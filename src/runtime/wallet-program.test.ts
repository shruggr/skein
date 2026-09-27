// The wallet program (wallet-zig/, issue #29 phase 1) in the VM against the
// real imports: the owner sends a checkpoint and headers of a small chain
// (regtest difficulty), then a BRC-29 payment as Atomic BEEF, which the
// program internalizes — SPV against its own header records, the payee key
// from the instance wallet over the `wallet` import (getPublicKey, attested),
// never a signature — then lists its spendable outputs; the payment is mined,
// its proof arrives, and the status the program computes becomes proven.
// Replay with no wallet reproduces every thread.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { KeyDeriver, MerklePath, P2PKH, Transaction, UnlockingScript } from "@bsv/sdk";
import { CID } from "multiformats/cid";
import { collect, installWasm, instance, send, type Instance } from "../testkit.ts";
import { decode } from "./cid.ts";
import { headTree } from "./heads.ts";
import { copyLog } from "./log.ts";
import { memoryStore } from "./memory.ts";
import { WALLET, WALLET_CID } from "./programs.ts";
import type { Attested } from "./records.ts";
import { Runtime, witnessFrom } from "./scheduler.ts";
import type { ThreadUpdate } from "./types.ts";

const sha256d = (b: Uint8Array) => createHash("sha256").update(createHash("sha256").update(b).digest()).digest();
const internal = (displayHex: string) => Buffer.from(displayHex, "hex").reverse();
const REGTEST_BITS = 0x207fffff;
const TARGET = 0x7fffffn << BigInt(8 * (0x20 - 3));

/** An 80-byte header at regtest difficulty, mined (a few tries). */
function mine(prev: Uint8Array, merkleRoot: Uint8Array, time: number): Uint8Array {
  const h = Buffer.alloc(80);
  h.writeInt32LE(1, 0);
  Buffer.from(prev).copy(h, 4);
  Buffer.from(merkleRoot).copy(h, 36);
  h.writeUInt32LE(time, 68);
  h.writeUInt32LE(REGTEST_BITS, 72);
  for (let nonce = 0; ; nonce++) {
    h.writeUInt32LE(nonce, 76);
    if (BigInt("0x" + Buffer.from(sha256d(h)).reverse().toString("hex")) <= TARGET) return new Uint8Array(h);
  }
}

type Result = Record<string, unknown> & { op: string; state?: CID };

/** Send one body to the `wallet` box, run it, and return the step's result record (its CID is the program's stdout). */
async function step(i: Instance, seen: Set<string>, body: unknown): Promise<{ result: Result; update: ThreadUpdate & { calls?: CID[] } }> {
  await send(i, "wallet", body);
  await i.delivery.poll();
  await i.rt.idle();
  const threads = (await collect(i.store.edges.query({ kind: "thread", program: WALLET_CID }))).filter((t) => !seen.has(t.toString()));
  assert.equal(threads.length, 1, `one new wallet thread for ${JSON.stringify((body as { op: string }).op)}: ${i.lines.slice(-6).join(" / ")}`);
  seen.add(threads[0].toString());
  const update = await i.store.get<ThreadUpdate & { calls?: CID[]; result: { stdout: Uint8Array; stderr: Uint8Array } }>(await i.store.chains.tip(threads[0]));
  const out = update.result as { stdout: Uint8Array; stderr: Uint8Array };
  assert.equal(update.state, "finished", JSON.stringify(Buffer.from(out.stderr).toString()));
  const cid = CID.decode(Buffer.from(Buffer.from(out.stdout).toString().trim(), "hex"));
  return { result: decode<Result>(await i.store.bytes(cid)), update };
}

test("wallet program (Zig): headers, BRC-29 payment internalized from Atomic BEEF, spendable outputs, proof → proven; replay", async () => {
  const i0 = await instance({ config: { subscriptions: [{ match: { box: "wallet" }, handler: WALLET_CID }] } });
  await i0.store.put(WALLET);
  await i0.rt.stop();
  const i = await instance({ store: i0.store, instanceKey: i0.instanceKey, ownerKey: i0.owner.key, hostKey: i0.host.key, hub: i0.hub, clock: i0.clock });
  const seen = new Set<string>();

  // The funding transaction, mined alone in block 101 (root = its txid), paying the owner.
  const fund = new Transaction();
  fund.addInput({ sourceTXID: "11".repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex("51"), sequence: 0xffffffff });
  fund.addOutput({ lockingScript: new P2PKH().lock(i.owner.key.toPublicKey().toHash()), satoshis: 50_000 });
  const fundTxid = fund.id("hex");
  fund.merklePath = new MerklePath(101, [[{ offset: 0, hash: fundTxid, txid: true }]]);
  const cp = mine(new Uint8Array(32), new Uint8Array(32).fill(7), 1_790_000_000);
  const h101 = mine(sha256d(cp), internal(fundTxid), 1_790_000_600);
  const h102 = mine(sha256d(h101), new Uint8Array(32).fill(9), 1_790_001_200);

  // The owner pays the instance: BRC-29 (protocol [2, "3241645161d8"], keyID "<prefix> <suffix>").
  const derivationPrefix = Buffer.from("skein-test-prefix").toString("base64");
  const derivationSuffix = Buffer.from("skein-test-suffix").toString("base64");
  const payTo = new KeyDeriver(i.owner.key).derivePublicKey([2, "3241645161d8"], `${derivationPrefix} ${derivationSuffix}`, i.identity, false);
  const pay = new Transaction();
  pay.addInput({ sourceTransaction: fund, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(i.owner.key), sequence: 0xffffffff });
  pay.addOutput({ lockingScript: new P2PKH().lock(payTo.toHash()), satoshis: 49_800 });
  await pay.sign();
  const payTxid = pay.id("hex");
  const atomic = new Uint8Array(pay.toAtomicBEEF());

  let r = await step(i, seen, { op: "checkpoint", height: 100, header: cp });
  assert.equal(r.result.op, "checkpoint");
  r = await step(i, seen, { op: "headers", headers: [h101, h102] });
  assert.deepEqual([r.result.added, r.result.tip], [2, 102]);
  assert.ok((await headTree(i.store, "wallet"))!.equals(r.result.state!), "the `wallet` head names the state the step saved");

  // A payment claimed under the wrong suffix is not ours: the step errors, nothing moves.
  const before = await headTree(i.store, "wallet");
  await send(i, "wallet", {
    op: "internalize", tx: atomic, description: "wrong",
    outputs: [{ outputIndex: 0, protocol: "wallet payment", paymentRemittance: { derivationPrefix, derivationSuffix: "eA==", senderIdentityKey: i.owner.identity } }],
  });
  await i.delivery.poll();
  await i.rt.idle();
  const bad = (await collect(i.store.edges.query({ kind: "thread", program: WALLET_CID }))).filter((t) => !seen.has(t.toString()));
  seen.add(bad[0].toString());
  const badTip = await i.store.get<ThreadUpdate>(await i.store.chains.tip(bad[0]));
  assert.equal(badTip.state, "errored");
  assert.match(badTip.error!.message, /NotOurPayment/);
  assert.ok((await headTree(i.store, "wallet"))!.equals(before!), "an errored step moves no head");

  r = await step(i, seen, {
    op: "internalize", tx: atomic, description: "funding from the owner", labels: ["funding"],
    outputs: [{ outputIndex: 0, protocol: "wallet payment", paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey: i.owner.identity } }],
  });
  assert.deepEqual([r.result.txid, r.result.status, r.result.outputs], [payTxid, "unproven", 1]);
  const calls = await Promise.all((r.update.calls ?? []).map((c) => i.store.get<Attested>(c)));
  assert.deepEqual(calls.map((c) => [c.op, (c.request as Uint8Array)[0]]), [["wallet", 8]], "one attested call: getPublicKey for the payee key; no signing");

  r = await step(i, seen, { op: "list" });
  assert.equal(r.result.basket, "default");
  assert.equal(r.result.total, 49_800);
  const [o] = r.result.outputs as Array<Record<string, unknown>>;
  assert.deepEqual([o.txid, o.vout, o.satoshis, o.spendable, o.status], [payTxid, 0, 49_800, true, "unproven"]);
  assert.equal(Buffer.from(o.lockingScript as Uint8Array).toString("hex"), new P2PKH().lock(payTo.toHash()).toHex());

  // Mined in block 103: the header, then the proof; status is computed from them.
  const h103 = mine(sha256d(h102), internal(payTxid), 1_790_001_800);
  r = await step(i, seen, { op: "headers", headers: [h103] });
  assert.equal(r.result.tip, 103);
  const proof = new MerklePath(103, [[{ offset: 0, hash: payTxid, txid: true }]]);
  r = await step(i, seen, { op: "proof", txid: payTxid, path: new Uint8Array(proof.toBinary()) });
  assert.equal(r.result.status, "proven");
  r = await step(i, seen, { op: "list", basket: "default", includeSpent: true });
  assert.equal((r.result.outputs as Array<Record<string, unknown>>)[0].status, "proven");

  // Replay: the log into a fresh store, no wallet, answers from the witness; every wallet thread and the head match.
  await i.rt.stop();
  const fresh = memoryStore();
  await installWasm(fresh);
  await fresh.put(WALLET);
  await copyLog(i.store, fresh);
  const rt = new Runtime({ store: fresh, witness: await witnessFrom(i.store) });
  await rt.start();
  await rt.idle();
  for (const t of await collect(i.store.edges.query({ kind: "thread", program: WALLET_CID }))) {
    assert.ok((await fresh.chains.tip(t)).equals(await i.store.chains.tip(t)), `thread ${t} replays to the same tip`);
  }
  assert.ok((await headTree(fresh, "wallet"))!.equals((await headTree(i.store, "wallet"))!), "the wallet head replays to the same state");
  await rt.stop();
});

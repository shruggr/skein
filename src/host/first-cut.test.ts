// The first cut's bar (skein next, the H2 brief): an instance born from an image on this host with the
// rebuilt chain app and overlay installed at birth (build C's skein-chain and skein-overlay `next`
// worktrees: SKEIN_CHAIN_DIR / SKEIN_OVERLAY_DIR, default ../wt-skein-chain-next, ../wt-skein-overlay-next),
// on regtest with the host's one header intake:
//   - a BEEF taken in through the public submit row (/overlay/submit: chain.beef, overlay.admits; recheck
//     chain.unspent) → BRC-22's STEAK; the chain app's chain/tx fact makes the host remember the holder;
//     the overlay's admitted fact carries `topics`;
//   - a second BEEF spending the same output: checks pass, refused at COMMIT ("already spent"), nothing written;
//   - a sync delivery (the host's own: /overlay/sync, plain BEEF) taken in; the sync row not offered over HTTP;
//   - a merkle proof as the event chain/proof (checked by chain.proof): taken; an EARLY one (its header not
//     held yet) refused 425, kept, and offered again by the host when the header arrives;
//   - a rejected status from the host's status service (its own key, role chain.status) → outcome rejected.
// NOT here (no shipped topic manager answers MissingParents: tm_demo admits every token output): a sync
// delivery left undecided and released by its parent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { MerklePath, P2PKH, PrivateKey, Script, Transaction, UnlockingScript } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { txCid } from "./feeds.ts";
import { REGTEST_GENESIS } from "./fake-teranode.ts";
import { DoorAnswered } from "./door-answer.ts";
import { imageTree, testHost, until } from "./testhost.ts";

const AGENT_ENV = resolve(import.meta.dirname, "../../..");
const CHAIN_DIR = process.env.SKEIN_CHAIN_DIR ?? join(AGENT_ENV, "wt-skein-chain-next");
const OVERLAY_DIR = process.env.SKEIN_OVERLAY_DIR ?? join(AGENT_ENV, "wt-skein-overlay-next");
const skip = (!existsSync(join(CHAIN_DIR, "bin/chain.wasm")) || !existsSync(join(OVERLAY_DIR, "bin/overlay.wasm"))) && "build C's chain app and overlay not here (SKEIN_CHAIN_DIR, SKEIN_OVERLAY_DIR)";

const sha256d = (b: Uint8Array) => createHash("sha256").update(createHash("sha256").update(b).digest()).digest();
const internal = (displayHex: string) => Buffer.from(displayHex, "hex").reverse();
const TARGET = 0x7fffffn << BigInt(8 * (0x20 - 3));
function mine(prev: Uint8Array, merkleRoot: Uint8Array, time: number): Uint8Array {
  const h = Buffer.alloc(80);
  h.writeInt32LE(1, 0);
  Buffer.from(prev).copy(h, 4);
  Buffer.from(merkleRoot).copy(h, 36);
  h.writeUInt32LE(time, 68);
  h.writeUInt32LE(0x207fffff, 72);
  for (let nonce = 0; ; nonce++) {
    h.writeUInt32LE(nonce, 76);
    if (BigInt("0x" + Buffer.from(sha256d(h)).reverse().toString("hex")) <= TARGET) return new Uint8Array(h);
  }
}

/**
 * The overlay app as build C wrote it, with its handlers and its own check named "<app>.<role>.<fn>":
 * its etc/app.json names "overlay.<fn>" for an app of three programs, which the kernel refuses to
 * resolve (kernel-zig on.zig handlerOf: "<app>.<fn>" only for an app with one program) — build H2's
 * BLOCKER 1, for build C to fix in skein-overlay. A copy: nothing in build C's tree is changed.
 */
function overlayCopy(to: string): string {
  cpSync(OVERLAY_DIR, to, { recursive: true, filter: (p) => !/\/(\.git|zig-out|\.zig-cache|zig-pkg|equiv|docs|src|test\.zig)$/.test(p) });
  const p = join(to, "etc/app.json");
  const m = JSON.parse(readFileSync(p, "utf8")) as { routes: Array<Record<string, unknown>> };
  const q = (x: unknown) => typeof x === "string" && /^overlay\.[A-Za-z0-9_-]+$/.test(x) ? `overlay.overlay.${x.slice("overlay.".length)}` : x;
  m.routes = m.routes.map((r) => ({ ...r, handler: q(r.handler), ...(Array.isArray(r.checks) ? { checks: r.checks.map(q) } : {}) }));
  writeFileSync(p, JSON.stringify(m, null, 2));
  return to;
}

test("the first cut: an instance with the chain app and the overlay, born from an image — public submit, a double spend refused at COMMIT, a sync delivery, proofs (one early, offered again), a rejection", { skip, timeout: 300_000 }, async (t) => {
  const h = await testHost(t, { network: "regtest", genesis: { defaults: { walletNetwork: "regtest" } } });
  const img = await imageTree(join(h.home, "img"), { apps: [CHAIN_DIR, overlayCopy(join(h.home, "overlay"))] });
  await h.instance("ov", img);
  // Regtest: the genesis, then F (a funding transaction with a stand-in input) mined at height 1.
  const alice = new PrivateKey("3333", 16);
  const lock = () => new P2PKH().lock(alice.toPublicKey().toHash());
  const fund = new Transaction();
  fund.addInput({ sourceTXID: "72".repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex("51"), sequence: 0xffffffff });
  for (let i = 0; i < 4; i++) fund.addOutput({ lockingScript: lock(), satoshis: 10_000 });
  const headers: Uint8Array[] = [new Uint8Array(REGTEST_GENESIS)];
  const mineAlone = (tx: Transaction) => {
    const height = headers.length;
    const cb = (height * 17 % 256).toString(16).padStart(2, "0").repeat(32);
    tx.merklePath = new MerklePath(height, [[{ offset: 0, hash: cb }, { offset: 1, hash: tx.id("hex"), txid: true }]]);
    headers.push(mine(sha256d(headers.at(-1)!), sha256d(Buffer.concat([internal(cb), internal(tx.id("hex"))])), 1_790_200_000 + height * 600));
    return height;
  };
  mineAlone(fund);
  await h.router.start();
  await h.router.takeHeaders(headers, 0);
  await h.router.settled();
  const k = (await h.router.hydrate("ov")).kernel;
  const rows = (await k.routes()).rows as Array<Record<string, unknown>>;
  assert.ok(rows.some((r) => r.path === "/overlay/submit") && rows.some((r) => r.name === "chain/proof") && rows.some((r) => r.path === "/chain/rejected"), "the apps' rows installed at birth");

  /** A tm_demo token spending F's output `vout`. */
  const token = async (vout: number, n: number) => {
    const tx = new Transaction();
    tx.addInput({ sourceTransaction: fund, sourceOutputIndex: vout, unlockingScriptTemplate: new P2PKH().unlock(alice), sequence: 0xffffffff });
    tx.addOutput({ lockingScript: Script.fromBinary([0x07, ...Buffer.from("tm_demo"), 0x75, ...lock().toBinary()]), satoshis: 9_000 + n });
    await tx.sign();
    return tx;
  };
  const submit = async (tx: Transaction) => await fetch(`${h.base}/@ov/overlay/submit`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: Buffer.from(tx.toBEEF()) });

  // 1. The public submit row.
  const t1 = await token(0, 1);
  const n0 = await h.entries("ov");
  const r1 = await submit(t1);
  const steak = await r1.text();
  assert.equal(r1.status, 200, steak);
  assert.deepEqual(JSON.parse(steak).tm_demo?.outputsToAdmit, [0], `BRC-22's STEAK: ${steak}`);
  assert.equal(await h.entries("ov"), n0 + 1, "one entry");
  await h.router.settled();
  assert.deepEqual(h.router.holdersOf(t1.id("hex")), ["ov"], "the host remembers the holder from the chain app's chain/tx fact");
  const fact = (await h.router.events.read("ov", { name: `overlay/topic/tx/${t1.id("hex")}` })).at(-1);
  assert.ok(fact && /"admitted"/.test(fact.data) && /"tm_demo"/.test(fact.data), `the overlay's admitted fact with its topics: ${fact?.data}`);

  // 2. A second BEEF spending the same output: past the checks, refused at COMMIT, nothing written.
  const t2 = await token(0, 2);
  const r2 = await submit(t2);
  assert.equal(r2.status, 409, await r2.clone().text());
  assert.equal(((await r2.json()) as { code: string }).code, "ERR_SPENT");
  assert.equal(await h.entries("ov"), n0 + 1, "nothing written");

  // 3. A sync delivery: the host's own (plain BEEF to /overlay/sync); the sync row not offered over HTTP.
  const t3 = await token(1, 3);
  const s3 = await h.router.submitBeef("ov", "/overlay/sync", Uint8Array.from(t3.toBEEF()));
  assert.equal(s3.verdict, "accept", s3.reason ?? "");
  const viaHttp = await fetch(`${h.base}/@ov/overlay/sync`, { method: "POST", body: Buffer.from(t3.toBEEF()) });
  assert.equal(viaHttp.status, 404, "the sync row is the host's: not offered over HTTP");
  assert.equal(await h.entries("ov"), n0 + 2);

  // 4. Proofs: t1 mined at height 2 (its header first) — taken; t3 mined at 3, its proof offered before the
  //    header — refused early (425), kept, offered again when the header arrives.
  const proofOf = (tx: Transaction) => ({ kind: "proof", subject: txCid(tx.id("hex")), txid: tx.id("hex"), path: Uint8Array.from(tx.merklePath!.toBinary()) });
  mineAlone(t1);
  await h.router.takeHeaders([headers[2]!], 2);
  await h.router.settled();
  assert.ok(await h.router.offerProof("ov", proofOf(t1)), "t1's proof taken");
  await h.router.settled();
  await until("t1 mined (the holder forgotten)", () => h.router.holdersOf(t1.id("hex")).length === 0 || undefined);
  mineAlone(t3);
  assert.equal(await h.router.offerProof("ov", proofOf(t3)), undefined, "early: kept, not taken");
  assert.ok(h.lines.some((l) => /proof .*: early/.test(l)));
  await h.router.takeHeaders([headers[3]!], 3);
  await until("t3's early proof taken after its header", async () => { await h.router.settled(); return h.router.holdersOf(t3.id("hex")).length === 0 || undefined; });

  // 5. A rejection from the host's status service (its own key, role chain.status).
  const t4 = await token(2, 4);
  assert.equal((await submit(t4)).status, 200);
  const e = await h.router.statusRequest("ov", { kind: "status", txid: t4.id("hex"), txStatus: "REJECTED", extraInfo: "a test" });
  await h.router.settled();
  const after = (await h.router.events.read("ov", { name: `chain/tx/${t4.id("hex")}` })).at(-1);
  assert.ok(after && /"rejected"/.test(after.data), `the chain app took the rejection: ${after?.data}`);
  void e;
  // The rejected row takes no other key: the owner (root) is no chain.status holder.
  await assert.rejects(h.request("ov", "POST", "/chain/rejected", { txid: t4.id("hex"), txStatus: "REJECTED" }), (x) => x instanceof DoorAnswered && x.answer.status === 403);
  void dagCbor;
});

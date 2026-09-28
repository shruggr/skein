// The peer process for equiv/wallet.ts: peer/peer.ts with fixed keys, an
// in-process messagebox hub, the instance's signing oracle a ProtoWallet
// (@bsv/sdk; #18: the oracle is a ProtoWallet over a derived key), and a fake
// ARC answering the wallet program's `http` calls. It drives the wallet
// (wallet-zig, issue #29) through `skein-kernel serve` end to end and writes
// what it saw to $SKEIN_HOME/wallet.json, then asks the kernel to stop.
//
// The chain is regtest from its genesis (defaults.walletNetwork): headers
// 1..100 in an owner's message, the rest as plain `header` entries; the
// owner funds the instance with a BRC-29 payment; the instance pays someone
// (createAction: signed through the oracle, broadcast to ARC over http), the
// thread rests awaiting the transaction's CID with a deadline — the tick
// wakes it and it re-asks ARC — until a `status` entry (MINED, with the
// merkle path) proves it; a rejected broadcast gives the inputs back; a
// draft (signAndProcess: false) is signed by signAction.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { KeyDeriver, MerklePath, P2PKH, PrivateKey, Transaction, UnlockingScript } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import { seal } from "../../src/envelope.ts";
import { DEFAULTS } from "../../src/runtime/log.ts";
import { rawCid, WALLET as WALLET_P1 } from "../../src/runtime/programs.ts";
import { encode } from "../../src/runtime/cid.ts";
import { openStoreFile } from "../../src/runtime/index-store.ts";
import { decode } from "../../src/runtime/cid.ts";
import { collect, messageBoxHub } from "../../src/testkit.ts";
import type { ThreadUpdate } from "../../src/runtime/types.ts";
import { ephemeralWallet } from "../../src/wallet.ts";
import { admitEvent, remote, runPeer, say, type HttpRequest, type HttpResponse } from "../peer/peer.ts";

// SKEIN_WALLET_COMPONENT=<file>: the wallet's component build (issue #34;
// `zig build component` in wallet-zig) in place of the pinned preview1 module:
// the same program record but for `code.wasm` (the kernel installs the file
// through SKEIN_EXTRA_MODULES). Everything the scenario checks must come out
// the same on both ABIs.
const componentPath = process.env.SKEIN_WALLET_COMPONENT;
const WALLET = componentPath ? { ...WALLET_P1, code: { wasm: rawCid(readFileSync(componentPath)) } } : WALLET_P1;
const WALLET_CID = encode(WALLET).cid;

const KEYS = { instance: "1111", owner: "2222", host: "3333" };
const key = (h: string) => new PrivateKey(h, 16);
const env = process.env;
const hub = messageBoxHub();
const ownerKey = key(KEYS.owner);
const owner = ephemeralWallet(ownerKey);
const ownerId = ownerKey.toPublicKey().toString();
const report: Record<string, unknown> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- regtest

const sha256d = (b: Uint8Array) => createHash("sha256").update(createHash("sha256").update(b).digest()).digest();
const internal = (displayHex: string) => Buffer.from(displayHex, "hex").reverse();
const REGTEST_GENESIS = Buffer.from("0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4adae5494dffff7f2002000000", "hex");
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
/** A transaction's CID: bitcoin-tx (0xb1), dbl-sha2-256 (0x56) over the txid in internal order. */
const txCid = (txid: string) => CID.createV1(0xb1, Digest.create(0x56, internal(txid)));

// ---------------------------------------------------------------- a fake ARC

type Arc = { mode: "seen" | "reject"; posts: Uint8Array[]; gets: string[] };
const arc: Arc = { mode: "seen", posts: [], gets: [] };
async function fakeArc(r: HttpRequest): Promise<HttpResponse> {
  const json = (status: number, v: unknown): HttpResponse => ({ status, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(v)) });
  if (r.method === "POST" && r.url === "https://arc.test/v1/tx") {
    const beef = r.body!;
    arc.posts.push(beef);
    const tx = Transaction.fromAtomicBEEF([...beef]);
    if (arc.mode === "reject") return json(461, { status: 461, title: "Malformed transaction", txid: tx.id("hex"), extraInfo: "rejected by the test" });
    return json(200, { txid: tx.id("hex"), txStatus: "SEEN_ON_NETWORK", extraInfo: "", merklePath: "" });
  }
  const m = r.url.match(/^https:\/\/arc\.test\/v1\/tx\/([0-9a-f]{64})$/);
  if (r.method === "GET" && m) {
    arc.gets.push(m[1]);
    return json(200, { txid: m[1], txStatus: "SEEN_ON_NETWORK", merklePath: "" });
  }
  return json(404, { title: "not found" });
}

// ---------------------------------------------------------------- the owner and the results

async function sendTo(identity: string, box: string, body: unknown): Promise<void> {
  const e = await seal(owner, { recipient: { identityKey: identity, handle: "wallettest", domain: "localhost" }, body: dagCbor.encode(body), created: new Date().toISOString() });
  await hub.as(ownerId).send({ recipient: identity, box, body: e });
}

async function until<T>(what: string, f: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

type Result = Record<string, unknown> & { op: string };
// Opened once the kernel has written the store (its state pointer): read through the index, following it live.
let view!: ReturnType<typeof openStoreFile>;
const seen = new Set<string>();

/** The wallet threads' updates, oldest first: [thread, step n, update]. */
async function updates(): Promise<Array<{ thread: CID; update: ThreadUpdate & { kept?: CID[]; result?: { stdout: Uint8Array; stderr: Uint8Array } } }>> {
  const out = [];
  for (const t of await collect(view.edges.query({ kind: "thread", program: WALLET_CID }))) {
    for (const u of (await collect(view.chains.history(t))).slice(1)) out.push({ thread: t, update: await view.get(u) as never });
  }
  return out;
}

/** The result of the next wallet step to end (finished, waiting or errored) that we have not seen. */
async function nextResult(what: string): Promise<{ result: Result; state: string; thread: CID; error?: string }> {
  return until(what, async () => {
    for (const { thread, update } of await updates()) {
      const k = `${thread}/${update.step}`;
      if (seen.has(k) || update.state === "running") continue;
      seen.add(k);
      const stdout = Buffer.from(update.result?.stdout ?? []).toString().trim();
      if (update.state === "errored") return { result: { op: "?" }, state: "errored", thread, error: update.error?.message };
      const cid = CID.decode(Buffer.from(stdout, "hex"));
      return { result: decode<Result>(await view.bytes(cid)), state: update.state, thread };
    }
    return undefined;
  });
}

async function owned(identity: string, body: Record<string, unknown>) {
  await sendTo(identity, "wallet", body);
  return nextResult(String(body.op));
}

// ---------------------------------------------------------------- the scenario

await runPeer({
  host: ephemeralWallet(key(KEYS.host)),
  wallet: ephemeralWallet(key(KEYS.instance)), // the signing oracle: a ProtoWallet
  box: () => hub.as(key(KEYS.instance).toPublicKey().toString()),
  pollMs: 50,
  http: fakeArc,
  config: (c) => ({
    ...c,
    subscriptions: [...(c.subscriptions ?? []), { match: { box: "wallet", sender: ownerId }, handler: WALLET_CID }, { match: { box: "chain" }, handler: WALLET_CID }],
    defaults: { ...DEFAULTS, walletNetwork: "regtest", walletArc: "https://arc.test", walletRecheckMs: "3000", walletFeeRate: "100" },
  }),
  async running(identity) {
    try {
      view = openStoreFile(env.SKEIN_DB!, { readOnly: true });
      await remote.store.put(WALLET);
      // The funding: mined alone at 101 (root = its txid), paying the owner.
      const fund = new Transaction();
      fund.addInput({ sourceTXID: "11".repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex("51"), sequence: 0xffffffff });
      fund.addOutput({ lockingScript: new P2PKH().lock(ownerKey.toPublicKey().toHash()), satoshis: 50_000 });
      const fundTxid = fund.id("hex");
      fund.merklePath = new MerklePath(101, [[{ offset: 0, hash: fundTxid, txid: true }]]);
      const headers: Uint8Array[] = [];
      let prev: Uint8Array = sha256d(REGTEST_GENESIS);
      for (let h = 1; h <= 102; h++) {
        const root = h === 101 ? internal(fundTxid) : sha256d(Buffer.from(`filler ${h}`));
        headers.push(mine(prev, root, 1_790_000_000 + h * 600));
        prev = sha256d(headers.at(-1)!);
      }

      // Headers: 1..100 from the owner, 101 and 102 as plain entries (a header feed).
      let r = await owned(identity, { op: "headers", headers: headers.slice(0, 100) });
      report.headers = [r.result.added, r.result.tip];
      for (const raw of headers.slice(100)) {
        await admitEvent("chain", { kind: "header", raw });
        r = await nextResult("a header entry");
        report.headerEntry = [r.result.event, r.result.tip];
      }

      // The owner pays the instance (BRC-29).
      const derivationPrefix = Buffer.from("skein-prefix").toString("base64");
      const derivationSuffix = Buffer.from("skein-suffix").toString("base64");
      const payTo = new KeyDeriver(ownerKey).derivePublicKey([2, "3241645161d8"], `${derivationPrefix} ${derivationSuffix}`, identity, false);
      const pay = new Transaction();
      pay.addInput({ sourceTransaction: fund, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(ownerKey), sequence: 0xffffffff });
      pay.addOutput({ lockingScript: new P2PKH().lock(payTo.toHash()), satoshis: 49_800 });
      await pay.sign();
      r = await owned(identity, {
        op: "internalize", tx: new Uint8Array(pay.toAtomicBEEF()), description: "funding",
        outputs: [{ outputIndex: 0, protocol: "wallet payment", paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey: ownerId } }],
      });
      report.internalize = [r.result.txid === pay.id("hex"), r.result.status];

      // Spend: pay someone 10000; signed by the oracle, broadcast to ARC, the thread awaits.
      const someone = new P2PKH().lock(key("5555").toPublicKey().toHash()).toBinary();
      r = await owned(identity, { op: "createAction", description: "pay someone", labels: ["out"], outputs: [{ lockingScript: new Uint8Array(someone), satoshis: 10_000, outputDescription: "to 5555" }] });
      const spendTxid = r.result.txid as string;
      const posted = Transaction.fromAtomicBEEF([...arc.posts.at(-1)!]);
      report.create = {
        state: r.state, awaiting: r.result.awaiting, outcome: r.result.outcome, arc: (r.result.arc as { txStatus?: string })?.txStatus,
        postedIsTheTx: posted.id("hex") === spendTxid, scriptsVerify: await posted.verify("scripts only"),
        inputs: posted.inputs.map((i) => i.sourceTXID ?? i.sourceTransaction?.id("hex")), outputs: posted.outputs.map((o) => o.satoshis),
      };
      const spendThread = r.thread;

      // The deadline passes: the tick wakes the thread, it re-asks ARC, and rests again.
      r = await nextResult("the woken callback");
      report.woke = { same: r.thread.equals(spendThread), op: r.result.op, outcome: r.result.outcome, state: r.state, gets: arc.gets.length };

      // Mined at 103: the header, then ARC's status (MINED, with the path) as a plain entry for the transaction.
      const h103 = mine(prev, internal(spendTxid), 1_790_000_000 + 103 * 600);
      await admitEvent("chain", { kind: "header", raw: h103 });
      r = await nextResult("header 103");
      const path = new MerklePath(103, [[{ offset: 0, hash: spendTxid, txid: true }]]);
      await admitEvent("chain", { kind: "status", subject: txCid(spendTxid), txid: spendTxid, txStatus: "MINED", merklePath: new Uint8Array(path.toBinary()) });
      r = await nextResult("the MINED status");
      report.mined = { same: r.thread.equals(spendThread), outcome: r.result.outcome, state: r.state };

      r = await owned(identity, { op: "list", includeSpent: true });
      report.list = (r.result.outputs as Array<Record<string, unknown>>).map((o) => [o.txid === spendTxid ? "change" : o.txid === pay.id("hex") ? "payment" : "?", o.satoshis, o.spendable, o.status]);
      report.total = r.result.total;

      // A rejected broadcast: the action is dropped, its inputs are spendable again.
      arc.mode = "reject";
      r = await owned(identity, { op: "createAction", description: "rejected", outputs: [{ lockingScript: new Uint8Array(someone), satoshis: 1_000 }] });
      report.rejected = { outcome: r.result.outcome, state: r.state, awaiting: r.result.awaiting ?? false };
      arc.mode = "seen";
      r = await owned(identity, { op: "list" });
      report.afterReject = r.result.total;

      // A draft, then signAction.
      r = await owned(identity, { op: "createAction", description: "draft", outputs: [{ lockingScript: new Uint8Array(someone), satoshis: 2_000 }], options: { signAndProcess: false } });
      const draft = { reference: r.result.reference as CID, txid: r.result.txid, posts: arc.posts.length };
      r = await owned(identity, { op: "signAction", reference: draft.reference });
      const signed = Transaction.fromAtomicBEEF([...arc.posts.at(-1)!]);
      report.draft = { hasReference: CID.asCID(draft.reference) !== null, notPostedAsDraft: draft.posts === arc.posts.length - 1, awaiting: r.result.awaiting, scriptsVerify: await signed.verify("scripts only"), txid: r.result.txid === signed.id("hex") };

      report.ok = true;
    } catch (e) {
      report.error = (e as Error).stack ?? String(e);
    }
    writeFileSync(join(env.SKEIN_HOME!, "wallet.json"), JSON.stringify(report, (_, v) => (v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v)));
    say("scenario: done");
    process.kill(process.ppid, "SIGTERM");
  },
});

// The wallet in the VM (issue #29) end to end on the Zig kernel, driven by
// the router (src/host/router.ts, #33): the instance's signing oracle a
// ProtoWallet, a fake ARC answering the wallet program's `http` calls, the
// owner a standard messagebox client, and plain header/status event entries
// admitted by the router's feeds (#33 part 2: the genesis declares a fake SSE
// header feed and an ARC callback; feeds.ts). Then the store it wrote is
// replayed Zig against Zig (equiv/replays.ts): the oracle's and ARC's answers
// come from the recorded calls, nothing is asked again.
//
// The chain is regtest from its genesis (defaults.walletNetwork): headers
// 1..100 in an owner's message, the rest as plain `header` entries from the
// SSE feed; the
// owner funds the instance with a BRC-29 payment; the instance pays someone
// (createAction: signed through the oracle, broadcast to ARC over http), the
// thread rests awaiting the transaction's CID with a deadline — the router's
// waker wakes it and it re-asks ARC — until ARC's callback (MINED, with the
// merkle path: POST /callback/<handle>, a `status` entry routed by its
// subject) proves it; a rejected broadcast gives
// the inputs back; a draft (signAndProcess: false) is signed by signAction.
// Then settlement (#37, settlementScenario): a rejection bubbling from A to
// the B that spends it, settlement messages to the owner's `settlement` box,
// B's thread learning it as a new input, and a reorg re-broadcasting.
//
// Issue #34, when the wallet's component build is there
// (wallet-zig/zig-out/bin/wallet.component.wasm from `zig build component`, or
// $SKEIN_WALLET_COMPONENT): the preview1 store's log is replayed with the
// component in the module's place (equiv/abi.ts: every update identical but
// for fuel), and the whole scenario runs again with the component as the
// wallet program (this script, SKEIN_WALLET_ABI=component: the same program
// record but for code.wasm, installed unpinned through SKEIN_EXTRA_MODULES):
// the same report, and its store replays to itself exactly.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/wallet.ts

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KeyDeriver, MerklePath, P2PKH, PrivateKey, Transaction, UnlockingScript } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import { RawBox } from "../../src/client/raw.ts";
import { HostDb } from "../../src/host/instances.ts";
import type { HttpRequest, HttpResponse } from "../../src/host/kernel.ts";
import { Router } from "../../src/host/router.ts";
import { decode } from "../../src/runtime/cid.ts";
import { buildTree, derive, openStoreFile } from "../../src/runtime/index-store.ts";
import { render } from "../../src/dev/explore/server.ts";
import { encode } from "../../src/runtime/cid.ts";
import { MODULES, rawCid, WALLET as WALLET_P1 } from "../../src/runtime/programs.ts";
import type { ThreadUpdate } from "../../src/runtime/types.ts";
import { collect } from "../../src/testkit.ts";
import { ephemeralWallet } from "../../src/wallet.ts";

const here = dirname(fileURLToPath(import.meta.url));
const component = process.env.SKEIN_WALLET_COMPONENT ?? join(here, "../../wallet-zig/zig-out/bin/wallet.component.wasm");
/** This run's ABI: the pinned preview1 module, or (issue #34) the component build of the same program. */
const abi = process.env.SKEIN_WALLET_ABI === "component" ? "component" : "preview1";
if (abi === "component") process.env.SKEIN_EXTRA_MODULES = component; // the kernel the router spawns installs it
const WALLET = abi === "component" ? { ...WALLET_P1, code: { wasm: rawCid(readFileSync(component)) } } : WALLET_P1;
const WALLET_CID = encode(WALLET).cid;
const kernel = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
const home = mkdtempSync(join(tmpdir(), "skein-kz-wallet-"));
const db = join(home, "instances/wallettest/runtime.db");
const key = (h: string) => new PrivateKey(h, 16);
const KEYS = { instance: "1111", owner: "2222" };
const ownerKey = key(KEYS.owner);
const owner = ephemeralWallet(ownerKey);
const ownerId = ownerKey.toPublicKey().toString();
const report: Record<string, unknown> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };

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

// ---------------------------------------------------------------- a fake header feed (SSE), ARC's callback token

const sse: ServerResponse[] = [];
const sseServer = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": headers\n\n"); sse.push(res); });
await new Promise<void>((r) => sseServer.listen(0, "127.0.0.1", r));
const SSE_URL = `http://127.0.0.1:${(sseServer.address() as { port: number }).port}/headers`;
let sseId = 0;
/** A header on the feed: its hex as the event's data (the router admits it as a plain `header` entry). */
const feedHeader = async (raw: Uint8Array) => {
  for (let i = 0; !sse.length && i < 200; i++) await sleep(25);
  sse.at(-1)!.write(`id: ${++sseId}\ndata: ${Buffer.from(raw).toString("hex")}\n\n`);
};
const ARC_TOKEN = "arc-callback-token";

// ---------------------------------------------------------------- the router, the owner and the results

const hostDb = new HostDb(join(home, "host.db"));
hostDb.add("wallettest", { store: db });
const router = new Router({
  // The signing oracle: a ProtoWallet (the owner's mailbox instance has a key of its own).
  db: hostDb, walletFor: (row) => ephemeralWallet(key(row.handle === "wallettest" ? KEYS.instance : "9999")), home,
  owner: ownerId, idleMs: 0, http: fakeArc, kernel: { command: kernel, env: { SKEIN_HOME: home } },
  genesis: {
    subscriptions: [{ box: "wallet", sender: ownerId, handler: WALLET_CID }, { box: "chain", handler: WALLET_CID }],
    defaults: { walletNetwork: "regtest", walletArc: "https://arc.test", walletRecheckMs: "3000", walletFeeRate: "100" },
    feeds: [{ kind: "headers", url: SSE_URL }, { kind: "arc-callback", token: ARC_TOKEN }],
  },
  log: (s, l) => { if (process.env.VERBOSE) process.stdout.write(`  | [${s}] ${l}\n`); },
});
await router.listen(0);
// The owner's mailbox instance (#40), before the instance's genesis names it: where settlement messages go.
router.addMailbox("david", ownerId);
const toWallet = new RawBox(owner, `http://127.0.0.1:${router.port}/@wallettest`);
const ownersBox = new RawBox(owner, `http://127.0.0.1:${router.port}/@david`);

async function sendTo(identity: string, b: string, body: unknown): Promise<void> {
  await toWallet.send(identity, b, body);
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

// ---------------------------------------------------------------- settlement (#37)

/** The next unseen ended wallet step whose result satisfies `pred` (others stay unseen: deadline wakes interleave). */
async function resultWhere(what: string, pred: (r: Result, state: string, thread: CID) => boolean, ms = 30_000) {
  return until(what, async () => {
    for (const { thread, update } of await updates()) {
      const k = `${thread}/${update.step}`;
      if (seen.has(k) || update.state === "running" || update.state === "errored") continue;
      const stdout = Buffer.from(update.result?.stdout ?? []).toString().trim();
      const result = decode<Result>(await view.bytes(CID.decode(Buffer.from(stdout, "hex"))));
      if (!pred(result, update.state, thread)) continue;
      seen.add(k);
      return { result, state: update.state, thread };
    }
    return undefined;
  }, ms);
}

/**
 * A rejection after a dependent spend: A pays someone from our change, B
 * spends A's change, then ARC's status for A says DOUBLE_SPEND_ATTEMPTED (a
 * plain entry routed by its subject to A's awaiting thread). A and B are
 * rejected (the bubbling: B spends A), their outputs vanish, the input A
 * consumed is spendable again, and the owner — who opted in with `watch` —
 * gets one settlement message per transaction in its `settlement` box. B's
 * own thread is not replayed: at its deadline it finds B rejected, a new
 * input, and finishes. The results name the transactions as `mentions`.
 */
async function settlementScenario(identity: string, someone: Uint8Array, base: string, reorg: { h102: Uint8Array; spend: string }): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const ownedWhere = async (body: Record<string, unknown>) => {
    await sendTo(identity, "wallet", body);
    return resultWhere(String(body.op), (r) => r.op === body.op);
  };
  out.watch = (await ownedWhere({ op: "watch" })).result.settlement;
  const total0 = (await ownedWhere({ op: "list" })).result.total;

  const a = await ownedWhere({ op: "createAction", description: "A", outputs: [{ lockingScript: someone, satoshis: 1_000 }] });
  const b = await ownedWhere({ op: "createAction", description: "B", outputs: [{ lockingScript: someone, satoshis: 500 }] });
  const txA = a.result.txid as string, txB = b.result.txid as string;
  const bTx = Transaction.fromAtomicBEEF([...(b.result.tx as Uint8Array)]);
  out.bSpendsA = bTx.inputs.some((i) => (i.sourceTXID ?? i.sourceTransaction?.id("hex")) === txA);
  out.awaiting = [a.state, b.state];

  await router.admitEvent("wallettest", "chain", { kind: "status", subject: txCid(txA), txid: txA, txStatus: "DOUBLE_SPEND_ATTEMPTED" });
  const r = await resultWhere("A's status entry", (res) => res.op === "callback" && res.txid === txA && res.event === "status");
  out.rejected = {
    sameThread: r.thread.equals(a.thread), outcome: r.result.outcome, state: r.state,
    settlement: (r.result.settlement as Array<Record<string, unknown>>)?.map((c) => [c.txid === txA ? "A" : c.txid === txB ? "B" : "?", c.status, c.reason, c.cause === undefined ? null : c.cause === txA ? "A" : "?"]),
    sent: r.result.sent,
  };
  const list = await ownedWhere({ op: "list", includeSpent: true });
  out.inputsFreed = list.result.total === total0;
  out.noOutputsOfAB = !(list.result.outputs as Array<Record<string, unknown>>).some((o) => o.txid === txA || o.txid === txB);

  // The owner's settlement box (its mailbox instance): the instance delivered them over http, one per transaction.
  void base;
  const msgs = await until("two settlement messages", async () => { const x = await ownersBox.list("settlement"); return x.length >= 2 ? x : undefined; });
  const bodies = msgs.map((m) => m.value as Record<string, unknown>);
  out.messages = bodies.map((m) => [m.kind, m.txid === txA ? "A" : m.txid === txB ? "B" : "?", m.status, m.reason]).sort();
  out.messageSender = msgs.every((m) => m.sender === identity);

  // B's thread was not replayed: its deadline wakes it, it finds B rejected, and finishes.
  const bw = await resultWhere("B's deadline", (res, _s, t) => t.equals(b.thread) && res.op === "callback", 15_000);
  out.bThread = { outcome: bw.result.outcome, state: bw.state };
  // The results mention the transactions (kernel edges with rel `mentions`).
  out.mentions = (await view.edges.refsTo(txCid(txA))).some((x) => x.rel === "mentions");
  // #42: B's input is a `spends` edge into A — from B itself (a kept bitcoin-tx block), its locator A's vout.
  const intoA = await view.edges.refsTo(txCid(txA));
  const bSpends = intoA.filter((x) => x.rel === "spends" && x.from.equals(txCid(txB)));
  out.spendsEdge = bSpends.length === 1 && bSpends[0]!.locator === String(Transaction.fromHex(Buffer.from(await view.bytes(txCid(txB))).toString("hex")).inputs[0]!.sourceOutputIndex);
  // The explorer's record page shows the graph: A decoded, its inputs' links, and ← spends from B.
  const page = await render(view, new URL(`/r/${txCid(txA)}`, "http://x"));
  out.explorer = page.status === 200 && page.body.includes("bitcoin-tx") && page.body.includes("vin 0") && page.body.includes("← spends") && page.body.includes(txCid(txB).toString());

  // A reorg: a heavier branch from 102 drops block 103, where our first spend was proven. It is
  // unproven again, broadcast again like a fresh one, awaited; the owner is told.
  const posts = arc.posts.length;
  const alt103 = mine(reorg.h102, sha256d(Buffer.from("alt 103")), 1_790_000_000 + 103 * 600 + 1);
  const alt104 = mine(sha256d(alt103), sha256d(Buffer.from("alt 104")), 1_790_000_000 + 104 * 600);
  const h = await ownedWhere({ op: "headers", headers: [alt103, alt104] });
  out.reorg = {
    replaced: h.result.replaced, reverted: (h.result.reverted as string[] | undefined)?.map((t) => t === reorg.spend ? "spend" : "?"),
    reposted: arc.posts.length === posts + 1 && Transaction.fromAtomicBEEF([...arc.posts.at(-1)!]).id("hex") === reorg.spend,
    state: h.state, awaited: (h.result.awaited as string[] | undefined)?.includes(reorg.spend),
  };
  const m3 = await until("the reorg's settlement message", async () => { const x = await ownersBox.list("settlement"); return x.length >= 3 ? x : undefined; });
  const last = m3.map((m) => m.value as Record<string, unknown>);
  out.reorgMessage = last.some((m) => m.txid === reorg.spend && m.status === "unproven" && m.reason === "reorg");
  return out;
}

// ---------------------------------------------------------------- the scenario

try {
  const { kernel: k, identity } = await router.hydrate("wallettest");
  await k.store.put(WALLET as never);
  view = openStoreFile(db, { readOnly: true });
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

  // Headers: 1..100 from the owner, 101 and 102 as plain entries from the router's SSE header feed.
  let r = await owned(identity, { op: "headers", headers: headers.slice(0, 100) });
  report.headers = [r.result.added, r.result.tip];
  for (const raw of headers.slice(100)) {
    await feedHeader(raw);
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
  await feedHeader(h103);
  r = await nextResult("header 103");
  const path = new MerklePath(103, [[{ offset: 0, hash: spendTxid, txid: true }]]);
  // ARC's callback to the router's webhook: a status entry for the transaction's CID.
  const cb = (auth: string) => fetch(`http://127.0.0.1:${router.port}/callback/wallettest`, {
    method: "POST", headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify({ timestamp: new Date().toISOString(), txid: spendTxid, txStatus: "MINED", blockHeight: 103, blockHash: "00".repeat(32), merklePath: path.toHex(), extraInfo: "" }),
  });
  report.callbackRefused = (await cb("Bearer wrong")).status;
  report.callback = (await cb(`Bearer ${ARC_TOKEN}`)).status;
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

  report.settlement = await settlementScenario(identity, new Uint8Array(someone), `http://127.0.0.1:${router.port}`, { h102: prev, spend: spendTxid });

  report.ok = true;
} catch (e) {
  report.error = (e as Error).stack ?? String(e);
}
await router.stop();
hostDb.close();
// #42: the TS reader derives the kernel's edges map key for key (a kept bitcoin block's links included).
{
  const v2 = openStoreFile(db, { readOnly: true });
  const d = await derive(v2);
  const rels = new Map<string, number>();
  for (const [, v] of d.pairs.edges) { const rel = (v as [string])[0]; rels.set(rel, (rels.get(rel) ?? 0) + 1); }
  report.edges = { sameRoot: String(buildTree(d.pairs.edges).root) === String((v2 as unknown as { state(): { roots: { edges: CID } } }).state().roots.edges), bitcoin: ["spends", "prev", "merkleroot"].map((r) => (rels.get(r) ?? 0) > 0) }; // one-transaction blocks here: no merkle nodes (overlay.ts has them)
  await v2.close();
}
for (const r of sse) r.end();
sseServer.close();

const eq = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
process.stdout.write(`== the wallet on ${abi}${abi === "component" ? ` (${component})` : ""}\n`);
check(report.ok === true, `the scenario ran${report.error ? `: ${report.error}` : ""}`);
check(eq(report.headers, [100, 100]), `headers 1..100 from the owner, chained from regtest's genesis (${JSON.stringify(report.headers)})`);
check(eq(report.headerEntry, ["header", 102]), `plain header entries from the router's SSE feed, routed by a sender-less subscription (${JSON.stringify(report.headerEntry)})`);
check(eq(report.internalize, [true, "unproven"]), `a BRC-29 payment internalized (${JSON.stringify(report.internalize)})`);
const c = (report.create ?? {}) as Record<string, unknown> & { outputs?: number[] };
check(c.state === "waiting" && c.awaiting === true && c.outcome === "pending" && c.arc === "SEEN_ON_NETWORK", `createAction: signed, broadcast over http, the thread awaits its status (${JSON.stringify(c)})`);
check(c.postedIsTheTx === true && c.scriptsVerify === true, "ARC received the transaction as Atomic BEEF; @bsv/sdk verifies its scripts (signatures from the oracle)");
check(eq(c.outputs?.slice(0, 1), [10000]) && c.outputs?.length === 2, `the payment and our change (${JSON.stringify(c.outputs)})`);
check(eq(report.woke, { same: true, op: "callback", outcome: "pending", state: "waiting", gets: 1 }), `the deadline: the router's waker wakes the thread, it re-asks ARC over http, rests again (${JSON.stringify(report.woke)})`);
check(report.callbackRefused === 401 && report.callback === 200, `ARC's callback at /callback/<handle>: the wrong token refused, the right one taken (${String(report.callbackRefused)}, ${String(report.callback)})`);
check(eq(report.mined, { same: true, outcome: "proven", state: "finished" }), `the callback's status entry (MINED + path) for the transaction's CID steps the awaiting thread: proven (${JSON.stringify(report.mined)})`);
check(Array.isArray(report.list) && (report.list as unknown[][]).some((o) => o[0] === "change" && o[2] === true && o[3] === "proven") && (report.list as unknown[][]).some((o) => o[0] === "payment" && o[2] === false), `list: the change spendable and proven, the payment spent (${JSON.stringify(report.list)})`);
check(eq(report.rejected, { outcome: "rejected", state: "finished", awaiting: false }) && report.afterReject === report.total, `a rejected broadcast drops the action: the balance is back (${JSON.stringify(report.rejected)}, ${report.afterReject} vs ${report.total})`);
const d = (report.draft ?? {}) as Record<string, unknown>;
check(d.hasReference === true && d.notPostedAsDraft === true && d.awaiting === true && d.scriptsVerify === true && d.txid === true, `a draft (signAndProcess: false), then signAction: signed, broadcast, awaiting (${JSON.stringify(d)})`);

const st = (report.settlement ?? {}) as Record<string, unknown>;
check(st.watch === true && eq(st.awaiting, ["waiting", "waiting"]) && st.bSpendsA === true, `settlement (#37): the owner watches; A, then B spending A's change, both broadcast and awaited (${JSON.stringify([st.watch, st.awaiting, st.bSpendsA])})`);
check(eq(st.rejected, { sameThread: true, outcome: "rejected", state: "finished", settlement: [["A", "rejected", "DOUBLE_SPEND_ATTEMPTED", null], ["B", "rejected", "input-rejected", "A"]], sent: 2 }), `a DOUBLE_SPEND status entry for A reaches A's thread: A rejected, bubbled to B (spends) (${JSON.stringify(st.rejected)})`);
check(st.inputsFreed === true && st.noOutputsOfAB === true, `the rejected outputs vanish; the input A consumed is spendable again (${JSON.stringify([st.inputsFreed, st.noOutputsOfAB])})`);
check(eq(st.messages, [["settlement", "A", "rejected", "DOUBLE_SPEND_ATTEMPTED"], ["settlement", "B", "rejected", "input-rejected"]]) && st.messageSender === true, `the owner's settlement box: one message per rejected transaction, delivered by the instance (${JSON.stringify(st.messages)})`);
check(eq(st.bThread, { outcome: "rejected", state: "finished" }), `B's thread is not replayed: at its deadline it finds B rejected and finishes (${JSON.stringify(st.bThread)})`);
check(st.mentions === true, "the results name the transactions as `mentions` edges (which never propagate)");
check(st.spendsEdge === true, "#42: B's input is a `spends` edge into A, from B's own kept block, locator = the vout it spends");
check(st.explorer === true, "#42: the explorer's record page for A shows it decoded (bitcoin-tx, its inputs) and ← spends from B");
check(eq(report.edges, { sameRoot: true, bitcoin: [true, true, true] }), `#42: the TS reader derives the kernel's edges map (same root), with spends / prev / merkleroot edges from the kept blocks (${JSON.stringify(report.edges)})`);
check(eq(st.reorg, { replaced: 1, reverted: ["spend"], reposted: true, state: "waiting", awaited: true }) && st.reorgMessage === true, `a reorg drops block 103: the spend proven there is unproven again, broadcast again, awaited; the owner is told (${JSON.stringify([st.reorg, st.reorgMessage])})`);

const r = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), db], { encoding: "utf8" });
process.stdout.write(r.stdout);
if (r.status !== 0) process.stdout.write(r.stderr);
check(r.status === 0 && /identical .*the source store reproduced exactly/.test(r.stdout), "the store replays to itself exactly, twice over: oracle and http answers from the recorded calls");

if (process.env.SKEIN_WALLET_REPORT) writeFileSync(process.env.SKEIN_WALLET_REPORT, JSON.stringify(report));

// Issue #34: the component build, against this preview1 log and then live.
if (abi === "preview1" && existsSync(component)) {
  process.stdout.write(`== the preview1 log replayed with the wallet's component in the module's place (equiv/abi.ts)\n`);
  const a = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "abi.ts"), db, MODULES.wallet.toString(), component], { encoding: "utf8" });
  process.stdout.write(a.stdout.split("\n").filter((l) => l).map((l) => `  ${l}\n`).join(""));
  if (a.status !== 0) process.stdout.write(a.stderr);
  check(a.status === 0, "no DIVERGED; every update identical but for fuel");
  const out = join(home, "component.json");
  const c2 = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "wallet.ts")], { encoding: "utf8", env: { ...process.env, SKEIN_WALLET_ABI: "component", SKEIN_WALLET_REPORT: out } });
  process.stdout.write(c2.stdout);
  if (c2.status !== 0) process.stdout.write(c2.stderr);
  check(c2.status === 0, "the scenario with the wallet as a component: all ok");
  const theirs = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : {};
  check(eq(theirs, JSON.parse(JSON.stringify(report))), "the component's run reports exactly what the module's did");
} else if (abi === "preview1") {
  process.stdout.write(`== the wallet as a component: skipped (no ${component}; \`cd wallet-zig && zig build component\`)\n`);
}

rmSync(home, { recursive: true, force: true });
process.stdout.write(failures ? `wallet (${abi}): ${failures} FAILED\n` : `wallet (${abi}): all ok\n`);
process.exit(failures ? 1 : 0);

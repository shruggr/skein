// The wallet in the VM (issue #29) end to end on the Zig kernel, driven by
// the router (src/host/router.ts, #33): the instance's signing oracle a
// ProtoWallet, the owner a standard messagebox client, plain header entries
// from the router's feeds (#33 part 2: a fake SSE header feed; feeds.ts), and
// the host's broadcaster (#58, #65, src/host/arc.ts) in front of a fake
// Arcade (src/host/fake-arcade.ts): the wallet program's broadcast is an
// event (#65: unauthenticated, addressed to no one), which the host queues
// and posts to Arcade under its token; Arcade's answer and its statuses
// (over one SSE subscription, and a webhook) reach every instance holding the
// transaction — a proof as an unsigned event in box `chain`, any other
// status as a signed message from the host's status provider, which both
// instances subscribe to (`$status`). Then the stores it wrote are replayed
// Zig against Zig (equiv/replays.ts): the oracle's answers come from the
// recorded calls, nothing is asked again.
//
// The chain is regtest from its genesis (defaults.walletNetwork): headers
// 1..100 in an owner's message, the rest as plain `header` entries from the
// SSE feed; the owner funds the instance with a BRC-29 payment; the instance
// pays a second instance, the payee, with a BRC-29 payment (createAction:
// signed through the oracle, broadcast as an event: Arcade receives it in
// Extended Format), the payee internalizes it, and the wallet's thread rests
// awaiting the transaction's CID with a deadline at its abandonment —
// Arcade's RECEIVED, SEEN_ON_NETWORK on the stream and SEEN_ON_MULTIPLE_NODES
// by webhook reach both instances as status messages, then MINED with the
// merkle path as a proof event: the wallet's thread and the payee's
// subscription both prove it. A redelivered status writes nothing. A
// rejected broadcast (Arcade's 400: a REJECTED status) gives the inputs back;
// a draft (signAndProcess: false) is signed by signAction. Then settlement
// (#37, settlementScenario): a rejection bubbling from A to the B that spends
// it, B's thread learning it from B's own status, and a reorg re-broadcasting.
// Last, a broadcast Arcade refuses for backpressure (503) stays in the host's
// queue — the instance never sees it — and is posted again until taken, and
// the host restarts while Arcade moves on: the new router resumes the stream
// after the last event id it took, and the status it missed reaches the
// thread.
//
// Issue #34, when the wallet's component build is there
// (programs/wallet/zig-out/bin/wallet.component.wasm from `zig build component`, or
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
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import { RawBox } from "../../src/client/raw.ts";
import { FakeArcade } from "../../src/host/fake-arcade.ts";
import { HostDb } from "../../src/host/instances.ts";
import { Router } from "../../src/host/router.ts";
import { Oracle } from "../../src/host/oracle.ts";
import { decode } from "../../src/runtime/cid.ts";
import { buildTree, derive, openStoreFile } from "../../src/runtime/index-store.ts";
import { render } from "../../src/dev/explore/server.ts";
import { encode } from "../../src/runtime/cid.ts";
import { MODULES, rawCid, WALLET as WALLET_P1 } from "../../src/runtime/programs.ts";
import type { ThreadUpdate } from "../../src/runtime/types.ts";
import { collect } from "../../src/testkit.ts";
import { ephemeralWallet } from "../../src/wallet.ts";

const here = dirname(fileURLToPath(import.meta.url));
const component = process.env.SKEIN_WALLET_COMPONENT ?? join(here, "../../programs/wallet/zig-out/bin/wallet.component.wasm");
/** This run's ABI: the pinned preview1 module, or (issue #34) the component build of the same program. */
const abi = process.env.SKEIN_WALLET_ABI === "component" ? "component" : "preview1";
if (abi === "component") process.env.SKEIN_EXTRA_MODULES = component; // the kernel the router spawns installs it
const WALLET = abi === "component" ? { ...WALLET_P1, code: { wasm: rawCid(readFileSync(component)) } } : WALLET_P1;
const WALLET_CID = encode(WALLET).cid;
const kernel = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
const home = mkdtempSync(join(tmpdir(), "skein-kz-wallet-"));
const db = join(home, "instances/wallettest/runtime.db");
const payeeDb = join(home, "instances/payee/runtime.db");
const key = (h: string) => new PrivateKey(h, 16);
const KEYS = { instance: "1111", owner: "2222", payee: "3333" };
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

// ---------------------------------------------------------------- a fake Arcade, a fake header feed (SSE)

const arcade = await FakeArcade.start();
const ARC_TOKEN = "the-host-arcade-token";
/** The transaction Arcade received last (Extended Format). */
const lastPosted = () => FakeArcade.txOf(arcade.posts.at(-1)!);

const sse: ServerResponse[] = [];
const sseServer = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": headers\n\n"); sse.push(res); });
await new Promise<void>((r) => sseServer.listen(0, "127.0.0.1", r));
const SSE_URL = `http://127.0.0.1:${(sseServer.address() as { port: number }).port}/headers`;
let sseId = 0;
/** A header on the feed: its hex as the event's data (the router admits it as a plain `header` entry). */
const feedHeader = async (raw: Uint8Array) => {
  for (let i = 0; !sse.length && i < 200; i++) await sleep(25);
  for (const s of sse) s.write(`id: ${++sseId}\ndata: ${Buffer.from(raw).toString("hex")}\n\n`);
};

// ---------------------------------------------------------------- the router, the owner and the results

const hostDb = new HostDb(join(home, "host.db"));
hostDb.add("wallettest", { store: db });
hostDb.add("payee", { store: payeeDb });
const make = () => new Router({
  // The signing oracles: ProtoWallets (any other instance has a key of its own).
  db: hostDb, walletFor: (row) => ephemeralWallet(key(row.handle === "wallettest" ? KEYS.instance : row.handle === "payee" ? KEYS.payee : "9999")), home,
  owner: ownerId, idleMs: 0, kernel: { command: kernel, env: { SKEIN_HOME: home } },
  providerKeyFor: (n) => new Oracle(new PrivateKey("a77e57", 16)).providerKey(n),
  // The host's Arcade (#58, #65): the broadcast events' queue, the status subscription, the status provider.
  arc: { url: arcade.url, token: ARC_TOKEN, events: arcade.eventsUrl },
  feeds: { backoff: { min: 50, max: 500 } },
  genesis: {
    // The owner's box, the chain feed (headers, proofs) and the status provider's messages (#65: `$status`).
    subscriptions: [{ box: "wallet", sender: ownerId, handler: WALLET_CID }, { box: "chain", handler: WALLET_CID }, { box: "status", sender: "$status", handler: WALLET_CID }],
    defaults: { walletNetwork: "regtest", walletFeeRate: "100" },
    feeds: [{ kind: "headers", url: SSE_URL }],
  },
  log: (s, l) => { if (process.env.VERBOSE) process.stdout.write(`  | [${s}] ${l}\n`); },
});
let router = make();
await router.listen(0);
const port = router.port;
const toWallet = new RawBox(owner, `http://127.0.0.1:${port}/@wallettest`);
const toPayee = new RawBox(owner, `http://127.0.0.1:${port}/@payee`);

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
type View = ReturnType<typeof openStoreFile>;
// Opened once the kernels have written the stores (their state pointers): read through the index, following them live.
let view!: View;
let payeeView!: View;
const seen = new Set<string>();

/** The wallet threads' updates in a store, oldest first: [thread, step n, update]. */
async function updates(v: View = view): Promise<Array<{ thread: CID; update: ThreadUpdate & { kept?: CID[]; result?: { stdout: Uint8Array; stderr: Uint8Array } } }>> {
  const out = [];
  for (const t of await collect(v.edges.query({ kind: "thread", program: WALLET_CID }))) {
    for (const u of (await collect(v.chains.history(t))).slice(1)) out.push({ thread: t, update: await v.get(u) as never });
  }
  return out;
}

/** The next unseen ended wallet step in a store whose result satisfies `pred` (others stay unseen: deadline wakes interleave). */
async function resultWhere(what: string, pred: (r: Result, state: string, thread: CID) => boolean, ms = 30_000, v: View = view) {
  return until(what, async () => {
    for (const { thread, update } of await updates(v)) {
      const k = `${thread}/${update.step}`;
      if (seen.has(k) || update.state === "running") continue;
      if (update.state === "errored") throw new Error(`${what}: a wallet step errored: ${update.error?.message}`);
      const stdout = Buffer.from(update.result?.stdout ?? []).toString().trim();
      const result = decode<Result>(await v.bytes(CID.decode(Buffer.from(stdout, "hex"))));
      if (!pred(result, update.state, thread)) continue;
      seen.add(k);
      return { result, state: update.state, thread };
    }
    return undefined;
  }, ms);
}

/** An owner's message to an instance's `wallet` box, and the step that answers it. */
async function owned(body: Record<string, unknown>, to = toWallet, v: View = view) {
  const identity = to === toWallet ? key(KEYS.instance).toPublicKey().toString() : key(KEYS.payee).toPublicKey().toString();
  await to.send(identity, "wallet", body);
  return resultWhere(String(body.op), (r) => r.op === body.op, 30_000, v);
}

/** How many wallet steps a store has (a redelivered status must add none). */
const steps = async (v: View) => (await updates(v)).length;

/** Arcade's webhook to the router's callback route. */
const webhook = (auth: string, body: unknown) => fetch(`http://127.0.0.1:${port}/arc/callback`, {
  method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: JSON.stringify(body),
});

/** Until the router's broadcaster has dropped `n` redeliveries in all. */
const duplicates = (n: number) => until(`${n} redeliveries dropped`, async () => (router.arc!.stats.duplicates >= n ? true : undefined));

// ---------------------------------------------------------------- settlement (#37)

/**
 * A rejection after a dependent spend: A pays someone from our change, B
 * spends A's change, then Arcade's status for A says DOUBLE_SPEND_ATTEMPTED
 * (the status provider's message, routed by its subject to A's awaiting
 * thread). A and B are rejected (the bubbling: B spends A), their outputs
 * vanish, the input A consumed is spendable again. Settlement is state to
 * read: nothing is sent to anyone; whoever cares reads it when it next acts.
 * B's own thread is not replayed: B's own status (Arcade rejects the orphan)
 * steps it, it reads B rejected, and finishes. The results name the
 * transactions as `mentions`.
 */
async function settlementScenario(someone: Uint8Array, reorg: { h102: Uint8Array; spend: string }): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const total0 = (await owned({ op: "list" })).result.total;

  const a = await owned({ op: "createAction", description: "A", outputs: [{ lockingScript: someone, satoshis: 1_000 }] });
  const b = await owned({ op: "createAction", description: "B", outputs: [{ lockingScript: someone, satoshis: 500 }] });
  const txA = a.result.txid as string, txB = b.result.txid as string;
  const bTx = Transaction.fromAtomicBEEF([...(b.result.tx as Uint8Array)]);
  out.bSpendsA = bTx.inputs.some((i) => (i.sourceTXID ?? i.sourceTransaction?.id("hex")) === txA);
  out.awaiting = [a.state, b.state];

  await resultWhere("A's RECEIVED", (res, _s, t) => t.equals(a.thread) && res.event === "status");
  await resultWhere("B's RECEIVED", (res, _s, t) => t.equals(b.thread) && res.event === "status");
  arcade.emit(txA, { txStatus: "DOUBLE_SPEND_ATTEMPTED" });
  const r = await resultWhere("A's status message", (res) => res.op === "callback" && res.txid === txA && res.event === "status" && res.txStatus === "DOUBLE_SPEND_ATTEMPTED");
  out.rejected = {
    sameThread: r.thread.equals(a.thread), outcome: r.result.outcome, state: r.state,
  };
  const list = await owned({ op: "list", includeSpent: true });
  out.inputsFreed = list.result.total === total0;
  out.noOutputsOfAB = !(list.result.outputs as Array<Record<string, unknown>>).some((o) => o.txid === txA || o.txid === txB);

  // B's thread was not replayed: B's own status (Arcade rejects the orphan) steps it, it finds B rejected, and finishes.
  arcade.emit(txB, { txStatus: "REJECTED" });
  const bw = await resultWhere("B's status", (res, _s, t) => t.equals(b.thread) && res.op === "callback" && res.txStatus === "REJECTED", 15_000);
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
  // unproven again, broadcast again like a fresh one (Arcade echoes its status), awaited. Arcade
  // saw the reorg too: the spend is SEEN_ON_NETWORK again, no path (a status already routed once:
  // the stream's copy and the echo are dropped).
  arcade.emit(reorg.spend, { txStatus: "SEEN_ON_NETWORK" });
  const posts = arcade.posts.length;
  const alt103 = mine(reorg.h102, sha256d(Buffer.from("alt 103")), 1_790_000_000 + 103 * 600 + 1);
  const alt104 = mine(sha256d(alt103), sha256d(Buffer.from("alt 104")), 1_790_000_000 + 104 * 600);
  const h = await owned({ op: "headers", headers: [alt103, alt104] });
  await router.settled(); // the broadcaster has posted what the step emitted (#65)
  out.reorg = {
    replaced: h.result.replaced, reverted: (h.result.reverted as string[] | undefined)?.map((t) => t === reorg.spend ? "spend" : "?"),
    reposted: arcade.posts.length === posts + 1 && lastPosted().id("hex") === reorg.spend,
    state: h.state, awaited: (h.result.awaited as string[] | undefined)?.includes(reorg.spend),
  };
  return out;
}

// ---------------------------------------------------------------- the scenario

try {
  const { kernel: k, identity } = await router.hydrate("wallettest");
  await k.store.put(WALLET as never);
  const { kernel: pk, identity: payeeId } = await router.hydrate("payee");
  await pk.store.put(WALLET as never);
  view = openStoreFile(db, { readOnly: true });
  payeeView = openStoreFile(payeeDb, { readOnly: true });
  const g = await k.genesis() as { addressBook?: Array<{ role?: string; transport?: string; key?: Uint8Array }>; subscriptions?: Array<{ match: { sender?: Uint8Array; box?: string } }> };
  const statusKey = g.addressBook?.find((e) => e.role === "status" && e.transport === "local")?.key;
  report.statusProvider = !!statusKey && !!g.subscriptions?.some((s) => s.match.box === "status" && s.match.sender && Buffer.from(s.match.sender).equals(Buffer.from(statusKey)));

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

  // Headers: 1..100 from the owner (to both instances), 101 and 102 as plain entries from the router's SSE header feed.
  let r = await owned({ op: "headers", headers: headers.slice(0, 100) });
  report.headers = [r.result.added, r.result.tip];
  await owned({ op: "headers", headers: headers.slice(0, 100) }, toPayee, payeeView);
  for (const [i, raw] of headers.slice(100).entries()) {
    await feedHeader(raw);
    r = await resultWhere("a header entry", (res) => res.event === "header" && res.tip === 101 + i);
    await resultWhere("the payee's header entry", (res) => res.event === "header" && res.tip === 101 + i, 30_000, payeeView);
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
  r = await owned({
    op: "internalize", tx: new Uint8Array(pay.toAtomicBEEF()), description: "funding",
    outputs: [{ outputIndex: 0, protocol: "wallet payment", paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey: ownerId } }],
  });
  report.internalize = [r.result.txid === pay.id("hex"), r.result.status];

  // Spend: pay the payee instance 10000 (BRC-29 to its key); signed by the oracle, broadcast as an event, the thread awaits.
  const p2 = Buffer.from("payee-prefix").toString("base64"), s2 = Buffer.from("payee-suffix").toString("base64");
  const payeeScript = new P2PKH().lock(new KeyDeriver(key(KEYS.instance)).derivePublicKey([2, "3241645161d8"], `${p2} ${s2}`, payeeId, false).toHash()).toBinary();
  r = await owned({ op: "createAction", description: "pay the payee", labels: ["out"], outputs: [{ lockingScript: new Uint8Array(payeeScript), satoshis: 10_000, outputDescription: "to the payee" }] });
  const spendTxid = r.result.txid as string;
  const spendThread = r.thread;
  // #65: the step's update lists the broadcast event (no recipient, no signature) and rests until the abandonment.
  const step = (await updates(view)).find(({ thread, update }) => thread.equals(spendThread) && update.step === 1)!.update as unknown as { emitted?: CID[]; until?: number; at: number; calls?: CID[] };
  const ev = await view.get(step.emitted![0]!) as unknown as { kind: string; tx: CID; beef?: Uint8Array; recipient?: unknown };
  // The host's answer: Arcade's 202 RECEIVED, a status message from the status provider.
  const answered = await resultWhere("Arcade's RECEIVED", (res, _s, t) => t.equals(spendThread) && res.op === "callback" && res.event === "status");
  const posted = lastPosted();
  report.create = {
    state: r.state, awaiting: r.result.awaiting, outcome: r.result.outcome, event: [ev.kind, ev.tx.equals(txCid(spendTxid)), ev.beef instanceof Uint8Array, ev.recipient === undefined, step.emitted!.length],
    until: step.until === step.at + 86_400_000, received: [answered.result.txStatus, answered.result.outcome, answered.state],
    postedIsTheTx: posted.id("hex") === spendTxid, extendedFormat: Buffer.from(arcade.posts.at(-1)!).equals(Buffer.from(posted.toEF())),
    token: arcade.postHeaders.at(-1)!["x-callbacktoken"] === ARC_TOKEN,
    scriptsVerify: await Transaction.fromAtomicBEEF([...(r.result.tx as Uint8Array)]).verify("scripts only"),
    inputs: posted.inputs.map((i) => i.sourceTXID ?? i.sourceTransaction?.id("hex")), outputs: posted.outputs.map((o) => o.satoshis),
  };

  // The payee receives the payment: the same transaction, held in its own state.
  const pr = await owned({
    op: "internalize", tx: r.result.tx, description: "from wallettest",
    outputs: [{ outputIndex: 0, protocol: "wallet payment", paymentRemittance: { derivationPrefix: p2, derivationSuffix: s2, senderIdentityKey: identity } }],
  }, toPayee, payeeView);
  report.payeeInternalize = [pr.result.txid === spendTxid, pr.result.status];

  // Arcade's statuses on the host's one stream reach both holders: the wallet's awaiting thread, the payee's subscription.
  arcade.emit(spendTxid, { txStatus: "SEEN_ON_NETWORK" });
  const seenW = await resultWhere("SEEN_ON_NETWORK at the wallet", (res) => res.op === "callback" && res.event === "status" && res.txid === spendTxid && res.txStatus === "SEEN_ON_NETWORK");
  const seenP = await resultWhere("SEEN_ON_NETWORK at the payee", (res) => res.op === "event" && res.event === "status" && res.txid === spendTxid && res.txStatus === "SEEN_ON_NETWORK", 30_000, payeeView);
  report.seen = { wallet: [seenW.thread.equals(spendThread), seenW.result.outcome, seenW.state], payee: [seenP.result.outcome, seenP.state] };

  // A webhook brings the next one first; the stream's copy of it writes nothing.
  report.webhookRefused = (await webhook("Bearer wrong", { txid: spendTxid, txStatus: "SEEN_ON_MULTIPLE_NODES" })).status;
  report.webhook = (await webhook(`Bearer ${ARC_TOKEN}`, { timestamp: new Date().toISOString(), txid: spendTxid, txStatus: "SEEN_ON_MULTIPLE_NODES" })).status;
  const mW = await resultWhere("SEEN_ON_MULTIPLE_NODES at the wallet", (res) => res.op === "callback" && res.event === "status" && res.txid === spendTxid);
  const mP = await resultWhere("SEEN_ON_MULTIPLE_NODES at the payee", (res) => res.op === "event" && res.event === "status" && res.txid === spendTxid, 30_000, payeeView);
  await router.settled();
  let before = [await steps(view), await steps(payeeView)];
  arcade.emit(spendTxid, { txStatus: "SEEN_ON_MULTIPLE_NODES" });
  await duplicates(1);
  await router.settled();
  report.multiple = { wallet: mW.result.outcome, payee: mP.result.outcome, streamCopyWroteNothing: JSON.stringify(before) === JSON.stringify([await steps(view), await steps(payeeView)]) };

  // Mined at 103: the header (to both), then MINED with the merkle path on the stream: both prove it.
  const h103 = mine(prev, internal(spendTxid), 1_790_000_000 + 103 * 600);
  await feedHeader(h103);
  await resultWhere("header 103", (res) => res.event === "header" && res.tip === 103);
  await resultWhere("the payee's header 103", (res) => res.event === "header" && res.tip === 103, 30_000, payeeView);
  const path = new MerklePath(103, [[{ offset: 0, hash: spendTxid, txid: true }]]);
  const block103 = Buffer.from(sha256d(h103)).reverse().toString("hex");
  arcade.emit(spendTxid, { txStatus: "MINED", blockHash: block103, blockHeight: 103, merklePath: path.toHex() });
  r = await resultWhere("the MINED proof", (res) => res.op === "callback" && res.event === "proof" && res.txid === spendTxid && res.outcome !== "pending");
  const minedP = await resultWhere("the payee's MINED proof", (res) => res.op === "event" && res.event === "proof" && res.txid === spendTxid && res.outcome !== "pending", 30_000, payeeView);
  report.mined = { same: r.thread.equals(spendThread), outcome: r.result.outcome, state: r.state, payee: minedP.result.outcome };

  // Arcade retries its webhook: the same MINED again writes nothing.
  await router.settled();
  before = [await steps(view), await steps(payeeView)];
  report.redelivered = (await webhook(`Bearer ${ARC_TOKEN}`, arcade.webhookBody(spendTxid))).status;
  await duplicates(2);
  await router.settled();
  report.redeliveryWroteNothing = JSON.stringify(before) === JSON.stringify([await steps(view), await steps(payeeView)]);

  r = await owned({ op: "list", includeSpent: true });
  report.list = (r.result.outputs as Array<Record<string, unknown>>).map((o) => [o.txid === spendTxid ? "change" : o.txid === pay.id("hex") ? "payment" : "?", o.satoshis, o.spendable, o.status]);
  report.total = r.result.total;
  r = await owned({ op: "list" }, toPayee, payeeView);
  report.payeeList = (r.result.outputs as Array<Record<string, unknown>>).map((o) => [o.txid === spendTxid, o.satoshis, o.spendable, o.status]);

  // A rejected broadcast (Arcade's 400, a REJECTED status): the action is dropped, its inputs are spendable again.
  const someone = new P2PKH().lock(key("5555").toPublicKey().toHash()).toBinary();
  arcade.mode = "reject";
  r = await owned({ op: "createAction", description: "rejected", outputs: [{ lockingScript: new Uint8Array(someone), satoshis: 1_000 }] });
  const refusedTx = r.thread;
  r = await resultWhere("Arcade's 400", (res, _s, t) => t.equals(refusedTx) && res.op === "callback" && res.event === "status");
  report.rejected = { outcome: r.result.outcome, state: r.state, txStatus: r.result.txStatus, awaiting: r.result.awaiting ?? false };
  arcade.mode = "ok";
  r = await owned({ op: "list" });
  report.afterReject = r.result.total;

  // A draft, then signAction.
  r = await owned({ op: "createAction", description: "draft", outputs: [{ lockingScript: new Uint8Array(someone), satoshis: 2_000 }], options: { signAndProcess: false } });
  const draft = { reference: r.result.reference as CID, txid: r.result.txid, posts: arcade.posts.length };
  r = await owned({ op: "signAction", reference: draft.reference });
  await router.settled();
  const signed = lastPosted();
  report.draft = { hasReference: CID.asCID(draft.reference) !== null, notPostedAsDraft: draft.posts === arcade.posts.length - 1, awaiting: r.result.awaiting, scriptsVerify: await Transaction.fromAtomicBEEF([...(r.result.tx as Uint8Array)]).verify("scripts only"), txid: r.result.txid === signed.id("hex") };

  report.settlement = await settlementScenario(new Uint8Array(someone), { h102: prev, spend: spendTxid });

  // Backpressure (Arcade's 503): the host keeps it queued and posts it again until Arcade takes it; the instance never sees the 503.
  arcade.mode = "busy";
  const posts = arcade.posts.length;
  const t = await owned({ op: "createAction", description: "transient", outputs: [{ lockingScript: new Uint8Array(someone), satoshis: 700 }] });
  const T = t.result.txid as string;
  await until("posted again while busy", async () => (arcade.posts.length >= posts + 2 ? true : undefined));
  const queued = router.arc!.queued().find((q) => q.txid === T);
  const seenBusy = (await updates(view)).filter(({ thread }) => thread.equals(t.thread)).length;
  arcade.mode = "ok";
  r = await resultWhere("Arcade takes it", (res, _s, th) => th.equals(t.thread) && res.op === "callback" && res.event === "status");
  report.transient = {
    state: t.state, outcome: t.result.outcome, queued: !!queued && queued.attempts >= 1, untouched: seenBusy === 1,
    taken: [r.result.txStatus, r.result.outcome, r.state], offTheQueue: !router.arc!.queued().some((q) => q.txid === T),
  };

  // The host restarts while Arcade moves on: the new router resumes after the last event id it took.
  await router.settled();
  const lastTaken = hostDb.cursor(arcade.eventsUrl);
  const statusSteps = async () => (await Promise.all((await updates(view)).map(async ({ update }) => {
    const out = Buffer.from(update.result?.stdout ?? []).toString().trim();
    if (!out) return 0;
    const res = decode<Result>(await view.bytes(CID.decode(Buffer.from(out, "hex"))));
    return res.event === "status" ? 1 : 0;
  }))).reduce((a: number, b) => a + b, 0);
  const statusesBefore = await statusSteps();
  await router.stop();
  arcade.emit(T, { txStatus: "SEEN_ON_NETWORK" });
  router = make();
  await router.listen(port);
  await router.start();
  r = await resultWhere("the status missed while down", (res) => res.op === "callback" && res.event === "status" && res.txid === T && res.txStatus === "SEEN_ON_NETWORK");
  await router.settled();
  report.resumed = {
    lastEventId: lastTaken !== undefined && arcade.connects.at(-1) === lastTaken, sameThread: r.thread.equals(t.thread), outcome: r.result.outcome, state: r.state,
    onlyTheMissed: (await statusSteps()) === statusesBefore + 1,
  };

  report.ok = true;
} catch (e) {
  report.error = (e as Error).stack ?? String(e);
}
await router.stop();
hostDb.close();
// #42: the TS reader derives the kernel's edges map key for key (a kept transaction's inputs included; kept headers contribute none, decided 2026-09-30).
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
await arcade.close();

const eq = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
process.stdout.write(`== the wallet on ${abi}${abi === "component" ? ` (${component})` : ""}\n`);
check(report.ok === true, `the scenario ran${report.error ? `: ${report.error}` : ""}`);
check(report.statusProvider === true, "#65: the genesis's address book names the host's status provider (local, role status), and the instance subscribes to it in `status`");
check(eq(report.headers, [100, 100]), `headers 1..100 from the owner, chained from regtest's genesis (${JSON.stringify(report.headers)})`);
check(eq(report.headerEntry, ["header", 102]), `plain header entries from the router's SSE feed, routed by a sender-less subscription (${JSON.stringify(report.headerEntry)})`);
check(eq(report.internalize, [true, "unproven"]), `a BRC-29 payment internalized (${JSON.stringify(report.internalize)})`);
const c = (report.create ?? {}) as Record<string, unknown> & { outputs?: number[] };
check(c.state === "waiting" && c.awaiting === true && c.outcome === "pending" && eq(c.event, ["broadcast", true, true, true, 2]) && c.until === true, `createAction: signed, broadcast as an event (the update lists it: no recipient, its BEEF — and the deadline's wake-me beside it), the thread awaits until its abandonment (${JSON.stringify(c)})`);
check(eq(c.received, ["RECEIVED", "pending", "waiting"]), `the host posted it: Arcade's 202 RECEIVED reaches the awaiting thread as the status provider's message (${JSON.stringify(c.received)})`);
check(c.postedIsTheTx === true && c.extendedFormat === true && c.token === true && c.scriptsVerify === true, "Arcade received the transaction in Extended Format under the host's callback token; @bsv/sdk verifies its scripts (signatures from the oracle)");
check(eq(c.outputs?.slice(0, 1), [10000]) && c.outputs?.length === 2, `the payment and our change (${JSON.stringify(c.outputs)})`);
check(eq(report.payeeInternalize, [true, "unproven"]), `the payee instance internalizes the same transaction: it holds it too (${JSON.stringify(report.payeeInternalize)})`);
check(eq(report.seen, { wallet: [true, "pending", "waiting"], payee: ["pending", "finished"] }), `SEEN_ON_NETWORK on the host's one stream reaches both holders as status messages: the wallet's awaiting thread and the payee's subscription (${JSON.stringify(report.seen)})`);
check(report.webhookRefused === 401 && report.webhook === 200, `Arcade's webhook at /arc/callback: the wrong token refused, the host's taken (${String(report.webhookRefused)}, ${String(report.webhook)})`);
check(eq(report.multiple, { wallet: "pending", payee: "pending", streamCopyWroteNothing: true }), `a webhook's status reaches both holders; the stream's copy of it writes nothing (${JSON.stringify(report.multiple)})`);
check(eq(report.mined, { same: true, outcome: "proven", state: "finished", payee: "proven" }), `MINED with the BUMP on the stream, a proof event: the wallet's awaiting thread proves the transaction, and so does the payee (${JSON.stringify(report.mined)})`);
check(report.redelivered === 200 && report.redeliveryWroteNothing === true, `a redelivered MINED (Arcade's webhook retry) writes nothing (${String(report.redelivered)}, ${String(report.redeliveryWroteNothing)})`);
check(Array.isArray(report.list) && (report.list as unknown[][]).some((o) => o[0] === "change" && o[2] === true && o[3] === "proven") && (report.list as unknown[][]).some((o) => o[0] === "payment" && o[2] === false), `list: the change spendable and proven, the payment spent (${JSON.stringify(report.list)})`);
check(eq(report.payeeList, [[true, 10000, true, "proven"]]), `the payee's list: the payment spendable and proven (${JSON.stringify(report.payeeList)})`);
check(eq(report.rejected, { outcome: "rejected", state: "finished", txStatus: "REJECTED", awaiting: false }) && report.afterReject === report.total, `a rejected broadcast (Arcade's 400: a REJECTED status) drops the action: the balance is back (${JSON.stringify(report.rejected)}, ${report.afterReject} vs ${report.total})`);
const d = (report.draft ?? {}) as Record<string, unknown>;
check(d.hasReference === true && d.notPostedAsDraft === true && d.awaiting === true && d.scriptsVerify === true && d.txid === true, `a draft (signAndProcess: false), then signAction: signed, broadcast, awaiting (${JSON.stringify(d)})`);

const st = (report.settlement ?? {}) as Record<string, unknown>;
check(eq(st.awaiting, ["waiting", "waiting"]) && st.bSpendsA === true, `settlement (#37): A, then B spending A's change, both broadcast and awaited (${JSON.stringify([st.awaiting, st.bSpendsA])})`);
check(eq(st.rejected, { sameThread: true, outcome: "rejected", state: "finished" }), `a DOUBLE_SPEND_ATTEMPTED status message for A reaches A's thread: A rejected (${JSON.stringify(st.rejected)})`);
check(st.inputsFreed === true && st.noOutputsOfAB === true, `the rejected outputs vanish; the input A consumed is spendable again (${JSON.stringify([st.inputsFreed, st.noOutputsOfAB])})`);
check(eq(st.bThread, { outcome: "rejected", state: "finished" }), `the rejection bubbled to B (spends A): B's thread is not replayed, B's own status steps it, it reads B rejected and finishes (${JSON.stringify(st.bThread)})`);
check(st.mentions === true, "the results name the transactions as `mentions` edges (which never propagate)");
check(st.spendsEdge === true, "#42: B's input is a `spends` edge into A, from B's own kept block, locator = the vout it spends");
check(st.explorer === true, "#42: the explorer's record page for A shows it decoded (bitcoin-tx, its inputs) and ← spends from B");
check(eq(report.edges, { sameRoot: true, bitcoin: [true, false, false] }), `#42: the TS reader derives the kernel's edges map (same root), with spends edges from the kept transactions and no prev / merkleroot edges from the kept headers (${JSON.stringify(report.edges)})`);
check(eq(st.reorg, { replaced: 1, reverted: ["spend"], reposted: true, state: "waiting", awaited: true }), `a reorg drops block 103: the spend proven there is unproven again, broadcast again, awaited (${JSON.stringify(st.reorg)})`);
check(eq(report.transient, { state: "waiting", outcome: "pending", queued: true, untouched: true, taken: ["RECEIVED", "pending", "waiting"], offTheQueue: true }), `Arcade's 503 (backpressure): the host's queue posts it again until taken; the instance never sees it, and hears RECEIVED once it is (${JSON.stringify(report.transient)})`);
check(eq(report.resumed, { lastEventId: true, sameThread: true, outcome: "pending", state: "waiting", onlyTheMissed: true }), `a host restart: the stream resumes with Last-Event-ID from host.db, the status missed while down reaches the thread, nothing twice (${JSON.stringify(report.resumed)})`);

const r = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), db, payeeDb], { encoding: "utf8" });
process.stdout.write(r.stdout);
if (r.status !== 0) process.stdout.write(r.stderr);
check(r.status === 0 && /identical .*the source store reproduced exactly/.test(r.stdout), "both stores replay to themselves exactly, twice over: the oracle's answers from the recorded calls");

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
  process.stdout.write(`== the wallet as a component: skipped (no ${component}; \`cd programs/wallet && zig build component\`)\n`);
}

rmSync(home, { recursive: true, force: true });
process.stdout.write(failures ? `wallet (${abi}): ${failures} FAILED\n` : `wallet (${abi}): all ok\n`);
process.exit(failures ? 1 : 0);

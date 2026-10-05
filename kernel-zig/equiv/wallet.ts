// The wallet in the VM (issues #29, #79) end to end on the Zig kernel, on a
// test host (src/host/testhost.ts) with the host's broadcaster (#58, #65) in
// front of a fake Arcade (src/host/fake-arcade.ts) and a fake SSE header
// feed. Since #79 the wallet keeps only its own records (actions, coins,
// drafts, under `wallet/state`) and the chain is the chain app's
// (shruggr/skein-chain, installed into both instances with `skein-host
// install`): the feed's headers go to the chain app; the wallet reads
// `chain/state` by CID and hands every transaction to the chain app as an
// `ingest` message to the instance itself (the host's loopback), then waits
// on the chain app's answers — accepted, proven, rejected. The wallet never
// broadcasts; the chain app does. Then the stores are replayed Zig against
// Zig (equiv/replays.ts): the signer's answers come from the recorded calls.
//
// The chain is regtest from its genesis: headers 1..102 on the feed; the
// owner funds the instance with a BRC-29 payment (internalize: SPV against
// the chain state's headers, then ingested — the chain app broadcasts it);
// the instance pays a second instance, the payee, with a BRC-29 payment
// (createAction: signed through the signer, its step emits the ingest
// message — no broadcast event of its own — and rests awaiting it): the
// chain app broadcasts it, Arcade's RECEIVED makes it `accepted` (the same
// thread steps), MINED with the merkle path makes it `proven` (the thread
// finishes); the payee internalizes it and is answered the same way. A
// rejected broadcast (Arcade's 400) gives the inputs back; a draft
// (signAndProcess: false) is signed by signAction. Settlement (#37): A, then
// B spending A's change; a DOUBLE_SPEND_ATTEMPTED for A rejects A at the
// chain app, which rejects B too (input-rejected): both threads are answered
// `rejected`, their coins vanish, A's input is spendable again — computed
// from the chain state at read time. A reorg dropping the block a spend was
// proven in: the chain app broadcasts it again, and the wallet lists that
// change as unproven again with nothing of its own rewritten.
//
// Issue #34, when the wallet's component build is there
// (programs/wallet/zig-out/bin/wallet.component.wasm from `zig build component`, or
// $SKEIN_WALLET_COMPONENT): the preview1 store's log is replayed with the
// component in the module's place (equiv/abi.ts: every update identical but
// for fuel), and the whole scenario runs again with the component as the
// wallet program (SKEIN_WALLET_ABI=component): the same report, and its
// store replays to itself exactly.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/wallet.ts

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KeyDeriver, MerklePath, P2PKH, PrivateKey, Transaction, UnlockingScript } from "@bsv/sdk";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import { RawBox } from "../../src/client/raw.ts";
import { FakeArcade } from "../../src/host/fake-arcade.ts";
import { main } from "../../src/host/cli.ts";
import { testHost, until } from "../../src/host/testhost.ts";
import { decode, encode } from "../../src/runtime/cid.ts";
import { buildTree, derive, openStoreFile } from "../../src/runtime/index-store.ts";
import { MODULES, rawCid, WALLET as WALLET_P1 } from "../../src/runtime/programs.ts";
import type { ThreadUpdate } from "../../src/runtime/types.ts";
import { collect } from "../../src/testkit.ts";

const here = dirname(fileURLToPath(import.meta.url));
const component = process.env.SKEIN_WALLET_COMPONENT ?? join(here, "../../programs/wallet/zig-out/bin/wallet.component.wasm");
/** This run's ABI: the pinned preview1 module, or (issue #34) the component build of the same program. */
const abi = process.env.SKEIN_WALLET_ABI === "component" ? "component" : "preview1";
if (abi === "component") process.env.SKEIN_EXTRA_MODULES = component; // the kernels the router spawns install it
const WALLET = abi === "component" ? { ...WALLET_P1, code: { wasm: rawCid(readFileSync(component)) } } : WALLET_P1;
const WALLET_CID = encode(WALLET).cid;
// The chain app (#78, #79): SKEIN_CHAIN_DIR names a checkout, else this commit.
const CHAIN_REPO = "https://github.com/shruggr/skein-chain";
const CHAIN_REV = process.env.SKEIN_CHAIN_REV ?? "9668965821fb50cfa0853519834f319983ab7f53";
const report: Record<string, unknown> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };

// ---------------------------------------------------------------- regtest

const sha256d = (b: Uint8Array) => createHash("sha256").update(createHash("sha256").update(b).digest()).digest();
const internal = (displayHex: string) => Buffer.from(displayHex, "hex").reverse();
const display = (h: Uint8Array) => Buffer.from(h).reverse().toString("hex");
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

// ---------------------------------------------------------------- a fake Arcade, a fake header feed (SSE), the host

const arcade = await FakeArcade.start();
const ARC_TOKEN = "the-host-arcade-token";
/** The transaction Arcade received last (Extended Format). */
const lastPosted = () => FakeArcade.txOf(arcade.posts.at(-1)!);

const sse: ServerResponse[] = [];
const sseServer = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": headers\n\n"); sse.push(res); });
await new Promise<void>((r) => sseServer.listen(0, "127.0.0.1", r));
const SSE_URL = `http://127.0.0.1:${(sseServer.address() as { port: number }).port}/headers`;
let sseId = 0;
/** A header on the feed (the host holds one connection per feed URL and admits each event into every instance naming it): its hex as the event's data (the host admits it as a `header` event in box `chain`). */
const feedHeader = async (raw: Uint8Array) => {
  for (let i = 0; !sse.length && i < 400; i++) await sleep(25);
  for (const s of sse) s.write(`id: ${++sseId}\ndata: ${Buffer.from(raw).toString("hex")}\n\n`);
};

const ownerKey = new PrivateKey("2222", 16);
const ownerId = ownerKey.toPublicKey().toString();
const afters: Array<() => unknown> = [];
const h = await testHost({ after: (f) => afters.push(f) }, {
  ownerKey,
  arc: { url: arcade.url, token: ARC_TOKEN, events: arcade.eventsUrl }, arcRetry: { min: 300, max: 1000 },
  genesis: {
    // The owner's box → the wallet (genesis-wired: its writes the stock scope wallet/). Headers, proofs and
    // statuses are the chain app's (installed below), not the wallet's.
    subscriptions: [{ box: "wallet", sender: ownerId, handler: WALLET_CID }],
    defaults: { walletNetwork: "regtest", walletFeeRate: "100" },
    feeds: [{ kind: "headers", url: SSE_URL }],
  },
});
const owner = h.owner;
const identity = h.agent("wallettest");
const payeeId = h.agent("payee");
const toWallet = new RawBox(owner, `${h.base}/@wallettest`);
const toPayee = new RawBox(owner, `${h.base}/@payee`);

type Result = Record<string, unknown> & { op: string };
type View = ReturnType<typeof openStoreFile>;
let view!: View;
let payeeView!: View;
let db = "", payeeDb = "";
const seen = new Set<string>();

/** A program's threads' updates in a store, oldest first. */
async function updates(v: View, program: CID = WALLET_CID): Promise<Array<{ thread: CID; update: ThreadUpdate & { kept?: CID[]; emitted?: CID[]; result?: { stdout: Uint8Array; stderr: Uint8Array } } }>> {
  const out = [];
  for (const t of await collect(v.edges.query({ kind: "thread", program }))) {
    for (const u of (await collect(v.chains.history(t))).slice(1)) out.push({ thread: t, update: await v.get(u) as never });
  }
  return out;
}

/** The next unseen ended step of `program` in a store whose result satisfies `pred`. */
async function resultWhere(what: string, pred: (r: Result, state: string, thread: CID) => boolean, ms = 30_000, v: View = view, program: CID = WALLET_CID) {
  return until(what, async () => {
    for (const { thread, update } of await updates(v, program)) {
      const k = `${String(program)}/${thread}/${update.step}`;
      if (seen.has(k) || update.state === "running") continue;
      if (update.state === "errored") throw new Error(`${what}: a step errored: ${update.error?.message}`);
      const stdout = Buffer.from(update.result?.stdout ?? []).toString().trim();
      if (!stdout) continue;
      const result = decode<Result>(await v.bytes(CID.decode(Buffer.from(stdout, "hex"))));
      if (!pred(result, update.state, thread)) continue;
      seen.add(k);
      return { result, state: update.state, thread, update };
    }
    return undefined;
  }, ms);
}

/** An owner's message to an instance's `wallet` box, and the step that answers it. */
async function owned(body: Record<string, unknown>, to = toWallet, v: View = view) {
  await to.send(to === toWallet ? identity : payeeId, "wallet", body);
  return resultWhere(String(body.op), (r) => r.op === body.op, 30_000, v);
}
/** The chain app's next answer to a wallet thread: the callback step it drives. */
const answered = (what: string, thread: CID, pred: (r: Result) => boolean = () => true, v: View = view) =>
  resultWhere(what, (res, _s, t) => t.equals(thread) && res.op === "callback" && pred(res), 30_000, v);

function cloneChain(): string {
  const dir = join(h.home, "skein-chain");
  for (const args of [["clone", "-q", CHAIN_REPO, dir], ["-C", dir, "checkout", "-q", CHAIN_REV]]) {
    const r = spawnSync("git", args, { stdio: ["ignore", "ignore", "inherit"] });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: exit ${r.status}`);
  }
  return dir;
}

// ---------------------------------------------------------------- settlement (#37) at the chain app, read by the wallet

async function settlementScenario(someone: Uint8Array, reorg: { h102: Uint8Array; spend: string }): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const total0 = (await owned({ op: "list" })).result.total;
  const a = await owned({ op: "createAction", description: "A", outputs: [{ lockingScript: someone, satoshis: 1_000 }] });
  const b = await owned({ op: "createAction", description: "B", outputs: [{ lockingScript: someone, satoshis: 500 }] });
  const txA = a.result.txid as string, txB = b.result.txid as string;
  const bTx = Transaction.fromAtomicBEEF([...(b.result.tx as Uint8Array)]);
  out.bSpendsA = bTx.inputs.some((i) => (i.sourceTXID ?? i.sourceTransaction?.id("hex")) === txA);
  out.awaiting = [a.state, b.state];
  await answered("A accepted", a.thread, (r) => r.outcome === "accepted");
  await answered("B accepted", b.thread, (r) => r.outcome === "accepted");
  arcade.emit(txA, { txStatus: "DOUBLE_SPEND_ATTEMPTED" });
  const ra = await answered("A rejected", a.thread, (r) => r.outcome === "rejected");
  const rb = await answered("B rejected", b.thread, (r) => r.outcome === "rejected");
  out.rejected = { a: [ra.result.reason, ra.state], b: [rb.result.reason, rb.state] };
  const list = await owned({ op: "list", includeSpent: true });
  out.inputsFreed = list.result.total === total0;
  out.noOutputsOfAB = !(list.result.outputs as Array<Record<string, unknown>>).some((o) => o.txid === txA || o.txid === txB);
  out.mentions = (await view.edges.refsTo(txCid(txA))).some((x) => x.rel === "mentions");
  // #42: B's input is a `spends` edge into A — from B itself (a kept bitcoin-tx block), its locator A's vout.
  const intoA = await view.edges.refsTo(txCid(txA));
  const bSpends = intoA.filter((x) => x.rel === "spends" && x.from.equals(txCid(txB)));
  out.spendsEdge = bSpends.length === 1 && bSpends[0]!.locator === String(Transaction.fromHex(Buffer.from(await view.bytes(txCid(txB))).toString("hex")).inputs[0]!.sourceOutputIndex);

  // A reorg: a heavier branch from 102 drops block 103, where our first spend was proven. The chain
  // app turns it back to unproven and broadcasts it again; the wallet rewrites nothing and lists that
  // change unproven again.
  const posts = arcade.posts.length;
  const alt103 = mine(reorg.h102, sha256d(Buffer.from("alt 103")), 1_790_000_000 + 103 * 600 + 1);
  const alt104 = mine(sha256d(alt103), sha256d(Buffer.from("alt 104")), 1_790_000_000 + 104 * 600);
  // A heavier branch arrives as one run (its first header alone is no heavier than ours): one `header` event with `raws`.
  for (const inst of ["wallettest", "payee"]) await h.router.admitEvent(inst, "chain", { kind: "header", raws: [alt103, alt104] });
  await until("the reorg's rebroadcast", async () => { await h.router.settled(); return arcade.posts.slice(posts).some((p) => FakeArcade.txOf(p).id("hex") === reorg.spend) ? true : undefined; });
  const after = await owned({ op: "list", includeSpent: true });
  out.reorg = {
    reposted: true,
    change: (after.result.outputs as Array<Record<string, unknown>>).filter((o) => o.txid === reorg.spend).map((o) => o.status),
  };
  return out;
}

// ---------------------------------------------------------------- the scenario

try {
  await h.router.start();
  // The chain app, installed into both instances (#78, #79).
  const spec = process.env.SKEIN_CHAIN_DIR ?? cloneChain();
  for (const inst of ["wallettest", "payee"]) {
    const err: string[] = [];
    const code = await main(["install", spec, "--instance", inst, "--approve-all"], {
      vars: { SKEIN_HOME: h.home, HOME: h.home }, out: () => {}, err: (l) => err.push(l),
      owner: { wallet: owner, box: (row) => new RawBox(owner, `${h.base}/@${row.handle}`) },
    });
    if (code !== 0) throw new Error(`install skein-chain into ${inst}: ${err.join(" ")}`);
  }
  await h.router.settled();
  const k = (await h.router.hydrate("wallettest")).kernel;
  await k.store.put(WALLET as never);
  await (await h.router.hydrate("payee")).kernel.store.put(WALLET as never);
  db = h.db.get("wallettest")!.store;
  payeeDb = h.db.get("payee")!.store;
  view = openStoreFile(db, { readOnly: true });
  payeeView = openStoreFile(payeeDb, { readOnly: true });
  const chainApp = await k.store.get(await k.call("head", "chain/app") as CID) as { programs: Record<string, CID> };
  const CHAIN = chainApp.programs.chain!;
  const payeeChainApp = await (await h.router.hydrate("payee")).kernel.store.get(await (await h.router.hydrate("payee")).kernel.call("head", "chain/app") as CID) as { programs: Record<string, CID> };
  report.sameChainProgram = CHAIN.equals(payeeChainApp.programs.chain!);

  // The funding: mined alone at 101 (root = its txid), paying the owner.
  const fund = new Transaction();
  fund.addInput({ sourceTXID: "11".repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex("51"), sequence: 0xffffffff });
  fund.addOutput({ lockingScript: new P2PKH().lock(ownerKey.toPublicKey().toHash()), satoshis: 50_000 });
  const fundTxid = fund.id("hex");
  fund.merklePath = new MerklePath(101, [[{ offset: 0, hash: fundTxid, txid: true }]]);
  const headers: Uint8Array[] = [];
  let prev: Uint8Array = sha256d(REGTEST_GENESIS);
  for (let n = 1; n <= 102; n++) {
    const root = n === 101 ? internal(fundTxid) : sha256d(Buffer.from(`filler ${n}`));
    headers.push(mine(prev, root, 1_790_000_000 + n * 600));
    prev = sha256d(headers.at(-1)!);
  }

  // Headers 1..102 on the feed: the chain app's (box chain, its `event` row), not the wallet's.
  for (const raw of headers) await feedHeader(raw);
  const tip = await resultWhere("the chain app at 102", (res) => res.event === "header" && res.tip === 102, 60_000, view, CHAIN);
  await resultWhere("the payee's chain app at 102", (res) => res.event === "header" && res.tip === 102, 60_000, payeeView, CHAIN);
  report.headers = [tip.result.event, tip.result.tip];
  report.walletTookNoHeader = (await updates(view)).length === 0;

  // The owner pays the instance (BRC-29): internalized, then the chain app takes it (and broadcasts it).
  const derivationPrefix = Buffer.from("skein-prefix").toString("base64");
  const derivationSuffix = Buffer.from("skein-suffix").toString("base64");
  const payTo = new KeyDeriver(ownerKey).derivePublicKey([2, "3241645161d8"], `${derivationPrefix} ${derivationSuffix}`, identity, false);
  const pay = new Transaction();
  pay.addInput({ sourceTransaction: fund, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(ownerKey), sequence: 0xffffffff });
  pay.addOutput({ lockingScript: new P2PKH().lock(payTo.toHash()), satoshis: 49_800 });
  await pay.sign();
  let r = await owned({
    op: "internalize", tx: new Uint8Array(pay.toAtomicBEEF()), description: "funding",
    outputs: [{ outputIndex: 0, protocol: "wallet payment", paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey: ownerId } }],
  });
  const payAccepted = await answered("the payment accepted", r.thread, (x) => x.outcome === "accepted");
  report.internalize = [r.result.txid === pay.id("hex"), r.result.status, r.state, payAccepted.result.outcome];

  // Spend: pay the payee 10000 (BRC-29 to its key). The step emits the ingest message to the instance itself (no broadcast of its own).
  const p2 = Buffer.from("payee-prefix").toString("base64"), s2 = Buffer.from("payee-suffix").toString("base64");
  const payeeScript = new P2PKH().lock(new KeyDeriver(h.keyOf("wallettest")).derivePublicKey([2, "3241645161d8"], `${p2} ${s2}`, payeeId, false).toHash()).toBinary();
  r = await owned({ op: "createAction", description: "pay the payee", labels: ["out"], outputs: [{ lockingScript: new Uint8Array(payeeScript), satoshis: 10_000, outputDescription: "to the payee" }] });
  const spendTxid = r.result.txid as string;
  const spendThread = r.thread;
  const msg = await view.get(r.update.emitted![0]!) as unknown as { kind: string; recipient: Uint8Array; box: string; body: CID };
  const msgBody = await view.get(msg.body) as unknown as { fn: string; args: { beef: Uint8Array } };
  const acc = await answered("Arcade's RECEIVED → accepted", spendThread, (x) => x.outcome === "accepted");
  await h.router.settled();
  const posted = arcade.posts.map((p) => FakeArcade.txOf(p)).find((t) => t.id("hex") === spendTxid);
  report.create = {
    state: r.state, awaiting: r.result.awaiting, outcome: r.result.outcome,
    ingest: [msg.kind, Buffer.from(msg.recipient).toString("hex") === identity, msg.box, msgBody.fn, r.update.emitted!.length],
    accepted: [acc.result.outcome, acc.result.txStatus, acc.state],
    postedByTheChainApp: !!posted, extendedFormat: !!posted && arcade.posts.some((p) => Buffer.from(p).equals(Buffer.from(posted.toEF()))),
    token: arcade.postHeaders.at(-1)!["x-callbacktoken"] === ARC_TOKEN,
    scriptsVerify: await Transaction.fromAtomicBEEF([...(r.result.tx as Uint8Array)]).verify("scripts only"),
    outputs: posted?.outputs.map((o) => o.satoshis),
  };

  // The payee receives the payment: the same transaction, internalized and handed to its own chain app.
  const pr = await owned({
    op: "internalize", tx: r.result.tx, description: "from wallettest",
    outputs: [{ outputIndex: 0, protocol: "wallet payment", paymentRemittance: { derivationPrefix: p2, derivationSuffix: s2, senderIdentityKey: identity } }],
  }, toPayee, payeeView);
  const pacc = await answered("the payee's chain app accepts it", pr.thread, (x) => x.outcome === "accepted", payeeView);
  report.payeeInternalize = [pr.result.txid === spendTxid, pr.result.status, pacc.result.outcome];

  // Mined at 103: the header, then MINED with the merkle path: both chain apps prove it, both threads finish.
  const h103 = mine(prev, internal(spendTxid), 1_790_000_000 + 103 * 600);
  await feedHeader(h103);
  await resultWhere("header 103", (res) => res.event === "header" && res.tip === 103, 30_000, view, CHAIN);
  await resultWhere("the payee's header 103", (res) => res.event === "header" && res.tip === 103, 30_000, payeeView, CHAIN);
  const path = new MerklePath(103, [[{ offset: 0, hash: spendTxid, txid: true }]]);
  arcade.emit(spendTxid, { txStatus: "MINED", blockHash: display(sha256d(h103)), blockHeight: 103, merklePath: path.toHex() });
  const mined = await answered("proven", spendThread, (x) => x.outcome === "proven");
  const pmined = await answered("the payee's proven", pr.thread, (x) => x.outcome === "proven", payeeView);
  report.mined = { outcome: mined.result.outcome, state: mined.state, payee: [pmined.result.outcome, pmined.state] };

  r = await owned({ op: "list", includeSpent: true });
  report.list = (r.result.outputs as Array<Record<string, unknown>>).map((o) => [o.txid === spendTxid ? "change" : o.txid === pay.id("hex") ? "payment" : "?", o.satoshis, o.spendable, o.status]);
  report.total = r.result.total;
  r = await owned({ op: "list" }, toPayee, payeeView);
  report.payeeList = (r.result.outputs as Array<Record<string, unknown>>).map((o) => [o.txid === spendTxid, o.satoshis, o.spendable, o.status]);

  // A rejected broadcast (Arcade's 400): the chain app answers rejected; the coins are back at read time.
  const someone = new P2PKH().lock(new PrivateKey("5555", 16).toPublicKey().toHash()).toBinary();
  arcade.mode = "reject";
  r = await owned({ op: "createAction", description: "rejected", outputs: [{ lockingScript: new Uint8Array(someone), satoshis: 1_000 }] });
  const rej = await answered("rejected", r.thread, (x) => x.outcome === "rejected");
  arcade.mode = "ok";
  report.rejected = { outcome: rej.result.outcome, reason: rej.result.reason, state: rej.state };
  r = await owned({ op: "list" });
  report.afterReject = r.result.total;

  // A draft, then signAction.
  r = await owned({ op: "createAction", description: "draft", outputs: [{ lockingScript: new Uint8Array(someone), satoshis: 2_000 }], options: { signAndProcess: false } });
  const draft = { reference: r.result.reference as CID, awaiting: r.result.awaiting, emitted: r.update.emitted?.length ?? 0 };
  r = await owned({ op: "signAction", reference: draft.reference });
  await answered("the signed draft accepted", r.thread, (x) => x.outcome === "accepted");
  report.draft = {
    hasReference: CID.asCID(draft.reference) !== null, draftNotIngested: draft.awaiting === undefined && draft.emitted === 0,
    awaiting: r.result.awaiting, scriptsVerify: await Transaction.fromAtomicBEEF([...(r.result.tx as Uint8Array)]).verify("scripts only"),
    posted: arcade.posts.some((p) => FakeArcade.txOf(p).id("hex") === r.result.txid),
  };

  report.settlement = await settlementScenario(new Uint8Array(someone), { h102: prev, spend: spendTxid });
  // The wallet's head is under its own name; the chain's is the chain app's.
  report.heads = [!!(await k.call("head", "wallet/state")), !!(await k.call("head", "chain/state")), !(await k.call("head", "wallet"))];
  report.ok = true;
} catch (e) {
  report.error = (e as Error).stack ?? String(e);
}
await h.router.settled().catch(() => {});
const [removeHome, ...rest] = afters;
for (const f of rest.reverse()) await f();
// #42: the TS reader derives the kernel's edges map key for key.
if (db) {
  const v2 = openStoreFile(db, { readOnly: true });
  const d = await derive(v2);
  const rels = new Map<string, number>();
  for (const [, v] of d.pairs.edges) { const rel = (v as [string])[0]; rels.set(rel, (rels.get(rel) ?? 0) + 1); }
  report.edges = { sameRoot: String(buildTree(d.pairs.edges).root) === String((v2 as unknown as { state(): { roots: { edges: CID } } }).state().roots.edges), spends: (rels.get("spends") ?? 0) > 0 };
  await v2.close();
}
for (const s of sse) s.end();
sseServer.close();
await arcade.close();

const eq = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
process.stdout.write(`== the wallet on ${abi}${abi === "component" ? ` (${component})` : ""}\n`);
check(report.ok === true, `the scenario ran${report.error ? `: ${report.error}` : ""}`);
check(eq(report.headers, ["header", 102]) && report.walletTookNoHeader === true, `headers 1..102 from the host's feed reach the chain app; the wallet takes none (#79) (${JSON.stringify(report.headers)})`);
check(eq(report.internalize, [true, "unproven", "waiting", "accepted"]), `a BRC-29 payment internalized, handed to the chain app (it broadcasts it), the thread answered accepted (${JSON.stringify(report.internalize)})`);
const c = (report.create ?? {}) as Record<string, unknown>;
check(c.state === "waiting" && c.awaiting === true && c.outcome === "pending" && eq(c.ingest, ["mail", true, "chain", "ingest", 1]), `createAction: signed; its step emits one message — {fn: ingest} to the instance itself in box chain — and no broadcast of its own; the thread awaits it (${JSON.stringify(c)})`);
check(eq(c.accepted, ["accepted", "RECEIVED", "waiting"]), `the chain app broadcast it; Arcade's RECEIVED makes it accepted: an answer to the same thread, which waits on (${JSON.stringify(c.accepted)})`);
check(c.postedByTheChainApp === true && c.extendedFormat === true && c.token === true && c.scriptsVerify === true, "Arcade received it in Extended Format under the host's token (the chain app is the broadcaster); @bsv/sdk verifies its scripts");
check(eq((c.outputs as number[] | undefined)?.slice(0, 1), [10000]) && (c.outputs as number[] | undefined)?.length === 2, `the payment and our change (${JSON.stringify(c.outputs)})`);
check(eq(report.payeeInternalize, [true, "unproven", "accepted"]), `the payee internalizes the same transaction, its own chain app accepts it (${JSON.stringify(report.payeeInternalize)})`);
check(eq(report.mined, { outcome: "proven", state: "finished", payee: ["proven", "finished"] }), `MINED with the BUMP: both chain apps prove it; both wallet threads are answered proven and finish (${JSON.stringify(report.mined)})`);
check(Array.isArray(report.list) && (report.list as unknown[][]).some((o) => o[0] === "change" && o[2] === true && o[3] === "proven") && (report.list as unknown[][]).some((o) => o[0] === "payment" && o[2] === false), `list: the change spendable and proven, the payment spent — computed from the chain state (${JSON.stringify(report.list)})`);
check(eq(report.payeeList, [[true, 10000, true, "proven"]]), `the payee's list: the payment spendable and proven (${JSON.stringify(report.payeeList)})`);
check(eq(report.rejected, { outcome: "rejected", reason: "REJECTED", state: "finished" }) && report.afterReject === report.total, `a rejected broadcast (Arcade's 400): answered rejected; the balance is back (${JSON.stringify(report.rejected)}, ${report.afterReject} vs ${report.total})`);
const d = (report.draft ?? {}) as Record<string, unknown>;
check(d.hasReference === true && d.draftNotIngested === true && d.awaiting === true && d.scriptsVerify === true && d.posted === true, `a draft (signAndProcess: false) is not ingested; signAction signs it, ingests it, the chain app broadcasts it (${JSON.stringify(d)})`);
const st = (report.settlement ?? {}) as Record<string, unknown>;
check(eq(st.awaiting, ["waiting", "waiting"]) && st.bSpendsA === true, `settlement (#37): A, then B spending A's change, both ingested and awaited (${JSON.stringify([st.awaiting, st.bSpendsA])})`);
check(eq(st.rejected, { a: ["DOUBLE_SPEND_ATTEMPTED", "finished"], b: ["input-rejected", "finished"] }), `a DOUBLE_SPEND_ATTEMPTED for A: the chain app rejects A and B (it spends A); both threads are answered rejected and finish (${JSON.stringify(st.rejected)})`);
check(st.inputsFreed === true && st.noOutputsOfAB === true, `the rejected coins vanish; A's input is spendable again — read from the chain state, nothing of the wallet's rewritten (${JSON.stringify([st.inputsFreed, st.noOutputsOfAB])})`);
check(st.mentions === true, "the results name the transactions as `mentions` edges");
check(st.spendsEdge === true, "#42: B's input is a `spends` edge into A, from B's own kept block, locator = the vout it spends");
check(eq(st.reorg, { reposted: true, change: ["unproven"] }), `a reorg drops block 103: the chain app broadcasts the spend again; the wallet lists its change unproven (${JSON.stringify(st.reorg)})`);
check(eq(report.heads, [true, true, true]), `the wallet's head is wallet/state, the chain's chain/state; no \`wallet\` head (${JSON.stringify(report.heads)})`);
check(report.sameChainProgram === true, "the same chain app program record in both instances");
check(eq(report.edges, { sameRoot: true, spends: true }), `#42: the TS reader derives the kernel's edges map (same root), with spends edges (${JSON.stringify(report.edges)})`);

if (db) {
  const r = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), db, payeeDb], { encoding: "utf8" });
  process.stdout.write(r.stdout);
  if (r.status !== 0) process.stdout.write(r.stderr);
  check(r.status === 0 && /identical .*the source store reproduced exactly/.test(r.stdout), "both stores replay to themselves exactly: the signer's answers from the recorded calls");
}

if (process.env.SKEIN_WALLET_REPORT) writeFileSync(process.env.SKEIN_WALLET_REPORT, JSON.stringify(report));

// Issue #34: the component build, against this preview1 log and then live.
if (abi === "preview1" && existsSync(component) && db) {
  process.stdout.write(`== the preview1 log replayed with the wallet's component in the module's place (equiv/abi.ts)\n`);
  const a = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "abi.ts"), db, MODULES.wallet.toString(), component], { encoding: "utf8" });
  process.stdout.write(a.stdout.split("\n").filter((l) => l).map((l) => `  ${l}\n`).join(""));
  if (a.status !== 0) process.stdout.write(a.stderr);
  check(a.status === 0, "no DIVERGED; every update identical but for fuel");
  const out = join(h.home, "component.json");
  const c2 = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "wallet.ts")], { encoding: "utf8", env: { ...process.env, SKEIN_WALLET_ABI: "component", SKEIN_WALLET_REPORT: out } });
  process.stdout.write(c2.stdout);
  if (c2.status !== 0) process.stdout.write(c2.stderr);
  check(c2.status === 0, "the scenario with the wallet as a component: all ok");
  const theirs = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : {};
  check(eq(theirs, JSON.parse(JSON.stringify(report))), "the component's run reports exactly what the module's did");
} else if (abi === "preview1") {
  process.stdout.write(`== the wallet as a component: skipped (no ${component}; \`cd programs/wallet && zig build component\`)\n`);
}

if (!process.env.KEEP) await removeHome?.();
process.stdout.write(failures ? `wallet (${abi}): ${failures} FAILED\n` : `wallet (${abi}): all ok\n`);
process.exit(failures ? 1 : 0);

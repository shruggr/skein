// Overlay services in the VM (issues #36, #79) end to end on the Zig kernel,
// served by the instance's own front door to the stock @bsv/sdk overlay
// clients: instances booted from a system tree (#4) whose bin/ holds the
// front door, the overlay engine, the tm_demo topic and the ls_demo lookup
// (the app shruggr/skein-overlay, #71: its committed bin/*.wasm, cloned at a
// pinned commit or $SKEIN_OVERLAY_DIR) and the chain app (shruggr/skein-chain,
// #78: bin/chain.wasm, or $SKEIN_CHAIN_DIR), its etc/dispatch.json the #77
// rows: the chain app's box `chain` from `event` (the host's headers and
// proofs), `$self` and `$owner`, its `chain/status` from `$status`; the overlay's
// own box `overlay` from `event` and `$self`; the overlay-express routes.
//
// Since #79 the overlay keeps only its own records (`overlay/state`:
// admitted, applied, pending; `overlay/ls_demo`; `overlay/gossip`) and the
// chain is the chain app's (`chain/state`): a submission is decoded once and
// judged in the front door's step, SPV-checked against the chain state's
// headers (read only), then its thread hands the BEEF to the chain app (an
// `ingest` message to the instance itself) and admits on the chain app's
// first answer that is `accepted` (Arcade's RECEIVED, through the host's
// status provider) or `proven`; a later `rejected` (a double spend) reaches
// the overlay's watch of it and unwinds the admission. The chain app is the
// only broadcaster.
//
// Cases: TopicBroadcaster (POST /submit) and LookupResolver (POST /lookup) —
// the BEEF verifies against the headers; the same transaction as a GossipSub
// message on a second instance persists the same records; a redelivery is
// ignored; a dupe answers from the state; every request is an entry and only
// writes move heads; listings and documentation; a spend retaining the old
// token, then a DOUBLE_SPEND_ATTEMPTED for it, unwound: the old token live
// again; three tokens in one block proven by separate BUMPs (lookup answers
// carry BUMPs rebuilt from the stored nodes); a Chronicle AMM pool spend
// (#53); a mined submission; Arcade's 400; Arcade busy (503: the client
// waits to the router's bound; a resubmission waits on the same thread);
// a fourth instance with no Arcade admits only at the proof; and the
// standard gossip (#74) across three routers. Every store replays to itself
// exactly (equiv/replays.ts).
//
// skein-overlay 0.7.3 (shruggr/skein#112): POST /submit answers its delivery
// (200 {id}), never a STEAK; on that open route no one is answered, and the
// admitting step's result record carries the STEAK. The verdict cases submit
// by message instead — {fn: "submit", args: {beef, topics}} into box `overlay/submit`
// over a wallet's /sendMessage session (the tree has the messagebox for it) —
// and read the answers (admitted / rejected, each naming the message) from the
// steps' result records: no message reaches that sender. No request waits:
// Arcade busy and no status provider leave the submitter unanswered until the
// verdict.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/overlay.ts

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HTTPSOverlayBroadcastFacilitator, LookupResolver, MerklePath, P2PKH, PrivateKey, Script, TopicBroadcaster, Transaction, UnlockingScript, type ChainTracker } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import { DatabaseSync } from "node:sqlite";
import { dirSource } from "../../src/host/boot.ts";
import { beefOf, isBeefRecord, type BeefRecord } from "../../src/runtime/beef.ts";
import { FakeArcade } from "../../src/host/fake-arcade.ts";
import { HostDb } from "../../src/host/instances.ts";
import { buildTree, derive, openStoreFile } from "../../src/runtime/index-store.ts";
import { libp2pKey, peerIdOf } from "../../src/host/p2p.ts";
import { Router } from "../../src/host/router.ts";
import { RawBox } from "../../src/client/raw.ts";
import { Signer } from "../../src/host/signer.ts";
import { ephemeralWallet } from "../../src/wallet.ts";

// The apps under test (#71, #78): SKEIN_OVERLAY_DIR / SKEIN_CHAIN_DIR name checkouts, else these commits are cloned.
const OVERLAY_REPO = "https://github.com/shruggr/skein-overlay";
const OVERLAY_REV = process.env.SKEIN_OVERLAY_REV ?? "5e948536058220d34d819382369e1c7f468bf1a5";
const CHAIN_REPO = "https://github.com/shruggr/skein-chain";
const CHAIN_REV = process.env.SKEIN_CHAIN_REV ?? "22ae34d5646f30aef35b0efcad39a7be8ae7ac34";
const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
const home = mkdtempSync(join(tmpdir(), "skein-kz-overlay-"));
const db = join(home, "instances/overlay/runtime.db");
const key = (h: string) => new PrivateKey(h, 16);
const report: Record<string, unknown> = {};
let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };
const eq = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);

function clone(repo: string, rev: string, dir: string): string {
  for (const args of [["clone", "-q", repo, dir], ["-C", dir, "checkout", "-q", rev]]) {
    const r = spawnSync("git", args, { stdio: ["ignore", "ignore", "inherit"] });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: exit ${r.status}`);
  }
  return dir;
}

// ---------------------------------------------------------------- the system tree

const sys = join(home, "system");
mkdirSync(join(sys, "bin"), { recursive: true });
mkdirSync(join(sys, "etc"), { recursive: true });
const overlayBin = join(process.env.SKEIN_OVERLAY_DIR ?? clone(OVERLAY_REPO, OVERLAY_REV, join(home, "skein-overlay")), "bin");
for (const p of ["overlay", "topic-demo", "lookup-demo"]) copyFileSync(join(overlayBin, `${p}.wasm`), join(sys, `bin/${p}.wasm`));
copyFileSync(join(process.env.SKEIN_CHAIN_DIR ?? clone(CHAIN_REPO, CHAIN_REV, join(home, "skein-chain")), "bin/chain.wasm"), join(sys, "bin/chain.wasm"));
copyFileSync(join(here, "../../wasm/frontdoor.wasm"), join(sys, "bin/frontdoor.wasm"));
writeFileSync(join(sys, "bin/frontdoor.json"), JSON.stringify({ inputs: {}, description: "The front door." }));
// skein-overlay 0.7.3 (#112): submissions by message arrive through the messagebox's /sendMessage (a BRC-104 session).
copyFileSync(join(here, "../../wasm/messagebox.wasm"), join(sys, "bin/messagebox.wasm"));
copyFileSync(join(here, "../../images/default/bin/messagebox.json"), join(sys, "bin/messagebox.json"));
writeFileSync(join(sys, "bin/overlay.json"), JSON.stringify({ inputs: { event: "cid", box: "string" }, description: "The overlay engine: BRC-22 submit, BRC-24 lookup." }));
writeFileSync(join(sys, "bin/chain.json"), JSON.stringify({ inputs: {}, description: "The chain module: the instance's one chain state." }));
writeFileSync(join(sys, "bin/topic-demo.json"), JSON.stringify({ inputs: {}, description: "Demo tokens: outputs whose script starts <\"tm_demo\"> OP_DROP.\n\nEvery such output is admitted; the tokens a transaction spends are retained when it admits one." }));
writeFileSync(join(sys, "bin/lookup-demo.json"), JSON.stringify({ inputs: {}, description: "Demo token lookup: {topic}, {scriptHash, topic?}, {txid, outputIndex, topic}." }));
// #77, #79: genesis-wired programs write what `scopes` name: the engine and its lookup service `overlay/…` (the
// engine's app is its program's name), the chain app the stock `chain/`.
const config = () => JSON.stringify({ defaults: { walletNetwork: "regtest", overlayTopics: JSON.stringify({ tm_demo: "topic-demo" }), overlayLookups: JSON.stringify({ ls_demo: { program: "lookup-demo", topics: ["tm_demo"] } }) }, scopes: { overlay: ["overlay/"], "lookup-demo": ["overlay/"] } });
writeFileSync(join(sys, "etc/config.json"), config());
const http = (address: string, fn: string) => ({ transport: "http", address, sender: "*", program: "overlay", fn });
const ROWS = [
  // The chain app (#78, #79): the host's events, the instance's own apps and the owner as callers, the status provider.
  { address: "chain", sender: "event", program: "chain" },
  { address: "chain", sender: "$self", program: "chain", filter: "beef" },
  { address: "chain", sender: "$owner", program: "chain", filter: "beef" },
  { address: "chain/status", sender: "$status", program: "chain" },
  // The overlay (#79): its own box, from events (its libp2p route's admits) and from itself (its watches).
  { address: "overlay", sender: "event", program: "overlay" },
  { address: "overlay", sender: "$self", program: "overlay" },
  // skein-overlay 0.7.6 (#112, #128): a submission is a message into the box overlay/submit, from anyone (the BEEF through the door's filter).
  { address: "overlay/submit", sender: "*", program: "overlay", filter: "beef" },
  { transport: "http", address: "/sendMessage", sender: "session", program: "messagebox", fn: "sendMessage" },
  // The overlay-express wire contract: open routes, as overlay-express is.
  // #121: the submit rows name the door's beef filter: the handler gets the BEEF's pointer record, never its bytes.
  { ...http("/submit", "submit"), filter: "beef" }, http("/lookup", "lookup"),
  http("/listTopicManagers", "listTopicManagers"), http("/listLookupServiceProviders", "listLookupServiceProviders"),
  http("/getDocumentationForTopicManager", "topicDocumentation"), http("/getDocumentationForLookupServiceProvider", "lookupDocumentation"),
  // #57: the same submit fn on a GossipSub topic.
  { transport: "libp2p", address: "tm_demo", sender: "*", program: "overlay", fn: "submit", filter: "beef" },
];
writeFileSync(join(sys, "etc/dispatch.json"), JSON.stringify(ROWS));
writeFileSync(join(sys, "README.md"), "An overlay node: tm_demo and ls_demo, and the chain app.\n");
// #57: the same node again, for the transient-failure case (Arcade busy).
const sys2 = join(home, "system-gate");
cpSync(sys, sys2, { recursive: true });

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
const txCid = (txid: string) => CID.createV1(0xb1, Digest.create(0x56, internal(txid)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, f: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

// ---------------------------------------------------------------- reading an instance's state

type K = Awaited<ReturnType<Router["hydrate"]>>["kernel"];
/** A Merkle search tree's entries (key hex, value), read through its nodes. */
async function walkMap(k: K, root: CID | null | undefined): Promise<Array<[string, unknown]>> {
  const out: Array<[string, unknown]> = [];
  const go = async (c: CID | null | undefined): Promise<void> => {
    if (!c) return;
    const [left, es] = await k.store.get(c) as unknown as [CID | null, Array<[Uint8Array, unknown, CID | null]>];
    await go(left);
    for (const [kk, v, right] of es) { out.push([Buffer.from(kk).toString("hex"), v]); await go(right); }
  };
  await go(root);
  return out;
}
/** A head's record's map, as key hex → value. */
async function headMap(k: K, head: string, name: string): Promise<Map<string, unknown>> {
  const c = await k.call("head", head) as CID | null;
  if (!c) return new Map();
  const st = await k.store.get(c) as unknown as { maps: Record<string, CID | null> };
  return new Map(await walkMap(k, st.maps[name]));
}
/** The `beef` of every chain-app ingest message an instance's steps emitted (#121: a pointer record's CID, or bytes). */
async function ingestBeefs(file: string): Promise<unknown[]> {
  const v = openStoreFile(file, { readOnly: true });
  const out: unknown[] = [];
  try {
    for await (const th of v.edges.query({ kind: "thread" })) {
      for await (const u of v.chains.history(th)) {
        if (u.equals(th)) continue;
        const up = await v.get(u) as unknown as { emitted?: CID[] };
        for (const e of up.emitted ?? []) {
          const m = await v.get(e) as unknown as { kind?: string; box?: string; body?: CID };
          if (m.kind !== "mail" || m.box !== "chain" || !m.body) continue;
          const b = await v.get(m.body) as unknown as { fn?: string; args?: { beef?: unknown } };
          if (b.fn === "ingest" && b.args) out.push(b.args.beef); // (the chain app's answers come back in box chain too: {fn, request, replyTo, result})
        }
      }
    }
  } finally { await v.close(); }
  return out;
}
/** Each transaction as the chain state and the overlay say: [proven, unproven with its broadcast registered (or pending in the overlay), rejected]. */
async function settledIn(k: K, txids: string[]) {
  const [proofs, broadcasts, rejected, pending] = await Promise.all([headMap(k, "chain/state", "proofs"), headMap(k, "chain/state", "broadcasts"), headMap(k, "chain/state", "rejected"), headMap(k, "overlay/state", "pending")]);
  return txids.map((t) => { const x = internal(t).toString("hex"); return [proofs.has(x), broadcasts.has(x) || pending.has(x), rejected.has(x)]; });
}
/** Every overlay step's result record in an instance's store (the CID its step printed), with the step's time, oldest first. */
async function overlayResults(file: string): Promise<Array<Record<string, unknown>>> {
  const v = openStoreFile(file, { readOnly: true });
  const out: Array<{ at: number; r: Record<string, unknown> }> = [];
  const seen = new Set<string>();
  try {
    for await (const th of v.edges.query({ kind: "thread" })) {
      for await (const u of v.chains.history(th)) {
        if (u.equals(th)) continue;
        const up = await v.get(u) as unknown as { at?: number; result?: { stdout?: Uint8Array } };
        const text = up.result?.stdout ? Buffer.from(up.result.stdout).toString("utf8").trim().split("\n").at(-1) ?? "" : "";
        let c: CID;
        try { c = /^[0-9a-f]+$/.test(text) ? CID.decode(Buffer.from(text, "hex")) : CID.parse(text); } catch { continue; }
        const r = await v.get(c).catch(() => undefined) as unknown as Record<string, unknown> | undefined;
        if (r?.kind === "overlay-result" && !seen.has(String(c))) { seen.add(String(c)); out.push({ at: up.at ?? 0, r }); }
      }
    }
  } finally { await v.close(); }
  return out.sort((x, y) => x.at - y.at).map((x) => x.r);
}
/**
 * skein-overlay 0.7.3 (shruggr/skein#112): a submission's answers, `{fn: "submit", request, replyTo, result | error}`,
 * oldest first — the ones whose `request` is `id` (the message's id; POST /submit's `{id}`). The submitter here is a
 * session no message reaches (not in the address book): each answer is in its step's result record (`answers[].body`).
 */
async function answersTo(file: string, id: CID | string): Promise<Array<Record<string, unknown>>> {
  const want = String(id);
  const out: Array<Record<string, unknown>> = [];
  for (const r of await overlayResults(file)) {
    for (const a of (r.answers ?? []) as Array<{ body?: Record<string, unknown> }>) {
      if (a.body && String(CID.asCID(a.body.request)) === want) out.push({ ...a.body, op: r.op });
    }
  }
  return out;
}
/** A STEAK in the field order the @bsv/sdk client writes (a record's map keys come back in dag-cbor order). */
const steakShape = (st: unknown): unknown => st && typeof st === "object"
  ? Object.fromEntries(Object.entries(st as Record<string, { outputsToAdmit: unknown; coinsToRetain: unknown; coinsRemoved: unknown }>).map(([t, x]) => [t, { outputsToAdmit: x.outputsToAdmit, coinsToRetain: x.coinsToRetain, coinsRemoved: x.coinsRemoved }]))
  : st;
/** The STEAK of the step that admitted `txid` (open-route submissions are answered to no one: their result records say). */
async function steakOf(file: string, txid: string): Promise<unknown> {
  const r = (await overlayResults(file)).filter((x) => x.txid === txid && x.admitted === true).at(-1);
  return r ? steakShape(r.steak) : undefined;
}

// ---------------------------------------------------------------- the router

const hostDb = new HostDb(join(home, "host.db"));
hostDb.add("overlay", { store: db });
// #57: the same tree again, fed the token transaction by GossipSub instead of POST /submit.
const gossipDb = join(home, "instances/gossip/runtime.db");
hostDb.add("gossip", { store: gossipDb });
// #57: the transient-failure case.
const gateDb = join(home, "instances/gate/runtime.db");
hostDb.add("gate", { store: gateDb });
const owner = key("2222").toPublicKey().toString();
// The host's Arcade (#58, #65): the chain app broadcasts (an event), the host posts it; Arcade's answer and statuses come back as status messages, proofs as events.
const arcade = await FakeArcade.start();
const posted = (txid: string) => arcade.posts.filter((b) => FakeArcade.txOf(b).id("hex") === txid);
const router = new Router({
  db: hostDb, walletFor: () => ephemeralWallet(key("1111")), home, owner, idleMs: 0, providerKeyFor: (n) => new Signer(new PrivateKey("a77e57", 16)).providerKey(n),
  // #66: a client waits on its request's thread; the gate's pending broadcast answers 503 + Retry-After at this bound.
  answerWaitMs: 6000,
  kernel: { command: kernel, env: { SKEIN_HOME: home } },
  arc: { url: arcade.url, token: "the-host-arcade-token", events: arcade.eventsUrl }, arcRetry: { min: 500, max: 2000 },
  log: (s, l) => { if (process.env.VERBOSE) process.stdout.write(`  | [${s}] ${l}\n`); },
});
/** An instance's log entries from position `from` on (with their CIDs), oldest first. */
async function entriesSince(handle: string, from: number): Promise<Array<{ cid: CID; n: number; request?: CID; transport?: string }>> {
  const k = (await router.hydrate(handle)).kernel;
  const out: Array<{ cid: CID; n: number; request?: CID; transport?: string }> = [];
  for (let c = await k.tip(); c;) {
    const e = await k.store.get(c) as unknown as { n: number; request?: CID; transport?: string; prev?: CID };
    if (e.n < from) break;
    out.unshift({ cid: c, n: e.n, ...(e.request ? { request: e.request } : {}), ...(e.transport ? { transport: e.transport } : {}) });
    c = e.prev;
  }
  return out;
}
// #73: a fourth instance, on a router with no Arcade — no status provider in its address book (its `status` row
// left out), so no status ever arrives: the chain app answers only at the proof.
const noarcDb = join(home, "instances/noarc/runtime.db");
const noarcHostDb = new HostDb(join(home, "noarc-host.db"));
noarcHostDb.add("noarc", { store: noarcDb });
const noarcRouter = new Router({
  db: noarcHostDb, walletFor: () => ephemeralWallet(key("1111")), home, owner, idleMs: 0, providerKeyFor: (n) => new Signer(new PrivateKey("a77e57", 16)).providerKey(n),
  answerWaitMs: 300,
  kernel: { command: kernel, env: { SKEIN_HOME: home } },
  log: (s, l) => { if (process.env.VERBOSE) process.stdout.write(`  | [noarc:${s}] ${l}\n`); },
});

try {
  // Listening first (the instances' origins name the port).
  await router.listen(0);
  const src = await dirSource(sys);
  await router.bootRow("overlay", { kind: "tree", root: src.root, objects: src.objects });
  await router.bootRow("gossip", { kind: "tree", root: src.root, objects: src.objects });
  const src2 = await dirSource(sys2);
  await router.bootRow("gate", { kind: "tree", root: src2.root, objects: src2.objects });
  const base = router.originOf("overlay");
  const kO = async () => (await router.hydrate("overlay")).kernel;
  // skein-overlay 0.7.3 (#112): a submission by message, {fn: "submit", args: {beef, topics}} into box `overlay/submit`, from a
  // wallet's BRC-104 session (/sendMessage); its answers name the message's id. No message reaches this sender (not in
  // the address book): the answers are in the steps' result records (answersTo).
  const submitterWallet = ephemeralWallet(key("8888"));
  const sessions = new Map<string, RawBox>();
  const submitMsg = async (r: Router, h: string, file: string, beef: Uint8Array, topics: string[]) => {
    let b = sessions.get(h);
    if (!b) { b = new RawBox(submitterWallet, r.originOf(h)); sessions.set(h, b); }
    let id: CID;
    try { ({ id } = await b.send((await r.hydrate(h)).identity, "overlay/submit", { fn: "submit", args: { beef, topics } })); } catch (e) { process.stdout.write(`  (submit by message to ${h} refused: ${(e as Error).message})\n`); return { refused: (e as Error).message, answers: async () => [] as Array<Record<string, unknown>> }; }
    await r.settled();
    return { id, refused: undefined as string | undefined, answers: () => answersTo(file, id) };
  };
  /** An answer's gist: [state, status | reason, steak?] (or ["error", code]). */
  const gist = (a: Record<string, unknown> | undefined): unknown[] => {
    if (!a) return [];
    const res = a.result as { state?: string; status?: string; reason?: string; steak?: unknown } | undefined;
    if (!res) return ["error", (a.error as { code?: string } | undefined)?.code];
    return res.state === "rejected" ? [res.state, res.reason] : res.steak !== undefined ? [res.state, res.status, steakShape(res.steak)] : [res.state, res.status];
  };
  const answered = async (s: { answers: () => Promise<Array<Record<string, unknown>>> }, r: Router, n = 1, ms = 15_000) =>
    await until(`${n} answer(s)`, async () => { await r.settled(); const a = await s.answers(); return a.length >= n ? a : undefined; }, ms).catch(async () => await s.answers());

  // The chain: the funding transaction mined at 1, then 2 and 3, as `header` events in box chain (the chain app's).
  const alice = key("3333");
  const fund = new Transaction();
  fund.addInput({ sourceTXID: "11".repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex("51"), sequence: 0xffffffff });
  fund.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 50_000 });
  fund.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 10_000 }); // #57: the gate instance's token
  const fundTxid = fund.id("hex");
  // Second in its block (a transaction at offset 0 is a coinbase, which the SDK holds to 100 blocks' maturity).
  const cb = "cb".repeat(32);
  fund.merklePath = new MerklePath(1, [[{ offset: 0, hash: cb }, { offset: 1, hash: fundTxid, txid: true }]]);
  const root1 = sha256d(Buffer.concat([internal(cb), internal(fundTxid)]));
  const headers: Uint8Array[] = [];
  let prev: Uint8Array = sha256d(REGTEST_GENESIS);
  for (let h = 1; h <= 3; h++) {
    headers.push(mine(prev, h === 1 ? root1 : sha256d(Buffer.from(`filler ${h}`)), 1_790_000_000 + h * 600));
    prev = sha256d(headers.at(-1)!);
  }
  for (const raw of headers) for (const h of ["overlay", "gossip", "gate"]) await router.admitEvent(h, "chain", { kind: "header", raw });
  await router.settled();
  const roots = new Map<number, string>(headers.map((h, i) => [i + 1, Buffer.from(h.subarray(36, 68)).reverse().toString("hex")]));
  const tracker: ChainTracker = { isValidRootForHeight: async (root, height) => roots.get(height) === root, currentHeight: async () => headers.length };
  report.chainState = ((await (await kO()).store.get(await (await kO()).call("head", "chain/state") as CID)) as { kind?: string }).kind;

  // A token: <"tm_demo"> OP_DROP + P2PKH to alice.
  const tokenScript = (k: PrivateKey) => Script.fromBinary([0x07, ...Buffer.from("tm_demo"), 0x75, ...new P2PKH().lock(k.toPublicKey().toHash()).toBinary()]);
  const t1 = new Transaction();
  t1.addInput({ sourceTransaction: fund, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(alice), sequence: 0xffffffff });
  t1.addOutput({ lockingScript: tokenScript(alice), satoshis: 1 });
  t1.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 49_000 });
  await t1.sign();

  // The stock broadcaster, its facilitator pointed at the router.
  const steaks: unknown[] = [];
  const sentBeefs: Uint8Array[] = [];
  const facilitator = { send: async (_url: string, tagged: Parameters<HTTPSOverlayBroadcastFacilitator["send"]>[1]) => { sentBeefs.push(Uint8Array.from(tagged.beef)); const s = await new HTTPSOverlayBroadcastFacilitator(fetch, true).send(base, tagged); steaks.push(s); return s; } };
  const broadcaster = new TopicBroadcaster(["tm_demo"], { networkPreset: "local", facilitator });
  const b1 = await broadcaster.broadcast(t1);
  // skein-overlay 0.7.3 (#112): POST /submit answers its delivery, {id}, not a STEAK (the stock broadcaster reads that
  // as an error); on the open route no one is answered: the admitting step's result record carries the STEAK.
  await until("T1 admitted", async () => { await router.settled(); return (await steakOf(db, t1.id("hex"))) ? true : undefined; });
  report.submit1 = { status: b1.status, delivered: /^[0-9a-f]{60,}$/.test(String((steaks.at(-1) as { id?: unknown } | undefined)?.id)), steak: await steakOf(db, t1.id("hex")) };
  // #79: the chain app broadcast it (the overlay handed it over); the host posted it once, in Extended Format.
  report.posted1 = posted(t1.id("hex")).map((b) => Buffer.from(b).equals(Buffer.from(t1.toEF())));

  await router.settled();
  // #121: the door. The submit row names `filter: "beef"`: before the request's entry was written the kernel
  // decoded the BEEF, checked its BUMP against chain/state, stored its transactions as bitcoin-tx blocks, and put
  // the pointer record where the bytes were. Its entry carries `door`; no block in the store holds the BEEF's
  // bytes (a grep of every block); the chain app ingested it from the record's CID; the bytes come back exactly.
  {
    const k = await kO();
    const wire = sentBeefs[0]!;
    let submitEntry: { door?: { filter?: string; beefs?: CID[]; verified?: unknown }; request: CID } | undefined;
    for (const e of await entriesSince("overlay", 0)) {
      if (e.transport !== "http") continue;
      const rec = await k.store.get(e.request!) as unknown as { route: string; body: unknown };
      if (rec.route === "/submit") { submitEntry = await k.store.get(e.cid) as unknown as typeof submitEntry; break; }
    }
    const rec = submitEntry ? await k.store.get(submitEntry.request) as unknown as { body: unknown } : undefined;
    const pointer = CID.asCID(rec?.body);
    const v = openStoreFile(db, { readOnly: true });
    try {
      const d = new DatabaseSync(db, { readOnly: true });
      let holding = 0, total = 0;
      try { for (const row of d.prepare("SELECT bytes FROM blocks").iterate() as Iterable<{ bytes: Uint8Array }>) { total++; if (Buffer.from(row.bytes).indexOf(Buffer.from(wire)) >= 0) holding++; } } finally { d.close(); }
      const pr = pointer ? await k.store.get(pointer) as unknown as BeefRecord : undefined;
      const back = pr && isBeefRecord(pr) ? await beefOf(pr, async (c) => await v.bytes(c)) : undefined;
      const txs = await headMap(k, "chain/state", "txs");
      report.door121 = {
        filter: submitEntry?.door?.filter, linked: !!pointer && (submitEntry?.door?.beefs ?? []).some((c) => c.equals(pointer)), kind: pr?.kind,
        grep: [holding, total > 0], identical: !!back && Buffer.from(back).equals(Buffer.from(wire)),
        txBlocks: pr ? await Promise.all(pr.txs.map(async (c) => Buffer.from(await v.bytes(c)).toString("hex").length > 0)) : [],
        pointer: String(pointer),
        ingested: txs.has(internal(t1.id("hex")).toString("hex")),
        ingests: (await ingestBeefs(db)).map((b) => b instanceof Uint8Array ? "bytes" : pointer && CID.asCID(b)?.equals(pointer) ? "the pointer" : String(b)),
      };
    } finally { await v.close(); }
  }
  const plainOf = (v: unknown): unknown => v instanceof Uint8Array ? Buffer.from(v).toString("hex")
    : v instanceof CID || (v && typeof v === "object" && (v as { asCID?: unknown }).asCID === v) ? String(v)
    : Array.isArray(v) ? v.map(plainOf)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([x, y]) => [x, plainOf(y)])) : v;
  // What an instance persisted for the token: every record in its overlay's `applied` and `admitted` maps, the
  // lookup service's head. The records carry their step's time (`at`, `admittedAt`): set aside, and shown.
  const persisted = async (h: string) => {
    const k = (await router.hydrate(h)).kernel;
    const times: unknown[] = [];
    const records = async (name: string) => {
      const out: unknown[] = [];
      for (const [kk, rec] of await headMap(k, "overlay/state", name)) {
        const { at, admittedAt, ...r } = await k.store.get(rec as CID) as unknown as Record<string, unknown>;
        times.push(at ?? admittedAt);
        out.push([kk, plainOf(r)]);
      }
      return out;
    };
    return { applied: await records("applied"), admitted: await records("admitted"), lookup: String(await k.call("head", "overlay/ls_demo")), times };
  };

  // #57: the same transaction as a GossipSub message on the second instance's `libp2p:tm_demo` route.
  const publisher = key("4444");
  const body = new Uint8Array(t1.toBEEF());
  const seqno = new Uint8Array(8);
  new DataView(seqno.buffer).setBigUint64(0, 1n, false);
  const peer = peerIdOf(publisher).toMultihash().bytes;
  const pb: number[] = [];
  const field = (tag: number, b: Uint8Array) => {
    pb.push(tag);
    let n = b.length;
    while (n >= 0x80) { pb.push((n & 0x7f) | 0x80); n >>>= 7; }
    pb.push(n, ...b);
  };
  field(0x0a, peer);
  field(0x12, body);
  field(0x1a, seqno);
  field(0x22, new TextEncoder().encode("tm_demo"));
  const signature = await libp2pKey(publisher).sign(Uint8Array.from([...new TextEncoder().encode("libp2p-pubsub:"), ...pb]));
  const message = { transport: "libp2p" as const, topic: "tm_demo", from: peer, seqno, signature, body };
  const gossipLen = async () => { const k = (await router.hydrate("gossip")).kernel; return (await k.store.get((await k.tip())!) as unknown as { n: number }).n + 1; };
  const lenBefore = await gossipLen();
  const g1 = await router.p2pInbound("gossip", message);
  await router.settled();
  const lenAfter = await gossipLen();
  // Nobody waits on this thread (GossipSub got its verdict): wait for the admission here.
  await until("the gossip instance's admission", async () => ((await persisted("gossip")).applied.length > 0 ? true : undefined));
  await router.settled();
  const byHttp = await persisted("overlay");
  const byGossip = await persisted("gossip");
  // #68: the message is one entry, as received; what the front door's step admitted — the `p2p` event, then
  // the submit event (box `overlay`, the app's own, #79) — is on its answer, the request thread's last update.
  const gk = (await router.hydrate("gossip")).kernel;
  const boxes: string[] = [];
  let appended = 0;
  for (const e of (await entriesSince("gossip", lenBefore)).filter((x) => x.request && x.transport === "libp2p" && x.n < lenAfter)) {
    appended++;
    const a = await gk.answer(e.cid, 0);
    if (a.state === "finished") for (const x of (dagCbor.decode(a.answer) as { admit?: Array<{ box: string; event: { kind: string } }> }).admit ?? []) boxes.push(`${x.box}:${x.event.kind}`);
  }
  const { times: httpTimes, ...httpState } = byHttp;
  const { times: gossipTimes, ...gossipState } = byGossip;
  // Each instance's lookup head moves with its own hook calls' records (CIDs differ only through times): compare the records.
  const { lookup: _hl, ...httpRecs } = httpState;
  const { lookup: _gl, ...gossipRecs } = gossipState;
  void _hl; void _gl;
  report.gossip = {
    verdict: g1.verdict, appended, boxes, posts: posted(t1.id("hex")).length, applied: httpState.applied.length, admitted: httpState.admitted.length,
    same: eq(httpRecs, gossipRecs), times: [httpTimes, gossipTimes], ...(eq(httpRecs, gossipRecs) ? {} : { httpState, gossipState }),
  };
  // #121: one instance took T1 over HTTP, the other over GossipSub, each through its door (a pointer record): the
  // stock resolver gets the same bytes from both.
  const lookupRaw = async (h: string) => JSON.stringify(await new LookupResolver({ networkPreset: "local", hostOverrides: { ls_demo: [router.originOf(h)] } }).query({ service: "ls_demo", query: { topic: "tm_demo" } }));
  report.lookupSame = [await lookupRaw("overlay") === await lookupRaw("gossip"), (await lookupRaw("overlay")).length > 2];
  // Redelivered: recorded as received, ignored (the front door's `unique` map), nothing else changed.
  const g2len = await gossipLen();
  const g2 = await router.p2pInbound("gossip", message);
  await router.settled();
  report.gossipAgain = [g2.verdict, g2.reason, (await gossipLen()) - g2len, eq(await persisted("gossip"), byGossip)];

  // The stock resolver: aggregated octet-stream answers, BEEF per output.
  const resolver = new LookupResolver({ networkPreset: "local", hostOverrides: { ls_demo: [base] } });
  const look = async (query: unknown, r = resolver) => {
    const a = await r.query({ service: "ls_demo", query }) as { type: string; outputs: Array<{ beef: number[]; outputIndex: number }> };
    const out = [];
    for (const o of a.outputs) {
      const tx = Transaction.fromBEEF(o.beef);
      let verifies: unknown;
      try { verifies = await tx.verify(tracker); } catch (e) { verifies = (e as Error).message; }
      out.push({ txid: tx.id("hex"), outputIndex: o.outputIndex, verifies });
    }
    return out;
  };
  const t2 = new Transaction();
  t2.addInput({ sourceTransaction: t1, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(alice), sequence: 0xffffffff });
  t2.addOutput({ lockingScript: tokenScript(alice), satoshis: 1 });
  await t2.sign();
  const name = (txid: string) => txid === t1.id("hex") ? "t1" : txid === t2.id("hex") ? "t2" : "?";

  report.lookup1 = (await look({ topic: "tm_demo" })).map((o) => [name(o.txid), o.outputIndex, o.verifies]);
  const sh = createHash("sha256").update(Buffer.from(tokenScript(alice).toBinary())).digest("hex");
  report.byScript = (await look({ scriptHash: sh, topic: "tm_demo" })).map((o) => [name(o.txid), o.outputIndex]);
  const json = await (await fetch(`${base}/lookup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service: "ls_demo", query: { topic: "tm_demo" } }) })).json() as { type: string; outputs: Array<{ beef: number[]; outputIndex: number }> };
  report.lookupJson = { type: json.type, outputs: json.outputs.map((o) => [name(Transaction.fromBEEF(o.beef).id("hex")), o.outputIndex]) };

  // A resubmission is a dupe: nothing new. #121: a held transaction submitted again writes no block — its
  // transactions, its BUMP's bytes and its pointer record are the ones the store holds (content-addressed, once).
  const heldBlocks = () => {
    const d = new DatabaseSync(db, { readOnly: true });
    try {
      let n = 0;
      for (const row of d.prepare("SELECT cid FROM blocks").iterate() as Iterable<{ cid: Uint8Array }>) { const c = CID.decode(row.cid); if (c.code === 0xb1 || c.code === 0xb0 || c.code === 0x55) n++; }
      return n;
    } finally { d.close(); }
  };
  await router.settled();
  const held0 = heldBlocks();
  const dupeHttp = await new HTTPSOverlayBroadcastFacilitator(fetch, true).send(base, { beef: t1.toBEEF(), topics: ["tm_demo", "tm_other"] }) as { id?: unknown };
  await router.settled();
  {
    const k = await kO();
    const last = (await entriesSince("overlay", 0)).filter((e) => e.transport === "http").at(-1)!;
    const body = (await k.store.get(last.request!) as unknown as { body: unknown }).body;
    report.dupeBlocks = { bitcoinAndRaw: [held0, heldBlocks()], samePointer: !!CID.asCID(body) && (report.door121 as { pointer?: string }).pointer === String(body), delivered: typeof dupeHttp.id === "string" };
  }
  // The same dupe by message (0.7.3): answered `admitted` from the state at once, the STEAK of the topics it serves.
  {
    const d = await submitMsg(router, "overlay", db, new Uint8Array(t1.toBEEF()), ["tm_demo", "tm_other"]);
    const a = await answered(d, router);
    report.dupe = { answers: a.length, gist: gist(a[0]) };
  }
  // #68: every request is an entry; only a write moves the state.
  const logLen = async () => { const k = await kO(); return (await k.store.get((await k.tip())!) as unknown as { n: number }).n + 1; };
  const fwd = router as unknown as { forward(handle: string, ...rest: unknown[]): Promise<unknown> };
  const forward0 = fwd.forward.bind(router);
  let requests = 0;
  fwd.forward = async (handle, ...rest) => { if (handle === "overlay") requests++; return await forward0(handle, ...rest); };
  const stateOf = async () => { const k = await kO(); return [String(await k.call("head", "overlay/state")), String(await k.call("head", "overlay/ls_demo")), String(await k.call("head", "chain/state"))]; };
  const before = await logLen();
  const state0 = await stateOf();

  // #50: a submission no topic takes: 200 with the empty STEAK from the front door's step; nothing else changed.
  const plain = new Transaction();
  plain.addInput({ sourceTransaction: t1, sourceOutputIndex: 1, unlockingScriptTemplate: new P2PKH().unlock(alice), sequence: 0xffffffff });
  plain.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 48_000 });
  await plain.sign();
  await router.settled();
  const lenBeforeRefused = await logLen();
  const refused = await submitMsg(router, "overlay", db, new Uint8Array(plain.toBEEF()), ["tm_demo"]);
  const refusedA = await answered(refused, router);
  await router.settled();
  report.refusedSubmit = [refusedA.length, ...gist(refusedA[0]).map((x) => typeof x === "string" ? x.split(":")[0] : x), (await logLen()) - lenBeforeRefused, eq(await stateOf(), state0)];

  // #121: a bad BUMP — T1's BEEF with its funding's BUMP sibling changed (the root is not block 1's): refused at the
  // door. The entry is written (a refusal entry, stage filter, its BEEF still a pointer: stored, reconstructible) and
  // nothing runs: no thread for it, no head moved; the client gets the refusal (400).
  {
    const good = new Uint8Array(t1.toBEEF());
    const at = Buffer.from(good).indexOf(Buffer.from("cb".repeat(32), "hex"));
    const bad = Uint8Array.from(good);
    bad.set(Buffer.from("cc".repeat(32), "hex"), at);
    const len0 = await logLen();
    const st0 = await stateOf();
    const res = await fetch(`${base}/submit`, { method: "POST", headers: { "x-topics": "tm_demo" }, body: bad });
    const answer = await res.json() as { code?: string; description?: string };
    await router.settled();
    const k = await kO();
    const last = (await entriesSince("overlay", len0)).at(-1)!;
    const e = await k.store.get(last.cid) as unknown as { refused?: { stage: string; reason: string }; door?: unknown };
    const a = await k.answer(last.cid, 0);
    const rec = await k.store.get(last.request!) as unknown as { body: unknown };
    report.badBump = {
      status: res.status, code: answer.code, entries: (await logLen()) - len0, refused: e.refused?.stage, reason: /merkle root/.test(e.refused?.reason ?? ""),
      noThread: a.state === "refused", same: eq(await stateOf(), st0), pointer: !!CID.asCID(rec.body),
    };
  }
  report.lsHead = (await (await kO()).call("head", "overlay/ls_demo")) != null;

  // T2 spends the token into a new one (X-Topics as a JSON array, Atomic BEEF): the old one is retained.
  const r2 = await fetch(`${base}/submit`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-topics": JSON.stringify(["tm_demo"]) }, body: new Uint8Array(t2.toAtomicBEEF()) });
  report.submit2Delivered = [r2.status, typeof ((await r2.json()) as { id?: unknown }).id];
  report.submit2 = await until("T2 admitted", async () => { await router.settled(); return await steakOf(db, t2.id("hex")); });
  report.lookup2 = (await look({ topic: "tm_demo" })).map((o) => [name(o.txid), o.outputIndex, o.verifies]);
  report.withSpent = (await look({ topic: "tm_demo", includeSpent: true })).map((o) => [name(o.txid), o.outputIndex]).sort();

  // Arcade says T2 was double spent (the status provider's message, to the chain app): the chain app rejects it and
  // answers the overlay's watch of it; the admittance vanishes, T1's token is live again.
  await router.settled();
  arcade.emit(t2.id("hex"), { txStatus: "DOUBLE_SPEND_ATTEMPTED" });
  await until("T2 rejected and unwound", async () => {
    await router.settled();
    return (await settledIn(await kO(), [t2.id("hex")]))[0]![2] && !(await headMap(await kO(), "overlay/state", "applied")).has(`07746d5f64656d6f${internal(t2.id("hex")).toString("hex")}`) ? true : undefined;
  });
  await router.settled();
  report.afterReject = (await look({ topic: "tm_demo" })).map((o) => [name(o.txid), o.outputIndex, o.verifies]);
  report.t2Settled = await settledIn(await kO(), [t2.id("hex")]);
  // From here on only reads (a rejected resubmission, refusals, listings, a lookup, a dupe): the state stays.
  const state1 = await stateOf();
  const again = await submitMsg(router, "overlay", db, new Uint8Array(t2.toAtomicBEEF()), ["tm_demo"]);
  report.resubmitRejected = gist((await answered(again, router))[0]);

  // Refusals, listings, documentation.
  const bad = await submitMsg(router, "overlay", db, new Uint8Array([1, 2, 3]), ["tm_demo"]);
  report.badBeef = gist((await answered(bad, router))[0]);
  const unknown = await fetch(`${base}/lookup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service: "ls_nope", query: {} }) });
  report.unknownService = unknown.status;
  report.topics = await (await fetch(`${base}/listTopicManagers`)).json();
  report.lookups = await (await fetch(`${base}/listLookupServiceProviders`)).json();
  const doc = await fetch(`${base}/getDocumentationForTopicManager?manager=tm_demo`);
  report.doc = [doc.headers.get("content-type"), (await doc.text()).split("\n")[0]];
  await look({ topic: "tm_demo" });
  await fetch(`${base}/submit`, { method: "POST", headers: { "x-topics": "tm_demo" }, body: new Uint8Array(t1.toBEEF()) });
  await router.settled();
  // #65, #79: `local` requests are entries too, not forwarded: the status provider's messages and the loopback (the
  // overlay's ingest and watch messages, the chain app's answers).
  const local = (await entriesSince("overlay", before)).filter((e) => e.transport === "local").length;
  report.readsWrite = [before, (await logLen()) - local, requests, eq(await stateOf(), state1), local];
  fwd.forward = forward0;

  // Merkle proofs as IPLD nodes (#29): three tokens mined in one block (4: a coinbase, u1, u2, u3), each proven by
  // its own BUMP (out of order), at the chain app. A lookup's BEEF carries each token's BUMP rebuilt from the nodes.
  const us: Transaction[] = [];
  let from = t1, vout = 1, sats = 49_000;
  for (let i = 0; i < 3; i++) {
    const u = new Transaction();
    u.addInput({ sourceTransaction: from, sourceOutputIndex: vout, unlockingScriptTemplate: new P2PKH().unlock(alice), sequence: 0xffffffff });
    u.addOutput({ lockingScript: tokenScript(alice), satoshis: 1 });
    sats -= 100;
    u.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: sats });
    await u.sign();
    const s = await fetch(`${base}/submit`, { method: "POST", headers: { "x-topics": "tm_demo" }, body: new Uint8Array(u.toAtomicBEEF()) });
    if (s.status !== 200) throw new Error(`submit u${i + 1}: ${s.status} ${await s.text()}`);
    us.push(u);
    from = u; vout = 1;
  }
  await router.settled();
  // Each admitted (the chain app's accepted: Arcade's RECEIVED) and unproven at the chain app (its broadcast registered); posted once each.
  report.awaitingU = { state: await settledIn(await kO(), us.map((u) => u.id("hex"))), posts: us.map((u) => posted(u.id("hex")).length) };
  const leaves = ["cc".repeat(32), ...us.map((u) => u.id("hex"))];
  report.leaves = leaves;
  const n01 = sha256d(Buffer.concat([internal(leaves[0]!), internal(leaves[1]!)]));
  const n23 = sha256d(Buffer.concat([internal(leaves[2]!), internal(leaves[3]!)]));
  report.nodes = [n01, n23].map((n) => Buffer.from(n).reverse().toString("hex"));
  report.root = Buffer.from(sha256d(Buffer.concat([n01, n23]))).reverse().toString("hex");
  const h4 = mine(prev, sha256d(Buffer.concat([n01, n23])), 1_790_000_000 + 4 * 600);
  headers.push(h4);
  roots.set(4, Buffer.from(h4.subarray(36, 68)).reverse().toString("hex"));
  await router.admitEvent("overlay", "chain", { kind: "header", raw: h4 });
  const disp = (b: Uint8Array) => Buffer.from(b).reverse().toString("hex");
  const bumpOf = (i: number) => new MerklePath(4, [
    [i ^ 1, i].sort().map((o) => o === i ? { offset: o, hash: leaves[o]!, txid: true } : { offset: o, hash: leaves[o]! }),
    [{ offset: (i >> 1) ^ 1, hash: disp((i >> 1) ^ 1 ? n23 : n01) }],
  ]);
  const sent = new Map<string, string>();
  await until("the broadcaster's stream", async () => arcade.streams > 0 || undefined);
  await router.settled();
  const routed0 = router.arc!.stats.routed;
  for (const i of [1, 2, 3]) arcade.emit(leaves[i]!, { txStatus: "SEEN_ON_NETWORK" });
  const block4 = Buffer.from(sha256d(h4)).reverse().toString("hex");
  for (const i of [3, 1, 2]) {
    const bump = bumpOf(i);
    sent.set(leaves[i]!, bump.toHex());
    arcade.emit(leaves[i]!, { txStatus: "MINED", blockHash: block4, blockHeight: 4, merklePath: bump.toHex() });
  }
  await until("six statuses routed", async () => router.arc!.stats.routed >= routed0 + 6 || undefined);
  await router.settled();
  report.settledBySse = await settledIn(await kO(), leaves.slice(1));
  const answers = await resolver.query({ service: "ls_demo", query: { topic: "tm_demo" } }) as { outputs: Array<{ beef: number[]; outputIndex: number }> };
  const proofs: Array<[number, boolean, boolean]> = [];
  for (const o of answers.outputs) {
    const tx = Transaction.fromBEEF(o.beef);
    const i = leaves.indexOf(tx.id("hex"));
    if (i < 1) continue;
    let ok = false;
    try { ok = await tx.verify(tracker); } catch { ok = false; }
    const mp = tx.merklePath;
    const leaf = mp?.path[0].some((l) => l.hash === leaves[i] && l.txid === true) ?? false;
    proofs.push([i, leaf && mp!.blockHeight === 4 && mp!.computeRoot(leaves[i]) === roots.get(4), ok]);
  }
  report.merkle = proofs.sort((x, y) => x[0] - y[0]);
  const alone: Array<[number, boolean, boolean]> = [];
  for (const i of [1, 2, 3]) {
    const a = await resolver.query({ service: "ls_demo", query: { txid: leaves[i], outputIndex: 0, topic: "tm_demo" } }) as { outputs: Array<{ beef: number[] }> };
    const tx = a.outputs.length === 1 ? Transaction.fromBEEF(a.outputs[0]!.beef) : undefined;
    let ok = false;
    try { ok = !!tx && await tx.verify(tracker); } catch { ok = false; }
    alone.push([i, tx?.merklePath?.toHex() === sent.get(leaves[i]!), ok]);
  }
  report.merkleAlone = alone;

  // Chronicle script rules (#53): a Rúnar AMM pool spend (test/vectors/chronicle.json), whose pool input executes
  // OP_2MUL, verified in the front door's call against the chain state's headers; no topic here takes it: 200 with
  // the empty STEAK. The same swap with its funding signature broken: 400 ScriptFailed.
  const chron = JSON.parse(readFileSync(join(here, "../test/vectors/chronicle.json"), "utf8")) as { txs: Record<string, string> };
  const cFund = Transaction.fromHex(chron.txs.fund!);
  const cToken = Transaction.fromHex(chron.txs.token_deploy!);
  const cPool = Transaction.fromHex(chron.txs.pool_deploy!);
  const leaves5 = ["dd".repeat(32), cFund.id("hex"), cToken.id("hex"), "ee".repeat(32)];
  const m01 = sha256d(Buffer.concat([internal(leaves5[0]!), internal(leaves5[1]!)]));
  const m23 = sha256d(Buffer.concat([internal(leaves5[2]!), internal(leaves5[3]!)]));
  const h5 = mine(sha256d(h4), sha256d(Buffer.concat([m01, m23])), 1_790_000_000 + 5 * 600);
  headers.push(h5);
  roots.set(5, Buffer.from(h5.subarray(36, 68)).reverse().toString("hex"));
  await router.admitEvent("overlay", "chain", { kind: "header", raw: h5 });
  await router.settled();
  const bump5 = (i: number) => new MerklePath(5, [
    [i ^ 1, i].sort().map((o) => o === i ? { offset: o, hash: leaves5[o]!, txid: true } : { offset: o, hash: leaves5[o]! }),
    [{ offset: (i >> 1) ^ 1, hash: disp((i >> 1) ^ 1 ? m23 : m01) }],
  ]);
  cFund.merklePath = bump5(1);
  cToken.merklePath = bump5(2);
  const link = (t: Transaction) => { for (const inp of t.inputs) inp.sourceTransaction = [cFund, cToken, cPool].find((s) => s.id("hex") === inp.sourceTXID); };
  link(cPool);
  const swapOf = (hex: string) => { const t = Transaction.fromHex(hex); link(t); return t; };
  const swap = swapOf(chron.txs.swap_bsv_in!);
  const poolSpent = swap.inputs[0]!.sourceTXID === cPool.id("hex");
  const cs = await submitMsg(router, "overlay", db, new Uint8Array(swap.toBEEF()), ["tm_demo"]);
  report.chronicle = [poolSpent, ...gist((await answered(cs, router))[0])];
  const broken = swapOf(chron.txs.swap_bsv_in!);
  const sig = broken.inputs[1]!.unlockingScript!.toBinary();
  sig[10] ^= 1;
  broken.inputs[1]!.unlockingScript = UnlockingScript.fromBinary(sig);
  const cb2 = await submitMsg(router, "overlay", db, new Uint8Array(broken.toBEEF()), ["tm_demo"]);
  report.chronicleBroken = gist((await answered(cb2, router))[0]);

  // #57 (d): a mined submission — its BEEF carries its BUMP — is admitted at the chain app's at-once `proven`, with no post.
  const m = new Transaction();
  m.addInput({ sourceTransaction: us[2]!, sourceOutputIndex: 1, unlockingScriptTemplate: new P2PKH().unlock(alice), sequence: 0xffffffff });
  m.addOutput({ lockingScript: tokenScript(alice), satoshis: 1 });
  m.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 48_000 });
  await m.sign();
  const filler6 = "f6".repeat(32);
  const h6 = mine(sha256d(h5), sha256d(Buffer.concat([internal(filler6), internal(m.id("hex"))])), 1_790_000_000 + 6 * 600);
  roots.set(6, Buffer.from(h6.subarray(36, 68)).reverse().toString("hex"));
  await router.admitEvent("overlay", "chain", { kind: "header", raw: h6 });
  await router.settled();
  m.merklePath = new MerklePath(6, [[{ offset: 0, hash: filler6 }, { offset: 1, hash: m.id("hex"), txid: true }]]);
  const postsBefore = arcade.posts.length;
  const mr = await submitMsg(router, "overlay", db, new Uint8Array(m.toBEEF()), ["tm_demo"]);
  const mrA = await answered(mr, router);
  report.mined = { answer: gist(mrA[0]), posted: arcade.posts.length - postsBefore, state: (await settledIn(await kO(), [m.id("hex")]))[0] };

  // #57 (b): Arcade refuses one (400: a REJECTED status): the chain app answers rejected, nothing admitted; the client gets 400.
  const x = new Transaction();
  x.addInput({ sourceTransaction: m, sourceOutputIndex: 1, unlockingScriptTemplate: new P2PKH().unlock(alice), sequence: 0xffffffff });
  x.addOutput({ lockingScript: tokenScript(alice), satoshis: 1 });
  x.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 47_000 });
  await x.sign();
  arcade.mode = "reject";
  const xr = await submitMsg(router, "overlay", db, new Uint8Array(x.toAtomicBEEF()), ["tm_demo"]);
  const xrA = await answered(xr, router);
  arcade.mode = "ok";
  report.arcRejected = {
    answer: gist(xrA[0]), posted: posted(x.id("hex")).length, state: (await settledIn(await kO(), [x.id("hex")]))[0],
    live: (await look({ topic: "tm_demo", txid: x.id("hex"), outputIndex: 0 })).length,
  };

  // #57 (c), #66: Arcade busy (503) on the gate instance: the host keeps it queued; the client waits on the submission's
  // thread until the router's bound — 503 + Retry-After, nothing admitted; a resubmission waits on the same thread. Then
  // Arcade takes it: two clients resubmit at once, both get the STEAK — the same thread, the same answer.
  const gateBase = router.originOf("gate");
  const g = new Transaction();
  g.addInput({ sourceTransaction: fund, sourceOutputIndex: 1, unlockingScriptTemplate: new P2PKH().unlock(alice), sequence: 0xffffffff });
  g.addOutput({ lockingScript: tokenScript(alice), satoshis: 1 });
  g.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 9_000 });
  await g.sign();
  const gid = g.id("hex");
  void gateBase;
  const submitG = () => submitMsg(router, "gate", gateDb, new Uint8Array(g.toBEEF()), ["tm_demo"]);
  // The gate's submission threads: the overlay engine launched by POST /submit on a submit record.
  const submissions = async () => {
    const v = openStoreFile(gateDb, { readOnly: true });
    try {
      let n = 0;
      for await (const th of v.edges.query({ kind: "thread" })) if (((await v.get(th)) as unknown as { args?: { box?: string } }).args?.box === "submit") n++;
      return n;
    } finally { await v.close(); }
  };
  const kG = async () => (await router.hydrate("gate")).kernel;
  // 0.7.3 (#112): no request waits; the submitter's answers come when there is a verdict.
  arcade.mode = "busy";
  const g1r = await submitG();
  await sleep(1500);
  await router.settled();
  const g2r = await submitG();
  await sleep(500);
  await router.settled();
  const busy = {
    first: (await g1r.answers()).map(gist), again: (await g2r.answers()).map(gist), submissions: await submissions(),
    state: (await settledIn(await kG(), [gid]))[0], posts: posted(gid).length,
  };
  arcade.mode = "ok";
  // The host's queue retries the post: Arcade takes it, the chain app answers accepted, the submission is admitted.
  const firstA = await answered(g1r, router, 1, 20_000);
  await router.settled();
  const ok = [firstA.slice(0, 1).map(gist), (await g2r.answers()).map(gist)];
  // 0.7.4: a by-message submission whose thread it launched is answered once (0.7.3 answered it twice — at
  // admission, op "answer", and again when the received step woke on that thread's end, op "received").
  const firstOps = (await g1r.answers()).map((a) => a.op);
  report.firstAnswers = firstOps;
  const gateResolver = new LookupResolver({ networkPreset: "local", hostOverrides: { ls_demo: [gateBase] } });
  const gLive = await gateResolver.query({ service: "ls_demo", query: { topic: "tm_demo" } }) as { outputs: Array<{ beef: number[]; outputIndex: number }> };
  report.transient = {
    busy, steak: ok, submissions: await submissions(), queued: router.arc!.queued().some((q) => q.txid === gid), posts: posted(gid).length,
    state: (await settledIn(await kG(), [gid]))[0], live: gLive.outputs.map((o) => [Transaction.fromBEEF(o.beef).id("hex") === gid, o.outputIndex]),
  };

  // #73: the fourth instance (no Arcade, no status provider): the chain app's broadcast is dropped (this host has
  // none) and the submission's thread waits for the chain app's answer; the client gets 503 at the bound, nothing
  // admitted. The proof, fed directly: the chain app proves it and answers `proven`: admitted at the proof.
  await noarcRouter.listen(0);
  await noarcRouter.bootRow("noarc", { kind: "tree", root: src.root, objects: src.objects });
  const noarcBase = noarcRouter.originOf("noarc");
  const kN = async () => (await noarcRouter.hydrate("noarc")).kernel;
  const bob = key("5555");
  const nFund = new Transaction();
  nFund.addInput({ sourceTXID: "33".repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex("51"), sequence: 0xffffffff });
  nFund.addOutput({ lockingScript: new P2PKH().lock(bob.toPublicKey().toHash()), satoshis: 20_000 });
  const nFundTxid = nFund.id("hex");
  const nCb = "cb".repeat(32);
  nFund.merklePath = new MerklePath(1, [[{ offset: 0, hash: nCb }, { offset: 1, hash: nFundTxid, txid: true }]]);
  const nRoot1 = sha256d(Buffer.concat([internal(nCb), internal(nFundTxid)]));
  const nH1 = mine(sha256d(REGTEST_GENESIS), nRoot1, 1_790_010_000);
  await noarcRouter.admitEvent("noarc", "chain", { kind: "header", raw: nH1 });
  await noarcRouter.settled();
  const nTok = new Transaction();
  nTok.addInput({ sourceTransaction: nFund, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(bob), sequence: 0xffffffff });
  nTok.addOutput({ lockingScript: tokenScript(bob), satoshis: 1 });
  nTok.addOutput({ lockingScript: new P2PKH().lock(bob.toPublicKey().toHash()), satoshis: 19_000 });
  await nTok.sign();
  const nTokId = nTok.id("hex");
  const noarcLive = async () => {
    const r = new LookupResolver({ networkPreset: "local", hostOverrides: { ls_demo: [noarcBase] } });
    const a = await r.query({ service: "ls_demo", query: { topic: "tm_demo" } }) as { outputs: unknown[] };
    return a.outputs.length;
  };
  const nSub = await submitMsg(noarcRouter, "noarc", noarcDb, new Uint8Array(nTok.toAtomicBEEF()), ["tm_demo"]);
  await sleep(500);
  await noarcRouter.settled();
  const ng = await (await kN()).genesis() as { dispatch?: Array<{ address: string }> };
  report.noProviderPending = { answers: (await nSub.answers()).length, state: (await settledIn(await kN(), [nTokId]))[0], live: await noarcLive(), statusRow: (ng.dispatch ?? []).some((r) => r.address === "chain/status") };
  const nFiller = "f7".repeat(32);
  const nH2 = mine(sha256d(nH1), sha256d(Buffer.concat([internal(nFiller), internal(nTokId)])), 1_790_010_600);
  const nPath = new MerklePath(2, [[{ offset: 0, hash: nFiller }, { offset: 1, hash: nTokId, txid: true }]]);
  await noarcRouter.admitEvent("noarc", "chain", { kind: "header", raw: nH2 });
  await noarcRouter.admitEvent("noarc", "chain", { kind: "proof", subject: txCid(nTokId), txid: nTokId, path: Uint8Array.from(nPath.toBinary()) });
  await noarcRouter.settled();
  await until("the no-Arcade instance admits at the proof", async () => { await noarcRouter.settled(); return (await noarcLive()) > 0 ? true : undefined; }, 15_000).catch(() => undefined);
  report.noProviderProven = { state: (await settledIn(await kN(), [nTokId]))[0], live: await noarcLive(), answers: (await answered(nSub, noarcRouter)).map(gist).map((x) => x.slice(0, 2)) };

  report.ok = true;
} catch (e) {
  report.error = (e as Error).stack ?? String(e);
}
await router.stop();
await arcade.close();
hostDb.close();
await noarcRouter.stop();
noarcHostDb.close();

// ---------------------------------------------------------------- #74: the standard overlay gossip
// Three instances on three routers, each with a libp2p node: A (`ga`, with the host's Arcade, so a status
// provider) and B (`gb`, no Arcade: its chain app answers only at the proof) subscribe `tm_demo` and
// `tm_demo-proof`; C (`gc`) subscribes only `tm_demo-admit`. Every tree routes the three inbound topics to the
// overlay (`submit`, `peerAdmit`, `peerProof`).
const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});
const G = ["ga", "gb", "gc"] as const;
type GH = typeof G[number];
const gDb: Record<GH, string> = { ga: join(home, "instances/ga/runtime.db"), gb: join(home, "instances/gb/runtime.db"), gc: join(home, "instances/gc/runtime.db") };
const p2pSigner = new Signer(new PrivateKey("a77e57", 16));
const gossipTree = (dir: string, topics: string[]) => {
  cpSync(sys, dir, { recursive: true });
  const c = JSON.parse(readFileSync(join(sys, "etc/config.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(join(dir, "etc/config.json"), JSON.stringify({ ...c, libp2p: { topics } }));
  writeFileSync(join(dir, "etc/dispatch.json"), JSON.stringify([...ROWS,
    { transport: "libp2p", address: "tm_demo-admit", sender: "*", program: "overlay", fn: "peerAdmit" },
    { transport: "libp2p", address: "tm_demo-proof", sender: "*", program: "overlay", fn: "peerProof" }]));
};
gossipTree(join(home, "system-gossip-ab"), ["tm_demo", "tm_demo-proof"]);
gossipTree(join(home, "system-gossip-c"), ["tm_demo-admit"]);
const g: Partial<Record<GH, { hdb: HostDb; r: Router }>> = {};
const arcade74 = await FakeArcade.start();
const gr = (h: GH) => g[h]!.r;
try {
  const ports: Record<GH, number> = { ga: await freePort(), gb: await freePort(), gc: await freePort() };
  const idOf = (h: GH) => peerIdOf(p2pSigner.peerKey(h)).toString();
  for (const h of G) {
    const hdb = new HostDb(join(home, `${h}-host.db`));
    hdb.add(h, { store: gDb[h] });
    g[h] = {
      hdb,
      r: new Router({
        db: hdb, walletFor: () => ephemeralWallet(key("1111")), home, owner, idleMs: 0,
        providerKeyFor: (n) => p2pSigner.providerKey(n), peerKeyFor: (x) => p2pSigner.peerKey(x), answerWaitMs: 6000,
        kernel: { command: kernel, env: { SKEIN_HOME: home } },
        ...(h === "ga" ? { arc: { url: arcade74.url, token: "the-ga-arcade-token", events: arcade74.eventsUrl }, arcRetry: { min: 500, max: 2000 } } : {}),
        libp2p: { listen: [`/ip4/127.0.0.1/tcp/${ports[h]}`], bootstrap: G.filter((x) => x !== h).map((x) => `/ip4/127.0.0.1/tcp/${ports[x]}/p2p/${idOf(x)}`), dht: "off", relays: [], mdns: false },
        libp2pDiscoveryMs: 300,
        log: (s, l) => { if (process.env.VERBOSE) process.stdout.write(`  | [${h}:${s}] ${l}\n`); },
      }),
    };
  }
  const srcAB = await dirSource(join(home, "system-gossip-ab"));
  const srcC = await dirSource(join(home, "system-gossip-c"));
  for (const h of G) {
    await gr(h).listen(0);
    const s = h === "gc" ? srcC : srcAB;
    await gr(h).bootRow(h, { kind: "tree", root: s.root, objects: s.objects });
  }
  const subscribers = (h: GH, topic: string) => ((gr(h).p2p?.node(h)?.services as { pubsub: { getSubscribers(t: string): unknown[] } } | undefined)?.pubsub.getSubscribers(topic).length ?? 0);
  for (const h of G) await gr(h).hydrate(h);
  await until("the three nodes see each other's topics", async () => (
    subscribers("ga", "tm_demo") > 0 && subscribers("ga", "tm_demo-proof") > 0
    && subscribers("ga", "tm_demo-admit") > 0 && subscribers("gb", "tm_demo-admit") > 0) || undefined);

  const kOf = async (h: GH) => (await gr(h).hydrate(h)).kernel;
  const peerAdmits = async (h: GH) => {
    const k = await kOf(h);
    const out: Array<{ kind: string; topic: string; txid: string; from: string; outputsToAdmit: number[]; coinsToRetain: number[] }> = [];
    for (const [, c] of await headMap(k, "overlay/gossip", "peerAdmits")) {
      const r = await k.store.get(c as CID) as unknown as { kind: string; topic: string; txid: string; from: Uint8Array; outputsToAdmit: number[]; coinsToRetain: number[] };
      out.push({ ...r, from: Buffer.from(r.from).toString("hex") });
    }
    return out;
  };
  const logLenOf = async (h: GH) => { const k = await kOf(h); return (await k.store.get((await k.tip())!) as unknown as { n: number }).n + 1; };
  const headOf = async (h: GH, name: string) => String(await (await kOf(h)).call("head", name));
  const settleAll = async () => { for (const h of G) await gr(h).settled(); };
  const header = async (ev: Record<string, unknown>) => { for (const h of G) await gr(h).admitEvent(h, "chain", { kind: "header", ...ev }); await settleAll(); };
  const signed = async (k: PrivateKey, topic: string, body: Uint8Array, seq: bigint) => {
    const sq = new Uint8Array(8);
    new DataView(sq.buffer).setBigUint64(0, seq, false);
    const from = peerIdOf(k).toMultihash().bytes;
    const pb: number[] = [];
    const fld = (tag: number, b: Uint8Array) => { pb.push(tag); let n = b.length; while (n >= 0x80) { pb.push((n & 0x7f) | 0x80); n >>>= 7; } pb.push(n, ...b); };
    fld(0x0a, from); fld(0x12, body); fld(0x1a, sq); fld(0x22, new TextEncoder().encode(topic));
    const signature = await libp2pKey(k).sign(Uint8Array.from([...new TextEncoder().encode("libp2p-pubsub:"), ...pb]));
    return { transport: "libp2p" as const, topic, from, seqno: sq, signature, body };
  };
  const disp = (b: Uint8Array) => Buffer.from(b).reverse().toString("hex");
  const blockCid = (raw: Uint8Array) => String(CID.createV1(0xb0, Digest.create(0x56, sha256d(raw))));
  const peerKeyHex = (h: GH) => p2pSigner.peerKey(h).toPublicKey().toString();
  // Published messages: the libp2p provider's `publish` answers are recorded; count the overlay's emits by topic.
  const publishedBy = async (h: GH) => {
    const v = openStoreFile(gDb[h], { readOnly: true });
    const out: string[] = [];
    try {
      for await (const th of v.edges.query({ kind: "thread" })) {
        for await (const u of v.chains.history(th)) {
          if (u.equals(th)) continue;
          const up = await v.get(u) as unknown as { emitted?: CID[] };
          for (const e of up.emitted ?? []) {
            const m = await v.get(e) as unknown as { kind?: string; box?: string; body?: CID };
            if (m.kind !== "mail" || m.box !== "publish" || !m.body) continue;
            out.push(String((await v.get(m.body) as unknown as { topic: string }).topic));
          }
        }
      }
    } finally { await v.close(); }
    return out.sort();
  };

  // The chain: a funding transaction mined at 1 (second in its block), fed to all three (their chain apps).
  const carol = key("6666");
  const gFund = new Transaction();
  gFund.addInput({ sourceTXID: "66".repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex("51"), sequence: 0xffffffff });
  gFund.addOutput({ lockingScript: new P2PKH().lock(carol.toPublicKey().toHash()), satoshis: 30_000 });
  const gCb = "c6".repeat(32);
  gFund.merklePath = new MerklePath(1, [[{ offset: 0, hash: gCb }, { offset: 1, hash: gFund.id("hex"), txid: true }]]);
  const gh1 = mine(sha256d(REGTEST_GENESIS), sha256d(Buffer.concat([internal(gCb), internal(gFund.id("hex"))])), 1_790_020_000);
  await header({ raw: gh1 });
  const tokenOf = (k: PrivateKey) => Script.fromBinary([0x07, ...Buffer.from("tm_demo"), 0x75, ...new P2PKH().lock(k.toPublicKey().toHash()).toBinary()]);
  const gTok = new Transaction();
  gTok.addInput({ sourceTransaction: gFund, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(carol), sequence: 0xffffffff });
  gTok.addOutput({ lockingScript: tokenOf(carol), satoshis: 1 });
  gTok.addOutput({ lockingScript: new P2PKH().lock(carol.toPublicKey().toHash()), satoshis: 29_000 });
  await gTok.sign();
  const gTokId = gTok.id("hex");
  const gKey = internal(gTokId).toString("hex");
  const appliedOf = async (h: GH) => headMap(await kOf(h), "overlay/state", "applied");
  const pendingOf = async (h: GH) => headMap(await kOf(h), "overlay/state", "pending");
  const proofsOf = async (h: GH) => headMap(await kOf(h), "chain/state", "proofs");

  // (1) A submission over HTTP to A: admitted on its chain app's `accepted` (Arcade's RECEIVED) → A publishes the
  // BEEF as received on `tm_demo` and its verdict on `tm_demo-admit`.
  const sub = await fetch(`${gr("ga").originOf("ga")}/submit`, { method: "POST", headers: { "x-topics": "tm_demo" }, body: new Uint8Array(gTok.toBEEF()) });
  report.g74submit = [sub.status, typeof ((await sub.json()) as { id?: unknown }).id, await until("A admits", async () => { await gr("ga").settled(); return await steakOf(gDb.ga, gTokId); }).catch(() => undefined)];
  // B gets the raw submission by gossip, judges it, hands it to its chain app and waits: no status provider, so
  // nothing is admitted before the proof.
  await until("B holds the gossiped submission, pending", async () => (await pendingOf("gb")).has(gKey) || undefined);
  await settleAll();
  report.g74bPending = { pending: (await pendingOf("gb")).has(gKey), applied: (await appliedOf("gb")).size, proven: (await proofsOf("gb")).has(gKey) };
  // C, on `tm_demo-admit` only, records A's verdict: a peer-admit record under overlay/gossip, nothing admitted.
  await until("C records A's admit", async () => (await peerAdmits("gc")).length > 0 || undefined);
  report.g74cFirst = (await peerAdmits("gc")).map((r) => [r.kind, r.topic, r.txid === gTokId, r.from === peerKeyHex("ga"), r.outputsToAdmit, r.coinsToRetain]);

  // (2) The proof: block 2 mines the token; the header to all three, the proof event to A only. A's chain app proves it
  // and answers A's watch: A publishes `tm_demo-proof`. B's peerProof route checks the BUMP against its own chain
  // state and admits it as the chain app's `proof` event (with `via`): B's chain app proves it, answers B's submission
  // `proven` (via): admitted at the proof, `-proof` not published again; B publishes its own `tm_demo-admit`.
  const f2 = "f2".repeat(32);
  const gh2 = mine(sha256d(gh1), sha256d(Buffer.concat([internal(f2), internal(gTokId)])), 1_790_020_600);
  await header({ raw: gh2 });
  const path2 = new MerklePath(2, [[{ offset: 0, hash: f2 }, { offset: 1, hash: gTokId, txid: true }]]);
  await gr("ga").admitEvent("ga", "chain", { kind: "proof", subject: txCid(gTokId), txid: gTokId, path: Uint8Array.from(path2.toBinary()) });
  await until("B admits at the proof", async () => ((await appliedOf("gb")).size > 0 && (await proofsOf("gb")).has(gKey)) || undefined);
  await until("C records B's admit", async () => (await peerAdmits("gc")).length > 1 || undefined);
  await settleAll();
  const proofBlock = async (h: GH) => String(((await proofsOf(h)).get(gKey) as { block?: CID } | undefined)?.block);
  const bLive = await new LookupResolver({ networkPreset: "local", hostOverrides: { ls_demo: [gr("gb").originOf("gb")] } }).query({ service: "ls_demo", query: { topic: "tm_demo" } }) as { outputs: Array<{ beef: number[]; outputIndex: number }> };
  report.g74bAdmitted = {
    applied: (await appliedOf("gb")).size, pending: (await pendingOf("gb")).has(gKey),
    block: (await proofBlock("gb")) === blockCid(gh2), aBlock: (await proofBlock("ga")) === blockCid(gh2),
    live: bLive.outputs.map((o) => [Transaction.fromBEEF(o.beef).id("hex") === gTokId, o.outputIndex]),
  };
  report.g74cBoth = {
    froms: (await peerAdmits("gc")).map((r) => r.from).sort(), want: [peerKeyHex("ga"), peerKeyHex("gb")].sort(),
    cApplied: (await appliedOf("gc")).size,
  };
  report.g74published = { a: await publishedBy("ga"), b: await publishedBy("gb") };

  // (3) A bad BUMP on `tm_demo-proof` (block 3, a filler block, whose root is not the token's): ignore, not reject;
  // only its request entry is written, nothing else moves.
  const gh3 = mine(sha256d(gh2), sha256d(Buffer.from("filler g3")), 1_790_021_200);
  await header({ raw: gh3 });
  const mallory = key("7777");
  const badPath = new MerklePath(3, [[{ offset: 0, hash: "ba".repeat(32) }, { offset: 1, hash: gTokId, txid: true }]]);
  const bLen0 = await logLenOf("gb");
  const bState0 = [await headOf("gb", "overlay/state"), await headOf("gb", "chain/state")];
  const bad = await gr("gb").p2pInbound("gb", await signed(mallory, "tm_demo-proof", dagCbor.encode({ txid: gTokId, blockHash: disp(sha256d(gh3)), blockHeight: 3, bump: Uint8Array.from(badPath.toBinary()) }), 1n));
  await settleAll();
  report.g74badProof = [bad.verdict, bad.reason, (await logLenOf("gb")) - bLen0, eq([await headOf("gb", "overlay/state"), await headOf("gb", "chain/state")], bState0), (await proofBlock("gb")) === blockCid(gh2)];

  // (4) Late duplicates on `tm_demo`: the same BEEF from another publisher is "already judged"; A's own message
  // redelivered past the seen-cache is the same record, already admitted: nothing runs at all.
  const bLen1 = await logLenOf("gb");
  const late = await gr("gb").p2pInbound("gb", await signed(mallory, "tm_demo", new Uint8Array(gTok.toBEEF()), 2n));
  await settleAll();
  const kb = await kOf("gb");
  let original: { topic: string; from: Uint8Array; seqno: Uint8Array; signature: Uint8Array; body: Uint8Array | CID } | undefined;
  for (let c = await kb.tip(); c;) {
    const e = await kb.store.get(c) as unknown as { request?: CID; transport?: string; prev?: CID };
    if (e.request && e.transport === "libp2p") {
      const rec = await kb.store.get(e.request) as unknown as { kind: string; topic: string; from: Uint8Array; seqno: Uint8Array; signature: Uint8Array; body: Uint8Array | CID };
      if (rec.kind === "p2p" && rec.topic === "tm_demo" && Buffer.from(rec.from).equals(Buffer.from(peerIdOf(p2pSigner.peerKey("ga")).toMultihash().bytes))) original = rec;
    }
    c = e.prev;
  }
  // #121: B's log holds A's message with the BEEF replaced by its pointer record; the bytes come back exactly
  // (beef.ts beefOf, the encoder beside the door's decoder) — the gossip round trip: what B logged reconstructs to
  // what A was sent over HTTP — and they are what the redelivery carries, whose GossipSub signature (over the
  // bytes) the door checks again.
  let restored: Uint8Array | undefined;
  const pointerB = original ? CID.asCID(original.body) : null;
  if (pointerB) {
    const v = openStoreFile(gDb.gb, { readOnly: true });
    try { restored = await beefOf(await kb.store.get(pointerB) as unknown as BeefRecord, async (c) => await v.bytes(c)); } finally { await v.close(); }
  }
  report.g74roundTrip = [!!pointerB, !!restored && Buffer.from(restored).equals(Buffer.from(gTok.toBEEF()))];
  const again = original && restored ? await gr("gb").p2pInbound("gb", { transport: "libp2p", topic: original.topic, from: original.from, seqno: original.seqno, signature: original.signature, body: restored }) : undefined;
  await settleAll();
  report.g74late = {
    late: [late.verdict, late.reason], redelivered: again ? [again.verdict, again.reason] : "A's message not found in B's log",
    entries: (await logLenOf("gb")) - bLen1, state: (await headOf("gb", "overlay/state")) === bState0[0],
  };
  report.g74ok = true;
} catch (e) {
  report.g74error = (e as Error).stack ?? String(e);
}
for (const h of G) if (g[h]) { await g[h]!.r.stop(); g[h]!.hdb.close(); }
await arcade74.close();

// #42: the merkle nodes the BUMPs revealed (kept by the chain app) are 64-byte bitcoin-tx blocks that contribute no
// edges (nor does the header): no token is a `child` edge target, and no edge in the map is `child` / `prev` /
// `merkleroot`. The nodes still link forward. The TS reader derives the kernel's edges map key for key.
if (report.ok === true) {
  const v = openStoreFile(db, { readOnly: true });
  const d = await derive(v);
  const children: boolean[] = [];
  const leaves = report.leaves as string[];
  const [n01, n23] = report.nodes as string[];
  for (const i of [1, 2, 3]) children.push((await v.edges.refsTo(txCid(leaves[i]!))).some((x) => x.rel === "child"));
  const fwd = async (c: string) => (await v.edges.refsFrom(txCid(c))).map((x) => [x.rel, x.locator, String(x.to)].join(" "));
  const forward = eq(await fwd(report.root as string), [["child", "0", String(txCid(n01!))].join(" "), ["child", "1", String(txCid(n23!))].join(" ")])
    && eq(await fwd(n23!), [["child", "0", String(txCid(leaves[2]!))].join(" "), ["child", "1", String(txCid(leaves[3]!))].join(" ")]);
  const noNodeEdges = d.pairs.edges.every(([, x]) => !["child", "prev", "merkleroot"].includes((x as [string])[0]));
  report.edges = { sameRoot: String(buildTree(d.pairs.edges).root) === String((v as unknown as { state(): { roots: { edges: CID } } }).state().roots.edges), children, noNodeEdges, forward };
  await v.close();
}

const STEAK = { tm_demo: { outputsToAdmit: [0], coinsToRetain: [], coinsRemoved: [] } };
process.stdout.write("== overlay services (#36, #79)\n");
check(report.ok === true, `the scenario ran${report.error ? `: ${report.error}` : ""}`);
check(report.chainState === "chain-state", `the headers (events in box chain) reached the chain app: chain/state is a chain-state (${String(report.chainState)})`);
check(eq(report.submit1, { status: "error", delivered: true, steak: STEAK }), `TopicBroadcaster → POST /submit (0.7.3: 200 {id}, delivery only, which the stock broadcaster does not read as a STEAK): the token admitted on the chain app's answer, the STEAK in the admitting step's result (${JSON.stringify(report.submit1)})`);
check(eq(report.posted1, [true]), `#79: the chain app broadcast the token transaction the overlay handed it; the host posted it to Arcade once (Extended Format) before it was admitted (${JSON.stringify(report.posted1)})`);
{
  const d = report.door121 as { filter?: string; linked?: boolean; kind?: string; grep?: [number, boolean]; identical?: boolean; txBlocks?: boolean[]; ingested?: boolean; ingests?: string[] } | undefined;
  check(d?.filter === "beef" && d.linked === true && d.kind === "beef", `#121: the submit's entry: the door ran the row's beef filter; its request names the BEEF's pointer record, listed in door.beefs (${JSON.stringify(d)})`);
  check(!!d?.grep && d.grep[0] === 0 && d.grep[1], `#121: no block in the store holds the submitted BEEF's bytes (a grep of every block: ${JSON.stringify(d?.grep)})`);
  check(d?.identical === true && !!d.txBlocks?.length && d.txBlocks.every(Boolean), `#121: the record's bytes back (beef.ts beefOf over its blocks: each transaction a bitcoin-tx block) are the submitted bytes`);
  check(d?.ingested === true && !!d.ingests?.length && d.ingests.every((x) => x === "the pointer"), `#121: the chain app ingested it from the pointer record's CID — every ingest message the overlay sent carries the CID, none the bytes (${JSON.stringify(d?.ingests)})`);
  const bb = report.badBump as Record<string, unknown> | undefined;
  check(eq(bb, { status: 400, code: "ERR_REFUSED", entries: 1, refused: "filter", reason: true, noThread: true, same: true, pointer: true }), `#121: a bad BUMP: a refusal entry (stage filter, "merkle root"), stored with its BEEF a pointer; nothing runs (no thread, no head moved); 400 to the client (${JSON.stringify(bb)})`);
  const db_ = report.dupeBlocks as { bitcoinAndRaw: [number, number]; samePointer: boolean } | undefined;
  check(!!db_ && db_.bitcoinAndRaw[0] === db_.bitcoinAndRaw[1] && db_.samePointer && (db_ as { delivered?: boolean }).delivered === true, `#121: a held transaction submitted again writes no block (bitcoin and raw blocks ${JSON.stringify(db_?.bitcoinAndRaw)}), the same pointer record`);
  check(eq(report.lookupSame, [true, true]), `#121: the lookup answers the same bytes on the instance that took T1 over HTTP and the one that took it over GossipSub (${JSON.stringify(report.lookupSame)})`);
}
{
  const gg = report.gossip as { verdict: string; appended: number; boxes: string[]; applied: number; admitted: number; same: boolean; posts: number } | undefined;
  check(gg?.verdict === "accept" && gg.appended === 1 && eq(gg.boxes, ["libp2p:tm_demo:p2p", "overlay:submit"]) && gg.applied === 1 && gg.admitted === 1 && gg.same, `#57, #68, #79: the same transaction as a GossipSub message: one entry; accept, admitting the \`p2p\` event then the submit event into the app's own box \`overlay\`; the same applied / admitted records (but for their step times) as POST /submit produced (${JSON.stringify(gg)})`);
  check(gg?.posts === 2, `#57: the pubsub submission went through the same gate: the gossip instance's chain app broadcast it too (${JSON.stringify(gg?.posts)} posts of it)`);
  check(eq(report.gossipAgain, ["ignore", "already admitted", 1, true]), `#57, #68: the message redelivered: one entry, ignored, nothing else changed (${JSON.stringify(report.gossipAgain)})`);
}
check(eq(report.lookup1, [["t1", 0, true]]), `LookupResolver → POST /lookup (aggregated): the token, its BEEF (from the chain state) verifying against the headers (${JSON.stringify(report.lookup1)})`);
check(eq(report.byScript, [["t1", 0]]), `a lookup by script hash (${JSON.stringify(report.byScript)})`);
check(eq(report.lookupJson, { type: "output-list", outputs: [["t1", 0]] }), `the JSON answer form (${JSON.stringify(report.lookupJson)})`);
{
  const d = report.dupe as { answers: number; gist: unknown[] } | undefined;
  check(!!d && d.answers === 1 && d.gist[0] === "admitted" && eq(d.gist[2], STEAK), `#57, #112: a resubmission by message is answered admitted from the state at once, its STEAK; an unserved topic is left out (${JSON.stringify(report.dupe)})`);
}
check(eq(report.refusedSubmit, [1, "rejected", "NotAdmitted", 1, true]), `#50, #68, #112: a submission no topic takes: answered rejected (NotAdmitted), one entry; the overlay's, the lookup service's and the chain's heads where they were (${JSON.stringify(report.refusedSubmit)})`);
check(report.lsHead === true, `#50, #79: ls_demo keeps its own storage under the head overlay/ls_demo`);
check(eq(report.submit2Delivered, [200, "string"]) && eq(report.submit2, { tm_demo: { outputsToAdmit: [0], coinsToRetain: [0], coinsRemoved: [] } }), `the spend (POST /submit, X-Topics a JSON array, Atomic BEEF: 200 {id}): a new token admitted, the old retained (${JSON.stringify([report.submit2Delivered, report.submit2])})`);
check(eq(report.lookup2, [["t2", 0, true]]) && eq(report.withSpent, [["t1", 0], ["t2", 0]]), `the live set moves to the new token (spent-ness from the chain state); the old one stays for history (${JSON.stringify([report.lookup2, report.withSpent])})`);
check(eq(report.afterReject, [["t1", 0, true]]), `#79: a DOUBLE_SPEND_ATTEMPTED for the spend: the chain app rejects it and answers the overlay's watch; its admittance vanishes, the consumed token is live again (${JSON.stringify(report.afterReject)})`);
check(eq(report.t2Settled, [[false, false, true]]), `the chain state: the spend rejected, nothing pending (${JSON.stringify(report.t2Settled)})`);
check(Array.isArray(report.resubmitRejected) && report.resubmitRejected[0] === "rejected", `a rejected transaction admits nothing on resubmission: answered rejected (${JSON.stringify(report.resubmitRejected)})`);
check(Array.isArray(report.badBeef) && report.badBeef[0] === "rejected" && report.unknownService === 400, `refusals: a bad BEEF (answered rejected), an unknown service (400) (${JSON.stringify([report.badBeef, report.unknownService])})`);
check(eq(report.topics, { tm_demo: { name: "tm_demo", shortDescription: "Example tokens: outputs starting <\"tm_demo\"> OP_DROP with at least 1 satoshi." } }) && (report.lookups as Record<string, unknown>)?.ls_demo !== undefined, `the listings, from the programs' own metadata (skein-overlay#2) (${JSON.stringify([report.topics, report.lookups])})`);
check(Array.isArray(report.doc) && String(report.doc[0]).startsWith("text/markdown"), `documentation (${JSON.stringify(report.doc)})`);
{
  const [b, a, n, still, local] = (report.readsWrite ?? []) as [number, number, number, boolean, number];
  check(n > 10 && a === b + n && local >= 2 && still === true, `every forwarded request is an entry (${n} requests: ${b} → ${a}, besides ${local} \`local\` ones: the status provider's and the loopback's); the reads moved nothing (${still})`);
}
check(eq(report.awaitingU, { state: [[false, true, false], [false, true, false], [false, true, false]], posts: [1, 1, 1] }), `#57, #79: three unproven tokens, each posted once by the chain app and admitted on its accepted, each unproven with its broadcast registered (${JSON.stringify(report.awaitingU)})`);
check(eq(report.settledBySse, [[true, false, false], [true, false, false], [true, false, false]]), `#65: Arcade's SEEN_ON_NETWORK then MINED (proof events with merkle paths) over its SSE stream, to the chain app: proven, nothing registered (${JSON.stringify(report.settledBySse)})`);
check(eq(report.merkle, [[1, true, true], [2, true, true], [3, true, true]]), `three tokens of one block, proven by separate BUMPs (out of order): each lookup answer carries the BUMPs rebuilt from the stored merkle nodes, verified by @bsv/sdk (${JSON.stringify(report.merkle)})`);
check(eq(report.merkleAlone, [[1, true, true], [2, true, true], [3, true, true]]), `each token alone: its BUMP rebuilt from the tree is byte for byte the one its proof carried (${JSON.stringify(report.merkleAlone)})`);
check(Array.isArray(report.chronicle) && report.chronicle[0] === true && report.chronicle[1] === "rejected" && /^NotAdmitted/.test(String(report.chronicle[2])), `#53: a Rúnar AMM pool spend (OP_2MUL) verifies under Chronicle rules: no topic here takes it, answered rejected NotAdmitted (not a script failure) (${JSON.stringify(report.chronicle)})`);
check(Array.isArray(report.chronicleBroken) && report.chronicleBroken[0] === "rejected" && String(report.chronicleBroken[1]).includes("ScriptFailed"), `#53: the same swap with its funding signature broken: answered rejected, ScriptFailed (${JSON.stringify(report.chronicleBroken)})`);
check(eq(report.mined, { answer: ["admitted", "proven", STEAK], posted: 0, state: [true, false, false] }), `#57: a mined submission (its BEEF proves it): the chain app answers proven at once, admitted, no post (${JSON.stringify(report.mined)})`);
{
  const x = report.arcRejected as { answer: unknown[]; posted: number; state: boolean[]; live: number } | undefined;
  check(x?.answer[0] === "rejected" && /REJECTED|TransactionRejected/.test(String(x.answer[1])) && x.posted === 1 && eq(x.state, [false, false, true]) && x.live === 0, `#57: Arcade's 400 (a REJECTED status): the chain app answers rejected, nothing admitted; the submitter answered rejected (${JSON.stringify(x)})`);
}
{
  const t = report.transient as { busy: { first: unknown[]; again: unknown[]; submissions: number; state: boolean[]; posts: number }; steak: unknown[][]; submissions: number; queued: boolean; posts: number; state: boolean[]; live: unknown[] } | undefined;
  check(!!t && eq(t.busy.first, []) && eq(t.busy.state, [false, true, false]) && t.busy.posts >= 1, `#57, #112: Arcade's 503: the host keeps it queued; nothing admitted; the submitter not answered yet (${JSON.stringify(t?.busy)})`);
  check(!!t && eq(t.busy.again, []) && t.busy.submissions === 1, `#112: a resubmission while pending launches no second submission and is not answered (${JSON.stringify(t?.busy)})`);
  check(!!t && eq(t.steak, [[["admitted", "pending", STEAK]], []]) && t.submissions === 1 && !t.queued && t.posts >= 2 && eq(t.state, [false, true, false]) && eq(t.live, [[true, 0]]), `#57, #112: the host's queue retries; Arcade takes it: accepted, admitted; the first submitter answered admitted with the STEAK (${JSON.stringify(t)})`);
  check(Array.isArray(report.firstAnswers) && report.firstAnswers.length === 1, `skein-overlay 0.7.4: the first submitter (by message) is answered exactly once (${JSON.stringify(report.firstAnswers)})`);
}
{
  const p = report.noProviderPending as { answers: number; state: boolean[]; live: number; statusRow: boolean } | undefined;
  check(!!p && p.answers === 0 && eq(p.state, [false, true, false]) && p.live === 0 && p.statusRow === false, `#73: no Arcade, no status provider (the chain app's \`status\` row left out): the submission handed to the chain app, pending; not answered; nothing admitted (${JSON.stringify(p)})`);
  const v = report.noProviderProven as { state: boolean[]; live: number; answers: unknown[][] } | undefined;
  check(!!v && eq(v.state, [true, false, false]) && v.live === 1 && v.answers[0]?.[0] === "admitted" && v.answers[0]?.[1] === "proven", `#73: its proof, fed directly: the chain app answers proven — admitted at the proof, the submitter answered admitted (proven) (${JSON.stringify(v)})`);
}
check(eq(report.edges, { sameRoot: true, children: [false, false, false], noNodeEdges: true, forward: true }), `#42: kept merkle nodes and headers contribute no edges, the nodes still link forward; the TS reader derives the kernel's edges map, same root (${JSON.stringify(report.edges)})`);

process.stdout.write("== overlay gossip (#74, #79)\n");
check(report.g74ok === true, `the gossip scenario ran${report.g74error ? `: ${report.g74error}` : ""}`);
check(eq(report.g74submit, [200, "string", STEAK]), `A: POST /submit (200 {id}) admitted on its chain app's accepted (Arcade's RECEIVED) (${JSON.stringify(report.g74submit)})`);
check(eq(report.g74bPending, { pending: true, applied: 0, proven: false }), `A re-published the raw submission on \`tm_demo\`: B (no status provider) judged it, handed it to its chain app, waits — nothing admitted before the proof (${JSON.stringify(report.g74bPending)})`);
check(eq(report.g74cFirst, [["peer-admit", "tm_demo", true, true, [0], []]]), `A's verdict on \`tm_demo-admit\`: C records it as a peer-admit record from A's peer key under overlay/gossip (${JSON.stringify(report.g74cFirst)})`);
check(eq(report.g74bAdmitted, { applied: 1, pending: false, block: true, aBlock: true, live: [[true, 0]] }), `A's chain app proved it; A published \`tm_demo-proof\`; B's route checked the BUMP against its chain state, B's chain app proved it, B admitted at the proof (${JSON.stringify(report.g74bAdmitted)})`);
{
  const c = report.g74cBoth as { froms: string[]; want: string[]; cApplied: number } | undefined;
  check(!!c && eq(c.froms, c.want) && c.cApplied === 0, `B published its own admit: C holds A's and B's peer-admits, and admitted nothing itself (${JSON.stringify(c)})`);
}
check(eq(report.g74published, { a: ["tm_demo", "tm_demo-admit", "tm_demo-proof"], b: ["tm_demo-admit"] }), `what each published: A the submission, its verdict and the proof; B only its verdict (the submission and the proof came by gossip: \`via\`) (${JSON.stringify(report.g74published)})`);
check(eq(report.g74badProof, ["ignore", "the bump's root is not our header's merkle root", 1, true, true]), `a bad BUMP on \`tm_demo-proof\`: ignore (not reject), only its request entry written, B's state where it was (${JSON.stringify(report.g74badProof)})`);
check(eq(report.g74roundTrip, [true, true]), `#121, the gossip round trip: B's log holds A's raw submission as a pointer record, and its bytes back are exactly what A was sent over HTTP (${JSON.stringify(report.g74roundTrip)})`);
{
  const l = report.g74late as { late: unknown[]; redelivered: unknown; entries: number; state: boolean } | undefined;
  check(!!l && eq(l.late, ["ignore", "already judged"]) && eq(l.redelivered, ["ignore", "already admitted"]) && l.entries === 2 && l.state, `late duplicates on \`tm_demo\`: "already judged" / "already admitted", each one request entry, the state unchanged (${JSON.stringify(l)})`);
}

const replay = (file: string, what: string) => {
  const r = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), file], { encoding: "utf8" });
  process.stdout.write(r.stdout);
  if (r.status !== 0) process.stdout.write(r.stderr);
  check(r.status === 0 && /identical .*the source store reproduced exactly/.test(r.stdout), what);
};
replay(db, "the store replays to itself exactly");
replay(gossipDb, "#57: the gossip instance's store replays to itself exactly");
replay(gateDb, "#57: the gate instance's store replays to itself exactly");
replay(noarcDb, "#73: the no-Arcade instance's store replays to itself exactly");
if (report.g74ok === true) for (const h of G) replay(gDb[h], `#74: ${h}'s store replays to itself exactly`);

if (process.env.KEEP) process.stdout.write(`kept ${home}\n`); else rmSync(home, { recursive: true, force: true });
process.stdout.write(failures ? `overlay: ${failures} FAILED\n` : "overlay: all ok\n");
process.exit(failures ? 1 : 0);

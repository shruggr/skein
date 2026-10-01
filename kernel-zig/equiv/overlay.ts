// Overlay services in the VM (issue #36) end to end on the Zig kernel,
// served by the instance's own front door (#40: etc/routes.json names the
// overlay engine's route handlers; the router only proxies to the instance's
// origin) to the stock @bsv/sdk overlay clients: an instance booted from a
// system tree (#4) whose bin/ holds the front door, the overlay engine, the
// tm_demo topic and the ls_demo lookup (programs/overlay), its config naming
// them (#50: ls_demo listening to tm_demo, keeping its own index through its
// hooks). Every request is an entry (#68: appended as received, the front
// door stepped on it); a submit is the one write (decoded once and judged in
// the front door's step, the submission's thread launched and waited on, #66,
// its STEAK read from the state once it finishes); a lookup, a dupe, a
// refused BEEF and a submission no topic takes move no state — the refusal
// recorded, the heads where they were. Headers are fed as plain
// `header` entries (a regtest chain from its genesis, the funding mined at
// height 1); a token transaction is broadcast with TopicBroadcaster (POST
// /submit, SHIP's wire form) and found with LookupResolver (POST /lookup,
// the aggregated octet-stream form) — its BEEF verifies against the headers;
// the token is spent into a new one (the old retained for history); then a
// status (the status provider's message) rejects the spend and the first token is live again. The
// listings and documentation routes answer from the program records. Then
// merkle proofs as IPLD nodes (#29): three tokens mined in one block, proven
// by separate BUMPs in proof events (out of order); the lookup answers carry
// BUMPs rebuilt from the stored nodes, which @bsv/sdk verifies (one token
// alone: byte for byte the BUMP it was sent). The store then replays to
// itself exactly (equiv/replays.ts). Chronicle (#53): a Rúnar AMM pool spend
// (its pool input executes OP_2MUL) verifies in the front door's call.
// One submit, every transport (#57): a second instance from the same tree gets
// the same token transaction as a signed GossipSub message on its
// `libp2p:tm_demo` route (the same `submit` fn), through the router's
// p2pInbound; its store then holds the same `applied` / `admitted` records
// (but for each step's own time), `byTopic` map and lookup storage as the
// POST /submit path produced, and a redelivery of the message is recorded and
// ignored, nothing else changed.
// The broadcast gate (#57, #65, #73), against the host's broadcaster (#58) in
// front of a fake Arcade (src/host/fake-arcade.ts): there is no setting —
// every unproven submission is broadcast as an event by the step, which the
// host queues and posts to Arcade (Extended Format), and admitted (the
// instances subscribing to the host's status provider) on the first of
// Arcade's answer — a RECEIVED status message — saying Arcade took it, or its
// proof: the GossipSub one too (Arcade's duplicate answer, sent to its
// broadcaster); the three tokens' SEEN statuses (messages) and MINED proofs
// (events, with their merkle paths) come back over Arcade's SSE stream, and
// the proofs just prove them (no second admission); a resubmission answers
// the STEAK from the state; a mined submission (its BEEF proves it) is
// admitted with no POST; Arcade's 400 (a REJECTED status) rejects one (400,
// nothing admitted). A third instance meets Arcade's 503: the host keeps the
// transaction queued, the client waits on the submission's thread until the
// router's bound (503 + Retry-After, nothing admitted), a resubmission waits
// on the same thread (503 again); then the queue's retry is taken, and two
// clients waiting on the thread both get the STEAK. A fourth instance, on a
// host with no Arcade (so no status provider is seeded in its address book):
// nothing is admitted before its proof, fed directly as the headers are
// (overlay unit test.zig covers the status-first and proof-first orderings
// and that a later signal never admits twice). The standard overlay gossip
// (#74), three instances on three routers with libp2p: A (with Arcade)
// admits an HTTP submission and publishes it on `tm_demo` and its verdict on
// `tm_demo-admit`; B (no status provider) judges the gossiped submission and
// waits at its gate; A's proof (its chain feed) goes out on `tm_demo-proof`,
// B checks it against its own headers and admits at it; C (on
// `tm_demo-admit` only) records A's and B's admits as peer-admit records; a
// reorg's re-proof reaches B and replaces the old one; a bad BUMP is ignored
// (its request entry only); late duplicates are "already judged" / "already
// admitted". All stores replay to themselves exactly.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/overlay.ts

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HTTPSOverlayBroadcastFacilitator, LookupResolver, MerklePath, P2PKH, PrivateKey, Script, TopicBroadcaster, Transaction, UnlockingScript, Utils, type ChainTracker } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import { dirSource } from "../../src/host/boot.ts";
import { FakeArcade } from "../../src/host/fake-arcade.ts";
import { HostDb } from "../../src/host/instances.ts";
import { buildTree, derive, openStoreFile } from "../../src/runtime/index-store.ts";
import { libp2pKey, peerIdOf } from "../../src/host/p2p.ts";
import { Router } from "../../src/host/router.ts";
import { Oracle } from "../../src/host/oracle.ts";
import { ephemeralWallet } from "../../src/wallet.ts";

const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
const overlayBin = join(here, "../../programs/overlay/zig-out/bin");
const home = mkdtempSync(join(tmpdir(), "skein-kz-overlay-"));
const db = join(home, "instances/overlay/runtime.db");
const key = (h: string) => new PrivateKey(h, 16);
const report: Record<string, unknown> = {};
let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };
const eq = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);

// ---------------------------------------------------------------- the system tree

const sys = join(home, "system");
mkdirSync(join(sys, "bin"), { recursive: true });
mkdirSync(join(sys, "etc"), { recursive: true });
for (const p of ["overlay", "topic-demo", "lookup-demo"]) copyFileSync(join(overlayBin, `${p}.wasm`), join(sys, `bin/${p}.wasm`));
copyFileSync(join(here, "../../wasm/frontdoor.wasm"), join(sys, "bin/frontdoor.wasm"));
writeFileSync(join(sys, "bin/frontdoor.json"), JSON.stringify({ inputs: {}, description: "The front door." }));
const handler = { event: "cid", box: "string" };
writeFileSync(join(sys, "bin/overlay.json"), JSON.stringify({ inputs: handler, description: "The overlay engine: BRC-22 submit, BRC-24 lookup, the chain feed." }));
writeFileSync(join(sys, "bin/topic-demo.json"), JSON.stringify({ inputs: {}, description: "Demo tokens: outputs whose script starts <\"tm_demo\"> OP_DROP.\n\nEvery such output is admitted; the tokens a transaction spends are retained when it admits one." }));
writeFileSync(join(sys, "bin/lookup-demo.json"), JSON.stringify({ inputs: {}, description: "Demo token lookup: {topic}, {scriptHash, topic?}, {txid, outputIndex, topic}." }));
// No broadcaster in the tree: a broadcast is an event the host carries (#65); the host's genesis seeds its status provider in the address book.
const config = () => JSON.stringify({ defaults: { walletNetwork: "regtest", overlayTopics: JSON.stringify({ tm_demo: "topic-demo" }), overlayLookups: JSON.stringify({ ls_demo: { program: "lookup-demo", topics: ["tm_demo"] } }) } });
writeFileSync(join(sys, "etc/config.json"), config());
// The submit entries, the chain feed (headers, proofs) and the status provider's messages (#65: `$status`).
writeFileSync(join(sys, "etc/subscriptions.json"), JSON.stringify([{ box: "submit", handler: "overlay" }, { box: "chain", handler: "overlay" }, { sender: "$status", box: "status", handler: "overlay" }]));
// The overlay-express wire contract as front-door routes: open, as overlay-express is.
const route = (path: string, fn: string) => ({ path, program: "overlay", fn, auth: "none" });
writeFileSync(join(sys, "etc/routes.json"), JSON.stringify([
  route("/submit", "submit"), route("/lookup", "lookup"),
  route("/listTopicManagers", "listTopicManagers"), route("/listLookupServiceProviders", "listLookupServiceProviders"),
  route("/getDocumentationForTopicManager", "topicDocumentation"), route("/getDocumentationForLookupServiceProvider", "lookupDocumentation"),
  // #57: the same submit fn on a GossipSub topic (the message's topic is the overlay topic requested).
  { path: "libp2p:tm_demo", program: "overlay", fn: "submit" },
]));
writeFileSync(join(sys, "README.md"), "An overlay node: tm_demo and ls_demo.\n");
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
// The host's Arcade (#58, #65): the overlay's step broadcasts an event, the host posts it; Arcade's answer and statuses come back as status messages, proofs as events.
const arcade = await FakeArcade.start();
const posted = (txid: string) => arcade.posts.filter((b) => FakeArcade.txOf(b).id("hex") === txid);
const router = new Router({
  db: hostDb, walletFor: () => ephemeralWallet(key("1111")), home, owner, idleMs: 0, providerKeyFor: (n) => new Oracle(new PrivateKey("a77e57", 16)).providerKey(n),
  // #66: a client waits on its request's thread; the gate's pending broadcast answers 503 + Retry-After at this bound.
  answerWaitMs: 6000,
  kernel: { command: kernel, env: { SKEIN_HOME: home } },
  arc: { url: arcade.url, token: "the-host-arcade-token", events: arcade.eventsUrl }, arcRetry: { min: 500, max: 2000 },
  log: (s, l) => { if (process.env.VERBOSE) process.stdout.write(`  | [${s}] ${l}\n`); },
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
async function until<T>(what: string, f: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}
// #73: a fourth instance, on a router with no Arcade — no status provider is seeded in its address
// book, so no status ever arrives.
const noarcDb = join(home, "instances/noarc/runtime.db");
const noarcHostDb = new HostDb(join(home, "noarc-host.db"));
noarcHostDb.add("noarc", { store: noarcDb });
const noarcRouter = new Router({
  db: noarcHostDb, walletFor: () => ephemeralWallet(key("1111")), home, owner, idleMs: 0, providerKeyFor: (n) => new Oracle(new PrivateKey("a77e57", 16)).providerKey(n),
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
  // The overlay's own origin (the SDK clients take an origin, no path): http://overlay.localhost:<port>.
  const base = router.originOf("overlay");

  // The chain: the funding transaction mined alone at 1, then 2 and 3, as plain header entries.
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

  // A token: <"tm_demo"> OP_DROP + P2PKH to alice.
  const tokenScript = (k: PrivateKey) => Script.fromBinary([0x07, ...Buffer.from("tm_demo"), 0x75, ...new P2PKH().lock(k.toPublicKey().toHash()).toBinary()]);
  const t1 = new Transaction();
  t1.addInput({ sourceTransaction: fund, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(alice), sequence: 0xffffffff });
  t1.addOutput({ lockingScript: tokenScript(alice), satoshis: 1 });
  t1.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 49_000 });
  await t1.sign();

  // The stock broadcaster, its facilitator pointed at the router (the local preset only knows :8080).
  const steaks: unknown[] = [];
  const facilitator = { send: async (_url: string, tagged: Parameters<HTTPSOverlayBroadcastFacilitator["send"]>[1]) => { const s = await new HTTPSOverlayBroadcastFacilitator(fetch, true).send(base, tagged); steaks.push(s); return s; } };
  const broadcaster = new TopicBroadcaster(["tm_demo"], { networkPreset: "local", facilitator });
  const b1 = await broadcaster.broadcast(t1);
  report.submit1 = { status: b1.status, steak: steaks.at(-1) };
  // #57, #65: the step broadcast it (an event), the host posted it to Arcade before it was admitted: once, in Extended Format.
  report.posted1 = posted(t1.id("hex")).map((b) => Buffer.from(b).equals(Buffer.from(t1.toEF())));

  // #57: the same transaction as a GossipSub message on the second instance's `libp2p:tm_demo` route — signed
  // by a publisher's peer key (StrictSign), handed to the router's p2pInbound as the libp2p host would. The
  // front door verifies it, the overlay's submit fn judges it and returns the same submit entry, and the front
  // door forwards that entry after the message's own `p2p` entry: the step persists what POST /submit did.
  await router.settled();
  // What an instance persisted for the token: every record in its `applied` and `admitted` maps (keys and
  // records, read through the map's tree nodes), the `byTopic` map's root, the lookup service's head. The records
  // carry their step's time (`at`, `admittedAt`), which is each instance's own: set aside, and shown.
  const plainOf = (v: unknown): unknown => v instanceof Uint8Array ? Buffer.from(v).toString("hex")
    : v instanceof CID || (v && typeof v === "object" && (v as { asCID?: unknown }).asCID === v) ? String(v)
    : Array.isArray(v) ? v.map(plainOf)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([x, y]) => [x, plainOf(y)])) : v;
  const persisted = async (h: string) => {
    const k = (await router.hydrate(h)).kernel;
    const st = await k.store.get(await k.call("head", "wallet") as CID) as unknown as { maps: Record<string, CID | null> };
    const times: unknown[] = [];
    const records = async (root: CID | null): Promise<unknown[]> => {
      const out: unknown[] = [];
      const walk = async (c: CID | null): Promise<void> => {
        if (!c) return;
        const [left, es] = await k.store.get(c) as unknown as [CID | null, Array<[Uint8Array, CID, CID | null]>];
        await walk(left);
        for (const [key, rec, right] of es) {
          const { at, admittedAt, ...r } = await k.store.get(rec) as unknown as Record<string, unknown>;
          times.push(at ?? admittedAt);
          out.push([Buffer.from(key).toString("hex"), plainOf(r)]);
          await walk(right);
        }
      };
      await walk(root);
      return out;
    };
    const applied = await records(st.maps.applied ?? null);
    const admitted = await records(st.maps.admitted ?? null);
    return { applied, admitted, byTopic: String(st.maps.byTopic), lookup: String(await k.call("head", "ls:ls_demo")), times };
  };
  // #57: the keys of one of an instance's state maps (hex), read through its tree nodes.
  const mapKeys = async (h: string, name: string): Promise<Set<string>> => {
    const k = (await router.hydrate(h)).kernel;
    const st = await k.store.get(await k.call("head", "wallet") as CID) as unknown as { maps: Record<string, CID | null> };
    const out = new Set<string>();
    const walk = async (c: CID | null | undefined): Promise<void> => {
      if (!c) return;
      const [left, es] = await k.store.get(c) as unknown as [CID | null, Array<[Uint8Array, CID, CID | null]>];
      await walk(left);
      for (const [key, , right] of es) { out.add(Buffer.from(key).toString("hex")); await walk(right); }
    };
    await walk(st.maps[name]);
    return out;
  };
  // Each transaction's settlement as the state says: [proven (a proof held), still awaiting its status, rejected].
  const settledOf = async (h: string, txids: string[]) => {
    const [proofs, awaiting, rejected] = await Promise.all(["proofs", "awaiting", "rejected"].map((m) => mapKeys(h, m)));
    return txids.map((t) => { const k = internal(t).toString("hex"); return [proofs.has(k), awaiting.has(k), rejected.has(k)]; });
  };
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
  // #65: the submission's step broadcast it; Arcade's answer to the host's post — a status message, later —
  // admits it. Nobody waits on this thread (GossipSub got its verdict), so wait for the admission here.
  await until("the gossip instance's admission", async () => ((await persisted("gossip")).applied.length > 0 ? true : undefined));
  await router.settled();
  const byHttp = await persisted("overlay");
  const byGossip = await persisted("gossip");
  // #68: the message is one entry, as received; what the front door's step admitted — the `p2p` event, then
  // the submit event (box `submit`), in that order — is on its answer, the request thread's last update.
  const gk = (await router.hydrate("gossip")).kernel;
  const boxes: string[] = [];
  let appended = 0;
  // The message's own request (the status provider's messages are requests too, transport `local`, #65).
  for (const e of (await entriesSince("gossip", lenBefore)).filter((x) => x.request && x.transport === "libp2p" && x.n < lenAfter)) {
    appended++;
    const a = await gk.answer(e.cid, 0);
    if (a.state === "finished") for (const x of (dagCbor.decode(a.answer) as { admit?: Array<{ box: string; event: { kind: string } }> }).admit ?? []) boxes.push(`${x.box}:${x.event.kind}`);
  }
  const { times: httpTimes, ...httpState } = byHttp;
  const { times: gossipTimes, ...gossipState } = byGossip;
  report.gossip = {
    // #57: the same gate — the gossip instance's step broadcast it too (Arcade answered its duplicate's status, to it).
    verdict: g1.verdict, appended, boxes, posts: posted(t1.id("hex")).length, applied: httpState.applied.length, admitted: httpState.admitted.length,
    same: eq(httpState, gossipState), times: [httpTimes, gossipTimes], ...(eq(httpState, gossipState) ? {} : { httpState, gossipState }),
  };
  // Redelivered (GossipSub's seen-cache expired, or another peer): recorded as received, ignored — the front
  // door's step sees the message in the `unique` map — and nothing else changed.
  const g2len = await gossipLen();
  const g2 = await router.p2pInbound("gossip", message);
  await router.settled();
  report.gossipAgain = [g2.verdict, g2.reason, (await gossipLen()) - g2len, eq(await persisted("gossip"), byGossip)];

  // The stock resolver: aggregated octet-stream answers, BEEF per output.
  const resolver = new LookupResolver({ networkPreset: "local", hostOverrides: { ls_demo: [base] } });
  const look = async (query: unknown) => {
    const a = await resolver.query({ service: "ls_demo", query }) as { type: string; outputs: Array<{ beef: number[]; outputIndex: number }> };
    const out = [];
    for (const o of a.outputs) {
      const tx = Transaction.fromBEEF(o.beef);
      let verifies: unknown;
      try { verifies = await tx.verify(tracker); } catch (e) {
        const walk = (t: Transaction): unknown => ({ id: t.id("hex"), mp: t.merklePath ? [t.merklePath.blockHeight, t.merklePath.computeRoot(t.id("hex"))] : null, ins: t.inputs.map((i) => i.sourceTransaction ? walk(i.sourceTransaction) : i.sourceTXID) });
        verifies = `${(e as Error).message} ${JSON.stringify(walk(tx))} roots ${JSON.stringify([...roots])} fund ${fundTxid}`;
      }
      out.push({ txid: tx.id("hex"), outputIndex: o.outputIndex, verifies });
    }
    return out;
  };
  const name = (txid: string) => txid === t1.id("hex") ? "t1" : txid === t2.id("hex") ? "t2" : "?";
  const t2 = new Transaction();
  t2.addInput({ sourceTransaction: t1, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(alice), sequence: 0xffffffff });
  t2.addOutput({ lockingScript: tokenScript(alice), satoshis: 1 });
  // (T2 pays no fee: nothing here broadcasts to the network, and SPV does not check fees.)
  await t2.sign();

  report.lookup1 = (await look({ topic: "tm_demo" })).map((o) => [name(o.txid), o.outputIndex, o.verifies]);
  const sh = createHash("sha256").update(Buffer.from(tokenScript(alice).toBinary())).digest("hex");
  report.byScript = (await look({ scriptHash: sh, topic: "tm_demo" })).map((o) => [name(o.txid), o.outputIndex]);
  // The plain JSON form too.
  const json = await (await fetch(`${base}/lookup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service: "ls_demo", query: { topic: "tm_demo" } }) })).json() as { type: string; outputs: Array<{ beef: number[]; outputIndex: number }> };
  report.lookupJson = { type: json.type, outputs: json.outputs.map((o) => [name(Transaction.fromBEEF(o.beef).id("hex")), o.outputIndex]) };

  // A resubmission is a dupe: nothing new.
  const dupe = await new HTTPSOverlayBroadcastFacilitator(fetch, true).send(base, { beef: t1.toBEEF(), topics: ["tm_demo", "tm_other"] });
  report.dupe = dupe;
  // #68: every request is an entry (an access log); only a write moves the state. Counted from here: the
  // requests the router forwards to the overlay, and the entries.
  const logLen = async () => { const k = (await router.hydrate("overlay")).kernel; return (await k.store.get((await k.tip())!) as unknown as { n: number }).n + 1; };
  const fwd = router as unknown as { forward(handle: string, ...rest: unknown[]): Promise<unknown> };
  const forward0 = fwd.forward.bind(router);
  let requests = 0;
  fwd.forward = async (handle, ...rest) => { if (handle === "overlay") requests++; return await forward0(handle, ...rest); };
  const stateOf = async () => { const k = (await router.hydrate("overlay")).kernel; return [String(await k.call("head", "wallet")), String(await k.call("head", "ls:ls_demo"))]; };
  const before = await logLen();
  const state0 = await stateOf();

  // #50: a submission no topic takes (T1's change paid on, no token, no previous coin) is decoded and judged in
  // the front door's step and refused there: 200 with the empty STEAK, the request recorded, nothing else
  // changed — the overlay's state (head `wallet`) and the lookup service's (head `ls:ls_demo`) where they were.
  // (Not held, so u1 below may still spend the same output.)
  const plain = new Transaction();
  plain.addInput({ sourceTransaction: t1, sourceOutputIndex: 1, unlockingScriptTemplate: new P2PKH().unlock(alice), sequence: 0xffffffff });
  plain.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 48_000 });
  await plain.sign();
  await router.settled();
  const lenBeforeRefused = await logLen();
  const refusedSubmit = await fetch(`${base}/submit`, { method: "POST", headers: { "x-topics": "tm_demo" }, body: new Uint8Array(plain.toBEEF()) });
  const refusedSteak = (await refusedSubmit.json()) as Record<string, { outputsToAdmit?: unknown[] }>;
  const refusedMessage = refusedSteak.tm_demo && Array.isArray(refusedSteak.tm_demo.outputsToAdmit) && refusedSteak.tm_demo.outputsToAdmit.length === 0 ? "empty-steak" : JSON.stringify(refusedSteak);
  await router.settled();
  report.refusedSubmit = [refusedSubmit.status, refusedMessage.split(":")[0], (await logLen()) - lenBeforeRefused, eq(await stateOf(), state0)];
  // The lookup service's own storage: its head, moved only by its hooks.
  report.lsHead = (await (await router.hydrate("overlay")).kernel.call("head", "ls:ls_demo")) != null;

  // T2 spends the token into a new one (X-Topics as a JSON array, Atomic BEEF): the old one is retained.
  const r2 = await fetch(`${base}/submit`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-topics": JSON.stringify(["tm_demo"]) }, body: new Uint8Array(t2.toAtomicBEEF()) });
  report.submit2 = await r2.json();
  report.lookup2 = (await look({ topic: "tm_demo" })).map((o) => [name(o.txid), o.outputIndex, o.verifies]);
  report.withSpent = (await look({ topic: "tm_demo", includeSpent: true })).map((o) => [name(o.txid), o.outputIndex]).sort();

  // Arcade says T2 was double spent (the status provider's message): its admittance vanishes, T1's token is live again.
  await router.settled();
  arcade.emit(t2.id("hex"), { txStatus: "DOUBLE_SPEND_ATTEMPTED" });
  await until("T2 rejected", async () => (await settledOf("overlay", [t2.id("hex")]))[0]![2] || undefined);
  await router.settled();
  report.afterReject = (await look({ topic: "tm_demo" })).map((o) => [name(o.txid), o.outputIndex, o.verifies]);
  // #57: T2's submission thread finished at admission; the status, by the subscription, rejected it: no longer awaiting.
  report.t2Settled = await settledOf("overlay", [t2.id("hex")]);
  // From here on only reads (a rejected resubmission, refusals, listings, a lookup, a dupe): the state stays.
  const state1 = await stateOf();
  const again = await fetch(`${base}/submit`, { method: "POST", headers: { "x-topics": "tm_demo" }, body: new Uint8Array(t2.toAtomicBEEF()) });
  const againSteak = (await again.json()) as Record<string, { outputsToAdmit?: unknown[] }>;
  report.resubmitRejected = [again.status, againSteak.tm_demo && againSteak.tm_demo.outputsToAdmit?.length === 0 ? "empty-steak" : JSON.stringify(againSteak)];

  // Refusals, listings, documentation.
  const bad = await fetch(`${base}/submit`, { method: "POST", headers: { "x-topics": "tm_demo" }, body: new Uint8Array([1, 2, 3]) });
  report.badBeef = [bad.status, ((await bad.json()) as { message?: string }).message];
  const unknown = await fetch(`${base}/lookup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service: "ls_nope", query: {} }) });
  report.unknownService = unknown.status;
  report.topics = await (await fetch(`${base}/listTopicManagers`)).json();
  report.lookups = await (await fetch(`${base}/listLookupServiceProviders`)).json();
  const doc = await fetch(`${base}/getDocumentationForTopicManager?manager=tm_demo`);
  report.doc = [doc.headers.get("content-type"), (await doc.text()).split("\n")[0]];
  await look({ topic: "tm_demo" });
  await fetch(`${base}/submit`, { method: "POST", headers: { "x-topics": "tm_demo" }, body: new Uint8Array(t1.toBEEF()) });
  await router.settled();
  // #65: the status provider's messages are entries too (signed messages, `local` requests): T2's RECEIVED and its double spend.
  const local = (await entriesSince("overlay", before)).filter((e) => e.transport === "local").length;
  report.readsWrite = [before, (await logLen()) - local, requests, eq(await stateOf(), state1), local];
  fwd.forward = forward0;

  // Merkle proofs as IPLD nodes (#29): three tokens mined in one block (4: a coinbase, u1, u2, u3), each
  // proven by its own BUMP in a proof event (out of order). The overlay keeps the tree's nodes, not the
  // paths; a lookup's BEEF carries each token's BUMP rebuilt from them, verified here by @bsv/sdk.
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
  // #57: each admitted (Arcade's RECEIVED) and awaiting its proof; posted once each.
  report.awaitingU = { state: await settledOf("overlay", us.map((u) => u.id("hex"))), posts: us.map((u) => posted(u.id("hex")).length) };
  const leaves = ["cc".repeat(32), ...us.map((u) => u.id("hex"))];
  report.leaves = leaves;
  const n01 = sha256d(Buffer.concat([internal(leaves[0]), internal(leaves[1])]));
  const n23 = sha256d(Buffer.concat([internal(leaves[2]), internal(leaves[3])]));
  report.nodes = [n01, n23].map((n) => Buffer.from(n).reverse().toString("hex"));
  report.root = Buffer.from(sha256d(Buffer.concat([n01, n23]))).reverse().toString("hex");
  const h4 = mine(prev, sha256d(Buffer.concat([n01, n23])), 1_790_000_000 + 4 * 600);
  headers.push(h4);
  roots.set(4, Buffer.from(h4.subarray(36, 68)).reverse().toString("hex"));
  await router.admitEvent("overlay", "chain", { kind: "header", raw: h4 });
  const disp = (b: Uint8Array) => Buffer.from(b).reverse().toString("hex");
  const bumpOf = (i: number) => new MerklePath(4, [
    [i ^ 1, i].sort().map((o) => o === i ? { offset: o, hash: leaves[o], txid: true } : { offset: o, hash: leaves[o] }),
    [{ offset: (i >> 1) ^ 1, hash: disp((i >> 1) ^ 1 ? n23 : n01) }],
  ]);
  const sent = new Map<string, string>();
  // #57, #65: Arcade's statuses over its SSE stream, through the host's broadcaster: SEEN_ON_NETWORK for each (a
  // status message), then MINED with its merkle path (out of order: a proof event in box `chain`).
  await until("the broadcaster's stream", async () => arcade.streams > 0 || undefined);
  await router.settled();
  const routed0 = router.arc!.stats.routed;
  for (const i of [1, 2, 3]) arcade.emit(leaves[i]!, { txStatus: "SEEN_ON_NETWORK" });
  const block4 = Buffer.from(sha256d(h4)).reverse().toString("hex");
  for (const i of [3, 1, 2]) {
    const bump = bumpOf(i);
    sent.set(leaves[i], bump.toHex());
    arcade.emit(leaves[i]!, { txStatus: "MINED", blockHash: block4, blockHeight: 4, merklePath: bump.toHex() });
  }
  await until("six statuses routed", async () => router.arc!.stats.routed >= routed0 + 6 || undefined);
  await router.settled();
  // Each token: admitted at its submit (Arcade's RECEIVED), SEEN left it pending, its proof proved it.
  report.settledBySse = await settledOf("overlay", leaves.slice(1));
  const answers = await resolver.query({ service: "ls_demo", query: { topic: "tm_demo" } }) as { outputs: Array<{ beef: number[]; outputIndex: number }> };
  const proofs: Array<[number, boolean, boolean]> = [];
  for (const o of answers.outputs) {
    const tx = Transaction.fromBEEF(o.beef);
    const i = leaves.indexOf(tx.id("hex"));
    if (i < 1) continue;
    let ok = false;
    try { ok = await tx.verify(tracker); } catch { ok = false; }
    // One aggregated answer: the rebuilt BUMPs of block 4 arrive merged (one per block, as BEEF does). Each
    // token is a txid-flagged leaf of it, and its path computes the header's root.
    const mp = tx.merklePath;
    const leaf = mp?.path[0].some((l) => l.hash === leaves[i] && l.txid === true) ?? false;
    proofs.push([i, leaf && mp!.blockHeight === 4 && mp!.computeRoot(leaves[i]) === roots.get(4), ok]);
  }
  report.merkle = proofs.sort((x, y) => x[0] - y[0]);
  // One token asked for alone: its answer carries its BUMP alone — rebuilt from the nodes, byte for byte the one sent.
  const alone: Array<[number, boolean, boolean]> = [];
  for (const i of [1, 2, 3]) {
    const a = await resolver.query({ service: "ls_demo", query: { txid: leaves[i], outputIndex: 0, topic: "tm_demo" } }) as { outputs: Array<{ beef: number[] }> };
    const tx = a.outputs.length === 1 ? Transaction.fromBEEF(a.outputs[0].beef) : undefined;
    let ok = false;
    try { ok = !!tx && await tx.verify(tracker); } catch { ok = false; }
    alone.push([i, tx?.merklePath?.toHex() === sent.get(leaves[i]), ok]);
  }
  report.merkleAlone = alone;

  // Chronicle script rules (#53): a Rúnar AMM pool spend (test/vectors/chronicle.json, from the amm-poc
  // fixtures — a copy of the SDK's wallet/vectors/chronicle.json, #75: the SDK is a URL+hash dependency now,
  // not a submodule, so this TS-only test keeps its own copy; refresh it here if the SDK's vector changes),
  // whose pool input executes OP_2MUL. Its funding and token deploy are mined in block 5 (a coinbase,
  // fund, token deploy, a filler); the BEEF carries the pool deploy and the sats-in swap unproven, so the front
  // door's call verifies every input's script, the pool's included. No topic here takes it: 200 with the empty
  // STEAK is a verified submission (before Chronicle bsvz refused OP_2MUL: 400 ScriptFailed). The same swap with
  // its funding signature broken is refused (400 ScriptFailed): the scripts are run.
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
  const cs = await fetch(`${base}/submit`, { method: "POST", headers: { "x-topics": "tm_demo" }, body: new Uint8Array(swap.toBEEF()) });
  const csSteak = (await cs.json()) as Record<string, { outputsToAdmit?: unknown[] }>;
  report.chronicle = [poolSpent, cs.status, csSteak.tm_demo && csSteak.tm_demo.outputsToAdmit?.length === 0 ? "empty-steak" : JSON.stringify(csSteak)];
  const broken = swapOf(chron.txs.swap_bsv_in!);
  const sig = broken.inputs[1]!.unlockingScript!.toBinary();
  sig[10] ^= 1;
  broken.inputs[1]!.unlockingScript = UnlockingScript.fromBinary(sig);
  const cb2 = await fetch(`${base}/submit`, { method: "POST", headers: { "x-topics": "tm_demo" }, body: new Uint8Array(broken.toBEEF()) });
  report.chronicleBroken = [cb2.status, ((await cb2.json()) as { message?: string }).message];

  // #57 (d): a mined submission — its BEEF carries its BUMP (block 6: a filler, then it) — is admitted with no POST.
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
  const mr = await fetch(`${base}/submit`, { method: "POST", headers: { "x-topics": "tm_demo" }, body: new Uint8Array(m.toBEEF()) });
  report.mined = { status: mr.status, steak: await mr.json(), posted: arcade.posts.length - postsBefore, state: (await settledOf("overlay", [m.id("hex")]))[0] };

  // #57 (b): Arcade refuses one (400: a REJECTED status): the transaction rejected, nothing admitted; the client gets 400 (BRC-22's error form).
  const x = new Transaction();
  x.addInput({ sourceTransaction: m, sourceOutputIndex: 1, unlockingScriptTemplate: new P2PKH().unlock(alice), sequence: 0xffffffff });
  x.addOutput({ lockingScript: tokenScript(alice), satoshis: 1 });
  x.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 47_000 });
  await x.sign();
  arcade.mode = "reject";
  const xr = await fetch(`${base}/submit`, { method: "POST", headers: { "x-topics": "tm_demo" }, body: new Uint8Array(x.toAtomicBEEF()) });
  arcade.mode = "ok";
  report.arcRejected = {
    status: xr.status, body: await xr.json(), posted: posted(x.id("hex")).length, state: (await settledOf("overlay", [x.id("hex")]))[0],
    live: (await look({ topic: "tm_demo", txid: x.id("hex"), outputIndex: 0 })).length,
  };

  // #57 (c), #66, #65: Arcade busy (503) on the gate instance: the host keeps the transaction queued, retrying; the
  // submission's thread waits, and so does the client, until the router's bound — 503 + Retry-After, nothing
  // admitted, the thread going on; a resubmission launches no second submission: it waits on the same thread, and
  // gets 503 again at the bound. Then Arcade takes it: two clients resubmit at once, the queue's next post is
  // taken — RECEIVED, admitted, the thread finished — and both get the STEAK: the same thread, the same answer.
  const gateBase = router.originOf("gate");
  const g = new Transaction();
  g.addInput({ sourceTransaction: fund, sourceOutputIndex: 1, unlockingScriptTemplate: new P2PKH().unlock(alice), sequence: 0xffffffff });
  g.addOutput({ lockingScript: tokenScript(alice), satoshis: 1 });
  g.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 9_000 });
  await g.sign();
  const gid = g.id("hex");
  const gateLen = async () => { const k = (await router.hydrate("gate")).kernel; return (await k.store.get((await k.tip())!) as unknown as { n: number }).n + 1; };
  const submitG = () => fetch(`${gateBase}/submit`, { method: "POST", headers: { "x-topics": "tm_demo" }, body: new Uint8Array(g.toBEEF()) });
  // The gate's submission threads: the overlay engine launched on a submit record.
  const submissions = async () => {
    const v = openStoreFile(gateDb, { readOnly: true });
    try {
      let n = 0;
      for await (const th of v.edges.query({ kind: "thread" })) if (((await v.get(th)) as unknown as { args?: { box?: string } }).args?.box === "submit") n++;
      return n;
    } finally { await v.close(); }
  };
  arcade.mode = "busy";
  const g1r = await submitG();
  const g2r = await submitG();
  const busy = {
    first: [g1r.status, g1r.headers.get("retry-after"), ((await g1r.json()) as { status?: string }).status],
    again: [g2r.status, g2r.headers.get("retry-after")], submissions: await submissions(),
    state: (await settledOf("gate", [gid]))[0], posts: posted(gid).length,
  };
  arcade.mode = "ok";
  const both = await Promise.all([submitG(), submitG()]);
  const ok = await Promise.all(both.map(async (r) => [r.status, await r.json()]));
  const retried = both.map((r) => r.status);
  const gateResolver = new LookupResolver({ networkPreset: "local", hostOverrides: { ls_demo: [gateBase] } });
  const gLive = await gateResolver.query({ service: "ls_demo", query: { topic: "tm_demo" } }) as { outputs: Array<{ beef: number[]; outputIndex: number }> };
  report.transient = {
    busy, steak: ok, statuses: retried, submissions: await submissions(), queued: router.arc!.queued().some((q) => q.txid === gid), posts: posted(gid).length,
    state: (await settledOf("gate", [gid]))[0], live: gLive.outputs.map((o) => [Transaction.fromBEEF(o.beef).id("hex") === gid, o.outputIndex]),
  };

  // #73: the fourth instance (no Arcade, no status provider in its address book): a token is broadcast
  // (the event is dropped — this host has no Arcade — a line in its log) and the submission's thread
  // rests, no status ever able to reach it; the client waits out the router's bound and gets 503,
  // nothing admitted. Its proof, fed directly (as headers are above, #73's own gate otherwise needs a
  // live Arcade to race): admits it — "with no status provider, nothing before the proof".
  await noarcRouter.listen(0);
  await noarcRouter.bootRow("noarc", { kind: "tree", root: src.root, objects: src.objects });
  const noarcBase = noarcRouter.originOf("noarc");
  // As `settledOf` above, over `noarcRouter` instead of `router`: [proven, still awaiting, rejected].
  const nMapKeys = async (name: string): Promise<Set<string>> => {
    const k = (await noarcRouter.hydrate("noarc")).kernel;
    const st = await k.store.get(await k.call("head", "wallet") as CID) as unknown as { maps: Record<string, CID | null> };
    const out = new Set<string>();
    const walk = async (c: CID | null | undefined): Promise<void> => {
      if (!c) return;
      const [left, es] = await k.store.get(c) as unknown as [CID | null, Array<[Uint8Array, CID, CID | null]>];
      await walk(left);
      for (const [key, , right] of es) { out.add(Buffer.from(key).toString("hex")); await walk(right); }
    };
    await walk(st.maps[name]);
    return out;
  };
  const nSettled = async (txid: string) => {
    const [proofs, awaiting, rejected] = await Promise.all(["proofs", "awaiting", "rejected"].map((m) => nMapKeys(m)));
    const k = internal(txid).toString("hex");
    return [proofs.has(k), awaiting.has(k), rejected.has(k)];
  };
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
  const nSub = await fetch(`${noarcBase}/submit`, { method: "POST", headers: { "x-topics": "tm_demo" }, body: new Uint8Array(nTok.toAtomicBEEF()) });
  await noarcRouter.settled();
  report.noProviderPending = { status: nSub.status, state: await nSettled(nTokId), live: await noarcLive() };
  const nFiller = "f7".repeat(32);
  const nH2 = mine(sha256d(nH1), sha256d(Buffer.concat([internal(nFiller), internal(nTokId)])), 1_790_010_600);
  const nPath = new MerklePath(2, [[{ offset: 0, hash: nFiller }, { offset: 1, hash: nTokId, txid: true }]]);
  await noarcRouter.admitEvent("noarc", "chain", { kind: "header", raw: nH2 });
  await noarcRouter.admitEvent("noarc", "chain", { kind: "proof", subject: txCid(nTokId), txid: nTokId, path: Uint8Array.from(nPath.toBinary()) });
  await noarcRouter.settled();
  report.noProviderProven = { state: await nSettled(nTokId), live: await noarcLive() };

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
// Three instances on three routers, each with a libp2p node (loopback TCP, bootstrapping each other):
// A (`ga`, with the host's Arcade, so a status provider) and B (`gb`, no Arcade: it admits at the proof)
// subscribe `tm_demo` and `tm_demo-proof`; C (`gc`) subscribes only `tm_demo-admit`. Every tree routes
// the three inbound topics to the overlay (`submit`, `peerAdmit`, `peerProof`).
const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});
const G = ["ga", "gb", "gc"] as const;
type GH = typeof G[number];
const gDb: Record<GH, string> = { ga: join(home, "instances/ga/runtime.db"), gb: join(home, "instances/gb/runtime.db"), gc: join(home, "instances/gc/runtime.db") };
const p2pOracle = new Oracle(new PrivateKey("a77e57", 16));
const gossipTree = (dir: string, topics: string[]) => {
  cpSync(sys, dir, { recursive: true });
  const c = JSON.parse(readFileSync(join(sys, "etc/config.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(join(dir, "etc/config.json"), JSON.stringify({ ...c, libp2p: { topics } }));
  const rs = JSON.parse(readFileSync(join(sys, "etc/routes.json"), "utf8")) as unknown[];
  writeFileSync(join(dir, "etc/routes.json"), JSON.stringify([...rs,
    { path: "libp2p:tm_demo-admit", program: "overlay", fn: "peerAdmit" },
    { path: "libp2p:tm_demo-proof", program: "overlay", fn: "peerProof" }]));
};
gossipTree(join(home, "system-gossip-ab"), ["tm_demo", "tm_demo-proof"]);
gossipTree(join(home, "system-gossip-c"), ["tm_demo-admit"]);
const g: Partial<Record<GH, { hdb: HostDb; r: Router }>> = {};
const arcade74 = await FakeArcade.start();
const gr = (h: GH) => g[h]!.r;
try {
  const ports: Record<GH, number> = { ga: await freePort(), gb: await freePort(), gc: await freePort() };
  const idOf = (h: GH) => peerIdOf(p2pOracle.peerKey(h)).toString();
  for (const h of G) {
    const hdb = new HostDb(join(home, `${h}-host.db`));
    hdb.add(h, { store: gDb[h] });
    g[h] = {
      hdb,
      r: new Router({
        db: hdb, walletFor: () => ephemeralWallet(key("1111")), home, owner, idleMs: 0,
        providerKeyFor: (n) => p2pOracle.providerKey(n), peerKeyFor: (x) => p2pOracle.peerKey(x), answerWaitMs: 6000,
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
  // (A node starts as its instance hydrates: until then, no subscribers.)
  const subscribers = (h: GH, topic: string) => ((gr(h).p2p?.node(h)?.services as { pubsub: { getSubscribers(t: string): unknown[] } } | undefined)?.pubsub.getSubscribers(topic).length ?? 0);
  for (const h of G) await gr(h).hydrate(h);
  await until("the three nodes see each other's topics", async () => (
    subscribers("ga", "tm_demo") > 0 && subscribers("ga", "tm_demo-proof") > 0
    && subscribers("ga", "tm_demo-admit") > 0 && subscribers("gb", "tm_demo-admit") > 0) || undefined);

  // Reading the instances: a map of the wallet state (key hex → value), the peer-admit records, the log length.
  const kOf = async (h: GH) => (await gr(h).hydrate(h)).kernel;
  const walk = async (h: GH, root: CID | null | undefined): Promise<Array<[string, unknown]>> => {
    const k = await kOf(h);
    const out: Array<[string, unknown]> = [];
    const go = async (c: CID | null | undefined): Promise<void> => {
      if (!c) return;
      const [left, es] = await k.store.get(c) as unknown as [CID | null, Array<[Uint8Array, unknown, CID | null]>];
      await go(left);
      for (const [kk, v, right] of es) { out.push([Buffer.from(kk).toString("hex"), v]); await go(right); }
    };
    await go(root);
    return out;
  };
  const gMap = async (h: GH, name: string) => {
    const k = await kOf(h);
    const st = await k.store.get(await k.call("head", "wallet") as CID) as unknown as { maps: Record<string, CID | null> };
    return new Map(await walk(h, st.maps[name]));
  };
  const peerAdmits = async (h: GH) => {
    const k = await kOf(h);
    const head = await k.call("head", "overlay:gossip") as CID | null;
    if (!head) return [];
    const st = await k.store.get(head) as unknown as { maps: { peerAdmits: CID | null } };
    const out: Array<{ kind: string; topic: string; txid: string; from: string; outputsToAdmit: number[]; coinsToRetain: number[] }> = [];
    for (const [, c] of await walk(h, st.maps.peerAdmits)) {
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
  const peerKeyHex = (h: GH) => p2pOracle.peerKey(h).toPublicKey().toString();

  // The chain: a funding transaction mined at 1 (second in its block), fed to all three.
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

  // (1) A submission over HTTP to A: admitted on Arcade's RECEIVED (A's status provider) → A publishes the
  // BEEF as received on `tm_demo` and its verdict on `tm_demo-admit`.
  const sub = await fetch(`${gr("ga").originOf("ga")}/submit`, { method: "POST", headers: { "x-topics": "tm_demo" }, body: new Uint8Array(gTok.toBEEF()) });
  report.g74submit = [sub.status, await sub.json()];
  // B gets the raw submission by gossip, judges it (its own identify), holds it and waits at its gate: no status
  // provider, so nothing is admitted before the proof.
  await until("B holds the gossiped submission, pending", async () => (await gMap("gb", "awaiting")).has(gKey) || undefined);
  await settleAll();
  report.g74bPending = { awaiting: (await gMap("gb", "awaiting")).has(gKey), applied: (await gMap("gb", "applied")).size, proven: (await gMap("gb", "proofs")).has(gKey) };
  // C, on `tm_demo-admit` only, records A's verdict: a peer-admit record, nothing admitted.
  await until("C records A's admit", async () => (await peerAdmits("gc")).length > 0 || undefined);
  report.g74cFirst = (await peerAdmits("gc")).map((r) => [r.kind, r.topic, r.txid === gTokId, r.from === peerKeyHex("ga"), r.outputsToAdmit, r.coinsToRetain]);

  // (2) The proof: block 2 mines the token (a filler, then it); the header to all three, the proof event to A
  // only (its chain feed). A records it and publishes `tm_demo-proof`; B checks the BUMP against its own headers,
  // admits the proof event, which steps its pending submission: admitted at the proof. B then publishes its own
  // `tm_demo-admit` (not `tm_demo`: it came by gossip; not the proof: it came by gossip) — C records B's admit too.
  const f2 = "f2".repeat(32);
  const gh2 = mine(sha256d(gh1), sha256d(Buffer.concat([internal(f2), internal(gTokId)])), 1_790_020_600);
  await header({ raw: gh2 });
  const path2 = new MerklePath(2, [[{ offset: 0, hash: f2 }, { offset: 1, hash: gTokId, txid: true }]]);
  await gr("ga").admitEvent("ga", "chain", { kind: "proof", subject: txCid(gTokId), txid: gTokId, path: Uint8Array.from(path2.toBinary()) });
  await until("B admits at the proof", async () => ((await gMap("gb", "applied")).size > 0 && (await gMap("gb", "proofs")).has(gKey)) || undefined);
  await until("C records B's admit", async () => (await peerAdmits("gc")).length > 1 || undefined);
  await settleAll();
  const proofBlock = async (h: GH) => String(((await gMap(h, "proofs")).get(gKey) as { block?: CID } | undefined)?.block);
  const bLive = await new LookupResolver({ networkPreset: "local", hostOverrides: { ls_demo: [gr("gb").originOf("gb")] } }).query({ service: "ls_demo", query: { topic: "tm_demo" } }) as { outputs: Array<{ beef: number[]; outputIndex: number }> };
  report.g74bAdmitted = {
    applied: (await gMap("gb", "applied")).size, awaiting: (await gMap("gb", "awaiting")).has(gKey),
    block: (await proofBlock("gb")) === blockCid(gh2), aBlock: (await proofBlock("ga")) === blockCid(gh2),
    live: bLive.outputs.map((o) => [Transaction.fromBEEF(o.beef).id("hex") === gTokId, o.outputIndex]),
  };
  report.g74cBoth = {
    froms: (await peerAdmits("gc")).map((r) => r.from).sort(), want: [peerKeyHex("ga"), peerKeyHex("gb")].sort(),
    cApplied: (await gMap("gc", "applied")).size,
  };

  // (3) A reorg: a heavier branch from 1 (2', 3') mines the token second in block 2'. All three take the run;
  // A gets the token's re-proof (its chain feed) and publishes `tm_demo-proof` again (a new block); B checks it
  // against its new headers and replaces the old proof.
  const f2b = "fb".repeat(32);
  const gh2b = mine(sha256d(gh1), sha256d(Buffer.concat([internal(f2b), internal(gTokId)])), 1_790_020_700);
  const gh3b = mine(sha256d(gh2b), sha256d(Buffer.from("filler 3b")), 1_790_021_300);
  await header({ raws: [gh2b, gh3b] });
  const path2b = new MerklePath(2, [[{ offset: 0, hash: f2b }, { offset: 1, hash: gTokId, txid: true }]]);
  await gr("ga").admitEvent("ga", "chain", { kind: "proof", subject: txCid(gTokId), txid: gTokId, path: Uint8Array.from(path2b.toBinary()) });
  await until("B takes the reorg's re-proof", async () => (await proofBlock("gb")) === blockCid(gh2b) || undefined);
  await settleAll();
  report.g74reorg = { a: (await proofBlock("ga")) === blockCid(gh2b), b: (await proofBlock("gb")) === blockCid(gh2b), bApplied: (await gMap("gb", "applied")).size };

  // (4) A bad BUMP on `tm_demo-proof` (a path claiming block 3', whose root is not that header's): ignore, not reject (it may be our
  // missing headers); only its request entry is written, nothing else moves.
  const mallory = key("7777");
  const badPath = new MerklePath(3, [[{ offset: 0, hash: "ba".repeat(32) }, { offset: 1, hash: gTokId, txid: true }]]);
  const bLen0 = await logLenOf("gb");
  const bWallet0 = await headOf("gb", "wallet");
  const bad = await gr("gb").p2pInbound("gb", await signed(mallory, "tm_demo-proof", dagCbor.encode({ txid: gTokId, blockHash: disp(sha256d(gh3b)), blockHeight: 3, bump: Uint8Array.from(badPath.toBinary()) }), 1n));
  await settleAll();
  report.g74badProof = [bad.verdict, bad.reason, (await logLenOf("gb")) - bLen0, (await headOf("gb", "wallet")) === bWallet0, (await proofBlock("gb")) === blockCid(gh2b)];

  // (5) Late duplicates on `tm_demo`: the same BEEF from another publisher (a message GossipSub never saw) is
  // decoded, looked up, "already judged" — no topic manager runs (programs/overlay test.zig counts the calls);
  // A's own message redelivered past the seen-cache is the same record, already admitted: nothing runs at all.
  const bLen1 = await logLenOf("gb");
  const late = await gr("gb").p2pInbound("gb", await signed(mallory, "tm_demo", new Uint8Array(gTok.toBEEF()), 2n));
  await settleAll();
  const kb = await kOf("gb");
  let original: { topic: string; from: Uint8Array; seqno: Uint8Array; signature: Uint8Array; body: Uint8Array } | undefined;
  for (let c = await kb.tip(); c;) {
    const e = await kb.store.get(c) as unknown as { request?: CID; transport?: string; prev?: CID };
    if (e.request && e.transport === "libp2p") {
      const rec = await kb.store.get(e.request) as unknown as { kind: string; topic: string; from: Uint8Array; seqno: Uint8Array; signature: Uint8Array; body: Uint8Array };
      if (rec.kind === "p2p" && rec.topic === "tm_demo" && Buffer.from(rec.from).equals(Buffer.from(peerIdOf(p2pOracle.peerKey("ga")).toMultihash().bytes))) original = rec;
    }
    c = e.prev;
  }
  const again = original ? await gr("gb").p2pInbound("gb", { transport: "libp2p", topic: original.topic, from: original.from, seqno: original.seqno, signature: original.signature, body: original.body }) : undefined;
  await settleAll();
  report.g74late = {
    late: [late.verdict, late.reason], redelivered: again ? [again.verdict, again.reason] : "A's message not found in B's log",
    entries: (await logLenOf("gb")) - bLen1, wallet: (await headOf("gb", "wallet")) === bWallet0,
  };
  report.g74ok = true;
} catch (e) {
  report.g74error = (e as Error).stack ?? String(e);
}
for (const h of G) if (g[h]) { await g[h]!.r.stop(); g[h]!.hdb.close(); }
await arcade74.close();

// #42 (decided 2026-09-30): the merkle nodes the BUMPs revealed are kept 64-byte bitcoin-tx blocks that
// contribute no edges (nor does the header): no token is a `child` edge target, and no edge in the map is
// `child` / `prev` / `merkleroot`. The nodes still link forward: the root's two children, n23's two
// tokens. The TS reader derives the kernel's edges map key for key.
if (report.ok === true) {
  const v = openStoreFile(db, { readOnly: true });
  const d = await derive(v);
  const children: boolean[] = [];
  const leaves = report.leaves as string[];
  const [n01, n23] = report.nodes as string[];
  for (const i of [1, 2, 3]) children.push((await v.edges.refsTo(txCid(leaves[i]!))).some((x) => x.rel === "child"));
  const fwd = async (c: string) => (await v.edges.refsFrom(txCid(c))).map((x) => [x.rel, x.locator, String(x.to)].join(" "));
  const forward = eq(await fwd(report.root as string), [["child", "0", String(txCid(n01))].join(" "), ["child", "1", String(txCid(n23))].join(" ")])
    && eq(await fwd(n23), [["child", "0", String(txCid(leaves[2]!))].join(" "), ["child", "1", String(txCid(leaves[3]!))].join(" ")]);
  const noNodeEdges = d.pairs.edges.every(([, x]) => !["child", "prev", "merkleroot"].includes((x as [string])[0]));
  report.edges = { sameRoot: String(buildTree(d.pairs.edges).root) === String((v as unknown as { state(): { roots: { edges: CID } } }).state().roots.edges), children, noNodeEdges, forward };
  await v.close();
}

process.stdout.write("== overlay services (#36)\n");
check(report.ok === true, `the scenario ran${report.error ? `: ${report.error}` : ""}`);
check(eq(report.submit1, { status: "success", steak: { tm_demo: { outputsToAdmit: [0], coinsToRetain: [], coinsRemoved: [] } } }), `TopicBroadcaster → POST /submit: the token admitted (${JSON.stringify(report.submit1)})`);
check(eq(report.posted1, [true]), `#57, #65: the step broadcast the token transaction (an event); the host posted it to Arcade (Extended Format) before it was admitted (${JSON.stringify(report.posted1)})`);
{
  const g = report.gossip as { verdict: string; appended: number; boxes: string[]; applied: number; admitted: number; same: boolean; posts: number } | undefined;
  check(g?.verdict === "accept" && g.appended === 1 && eq(g.boxes, ["libp2p:tm_demo:p2p", "submit:submit"]) && g.applied === 1 && g.admitted === 1 && g.same, `#57, #68: the same transaction as a GossipSub message on \`libp2p:tm_demo\` (the same submit fn): one entry, the message as received; accept, its step admitting the \`p2p\` event then the handler's submit event; and the store holds the same applied / admitted records (but for their step times), byTopic map and lookup storage as POST /submit produced (${JSON.stringify(g)})`);
  check(g?.posts === 2, `#57: the pubsub submission went through the same broadcast gate: its step broadcast it too, and it was admitted on Arcade's duplicate answer (${JSON.stringify(g?.posts)} posts of it)`);
  check(eq(report.gossipAgain, ["ignore", "already admitted", 1, true]), `#57, #68: the message redelivered: recorded as received (one entry), ignored (its record in the \`unique\` map), nothing else changed (${JSON.stringify(report.gossipAgain)})`);
}
check(eq(report.lookup1, [["t1", 0, true]]), `LookupResolver → POST /lookup (aggregated): the token, its BEEF verifying against the headers (${JSON.stringify(report.lookup1)})`);
check(eq(report.byScript, [["t1", 0]]), `a lookup by script hash (${JSON.stringify(report.byScript)})`);
check(eq(report.lookupJson, { type: "output-list", outputs: [["t1", 0]] }), `the JSON answer form (${JSON.stringify(report.lookupJson)})`);
check(eq(report.dupe, { tm_demo: { outputsToAdmit: [0], coinsToRetain: [], coinsRemoved: [] } }), `#57: a resubmission appends nothing and answers the STEAK from the state (what was admitted); an unserved topic is left out (${JSON.stringify(report.dupe)})`);
check(eq(report.refusedSubmit, [200, "empty-steak", 1, true]), `#50, #68: a submission no topic takes answers 200 with the empty STEAK (BRC-22) from the front door's step: the refusal recorded (its request, one entry) and nothing else changed — the overlay's and the lookup service's heads where they were (${JSON.stringify(report.refusedSubmit)})`);
check(report.lsHead === true, `#50: ls_demo keeps its own storage under the head ls:ls_demo, and answers the lookups from it`);
check(eq(report.submit2, { tm_demo: { outputsToAdmit: [0], coinsToRetain: [0], coinsRemoved: [] } }), `the spend: a new token admitted, the old retained (${JSON.stringify(report.submit2)})`);
check(eq(report.lookup2, [["t2", 0, true]]) && eq(report.withSpent, [["t1", 0], ["t2", 0]]), `the live set moves to the new token; the old one stays for history (${JSON.stringify([report.lookup2, report.withSpent])})`);
check(eq(report.afterReject, [["t1", 0, true]]), `a status message (the status provider's) rejects the spend: its admittance vanishes, the consumed token is restored (${JSON.stringify(report.afterReject)})`);
check(eq(report.t2Settled, [[false, false, true]]), `#57: DOUBLE_SPEND_ATTEMPTED after admission, through the status subscription (#66: the submission's thread finished at admission): rejected, no longer awaiting (${JSON.stringify(report.t2Settled)})`);
check(Array.isArray(report.resubmitRejected) && report.resubmitRejected[0] === 200 && report.resubmitRejected[1] === "empty-steak", `a rejected transaction admits nothing on resubmission (200, empty STEAK) (${JSON.stringify(report.resubmitRejected)})`);
check(Array.isArray(report.badBeef) && report.badBeef[0] === 400 && report.unknownService === 400, `refusals: a bad BEEF, an unknown service (${JSON.stringify([report.badBeef, report.unknownService])})`);
check(eq(report.topics, { tm_demo: { name: "tm_demo", shortDescription: "Demo tokens: outputs whose script starts <\"tm_demo\"> OP_DROP." } }) && (report.lookups as Record<string, unknown>)?.ls_demo !== undefined, `the listings, from the program records (${JSON.stringify([report.topics, report.lookups])})`);
check(Array.isArray(report.doc) && String(report.doc[0]).startsWith("text/markdown"), `documentation (${JSON.stringify(report.doc)})`);
{
  const [b, a, n, still, local] = (report.readsWrite ?? []) as [number, number, number, boolean, number];
  // #68: between the two counts, every request the router forwarded is one entry (#65: besides the status
  // provider's two messages about T2, its RECEIVED and its double spend, counted apart);
  // the reads after the last write — a rejected resubmission, refusals, listings, a lookup, a dupe — moved no state.
  check(n > 10 && a === b + n && local === 2 && still === true, `every request is an entry (${n} requests: ${b} → ${a}, and ${local} status messages); the reads moved nothing (${still})`);
}

check(eq(report.awaitingU, { state: [[false, true, false], [false, true, false], [false, true, false]], posts: [1, 1, 1] }), `#57: three unproven tokens, each posted once and admitted on Arcade's RECEIVED (each submission's thread finished then, #66), each awaiting its proof (${JSON.stringify(report.awaitingU)})`);
check(eq(report.settledBySse, [[true, false, false], [true, false, false], [true, false, false]]), `#57, #65: Arcade's SEEN_ON_NETWORK (status messages) then MINED (proof events, with merkle paths) over its SSE stream, routed by the host's broadcaster: proven, no longer awaiting (${JSON.stringify(report.settledBySse)})`);
check(eq(report.merkle, [[1, true, true], [2, true, true], [3, true, true]]), `three tokens of one block, proven by separate BUMPs (out of order): each lookup answer carries the BUMPs rebuilt from the stored merkle nodes (merged per block), each leaf computing the header root, verified by @bsv/sdk (${JSON.stringify(report.merkle)})`);
check(eq(report.merkleAlone, [[1, true, true], [2, true, true], [3, true, true]]), `each token alone: its BUMP rebuilt from the tree is byte for byte the one its proof event carried, verified by @bsv/sdk (${JSON.stringify(report.merkleAlone)})`);
check(eq(report.chronicle, [true, 200, "empty-steak"]), `#53: a Rúnar AMM pool spend (its pool input executes OP_2MUL) verifies under Chronicle rules in the front door's call: 200, the empty STEAK, no topic here taking it (${JSON.stringify(report.chronicle)})`);
check(Array.isArray(report.chronicleBroken) && report.chronicleBroken[0] === 400 && String(report.chronicleBroken[1]).includes("ScriptFailed"), `#53: the same swap with its funding signature broken is refused, 400 ScriptFailed (${JSON.stringify(report.chronicleBroken)})`);
check(eq(report.mined, { status: 200, steak: { tm_demo: { outputsToAdmit: [0], coinsToRetain: [], coinsRemoved: [] } }, posted: 0, state: [true, false, false] }), `#57: a mined submission (its BEEF proves it) is admitted with no POST to Arcade, and awaits nothing (${JSON.stringify(report.mined)})`);
{
  const x = report.arcRejected as { status: number; body: { status?: string; message?: string }; posted: number; state: boolean[]; live: number } | undefined;
  check(x?.status === 400 && x.body.status === "error" && x.body.message === "Transaction rejected: REJECTED" && x.posted === 1 && eq(x.state, [false, false, true]) && x.live === 0, `#57: Arcade's 400 (a REJECTED status): the transaction rejected, nothing admitted; the client gets 400 {status: "error", message} (${JSON.stringify(x)})`);
}
{
  const t = report.transient as { busy: { first: unknown[]; again: unknown[]; submissions: number; state: boolean[]; posts: number }; steak: unknown[]; statuses: number[]; submissions: number; queued: boolean; posts: number; state: boolean[]; live: unknown[] } | undefined;
  const steak = { tm_demo: { outputsToAdmit: [0], coinsToRetain: [], coinsRemoved: [] } };
  check(!!t && eq(t.busy.first, [503, "5", "error"]) && eq(t.busy.state, [false, true, false]) && t.busy.posts >= 1, `#57, #66, #65: Arcade's 503: the host keeps it queued; nothing admitted; the client waited on the submission's thread until the router's bound, 503 + Retry-After; the transaction held and awaiting (${JSON.stringify(t?.busy)})`);
  check(!!t && eq(t.busy.again, [503, "5"]) && t.busy.submissions === 1, `#66: a resubmission while pending launches no second submission: it waits on the same thread, 503 again at the bound (${JSON.stringify(t?.busy)})`);
  check(!!t && eq(t.steak, [[200, steak], [200, steak]]) && t.submissions === 1 && !t.queued && t.posts >= 2 && eq(t.state, [false, true, false]) && eq(t.live, [[true, 0]]), `#57, #66, #65: Arcade takes it: the queue's next post — RECEIVED, admitted, finished, off the queue; two clients waiting on it both get the STEAK from the state (${JSON.stringify(t)})`);
}
{
  const p = report.noProviderPending as { status: number; state: boolean[]; live: number } | undefined;
  check(!!p && p.status === 503 && eq(p.state, [false, true, false]) && p.live === 0, `#73: a fourth instance with no Arcade (no status provider seeded in its address book): the submission is broadcast (the event dropped — this host has no Arcade to post it to) and left pending; the client waited out the router's bound, 503; nothing admitted (${JSON.stringify(p)})`);
  const v = report.noProviderProven as { state: boolean[]; live: number } | undefined;
  check(!!v && eq(v.state, [true, false, false]) && v.live === 1, `#73: its proof, fed directly (as the headers are, #73's own gate otherwise needs a status that can never arrive here): admits it — "status" with no provider subscribed is exactly "nothing before the proof" (${JSON.stringify(v)})`);
}
check(eq(report.edges, { sameRoot: true, children: [false, false, false], noNodeEdges: true, forward: true }), `#42: kept merkle nodes and headers contribute no edges (no token is a \`child\` edge target), the nodes still link forward to their children; the TS reader derives the kernel's edges map, same root (${JSON.stringify(report.edges)})`);

process.stdout.write("== overlay gossip (#74)\n");
check(report.g74ok === true, `the gossip scenario ran${report.g74error ? `: ${report.g74error}` : ""}`);
check(eq(report.g74submit, [200, { tm_demo: { outputsToAdmit: [0], coinsToRetain: [], coinsRemoved: [] } }]), `A: POST /submit admitted on Arcade's RECEIVED (its status provider) (${JSON.stringify(report.g74submit)})`);
check(eq(report.g74bPending, { awaiting: true, applied: 0, proven: false }), `A re-published the raw submission on \`tm_demo\`: B (no status provider) judged it by gossip, holds it and waits at its gate — nothing admitted before the proof (${JSON.stringify(report.g74bPending)})`);
check(eq(report.g74cFirst, [["peer-admit", "tm_demo", true, true, [0], []]]), `A's verdict on \`tm_demo-admit\` (STEAK + txid, no BEEF): C records it as a peer-admit record from A's peer key under its head overlay:gossip (${JSON.stringify(report.g74cFirst)})`);
check(eq(report.g74bAdmitted, { applied: 1, awaiting: false, block: true, aBlock: true, live: [[true, 0]] }), `A recorded the proof (its chain feed) and published \`tm_demo-proof\`; B checked the BUMP against its own headers, recorded it, and admitted at the proof (its lookup answers the token) (${JSON.stringify(report.g74bAdmitted)})`);
{
  const c = report.g74cBoth as { froms: string[]; want: string[]; cApplied: number } | undefined;
  check(!!c && eq(c.froms, c.want) && c.cApplied === 0, `B published its own admit: C holds A's and B's peer-admits, and admitted nothing itself (${JSON.stringify(c)})`);
}
check(eq(report.g74reorg, { a: true, b: true, bApplied: 1 }), `a reorg (2', 3' heavier, the token second in 2'): A's re-proof published again (a new block); B checked it against its new headers and replaced the old proof (${JSON.stringify(report.g74reorg)})`);
check(eq(report.g74badProof, ["ignore", "the bump's root is not our header's merkle root", 1, true, true]), `a bad BUMP on \`tm_demo-proof\`: ignore (not reject), only its request entry written, B's state where it was (${JSON.stringify(report.g74badProof)})`);
{
  const l = report.g74late as { late: unknown[]; redelivered: unknown; entries: number; wallet: boolean } | undefined;
  check(!!l && eq(l.late, ["ignore", "already judged"]) && eq(l.redelivered, ["ignore", "already admitted"]) && l.entries === 2 && l.wallet, `late duplicates on \`tm_demo\`: the same BEEF from another publisher is "already judged" (one decode, one lookup, no topic manager); A's message redelivered is "already admitted" (nothing runs); each one request entry, the state unchanged (${JSON.stringify(l)})`);
}

const r = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), db], { encoding: "utf8" });
process.stdout.write(r.stdout);
if (r.status !== 0) process.stdout.write(r.stderr);
check(r.status === 0 && /identical .*the source store reproduced exactly/.test(r.stdout), "the store replays to itself exactly");
const rg = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), gossipDb], { encoding: "utf8" });
process.stdout.write(rg.stdout);
if (rg.status !== 0) process.stdout.write(rg.stderr);
check(rg.status === 0 && /identical .*the source store reproduced exactly/.test(rg.stdout), "#57: the gossip instance's store (its `p2p` and submit entries) replays to itself exactly");
const rt = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), gateDb], { encoding: "utf8" });
process.stdout.write(rt.stdout);
if (rt.status !== 0) process.stdout.write(rt.stderr);
check(rt.status === 0 && /identical .*the source store reproduced exactly/.test(rt.stdout), "#57: the gate instance's store (its waits on Arcade, its RECEIVED) replays to itself exactly");
const rn = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), noarcDb], { encoding: "utf8" });
process.stdout.write(rn.stdout);
if (rn.status !== 0) process.stdout.write(rn.stderr);
check(rn.status === 0 && /identical .*the source store reproduced exactly/.test(rn.stdout), "#73: the no-Arcade instance's store (its 503, its proof fed directly) replays to itself exactly");
for (const h of G) {
  if (report.g74ok !== true) break;
  const rg74 = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), gDb[h]], { encoding: "utf8" });
  process.stdout.write(rg74.stdout);
  if (rg74.status !== 0) process.stdout.write(rg74.stderr);
  check(rg74.status === 0 && /identical .*the source store reproduced exactly/.test(rg74.stdout), `#74: ${h}'s store (its gossip: publishes and their answers, peers' messages) replays to itself exactly`);
}

if (process.env.KEEP) process.stdout.write(`kept ${home}\n`); else rmSync(home, { recursive: true, force: true });
process.stdout.write(failures ? `overlay: ${failures} FAILED\n` : "overlay: all ok\n");
process.exit(failures ? 1 : 0);

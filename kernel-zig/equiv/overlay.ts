// Overlay services in the VM (issue #36) end to end on the Zig kernel,
// served by the instance's own front door (#40: etc/routes.json names the
// overlay engine's route handlers; the router only proxies to the instance's
// origin) to the stock @bsv/sdk overlay clients: an instance booted from a
// system tree (#4) whose bin/ holds the front door, the overlay engine, the
// tm_demo topic and the ls_demo lookup (programs/overlay), its config naming
// them (#50: ls_demo listening to tm_demo, keeping its own index through its
// hooks). A submit is the one write (decoded once and judged in the front
// door's call; an entry admitted, then its STEAK read back); a lookup, a dupe,
// a refused BEEF and a submission no topic takes write nothing — the last
// leaves the store file byte-identical. Headers are fed as plain
// `header` entries (a regtest chain from its genesis, the funding mined at
// height 1); a token transaction is broadcast with TopicBroadcaster (POST
// /submit, SHIP's wire form) and found with LookupResolver (POST /lookup,
// the aggregated octet-stream form) — its BEEF verifies against the headers;
// the token is spent into a new one (the old retained for history); then a
// `status` entry rejects the spend and the first token is live again. The
// listings and documentation routes answer from the program records. Then
// merkle proofs as IPLD nodes (#29): three tokens mined in one block, proven
// by separate BUMPs in status entries (out of order); the lookup answers carry
// BUMPs rebuilt from the stored nodes, which @bsv/sdk verifies (one token
// alone: byte for byte the BUMP it was sent). The store then replays to
// itself exactly (equiv/replays.ts). Chronicle (#53): a Rúnar AMM pool spend
// (its pool input executes OP_2MUL) verifies in the front door's call.
// One submit, every transport (#57): a second instance from the same tree gets
// the same token transaction as a signed GossipSub message on its
// `libp2p:tm_demo` route (the same `submit` fn), through the router's
// p2pInbound; its store then holds the same `applied` / `admitted` records
// (but for each step's own time), `byTopic` map and lookup storage as the
// POST /submit path produced, and a
// redelivery of the message writes nothing (the store file byte-identical).
// The broadcast gate (#57), against the host's broadcaster (#58) in front of a
// fake Arcade (src/host/fake-arcade.ts): every unproven submission is posted
// to Arcade (Extended Format) by the step and admitted only once Arcade takes
// it — the GossipSub one too (Arcade's duplicate answer); the three tokens'
// SEEN and MINED statuses (with their merkle paths) come back over Arcade's
// SSE stream to their awaiting threads, which prove them; a resubmission
// answers the STEAK from the state; a mined submission (its BEEF proves it)
// is admitted with no POST; Arcade's 400 rejects one (400, nothing
// admitted). A third instance, re-asking every 1.5 s, gets Arcade's 503: the
// client is answered 503 + Retry-After with nothing admitted, a resubmission
// appends nothing and gets 503 again, and the deadline's re-ask (404: never
// taken) posts it again — admitted, and the retrying client gets the STEAK.
// All three stores replay to themselves exactly.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/overlay.ts

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HTTPSOverlayBroadcastFacilitator, LookupResolver, MerklePath, P2PKH, PrivateKey, Script, TopicBroadcaster, Transaction, UnlockingScript, Utils, type ChainTracker } from "@bsv/sdk";
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
// No walletArc: the host names its broadcast route (#58). Re-asked hourly here: no deadline wakes during the run.
const config = (recheckMs: string) => JSON.stringify({ defaults: { walletNetwork: "regtest", overlayRecheckMs: recheckMs, overlayTopics: JSON.stringify({ tm_demo: "topic-demo" }), overlayLookups: JSON.stringify({ ls_demo: { program: "lookup-demo", topics: ["tm_demo"] } }) } });
writeFileSync(join(sys, "etc/config.json"), config("3600000"));
writeFileSync(join(sys, "etc/subscriptions.json"), JSON.stringify([{ box: "submit", handler: "overlay" }, { box: "chain", handler: "overlay" }]));
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
// #57: the same node re-asking its broadcaster every 1.5 s (the transient-failure case).
const sys2 = join(home, "system-gate");
cpSync(sys, sys2, { recursive: true });
writeFileSync(join(sys2, "etc/config.json"), config("1500"));

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
// #57: the transient-failure case, on a node re-asking every 1.5 s.
const gateDb = join(home, "instances/gate/runtime.db");
hostDb.add("gate", { store: gateDb });
const owner = key("2222").toPublicKey().toString();
// The host's Arcade (#58): the overlay's step posts through the router's /arc route; statuses come back over SSE.
const arcade = await FakeArcade.start();
const posted = (txid: string) => arcade.posts.filter((b) => FakeArcade.txOf(b).id("hex") === txid);
const router = new Router({
  db: hostDb, walletFor: () => ephemeralWallet(key("1111")), home, owner, idleMs: 0, attestKey: new Oracle(new PrivateKey("a77e57", 16)).attestKey(),
  kernel: { command: kernel, env: { SKEIN_HOME: home } },
  arc: { url: arcade.url, token: "the-host-arcade-token", events: arcade.eventsUrl },
  log: (s, l) => { if (process.env.VERBOSE) process.stdout.write(`  | [${s}] ${l}\n`); },
});
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

try {
  // Listening first: a genesis names the router's broadcast route (its port) as walletArc.
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
  // #57: the step posted it to Arcade through the host's route before admitting it: once, in Extended Format.
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
  const byHttp = await persisted("overlay");
  const byGossip = await persisted("gossip");
  // The entries the call appended: the `p2p` event, then the submit event (box `submit`), in that order.
  const gk = (await router.hydrate("gossip")).kernel;
  const boxes: string[] = [];
  for (let c = await gk.tip(), i = 0; c && i < lenAfter - lenBefore; i++) {
    const e = await gk.store.get(c) as unknown as { box?: string; event?: CID; prev?: CID };
    if (e.event) boxes.unshift(`${e.box}:${(await gk.store.get(e.event) as unknown as { kind: string }).kind}`);
    c = e.prev;
  }
  const { times: httpTimes, ...httpState } = byHttp;
  const { times: gossipTimes, ...gossipState } = byGossip;
  report.gossip = {
    // #57: the same gate — the gossip instance's step posted it too (Arcade answered its duplicate's status).
    verdict: g1.verdict, boxes, posts: posted(t1.id("hex")).length, applied: httpState.applied.length, admitted: httpState.admitted.length,
    same: eq(httpState, gossipState), times: [httpTimes, gossipTimes], ...(eq(httpState, gossipState) ? {} : { httpState, gossipState }),
  };
  // Redelivered (GossipSub's seen-cache expired, or another peer): nothing written, not a byte.
  const gossipBytes = () => createHash("sha256").update(readFileSync(gossipDb)).update(existsSync(`${gossipDb}-wal`) ? readFileSync(`${gossipDb}-wal`) : new Uint8Array()).digest("hex");
  const gb = gossipBytes();
  const g2 = await router.p2pInbound("gossip", message);
  await router.settled();
  report.gossipAgain = [g2.verdict, gossipBytes() === gb];

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
  // Reads write nothing: the lookups above, the dupe; so do the refusals below.
  const logLen = async () => { const k = (await router.hydrate("overlay")).kernel; return (await k.store.get((await k.tip())!) as unknown as { n: number }).n + 1; };
  const before = await logLen();

  // #50: a submission no topic takes (T1's change paid on, no token, no previous coin) is decoded and judged in
  // the front door's call and refused there: no entry, and the store — the SQLite file and its WAL — is byte for
  // byte what it was. (Not held, so u1 below may still spend the same output.)
  const storeBytes = () => createHash("sha256").update(readFileSync(db)).update(existsSync(`${db}-wal`) ? readFileSync(`${db}-wal`) : new Uint8Array()).digest("hex");
  const plain = new Transaction();
  plain.addInput({ sourceTransaction: t1, sourceOutputIndex: 1, unlockingScriptTemplate: new P2PKH().unlock(alice), sequence: 0xffffffff });
  plain.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 48_000 });
  await plain.sign();
  await router.settled();
  const bytesBefore = storeBytes();
  const refusedSubmit = await fetch(`${base}/submit`, { method: "POST", headers: { "x-topics": "tm_demo" }, body: new Uint8Array(plain.toBEEF()) });
  const refusedSteak = (await refusedSubmit.json()) as Record<string, { outputsToAdmit?: unknown[] }>;
  const refusedMessage = refusedSteak.tm_demo && Array.isArray(refusedSteak.tm_demo.outputsToAdmit) && refusedSteak.tm_demo.outputsToAdmit.length === 0 ? "empty-steak" : JSON.stringify(refusedSteak);
  await router.settled();
  report.refusedSubmit = [refusedSubmit.status, refusedMessage.split(":")[0], storeBytes() === bytesBefore];
  // The lookup service's own storage: its head, moved only by its hooks.
  report.lsHead = (await (await router.hydrate("overlay")).kernel.call("head", "ls:ls_demo")) != null;

  // T2 spends the token into a new one (X-Topics as a JSON array, Atomic BEEF): the old one is retained.
  const r2 = await fetch(`${base}/submit`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-topics": JSON.stringify(["tm_demo"]) }, body: new Uint8Array(t2.toAtomicBEEF()) });
  report.submit2 = await r2.json();
  report.lookup2 = (await look({ topic: "tm_demo" })).map((o) => [name(o.txid), o.outputIndex, o.verifies]);
  report.withSpent = (await look({ topic: "tm_demo", includeSpent: true })).map((o) => [name(o.txid), o.outputIndex]).sort();

  // ARC says T2 was double spent (a plain status entry for its CID): its admittance vanishes, T1's token is live again.
  await router.admitEvent("overlay", "chain", { kind: "status", subject: txCid(t2.id("hex")), txid: t2.id("hex"), txStatus: "DOUBLE_SPEND_ATTEMPTED" });
  await router.settled();
  report.afterReject = (await look({ topic: "tm_demo" })).map((o) => [name(o.txid), o.outputIndex, o.verifies]);
  // #57: the status stepped T2's awaiting thread (admitted, then rejected): no longer awaiting, rejected.
  report.t2Settled = await settledOf("overlay", [t2.id("hex")]);
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
  report.readsWrite = [before, await logLen()];

  // Merkle proofs as IPLD nodes (#29): three tokens mined in one block (4: a coinbase, u1, u2, u3), each
  // proven by its own BUMP in a status entry (out of order). The overlay keeps the tree's nodes, not the
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
  // #57: each admitted (Arcade took it) and awaiting its status; posted once each.
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
  // #57: Arcade's statuses over its SSE stream, through the host's broadcaster to each token's awaiting thread:
  // SEEN_ON_NETWORK for each, then MINED with its merkle path (out of order).
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
  // Each token's thread: admitted at its submit (Arcade's 202), SEEN left it pending, MINED proved it and ended it.
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

  // Chronicle script rules (#53): a Rúnar AMM pool spend (wallet-zig/vectors/chronicle.json, from the amm-poc
  // fixtures), whose pool input executes OP_2MUL. Its funding and token deploy are mined in block 5 (a coinbase,
  // fund, token deploy, a filler); the BEEF carries the pool deploy and the sats-in swap unproven, so the front
  // door's call verifies every input's script, the pool's included. No topic here takes it: 200 with the empty
  // STEAK is a verified submission (before Chronicle bsvz refused OP_2MUL: 400 ScriptFailed). The same swap with
  // its funding signature broken is refused (400 ScriptFailed): the scripts are run.
  const chron = JSON.parse(readFileSync(join(here, "../../wallet-zig/vectors/chronicle.json"), "utf8")) as { txs: Record<string, string> };
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

  // #57 (b): Arcade refuses one (400): the transaction rejected, nothing admitted; the client gets 400 (BRC-22's error form).
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

  // #57 (c): Arcade busy (503) on the gate instance (re-asking every 1.5 s): the client is told 503 + Retry-After,
  // nothing admitted; a resubmission appends nothing and gets 503 again; at the deadline the thread re-asks (404:
  // Arcade never took it) and posts again — accepted, admitted; the retrying client then gets the STEAK.
  const gateBase = router.originOf("gate");
  const g = new Transaction();
  g.addInput({ sourceTransaction: fund, sourceOutputIndex: 1, unlockingScriptTemplate: new P2PKH().unlock(alice), sequence: 0xffffffff });
  g.addOutput({ lockingScript: tokenScript(alice), satoshis: 1 });
  g.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 9_000 });
  await g.sign();
  const gid = g.id("hex");
  const gateLen = async () => { const k = (await router.hydrate("gate")).kernel; return (await k.store.get((await k.tip())!) as unknown as { n: number }).n + 1; };
  const submitG = () => fetch(`${gateBase}/submit`, { method: "POST", headers: { "x-topics": "tm_demo" }, body: new Uint8Array(g.toBEEF()) });
  arcade.mode = "busy";
  const g1r = await submitG();
  const gLen = await gateLen();
  const g2r = await submitG();
  await router.settled();
  const gLen2 = await gateLen();
  const busy = {
    first: [g1r.status, g1r.headers.get("retry-after"), ((await g1r.json()) as { status?: string }).status],
    again: [g2r.status, g2r.headers.get("retry-after")], appended: gLen2 - gLen,
    state: (await settledOf("gate", [gid]))[0], posts: posted(gid).length,
  };
  arcade.mode = "ok";
  const retried: number[] = [];
  const ok = await until("the gate instance's wake to admit it", async () => {
    const r = await submitG();
    retried.push(r.status);
    if (r.status === 200) return await r.json();
    await r.arrayBuffer();
    await sleep(400);
    return undefined;
  });
  const gateResolver = new LookupResolver({ networkPreset: "local", hostOverrides: { ls_demo: [gateBase] } });
  const gLive = await gateResolver.query({ service: "ls_demo", query: { topic: "tm_demo" } }) as { outputs: Array<{ beef: number[]; outputIndex: number }> };
  report.transient = {
    busy, steak: ok, statuses: [...new Set(retried)], asked: arcade.gets.includes(gid), posts: posted(gid).length,
    state: (await settledOf("gate", [gid]))[0], live: gLive.outputs.map((o) => [Transaction.fromBEEF(o.beef).id("hex") === gid, o.outputIndex]),
  };
  report.ok = true;
} catch (e) {
  report.error = (e as Error).stack ?? String(e);
}
await router.stop();
await arcade.close();
hostDb.close();
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
check(eq(report.posted1, [true]), `#57: the step posted the token transaction to Arcade through the host's route (Extended Format) before admitting it (${JSON.stringify(report.posted1)})`);
{
  const g = report.gossip as { verdict: string; boxes: string[]; applied: number; admitted: number; same: boolean; posts: number } | undefined;
  check(g?.verdict === "accept" && eq(g.boxes, ["libp2p:tm_demo:p2p", "submit:submit"]) && g.applied === 1 && g.admitted === 1 && g.same, `#57: the same transaction as a GossipSub message on \`libp2p:tm_demo\` (the same submit fn): accept, the \`p2p\` entry then the handler's submit entry appended, and the store holds the same applied / admitted records (but for their step times), byTopic map and lookup storage as POST /submit produced (${JSON.stringify(g)})`);
  check(g?.posts === 2, `#57: the pubsub submission went through the same broadcast gate: its step posted it too, and was admitted on Arcade's duplicate answer (${JSON.stringify(g?.posts)} posts of it)`);
  check(eq(report.gossipAgain, ["ignore", true]), `#57: the message redelivered: ignore, nothing written — the store file byte-identical (${JSON.stringify(report.gossipAgain)})`);
}
check(eq(report.lookup1, [["t1", 0, true]]), `LookupResolver → POST /lookup (aggregated): the token, its BEEF verifying against the headers (${JSON.stringify(report.lookup1)})`);
check(eq(report.byScript, [["t1", 0]]), `a lookup by script hash (${JSON.stringify(report.byScript)})`);
check(eq(report.lookupJson, { type: "output-list", outputs: [["t1", 0]] }), `the JSON answer form (${JSON.stringify(report.lookupJson)})`);
check(eq(report.dupe, { tm_demo: { outputsToAdmit: [0], coinsToRetain: [], coinsRemoved: [] } }), `#57: a resubmission appends nothing and answers the STEAK from the state (what was admitted); an unserved topic is left out (${JSON.stringify(report.dupe)})`);
check(eq(report.refusedSubmit, [200, "empty-steak", true]), `#50: a submission no topic takes answers 200 with the empty STEAK (BRC-22) in the front door's call: no entry, the store file byte-identical (${JSON.stringify(report.refusedSubmit)})`);
check(report.lsHead === true, `#50: ls_demo keeps its own storage under the head ls:ls_demo, and answers the lookups from it`);
check(eq(report.submit2, { tm_demo: { outputsToAdmit: [0], coinsToRetain: [0], coinsRemoved: [] } }), `the spend: a new token admitted, the old retained (${JSON.stringify(report.submit2)})`);
check(eq(report.lookup2, [["t2", 0, true]]) && eq(report.withSpent, [["t1", 0], ["t2", 0]]), `the live set moves to the new token; the old one stays for history (${JSON.stringify([report.lookup2, report.withSpent])})`);
check(eq(report.afterReject, [["t1", 0, true]]), `a status entry rejects the spend: its admittance vanishes, the consumed token is restored (${JSON.stringify(report.afterReject)})`);
check(eq(report.t2Settled, [[false, false, true]]), `#57: DOUBLE_SPEND_ATTEMPTED after admission stepped the spend's awaiting thread: rejected, no longer awaiting (${JSON.stringify(report.t2Settled)})`);
check(Array.isArray(report.resubmitRejected) && report.resubmitRejected[0] === 200 && report.resubmitRejected[1] === "empty-steak", `a rejected transaction admits nothing on resubmission (200, empty STEAK) (${JSON.stringify(report.resubmitRejected)})`);
check(Array.isArray(report.badBeef) && report.badBeef[0] === 400 && report.unknownService === 400, `refusals: a bad BEEF, an unknown service (${JSON.stringify([report.badBeef, report.unknownService])})`);
check(eq(report.topics, { tm_demo: { name: "tm_demo", shortDescription: "Demo tokens: outputs whose script starts <\"tm_demo\"> OP_DROP." } }) && (report.lookups as Record<string, unknown>)?.ls_demo !== undefined, `the listings, from the program records (${JSON.stringify([report.topics, report.lookups])})`);
check(Array.isArray(report.doc) && String(report.doc[0]).startsWith("text/markdown"), `documentation (${JSON.stringify(report.doc)})`);
{
  const [b, a] = (report.readsWrite ?? []) as number[];
  // Between the two counts: T2's submit (one entry), the status entry (one); the rest — lookups, a dupe, refusals, listings — none.
  check(a === b! + 2, `only the writes write: 2 entries over one submit and one status entry, none for the lookups, dupes, refusals, listings (${b} → ${a})`);
}

check(eq(report.awaitingU, { state: [[false, true, false], [false, true, false], [false, true, false]], posts: [1, 1, 1] }), `#57: three unproven tokens, each posted once and admitted on Arcade's 202, each thread awaiting its status (${JSON.stringify(report.awaitingU)})`);
check(eq(report.settledBySse, [[true, false, false], [true, false, false], [true, false, false]]), `#57: Arcade's SEEN_ON_NETWORK then MINED (with merkle paths) over its SSE stream, routed by the host's broadcaster to each token's awaiting thread: proven, no longer awaiting (${JSON.stringify(report.settledBySse)})`);
check(eq(report.merkle, [[1, true, true], [2, true, true], [3, true, true]]), `three tokens of one block, proven by separate BUMPs (out of order): each lookup answer carries the BUMPs rebuilt from the stored merkle nodes (merged per block), each leaf computing the header root, verified by @bsv/sdk (${JSON.stringify(report.merkle)})`);
check(eq(report.merkleAlone, [[1, true, true], [2, true, true], [3, true, true]]), `each token alone: its BUMP rebuilt from the tree is byte for byte the one its status entry carried, verified by @bsv/sdk (${JSON.stringify(report.merkleAlone)})`);
check(eq(report.chronicle, [true, 200, "empty-steak"]), `#53: a Rúnar AMM pool spend (its pool input executes OP_2MUL) verifies under Chronicle rules in the front door's call: 200, the empty STEAK, no topic here taking it (${JSON.stringify(report.chronicle)})`);
check(Array.isArray(report.chronicleBroken) && report.chronicleBroken[0] === 400 && String(report.chronicleBroken[1]).includes("ScriptFailed"), `#53: the same swap with its funding signature broken is refused, 400 ScriptFailed (${JSON.stringify(report.chronicleBroken)})`);
check(eq(report.mined, { status: 200, steak: { tm_demo: { outputsToAdmit: [0], coinsToRetain: [], coinsRemoved: [] } }, posted: 0, state: [true, false, false] }), `#57: a mined submission (its BEEF proves it) is admitted with no POST to Arcade, and awaits nothing (${JSON.stringify(report.mined)})`);
{
  const x = report.arcRejected as { status: number; body: { status?: string; message?: string }; posted: number; state: boolean[]; live: number } | undefined;
  check(x?.status === 400 && x.body.status === "error" && x.body.message === "Transaction rejected: REJECTED" && x.posted === 1 && eq(x.state, [false, false, true]) && x.live === 0, `#57: Arcade's 400: the transaction rejected, nothing admitted; the client gets 400 {status: "error", message} (${JSON.stringify(x)})`);
}
{
  const t = report.transient as { busy: { first: unknown[]; again: unknown[]; appended: number; state: boolean[]; posts: number }; steak: unknown; statuses: number[]; asked: boolean; posts: number; state: boolean[]; live: unknown[] } | undefined;
  check(!!t && eq(t.busy.first, [503, "2", "error"]) && eq(t.busy.state, [false, true, false]) && t.busy.posts === 1, `#57: Arcade's 503: nothing admitted, the client answered 503 with Retry-After (the 1.5 s re-ask, rounded up), the transaction held and awaiting (${JSON.stringify(t?.busy)})`);
  check(!!t && eq(t.busy.again, [503, "2"]) && t.busy.appended === 0, `#57: a resubmission while pending appends nothing and answers 503 again (${JSON.stringify(t?.busy)})`);
  check(!!t && eq(t.steak, { tm_demo: { outputsToAdmit: [0], coinsToRetain: [], coinsRemoved: [] } }) && t.asked && t.posts >= 2 && eq(t.state, [false, true, false]) && eq(t.live, [[true, 0]]) && t.statuses.at(-1) === 200, `#57: at the deadline the thread re-asked (404: never taken) and posted again — accepted, admitted, awaiting its status; the retrying client gets the STEAK from the state (${JSON.stringify(t)})`);
}
check(eq(report.edges, { sameRoot: true, children: [false, false, false], noNodeEdges: true, forward: true }), `#42: kept merkle nodes and headers contribute no edges (no token is a \`child\` edge target), the nodes still link forward to their children; the TS reader derives the kernel's edges map, same root (${JSON.stringify(report.edges)})`);

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
check(rt.status === 0 && /identical .*the source store reproduced exactly/.test(rt.stdout), "#57: the gate instance's store (its recorded 503, the deadline's re-ask and re-post, its wakes) replays to itself exactly");

if (process.env.KEEP) process.stdout.write(`kept ${home}\n`); else rmSync(home, { recursive: true, force: true });
process.stdout.write(failures ? `overlay: ${failures} FAILED\n` : "overlay: all ok\n");
process.exit(failures ? 1 : 0);

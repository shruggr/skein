// Overlay services in the VM (issues #36, #79) end to end on the Zig kernel,
// served by the instance's own front door to the stock @bsv/sdk overlay
// clients. skein 0.6.0 (D8, David 2026-11-09): every instance is a
// stock-system instance and the chain app (shruggr/skein-chain, $SKEIN_CHAIN_DIR
// or a pinned tag) and the overlay (shruggr/skein-overlay, $SKEIN_OVERLAY_DIR or
// a pinned tag) are installed as apps by the owner's messages — never
// genesis-wired system programs; root adds the two root routes the SDK clients
// need (`/submit`, `/lookup` at the origin's root: skein-overlay docs/OVERLAY.md
// "Root routes"). The #57 GossipSub-submission instance and the #74 three-host
// gossip scenario are gone with the mechanisms they tested (the mesh carries
// only the host's `admit` announcements since skein-overlay 0.20.0; no
// `-proof` since 0.25.0): equiv sync.ts and announce.ts cover the spread.
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
// the BEEF verifies against the headers; a dupe answers from the state; every request is an entry and only
// writes move heads; listings and documentation; a spend retaining the old
// token, then a DOUBLE_SPEND_ATTEMPTED for it, unwound: the old token live
// again; three tokens in one block proven by separate BUMPs (lookup answers
// carry BUMPs rebuilt from the stored nodes); a Chronicle AMM pool spend
// (#53); a mined submission; Arcade's 400; Arcade busy (503: the client
// waits to the router's bound; a resubmission waits on the same thread);
// a fourth instance with no Arcade admits only at the proof. Every store replays to itself
// exactly (equiv/replays.ts).
//
// skein-overlay 0.9.2 (shruggr/skein#112): POST /submit is BRC-22 and
// synchronous again — the request waits on the engine's thread and is answered
// the STEAK (503 + Retry-After at the router's bound; several waiters all
// answered); a plain POST is admitted because its BEEF validates (#135). The
// verdict cases also submit by message — {fn: "submit", args: {beef, topics}} into box `overlay/submit`
// over a wallet's /sendMessage session (the tree has the messagebox for it) —
// and read the answers (admitted / rejected, each naming the message) from the
// steps' result records: no message reaches that sender. By message, Arcade
// busy and no status provider leave the submitter unanswered until the
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
import { dirSource } from "../../src/host/boot.ts";
import { isBeefEnvelope, isBeefRecord, wireOf, type BeefEnvelope, type BeefRecord } from "../../src/runtime/beef.ts";
import { FakeArcade } from "../../src/host/fake-arcade.ts";
import { HostDb } from "../../src/host/instances.ts";
import { buildTree, derive, parseRocksSpec } from "../../src/runtime/index-store.ts";
import { KernelHost } from "../../src/host/kernel.ts";
import { openStoreFile, storeBlocks } from "../../src/host/stores.ts";
import { BACKEND, specFor, storeFor } from "./backend.ts";
import { libp2pKey, peerIdOf } from "../../src/host/p2p.ts";
import { Router } from "../../src/host/router.ts";
import { RawBox } from "../../src/client/raw.ts";
import { Signer } from "../../src/host/signer.ts";
import { ephemeralWallet } from "../../src/wallet.ts";
import { chunk } from "../../src/client/bundle.ts";
import { encode } from "../../src/runtime/cid.ts";
import { ownerCli, signedSubmitter } from "../../src/testapps.ts";

// The apps under test (#71, #78): SKEIN_OVERLAY_DIR / SKEIN_CHAIN_DIR name checkouts, else these commits are cloned.
const OVERLAY_REPO = "https://github.com/shruggr/skein-overlay";
const OVERLAY_REV = process.env.SKEIN_OVERLAY_REV ?? "v0.25.0";
const CHAIN_REPO = "https://github.com/shruggr/skein-chain";
const CHAIN_REV = process.env.SKEIN_CHAIN_REV ?? "v0.9.0";
const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
const home = mkdtempSync(join(tmpdir(), "skein-kz-overlay-"));
const db = specFor(home, "overlay");
const key = (h: string) => new PrivateKey(h, 16);
const report: Record<string, unknown> = {};
let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };
const eq = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);

// #135, two doors: POST /submit is a message route — a signed request, X-Topics beside the signed headers
// (src/testapps.ts signedSubmitter) — and, signed or validated, an open row behind the `beef` filter: the
// stock TopicBroadcaster's plain POST is admitted because its BEEF validates (no sender key).
const submitFetch = signedSubmitter(ephemeralWallet(key("8888")));

// #135, #143: the overlay's lookup, listings and documentation are read routes — filters only, the engine's
// functions answer: anyone, signed or not, no entry. A filter is `<app>.<filter>`, the function an app record
// declares: a system tree has no app record for its genesis-wired engine, so root writes one (objects + head
// overlay/app: its programs the genesis's, its filters) and its read routes (dispatch), as an install would.
// skein-overlay 0.11.0: a read route naming no app is the app its filter names (config.zig `filterApp`), and that
// app record's config.overlay replaces the genesis defaults there: the record carries the genesis's topics and
// lookups, and their programs' roles.
const OVERLAY_READS: Array<[string, string]> = [["/lookup", "lookup"], ["/listTopicManagers", "listTopicManagers"], ["/listLookupServiceProviders", "listLookupServiceProviders"], ["/getDocumentationForTopicManager", "topicDocumentation"], ["/getDocumentationForLookupServiceProvider", "lookupDocumentation"]];
function clone(repo: string, rev: string, dir: string): string {
  for (const args of [["clone", "-q", repo, dir], ["-C", dir, "checkout", "-q", rev]]) {
    const r = spawnSync("git", args, { stdio: ["ignore", "ignore", "inherit"] });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: exit ${r.status}`);
  }
  return dir;
}

// ---------------------------------------------------------------- the apps (skein 0.6.0, D8)

// The chain app and the overlay are never genesis-wired system programs (D8, David 2026-11-09): every instance
// here is a stock-system instance (no tree), and both are installed as apps by the owner's messages (#141: the
// app records under `chain/app`, `overlay/app`; updatable by a logged install). The overlay app's manifest
// serves tm_demo and ls_demo (its etc/app.json); its routes are under its name: `/overlay/submit`,
// `/overlay/lookup`, the listings and documentation.
const overlayDir = process.env.SKEIN_OVERLAY_DIR ?? clone(OVERLAY_REPO, OVERLAY_REV, join(home, "skein-overlay"));
const chainDir = process.env.SKEIN_CHAIN_DIR ?? clone(CHAIN_REPO, CHAIN_REV, join(home, "skein-chain"));
const ownerWallet = ephemeralWallet(key("2222"));
/** The chain app, then the overlay, installed into `h` by the owner (the router listening). */
async function installApps(r: Router, h: string, hHome: string): Promise<void> {
  await r.hydrate(h);
  for (const dir of [chainDir, overlayDir]) {
    const o = await ownerCli({ home: hHome, port: r.port!, owner: ownerWallet, settled: () => r.settled() }, ["install", dir, "--instance", h]);
    if (o.code !== 0) throw new Error(`${h}: install ${dir}: ${o.err.join(" ")}`);
    await r.settled();
  }
  // The @bsv/sdk clients take only a bare origin and call `<origin>/submit` and `<origin>/lookup`: root's two root
  // routes to the app's submit handler and lookup filter (skein-overlay docs/OVERLAY.md "Root routes", by hand).
  const l = await r.hydrate(h);
  const app = await l.kernel.store.get(await l.kernel.call("head", "overlay/app") as CID) as unknown as { programs: Record<string, CID> };
  const box = new RawBox(ownerWallet, r.originOf(h));
  await box.send(l.identity, "dispatch", { op: "add", row: { transport: "http", address: "/submit", filters: ["kernel.beef"], program: app.programs.overlay!, fn: "submit" } });
  await box.send(l.identity, "dispatch", { op: "add", row: { transport: "http", address: "/lookup", filters: ["overlay.lookup"] } });
  await r.settled();
}

// ---------------------------------------------------------------- regtest

/** The STEAK of a tm_demo token admitted (output 0). */
const STEAK = { tm_demo: { outputsToAdmit: [0], coinsToRetain: [], coinsRemoved: [] } };
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
/** The `beef` of every chain-app ingest message an instance's steps emitted (#146: the door's envelope, or bytes). */
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
/** The pointer record a door's envelope links (#146: the envelope sits where the bytes were), or null. */
const pointerOf = (v: unknown): CID | null => isBeefEnvelope(v) ? CID.asCID(v.beef) : null;
/**
 * The wire bytes a block names: a dag-cbor envelope (#146) through its pointer record and blocks (beef.ts
 * wireOf), else the block's own bytes (the raw block a submission's bytes were kept as).
 */
async function wireAt(file: string, c: CID): Promise<Uint8Array> {
  const v = openStoreFile(file, { readOnly: true });
  try {
    const b = await v.bytes(c);
    const e = c.code === 0x71 ? dagCbor.decode(b) : undefined;
    if (!isBeefEnvelope(e)) return b;
    return await wireOf(e, dagCbor.decode(await v.bytes(CID.asCID(e.beef)!)) as BeefRecord, async (x) => await v.bytes(x));
  } finally { await v.close(); }
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
hostDb.add("overlay", { store: storeFor(home, "overlay") });
// #57: the transient-failure case.
const gateDb = specFor(home, "gate");
hostDb.add("gate", { store: storeFor(home, "gate") });
const owner = key("2222").toPublicKey().toString();
// The host's Arcade (#58, #65): the chain app broadcasts (an event), the host posts it; Arcade's answer and statuses come back as status messages, proofs as events.
const arcade = await FakeArcade.start();
const posted = (txid: string) => arcade.posts.filter((b) => FakeArcade.txOf(b).id("hex") === txid);
const router = new Router({
  db: hostDb, walletFor: () => ephemeralWallet(key("1111")), home, owner, idleMs: 0, providerKeyFor: (n) => new Signer(new PrivateKey("a77e57", 16)).providerKey(n),
  // #66: a client waits on its request's thread; the gate's pending broadcast answers 503 + Retry-After at this bound.
  answerWaitMs: 6000,
  kernel: { command: kernel, env: { SKEIN_HOME: home } }, network: "regtest", // #156: the host chain is regtest (the trees' own walletNetwork is per instance)
  genesis: { defaults: { walletNetwork: "regtest" } },
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
// #156: a host of its own (its own chain: in RocksDB mode, its own database and so its own host chain).
const noarcHome = join(home, "noarc-host");
const noarcDb = specFor(noarcHome, "noarc");
mkdirSync(noarcHome, { recursive: true });
const noarcHostDb = new HostDb(join(noarcHome, "host.db"));
noarcHostDb.add("noarc", { store: storeFor(noarcHome, "noarc") });
const noarcRouter = new Router({
  db: noarcHostDb, walletFor: () => ephemeralWallet(key("1111")), home, owner, idleMs: 0, providerKeyFor: (n) => new Signer(new PrivateKey("a77e57", 16)).providerKey(n),
  answerWaitMs: 300,
  kernel: { command: kernel, env: { SKEIN_HOME: home } }, network: "regtest", // #156: the host chain is regtest (the trees' own walletNetwork is per instance)
  genesis: { defaults: { walletNetwork: "regtest" } },
  log: (s, l) => { if (process.env.VERBOSE) process.stdout.write(`  | [noarc:${s}] ${l}\n`); },
});

try {
  // Listening first (the instances' origins name the port).
  await router.listen(0);
  // D8: stock-system instances, the chain app and the overlay installed as apps.
  for (const x of ["overlay", "gate"]) await installApps(router, x, home);
  // The SDK clients at the origin's root (root routes, above); the listings and documentation under the app's name.
  const base = router.originOf("overlay");
  const appBase = `${base}/overlay`;
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
  fund.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 10_000 }); // #112: the gate's HTTP token (0.9.2)
  fund.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 10_000 }); // #50: the submission no topic takes (0.25.0: ingested, so its own coin)
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
  for (const raw of headers) for (const h of ["overlay", "gate"]) await router.chainHeaders(h, "chain", [raw]);
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
  const facilitator = { send: async (_url: string, tagged: Parameters<HTTPSOverlayBroadcastFacilitator["send"]>[1]) => { sentBeefs.push(Uint8Array.from(tagged.beef)); const s = await new HTTPSOverlayBroadcastFacilitator(submitFetch as typeof fetch, true).send(base, tagged); steaks.push(s); return s; } };
  const broadcaster = new TopicBroadcaster(["tm_demo"], { networkPreset: "local", facilitator });
  const b1 = await broadcaster.broadcast(t1);
  // skein-overlay 0.9.2 (#112): POST /submit is BRC-22 again — the request waits on the engine's thread and is answered
  // the STEAK (the stock broadcaster reads it as success); the admitting step's result record carries it too.
  await until("T1 admitted", async () => { await router.settled(); return (await steakOf(db, t1.id("hex"))) ? true : undefined; });
  report.submit1 = { status: b1.status, answered: steaks.at(-1), steak: await steakOf(db, t1.id("hex")) };
  // #79: the chain app broadcast it (the overlay handed it over); the host posted it once, in Extended Format.
  report.posted1 = posted(t1.id("hex")).map((b) => Buffer.from(b).equals(Buffer.from(t1.toEF())));

  await router.settled();
  const plainOf = (v: unknown): unknown => v instanceof Uint8Array ? Buffer.from(v).toString("hex")
    : v instanceof CID || (v && typeof v === "object" && (v as { asCID?: unknown }).asCID === v) ? String(v)
    : Array.isArray(v) ? v.map(plainOf)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([x, y]) => [x, plainOf(y)])) : v;
  // #121, #146: the door. The submit row names `kernel.beef`: before the request's entry was written the kernel
  // decoded the BEEF, checked its BUMP against chain/state, stored its transactions as bitcoin-tx blocks, and put
  // the envelope where the bytes were, linking the pointer record. Its entry carries `door`; no block in the store
  // holds the BEEF's bytes (a grep of every block); the chain app ingested it from the envelope; the bytes come
  // back exactly.
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
    const envelope = isBeefEnvelope(rec?.body) ? rec.body as BeefEnvelope : undefined;
    const pointer = pointerOf(envelope);
    const v = openStoreFile(db, { readOnly: true });
    try {
      let holding = 0, total = 0;
      for (const row of storeBlocks(db)) { total++; if (Buffer.from(row.bytes).indexOf(Buffer.from(wire)) >= 0) holding++; }
      const pr = pointer ? await k.store.get(pointer) as unknown as BeefRecord : undefined;
      const back = envelope && pr && isBeefRecord(pr) ? await wireOf(envelope, pr, async (c) => await v.bytes(c)) : undefined;
      const txs = await headMap(k, "chain/state", "txs");
      report.door121 = {
        filter: (submitEntry?.door as { filters?: string[] } | undefined)?.filters?.[0], form: envelope?.form, linked: !!pointer && (submitEntry?.door?.beefs ?? []).some((c) => c.equals(pointer)), kind: pr?.kind,
        grep: [holding, total > 0], identical: !!back && Buffer.from(back).equals(Buffer.from(wire)),
        txBlocks: pr ? await Promise.all(pr.txs.map(async (c) => Buffer.from(await v.bytes(c)).toString("hex").length > 0)) : [],
        pointer: String(pointer),
        ingested: txs.has(internal(t1.id("hex")).toString("hex")),
        ingests: (await ingestBeefs(db)).map((b) => b instanceof Uint8Array ? "bytes" : pointer && pointerOf(b)?.equals(pointer) ? "the envelope" : JSON.stringify(plainOf(b))),
      };
    } finally { await v.close(); }
  }
  // (skein 0.6.0: the #57 GossipSub-submission instance is gone — since skein-overlay 0.20.0 the mesh carries only
  // `admit` announcements, the host's; sync.ts and announce.ts cover the spread.)

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
    let n = 0;
    for (const { cid: c } of storeBlocks(db)) if (c.code === 0xb1 || c.code === 0xb0 || c.code === 0x55) n++;
    return n;
  };
  await router.settled();
  const held0 = heldBlocks();
  const dupeHttp = await new HTTPSOverlayBroadcastFacilitator(submitFetch as typeof fetch, true).send(base, { beef: t1.toBEEF(), topics: ["tm_demo", "tm_other"] }) as Record<string, unknown>;
  await router.settled();
  {
    const k = await kO();
    const last = (await entriesSince("overlay", 0)).filter((e) => e.transport === "http").at(-1)!;
    const body = (await k.store.get(last.request!) as unknown as { body: unknown }).body;
    report.dupeBlocks = { bitcoinAndRaw: [held0, heldBlocks()], samePointer: !!pointerOf(body) && (report.door121 as { pointer?: string }).pointer === String(pointerOf(body)), delivered: eq(dupeHttp, STEAK) };
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
  let requests = 0, toDoor = 0;
  // #135, #143: what the door admits — the handshake, a POST /submit kernel.beef passes (signed or not), a signed request
  // at any other route but a read route — is an entry; a read route's answer is none, nor is a rejection (a bad BUMP: 400).
  const readPaths = new Set([...OVERLAY_READS.map(([p]) => `/overlay${p}`), "/lookup"]);
  fwd.forward = async (handle, ...rest) => {
    const res = await forward0(handle, ...rest);
    if (handle === "overlay") {
      requests++;
      const [route, , req] = rest as [string, URL, { headers: Record<string, string> }];
      const status = (res as { status?: number }).status;
      if (route === "/.well-known/auth" || (route.endsWith("/submit") && status !== 400) || (!readPaths.has(route) && !route.endsWith("/submit") && Object.keys(req.headers).some((k) => k.startsWith("x-bsv-auth-")))) toDoor++;
    }
    return res;
  };
  const stateOf = async () => { const k = await kO(); return [String(await k.call("head", "overlay/state")), String(await k.call("head", "overlay/ls_demo")), String(await k.call("head", "chain/state"))]; };
  const before = await logLen();
  const state0 = await stateOf();
  const state0Applied = (await headMap(await kO(), "overlay/state", "applied")).size;

  // #50: a submission no topic takes: 200 with the empty STEAK from the front door's step; nothing else changed.
  const plain = new Transaction();
  plain.addInput({ sourceTransaction: fund, sourceOutputIndex: 3, unlockingScriptTemplate: new P2PKH().unlock(alice), sequence: 0xffffffff });
  plain.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 9_000 });
  await plain.sign();
  await router.settled();
  const lenBeforeRefused = await logLen();
  const refused = await submitMsg(router, "overlay", db, new Uint8Array(plain.toBEEF()), ["tm_demo"]);
  const refusedA = await answered(refused, router);
  await router.settled();
  // 0.25.0 (D6): taken by no topic, it is an item all the same — ingested by the chain app (its verdict the fact
  // `rejected`); the overlay's lookup head where it was, the overlay records nothing applied.
  report.refusedSubmit = [refusedA.length, ...gist(refusedA[0]).map((x) => typeof x === "string" ? x.split(":")[0] : x), (await stateOf())[1] === state0[1], (await headMap(await kO(), "overlay/state", "applied")).size === (state0Applied)];

  // #121, #143: a bad BUMP — T1's BEEF with its funding's BUMP sibling changed (the root is not block 1's): rejected at
  // the door by kernel.beef. No entry is written, nothing runs, no head moved; the client gets the rejection (400).
  {
    const good = new Uint8Array(t1.toBEEF());
    const at = Buffer.from(good).indexOf(Buffer.from("cb".repeat(32), "hex"));
    const bad = Uint8Array.from(good);
    bad.set(Buffer.from("cc".repeat(32), "hex"), at);
    const len0 = await logLen();
    const st0 = await stateOf();
    const res = await submitFetch(`${base}/submit`, { method: "POST", headers: { "x-topics": "tm_demo" }, body: bad });
    const answer = await res.json() as { code?: string; description?: string };
    await router.settled();
    report.badBump = {
      status: res.status, code: answer.code, entries: (await logLen()) - len0, reason: /merkle root/.test(answer.description ?? ""), same: eq(await stateOf(), st0),
    };
    // #135: the same bad BEEF plain (validated, not signed): the filter's refusal, a plain 400.
    const resPlain = await fetch(`${base}/submit`, { method: "POST", headers: { "x-topics": "tm_demo" }, body: bad });
    report.badBumpPlain = [resPlain.status, (await resPlain.json() as { code?: string }).code, Object.keys(Object.fromEntries(resPlain.headers)).some((h) => h.startsWith("x-bsv-auth-"))];
    await router.settled();
  }
  report.lsHead = (await (await kO()).call("head", "overlay/ls_demo")) != null;

  // T2 spends the token into a new one (X-Topics as a JSON array, Atomic BEEF): the old one is retained.
  const r2 = await submitFetch(`${base}/submit`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-topics": JSON.stringify(["tm_demo"]) }, body: new Uint8Array(t2.toAtomicBEEF()) });
  report.submit2Delivered = [r2.status, await r2.json().catch(() => undefined)];
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
  report.topics = await (await fetch(`${appBase}/listTopicManagers`)).json();
  report.lookups = await (await fetch(`${appBase}/listLookupServiceProviders`)).json();
  const doc = await fetch(`${appBase}/getDocumentationForTopicManager?manager=tm_demo`);
  report.doc = [doc.headers.get("content-type"), (await doc.text()).split("\n")[0]];
  await look({ topic: "tm_demo" });
  await submitFetch(`${base}/submit`, { method: "POST", headers: { "x-topics": "tm_demo" }, body: new Uint8Array(t1.toBEEF()) });
  // #135: the same submission plain, by the stock facilitator over a plain fetch (the stock TopicBroadcaster's): signed
  // or validated — its BEEF validates at the door: admitted (an entry), 200; a dupe, so the state stays.
  let plainStatus = 0;
  const plainFetch = (async (u: string | URL | Request, i?: RequestInit) => { const r = await fetch(u, i); plainStatus = r.status; return r; }) as typeof fetch;
  await new HTTPSOverlayBroadcastFacilitator(plainFetch, true).send(base, { beef: t1.toBEEF(), topics: ["tm_demo"] }).catch(() => undefined);
  report.plainSubmit = plainStatus;
  await router.settled();
  // #65, #79: `local` requests are entries too, not forwarded: the status provider's messages and the loopback (the
  // overlay's ingest and watch messages, the chain app's answers).
  const local = (await entriesSince("overlay", before)).filter((e) => e.transport === "local").length;
  report.readsWrite = [before, (await logLen()) - local, requests, eq(await stateOf(), state1), local, toDoor];
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
    const s = await submitFetch(`${base}/submit`, { method: "POST", headers: { "x-topics": "tm_demo" }, body: new Uint8Array(u.toAtomicBEEF()) });
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
  await router.chainHeaders("overlay", "chain", [h4]);
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
  await router.chainHeaders("overlay", "chain", [h5]);
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
  await router.chainHeaders("overlay", "chain", [h6]);
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
      // A submission's thread: launched by a message submission (box `submit`), or the one the submit event POST
      // /submit admits into the app's box begins (0.24.0: no launch): its args name the submit event.
      for await (const th of v.edges.query({ kind: "thread" })) { const a = ((await v.get(th)) as unknown as { args?: { box?: string; event?: unknown } }).args; if (a?.event !== undefined && (a.box === "submit" || a.box === "overlay")) n++; }
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
  // 0.9.2 (#112: BRC-22 and synchronous again), over HTTP — a plain POST (#135: its BEEF validates): Arcade busy, the
  // client waits on the submission's thread to the router's bound, 503 + Retry-After; a resubmission waits on the same
  // thread (503 again, no second submission). Arcade takes it: two clients resubmitting at once both get the STEAK.
  {
    const h = new Transaction();
    h.addInput({ sourceTransaction: fund, sourceOutputIndex: 2, unlockingScriptTemplate: new P2PKH().unlock(alice), sequence: 0xffffffff });
    h.addOutput({ lockingScript: tokenScript(alice), satoshis: 1 });
    h.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 9_000 });
    await h.sign();
    const submitH = () => fetch(`${gateBase}/submit`, { method: "POST", headers: { "x-topics": "tm_demo" }, body: new Uint8Array(h.toBEEF()) });
    const n0 = await submissions();
    arcade.mode = "busy";
    const h1 = await submitH();
    const h2 = await submitH();
    const first = [h1.status, h1.headers.get("retry-after")], again = [h2.status, h2.headers.get("retry-after")];
    const busyThreads = (await submissions()) - n0;
    arcade.mode = "ok";
    const both = await Promise.all([submitH(), submitH()]);
    report.transientHttp = { first, again, busyThreads, both: await Promise.all(both.map(async (r) => [r.status, await r.json().catch(() => undefined)])), threads: (await submissions()) - n0, posts: posted(h.id("hex")).length };
    await router.settled();
  }

  // #73: the fourth instance (no Arcade, no status provider): the chain app's broadcast is dropped (this host has
  // none) and the submission's thread waits for the chain app's answer; the client gets 503 at the bound, nothing
  // admitted. The proof, fed directly: the chain app proves it and answers `proven`: admitted at the proof.
  await noarcRouter.listen(0);
  await installApps(noarcRouter, "noarc", noarcHome);
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
  await noarcRouter.chainHeaders("noarc", "chain", [nH1]);
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
  // D8: the chain app's rows are the install's (the route table), not the genesis's.
  const ng = await (await kN()).dispatch() as { rows: Array<{ address: string }> };
  report.noProviderPending = { answers: (await nSub.answers()).length, state: (await settledIn(await kN(), [nTokId]))[0], live: await noarcLive(), statusRow: ng.rows.some((r) => r.address === "chain/status") };
  const nFiller = "f7".repeat(32);
  const nH2 = mine(sha256d(nH1), sha256d(Buffer.concat([internal(nFiller), internal(nTokId)])), 1_790_010_600);
  const nPath = new MerklePath(2, [[{ offset: 0, hash: nFiller }, { offset: 1, hash: nTokId, txid: true }]]);
  await noarcRouter.chainHeaders("noarc", "chain", [nH2]);
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

// (skein 0.6.0: the #74 three-host gossip scenario of skein-overlay 0.12.0 — the raw submission on the mesh,
// peer-admit records, `<topic>-proof` — is gone with those mechanisms: 0.20.0 made the mesh the host's announcements,
// 0.25.0 removed `-proof`; equiv sync.ts and announce.ts cover the spread between hosts.)

// #42: the merkle nodes the BUMPs revealed (kept by the chain app) are 64-byte bitcoin-tx blocks that contribute no
// edges (nor does the header): no token is a `child` edge target, and no edge in the map is `child` / `prev` /
// `merkleroot`. The nodes still link forward. The TS reader derives the kernel's edges map key for key.
if (report.ok === true) {
  // #158: a RocksDB set is read through the host's kernel process, so one runs for the read (the routers are stopped).
  const rocks = parseRocksSpec(db);
  const kh = rocks ? KernelHost.acquire(rocks.dir, { command: kernel, env: { SKEIN_HOME: home } }) : undefined;
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
  await kh?.release();
}

process.stdout.write("== overlay services (#36, #79)\n");
check(report.ok === true, `the scenario ran${report.error ? `: ${report.error}` : ""}`);
check(report.chainState === "chain-state", `the headers (events in box chain) reached the chain app: chain/state is a chain-state (${String(report.chainState)})`);
check(eq(report.submit1, { status: "success", answered: STEAK, steak: STEAK }), `TopicBroadcaster → POST /submit (0.9.2: BRC-22, synchronous): the token admitted on the chain app's answer, the STEAK answered and in the admitting step's result (${JSON.stringify(report.submit1)})`);
check(eq(report.posted1, [true]), `#79: the chain app broadcast the token transaction the overlay handed it; the host posted it to Arcade once (Extended Format) before it was admitted (${JSON.stringify(report.posted1)})`);
{
  const d = report.door121 as { filter?: string; form?: string; linked?: boolean; kind?: string; grep?: [number, boolean]; identical?: boolean; txBlocks?: boolean[]; ingested?: boolean; ingests?: string[] } | undefined;
  check(d?.filter === "kernel.beef" && d.form === "beef" && d.linked === true && d.kind === "beef", `#121, #146: the submit's entry: the door ran the row's beef filter; its request's body is the envelope (form "beef") linking the BEEF's pointer record, listed in door.beefs (${JSON.stringify(d)})`);
  check(!!d?.grep && d.grep[0] === 0 && d.grep[1], `#121: no block in the store holds the submitted BEEF's bytes (a grep of every block: ${JSON.stringify(d?.grep)})`);
  check(d?.identical === true && !!d.txBlocks?.length && d.txBlocks.every(Boolean), `#121, #146: the envelope's bytes back (beef.ts wireOf over the pointer record and its blocks: each transaction a bitcoin-tx block) are the submitted bytes`);
  check(d?.ingested === true && !!d.ingests?.length && d.ingests.at(-1) === "the envelope" && d.ingests.slice(0, -1).every((x) => x === "bytes"), `#121, #146: the chain app ingested it from the envelope — the subject's ingest message carries the envelope linking the pointer record (0.25.0, D6: an earlier item no topic takes, the funding, its Atomic BEEF cut from it) (${JSON.stringify(d?.ingests)})`);
  const bb = report.badBump as Record<string, unknown> | undefined;
  check(eq(bb, { status: 400, code: "ERR_BEEF", entries: 0, reason: true, same: true }), `#121, #143: a bad BUMP: rejected by kernel.beef ("merkle root"), no entry, nothing runs; 400 to the client (${JSON.stringify(bb)})`);
  const db_ = report.dupeBlocks as { bitcoinAndRaw: [number, number]; samePointer: boolean } | undefined;
  check(!!db_ && db_.bitcoinAndRaw[0] === db_.bitcoinAndRaw[1] && db_.samePointer && (db_ as { delivered?: boolean }).delivered === true, `#121: a held transaction submitted again writes no block (bitcoin and raw blocks ${JSON.stringify(db_?.bitcoinAndRaw)}), its envelope links the same pointer record; answered the first STEAK from the state (0.9.2)`);
}
check(eq(report.lookup1, [["t1", 0, true]]), `LookupResolver → POST /lookup (aggregated): the token, its BEEF (from the chain state) verifying against the headers (${JSON.stringify(report.lookup1)})`);
check(eq(report.byScript, [["t1", 0]]), `a lookup by script hash (${JSON.stringify(report.byScript)})`);
check(eq(report.lookupJson, { type: "output-list", outputs: [["t1", 0]] }), `the JSON answer form (${JSON.stringify(report.lookupJson)})`);
{
  const d = report.dupe as { answers: number; gist: unknown[] } | undefined;
  check(!!d && d.answers === 1 && d.gist[0] === "admitted" && eq(d.gist[2], STEAK), `#57, #112: a resubmission by message is answered admitted from the state at once, its STEAK; an unserved topic is left out (${JSON.stringify(report.dupe)})`);
}
check(eq(report.refusedSubmit, [1, "rejected", "NotAdmitted", true, true]), `#50, #68, #112: a submission no topic takes: answered rejected (NotAdmitted), one entry; the overlay's, the lookup service's and the chain's heads where they were (${JSON.stringify(report.refusedSubmit)})`);
check(report.lsHead === true, `#50, #79: ls_demo keeps its own storage under the head overlay/ls_demo`);
check(eq(report.submit2Delivered, [200, { tm_demo: { outputsToAdmit: [0], coinsToRetain: [0], coinsRemoved: [] } }]) && eq(report.submit2, { tm_demo: { outputsToAdmit: [0], coinsToRetain: [0], coinsRemoved: [] } }), `the spend (POST /submit, X-Topics a JSON array, Atomic BEEF: 200, its STEAK): a new token admitted, the old retained (${JSON.stringify([report.submit2Delivered, report.submit2])})`);
check(eq(report.lookup2, [["t2", 0, true]]) && eq(report.withSpent, [["t1", 0], ["t2", 0]]), `the live set moves to the new token (spent-ness from the chain state); the old one stays for history (${JSON.stringify([report.lookup2, report.withSpent])})`);
check(eq(report.afterReject, [["t1", 0, true]]), `#79: a DOUBLE_SPEND_ATTEMPTED for the spend: the chain app rejects it and answers the overlay's watch; its admittance vanishes, the consumed token is live again (${JSON.stringify(report.afterReject)})`);
check(eq(report.t2Settled, [[false, false, true]]), `the chain state: the spend rejected, nothing pending (${JSON.stringify(report.t2Settled)})`);
check(Array.isArray(report.resubmitRejected) && report.resubmitRejected[0] === "rejected", `a rejected transaction admits nothing on resubmission: answered rejected (${JSON.stringify(report.resubmitRejected)})`);
check(Array.isArray(report.badBeef) && report.badBeef[0] === "rejected" && report.unknownService === 400, `refusals: a bad BEEF (answered rejected), an unknown service (400) (${JSON.stringify([report.badBeef, report.unknownService])})`);
check(eq(report.topics, { tm_demo: { name: "tm_demo", shortDescription: "Example tokens: outputs starting <\"tm_demo\"> OP_DROP with at least 1 satoshi." } }) && (report.lookups as Record<string, unknown>)?.ls_demo !== undefined, `the listings, from the programs' own metadata (skein-overlay#2) (${JSON.stringify([report.topics, report.lookups])})`);
check(Array.isArray(report.doc) && String(report.doc[0]).startsWith("text/markdown"), `documentation (${JSON.stringify(report.doc)})`);
{
  const [b, a, n, still, local, door] = (report.readsWrite ?? []) as [number, number, number, boolean, number, number];
  check(n > 10 && n - door >= 5 && a === b + door && local >= 2 && still === true, `#135: every request to the door (signed, the handshake, or a plain POST /submit: validated) is an entry, a read none (${n} requests, ${door} to the door: ${b} → ${a}, besides ${local} \`local\` ones: the status provider's and the loopback's); the reads moved nothing (${still})`);
  check(report.plainSubmit === 200, `#135, signed or validated: a plain POST /submit (the stock facilitator's, X-Topics) is admitted because its BEEF validates: 200 (${String(report.plainSubmit)})`);
  check(eq(report.badBumpPlain, [400, "ERR_BEEF", false]), `#135: a bad BUMP plain: the filter's refusal, 400, answered plain (${JSON.stringify(report.badBumpPlain)})`);
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
  check(x?.answer[0] === "rejected" && /REJECTED|TransactionRejected/.test(String(x.answer[1])) && x.posted === 1 && eq(x.state, [false, true, true]) && x.live === 0, `#57: Arcade's 400 (a REJECTED status): the chain app answers rejected, nothing admitted (0.25.0: its submission's record kept — a later proof admits it); the submitter answered rejected (${JSON.stringify(x)})`);
}
{
  const t = report.transient as { busy: { first: unknown[]; again: unknown[]; submissions: number; state: boolean[]; posts: number }; steak: unknown[][]; submissions: number; queued: boolean; posts: number; state: boolean[]; live: unknown[] } | undefined;
  check(!!t && eq(t.busy.first, []) && eq(t.busy.state, [false, true, false]) && t.busy.posts >= 1, `#57, #112: Arcade's 503: the host keeps it queued; nothing admitted; the submitter not answered yet (${JSON.stringify(t?.busy)})`);
  check(!!t && eq(t.busy.again, []) && t.busy.submissions === 1, `#112: a resubmission while pending launches no second submission and is not answered (${JSON.stringify(t?.busy)})`);
  check(!!t && eq(t.steak, [[["admitted", "pending", STEAK]], []]) && t.submissions === 1 && !t.queued && t.posts >= 2 && eq(t.state, [false, true, false]) && eq(t.live, [[true, 0]]), `#57, #112: the host's queue retries; Arcade takes it: accepted, admitted; the first submitter answered admitted with the STEAK (${JSON.stringify(t)})`);
  const th = report.transientHttp as { first: unknown[]; again: unknown[]; busyThreads: number; both: unknown[]; threads: number; posts: number } | undefined;
  check(!!th && eq(th.first, [503, "5"]) && eq(th.again, [503, "5"]) && th.busyThreads === 1, `#66, #112 (0.9.2): Arcade busy, a plain POST /submit: the client waited to the router's bound, 503 + Retry-After; a resubmission waits on the same thread, 503 again, no second submission (${JSON.stringify(th && [th.first, th.again, th.busyThreads])})`);
  check(!!th && eq(th.both, [[200, STEAK], [200, STEAK]]) && th.threads === 1 && th.posts >= 2, `#66, #112 (0.9.2): Arcade takes it: two clients waiting on the same submission both get the STEAK (${JSON.stringify(th)})`);
  check(Array.isArray(report.firstAnswers) && report.firstAnswers.length === 1, `skein-overlay 0.7.4: the first submitter (by message) is answered exactly once (${JSON.stringify(report.firstAnswers)})`);
}
{
  const p = report.noProviderPending as { answers: number; state: boolean[]; live: number; statusRow: boolean } | undefined;
  check(!!p && p.answers === 0 && eq(p.state, [false, true, false]) && p.live === 0 && p.statusRow === true, `#73: no Arcade, no status provider (#143: the chain app's \`status\` route stands — no sender; nothing comes into it): the submission handed to the chain app, pending; not answered; nothing admitted (${JSON.stringify(p)})`);
  const v = report.noProviderProven as { state: boolean[]; live: number; answers: unknown[][] } | undefined;
  check(!!v && eq(v.state, [true, false, false]) && v.live === 1 && v.answers[0]?.[0] === "admitted" && v.answers[0]?.[1] === "proven", `#73: its proof, fed directly: the chain app answers proven — admitted at the proof, the submitter answered admitted (proven) (${JSON.stringify(v)})`);
}
check(eq(report.edges, { sameRoot: true, children: [false, false, false], noNodeEdges: true, forward: true }), `#42: kept merkle nodes and headers contribute no edges, the nodes still link forward; the TS reader derives the kernel's edges map, same root (${JSON.stringify(report.edges)})`);

const replay = (file: string, what: string) => {
  const r = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), file], { encoding: "utf8" });
  process.stdout.write(r.stdout);
  if (r.status !== 0) process.stdout.write(r.stderr);
  check(r.status === 0 && /identical .*the source store reproduced exactly/.test(r.stdout), what);
};
replay(db, "the store replays to itself exactly");
replay(gateDb, "#57: the gate instance's store replays to itself exactly");
replay(noarcDb, "#73: the no-Arcade instance's store replays to itself exactly");

if (process.env.KEEP) process.stdout.write(`kept ${home}\n`); else rmSync(home, { recursive: true, force: true });
process.stdout.write(failures ? `overlay (${BACKEND}): ${failures} FAILED\n` : `overlay (${BACKEND}): all ok\n`);
process.exit(failures ? 1 : 0);

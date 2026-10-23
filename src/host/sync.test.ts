// Overlay sync (shruggr/skein#150, sync.ts) over fake overlays: two or three
// instances whose overlay state is a list of (height, txid) per instance with
// BRC-136's anchors; each puller's own reads (`local`: anchors, admitted) are
// its fake's, and its requests are answered by the other's fake engine
// (`engineSync`: the wire as skein-overlay's fn `sync` answers it, #154 — the
// host answers nothing). Checked: a beat whose tip anchor is ours starts
// nothing; one that is not runs the locator and pulls only what is lacking, in
// height order, into the receive row as from the peer; a list whose BUMP does
// not reach our header drops the peer before anything is fetched; a want asks
// the named peer, else the topic's peers, and ends on unwant; the want events
// folded. Then two P2PHosts: a host protocol's round trip and the beat hook.
// Then two routers (#154): the serving instance's libp2p row
// /skein/overlay/sync/1.0.0 with a filter (programs/test/sync-demo, standing in
// for the engine's `sync`) answers each frame at its door, the answer written
// back as the frame through p2p.ts `serve`, a rejection closing the stream,
// nothing logged; and a puller completes a catch-up against it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as dagCbor from "@ipld/dag-cbor";
import { MerklePath, PrivateKey } from "@bsv/sdk";
import { ownerCli } from "../testapps.ts";
import { ephemeralWallet } from "../wallet.ts";
import { HostDb } from "./instances.ts";
import { Router } from "./router.ts";
import { Signer } from "./signer.ts";
import { P2PHost, peerIdOf, type InboundAnswer } from "./p2p.ts";
import { MESSAGE_KEY_ID, MESSAGE_PROTOCOL as SIGN_PROTOCOL } from "./providers.ts";
import { foldWants, OverlaySync, peerOf, SYNC_PROTOCOL, wantEvent, type Want } from "./sync.ts";
import type { LiveBeat } from "./liveness.ts";

const sha256d = (b: Uint8Array) => createHash("sha256").update(createHash("sha256").update(b).digest()).digest();
const rev = (h: string) => Buffer.from(h, "hex").reverse();
const txidOf = (s: string) => Buffer.from(sha256d(Buffer.from(s))).reverse().toString("hex"); // display hex
const signer = new Signer(PrivateKey.fromHex("66".repeat(32)));
const peer = (h: string) => peerIdOf(signer.peerKey(h)).toString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => T | undefined | false, what: string, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = f(); if (v) return v; if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(20); }
}

/** The chain: blocks by height, each its txids in block order; a BUMP over any subset; the header's hash and root. */
const X = txidOf("x"), Y = txidOf("y"), Z = txidOf("z"), W = txidOf("w");
const BLOCKS: Record<number, string[]> = { 2: [X, Y], 3: [], 4: [Z] };
function bumpOf(height: number, txids: string[]): MerklePath {
  const all = BLOCKS[height]!;
  if (all.length === 1) return new MerklePath(height, [[{ offset: 0, hash: all[0], txid: true }]]);
  return new MerklePath(height, [all.map((t, i) => ({ offset: i, hash: t, ...(txids.includes(t) ? { txid: true } : {}) }))]);
}
const rootOf = (height: number) => BLOCKS[height]!.length ? bumpOf(height, BLOCKS[height]!).computeRoot(BLOCKS[height]![0]) : "77".repeat(32);
const hashOf = (height: number) => Buffer.from(sha256d(Buffer.from(`header ${height}`))).toString("hex");

/** A fake overlay's state: the (height, txid) it holds; its anchors as BRC-136 builds them. */
class FakeOverlay {
  have: Array<{ height: number; txid: string }> = [];
  delivered: Array<{ peer: string; txid: string }> = [];
  constructor(have: Array<[number, string]>) { this.have = have.map(([height, txid]) => ({ height, txid })); }
  span() { const hs = this.have.map((x) => x.height); return hs.length ? { genesis: Math.min(...hs), tip: Math.max(...hs) } : undefined; }
  at(h: number) { return BLOCKS[h]!.filter((t) => this.have.some((x) => x.height === h && x.txid === t)); }
  anchor(h: number): string | undefined {
    const sp = this.span();
    if (!sp || h < sp.genesis || h > sp.tip) return undefined;
    let prev = Buffer.alloc(32);
    for (let i = sp.genesis; i <= h; i++) {
      const ts = this.at(i).map(rev);
      let layer: Buffer[] = ts;
      while (layer.length > 1) { const n: Buffer[] = []; for (let j = 0; j < layer.length; j += 2) n.push(sha256d(Buffer.concat([layer[j]!, layer[j + 1] ?? layer[j]!]))); layer = n; }
      prev = sha256d(Buffer.concat([prev, rev(hashOf(i)), layer[0] ?? Buffer.alloc(32)]));
    }
    return prev.toString("hex");
  }
  tipBeat(): Uint8Array {
    const sp = this.span();
    return dagCbor.encode(sp ? { tipHeight: sp.tip, tipAnchor: Uint8Array.from(Buffer.from(this.anchor(sp.tip)!, "hex")), tailDigest: new Uint8Array(32) } : { tailDigest: new Uint8Array(32) });
  }
  read(path: string, q: Record<string, string>): unknown {
    const sp = this.span();
    if (path === "/anchors") {
      const heights = q.heights ? q.heights.split(",").map(Number) : sp ? [sp.tip, sp.genesis] : [];
      return { topic: q.topic, ...(sp ? { genesisHeight: sp.genesis, tipHeight: sp.tip } : {}), anchors: heights.filter((h) => this.anchor(h)).map((h) => ({ height: h, anchor: this.anchor(h) })) };
    }
    if (path === "/admitted") {
      const from = Number(q.fromHeight ?? 0), to = Math.min(Number(q.toHeight ?? 1e9), sp?.tip ?? -1);
      const blocks = [];
      for (let h = Math.max(from, sp?.genesis ?? 0); h <= to; h++) {
        const ts = this.at(h);
        if (ts.length) blocks.push({ height: h, blockHash: hashOf(h), txids: ts, bump: bumpOf(h, ts).toHex() });
      }
      return { topic: q.topic, blocks, nextHeight: null };
    }
    if (path === "/holds") return this.have.some((x) => x.txid === q.txid) || q.txid === W && this.holdsW ? { txid: q.txid, via: "admitted", beef: Buffer.from(q.txid!).toString("hex") } : {};
    throw new Error(`no read ${path}`);
  }
  holdsW = false;
}

/** A fake overlay's engine answering one sync frame (skein-overlay fn `sync`, #154): the wire sync.ts documents. */
function engineSync(ov: FakeOverlay, frame: Uint8Array): Uint8Array {
  let req: Record<string, unknown>;
  try { req = dagCbor.decode(frame) as Record<string, unknown>; } catch { return dagCbor.encode({ kind: "error", message: "not dag-cbor" }); }
  const topic = req.topic;
  if (topic !== "tm_t") return dagCbor.encode({ kind: "error", message: `${String(topic)} is not served here` });
  if (req.kind === "locator") {
    const loc = (req.locator ?? []) as Array<{ height: number; anchor: Uint8Array }>;
    const ours = ov.read("/anchors", { topic, heights: loc.length ? loc.map((x) => x.height).join(",") : "0" }) as { genesisHeight?: number; tipHeight?: number; anchors: Array<{ height: number; anchor: string }> };
    const mine = new Map(ours.anchors.map((x) => [x.height, x.anchor]));
    let agreed: number | undefined;
    for (const x of loc) if (mine.get(x.height) === Buffer.from(x.anchor).toString("hex") && (agreed === undefined || x.height > agreed)) agreed = x.height;
    return dagCbor.encode({
      kind: "locator", topic,
      ...(ours.genesisHeight !== undefined ? { genesisHeight: ours.genesisHeight, tipHeight: ours.tipHeight } : {}),
      ...(agreed !== undefined ? { agreedHeight: agreed } : {}),
    });
  }
  if (req.kind === "admitted") {
    const a = ov.read("/admitted", { topic, fromHeight: String(req.fromHeight), toHeight: String(req.toHeight) }) as { blocks: unknown[]; nextHeight: number | null };
    return dagCbor.encode({ kind: "admitted", topic, blocks: a.blocks, nextHeight: a.nextHeight });
  }
  if (req.kind === "tx") {
    const h = ov.read("/holds", { txid: String(req.txid) }) as { beef?: string };
    return dagCbor.encode({ kind: "tx", txid: req.txid, ...(h.beef ? { beef: Uint8Array.from(Buffer.from(h.beef, "hex")) } : {}) });
  }
  return dagCbor.encode({ kind: "error", message: `no request ${String(req.kind)}` });
}

/** Instances by handle, each with its overlay and its OverlaySync; requests answered by the other's fake engine. */
function world(overlays: Record<string, FakeOverlay>, o: { lie?: string } = {}) {
  const syncs: Record<string, OverlaySync> = {};
  const byPeer = (p: string) => Object.keys(overlays).find((h) => peer(h) === p)!;
  const beats: Record<string, LiveBeat[]> = {};
  for (const h of Object.keys(overlays)) {
    const ov = overlays[h]!;
    syncs[h] = new OverlaySync({
      overlayOf: (_h, t) => t === "tm_t-live" ? "overlay" : undefined,
      local: async (_h, _app, fn, q) => ov.read(`/${fn}`, q),
      deliver: async (_h, from, beef): Promise<InboundAnswer> => {
        const txid = Buffer.from(beef).toString("utf8");
        ov.delivered.push({ peer: from, txid });
        const height = Number(Object.keys(BLOCKS).find((k) => BLOCKS[Number(k)]!.includes(txid)) ?? 0);
        if (height) ov.have.push({ height, txid });
        return { verdict: "accept" };
      },
      header: async (_h, height) => BLOCKS[height] ? { hash: hashOf(height), root: rootOf(height) } : undefined,
      request: async (_h, p, body) => {
        const other = byPeer(p);
        const answer = engineSync(overlays[other]!, body);
        if (o.lie === other) { // a list whose BUMP reaches another root
          const a = dagCbor.decode(answer) as { kind: string; blocks?: Array<{ bump: string; txids: string[] }> };
          if (a.kind === "admitted") for (const b of a.blocks ?? []) b.bump = new MerklePath(2, [[{ offset: 0, hash: b.txids[0], txid: true }, { offset: 1, hash: W }]]).toHex();
          return dagCbor.encode(a);
        }
        return answer;
      },
      subscribers: () => Object.keys(overlays).filter((x) => x !== h).map(peer),
      beats: () => beats[h] ?? [],
      self: () => peer(h),
      cooldownMs: 0,
      wantRetryMs: 20,
    });
  }
  const beat = (to: string, from: string) => {
    const b: LiveBeat = { sender: from, at: Date.now(), body: overlays[from]!.tipBeat(), from: peer(from) };
    beats[to] = [...(beats[to] ?? []).filter((x) => x.from !== b.from), b];
    syncs[to]!.beat(to, "tm_t-live", b);
  };
  return { syncs, beat };
}

test("sync: a beat whose tip anchor is ours starts nothing; one that is not: the locator, then only what is lacking, in height order, as from the peer", async () => {
  const a = new FakeOverlay([[2, X]]);
  const b = new FakeOverlay([[2, X], [2, Y], [4, Z]]);
  const { syncs, beat } = world({ a, b });
  assert.notEqual(a.anchor(2), b.anchor(2), "the root at 2 differs: one txid against two");

  beat("b", "a"); // a's tip is 2, b's anchor at 2 is not a's: b asks; a has nothing b lacks
  await syncs.b!.idle();
  assert.deepEqual(b.delivered, []);
  beat("a", "b");
  await syncs.a!.idle();
  assert.deepEqual(a.delivered, [{ peer: peer("b"), txid: Y }, { peer: peer("b"), txid: Z }], "Y then Z, from b, X not fetched again");
  assert.equal(a.anchor(4), b.anchor(4), "equal anchors at the tip");
  beat("a", "b");
  await syncs.a!.idle();
  assert.equal(a.delivered.length, 2, "equal now: nothing more");

  // A new instance from genesis: an empty locator, the whole range.
  const c = new FakeOverlay([]);
  const w2 = world({ c, b });
  w2.beat("c", "b");
  await w2.syncs.c!.idle();
  assert.deepEqual(c.delivered.map((x) => x.txid), [X, Y, Z]);
  assert.equal(c.anchor(4), b.anchor(4));
});

test("sync: a list whose BUMP does not reach our header drops the peer before any transaction is fetched", async () => {
  const a = new FakeOverlay([]);
  const liar = new FakeOverlay([[2, X], [2, Y]]);
  const { syncs, beat } = world({ a, liar }, { lie: "liar" });
  beat("a", "liar");
  await syncs.a!.idle();
  assert.deepEqual(a.delivered, []);
  beat("a", "liar");
  await syncs.a!.idle();
  assert.deepEqual(a.delivered, [], "dropped: its beats start nothing");
});

test("sync: a want asks the named peer, else the topic's peers; answered into the receive row; unwant ends it; the events folded", async () => {
  const a = new FakeOverlay([]);
  const b = new FakeOverlay([]);
  const c = new FakeOverlay([]);
  c.holdsW = true;
  const { syncs } = world({ a, b, c });
  const mh = (h: string) => peerIdOf(signer.peerKey(h)).toMultihash().bytes;
  assert.equal(peerOf(mh("c")), peer("c"));
  // Named: c.
  syncs.a!.want("a", { event: "want", want: { app: "overlay", txid: W, topic: "tm_t", peer: mh("c") } });
  await syncs.a!.idle();
  assert.deepEqual(a.delivered, [{ peer: peer("c"), txid: W }]);
  // No peer: the topic's peers, b (holds nothing) then c.
  a.delivered = [];
  syncs.a!.want("a", { event: "want", want: { app: "overlay", txid: W, topic: "tm_t" } });
  await syncs.a!.idle();
  assert.deepEqual(a.delivered, [{ peer: peer("c"), txid: W }]);
  // No one holds it: asked again while it stands; unwant ends it.
  c.holdsW = false;
  a.delivered = [];
  const w: Want = { app: "overlay", txid: Z, topic: "tm_t" };
  syncs.a!.want("a", { event: "want", want: w });
  await sleep(50);
  assert.ok(syncs.a!.busy(), "still asking");
  syncs.a!.want("a", { event: "unwant", want: w });
  syncs.a!.stop();
  await syncs.a!.idle();
  assert.deepEqual(a.delivered, []);

  const ev = (r: Record<string, unknown>) => wantEvent({ kind: "event", app: "overlay", topic: "tm_t", ...r });
  for (const bad of [{ event: "want", txid: "zz" }, { event: "want", txid: W, peer: "text" }, { event: "beacon", txid: W }]) assert.ok("refused" in ev(bad), JSON.stringify(bad));
  const evs = [ev({ event: "want", txid: W }), ev({ event: "want", txid: Z }), ev({ event: "want", txid: W }), ev({ event: "unwant", txid: Z }), ev({ event: "want", txid: W, peer: mh("b") })];
  assert.deepEqual(foldWants(evs.map((e) => e as Exclude<typeof e, { refused: string }>)).map((x) => [x.txid, x.peer ? peerOf(x.peer) : undefined]), [[W, undefined], [W, peer("b")]]);
});

const HOST_PROTOCOL = "/skein/test/host/1.0.0";

test("sync: a host protocol on two nodes — one request, one answer, nothing at the front door; a beat newly kept reaches the hook, not the node's own", async (t) => {
  const inbound = async (): Promise<InboundAnswer> => { throw new Error("nothing reaches the front door"); };
  const kept: Array<{ handle: string; topic: string; from: string }> = [];
  const mk = (bootstrap: string[] = []) => new P2PHost({
    host: { listen: ["/ip4/127.0.0.1/tcp/0"], bootstrap, dht: "off", relays: [], mdns: false },
    keyOf: (h) => signer.peerKey(h), inbound, discoveryMs: 300,
    hostProtocols: { [HOST_PROTOCOL]: async (h, remote, frame) => new TextEncoder().encode(`${h} heard ${new TextDecoder().decode(frame)} from ${remote.toString() === peer("alpha") ? "alpha" : "?"}`) },
    beat: (handle, topic, b) => kept.push({ handle, topic, from: b.from }),
    sign: async (h, d) => Uint8Array.from((await signer.wallet(h).createSignature({ protocolID: SIGN_PROTOCOL, keyID: MESSAGE_KEY_ID, counterparty: "anyone", data: [...d] })).signature),
    identity: async (h) => Uint8Array.from(Buffer.from(signer.identity(h), "hex")),
  });
  const a = mk();
  t.after(() => a.stop());
  await a.declare("alpha", { topics: [], protocols: [] });
  const b = mk(a.addrs("alpha"));
  t.after(() => b.stop());
  await b.declare("beta", { topics: [], protocols: [] });
  a.liveness("alpha", [{ app: "overlay", topic: "tm_t-live", window: 40_000 }]);
  b.liveness("beta", [{ app: "overlay", topic: "tm_t-live", window: 40_000 }]);
  await until(() => a.node("alpha")!.getConnections().length > 0, "beta connects to alpha");
  const answer = await a.request("alpha", b.peerId("beta"), HOST_PROTOCOL, new TextEncoder().encode("hi"));
  assert.equal(new TextDecoder().decode(answer), "beta heard hi from alpha");
  assert.ok(!b.served("beta")!.protocols.includes(HOST_PROTOCOL), "not the config's: the host's own");

  await until(() => b.subscribers("beta", "tm_t-live").length > 0, "beta sees alpha on tm_t-live");
  await sleep(1200);
  b.beacons("beta", [{ app: "overlay", topic: "tm_t-live", every: 1000, body: dagCbor.encode({ tailDigest: new Uint8Array(32) }) }]);
  await until(() => kept.find((k) => k.handle === "alpha"), "alpha keeps beta's beat");
  assert.deepEqual(kept.find((k) => k.handle === "alpha"), { handle: "alpha", topic: "tm_t-live", from: b.peerId("beta") });
  assert.ok(!kept.some((k) => k.handle === "beta"), "the node's own beat is kept, not handed to the hook");
});

// ---------------------------------------------------------------- the engine's row (#154): two routers

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const KERNEL = join(ROOT, "kernel-zig/zig-out/bin/skein-kernel");
const SDEMO_WASM = join(ROOT, "kernel-zig/test/p2p/sync-demo.wasm");
const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});

test("sync (#154): an app's libp2p read row answers each frame at the door — its filter's answer written back as the frame through p2p.ts serve, a rejection closing the stream, nothing logged — and a puller catches up against it", { timeout: 120_000, skip: !existsSync(KERNEL) && "kernel-zig not built" }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "skein-sync-row-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const ownerKey = new PrivateKey("2323", 16);
  const ownerWallet = ephemeralWallet(ownerKey);
  const owner = ownerKey.toPublicKey().toString();
  const [pa, pb] = [await freePort(), await freePort()];
  const mk = (handle: string, listen: number, other: { handle: string; port: number }, genesis?: ConstructorParameters<typeof Router>[0]["genesis"]) => {
    const dir = join(home, handle);
    mkdirSync(dir, { recursive: true });
    const db = new HostDb(join(dir, "host.db"));
    db.add(handle, { store: join(dir, "instances", handle, "runtime.db") });
    const r = new Router({
      db, walletFor: (row) => signer.wallet(row.handle), peerKeyFor: (h) => signer.peerKey(h), providerKeyFor: (n) => signer.providerKey(n), home: dir, owner, idleMs: 0,
      kernel: { command: KERNEL, env: { SKEIN_HOME: dir } },
      libp2p: { listen: [`/ip4/127.0.0.1/tcp/${listen}`], bootstrap: [`/ip4/127.0.0.1/tcp/${other.port}/p2p/${peer(other.handle)}`], dht: "off", relays: [], mdns: false }, libp2pDiscoveryMs: 300,
      ...(genesis ? { genesis } : {}),
      log: (s, l) => { if (process.env.VERBOSE) process.stdout.write(`  | [${s}] ${l}\n`); },
    });
    return { db, r, dir };
  };
  const A = mk("alpha", pa, { handle: "beta", port: pb });
  const B = mk("beta", pb, { handle: "alpha", port: pa }, { libp2p: { topics: ["tm_t"] } });
  t.after(async () => { await Promise.all([A.r.stop(), B.r.stop()]); A.db.close(); B.db.close(); });
  await A.r.listen(0);
  const la = await A.r.hydrate("alpha");
  await B.r.hydrate("beta");

  // alpha serves: an app (sync-demo, standing in for the overlay engine) installed by root through the real install path,
  // its manifest declaring the row as skein-overlay's does — a libp2p protocol, filters only, no handler.
  // Its answers are b's state, as the fake engine answers it (the manifest's config.sync, hex).
  const b = new FakeOverlay([[2, X], [2, Y], [4, Z]]);
  const ask = (req: Record<string, unknown>) => Buffer.from(engineSync(b, dagCbor.encode(req))).toString("hex");
  const appDir = join(home, "sdemo");
  mkdirSync(join(appDir, "etc"), { recursive: true });
  mkdirSync(join(appDir, "bin"), { recursive: true });
  copyFileSync(SDEMO_WASM, join(appDir, "bin/sync-demo.wasm"));
  writeFileSync(join(appDir, "etc/app.json"), JSON.stringify({
    kind: "app", name: "sdemo", version: "0.1.0", description: "#154's stand-in for the overlay engine's fn sync",
    programs: { sdemo: "bin/sync-demo.wasm" },
    filters: { sync: "sdemo.sync" },
    routes: [{ transport: "libp2p", address: SYNC_PROTOCOL, filters: ["sync"] }],
    config: { sync: {
      locator: ask({ kind: "locator", topic: "tm_t", locator: [] }),
      admitted: ask({ kind: "admitted", topic: "tm_t", fromHeight: 2, toHeight: 4, limit: 1000 }),
      tx: Object.fromEntries([X, Y, Z].map((x) => [x, ask({ kind: "tx", topic: "tm_t", txid: x })])),
    } },
  }, null, 2));
  const inst = await ownerCli({ home: A.dir, port: A.r.port!, owner: ownerWallet, settled: () => A.r.settled() }, ["install", appDir, "--instance", "alpha"]);
  assert.equal(inst.code, 0, inst.err.join(" "));
  await A.r.settled();
  const row = (await la.kernel.dispatch()).rows.find((r) => r.transport === "libp2p" && r.address === SYNC_PROTOCOL);
  assert.ok(row && row.program === undefined && row.app === "sdemo", `alpha's row, a read route: ${JSON.stringify(row)}`);

  await until(() => B.r.p2p!.node("beta")!.getConnections().length > 0 || undefined, "beta connects to alpha", 20_000);
  await until(() => A.r.p2p!.served("alpha")?.protocols.includes(SYNC_PROTOCOL) || undefined, "alpha's node serves the row's protocol", 20_000);
  const entries = async () => (await la.kernel.store.get((await la.kernel.store.log.tip())!) as unknown as { n: number }).n;
  await A.r.settled();
  const before = await entries();

  // One frame each way: the filter's answer is the frame written back.
  const req = (body: Record<string, unknown>) => B.r.p2p!.request("beta", peer("alpha"), SYNC_PROTOCOL, dagCbor.encode(body));
  const loc = dagCbor.decode(await req({ kind: "locator", topic: "tm_t", locator: [] })) as Record<string, unknown>;
  assert.deepEqual(loc, { kind: "locator", topic: "tm_t", genesisHeight: 2, tipHeight: 4 }, "the filter's answer, as the frame");
  const tx = dagCbor.decode(await req({ kind: "tx", topic: "tm_t", txid: W })) as Record<string, unknown>;
  assert.deepEqual(tx, { kind: "tx", txid: W }, "not held");
  // A filter's rejection: no answer frame, the stream closed.
  await assert.rejects(req({ kind: "refuse", topic: "tm_t" }), "a rejection writes nothing back");
  await A.r.settled();
  assert.equal(await entries(), before, "answered at the door: nothing logged");

  // A puller (its own state empty) catches up from alpha over the real stream: every request answered by the row's filter.
  const c = new FakeOverlay([]);
  const sync = new OverlaySync({
    overlayOf: (_h, x) => x === "tm_t-live" ? "overlay" : undefined,
    local: async (_h, _app, fn, q) => c.read(`/${fn}`, q),
    deliver: async (_h, from, beef): Promise<InboundAnswer> => {
      const txid = Buffer.from(beef).toString("utf8");
      c.delivered.push({ peer: from, txid });
      const height = Number(Object.keys(BLOCKS).find((k) => BLOCKS[Number(k)]!.includes(txid)) ?? 0);
      if (height) c.have.push({ height, txid });
      return { verdict: "accept" };
    },
    header: async (_h, height) => BLOCKS[height] ? { hash: hashOf(height), root: rootOf(height) } : undefined,
    request: (h, p, body) => B.r.p2p!.request(h, p, SYNC_PROTOCOL, body),
    subscribers: () => [],
    beats: () => [],
    self: () => peer("beta"),
    cooldownMs: 0,
  });
  sync.beat("beta", "tm_t-live", { sender: "alpha", at: Date.now(), body: b.tipBeat(), from: peer("alpha") });
  await sync.idle();
  assert.deepEqual(c.delivered, [X, Y, Z].map((x) => ({ peer: peer("alpha"), txid: x })), "every transaction, in height order, as from alpha");
  assert.equal(c.anchor(4), b.anchor(4), "equal anchors at alpha's tip");
  await A.r.settled();
  assert.equal(await entries(), before, "the whole catch-up: nothing logged at alpha");
  sync.stop();
});

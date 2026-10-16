// Overlay sync (shruggr/skein#150) end to end over libp2p: shruggr/skein-chain
// and shruggr/skein-overlay 0.14.0 (pinned commits, or $SKEIN_CHAIN_DIR /
// $SKEIN_OVERLAY_DIR) installed by the owner's messages into stock-system
// instances on three routers, each topic registered by the owner (the beats
// are a registered topic's), the validator beating every second:
//
//   - two hosts, one topic (tm_sync): a token mined at 2 and submitted to b
//     reaches a by gossip; their anchors agree at 2;
//   - a offline (its router stopped) for three blocks: b takes a token mined
//     in each; a back (a new router on the same store, the headers fed): a
//     hears b's beat, runs the locator exchange on /skein/overlay/sync/1.0.0,
//     pulls b's admitted lists above the agreed height, checks each block's
//     BUMP against its headers, fetches each missing transaction and hands it
//     to its overlay's receive row as from b — until the anchors are equal;
//   - a third host c from genesis: an empty locator, the whole range, equal
//     anchors;
//   - a want (#112): b holds a token p (unmined, under tm_demo, gossip off for
//     it) that no other host has; a transfer spending p is posted to a without
//     p in its BEEF: a's overlay pauses it and wants p of the topic's peers, a
//     host asks them, b answers from /holds with the chain state's BEEF, a
//     hands it to the receive row, and the transfer is admitted.
//
// Each instance's store then replays to itself exactly.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/sync.ts

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Beef, MerklePath, P2PKH, PrivateKey, Script, Transaction, UnlockingScript } from "@bsv/sdk";
import { CID } from "multiformats/cid";
import { ownerCli } from "../../src/testapps.ts";
import { RawBox } from "../../src/client/raw.ts";
import { openStoreFile } from "../../src/runtime/index-store.ts";
import { FakeArcade } from "../../src/host/fake-arcade.ts";
import { HostDb } from "../../src/host/instances.ts";
import { Signer } from "../../src/host/signer.ts";
import { peerIdOf } from "../../src/host/p2p.ts";
import { Router } from "../../src/host/router.ts";
import { ephemeralWallet } from "../../src/wallet.ts";

const OVERLAY_REPO = "https://github.com/shruggr/skein-overlay";
const OVERLAY_REV = process.env.SKEIN_OVERLAY_REV ?? "385e1b96aedaab573b21e24a49675cc1a434034a";
const CHAIN_REPO = "https://github.com/shruggr/skein-chain";
const CHAIN_REV = process.env.SKEIN_CHAIN_REV ?? "00f29a21fa6c4de13090b04a6870dcdf237f0e59";
const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
const home = mkdtempSync(join(tmpdir(), "skein-kz-sync-"));
let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, f: () => Promise<T | undefined> | T | undefined, ms = 60_000): Promise<T> {
  for (const end = Date.now() + ms; ;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}
const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});
function checkout(envDir: string | undefined, repo: string, rev: string, dir: string): string {
  if (envDir) { cpSync(envDir, dir, { recursive: true, filter: (p) => !/\/(\.git|zig-out|\.zig-cache|zig-pkg)$/.test(p) }); return dir; }
  for (const args of [["clone", "-q", repo, dir], ["-C", dir, "checkout", "-q", rev]]) {
    const r = spawnSync("git", args, { stdio: ["ignore", "ignore", "inherit"] });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: exit ${r.status}`);
  }
  return dir;
}

// ---------------------------------------------------------------- regtest (as equiv/install-overlay.ts)

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

/** Every overlay step's result record in a store, oldest first, each once (as install-overlay.ts). */
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
const admittedIn = async (file: string, txid: string) => (await overlayResults(file)).some((x) => x.admitted === true && (x.txid === txid || ((x.admissions ?? []) as Array<{ txid?: string }>).some((a) => a.txid === txid)));

// ---------------------------------------------------------------- three routers with libp2p

const key = (h: string) => new PrivateKey(h, 16);
const ownerKey = key("2222");
const owner = ownerKey.toPublicKey().toString();
const ownerWallet = ephemeralWallet(ownerKey);
const signer = new Signer(new PrivateKey("5c5c5c", 16));
const arcade = await FakeArcade.start();
const names = ["a", "b", "c"] as const;
type Name = typeof names[number];
const ports: Record<Name, number> = { a: await freePort(), b: await freePort(), c: await freePort() };
const idOf = (h: string) => peerIdOf(signer.peerKey(h)).toString();
const addr = (h: Name) => `/ip4/127.0.0.1/tcp/${ports[h]}/p2p/${idOf(h)}`;
const walletKeys: Record<string, string> = { a: "1111", b: "1112", c: "1113" };
const dbs: Partial<Record<Name, HostDb>> = {};
const routers: Partial<Record<Name, Router>> = {};
const log = (who: string) => (s: string, l: string) => { if (process.env.VERBOSE || /^sync: /.test(l)) process.stdout.write(`  | [${who}:${s}] ${l}\n`); };
/** Each router's own SKEIN_HOME: the owner's install finds the instance through its host.db. */
const homeOf = (h: Name) => join(home, h);
function router(h: Name): Router {
  if (!dbs[h]) {
    mkdirSync(homeOf(h), { recursive: true });
    dbs[h] = new HostDb(join(homeOf(h), "host.db"));
    dbs[h]!.add(h, { store: join(homeOf(h), `instances/${h}/runtime.db`) });
  }
  return new Router({
    db: dbs[h]!, walletFor: (row) => ephemeralWallet(key(walletKeys[row.handle]!)), home: homeOf(h), owner, idleMs: 0,
    providerKeyFor: (n: string) => signer.providerKey(n), peerKeyFor: (x: string) => signer.peerKey(x), answerWaitMs: 6000,
    kernel: { command: kernel, env: { SKEIN_HOME: homeOf(h) } }, libp2pDiscoveryMs: 300,
    genesis: { defaults: { walletNetwork: "regtest" } },
    arc: { url: arcade.url, token: "the-host-arcade-token", events: arcade.eventsUrl }, arcRetry: { min: 500, max: 2000 },
    libp2p: { listen: [`/ip4/127.0.0.1/tcp/${ports[h]}`], bootstrap: names.filter((x) => x !== h).map(addr), dht: "off", relays: [], mdns: false },
    log: log(h),
  });
}
const r = (h: Name) => routers[h]!;
const storeOf = (h: Name) => dbs[h]!.get(h)!.store;
const stores: string[] = [];

// The chain: the funding transaction mined at 1, then one token per block.
const alice = key("3333");
const fund = new Transaction();
fund.addInput({ sourceTXID: "72".repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex("51"), sequence: 0xffffffff });
for (let i = 0; i < 8; i++) fund.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 10_000 });
const fundTxid = fund.id("hex");
fund.merklePath = new MerklePath(1, [[{ offset: 0, hash: "cb".repeat(32) }, { offset: 1, hash: fundTxid, txid: true }]]);
const headers: Uint8Array[] = [mine(sha256d(REGTEST_GENESIS), sha256d(Buffer.concat([internal("cb".repeat(32)), internal(fundTxid)])), 1_790_200_000)];
const tokenScript = () => Script.fromBinary([0x07, ...Buffer.from("tm_demo"), 0x75, ...new P2PKH().lock(alice.toPublicKey().toHash()).toBinary()]);
async function token(source: Transaction, vout: number): Promise<Transaction> {
  const t = new Transaction();
  t.addInput({ sourceTransaction: source, sourceOutputIndex: vout, unlockingScriptTemplate: new P2PKH().unlock(alice), sequence: 0xffffffff });
  t.addOutput({ lockingScript: tokenScript(), satoshis: 1 });
  t.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 9_000 });
  await t.sign();
  return t;
}
/** `t` mined alone (after a coinbase) in the next block: its header added to the chain. → its height. */
function mineAlone(t: Transaction): number {
  const height = headers.length + 1;
  const cb = (height * 17 % 256).toString(16).padStart(2, "0").repeat(32);
  t.merklePath = new MerklePath(height, [[{ offset: 0, hash: cb }, { offset: 1, hash: t.id("hex"), txid: true }]]);
  headers.push(mine(sha256d(headers.at(-1)!), sha256d(Buffer.concat([internal(cb), internal(t.id("hex"))])), 1_790_200_000 + height * 600));
  return height;
}
const feedHeaders = async (h: Name, from = 1) => {
  for (let i = from; i <= headers.length; i++) await r(h).admitEvent(h, "chain", { kind: "header", raw: headers[i - 1]! });
  await r(h).settled();
};

const origin = (h: Name) => r(h).originOf(h);
const anchorsOf = async (h: Name) => {
  const res = await fetch(`${origin(h)}/overlay/anchors?topic=tm_sync`);
  if (res.status !== 200) throw new Error(`${h} /overlay/anchors: ${res.status} ${await res.text()}`);
  return await res.json() as { genesisHeight?: number; tipHeight?: number; anchors: Array<{ height: number; anchor: string }> };
};
const tipOf = async (h: Name) => { const x = await anchorsOf(h); return x.tipHeight === undefined ? undefined : { genesis: x.genesisHeight!, tip: x.tipHeight, anchor: x.anchors.find((y) => y.height === x.tipHeight)!.anchor }; };
const sameTip = async (x: Name, y: Name) => { const [p, q] = [await tipOf(x), await tipOf(y)]; return !!p && !!q && p.genesis === q.genesis && p.tip === q.tip && p.anchor === q.anchor ? p : undefined; };
const holdsOn = async (h: Name, txid: string) => await (await fetch(`${origin(h)}/overlay/holds?txid=${txid}`)).json() as { via?: string };
const submit = async (h: Name, beef: number[] | Uint8Array, topics: string) => await fetch(`${origin(h)}/overlay/submit`, { method: "POST", headers: { "x-topics": topics }, body: Uint8Array.from(beef) });
/** Until nothing moves: every running router settled, twice over a quiet second (gossip in flight lands as entries before a router stops). */
const quiet = async () => {
  for (let i = 0; i < 3; i++) {
    for (const h of names) await routers[h]?.settled();
    await sleep(1000);
  }
};
const subscribers = (h: Name, topic: string) => ((r(h).p2p?.node(h)?.services as { pubsub: { getSubscribers(t: string): unknown[] } } | undefined)?.pubsub.getSubscribers(topic).length ?? 0);

let overlayDir = "";
let chainDir = "";
/** An instance up: the chain app and the overlay installed by the owner, tm_sync registered, the headers so far fed. */
async function bring(h: Name): Promise<void> {
  routers[h] = router(h);
  await r(h).listen(0);
  await r(h).hydrate(h);
  stores.push(storeOf(h));
  const host = { home: homeOf(h), port: r(h).port!, owner: ownerWallet, settled: () => r(h).settled() };
  for (const dir of [chainDir, overlayDir]) {
    const o = await ownerCli(host, ["install", dir, "--instance", h]);
    if (o.code !== 0) throw new Error(`${h}: install ${dir}: ${o.err.join(" ")}`);
    await r(h).settled();
  }
  const identity = (await r(h).hydrate(h)).identity;
  await new RawBox(ownerWallet, `http://127.0.0.1:${r(h).port}/@${h}`).send(identity, "overlay/register", { fn: "register", args: { topic: "tm_sync", program: "topic-demo" } });
  await r(h).settled();
  await feedHeaders(h);
}

try {
  overlayDir = checkout(process.env.SKEIN_OVERLAY_DIR, OVERLAY_REPO, OVERLAY_REV, join(home, "overlay"));
  chainDir = checkout(process.env.SKEIN_CHAIN_DIR, CHAIN_REPO, CHAIN_REV, join(home, "chain"));
  // The validator beats every second (default 30 s); tm_demo publishes nothing (the want below is the only way p travels).
  const mf = JSON.parse(readFileSync(join(overlayDir, "etc/app.json"), "utf8")) as { version: string; config: { overlay: Record<string, unknown> } };
  mf.config.overlay.validator = { every: 1000 };
  mf.config.overlay.gossip = { tm_demo: false };
  writeFileSync(join(overlayDir, "etc/app.json"), JSON.stringify(mf, null, 2));
  check(mf.version === "0.14.0", `skein-overlay ${mf.version} at ${OVERLAY_REV.slice(0, 7)}`);

  await bring("a");
  await bring("b");
  await until("a and b meshed on tm_sync", () => (subscribers("a", "tm_sync") > 0 && subscribers("b", "tm_sync") > 0) || undefined);
  await sleep(1200);

  // ------------------------------------------------ two hosts, one topic: a token mined at 2 through b reaches a by gossip
  const t2 = await token(fund, 0);
  const h2 = mineAlone(t2);
  await feedHeaders("a", h2);
  await feedHeaders("b", h2);
  const s2 = await submit("b", t2.toBEEF(), "tm_sync");
  check(s2.status === 200, `t2 (mined at ${h2}) posted to b: ${s2.status} ${await s2.text()}`);
  const agree2 = await until("a and b agree at 2", () => sameTip("a", "b")).catch(() => undefined);
  check(agree2?.tip === 2 && agree2.genesis === 2, `a (by gossip) and b agree: genesis ${agree2?.genesis}, tip ${agree2?.tip}, anchor ${agree2?.anchor.slice(0, 16)}…`);

  // ------------------------------------------------ a offline for three blocks; b takes a token in each
  await quiet();
  await r("a").stop();
  const later: Transaction[] = [];
  for (let i = 1; i <= 3; i++) {
    const t = await token(fund, i);
    const h = mineAlone(t);
    await feedHeaders("b", h);
    const s = await submit("b", t.toBEEF(), "tm_sync");
    check(s.status === 200, `t${h} (mined at ${h}) posted to b while a is offline: ${s.status}`);
    later.push(t);
  }
  const bTip = await tipOf("b");
  check(bTip?.tip === 5, `b's tip is 5 (${bTip?.tip})`);

  // ------------------------------------------------ a back: the locator, the pulls, equal anchors
  routers.a = router("a");
  await r("a").listen(0);
  await r("a").hydrate("a");
  await feedHeaders("a", 3);
  const caught = await until("a catches up to b", () => sameTip("a", "b"), 90_000).catch(() => undefined);
  check(caught?.tip === 5, `a caught up from b: equal anchors at tip ${caught?.tip} (${caught?.anchor.slice(0, 16)}…)`);
  for (const t of later) check(await admittedIn(storeOf("a"), t.id("hex")), `a admitted ${t.id("hex").slice(0, 8)}… (mined at ${t.merklePath!.blockHeight}) through its receive row`);

  // ------------------------------------------------ a third host from genesis
  await bring("c");
  const fromGenesis = await until("c catches up from genesis", () => sameTip("c", "b"), 90_000).catch(() => undefined);
  check(fromGenesis?.tip === 5 && fromGenesis.genesis === 2, `c, new, from genesis: equal anchors (genesis ${fromGenesis?.genesis}, tip ${fromGenesis?.tip})`);
  check(!!(await sameTip("a", "c")), "a, b and c agree");

  // ------------------------------------------------ a want: p held only by b; a transfer spending it posted to a without it
  const p = await token(fund, 6);
  const sp = await submit("b", p.toBEEF(), "tm_demo");
  check(sp.status === 200, `p (unmined) posted to b under tm_demo: ${sp.status} ${await sp.text()}`);
  await until("b holds p", async () => (await holdsOn("b", p.id("hex"))).via);
  check(!(await holdsOn("a", p.id("hex"))).via && !(await holdsOn("c", p.id("hex"))).via, "only b holds p");
  const x = new Transaction();
  x.addInput({ sourceTransaction: p, sourceOutputIndex: 1, unlockingScriptTemplate: new P2PKH().unlock(alice), sequence: 0xffffffff });
  x.addOutput({ lockingScript: tokenScript(), satoshis: 1 });
  x.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 8_000 });
  await x.sign();
  const lone = new Beef();
  lone.mergeRawTx(x.toBinary());
  void submit("a", lone.toBinaryAtomic(x.id("hex")), "tm_sync").catch(() => undefined); // it waits on the pause: its answer is not the point
  const viaWant = await until("the transfer admitted on a", async () => (await admittedIn(storeOf("a"), x.id("hex"))) || undefined, 60_000).catch(() => false);
  check(viaWant, `the transfer, posted to a without p, admitted once p came through a want (${x.id("hex").slice(0, 8)}…)`);
  check((await holdsOn("a", p.id("hex"))).via === "admitted", `a holds p now (${(await holdsOn("a", p.id("hex"))).via})`);
  // a's admission gossips the transfer: b takes it, and c (which lacks p) pauses it and wants p of the topic's peers.
  const everywhere = await until("b and c admit the transfer", async () => ((await admittedIn(storeOf("b"), x.id("hex"))) && (await admittedIn(storeOf("c"), x.id("hex")))) || undefined, 60_000).catch(() => false);
  check(everywhere && (await holdsOn("c", p.id("hex"))).via === "admitted", "the transfer gossiped from a: b admits it, c admits it once p comes through its own want");
  await quiet();
} catch (e) {
  check(false, `threw: ${(e as Error).stack}`);
} finally {
  for (const h of names) await routers[h]?.stop();
  await arcade.close();
  for (const h of names) dbs[h]?.close();
  for (const store of new Set(stores)) {
    const rp = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), store], { encoding: "utf8" });
    process.stdout.write(rp.stdout);
    if (rp.status !== 0) process.stdout.write(rp.stderr);
    check(rp.status === 0 && /identical .*the source store reproduced exactly/.test(rp.stdout), `${store.split("/").at(-2)}'s store replays to itself exactly`);
  }
}
if (process.env.KEEP) process.stdout.write(`kept ${home}\n`); else rmSync(home, { recursive: true, force: true });
process.stdout.write(failures ? `sync: ${failures} FAILED\n` : "sync: all ok\n");
process.exit(failures ? 1 : 0);

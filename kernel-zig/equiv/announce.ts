// The settled overlay sync design (David 2026-10-30; shruggr/skein-overlay
// 0.20.0, the host's sync.ts) end to end over libp2p: shruggr/skein-chain 0.7.1
// and shruggr/skein-overlay 0.20.0 (pinned commits, or $SKEIN_CHAIN_DIR /
// $SKEIN_OVERLAY_DIR) installed by the owner's messages into stock-system
// instances on three routers — a in the middle, b and c each connected to a
// only — one topic tm_ann registered on each, the validator beating every
// 2 s. Unmined transactions only (nothing is mined here):
//
//   (i)   announce, then fetch: t1 posted to b; b admits it and publishes its
//         admit; a's host fetches t1 from b ({kind: "tx"} on
//         /skein/overlay/sync/1.0.0), admits it and publishes its own admit;
//         c, which hears only a (no connection to b ever), fetches t1 from a.
//   (ii)  a fetch that fails moves to the next announcing peer and stops when
//         none is left: b announces t3, which b does not hold (an admit
//         published from b's node by hand); a asks b once, the BEEF absent,
//         and the set is exhausted — no further ask, however long; t3 posted
//         to c, c's admit adds c to the set: one more try, from c, taken.
//   (iii) a beacon replace does not publish: a burst of admissions on a, each
//         a new beat body re-declared, while a's beats on tm_ann-live are
//         counted: at most the timer's ticks.
//   (iv)  tail reconcile: c down (and its remembered peers forgotten) while
//         t4 is posted to b (a fetches it); c back: no admit reaches it, but
//         a's or b's next beat shows a tail digest unlike c's with the mined
//         side equal (nothing mined) → c asks that peer's tail and fetches t4.
//   (v)   persisted peers: c down while t5 is posted to b (a fetches it); a's
//         and b's beacons stopped (no beat at all from here on); c back: its
//         host.db names the peers its topic heard beats from; it dials them
//         at once and runs the locator and the tail — t5 arrives with no beat.
//
// Each instance's store then replays to itself exactly.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/announce.ts

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as dagCbor from "@ipld/dag-cbor";
import { MerklePath, P2PKH, PrivateKey, Script, Transaction, UnlockingScript } from "@bsv/sdk";
import { ownerCli } from "../../src/testapps.ts";
import { RawBox } from "../../src/client/raw.ts";
import { storeSpec } from "../../src/runtime/index-store.ts";
import { openStoreFile } from "../../src/host/stores.ts";
import { BACKEND, routerStore, storeFor } from "./backend.ts";
import { FakeArcade } from "../../src/host/fake-arcade.ts";
import { HostDb } from "../../src/host/instances.ts";
import { Signer } from "../../src/host/signer.ts";
import { emittedEvents, peerIdOf } from "../../src/host/p2p.ts";
import { SYNC_PROTOCOL } from "../../src/host/sync.ts";
import { Router } from "../../src/host/router.ts";
import { ephemeralWallet } from "../../src/wallet.ts";

const OVERLAY_REPO = "https://github.com/shruggr/skein-overlay";
const OVERLAY_REV = process.env.SKEIN_OVERLAY_REV ?? "a9ec5ee9ed7aeab011b9458c99ad1d6802d8f60c"; // v0.20.0
const CHAIN_REPO = "https://github.com/shruggr/skein-chain";
const CHAIN_REV = process.env.SKEIN_CHAIN_REV ?? "7da428422ce193a1bb489163637f070860d46ccd"; // v0.7.1
const TOPIC = "tm_ann";
const EVERY = 2000;
const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
const home = mkdtempSync(join(tmpdir(), "skein-kz-announce-"));
let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };
const say = (s: string) => process.stdout.write(`     ${s}\n`);

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

// ---------------------------------------------------------------- regtest: one funding transaction at 1

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

// ---------------------------------------------------------------- three routers: b — a — c

const key = (h: string) => new PrivateKey(h, 16);
const ownerKey = key("2222");
const owner = ownerKey.toPublicKey().toString();
const ownerWallet = ephemeralWallet(ownerKey);
const signer = new Signer(new PrivateKey("5c5d5e", 16));
const arcade = await FakeArcade.start();
const names = ["a", "b", "c"] as const;
type Name = typeof names[number];
const ports: Record<Name, number> = { a: await freePort(), b: await freePort(), c: await freePort() };
const idOf = (h: string) => peerIdOf(signer.peerKey(h)).toString();
const addr = (h: Name) => `/ip4/127.0.0.1/tcp/${ports[h]}/p2p/${idOf(h)}`;
/** a in the middle: b and c each know (and dial) a only. */
const knows: Record<Name, Name[]> = { a: ["b", "c"], b: ["a"], c: ["a"] };
const walletKeys: Record<string, string> = { a: "1121", b: "1122", c: "1123" };
const dbs: Partial<Record<Name, HostDb>> = {};
const routers: Partial<Record<Name, Router>> = {};
const lines: string[] = [];
const log = (who: string) => (s: string, l: string) => {
  if (/^sync: /.test(l)) lines.push(`${who} ${l}`);
  if (process.env.VERBOSE || /^sync: /.test(l)) process.stdout.write(`  | [${who}:${s}] ${l}\n`);
};
const homeOf = (h: Name) => join(home, h);
function router(h: Name): Router {
  if (!dbs[h]) {
    mkdirSync(homeOf(h), { recursive: true });
    dbs[h] = new HostDb(join(homeOf(h), "host.db"));
    dbs[h]!.add(h, { store: storeFor(homeOf(h), h) });
  }
  return new Router({
    db: dbs[h]!, walletFor: (row) => ephemeralWallet(key(walletKeys[row.handle]!)), home: homeOf(h), owner, idleMs: 0,
    providerKeyFor: (n: string) => signer.providerKey(n), peerKeyFor: (x: string) => signer.peerKey(x), answerWaitMs: 6000,
    kernel: { command: kernel, env: { SKEIN_HOME: homeOf(h) } }, ...routerStore(homeOf(h)), libp2pDiscoveryMs: 300,
    genesis: { defaults: { walletNetwork: "regtest" } },
    arc: { url: arcade.url, token: "the-host-arcade-token", events: arcade.eventsUrl }, arcRetry: { min: 500, max: 2000 },
    libp2p: { listen: [`/ip4/127.0.0.1/tcp/${ports[h]}`], bootstrap: knows[h].map(addr), dht: "off", relays: [], mdns: false },
    log: log(h),
  });
}
const r = (h: Name) => routers[h]!;
const storeOf = (h: Name) => storeSpec(dbs[h]!.get(h)!);
const stores: string[] = [];

const alice = key("3344");
const fund = new Transaction();
fund.addInput({ sourceTXID: "73".repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex("51"), sequence: 0xffffffff });
for (let i = 0; i < 12; i++) fund.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 10_000 });
const fundTxid = fund.id("hex");
fund.merklePath = new MerklePath(1, [[{ offset: 0, hash: "cb".repeat(32) }, { offset: 1, hash: fundTxid, txid: true }]]);
const h1 = mine(sha256d(REGTEST_GENESIS), sha256d(Buffer.concat([internal("cb".repeat(32)), internal(fundTxid)])), 1_790_400_000);
const tokenScript = () => Script.fromBinary([0x07, ...Buffer.from("tm_demo"), 0x75, ...new P2PKH().lock(alice.toPublicKey().toHash()).toBinary()]);
async function token(vout: number): Promise<Transaction> {
  const t = new Transaction();
  t.addInput({ sourceTransaction: fund, sourceOutputIndex: vout, unlockingScriptTemplate: new P2PKH().unlock(alice), sequence: 0xffffffff });
  t.addOutput({ lockingScript: tokenScript(), satoshis: 1 });
  t.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 9_000 });
  await t.sign();
  return t;
}

const origin = (h: Name) => r(h).originOf(h);
const holds = async (h: Name, txid: string) => !!(await (await fetch(`${origin(h)}/overlay/holds?txid=${txid}`)).json() as { via?: string }).via;
const submit = async (h: Name, t: Transaction) => {
  const res = await fetch(`${origin(h)}/overlay/submit`, { method: "POST", headers: { "x-topics": TOPIC }, body: Uint8Array.from(t.toBEEF()) });
  return { status: res.status, text: await res.text() };
};
const subscribers = (h: Name, topic: string) => ((r(h).p2p?.node(h)?.services as { pubsub: { getSubscribers(t: string): unknown[] } } | undefined)?.pubsub.getSubscribers(topic).length ?? 0);
const connected = (x: Name, y: Name) => (r(x).p2p?.node(x)?.getConnections().filter((c) => c.remotePeer.toString() === idOf(y)).length ?? 0) > 0;

/** Each router's sync requests, by kind and peer (`${peer} ${kind} ${txid?}`), counted from now on (a wrapper on its node's request). */
const asked: Record<Name, string[]> = { a: [], b: [], c: [] };
function watchRequests(h: Name): void {
  const p2p = r(h).p2p!;
  const inner = p2p.request.bind(p2p);
  p2p.request = async (handle, peer, protocol, body, timeoutMs) => {
    if (protocol === SYNC_PROTOCOL) {
      const f = dagCbor.decode(body) as { kind?: string; txid?: string };
      asked[h].push(`${names.find((n) => idOf(n) === peer) ?? peer} ${f.kind}${f.txid ? ` ${f.txid}` : ""}`);
    }
    return inner(handle, peer, protocol, body, timeoutMs);
  };
}
/** Each router's beats published on <TOPIC>-live (a wrapper on its node's publish). */
const beats: Record<Name, number[]> = { a: [], b: [], c: [] };
function watchBeats(h: Name): void {
  const p2p = r(h).p2p!;
  const inner = p2p.publish.bind(p2p);
  p2p.publish = async (handle, topic, body) => {
    if (topic === `${TOPIC}-live`) beats[h].push(Date.now());
    return inner(handle, topic, body);
  };
}

let overlayDir = "";
let chainDir = "";
async function up(h: Name): Promise<void> {
  routers[h] = router(h);
  await r(h).listen(0);
  await r(h).hydrate(h);
  if (!stores.includes(storeOf(h))) stores.push(storeOf(h));
  watchRequests(h);
  watchBeats(h);
}
async function bring(h: Name): Promise<void> {
  await up(h);
  const host = { home: homeOf(h), port: r(h).port!, owner: ownerWallet, settled: () => r(h).settled() };
  for (const dir of [chainDir, overlayDir]) {
    const o = await ownerCli(host, ["install", dir, "--instance", h]);
    if (o.code !== 0) throw new Error(`${h}: install ${dir}: ${o.err.join(" ")}`);
    await r(h).settled();
  }
  const identity = (await r(h).hydrate(h)).identity;
  await new RawBox(ownerWallet, `http://127.0.0.1:${r(h).port}/@${h}`).send(identity, "overlay/register", { fn: "register", args: { topic: TOPIC, program: "topic-demo" } });
  await r(h).settled();
  await r(h).chainHeaders(h, "chain", [h1]);
  await r(h).settled();
}

try {
  overlayDir = checkout(process.env.SKEIN_OVERLAY_DIR, OVERLAY_REPO, OVERLAY_REV, join(home, "overlay"));
  chainDir = checkout(process.env.SKEIN_CHAIN_DIR, CHAIN_REPO, CHAIN_REV, join(home, "chain"));
  const mf = JSON.parse(readFileSync(join(overlayDir, "etc/app.json"), "utf8")) as { version: string; config: { overlay: Record<string, unknown> } };
  mf.config.overlay.validator = { every: EVERY };
  mf.config.overlay.gossip = { tm_demo: false };
  writeFileSync(join(overlayDir, "etc/app.json"), JSON.stringify(mf, null, 2));
  check(mf.version === "0.20.0", `skein-overlay ${mf.version} at ${OVERLAY_REV.slice(0, 7)}; beats every ${EVERY} ms`);

  for (const h of names) await bring(h);
  await until("a meshed with b and c on tm_ann", () => (subscribers("a", TOPIC) >= 2 && subscribers("b", TOPIC) > 0 && subscribers("c", TOPIC) > 0) || undefined);
  await sleep(1500);

  // ------------------------------------------------ (i) announce, then fetch: b → a → c, one hop at a time
  const t1 = await token(0);
  const s1 = await submit("b", t1);
  check(s1.status === 200, `(i) t1 (unmined) posted to b: ${s1.status} ${s1.text.slice(0, 80)}`);
  const got1 = await until("a and c hold t1", async () => (await holds("a", t1.id("hex")) && await holds("c", t1.id("hex"))) || undefined, 30_000).catch(() => false);
  check(got1 === true, "(i) a fetched t1 from b on b's admit, admitted it; c fetched it from a on a's admit");
  check(asked.a.includes(`b tx ${t1.id("hex")}`) && asked.c.includes(`a tx ${t1.id("hex")}`) && !asked.c.some((x) => x.startsWith("b ")), `(i) a asked b, c asked a (c never asked b): a ${JSON.stringify(asked.a.filter((x) => x.endsWith(t1.id("hex"))))}, c ${JSON.stringify(asked.c.filter((x) => x.endsWith(t1.id("hex"))))}`);
  check(!connected("c", "b") && !connected("b", "c"), "(i) b and c never connected: c heard only a's admit");
  check(asked.a.filter((x) => x.endsWith(t1.id("hex"))).length === 1 && asked.c.filter((x) => x.endsWith(t1.id("hex"))).length === 1, "(i) each node fetched t1 once");

  // ------------------------------------------------ (ii) a failing fetch: the next announcing peer; exhausted, it stops
  const t3 = await token(2);
  const t3id = t3.id("hex");
  const forged = dagCbor.encode({ kind: "admit", txid: t3id, topics: { [TOPIC]: { outputsToAdmit: [0], coinsToRetain: [] } } });
  await r("b").p2p!.publish("b", TOPIC, forged); // b announces t3, which b does not hold
  await until("a asks b for t3", () => asked.a.includes(`b tx ${t3id}`) || undefined, 15_000).catch(() => undefined);
  await sleep(4000); // longer than any old want delay (2 s, doubling): no ask on a clock
  const pend = r("a").sync!.pending("a").find((x) => x.txid === t3id);
  check(asked.a.filter((x) => x.endsWith(t3id)).length === 1 && !!pend && !pend.fetching && pend.peers.join() === idOf("b"), `(ii) b's announcement fetched once from b (no beef), the set [b] exhausted, kept, nothing asked again: ${JSON.stringify(asked.a.filter((x) => x.endsWith(t3id)))} ${JSON.stringify(pend && { fetching: pend.fetching, peers: pend.peers.length })}`);
  check(!(await holds("a", t3id)), "(ii) a does not hold t3");
  const s3 = await submit("c", t3);
  check(s3.status === 200, `(ii) t3 posted to c: ${s3.status}`);
  const got3 = await until("a holds t3", async () => (await holds("a", t3id)) || undefined, 30_000).catch(() => false);
  check(got3 === true, "(ii) c's admit added c to the set: one more try, from c — taken");
  check(asked.a.filter((x) => x.endsWith(t3id)).join(" | ") === `b tx ${t3id} | c tx ${t3id}`, `(ii) a asked b, then c, once each: ${asked.a.filter((x) => x.endsWith(t3id)).map((x) => x.split(" ")[0]).join(" → ")}`);
  check(!r("a").sync!.pending("a").some((x) => x.txid === t3id), "(ii) the entry dropped on its taking");

  // ------------------------------------------------ (iii) a beacon replace does not publish
  const beaconsOn = async (h: Name) => { const v = openStoreFile(storeOf(h), { readOnly: true }); try { return (await emittedEvents(v, (rec) => rec.event === "beacon" && rec.topic === `${TOPIC}-live` ? rec : undefined)).length; } finally { await v.close(); } };
  await r("a").settled();
  const declared0 = await beaconsOn("a");
  const w0 = Date.now();
  const beats0 = beats.a.length;
  for (let i = 0; i < 3; i++) { const t = await token(4 + i); const s = await submit("a", t); check(s.status === 200, `(iii) burst ${i + 1} posted to a: ${s.status}`); }
  await r("a").settled();
  const w1 = Date.now();
  await sleep(Math.max(0, w0 + 3 * EVERY - w1));
  const elapsed = Date.now() - w0;
  const published = beats.a.length - beats0;
  const declared = (await beaconsOn("a")) - declared0;
  const ticks = Math.ceil(elapsed / EVERY) + 1; // the timer's ticks in the window, one of slack (a replace that published would add one per body: 3)
  say(`(iii) over ${elapsed} ms: ${declared} beacon declarations on a, ${published} beats published (at most ${ticks} timer ticks)`);
  check(declared >= 3 && published <= ticks, `(iii) ${declared} re-declared bodies, ${published} beats: the timer's ticks only, no publish on a replace`);

  // ------------------------------------------------ (iv) tail reconcile: c misses t4's admit
  await r("c").stop();
  dbs.c!.prunePeers(Number.MAX_SAFE_INTEGER); // c remembers no peer: only a beat brings it back
  const t4 = await token(8);
  const s4 = await submit("b", t4);
  check(s4.status === 200, `(iv) t4 posted to b while c is down: ${s4.status}`);
  await until("a holds t4", async () => (await holds("a", t4.id("hex"))) || undefined, 30_000);
  const before4 = lines.length;
  await up("c");
  const got4 = await until("c holds t4", async () => (await holds("c", t4.id("hex"))) || undefined, 30_000).catch(() => false);
  const tailLines = lines.slice(before4).filter((l) => l.startsWith("c ") && /'s tail: /.test(l));
  check(got4 === true && tailLines.length > 0, `(iv) c back, no admit for t4 reaches it: a beat's tail digest differs, c asks the tail and fetches t4 (${tailLines.join(" | ") || "no tail line"})`);
  check(asked.c.some((x) => / tail$/.test(x)) && asked.c.some((x) => x.endsWith(`tx ${t4.id("hex")}`)), `(iv) c's asks: ${JSON.stringify(asked.c.filter((x) => / tail$/.test(x) || x.endsWith(t4.id("hex"))))}`);

  // ------------------------------------------------ (v) persisted peers: a restart catches up with no beat at all
  await sleep(2 * EVERY + 500); // c's host.db learns its peers from the beats it keeps
  const remembered = dbs.c!.topicPeers("c", TOPIC);
  check(remembered.some((x) => x.peer === idOf("a") && x.addrs.length > 0), `(v) c's host.db remembers the peers its topic heard beats from: ${remembered.map((x) => `${names.find((n) => idOf(n) === x.peer) ?? x.peer} (${x.addrs.length} addrs)`).join(", ")}`);
  await r("c").stop();
  const t5 = await token(9);
  const s5 = await submit("b", t5);
  check(s5.status === 200, `(v) t5 posted to b while c is down: ${s5.status}`);
  await until("a holds t5", async () => (await holds("a", t5.id("hex"))) || undefined, 30_000);
  for (const h of ["a", "b"] as const) r(h).p2p!.beacons(h, []); // no beat from here on
  await sleep(500);
  const beatsAB = beats.a.length + beats.b.length;
  const t0 = Date.now();
  await up("c");
  const got5 = await until("c holds t5", async () => (await holds("c", t5.id("hex"))) || undefined, 30_000).catch(() => false);
  check(got5 === true, `(v) c back: t5 fetched within ${Date.now() - t0} ms, asked at start from the remembered peers`);
  check(beats.a.length + beats.b.length === beatsAB, `(v) no beat from a or b while c caught up (${beats.a.length + beats.b.length - beatsAB})`);
  check(asked.c.slice(-6).some((x) => x === "a locator") && asked.c.some((x) => x === "a tail"), `(v) c asked a the locator and the tail: ${JSON.stringify(asked.c.slice(-6))}`);
  await sleep(1000);
  for (const h of names) await routers[h]?.settled();
} catch (e) {
  check(false, `threw: ${(e as Error).stack}`);
} finally {
  for (const h of names) await routers[h]?.stop();
  await arcade.close();
  for (const h of names) dbs[h]?.close();
  for (const store of stores) {
    const rp = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), store], { encoding: "utf8" });
    process.stdout.write(rp.stdout);
    if (rp.status !== 0) process.stdout.write(rp.stderr);
    check(rp.status === 0 && /identical .*the source store reproduced exactly/.test(rp.stdout), `${store.split("/").at(-2)}'s store replays to itself exactly`);
  }
}
if (process.env.KEEP) process.stdout.write(`kept ${home}\n`); else rmSync(home, { recursive: true, force: true });
process.stdout.write(failures ? `announce (${BACKEND}): ${failures} FAILED\n` : `announce (${BACKEND}): all ok\n`);
process.exit(failures ? 1 : 0);

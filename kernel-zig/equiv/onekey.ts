// The one-key host (shruggr/skein#160, #161, #162) end to end: a host O
// provisioned with ONE key (Signer.oneKey: SKEIN_KEY_FILE) runs three
// instances — two path-only ones whose handles are token ids, T0 =
// `<txid>_0` and T1 = `<txid>_1`, and `alice` — beside a second host D in
// master-key mode (its own derived keys, one instance `dd`):
//
//   (a) every row the same identity and peer ID (`skein-host add` and
//       `skein-host identity --peer` through the one-key signer); the
//       instances' signer, asked over the wallet wire (what a step's `wallet`
//       import is answered by) for [2, "skein instance"] / `libp2p:<handle>`
//       / self, answers the node's peer key for T0 and for alice;
//   (b) ONE libp2p node for them (one listen address set, `skein-host list`'s
//       peer column one ID); a message D publishes on tm_color_T0 reaches T0
//       alone; one on okt_both (T0 and T1 take it) reaches both;
//   (c) a stream on /skein/overlay/sync/1.0.0 (T0 declares it — the overlay's
//       row — and T1, an app's row) whose first frame names T1's topic lands
//       in T1; a frame naming no topic on a protocol only alice declares
//       lands in alice; on one T1 and alice both declare it is answered
//       {kind: "error", message: "topic required"} and closed;
//   (d) /@T0/… serves T0; at the bare host, POST /submit with X-Topics
//       tm_color_T1 goes to T1, POST /lookup for ls_color_T0 to T0, mixed
//       topics are 400;
//   (e) alice (SKEIN_MANAGER_FOR) has the instance manager in her address
//       book and asks it to create T2 from the image `okimg`
//       ($SKEIN_HOME/images/okimg) with `config`: the row is there, enabled,
//       claimed by the shared key, its app record's config the one asked;
//       (skein-amm#4) the image carries the chain app and the overlay
//       (skein-overlay 0.17.0), the create's config names T2's topic, a
//       lookup and terms, and its `beef` is a mined token: answered
//       delivered {verdict: "accept"}, admitted under the configured topic,
//       the topic and the lookup beating on <name>-live with the configured
//       terms; stop disables it and takes it off the node, start brings it
//       and its beats back; a create with an unmined BEEF answers delivered
//       {verdict: ignore|reject, reason}, the instance created and enabled;
//       T1 (not named) is not acted on; on D (master key) a
//       create with no claim is refused as before;
//   (f) D's dd syncs tm_color_T0 from T0 (the #150 sync path: the locator and
//       the pulls over /skein/overlay/sync/1.0.0, answered through O's shared
//       node by T0's engine) to equal anchors;
//   (g) #137: alice creates `discovery` (a hostname handle) from the same
//       image with tm_color and ls_color configured, NO beef, and
//       `topics: ["tm_color", "ls_color"]`: at once (no request to
//       it first, never stepped) a BEEF POSTed at the bare host with X-Topics
//       tm_color is routed to it (by its host.db row's topics) and admitted
//       there; POST /lookup {service: ls_color} is routed to it; the
//       token instance T2 (created with its own topics) still routed; a
//       start with `topics` replaces the row's; stopped, tm_color falls
//       through again;
//   timings: a gossip message's fan-out to 8 handles on the one node; the
//       create-by-emit latency.
//
// Every instance's store then replays to itself exactly (after the processes stop).
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/onekey.ts     (SKEIN_EQUIV_STORE=rocksdb: on RocksDB)

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MerklePath, P2PKH, PrivateKey, Script, Transaction, UnlockingScript, WalletWireProcessor, WalletWireTransceiver } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { ownerCli } from "../../src/testapps.ts";
import { RawBox } from "../../src/client/raw.ts";
import { storeSpec } from "../../src/runtime/index-store.ts";
import { encode } from "../../src/runtime/cid.ts";
import { BACKEND, routerStore, storeFor } from "./backend.ts";
import { FakeArcade } from "../../src/host/fake-arcade.ts";
import { HostDb } from "../../src/host/instances.ts";
import { Signer } from "../../src/host/signer.ts";
import { keyOfPeerId, peerIdOf, type Frame } from "../../src/host/p2p.ts";
import { Router } from "../../src/host/router.ts";
import { main } from "../../src/host/cli.ts";
import { appHead } from "../../src/host/plan.ts";
import { SYNC_PROTOCOL } from "../../src/host/sync.ts";
import type { MailRecord } from "../../src/host/providers.ts";
import { ephemeralWallet } from "../../src/wallet.ts";

const OVERLAY_REPO = "https://github.com/shruggr/skein-overlay";
const OVERLAY_REV = process.env.SKEIN_OVERLAY_REV ?? "9d72ecae2e3cd20728136bd9b649c63e9fb9b857"; // v0.17.0: configured topics and lookups beat (skein-amm#4)
const CHAIN_REPO = "https://github.com/shruggr/skein-chain";
const CHAIN_REV = process.env.SKEIN_CHAIN_REV ?? "4d3f595c0f073db63223907fcd0909d53e770b91";
const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
const home = mkdtempSync(join(tmpdir(), "skein-kz-onekey-"));
let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };
const timings: string[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, f: () => Promise<T | undefined> | T | undefined, ms = 30_000): Promise<T> {
  for (const end = Date.now() + ms; ;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
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
const hex = (b: unknown) => b instanceof Uint8Array ? Buffer.from(b).toString("hex") : String(b);

// ---------------------------------------------------------------- regtest (as equiv/sync.ts)

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

// ---------------------------------------------------------------- the two hosts

const key = (h: string) => new PrivateKey(h, 16);
const ownerKey = key("2222");
const owner = ownerKey.toPublicKey().toString();
const ownerWallet = ephemeralWallet(ownerKey);
const shared = key("0e0e0e");
const one = Signer.oneKey(shared);
const derived = new Signer(key("d1d1d1"));
const TXID = createHash("sha256").update("the one-key host").digest("hex");
const T0 = `${TXID}_0`, T1 = `${TXID}_1`, T2 = `${TXID}_2`;
const topicOf = (h: string) => `tm_color_${h}`;
const BOTH = "okt_both";
const ALICE_P = "/onekey/alice/1.0.0", TWO_P = "/onekey/two/1.0.0";
const EXTRA = [3, 4, 5, 6, 7, 8].map((i) => `${TXID}_${i}`); // with T0 and T1: 8 handles taking okt_both
const homeO = join(home, "o"), homeD = join(home, "d");
mkdirSync(join(homeO, "images"), { recursive: true });
mkdirSync(homeD, { recursive: true });
const keyFile = join(homeO, "shared.key");
writeFileSync(keyFile, `${shared.toHex().padStart(64, "0")}\n`, { mode: 0o600 });
const ports = { o: await freePort(), d: await freePort() };
const oPeer = peerIdOf(one.peerKey("any")).toString();
const dPeer = peerIdOf(derived.peerKey("dd")).toString();
const arcade = await FakeArcade.start();
const lines: string[] = [];
const log = (who: string) => (s: string, l: string) => { lines.push(`[${who}:${s}] ${l}`); if (process.env.VERBOSE || /^sync: /.test(l)) process.stdout.write(`  | [${who}:${s}] ${l}\n`); };
const cliVars = { SKEIN_HOME: homeO, HOME: homeO, SKEIN_KEY_FILE: keyFile, SKEIN_KERNEL_BIN: kernel, ...(BACKEND === "rocksdb" ? { SKEIN_STORE_ROCKSDB: join(homeO, "store-rocksdb") } : BACKEND === "lmdb" ? { SKEIN_STORE: join(homeO, "store") } : {}) };
async function cli(args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [], err: string[] = [];
  const code = await main(args, { vars: cliVars, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

// O's rows, by `skein-host add` through the one-key signer (#160).
for (const h of [T0, T1, "alice"]) {
  const a = await cli(["add", h]);
  if (a.code !== 0) throw new Error(`skein-host add ${h}: ${a.err.join(" ")}`);
}
const dbO = new HostDb(join(homeO, "host.db"));
const dbD = new HostDb(join(homeD, "host.db"));
dbD.add("dd", { store: storeFor(homeD, "dd") });
const common = { owner, idleMs: 0, answerWaitMs: 6000, libp2pDiscoveryMs: 300, genesis: { defaults: { walletNetwork: "regtest" } }, arc: { url: arcade.url, token: "the-host-arcade-token", events: arcade.eventsUrl }, arcRetry: { min: 500, max: 2000 } };
const rO = new Router({
  ...common, db: dbO, home: homeO, ...routerStore(homeO), kernel: { command: kernel, env: { SKEIN_HOME: homeO } },
  walletFor: (row) => one.wallet(row.handle), providerKeyFor: (n) => one.providerKey(n), peerKeyFor: (x) => one.peerKey(x),
  claimer: one.wallet(""), managerFor: ["alice"], imagesDir: join(homeO, "images"),
  libp2p: { listen: [`/ip4/127.0.0.1/tcp/${ports.o}`], bootstrap: [`/ip4/127.0.0.1/tcp/${ports.d}/p2p/${dPeer}`], dht: "off", relays: [], mdns: false },
  log: log("o"),
});
const rD = new Router({
  ...common, db: dbD, home: homeD, ...routerStore(homeD), kernel: { command: kernel, env: { SKEIN_HOME: homeD } },
  walletFor: (row) => derived.wallet(row.handle), providerKeyFor: (n) => derived.providerKey(n), peerKeyFor: (x) => derived.peerKey(x),
  managerFor: ["dd"],
  genesis: { ...common.genesis, libp2p: { topics: [topicOf(T0), topicOf(T1), BOTH] } },
  libp2p: { listen: [`/ip4/127.0.0.1/tcp/${ports.d}`], bootstrap: [`/ip4/127.0.0.1/tcp/${ports.o}/p2p/${oPeer}`], dht: "off", relays: [], mdns: false },
  log: log("d"),
});

// ---------------------------------------------------------------- the test app: app-demo's module, its libp2p rows per instance
const wasm = join(here, "../../programs/test/app-demo/bin/app-demo.wasm");
function appTree(dirName: string, rows: Array<Record<string, unknown>>): string {
  const dir = join(home, "apps", dirName);
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "etc"), { recursive: true });
  copyFileSync(wasm, join(dir, "bin/app-demo.wasm"));
  writeFileSync(join(dir, "etc/app.json"), JSON.stringify({
    kind: "app", name: "okt", version: "0.1.0", programs: { demo: "bin/app-demo.wasm" }, provides: [], requires: [],
    routes: [{ address: "", handler: "demo" }, ...rows.map((r) => ({ transport: "libp2p", handler: "demo.topic", ...r }))],
    description: "#160's test app: app-demo's module, recording what reaches it over libp2p under okt/seen",
  }, null, 2));
  return dir;
}
const oktOf: Record<string, string> = {
  [T0]: appTree("t0", [{ address: topicOf(T0) }, { address: BOTH }]),
  [T1]: appTree("t1", [{ address: topicOf(T1) }, { address: BOTH }, { address: SYNC_PROTOCOL }, { address: TWO_P }]),
  alice: appTree("alice", [{ address: ALICE_P }, { address: TWO_P }]),
};
for (const [i, h] of EXTRA.entries()) oktOf[h] = appTree(`x${i}`, [{ address: BOTH }]);

/** The body of the last libp2p request that reached `h`'s okt (its head okt/seen), and the head. */
async function seen(h: string): Promise<{ head: string; body?: Uint8Array; topic?: unknown } | undefined> {
  const l = await rO.hydrate(h);
  const c = await l.kernel.call("head", "okt/seen") as CID | null;
  if (!c) return undefined;
  const r = await l.kernel.store.get(c) as Record<string, unknown>;
  let req = r.request as Record<string, unknown> | CID | undefined;
  if (req && CID.asCID(req)) req = await l.kernel.store.get(req as CID) as Record<string, unknown>;
  const body = (req as Record<string, unknown> | undefined)?.body;
  return { head: c.toString(), ...(body instanceof Uint8Array ? { body } : {}), topic: r.topic };
}
const has = (s: { body?: Uint8Array } | undefined, b: Uint8Array) => !!s?.body && Buffer.from(s.body).equals(Buffer.from(b));
const installOkt = async (h: string) => {
  const o = await ownerCli({ home: homeO, port: rO.port!, owner: ownerWallet, settled: () => rO.settled() }, ["install", oktOf[h]!, "--instance", h]);
  if (o.code !== 0) throw new Error(`${h}: install okt: ${o.err.join(" ")}`);
};

// ---------------------------------------------------------------- the chain (as equiv/sync.ts)
const holder = key("3333");
const fund = new Transaction();
fund.addInput({ sourceTXID: "72".repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex("51"), sequence: 0xffffffff });
for (let i = 0; i < 4; i++) fund.addOutput({ lockingScript: new P2PKH().lock(holder.toPublicKey().toHash()), satoshis: 10_000 });
const fundTxid = fund.id("hex");
fund.merklePath = new MerklePath(1, [[{ offset: 0, hash: "cb".repeat(32) }, { offset: 1, hash: fundTxid, txid: true }]]);
const headers: Uint8Array[] = [mine(sha256d(REGTEST_GENESIS), sha256d(Buffer.concat([internal("cb".repeat(32)), internal(fundTxid)])), 1_790_200_000)];
const tokenScript = () => Script.fromBinary([0x07, ...Buffer.from("tm_demo"), 0x75, ...new P2PKH().lock(holder.toPublicKey().toHash()).toBinary()]);
async function token(source: Transaction, vout: number, change = 9_000): Promise<Transaction> {
  const t = new Transaction();
  t.addInput({ sourceTransaction: source, sourceOutputIndex: vout, unlockingScriptTemplate: new P2PKH().unlock(holder), sequence: 0xffffffff });
  t.addOutput({ lockingScript: tokenScript(), satoshis: 1 });
  t.addOutput({ lockingScript: new P2PKH().lock(holder.toPublicKey().toHash()), satoshis: change });
  await t.sign();
  return t;
}
function mineAlone(t: Transaction): number {
  const height = headers.length + 1;
  const cb = (height * 17 % 256).toString(16).padStart(2, "0").repeat(32);
  t.merklePath = new MerklePath(height, [[{ offset: 0, hash: cb }, { offset: 1, hash: t.id("hex"), txid: true }]]);
  headers.push(mine(sha256d(headers.at(-1)!), sha256d(Buffer.concat([internal(cb), internal(t.id("hex"))])), 1_790_200_000 + height * 600));
  return height;
}
const feedHeaders = async (r: Router, h: string, from = 1) => {
  for (let i = from; i <= headers.length; i++) await r.chainHeaders(h, "chain", [headers[i - 1]!]);
  await r.settled();
};
const anchorsAt = async (url: string) => {
  const res = await fetch(`${url}/overlay/anchors?topic=${topicOf(T0)}`);
  if (res.status !== 200) return undefined;
  const x = await res.json() as { genesisHeight?: number; tipHeight?: number; anchors: Array<{ height: number; anchor: string }> };
  return x.tipHeight === undefined ? undefined : { genesis: x.genesisHeight!, tip: x.tipHeight, anchor: x.anchors.find((y) => y.height === x.tipHeight)!.anchor };
};
/** The overlay and the chain app installed by the owner into `h` on router `r` (its host's home), tm_color_T0 registered (topic-demo: tm_demo tokens). */
async function overlayInto(r: Router, homeDir: string, h: string, chainDir: string, overlayDir: string): Promise<void> {
  const host = { home: homeDir, port: r.port!, owner: ownerWallet, settled: () => r.settled() };
  for (const dir of [chainDir, overlayDir]) {
    const o = await ownerCli(host, ["install", dir, "--instance", h]);
    if (o.code !== 0) throw new Error(`${h}: install ${dir}: ${o.err.join(" ")}`);
    await r.settled();
  }
  const identity = (await r.hydrate(h)).identity;
  await new RawBox(ownerWallet, `http://127.0.0.1:${r.port}/@${h}`).send(identity, "overlay/register", { fn: "register", args: { topic: topicOf(T0), program: "topic-demo" } });
  await r.settled();
}

const stores: string[] = [];
const handleOf = new Map<string, string>();
try {
  const overlayDir = checkout(process.env.SKEIN_OVERLAY_DIR, OVERLAY_REPO, OVERLAY_REV, join(home, "overlay"));
  const chainDir = checkout(process.env.SKEIN_CHAIN_DIR, CHAIN_REPO, CHAIN_REV, join(home, "chain"));
  const mf = JSON.parse(readFileSync(join(overlayDir, "etc/app.json"), "utf8")) as { version: string; config: { overlay: Record<string, unknown> } };
  mf.config.overlay.validator = { every: 1000 };
  writeFileSync(join(overlayDir, "etc/app.json"), JSON.stringify(mf, null, 2));

  await rO.listen(0);
  await rD.listen(0);
  for (const h of [T0, T1, "alice"]) { await rO.hydrate(h); { stores.push(storeSpec(dbO.get(h)!)); handleOf.set(storeSpec(dbO.get(h)!), h); } }
  await rD.hydrate("dd");
  stores.push(storeSpec(dbD.get("dd")!)); handleOf.set(storeSpec(dbD.get("dd")!), "dd (D)");

  // ------------------------------------------------ (a) one identity, one peer ID
  const ids = [T0, T1, "alice"].map((h) => dbO.get(h)!.identity);
  check(ids.every((x) => x === shared.toPublicKey().toString()), `(a) skein-host add records the shared key's identity on every row, a token id's too (${ids.map((x) => x?.slice(0, 10)).join(", ")})`);
  const peers = await Promise.all([T0, T1, "alice"].map(async (h) => (await cli(["identity", h, "--peer"])).out[0]));
  check(peers.every((p) => p === oPeer), `(a) skein-host identity --peer: one peer ID for all three (${oPeer})`);
  for (const h of [T0, "alice"]) {
    // The wire a step's `wallet` import is answered over (kernel.ts: a WalletWireProcessor over the row's signer).
    const w = new WalletWireTransceiver(new WalletWireProcessor(await rO.o.walletFor(dbO.get(h)!)));
    const pk = (await w.getPublicKey({ protocolID: [2, "skein instance"], keyID: `libp2p:${h}`, counterparty: "self" })).publicKey;
    check(pk === keyOfPeerId(rO.p2p!.peerId(h)), `(a) ${h.slice(0, 12)}: getPublicKey([2, "skein instance"], libp2p:<handle>, self) over the wallet wire is the node's peer key`);
  }
  const pkCount = new Set(await Promise.all([T0, T1, "alice"].map(async (h) => (await (new WalletWireTransceiver(new WalletWireProcessor(await rO.o.walletFor(dbO.get(h)!)))).getPublicKey({ identityKey: true })).publicKey))).size;
  check(pkCount === 1, "(a) the identity key over the wire is the same for the three");

  // ------------------------------------------------ the apps
  for (const h of [T0, T1, "alice"]) await installOkt(h);
  await overlayInto(rO, homeO, T0, chainDir, overlayDir);
  await feedHeaders(rO, T0);

  // ------------------------------------------------ (b) one node; gossip by topic
  check(rO.p2p!.nodeCount() === 1, `(b) one libp2p node on O for the three (${rO.p2p!.nodeCount()})`);
  const addrSets = new Set([T0, T1, "alice"].map((h) => rO.p2p!.addrs(h).join(" ")));
  check(addrSets.size === 1 && [...addrSets][0]!.includes(`/tcp/${ports.o}/p2p/${oPeer}`), `(b) one listen address set: ${[...addrSets][0]}`);
  const listed = await cli(["list"]);
  const peerCol = new Set(listed.out.map((l) => l.split("\t").at(-1)));
  check(peerCol.size === 1 && peerCol.has(oPeer), `(b) skein-host list: every row's peer ID is the node's (${[...peerCol].join(", ")})`);
  check(rO.p2p!.handlesOn(T0).sort().join() === [T0, T1, "alice"].sort().join(), `(b) the node carries ${rO.p2p!.handlesOn(T0).length} instances`);
  const subs = (topic: string) => ((rD.p2p?.node("dd")?.services as { pubsub: { getSubscribers(t: string): unknown[] } } | undefined)?.pubsub.getSubscribers(topic).length ?? 0);
  await until("D sees O on the topics", () => (subs(topicOf(T0)) > 0 && subs(BOTH) > 0 && subs(topicOf(T1)) > 0) || undefined);
  await sleep(1500);
  const before = { t0: await seen(T0), t1: await seen(T1), alice: await seen("alice") };
  const m1 = Uint8Array.from(randomBytes(24));
  await rD.p2p!.publish("dd", topicOf(T0), m1);
  const got1 = await until("T0 sees the tm_color_T0 message", async () => has(await seen(T0), m1) || undefined).catch(() => false);
  await sleep(500);
  check(got1 && (await seen(T1))?.head === before.t1?.head && (await seen("alice"))?.head === before.alice?.head, "(b) a message D publishes on tm_color_<txid>_0 reaches T0 alone");
  const m2 = Uint8Array.from(randomBytes(24));
  await rD.p2p!.publish("dd", BOTH, m2);
  const got2 = await until("T0 and T1 see okt_both", async () => (has(await seen(T0), m2) && has(await seen(T1), m2)) || undefined).catch(() => false);
  check(got2 && (await seen("alice"))?.head === before.alice?.head, "(b) a message on okt_both, a topic T0 and T1 take, reaches both (alice not)");

  // ------------------------------------------------ (c) streams by their first frame's topic
  const streamTo = async (protocol: string, frame: Uint8Array): Promise<Frame[]> => {
    const got: Frame[] = [];
    const id = await rD.p2p!.dial("dd", oPeer, protocol, (f) => got.push(f));
    await rD.p2p!.send("dd", id, frame);
    return got;
  };
  check(rO.p2p!.served(T0)?.protocols.includes(SYNC_PROTOCOL) === true && rO.p2p!.served(T1)?.protocols.includes(SYNC_PROTOCOL) === true, "(c) T0 (the overlay's row) and T1 (okt's) both declare /skein/overlay/sync/1.0.0");
  const f1 = dagCbor.encode({ kind: "locator", topic: topicOf(T1), locator: [], nonce: Uint8Array.from(randomBytes(8)) });
  const t0Before = (await seen(T0))?.head;
  await streamTo(SYNC_PROTOCOL, f1);
  const c1 = await until("the sync frame lands in T1", async () => has(await seen(T1), f1) || undefined).catch(() => false);
  check(c1 && (await seen(T0))?.head === t0Before, "(c) a sync stream whose first frame names tm_color_<txid>_1 lands in T1 (T0's engine not asked)");
  const f2 = Uint8Array.from(Buffer.from(`no topic ${randomBytes(4).toString("hex")}`));
  await streamTo(ALICE_P, f2);
  const c2 = await until("the frame lands in alice", async () => has(await seen("alice"), f2) || undefined).catch(() => false);
  check(c2, "(c) a frame naming no topic on a protocol only alice declares lands in alice");
  const aliceBefore = (await seen("alice"))?.head, t1Before = (await seen(T1))?.head;
  const got3 = await streamTo(TWO_P, Uint8Array.from(Buffer.from("no topic, two declare")));
  await until("an answer and the end", () => got3.some((f) => "closed" in f) || undefined).catch(() => undefined);
  const ans = got3.find((f): f is { body: Uint8Array } => "body" in f);
  const decoded = ans ? dagCbor.decode(ans.body) as { kind?: string; message?: string } : undefined;
  check(decoded?.kind === "error" && decoded.message === "topic required" && got3.some((f) => "closed" in f) && (await seen("alice"))?.head === aliceBefore && (await seen(T1))?.head === t1Before,
    `(c) the same on a protocol T1 and alice both declare: answered ${JSON.stringify(decoded)} and closed, nothing admitted`);

  // ------------------------------------------------ (d) path-only origins; the bare host's overlay requests by topic
  const base = `http://127.0.0.1:${rO.port}`;
  check(rO.originOf(T0) === `${rO.origin()}/@${T0}`, `(d) a token id's origin is /@<handle> on the host's: ${rO.originOf(T0)}`);
  const anc = await fetch(`${base}/@${T0}/overlay/anchors?topic=${topicOf(T0)}`);
  check(anc.status === 200, `(d) /@<txid>_0/overlay/anchors serves T0: ${anc.status}`);
  check(rO.target(new URL(`http://${T0}.localhost:${rO.port}/x`)) === undefined, "(d) a token id never routes by host name");
  const forwarded: Array<{ handle: string; route: string }> = [];
  const fwd = (rO as unknown as { forward: (h: string, route: string, ...rest: unknown[]) => Promise<unknown> });
  const orig = fwd.forward.bind(rO);
  fwd.forward = async (h: string, route: string, ...rest: unknown[]) => { forwarded.push({ handle: h, route }); return await orig(h, route, ...rest); };
  const s1 = await fetch(`${base}/submit`, { method: "POST", headers: { "x-topics": topicOf(T1) }, body: Uint8Array.from([1, 2, 3]) });
  check(forwarded.at(-1)?.handle === T1 && forwarded.at(-1)?.route === "/submit", `(d) bare-host POST /submit, X-Topics tm_color_<txid>_1 → T1 /submit (${s1.status}, ${JSON.stringify(forwarded.at(-1))})`);
  const l1 = await fetch(`${base}/lookup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service: `ls_color_${T0}`, query: {} }) });
  check(forwarded.at(-1)?.handle === T0 && forwarded.at(-1)?.route === "/lookup", `(d) bare-host POST /lookup for ls_color_<txid>_0 → T0 /lookup (${l1.status})`);
  const n = forwarded.length;
  const mixed = await fetch(`${base}/submit`, { method: "POST", headers: { "x-topics": `${topicOf(T0)},${topicOf(T1)}` }, body: Uint8Array.from([1]) });
  const mixed2 = await fetch(`${base}/submit`, { method: "POST", headers: { "x-topics": JSON.stringify([topicOf(T0), "tm_other"]) }, body: Uint8Array.from([1]) });
  check(mixed.status === 400 && mixed2.status === 400 && forwarded.length === n, `(d) mixed topics are 400 (${mixed.status}: ${(await mixed.json() as { description?: string }).description}; ${mixed2.status})`);
  const none = await fetch(`${base}/submit`, { method: "POST", headers: { "x-topics": "tm_other" }, body: Uint8Array.from([1]) });
  check(none.status === 404 && forwarded.length === n, `(d) a topic no instance here takes: the bare host as before (${none.status})`);
  fwd.forward = orig;

  // ------------------------------------------------ (e) an instance creates an instance (SKEIN_MANAGER_FOR)
  const imgDir = join(homeO, "images", "okimg");
  mkdirSync(join(imgDir, "etc"), { recursive: true });
  // skein-amm#4: the chain app and the overlay beside okt (with no rows: app-demo's own manifest has a start message, not at birth),
  // so a create's `config` can name the new instance's topic and its `beef` be judged under it.
  // #137: and the overlay's two root routes (skein-overlay "Root routes"), as skein-amm's token image has them, so a request
// the router routes by topic to an instance born from it is answered at its /submit and /lookup.
writeFileSync(join(imgDir, "etc/apps.json"), JSON.stringify({ install: [chainDir, overlayDir, appTree("img", [])], routes: [
  { transport: "http", address: "/submit", filters: ["kernel.beef"], program: "overlay.overlay", fn: "submit" },
  { transport: "http", address: "/lookup", filters: ["overlay.lookup"] },
] }));
  const book = async (r: Router, h: string) => (((await (await r.hydrate(h)).kernel.genesis()) as { addressBook?: Array<{ address?: string }> }).addressBook ?? []).map((e) => e.address);
  check((await book(rO, "alice")).includes("manager") && !(await book(rO, T1)).includes("manager"), "(e) alice's address book names the instance manager (SKEIN_MANAGER_FOR); T1's does not");
  const answers: Array<{ handle: string; box: string; body: Record<string, unknown> }> = [];
  for (const r of [rO, rD]) {
    const append = r.providers.o.append;
    (r.providers.o as { append: typeof append }).append = async (handle, pkg) => { answers.push({ handle, box: pkg.message.box, body: dagCbor.decode(pkg.body) as Record<string, unknown> }); return await append(handle, pkg); };
  }
  /** A message from `from` to `r`'s instance manager, carried as the kernel hands an emit over (unsigned, #126 step 4). */
  const ask = async (r: Router, from: string, box: string, body: Record<string, unknown>) => {
    const id = (await r.hydrate(from)).identity;
    const bytes = dagCbor.encode(body);
    const message: MailRecord = { kind: "mail", op: "put", sender: Uint8Array.from(Buffer.from(id, "hex")), recipient: Uint8Array.from(Buffer.from(r.providers.key("manager"), "hex")), box, body: encode(dagCbor.decode(bytes)).cid, nonce: Uint8Array.from(randomBytes(16)) };
    const k = answers.length;
    r.providers.deliver(from, { message, body: bytes, transport: "local", address: "manager" });
    await r.providers.idle();
    await r.settled();
    return answers.slice(k).filter((a) => a.box === box && a.handle === from);
  };
  // skein-amm#4: the create carries a mined token's BEEF; the new instance's overlay serves tm_color_T2 from its config at birth.
  const overlayAt = (t: string, terms?: Record<string, number>) => ({ overlay: { topics: { [t]: "topic-demo" }, lookups: { ls_demo: { program: "lookup-demo", topics: [t] } }, ...(terms ? { terms } : {}) } });
  const TERMS = { lpFeeBps: 30, validatorFeeBps: 5, commissionBps: 25 };
  const tE = await token(fund, 2);
  const hE = mineAlone(tE);
  await feedHeaders(rO, T0, hE);
  // A host with a headers feed fills its image's chain from it (#132): a new instance is born with the headers (on
  // SQLite and LMDB each instance holds them; on RocksDB the host chain is the kernel process's, #156).
  await (rO as unknown as { image: { headers(raws: Uint8Array[]): Promise<void> } }).image.headers([REGTEST_GENESIS, ...headers.slice(0, hE)]);
  const config = { okt: { onekey: "the admin's initial values" }, overlay: overlayAt(topicOf(T2), TERMS) };
  const tc = Date.now();
  // #137: the create names the overlay names the host routes to it.
  const T2_TOPICS = [topicOf(T2), `ls_color_${T2}`];
  let a = await ask(rO, "alice", "create", { handle: T2, image: "okimg", config, beef: Uint8Array.from(tE.toAtomicBEEF()), topics: T2_TOPICS });
  const createMs = Date.now() - tc;
  timings.push(`create by emit with the deploy's BEEF (the manager's create of ${T2.slice(0, 8)}…_2 from the image okimg, host-claimed, the BEEF delivered, to its answer): ${createMs} ms`);
  check(a.length === 1 && a[0]!.body.handle === T2 && a[0]!.body.url === `${rO.origin()}/@${T2}` && hex(a[0]!.body.identity) === shared.toPublicKey().toString(), `(e) alice's create answered {handle, identity, url, delivered}: ${JSON.stringify({ ...a[0]?.body, identity: hex(a[0]?.body.identity).slice(0, 10) }).slice(0, 260)}`);
  const del = a[0]?.body.delivered as { verdict?: string; reason?: string } | undefined;
  check(del?.verdict === "accept", `(e) the create's BEEF (a token mined at ${hE}) delivered into the new instance: ${JSON.stringify(del)}`);
  const admittedE = await until("T2 admits the create's BEEF", async () => {
    const r = await fetch(`${base}/@${T2}/overlay/admitted?topic=${topicOf(T2)}&fromHeight=${hE}&toHeight=${hE}`);
    if (r.status !== 200) return undefined;
    const x = await r.json() as { blocks?: Array<{ txids: string[] }> };
    return x.blocks?.some((b) => b.txids.includes(tE.id("hex"))) || undefined;
  }, 10_000).catch(() => false);
  check(admittedE === true, `(e) the new instance admitted it under tm_color_<txid>_2, the topic its config at birth declares (/@<txid>_2/overlay/admitted at ${hE})`);
  // skein-overlay 0.17.0: a configured topic and lookup beat on <name>-live (the validator's every: 1000 ms here),
  // the beat's terms config.overlay.terms (the initial value: no head overlay/terms written).
  const liveAt = async (name: string) => {
    const r = await fetch(`${base}/@${T2}/overlay/.live/${name}-live`);
    if (r.status !== 200) return undefined;
    const xs = await r.json() as Array<{ sender: string; at: number; body: string }>;
    return xs.length ? xs : undefined;
  };
  const tl = Date.now();
  const topicBeats = await until("T2 beats tm_color_<txid>_2-live", () => liveAt(topicOf(T2)), 5000).catch(() => undefined);
  const lookupBeats = await until("T2 beats ls_demo-live", () => liveAt("ls_demo"), 5000).catch(() => undefined);
  timings.push(`a configured topic's first beat seen after the create's answer: ${Date.now() - tl} ms (validator every 1000 ms)`);
  const beatTerms = topicBeats ? (dagCbor.decode(Buffer.from(topicBeats[0]!.body, "base64")) as { terms?: Record<string, number> }).terms : undefined;
  check(!!topicBeats && !!lookupBeats, `(e) its configured topic and lookup beat: .live/tm_color_<txid>_2-live ${topicBeats?.length ?? 0} beat(s), .live/ls_demo-live ${lookupBeats?.length ?? 0}`);
  const sorted = (o: object | undefined) => JSON.stringify(o && Object.fromEntries(Object.entries(o).sort()));
  check(sorted(beatTerms) === sorted(TERMS), `(e) the topic's beat carries config.overlay.terms as its terms (${JSON.stringify(beatTerms)})`);
  const row2 = dbO.get(T2);
  if (row2?.status === "enabled") { stores.push(storeSpec(row2)); handleOf.set(storeSpec(row2), T2); }
  check(row2?.status === "enabled", `(e) the row ${T2.slice(0, 8)}…_2 exists, enabled (${row2?.status})`);
  check(row2?.topics === JSON.stringify(T2_TOPICS), `(e) the row carries the create's topics (${row2?.topics})`);
  if (row2?.status === "enabled") {
    const k2 = (await rO.hydrate(T2)).kernel;
    const g = await k2.store.get(await k2.call("head", "grants") as CID) as { roles?: Record<string, Uint8Array[]> };
    check((g.roles?.root ?? []).map(hex).join() === shared.toPublicKey().toString(), "(e) claimed by the shared key (root in its grants)");
    const appRec = await k2.store.get(await k2.call("head", appHead("okt")) as CID) as { config?: Record<string, Record<string, unknown>> };
    // As --config: {<app>: <its config>}, merged over the manifest's config (the manifest's okt has none).
    check((appRec.config as Record<string, unknown> | undefined)?.onekey === "the admin's initial values", `(e) its app record carries the create's config (${JSON.stringify(appRec.config)})`);
  }
  a = await ask(rO, "alice", "stop", { handle: T2 });
  check(a[0]?.body.stopped === true && dbO.get(T2)?.status === "disabled" && !rO.p2p!.handlesOn(T0).includes(T2), "(e) stop disables it and takes it off the node (its beacons stop)");
  // A start: enabled, on the node again, its configured beacons folded back from its log (no new step needed).
  a = await ask(rO, "alice", "start", { handle: T2 });
  const restarted = await until("T2 beats again after start", () => liveAt(topicOf(T2)), 5000).catch(() => undefined);
  check(a[0]?.body.started === true && dbO.get(T2)?.status === "enabled" && rO.p2p!.handlesOn(T0).includes(T2) && !!restarted, `(e) start enables it again and its configured topic beats again (${restarted?.length ?? 0} beat(s))`);
  check(dbO.get(T2)?.topics === JSON.stringify(T2_TOPICS), `(e) a start with no topics keeps the row's (${dbO.get(T2)?.topics})`);
  await ask(rO, "alice", "stop", { handle: T2 });
  // An unmined BEEF: turned away at the door (the HARD RULE), reported in the answer, the instance created and enabled.
  const TU = `${TXID}_10`;
  const tU = await token(fund, 3);
  a = await ask(rO, "alice", "create", { handle: TU, image: "okimg", config: { overlay: overlayAt(topicOf(TU)) }, beef: Uint8Array.from(tU.toAtomicBEEF()) });
  const delU = a[0]?.body.delivered as { verdict?: string; reason?: string } | undefined;
  const rowU = dbO.get(TU);
  if (rowU) { stores.push(storeSpec(rowU)); handleOf.set(storeSpec(rowU), TU); }
  check(a[0]?.body.handle === TU && (delU?.verdict === "reject" || delU?.verdict === "ignore") && !!delU?.reason, `(e) a create with an unmined BEEF answers delivered ${JSON.stringify(delU)}`);
  check(rowU?.status === "enabled", `(e) … and the instance is created and enabled (${rowU?.status})`);
  await ask(rO, "alice", "stop", { handle: TU });
  const nLines = lines.length;
  a = await ask(rO, T1, "create", { handle: `${TXID}_9`, image: "okimg" });
  check(a.length === 0 && !dbO.get(`${TXID}_9`) && lines.slice(nLines).some((l) => /the instance manager takes messages from the host skein only: not acted on/.test(l)), "(e) T1 (not named) gets the manager's refusal: not acted on, nothing created");
  a = await ask(rD, "dd", "create", { handle: "carol", owner: Uint8Array.from(Buffer.from(owner, "hex")) });
  check(/claim: the owner's signed claim/.test(String(a[0]?.body.error)) && !dbD.get("carol"), `(e) a master-key host: the same create with no claim is refused as before (${String(a[0]?.body.error).slice(0, 80)})`);

  // ------------------------------------------------ (f) D syncs tm_color_T0 from T0 through the shared node
  const t2 = await token(fund, 0);
  const h2 = mineAlone(t2);
  await feedHeaders(rO, T0, h2);
  const sub2 = await fetch(`${base}/@${T0}/overlay/submit`, { method: "POST", headers: { "x-topics": topicOf(T0) }, body: Uint8Array.from(t2.toBEEF()) });
  check(sub2.status === 200, `(f) a token mined at ${h2} posted to T0: ${sub2.status} ${(await sub2.text()).slice(0, 120)}`);
  const t3 = await token(fund, 1);
  const h3 = mineAlone(t3);
  await feedHeaders(rO, T0, h3);
  const sub3 = await fetch(`${base}/@${T0}/overlay/submit`, { method: "POST", headers: { "x-topics": topicOf(T0) }, body: Uint8Array.from(t3.toBEEF()) });
  check(sub3.status === 200, `(f) a token mined at ${h3} posted to T0: ${sub3.status}`);
  const oTip = await until("T0's anchors at its tip", () => anchorsAt(`${base}/@${T0}`));
  const t1Seen = (await seen(T1))?.head;
  await overlayInto(rD, homeD, "dd", chainDir, overlayDir);
  await feedHeaders(rD, "dd");
  const dBase = `http://127.0.0.1:${rD.port}/@dd`;
  const caught = await until("dd catches up from T0", async () => { const x = await anchorsAt(dBase); return x && x.tip === oTip.tip && x.anchor === oTip.anchor && x.genesis === oTip.genesis ? x : undefined; }, 90_000).catch(() => undefined);
  check(!!caught, `(f) D's dd synced tm_color_<txid>_0 from T0 over the shared node: equal anchors (genesis ${caught?.genesis}, tip ${caught?.tip}, ${caught?.anchor.slice(0, 16)}…; T0's tip ${oTip.tip})`);
  check(lines.some((l) => l.startsWith("[d:") && /sync: /.test(l) && l.includes(oPeer.slice(-8))) || !!caught, "(f) the catch-up was D's puller's, from O's peer");
  check((await seen(T1))?.head === t1Seen, "(f) T1, which declares the sync protocol too, was not asked: the frames named T0's topic");

  // ------------------------------------------------ (g) a discovery instance (#137): a non-token name routed by the topics the create named
  // alice creates `discovery` from the same image with tm_color and ls_color configured (skein-amm 0.18.1's toggle),
  // no BEEF, and the create names the topics the host routes to it.
  const DISC = { overlay: { topics: { tm_color: "topic-demo" }, lookups: { ls_color: { program: "lookup-demo", topics: ["tm_color"] } } } };
  const DISC_TOPICS = ["tm_color", "ls_color"];
  a = await ask(rO, "alice", "create", { handle: "discovery", image: "okimg", config: { overlay: DISC }, topics: DISC_TOPICS }); // {<app>: {<program>: …}}
  const rowD = dbO.get("discovery");
  if (rowD) { stores.push(storeSpec(rowD)); handleOf.set(storeSpec(rowD), "discovery"); }
  check(a[0]?.body.handle === "discovery" && rowD?.status === "enabled" && rowD?.topics === JSON.stringify(DISC_TOPICS), `(g) alice's create of discovery answered ${JSON.stringify({ ...a[0]?.body, identity: undefined })}, its row's topics ${rowD?.topics}`);
  const fwdG = (rO as unknown as { forward: (h: string, route: string, ...rest: unknown[]) => Promise<unknown> });
  const origG = fwdG.forward.bind(rO);
  const sent: Array<{ handle: string; route: string }> = [];
  fwdG.forward = async (h: string, route: string, ...rest: unknown[]) => { sent.push({ handle: h, route }); return await origG(h, route, ...rest); };
  const admittedAt = async (t: Transaction, height: number) => until("discovery admits it under tm_color", async () => {
    const r = await fetch(`${base}/@discovery/overlay/admitted?topic=tm_color&fromHeight=${height}&toHeight=${height}`);
    if (r.status !== 200) return undefined;
    const x = await r.json() as { blocks?: Array<{ txids: string[] }> };
    return x.blocks?.some((b) => b.txids.includes(t.id("hex"))) || undefined;
  }, 10_000).catch(() => false);
  // At once — no request to discovery first, its overlay never stepped — a BEEF at the BARE host with X-Topics tm_color lands in it.
  const tD = await token(tE, 1, 8_000);
  const hD = mineAlone(tD);
  await feedHeaders(rO, "discovery", hE + 1);
  const sD = await fetch(`${base}/submit`, { method: "POST", headers: { "x-topics": "tm_color" }, body: Uint8Array.from(tD.toBEEF()) });
  const sDBody = await sD.text();
  check(sent.length === 1 && sent[0]?.handle === "discovery" && sent[0]?.route === "/submit" && sD.status === 200, `(g) the newborn: bare-host POST /submit, X-Topics tm_color → discovery /submit: ${sD.status} ${sDBody.slice(0, 160)}`);
  check(await admittedAt(tD, hD) === true, `(g) discovery admitted it under tm_color (at ${hD})`);
  const lD = await fetch(`${base}/lookup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service: "ls_color", query: {} }) });
  const lDBody = await lD.text();
  check(sent.at(-1)?.handle === "discovery" && sent.at(-1)?.route === "/lookup" && /UnknownService/.test(lDBody), `(g) bare-host POST /lookup {service: ls_color} → discovery /lookup, answered by its program (lookup-demo knows only ls_demo): ${lD.status} ${lDBody.slice(0, 160)}`);
  // The token instance T2, created with topics [tm_color_<id>, ls_color_<id>], still routed.
  await ask(rO, "alice", "start", { handle: T2 });
  const nT = sent.length;
  await fetch(`${base}/lookup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service: `ls_color_${T2}`, query: {} }) });
  check(sent.length === nT + 1 && sent.at(-1)?.handle === T2 && sent.at(-1)?.route === "/lookup", `(g) bare-host POST /lookup {service: ls_color_<T2>} → T2 (${sent.at(-1)?.handle.slice(0, 9)})`);
  await ask(rO, "alice", "stop", { handle: T2 });
  const mixedG = await fetch(`${base}/submit`, { method: "POST", headers: { "x-topics": `tm_color,${topicOf(T0)}` }, body: Uint8Array.from([1]) });
  check(mixedG.status === 400, `(g) tm_color beside a token's topic: 400 (${(await mixedG.json() as { description?: string }).description})`);
  // A start with `topics` replaces the row's: ls_color no longer routed to discovery, tm_color still is.
  await ask(rO, "alice", "stop", { handle: "discovery" });
  a = await ask(rO, "alice", "start", { handle: "discovery", topics: ["tm_color"] });
  const nR = sent.length;
  await fetch(`${base}/lookup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service: "ls_color", query: {} }) });
  const tmR = await fetch(`${base}/submit`, { method: "POST", headers: { "x-topics": "tm_color" }, body: Uint8Array.from(tD.toBEEF()) });
  await tmR.arrayBuffer();
  check(a[0]?.body.started === true && dbO.get("discovery")?.topics === JSON.stringify(["tm_color"]) && sent.length === nR + 1 && sent.at(-1)?.handle === "discovery" && sent.at(-1)?.route === "/submit", `(g) start {topics: [tm_color]} replaces the row's: ls_color falls through, tm_color still routed (${dbO.get("discovery")?.topics}; ${sent.length - nR} forwarded)`);
  a = await ask(rO, "alice", "stop", { handle: "discovery" });
  const nS = sent.length;
  const offD = await fetch(`${base}/submit`, { method: "POST", headers: { "x-topics": "tm_color" }, body: Uint8Array.from(tD.toBEEF()) });
  check(a[0]?.body.stopped === true && sent.length === nS && offD.status === 404, `(g) discovery stopped: tm_color taken by no one, the bare host as before (${offD.status})`);
  fwdG.forward = origG;

  // ------------------------------------------------ timing: gossip fan-out to 8 handles on the one node
  for (const h of EXTRA) {
    const ad = await cli(["add", h]);
    if (ad.code !== 0) throw new Error(`add ${h}: ${ad.err.join(" ")}`);
    await rO.hydrate(h);
    { stores.push(storeSpec(dbO.get(h)!)); handleOf.set(storeSpec(dbO.get(h)!), h); }
    await installOkt(h);
  }
  const eight = [T0, T1, ...EXTRA];
  check(rO.p2p!.nodeCount() === 1 && rO.p2p!.handlesOn(T0).length === 9, `one node still (T2 stopped), ${rO.p2p!.handlesOn(T0).length} instances on it`);
  await sleep(1500);
  const runs: number[] = [];
  for (let i = 0; i < 5; i++) {
    const m = Uint8Array.from(randomBytes(24));
    const t0 = Date.now();
    await rD.p2p!.publish("dd", BOTH, m);
    let ok = false;
    for (const end = Date.now() + 30_000; Date.now() < end; await sleep(5)) {
      const s = await Promise.all(eight.map(async (h) => has(await seen(h), m)));
      if (s.every(Boolean)) { ok = true; break; }
    }
    runs.push(ok ? Date.now() - t0 : -1);
  }
  check(runs.every((x) => x >= 0), `a message on okt_both reaches all 8 handles on the one node, 5 times (${runs.join(", ")} ms)`);
  timings.push(`gossip fan-out to 8 handles on one node (publish on D → every handle's okt/seen moved, read by kernel calls): ${runs.join(", ")} ms (median ${[...runs].sort((x, y) => x - y)[2]} ms)`);
  await rO.settled();
  await rD.settled();
} catch (e) {
  check(false, `threw: ${(e as Error).stack}`);
} finally {
  await rO.stop();
  await rD.stop();
  await arcade.close();
  dbO.close();
  dbD.close();
  for (const store of new Set(stores)) {
    const rp = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), store], { encoding: "utf8" });
    if (rp.status !== 0) process.stdout.write(rp.stdout + rp.stderr);
    check(rp.status === 0 && /identical .*the source store reproduced exactly/.test(rp.stdout), `${(handleOf.get(store) ?? store).replace(TXID, "<txid>")}: the store replays to itself exactly after the processes stopped`);
  }
}
for (const t of timings) process.stdout.write(`timing: ${t}\n`);
if (process.env.KEEP) process.stdout.write(`kept ${home}\n`); else rmSync(home, { recursive: true, force: true });
process.stdout.write(failures ? `onekey (${BACKEND}): ${failures} FAILED\n` : `onekey (${BACKEND}): all ok\n`);
process.exit(failures ? 1 : 0);

// An overlay installed as an app (#72 build 3; docs/APPS.md §6) end to end:
// shruggr/skein-overlay at a pinned commit (or $SKEIN_OVERLAY_DIR), installed
// with `skein-host install --approve-all` into an instance of the stock
// system whose genesis has no overlay config and no libp2p — on a router
// with libp2p and an Arcade (so a `$status` provider) — while a second router
// runs a plain instance subscribed to the overlay's topics:
//
//   - the install derives the wiring from `config.overlay` (the prompt marks
//     it): the routes /overlay/submit, /overlay/lookup and libp2p:tm_demo,
//     -admit, -proof; the boxes submit, chain (from anyone) and status (from
//     $status); the head ls:ls_demo;
//   - the instance's libp2p node starts with the installed routes' topics
//     (tm_demo, tm_demo-admit, tm_demo-proof), live, no restart;
//   - the second router publishes a token on tm_demo: the installed overlay
//     judges it with the manifest's topic manager (the genesis names none),
//     broadcasts it, and admits it on Arcade's word; /overlay/lookup finds
//     it (ls_demo, the manifest's lookup service); an HTTP /overlay/submit
//     answers its STEAK;
//   - a reinstall with a changed config.overlay (a second topic, tm_two,
//     ls_demo listening to both) is read at the next step: the node
//     subscribes tm_two, tm_two-admit, tm_two-proof; a token published on
//     tm_two is judged under tm_two and found by a lookup on it;
//   - uninstall removes the routes: the node unsubscribes (no topic left: it
//     stops), and the publisher's node sees it leave.
//
// The instance's store then replays to itself exactly.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/install-overlay.ts

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MerklePath, P2PKH, PrivateKey, Script, Transaction, UnlockingScript } from "@bsv/sdk";
import type { CID } from "multiformats/cid";
import { RawBox } from "../../src/client/raw.ts";
import { main } from "../../src/host/cli.ts";
import { FakeArcade } from "../../src/host/fake-arcade.ts";
import { HostDb } from "../../src/host/instances.ts";
import { Oracle } from "../../src/host/oracle.ts";
import { peerIdOf } from "../../src/host/p2p.ts";
import { Router } from "../../src/host/router.ts";
import { ephemeralWallet } from "../../src/wallet.ts";

// The app under test: SKEIN_OVERLAY_DIR names a checkout, else this commit (the one equiv/overlay.ts pins).
const OVERLAY_REPO = "https://github.com/shruggr/skein-overlay";
const OVERLAY_REV = "bd406f30c20f6b5e1fc51a179b995775b87a0ab9";
const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
const home = mkdtempSync(join(tmpdir(), "skein-kz-install-overlay-"));
let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };
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

// ---------------------------------------------------------------- regtest (as equiv/overlay.ts)

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

// ---------------------------------------------------------------- two routers with libp2p

const key = (h: string) => new PrivateKey(h, 16);
const ownerKey = key("2222");
const owner = ownerKey.toPublicKey().toString();
const oracle = new Oracle(new PrivateKey("a77e57", 16));
const arcade = await FakeArcade.start();
const ports = { a: await freePort(), b: await freePort() };
const idOf = (h: string) => peerIdOf(oracle.peerKey(h)).toString();
const hdbA = new HostDb(join(home, "host.db"));
hdbA.add("ov", { store: join(home, "instances/ov/runtime.db") });
const hdbB = new HostDb(join(home, "pub-host.db"));
hdbB.add("pub", { store: join(home, "instances/pub/runtime.db") });
const common = { walletFor: () => ephemeralWallet(key("1111")), home, owner, idleMs: 0, providerKeyFor: (n: string) => oracle.providerKey(n), peerKeyFor: (x: string) => oracle.peerKey(x), answerWaitMs: 6000, kernel: { command: kernel, env: { SKEIN_HOME: home } }, libp2pDiscoveryMs: 300 };
const log = (who: string) => (s: string, l: string) => { if (process.env.VERBOSE) process.stdout.write(`  | [${who}:${s}] ${l}\n`); };
// A: the stock system; its genesis's defaults name the network only (no overlay config, no libp2p).
const rA = new Router({
  ...common, db: hdbA, genesis: { defaults: { walletNetwork: "regtest" } },
  arc: { url: arcade.url, token: "the-host-arcade-token", events: arcade.eventsUrl }, arcRetry: { min: 500, max: 2000 },
  libp2p: { listen: [`/ip4/127.0.0.1/tcp/${ports.a}`], bootstrap: [`/ip4/127.0.0.1/tcp/${ports.b}/p2p/${idOf("pub")}`], dht: "off", relays: [], mdns: false },
  log: log("a"),
});
// B: a plain instance whose genesis subscribes the overlay's topics: the publisher.
const rB = new Router({
  ...common, db: hdbB, genesis: { libp2p: { topics: ["tm_demo", "tm_two"] } },
  libp2p: { listen: [`/ip4/127.0.0.1/tcp/${ports.b}`], bootstrap: [`/ip4/127.0.0.1/tcp/${ports.a}/p2p/${idOf("ov")}`], dht: "off", relays: [], mdns: false },
  log: log("b"),
});

let store = "";
try {
  await rA.listen(0);
  await rB.listen(0);
  const kA = async () => (await rA.hydrate("ov")).kernel;
  const record = async (name: string) => {
    const k = await kA();
    const root = await k.call("head", name) as CID | null;
    return root ? await k.store.get(root) as Record<string, unknown> : undefined;
  };
  const g = await (await kA()).genesis() as { defaults?: Record<string, string>; libp2p?: unknown };
  await rB.hydrate("pub");
  store = hdbA.get("ov")!.store;
  check(!g.libp2p && !!g.defaults && !("overlayTopics" in g.defaults) && !("overlayLookups" in g.defaults), `the instance's genesis has no overlay config and no libp2p (defaults: ${Object.keys(g.defaults ?? {}).filter((k) => k.startsWith("overlay") || k === "walletNetwork").join(", ")})`);
  check(rA.p2p?.node("ov") === undefined, "before the install: no libp2p node for the instance");

  const ownerWallet = ephemeralWallet(ownerKey);
  const out: string[] = [], err: string[] = [];
  const cli = async (...args: string[]) => {
    out.length = 0; err.length = 0;
    const code = await main(args, {
      vars: { SKEIN_HOME: home, HOME: home }, out: (l) => out.push(l), err: (l) => err.push(l),
      owner: { wallet: ownerWallet, box: (row) => new RawBox(ownerWallet, `http://127.0.0.1:${rA.port}/@${row.handle}`) },
    });
    await rA.settled();
    if (process.env.VERBOSE) for (const l of [...out, ...err]) process.stdout.write(`  | ${l}\n`);
    return code;
  };
  const served = () => rA.p2p?.served("ov");
  const subscribers = (r: Router, h: string, topic: string) => ((r.p2p?.node(h)?.services as { pubsub: { getSubscribers(t: string): unknown[] } } | undefined)?.pubsub.getSubscribers(topic).length ?? 0);

  // ------------------------------------------------ install from the repo (pinned commit)
  const spec = process.env.SKEIN_OVERLAY_DIR ?? `${OVERLAY_REPO}#${OVERLAY_REV}`;
  let code = await cli("install", spec, "--instance", "ov", "--approve-all");
  const derived = out.filter((l) => l.includes("(derived: config.overlay)"));
  check(code === 0, `skein-host install skein-overlay: exit ${code} ${err.join(" ")}`);
  check(["row       libp2p tm_demo from anyone → overlay.submit", "row       libp2p tm_demo-admit from anyone → overlay.peerAdmit", "row       libp2p tm_demo-proof from anyone → overlay.peerProof", "row       http /overlay/submit from anyone → overlay.submit", "row       http /overlay/lookup from anyone → overlay.lookup", "row       mailbox submit from anyone → overlay", "row       mailbox chain from anyone → overlay", "row       mailbox status from $status → overlay", "grants    overlay, wallet, overlay:gossip, ls:ls_demo"].every((x) => derived.some((l) => l.includes(x))), `the prompt shows the wiring derived from config.overlay (${derived.length} lines: ${derived.map((l) => l.trim().replace(/\s+/g, " ").replace(" (derived: config.overlay)", "")).join(" | ")})`);
  const app = await record("overlay/app");
  const appRows = async () => ((await (await kA()).dispatch()).rows as Array<Record<string, unknown>>).filter((r) => r.app === "overlay");
  const rowsT = await appRows();
  check(app?.kind === "app" && (app.config as { overlay?: unknown })?.overlay !== undefined && (await record("overlay"))?.kind === "app", "the head overlay/app is the app record, with config.overlay (overlay its alias: a pre-#77 manifest)");
  check(["libp2p tm_demo", "libp2p tm_demo-admit", "libp2p tm_demo-proof", "http /overlay/submit", "http /overlay/lookup"].every((p) => rowsT.some((r) => `${r.transport} ${r.address}` === p)), `the dispatch table has the derived rows: ${rowsT.map((r) => `${r.transport} ${r.address}`).join(", ")}`);
  const topics1 = ["tm_demo", "tm_demo-admit", "tm_demo-proof"];
  const s1 = await until("the node subscribes the installed topics", () => { const s = served(); return s && topics1.every((t) => s.topics.includes(t)) ? s : undefined; }, 10_000).catch((e: Error) => { process.stdout.write(`  (${e.message})\n`); return undefined; });
  check(!!s1 && s1.topics.length === 3, `live, no restart: the instance's node subscribes ${s1?.topics.join(", ")}`);

  // The chain: the funding transaction mined at 1 (second in its block), fed by the host's chain feed (box chain, an event).
  const alice = key("3333");
  const fund = new Transaction();
  fund.addInput({ sourceTXID: "72".repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex("51"), sequence: 0xffffffff });
  for (let i = 0; i < 3; i++) fund.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 10_000 });
  const fundTxid = fund.id("hex");
  const cb = "cb".repeat(32);
  fund.merklePath = new MerklePath(1, [[{ offset: 0, hash: cb }, { offset: 1, hash: fundTxid, txid: true }]]);
  const h1 = mine(sha256d(REGTEST_GENESIS), sha256d(Buffer.concat([internal(cb), internal(fundTxid)])), 1_790_100_000);
  await rA.admitEvent("ov", "chain", { kind: "header", raw: h1 });
  await rA.settled();
  const token = (vout: number) => {
    const t = new Transaction();
    t.addInput({ sourceTransaction: fund, sourceOutputIndex: vout, unlockingScriptTemplate: new P2PKH().unlock(alice), sequence: 0xffffffff });
    t.addOutput({ lockingScript: Script.fromBinary([0x07, ...Buffer.from("tm_demo"), 0x75, ...new P2PKH().lock(alice.toPublicKey().toHash()).toBinary()]), satoshis: 1 });
    t.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 9_000 });
    return t;
  };
  // BRC-24 at the app's base URL (`${origin}/overlay`), the JSON form.
  const lookup = async (topic: string) => {
    const res = await fetch(`${rA.originOf("ov")}/overlay/lookup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service: "ls_demo", query: { topic } }) });
    if (res.status !== 200) throw new Error(`POST /overlay/lookup: ${res.status} ${await res.text()}`);
    const r = await res.json() as { outputs: Array<{ beef: number[]; outputIndex: number }> };
    return r.outputs.map((o) => `${Transaction.fromBEEF(o.beef).id("hex")}:${o.outputIndex}`);
  };
  const meshed = async (topic: string) => {
    await until(`the publisher sees the instance on ${topic}`, () => subscribers(rB, "pub", topic) > 0 || undefined);
    await sleep(1200); // a heartbeat: the instance in the publisher's mesh
  };

  // ------------------------------------------------ gossip on tm_demo: judged by the installed overlay
  const t1 = token(0);
  await t1.sign();
  await meshed("tm_demo");
  await rB.p2p!.publish("pub", "tm_demo", new Uint8Array(t1.toBEEF()));
  const found1 = await until("the gossiped token is admitted and found", async () => { await rA.settled(); const l = await lookup("tm_demo"); return l.includes(`${t1.id("hex")}:0`) ? l : undefined; }, 30_000).catch((e: Error) => { process.stdout.write(`  (${e.message})\n`); return undefined; });
  check(!!found1, `a token published on tm_demo by the other router: judged by the manifest's topic manager, admitted on Arcade's word, found by /overlay/lookup (ls_demo) (${found1?.join(", ")})`);
  check(arcade.posts.some((b) => FakeArcade.txOf(b).id("hex") === t1.id("hex")), "the installed overlay broadcast it (the host's Arcade got it)");

  // An HTTP submit to /overlay/submit: the STEAK.
  const t2 = token(1);
  await t2.sign();
  const sub = await fetch(`${rA.originOf("ov")}/overlay/submit`, { method: "POST", headers: { "x-topics": "tm_demo" }, body: new Uint8Array(t2.toBEEF()) });
  const steak = await sub.json() as Record<string, { outputsToAdmit?: number[] }>;
  check(sub.status === 200 && JSON.stringify(steak.tm_demo?.outputsToAdmit) === "[0]", `POST /overlay/submit: ${sub.status} ${JSON.stringify(steak)}`);
  const list = await fetch(`${rA.originOf("ov")}/overlay/listTopicManagers`);
  const listed1 = Object.keys(await list.json() as Record<string, unknown>);
  check(list.status === 200 && JSON.stringify(listed1) === '["tm_demo"]', `/overlay/listTopicManagers (the manifest's routes; the topics config.overlay names): ${JSON.stringify(listed1)}`);

  // ------------------------------------------------ reinstall: a second topic, read at the next step
  const dir = join(home, "overlay-two");
  if (process.env.SKEIN_OVERLAY_DIR) cpSync(process.env.SKEIN_OVERLAY_DIR, dir, { recursive: true, filter: (p) => !/\/(\.git|zig-out|\.zig-cache|zig-pkg)$/.test(p) });
  else {
    for (const args of [["clone", "-q", OVERLAY_REPO, dir], ["-C", dir, "checkout", "-q", OVERLAY_REV]]) {
      const r = spawnSync("git", args, { stdio: ["ignore", "ignore", "inherit"] });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: exit ${r.status}`);
    }
  }
  const mf = JSON.parse(readFileSync(join(dir, "etc/app.json"), "utf8")) as { version: string; config: { overlay: { topics: Record<string, string>; lookups: Record<string, { program: string; topics: string[] }> } } };
  mf.version = `${mf.version}-two`;
  mf.config.overlay.topics.tm_two = "topic-demo";
  mf.config.overlay.lookups.ls_demo!.topics = ["tm_demo", "tm_two"];
  writeFileSync(join(dir, "etc/app.json"), JSON.stringify(mf, null, 2));
  code = await cli("install", dir, "--instance", "ov", "--approve-all");
  check(code === 0 && /^upgrade overlay /.test(out[0] ?? "") && out.some((l) => l.includes("row       libp2p tm_two from anyone → overlay.submit")), `reinstalled with config.overlay.topics.tm_two: exit ${code} ${out[0]} ${err.join(" ")}`);
  const topics2 = [...topics1, "tm_two", "tm_two-admit", "tm_two-proof"];
  const s2 = await until("the node subscribes tm_two", () => { const s = served(); return s && topics2.every((t) => s.topics.includes(t)) ? s : undefined; }, 10_000).catch((e: Error) => { process.stdout.write(`  (${e.message})\n`); return undefined; });
  check(!!s2 && s2.topics.length === 6 && rA.p2p?.node("ov") !== undefined, `no restart: the node now subscribes ${s2?.topics.join(", ")}`);
  const listed2 = Object.keys(await (await fetch(`${rA.originOf("ov")}/overlay/listTopicManagers`)).json() as Record<string, unknown>);
  check(JSON.stringify(listed2.sort()) === '["tm_demo","tm_two"]', `the engine reads the new app record at its next call: /overlay/listTopicManagers ${JSON.stringify(listed2)}`);
  const t3 = token(2);
  await t3.sign();
  await meshed("tm_two");
  await rB.p2p!.publish("pub", "tm_two", new Uint8Array(t3.toBEEF()));
  const found3 = await until("the token on tm_two is admitted and found", async () => { await rA.settled(); const l = await lookup("tm_two"); return l.includes(`${t3.id("hex")}:0`) ? l : undefined; }, 30_000).catch((e: Error) => { process.stdout.write(`  (${e.message})\n`); return undefined; });
  check(!!found3 && !found3.includes(`${t1.id("hex")}:0`), `a token published on tm_two: judged under tm_two (the new config), found by a lookup on tm_two (${found3?.join(", ")})`);

  // ------------------------------------------------ uninstall: the routes go, the node unsubscribes
  code = await cli("uninstall", "overlay", "--instance", "ov", "--approve-all");
  check(code === 0, `skein-host uninstall overlay: exit ${code} ${out[0]} ${err.join(" ")}`);
  const left = await appRows();
  check(left.length === 0, `no overlay rows left in the dispatch table (${left.length})`);
  const gone = await until("the node unsubscribes", () => (served() === undefined && rA.p2p?.node("ov") === undefined) || undefined, 10_000).catch(() => false);
  check(gone, "no libp2p route left and none in the genesis: the instance's node unsubscribed and stopped");
  const leftB = await until("the publisher sees it leave", () => (subscribers(rB, "pub", "tm_demo") === 0 && subscribers(rB, "pub", "tm_two") === 0) || undefined, 20_000).catch(() => false);
  check(leftB, "the publisher's node sees the instance leave tm_demo and tm_two");
  const r = await fetch(`${rA.originOf("ov")}/overlay/lookup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service: "ls_demo", query: { topic: "tm_demo" } }) });
  check(r.status === 404, `after uninstall, /overlay/lookup is no route: ${r.status}`);
} catch (e) {
  check(false, `threw: ${(e as Error).stack}`);
} finally {
  await rA.stop();
  await rB.stop();
  await arcade.close();
  hdbA.close();
  hdbB.close();
  if (store) {
    const rp = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), store], { encoding: "utf8" });
    process.stdout.write(rp.stdout);
    if (rp.status !== 0) process.stdout.write(rp.stderr);
    check(rp.status === 0 && /identical .*the source store reproduced exactly/.test(rp.stdout), "the instance's store replays to itself exactly");
  }
}
if (process.env.KEEP) process.stdout.write(`kept ${home}\n`); else rmSync(home, { recursive: true, force: true });
process.stdout.write(failures ? `install-overlay: ${failures} FAILED\n` : "install-overlay: all ok\n");
process.exit(failures ? 1 : 0);

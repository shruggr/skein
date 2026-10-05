// Overlays installed as apps (#72 build 3, #79; docs/APPS.md §6) end to end:
// shruggr/skein-chain and shruggr/skein-overlay at pinned commits (or
// $SKEIN_CHAIN_DIR / $SKEIN_OVERLAY_DIR), installed as the owner's messages (#124:
// `skein plan install`, sent to /sendMessage) into an instance of the stock system whose genesis has no
// overlay config and no libp2p — on a router with libp2p and an Arcade (so a
// `$status` provider) — while a second router runs a plain instance
// subscribed to the overlays' topics:
//
//   - the overlay requires chain/1: installed into an instance without the
//     chain app it is refused; the chain app and the overlay install together
//     on one instance (#79);
//   - the install derives the overlay's wiring from `config.overlay` (the
//     prompt marks it): the rows http /overlay/submit, /overlay/lookup, libp2p
//     tm_demo, -admit, -proof, and the app's own box `overlay` from `event`
//     and from `$self`; no grants, no chain/status/submit box (the chain app's);
//   - the instance's libp2p node starts with the installed topics, live;
//   - the second router publishes a token on tm_demo: the installed overlay
//     judges it with the manifest's topic manager, hands it to the chain app
//     (which broadcasts it), admits it on the chain app's answer (Arcade's
//     word); /overlay/lookup finds it; an HTTP /overlay/submit answers its STEAK;
//   - BRC-22 → the chain app → BRC-24 over HTTP at the base URL
//     /@<handle>/overlay (#111): a mined token's BEEF to <base>/submit with
//     X-Topics: tm_demo, the chain app's answer proven (nothing broadcast),
//     <base>/lookup {service: ls_demo, query: {txid, outputIndex, topic}}
//     returns the output, its BEEF verifying against the headers; the token
//     submitted unproven (admitted on Arcade's accepted) found the same way;
//   - two overlay apps on one instance (#79): the same tree installed again as
//     `overlay2` with its own topic tm_two: no row clash; each writes only its
//     own heads (`<app>/state`, `<app>/ls_demo`); a submission to
//     /overlay2/submit is admitted by overlay2 and not by overlay; both read
//     the one `chain/state`;
//   - register / deregister (skein-overlay 0.7.0, #119, #128): the stock
//     manifest's owner row is the box overlay2/overlay; the owner's
//     register {topic: tm_reg, program: topic-demo} yields the three
//     subscriptions (tm_reg → overlay.submit with filter beef, -admit → peerAdmit, -proof →
//     peerProof) and overlay2/topics; the node subscribes them; a token
//     published on tm_reg is delivered by the subscription (no row);
//     deregister unsubscribes the three and the node leaves them;
//   - a reinstall of `overlay` with a changed config.overlay (a third topic,
//     tm_three) is read at the next step: the node subscribes it, a token
//     published on it is judged under it;
//   - uninstall removes the rows: the node unsubscribes (once both overlays
//     are gone, it stops), and the publisher's node sees it leave.
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
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { main } from "../../src/host/cli.ts";
import { ownerCli } from "../../src/testapps.ts";
import { RawBox } from "../../src/client/raw.ts";
import { openStoreFile } from "../../src/runtime/index-store.ts";
import { FakeArcade } from "../../src/host/fake-arcade.ts";
import { HostDb } from "../../src/host/instances.ts";
import { Signer } from "../../src/host/signer.ts";
import { peerIdOf, subscriptionsOf } from "../../src/host/p2p.ts";
import { Router } from "../../src/host/router.ts";
import { ephemeralWallet } from "../../src/wallet.ts";

// The apps under test: SKEIN_OVERLAY_DIR / SKEIN_CHAIN_DIR name checkouts, else these commits (the ones equiv/overlay.ts pins).
const OVERLAY_REPO = "https://github.com/shruggr/skein-overlay";
const OVERLAY_REV = process.env.SKEIN_OVERLAY_REV ?? "f71692b95bc6e88161789b5e5b2f5259a465d1c6";
const CHAIN_REPO = "https://github.com/shruggr/skein-chain";
const CHAIN_REV = process.env.SKEIN_CHAIN_REV ?? "a4c91a4654ce8560ec7803c2254c7be1c55d5173";
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
/** A checkout of `repo` at `rev` (or the env's dir), copied to `dir` without build output. */
function checkout(envDir: string | undefined, repo: string, rev: string, dir: string): string {
  if (envDir) { cpSync(envDir, dir, { recursive: true, filter: (p) => !/\/(\.git|zig-out|\.zig-cache|zig-pkg)$/.test(p) }); return dir; }
  for (const args of [["clone", "-q", repo, dir], ["-C", dir, "checkout", "-q", rev]]) {
    const r = spawnSync("git", args, { stdio: ["ignore", "ignore", "inherit"] });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: exit ${r.status}`);
  }
  return dir;
}

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
const signer = new Signer(new PrivateKey("a77e57", 16));
const arcade = await FakeArcade.start();
const ports = { a: await freePort(), b: await freePort() };
const idOf = (h: string) => peerIdOf(signer.peerKey(h)).toString();
const hdbA = new HostDb(join(home, "host.db"));
hdbA.add("ov", { store: join(home, "instances/ov/runtime.db") });
// An instance with no chain app: the overlay (requires chain/1) is refused there.
hdbA.add("bare", { store: join(home, "instances/bare/runtime.db") });
const hdbB = new HostDb(join(home, "pub-host.db"));
hdbB.add("pub", { store: join(home, "instances/pub/runtime.db") });
const common = { walletFor: () => ephemeralWallet(key("1111")), home, owner, idleMs: 0, providerKeyFor: (n: string) => signer.providerKey(n), peerKeyFor: (x: string) => signer.peerKey(x), answerWaitMs: 6000, kernel: { command: kernel, env: { SKEIN_HOME: home } }, libp2pDiscoveryMs: 300 };
const log = (who: string) => (s: string, l: string) => { if (process.env.VERBOSE) process.stdout.write(`  | [${who}:${s}] ${l}\n`); };
// A: the stock system; its genesis's defaults name the network only (no overlay config, no libp2p).
const rA = new Router({
  ...common, db: hdbA, genesis: { defaults: { walletNetwork: "regtest" } },
  arc: { url: arcade.url, token: "the-host-arcade-token", events: arcade.eventsUrl }, arcRetry: { min: 500, max: 2000 },
  libp2p: { listen: [`/ip4/127.0.0.1/tcp/${ports.a}`], bootstrap: [`/ip4/127.0.0.1/tcp/${ports.b}/p2p/${idOf("pub")}`], dht: "off", relays: [], mdns: false },
  log: log("a"),
});
// B: a plain instance whose genesis subscribes the overlays' topics: the publisher.
const rB = new Router({
  ...common, db: hdbB, genesis: { libp2p: { topics: ["tm_demo", "tm_three"] } },
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
  const headOf = async (name: string) => (await (await kA()).call("head", name)) as CID | null;
  const g = await (await kA()).genesis() as { defaults?: Record<string, string>; libp2p?: unknown };
  await rB.hydrate("pub");
  store = hdbA.get("ov")!.store;
  check(!g.libp2p && !!g.defaults && !("overlayTopics" in g.defaults) && !("overlayLookups" in g.defaults), `the instance's genesis has no overlay config and no libp2p (defaults: ${Object.keys(g.defaults ?? {}).filter((k) => k.startsWith("overlay") || k === "walletNetwork").join(", ")})`);
  check(rA.p2p?.node("ov") === undefined, "before the install: no libp2p node for the instance");

  const ownerWallet = ephemeralWallet(ownerKey);
  const out: string[] = [], err: string[] = [];
  const cli = async (...args: string[]) => {
    out.length = 0; err.length = 0;
    // #124: install/uninstall are the owner's messages, planned (`skein plan`) and sent to /sendMessage (src/testapps.ts ownerCli).
    const o = args[0] === "install" || args[0] === "uninstall" ? await ownerCli({ home: home, port: rA.port!, owner: ownerWallet, settled: () => rA.settled() }, args) : undefined;
    if (o) { out.push(...o.out); err.push(...o.err); }
    const code = o ? o.code : await main(args, {
      vars: { SKEIN_HOME: home, HOME: home }, out: (l) => out.push(l), err: (l) => err.push(l),
    });
    await rA.settled();
    if (process.env.VERBOSE) for (const l of [...out, ...err]) process.stdout.write(`  | ${l}\n`);
    return code;
  };
  const served = () => rA.p2p?.served("ov");
  const subscribers = (r: Router, h: string, topic: string) => ((r.p2p?.node(h)?.services as { pubsub: { getSubscribers(t: string): unknown[] } } | undefined)?.pubsub.getSubscribers(topic).length ?? 0);
  const overlayDir = checkout(process.env.SKEIN_OVERLAY_DIR, OVERLAY_REPO, OVERLAY_REV, join(home, "overlay"));
  const chainDir = checkout(process.env.SKEIN_CHAIN_DIR, CHAIN_REPO, CHAIN_REV, join(home, "chain"));

  // ------------------------------------------------ requires chain/1: refused without the chain app
  await rA.hydrate("bare");
  let code = await cli("install", overlayDir, "--instance", "bare");
  check(code !== 0 && /requires chain\/1/.test(err.join(" ")), `the overlay into an instance without the chain app: refused (${code}: ${err.join(" ")})`);

  // ------------------------------------------------ the chain app, then the overlay: on one instance (#79)
  code = await cli("install", chainDir, "--instance", "ov");
  check(code === 0, `skein plan install skein-chain: exit ${code} ${err.join(" ")}`);
  code = await cli("install", overlayDir, "--instance", "ov");
  const derived = out.filter((l) => l.includes("(derived: config.overlay)"));
  check(code === 0, `skein plan install skein-overlay beside the chain app (requires chain/1 satisfied): exit ${code} ${err.join(" ")}`);
  check(["row       libp2p tm_demo from anyone → overlay.submit (filter beef)", "row       libp2p tm_demo-admit from anyone → overlay.peerAdmit", "row       libp2p tm_demo-proof from anyone → overlay.peerProof", "row       http /overlay/submit from anyone → overlay.submit (filter beef)", "row       http /overlay/lookup from anyone → overlay.lookup", "row       mailbox overlay from event → overlay", "row       mailbox overlay from $self → overlay"].every((x) => derived.some((l) => l.includes(x))) && derived.length === 7 && derived.filter((l) => l.includes("(filter beef)")).length === 2 && out.some((l) => l.includes("dispatch add http /overlay/submit from anyone → overlay.submit (filter beef)")), `the prompt shows the wiring derived from config.overlay, the filter of the submit rows (#121) among it (${derived.length} lines: ${derived.map((l) => l.trim().replace(/\s+/g, " ").replace(" (derived: config.overlay)", "")).join(" | ")})`);
  check(!out.some((l) => /grants|mailbox (chain|status|submit) from .* → overlay/.test(l)), "no grants, no chain/status/submit box for the overlay (#79: the chain app's)");
  const app = await record("overlay/app");
  const appRows = async (name = "overlay") => ((await (await kA()).dispatch()).rows as Array<Record<string, unknown>>).filter((r) => r.app === name);
  const rowsT = await appRows();
  check(app?.kind === "app" && app.version === "0.7.0" && (app.config as { overlay?: unknown })?.overlay !== undefined && (await headOf("overlay")) === null, "the head overlay/app is the app record (0.7.0), with config.overlay; no alias head `overlay`");
  check(["libp2p tm_demo", "libp2p tm_demo-admit", "libp2p tm_demo-proof", "http /overlay/submit", "http /overlay/lookup", "mailbox overlay"].every((p) => rowsT.some((r) => `${r.transport} ${r.address}` === p)), `the dispatch table has the derived rows: ${rowsT.map((r) => `${r.transport} ${r.address}`).join(", ")}`);
  const topics1 = ["tm_demo", "tm_demo-admit", "tm_demo-proof"];
  const s1 = await until("the node subscribes the installed topics", () => { const s = served(); return s && topics1.every((t) => s.topics.includes(t)) ? s : undefined; }, 10_000).catch((e: Error) => { process.stdout.write(`  (${e.message})\n`); return undefined; });
  check(!!s1 && s1.topics.length === 3, `live, no restart: the instance's node subscribes ${s1?.topics.join(", ")}`);

  // The chain: the funding transaction mined at 1 (second in its block), a header event in box chain (the chain app's).
  const alice = key("3333");
  const fund = new Transaction();
  fund.addInput({ sourceTXID: "72".repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex("51"), sequence: 0xffffffff });
  for (let i = 0; i < 5; i++) fund.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 10_000 });
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
  // BRC-24 at an app's base URL (`${origin}/<app>`), the JSON form.
  const lookup = async (topic: string, app = "overlay") => {
    const res = await fetch(`${rA.originOf("ov")}/${app}/lookup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service: "ls_demo", query: { topic } }) });
    if (res.status !== 200) throw new Error(`POST /${app}/lookup: ${res.status} ${await res.text()}`);
    const r = await res.json() as { outputs: Array<{ beef: number[]; outputIndex: number }> };
    return r.outputs.map((o) => `${Transaction.fromBEEF(o.beef).id("hex")}:${o.outputIndex}`);
  };
  const meshed = async (topic: string) => {
    await until(`the publisher sees the instance on ${topic}`, () => subscribers(rB, "pub", topic) > 0 || undefined);
    await sleep(1200); // a heartbeat: the instance in the publisher's mesh
  };

  // ------------------------------------------------ gossip on tm_demo: judged by the installed overlay, admitted on the chain app's answer
  const t1 = token(0);
  await t1.sign();
  await meshed("tm_demo");
  await rB.p2p!.publish("pub", "tm_demo", new Uint8Array(t1.toBEEF()));
  const found1 = await until("the gossiped token is admitted and found", async () => { await rA.settled(); const l = await lookup("tm_demo"); return l.includes(`${t1.id("hex")}:0`) ? l : undefined; }, 30_000).catch((e: Error) => { process.stdout.write(`  (${e.message})\n`); return undefined; });
  check(!!found1, `a token published on tm_demo by the other router: judged by the manifest's topic manager, admitted on the chain app's answer (Arcade's word), found by /overlay/lookup (ls_demo) (${found1?.join(", ")})`);
  check(arcade.posts.some((b) => FakeArcade.txOf(b).id("hex") === t1.id("hex")), "the chain app broadcast it (the host's Arcade got it)");

  // An HTTP submit to /overlay/submit: the STEAK.
  const t2 = token(1);
  await t2.sign();
  const sub = await fetch(`${rA.originOf("ov")}/overlay/submit`, { method: "POST", headers: { "x-topics": "tm_demo" }, body: new Uint8Array(t2.toBEEF()) });
  const steak = await sub.json() as Record<string, { outputsToAdmit?: number[] }>;
  check(sub.status === 200 && JSON.stringify(steak.tm_demo?.outputsToAdmit) === "[0]", `POST /overlay/submit: ${sub.status} ${JSON.stringify(steak)}`);
  const list = await fetch(`${rA.originOf("ov")}/overlay/listTopicManagers`);
  const listed1 = Object.keys(await list.json() as Record<string, unknown>);
  check(list.status === 200 && JSON.stringify(listed1) === '["tm_demo"]', `/overlay/listTopicManagers (the manifest's own row; the topics config.overlay names): ${JSON.stringify(listed1)}`);

  // ------------------------------------------------ BRC-22 submit → the chain app → BRC-24 lookup, over HTTP at the base URL (#111)
  // The base URL on a host without wildcard DNS: /@<handle>/<app> on the router's origin (docs/OVERLAY.md "Installing an overlay").
  const base = `http://127.0.0.1:${rA.port}/@ov/overlay`;
  // A mined token: block 2 is [coinbase, tM]; its parent (fund) is proven at 1. The header reaches the chain app as the feed's would.
  const tM = token(4);
  await tM.sign();
  const cb2 = "cd".repeat(32);
  tM.merklePath = new MerklePath(2, [[{ offset: 0, hash: cb2 }, { offset: 1, hash: tM.id("hex"), txid: true }]]);
  const h2 = mine(sha256d(h1), sha256d(Buffer.concat([internal(cb2), internal(tM.id("hex"))])), 1_790_100_600);
  await rA.admitEvent("ov", "chain", { kind: "header", raw: h2 });
  await rA.settled();
  const postsBefore = arcade.posts.length;
  const subM = await fetch(`${base}/submit`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-topics": "tm_demo" }, body: new Uint8Array(tM.toBEEF()) });
  const steakM = await subM.json() as Record<string, { outputsToAdmit?: number[] }>;
  check(subM.status === 200 && JSON.stringify(steakM) === '{"tm_demo":{"outputsToAdmit":[0],"coinsToRetain":[],"coinsRemoved":[]}}', `BRC-22 POST ${base.replace(/^http:\/\/[^/]+/, "")}/submit (X-Topics: tm_demo, a mined token's BEEF): ${subM.status} ${JSON.stringify(steakM)}`);
  // The chain app's answer: proven from the BEEF at once, nothing broadcast.
  const chainApp = ((await record("chain/app")) as { programs: Record<string, CID> }).programs.chain!;
  const stateOf = async (txid: string) => { const r = await (await kA()).invoke(chainApp, "status", dagCbor.encode({ txid })); return r.ok ? (dagCbor.decode(r.result) as { state?: string }).state : String(r.error); };
  const stM = await stateOf(tM.id("hex"));
  check(stM === "proven" && arcade.posts.length === postsBefore, `the chain app's answer: ${stM}, admitted on it; nothing posted to Arcade (${arcade.posts.length - postsBefore} posts)`);
  // BRC-24: the output back, its BEEF verifying against the headers the chain app holds.
  const roots: Record<number, string> = { 1: Buffer.from(h1.subarray(36, 68)).reverse().toString("hex"), 2: Buffer.from(h2.subarray(36, 68)).reverse().toString("hex") };
  const tracker = { isValidRootForHeight: async (root: string, height: number) => roots[height] === root, currentHeight: async () => 2 };
  const lookupAt = async (query: Record<string, unknown>) => {
    const res = await fetch(`${base}/lookup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service: "ls_demo", query }) });
    const body = await res.json() as { type?: string; outputs?: Array<{ beef: number[]; outputIndex: number }> };
    const outs = await Promise.all((body.outputs ?? []).map(async (o) => { const t = Transaction.fromBEEF(o.beef); return [t.id("hex"), o.outputIndex, await t.verify(tracker).catch(() => false)] as const; }));
    return { status: res.status, type: body.type, outs };
  };
  const lkM = await lookupAt({ txid: tM.id("hex"), outputIndex: 0, topic: "tm_demo" });
  check(lkM.status === 200 && lkM.type === "output-list" && lkM.outs.length === 1 && lkM.outs[0]![0] === tM.id("hex") && lkM.outs[0]![1] === 0 && lkM.outs[0]![2] === true, `BRC-24 POST …/@ov/overlay/lookup {service: ls_demo, query: {txid, outputIndex: 0, topic: tm_demo}}: ${lkM.status} ${lkM.type} [${lkM.outs.map((o) => `${o[0].slice(0, 8)}:${o[1]} verifies ${o[2]}`).join(", ")}]`);
  // The token submitted above while unproven, admitted on Arcade's accepted: found the same way.
  const lk2 = await lookupAt({ txid: t2.id("hex"), outputIndex: 0, topic: "tm_demo" });
  check(lk2.status === 200 && lk2.outs.length === 1 && lk2.outs[0]![0] === t2.id("hex") && lk2.outs[0]![2] === true, `the unproven one admitted on the chain app's accepted: found too, its BEEF verifying (${lk2.status} [${lk2.outs.map((o) => `${o[0].slice(0, 8)}:${o[1]} verifies ${o[2]}`).join(", ")}])`);

  // ------------------------------------------------ a second overlay app on the same instance (#79)
  const dir2 = join(home, "overlay2");
  cpSync(overlayDir, dir2, { recursive: true, filter: (p) => !/\/(\.git|zig-out|\.zig-cache|zig-pkg)$/.test(p) });
  const mf2 = JSON.parse(readFileSync(join(dir2, "etc/app.json"), "utf8")) as { name: string; config: { overlay: Record<string, unknown> } };
  mf2.name = "overlay2";
  mf2.config.overlay = { topics: { tm_two: "topic-demo" }, lookups: { ls_demo: { program: "lookup-demo", topics: ["tm_two"] } }, gossip: { tm_two: true } };
  // skein-overlay 0.7.0 (#128): the stock manifest's row {address: "overlay", sender: "$owner"} is the box
  // overlay2/overlay here; register / deregister go there (the engine takes them in any box routed to it).
  writeFileSync(join(dir2, "etc/app.json"), JSON.stringify(mf2, null, 2));
  code = await cli("install", dir2, "--instance", "ov");
  check(code === 0 && out.some((l) => l.includes("row       mailbox overlay2 from event → overlay")) && out.some((l) => l.includes("row       mailbox overlay2/overlay from $owner → overlay")) && out.some((l) => l.includes("row       http /overlay2/submit from anyone → overlay.submit")), `two overlay apps on one instance: the same tree installed as overlay2 (its own box, its own routes, no row clash): exit ${code} ${err.join(" ")}`);
  const t3 = token(2);
  await t3.sign();
  const sub2 = await fetch(`${rA.originOf("ov")}/overlay2/submit`, { method: "POST", headers: { "x-topics": "tm_two" }, body: new Uint8Array(t3.toBEEF()) });
  const steak2 = await sub2.json() as Record<string, { outputsToAdmit?: number[] }>;
  const sub2b = await fetch(`${rA.originOf("ov")}/overlay/submit`, { method: "POST", headers: { "x-topics": "tm_two" }, body: new Uint8Array(t3.toBEEF()) });
  const steak2b = await sub2b.json() as Record<string, { outputsToAdmit?: number[] }>;
  const in2 = await lookup("tm_two", "overlay2");
  const in1 = await lookup("tm_two", "overlay");
  check(sub2.status === 200 && JSON.stringify(steak2.tm_two?.outputsToAdmit) === "[0]" && in2.includes(`${t3.id("hex")}:0`) && in1.length === 0 && JSON.stringify(steak2b) === "{}", `a submission to /overlay2/submit is admitted by overlay2 (${JSON.stringify(steak2)}, found ${in2.join(",")}), not by overlay (serves no tm_two: ${JSON.stringify(steak2b)}, finds ${in1.length})`);
  const heads2 = await Promise.all(["overlay/state", "overlay2/state", "overlay/ls_demo", "overlay2/ls_demo", "chain/state"].map(async (n) => [n, String(await headOf(n))]));
  check(heads2.every(([, c]) => c !== "null") && new Set(heads2.map(([, c]) => c)).size === 5, `each writes only its own heads: ${heads2.map(([n]) => n).join(", ")} — five distinct roots`);
  const st1 = await record("overlay/state") as { kind?: string; maps?: Record<string, CID | null> } | undefined;
  const st2 = await record("overlay2/state") as { kind?: string; maps?: Record<string, CID | null> } | undefined;
  check(st1?.kind === "overlay-state" && st2?.kind === "overlay-state" && String(st1.maps?.applied) !== String(st2.maps?.applied), "overlay/state and overlay2/state are separate overlay-state records (their own applied maps)");
  // Both read the one chain state: the chain app holds every submission of either.
  const chainProg = ((await record("chain/app")) as { programs: Record<string, CID> }).programs.chain!;
  const status = async (txid: string) => { const r = await (await kA()).invoke(chainProg, "status", dagCbor.encode({ txid })); return r.ok ? (dagCbor.decode(r.result) as { state?: string }).state : r.error; };
  const states = await Promise.all([t1, t2, t3].map((t) => status(t.id("hex"))));
  check(states.every((s) => s === "unproven"), `both overlays' submissions are in the one chain/state (the chain app's status: ${states.join(", ")})`);

  // ------------------------------------------------ register / deregister (skein-overlay 0.7.0, #119, #128): the owner registers tm_reg in overlay2, box overlay2/overlay
  const identity = (await rA.hydrate("ov")).identity;
  const toBox = async (body: unknown) => { await new RawBox(ownerWallet, `http://127.0.0.1:${rA.port}/@ov`).send(identity, "overlay2/overlay", body); await rA.settled(); };
  const folded = async () => { const s = openStoreFile(store, { readOnly: true }); try { return (await subscriptionsOf(s)).filter((x) => x.app === "overlay2").map((x) => `${x.topic} ${x.program}.${x.fn}${x.filter ? ` (filter ${x.filter})` : ""}`).sort().join("; "); } finally { s.close(); } };
  await toBox({ fn: "register", args: { topic: "tm_reg", program: "topic-demo" } });
  const subsReg = await folded();
  const regSet = await record("overlay2/topics") as { kind?: string; topics?: Array<{ topic: string; program: string }> } | undefined;
  const sReg = await until("the node subscribes tm_reg", () => { const s = served(); return s && ["tm_reg", "tm_reg-admit", "tm_reg-proof"].every((t) => s.topics.includes(t)) ? s : undefined; }, 10_000).catch(() => undefined);
  check(subsReg === "tm_reg overlay.submit (filter beef); tm_reg-admit overlay.peerAdmit; tm_reg-proof overlay.peerProof" && regSet?.kind === "overlay-topics" && JSON.stringify(regSet.topics) === '[{"topic":"tm_reg","program":"topic-demo"}]' && !!sReg, `the owner's register {topic: tm_reg, program: topic-demo} in box overlay2: three subscriptions (${subsReg}), overlay2/topics ${JSON.stringify(regSet?.topics)}, the node subscribes them (${sReg?.topics.filter((t) => t.startsWith("tm_reg")).join(", ")})`);
  // Every funding output is spent by now: this token spends t3's change.
  const tR = new Transaction();
  tR.addInput({ sourceTransaction: t3, sourceOutputIndex: 1, unlockingScriptTemplate: new P2PKH().unlock(alice), sequence: 0xffffffff });
  tR.addOutput({ lockingScript: Script.fromBinary([0x07, ...Buffer.from("tm_demo"), 0x75, ...new P2PKH().lock(alice.toPublicKey().toHash()).toBinary()]), satoshis: 1 });
  tR.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 8_000 });
  await tR.sign();
  const stateBefore = String(await headOf("overlay2/state"));
  await meshed("tm_reg");
  await rB.p2p!.publish("pub", "tm_reg", new Uint8Array(tR.toBEEF()));
  const moved = await until("overlay2 takes the token on tm_reg", async () => { await rA.settled(); return String(await headOf("overlay2/state")) !== stateBefore || undefined; }, 20_000).catch(() => false);
  const listedR = Object.keys(await (await fetch(`${rA.originOf("ov")}/overlay2/listTopicManagers`)).json() as Record<string, unknown>).sort();
  check(!!moved && JSON.stringify(listedR) === '["tm_reg","tm_two"]', `the kernel delivers tm_reg by the subscription, no row: a token published there moves overlay2/state; /overlay2/listTopicManagers ${JSON.stringify(listedR)}`);
  await toBox({ fn: "deregister", args: { topic: "tm_reg" } });
  const subsDe = await folded();
  const sDe = await until("the node leaves tm_reg", () => { const s = served(); return s && !s.topics.some((t) => t.startsWith("tm_reg")) ? s : undefined; }, 10_000).catch(() => undefined);
  check(subsDe === "" && !!sDe && JSON.stringify((await record("overlay2/topics") as { topics?: unknown[] } | undefined)?.topics) === "[]", `deregister {topic: tm_reg}: unsubscribed (${subsDe || "none left"}), the node leaves it (${sDe?.topics.join(", ")})`);

  // ------------------------------------------------ reinstall: a third topic, read at the next step
  const dir = join(home, "overlay-three");
  cpSync(overlayDir, dir, { recursive: true, filter: (p) => !/\/(\.git|zig-out|\.zig-cache|zig-pkg)$/.test(p) });
  const mf = JSON.parse(readFileSync(join(dir, "etc/app.json"), "utf8")) as { version: string; config: { overlay: { topics: Record<string, string>; lookups: Record<string, { program: string; topics: string[] }> } } };
  mf.version = `${mf.version}-three`;
  mf.config.overlay.topics.tm_three = "topic-demo";
  mf.config.overlay.lookups.ls_demo!.topics = ["tm_demo", "tm_three"];
  writeFileSync(join(dir, "etc/app.json"), JSON.stringify(mf, null, 2));
  code = await cli("install", dir, "--instance", "ov");
  check(code === 0 && /^upgrade overlay /.test(out[0] ?? "") && out.some((l) => l.includes("row       libp2p tm_three from anyone → overlay.submit")), `reinstalled with config.overlay.topics.tm_three: exit ${code} ${out[0]} ${err.join(" ")}`);
  const topics2 = [...topics1, "tm_two", "tm_two-admit", "tm_two-proof", "tm_three", "tm_three-admit", "tm_three-proof"];
  const s2 = await until("the node subscribes tm_three", () => { const s = served(); return s && topics2.every((t) => s.topics.includes(t)) ? s : undefined; }, 10_000).catch((e: Error) => { process.stdout.write(`  (${e.message})\n`); return undefined; });
  check(!!s2 && s2.topics.length === 9 && rA.p2p?.node("ov") !== undefined, `no restart: the node now subscribes both overlays' topics: ${s2?.topics.join(", ")}`);
  const listed2 = Object.keys(await (await fetch(`${rA.originOf("ov")}/overlay/listTopicManagers`)).json() as Record<string, unknown>);
  check(JSON.stringify(listed2.sort()) === '["tm_demo","tm_three"]', `the engine reads the new app record at its next call: /overlay/listTopicManagers ${JSON.stringify(listed2)}`);
  const t4 = token(3);
  await t4.sign();
  await meshed("tm_three");
  await rB.p2p!.publish("pub", "tm_three", new Uint8Array(t4.toBEEF()));
  const found4 = await until("the token on tm_three is admitted and found", async () => { await rA.settled(); const l = await lookup("tm_three"); return l.includes(`${t4.id("hex")}:0`) ? l : undefined; }, 30_000).catch((e: Error) => { process.stdout.write(`  (${e.message})\n`); return undefined; });
  check(!!found4 && !found4.includes(`${t1.id("hex")}:0`), `a token published on tm_three: judged under tm_three (the new config), found by a lookup on tm_three (${found4?.join(", ")})`);

  // ------------------------------------------------ uninstall: the rows go, the node unsubscribes
  code = await cli("uninstall", "overlay", "--instance", "ov");
  check(code === 0, `skein plan uninstall overlay: exit ${code} ${out[0]} ${err.join(" ")}`);
  const left = await appRows();
  check(left.length === 0 && (await appRows("overlay2")).length > 0, `no overlay rows left in the dispatch table (${left.length}); overlay2's stand`);
  const s3 = await until("the node unsubscribes overlay's topics", () => { const s = served(); return s && s.topics.length === 3 && s.topics.every((t) => t.startsWith("tm_two")) ? s : undefined; }, 10_000).catch(() => undefined);
  check(!!s3, `the node keeps overlay2's topics only: ${s3?.topics.join(", ")}`);
  const leftB = await until("the publisher sees it leave", () => (subscribers(rB, "pub", "tm_demo") === 0 && subscribers(rB, "pub", "tm_three") === 0) || undefined, 20_000).catch(() => false);
  check(leftB, "the publisher's node sees the instance leave tm_demo and tm_three");
  const r = await fetch(`${rA.originOf("ov")}/overlay/lookup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service: "ls_demo", query: { topic: "tm_demo" } }) });
  check(r.status === 404, `after uninstall, /overlay/lookup is no route: ${r.status}`);
  code = await cli("uninstall", "overlay2", "--instance", "ov");
  const gone = await until("the node stops", () => (served() === undefined && rA.p2p?.node("ov") === undefined) || undefined, 10_000).catch(() => false);
  check(code === 0 && gone, "overlay2 uninstalled too: no libp2p row left and none in the genesis: the instance's node unsubscribed and stopped");
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

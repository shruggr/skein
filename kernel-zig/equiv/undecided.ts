// Undecided is not rejected, and nothing is wanted (shruggr/skein-overlay
// 0.19.0 / 0.20.0, shruggr/skein-1color 0.13.1; David 2026-10-30: "we don't
// mark items which are undecided as invalid", and the settled sync design: no
// want, no timed retry): two hosts with libp2p, each a stock-system instance
// with the chain app and the 1color app (its engine skein-overlay 0.20.0, its
// topic manager color-topic) installed by the owner's messages, one 1Color
// token's topic tm_color_<D>_0 registered on each.
//
//   - b holds the token's deploy D (spending a mined funding transaction F),
//     a transfer P (spends D) and a transfer C (spends P), each mined alone
//     with its BUMP, admitted under the topic; b's beacons are held back
//     (stopped) while a is set up;
//   - a, which holds none of them, is posted ONLY C's Atomic BEEF (C + its
//     BUMP). color-topic cannot read P: MissingParents → the engine pauses C
//     waiting [P]; NOTHING is wanted (no want event exists any more) and a
//     asks nobody;
//   - b's beacon starts again (the first beat publishes at once): a hears
//     b's beat, b's tip anchor is not a's → the locator, the pull of b's
//     admitted lists (D at its height, then P, then C), each BEEF into a's
//     receive row → D admitted, P admitted → C's pause ends (its resume on
//     P's admission, or the pulled C, whichever lands first) and C is
//     admitted once. a's admitted set equals b's.
//   - F (a mined funding-only parent of D) is never waited on; nothing on a
//     is ever recorded or answered as rejected (checked after each step).
//
// Each instance's store then replays to itself exactly.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/undecided.ts
//   (SKEIN_1COLOR_DIR / SKEIN_CHAIN_DIR: checkouts in place of the pinned commits)

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MerklePath, P2PKH, PrivateKey, Script, Transaction, UnlockingScript } from "@bsv/sdk";
import { CID } from "multiformats/cid";
import { ownerCli } from "../../src/testapps.ts";
import { RawBox } from "../../src/client/raw.ts";
import { storeSpec } from "../../src/runtime/index-store.ts";
import { openStoreFile } from "../../src/host/stores.ts";
import { BACKEND, routerStore, storeFor } from "./backend.ts";
import { FakeArcade } from "../../src/host/fake-arcade.ts";
import { HostDb } from "../../src/host/instances.ts";
import { Signer } from "../../src/host/signer.ts";
import { emittedEvents, peerIdOf } from "../../src/host/p2p.ts";
import { Router } from "../../src/host/router.ts";
import { ephemeralWallet } from "../../src/wallet.ts";

const COLOR_REPO = "https://github.com/shruggr/skein-1color";
const COLOR_REV = process.env.SKEIN_1COLOR_REV ?? "14a3acc683312775e1ea92d769271f90b5cd1043"; // v0.13.1: color-topic's MissingParents, engine skein-overlay 0.20.0
const CHAIN_REPO = "https://github.com/shruggr/skein-chain";
const CHAIN_REV = process.env.SKEIN_CHAIN_REV ?? "7da428422ce193a1bb489163637f070860d46ccd"; // v0.7.1
const APP = "1color";
const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
const home = mkdtempSync(join(tmpdir(), "skein-kz-undecided-"));
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
  if (envDir) { cpSync(envDir, dir, { recursive: true, filter: (p) => !/\/(\.git|zig-out|\.zig-cache|zig-pkg|web|node_modules)$/.test(p) }); return dir; }
  for (const args of [["clone", "-q", repo, dir], ["-C", dir, "checkout", "-q", rev]]) {
    const r = spawnSync("git", args, { stdio: ["ignore", "ignore", "inherit"] });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: exit ${r.status}`);
  }
  rmSync(join(dir, "web"), { recursive: true, force: true });
  return dir;
}

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

/** Every overlay step's result record in a store, oldest first, each once (as sync.ts). */
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
const admittedTxids = (rs: Array<Record<string, unknown>>) => new Set(rs.flatMap((x) => x.admitted === true ? [x.txid as string, ...((x.admissions ?? []) as Array<{ txid?: string }>).map((a) => a.txid!)] : []).filter(Boolean));

// ---------------------------------------------------------------- two routers with libp2p

const key = (h: string) => new PrivateKey(h, 16);
const ownerKey = key("2222");
const owner = ownerKey.toPublicKey().toString();
const ownerWallet = ephemeralWallet(ownerKey);
const signer = new Signer(new PrivateKey("5c5c5c", 16));
const arcade = await FakeArcade.start();
const names = ["a", "b"] as const;
type Name = typeof names[number];
const ports: Record<Name, number> = { a: await freePort(), b: await freePort() };
const idOf = (h: string) => peerIdOf(signer.peerKey(h)).toString();
const addr = (h: Name) => `/ip4/127.0.0.1/tcp/${ports[h]}/p2p/${idOf(h)}`;
const walletKeys: Record<string, string> = { a: "1111", b: "1112" };
const dbs: Partial<Record<Name, HostDb>> = {};
const routers: Partial<Record<Name, Router>> = {};
const log = (who: string) => (s: string, l: string) => { if (process.env.VERBOSE || /^sync: /.test(l)) process.stdout.write(`  | [${who}:${s}] ${l}\n`); };
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
    libp2p: { listen: [`/ip4/127.0.0.1/tcp/${ports[h]}`], bootstrap: names.filter((x) => x !== h).map(addr), dht: "off", relays: [], mdns: false },
    log: log(h),
  });
}
const r = (h: Name) => routers[h]!;
const storeOf = (h: Name) => storeSpec(dbs[h]!.get(h)!);
const stores: string[] = [];

// ---------------------------------------------------------------- the token: F (funding, mined at 1), D deploy (2), P (3), C (4)

const alice = key("3333");
const lock = () => new P2PKH().lock(alice.toPublicKey().toHash());
const fund = new Transaction();
fund.addInput({ sourceTXID: "72".repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex("51"), sequence: 0xffffffff });
fund.addOutput({ lockingScript: lock(), satoshis: 10_000 });
const fundTxid = fund.id("hex");
fund.merklePath = new MerklePath(1, [[{ offset: 0, hash: "cb".repeat(32) }, { offset: 1, hash: fundTxid, txid: true }]]);
const headers: Uint8Array[] = [mine(sha256d(REGTEST_GENESIS), sha256d(Buffer.concat([internal("cb".repeat(32)), internal(fundTxid)])), 1_790_200_000)];
/** BRC-162: `<id | OP_0> <amount> OP_2DROP <P2PKH>`; id the deploy txid, internal byte order (a 32-byte push). */
const AMOUNT = [0x02, 0xe8, 0x03]; // 1000, a minimal script number
const colorScript = (deploy?: string) => Script.fromBinary([...(deploy ? [0x20, ...internal(deploy)] : [0x00]), ...AMOUNT, 0x6d, ...lock().toBinary()]);
async function tx(source: Transaction, vout: number, script: Script, sats: number): Promise<Transaction> {
  const t = new Transaction();
  t.addInput({ sourceTransaction: source, sourceOutputIndex: vout, unlockingScriptTemplate: new P2PKH().unlock(alice), sequence: 0xffffffff });
  t.addOutput({ lockingScript: script, satoshis: sats });
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
const feedHeaders = async (h: Name, from = 1) => {
  for (let i = from; i <= headers.length; i++) await r(h).chainHeaders(h, "chain", [headers[i - 1]!]);
  await r(h).settled();
};
const origin = (h: Name) => r(h).originOf(h);
const submit = async (h: Name, beef: number[] | Uint8Array, topics: string) => await fetch(`${origin(h)}/${APP}/submit`, { method: "POST", headers: { "x-topics": topics }, body: Uint8Array.from(beef) });
const subscribers = (h: Name, topic: string) => ((r(h).p2p?.node(h)?.services as { pubsub: { getSubscribers(t: string): unknown[] } } | undefined)?.pubsub.getSubscribers(topic).length ?? 0);
/** The topic's admitted lists on `h` (the engine's fn `admitted`, as the sync puller reads its own). */
const admittedOn = async (h: Name, topic: string) => {
  const x = await (r(h) as unknown as { overlayRead(h: string, app: string, fn: string, q: Record<string, string>): Promise<{ blocks: Array<{ height: number; txids: string[] }> }> }).overlayRead(h, APP, "admitted", { topic, fromHeight: "1", toHeight: "100" });
  return x.blocks.map((b) => `${b.height}:${b.txids.join(",")}`).join(" ");
};

let colorDir = "";
let chainDir = "";
async function bring(h: Name, topic: string): Promise<void> {
  routers[h] = router(h);
  await r(h).listen(0);
  await r(h).hydrate(h);
  stores.push(storeOf(h));
  const host = { home: homeOf(h), port: r(h).port!, owner: ownerWallet, settled: () => r(h).settled() };
  for (const dir of [chainDir, colorDir]) {
    const o = await ownerCli(host, ["install", dir, "--instance", h]);
    if (o.code !== 0) throw new Error(`${h}: install ${dir}: ${o.err.join(" ")}`);
    await r(h).settled();
  }
  const identity = (await r(h).hydrate(h)).identity;
  await new RawBox(ownerWallet, `http://127.0.0.1:${r(h).port}/@${h}`).send(identity, `${APP}/register`, { fn: "register", args: { topic, program: "color-topic" } });
  await r(h).settled();
  await feedHeaders(h);
}

/** a's results so far, and the checks after each step: nothing rejected, F never waited on, no want event. */
const short = (x: unknown) => typeof x === "string" ? `${x.slice(0, 8)}…` : String(x);
let shown = 0;
async function stepCheck(label: string, ids: Record<string, string>): Promise<Array<Record<string, unknown>>> {
  const rs = await overlayResults(storeOf("a"));
  const nameOf = (t: unknown) => Object.entries(ids).find(([, v]) => v === t)?.[0] ?? short(t);
  for (const x of rs.slice(shown)) {
    const parts = [`op ${x.op}`];
    if (x.outcome) parts.push(`outcome ${x.outcome}`);
    if (x.txid) parts.push(`txid ${nameOf(x.txid)}`);
    if (Array.isArray(x.waiting)) parts.push(`waiting [${(x.waiting as string[]).map(nameOf).join(",")}]`);
    if (x.wanted !== undefined) parts.push(`wanted ${x.wanted}`);
    if (x.heard) parts.push(`heard ${x.heard}`);
    if (x.admitted !== undefined) parts.push(`admitted ${x.admitted}${Array.isArray(x.admissions) ? ` [${(x.admissions as Array<{ txid: string }>).map((a) => nameOf(a.txid)).join(",")}]` : ""}`);
    if (x.error) parts.push(`error ${JSON.stringify(x.error)}`);
    say(`a: ${parts.join(" · ")}`);
  }
  shown = rs.length;
  const rejected = rs.filter((x) => x.outcome === "dropped" || x.heard === "rejected" || x.heard === "failed" || (Array.isArray(x.unapplied) && x.unapplied.length > 0) || JSON.stringify(x.answers ?? []).includes("rejected"));
  check(rejected.length === 0, `${label}: nothing recorded or answered as rejected on a (${rejected.length})`);
  check(!rs.some((x) => Array.isArray(x.waiting) && (x.waiting as string[]).includes(fundTxid)), `${label}: F (D's mined funding parent) never waited on`);
  const v = openStoreFile(storeOf("a"), { readOnly: true });
  const wants = await emittedEvents(v, (rec) => rec.event === "want" || rec.event === "unwant" ? rec : undefined).finally(() => v.close());
  check(wants.length === 0 && !rs.some((x) => x.wanted !== undefined), `${label}: no want event on a, no step wanted anything (${wants.length})`);
  return rs;
}

try {
  colorDir = checkout(process.env.SKEIN_1COLOR_DIR, COLOR_REPO, COLOR_REV, join(home, "1color"));
  chainDir = checkout(process.env.SKEIN_CHAIN_DIR, CHAIN_REPO, CHAIN_REV, join(home, "chain"));
  // The validator beats every 2 s here (the default is 120 s); b's beacons are held back until a is paused.
  const mf = JSON.parse(readFileSync(join(colorDir, "etc/app.json"), "utf8")) as { version: string; config: { overlay: Record<string, unknown> } };
  mf.config.overlay.validator = { every: 2000 };
  writeFileSync(join(colorDir, "etc/app.json"), JSON.stringify(mf, null, 2));
  check(mf.version === "0.13.1", `skein-1color ${mf.version} (engine skein-overlay 0.20.0)`);

  const D = await tx(fund, 0, colorScript(), 1);
  const hD = mineAlone(D);
  const dTxid = D.id("hex");
  const topic = `tm_color_${dTxid}_0`;
  const P = await tx(D, 0, colorScript(dTxid), 1);
  const hP = mineAlone(P);
  const C = await tx(P, 0, colorScript(dTxid), 1);
  const hC = mineAlone(C);
  const ids = { F: fundTxid, D: dTxid, P: P.id("hex"), C: C.id("hex") };
  say(`F ${fundTxid.slice(0, 8)}… (mined 1, funding)  D ${ids.D.slice(0, 8)}… (deploy, ${hD})  P ${ids.P.slice(0, 8)}… (${hP})  C ${ids.C.slice(0, 8)}… (${hC}); topic ${topic.slice(0, 22)}…`);

  // ------------------------------------------------ b holds D, P, C (each mined, posted with its BUMP)
  await bring("b", topic);
  for (const [n, t] of [["D", D], ["P", P], ["C", C]] as const) {
    const s = await submit("b", t.toAtomicBEEF(), topic);
    check(s.status === 200, `b: ${n} posted (its Atomic BEEF, mined): ${s.status} ${(await s.text()).slice(0, 120)}`);
  }
  await r("b").settled();
  const onB = await admittedOn("b", topic);
  check(onB === `${hD}:${ids.D} ${hP}:${ids.P} ${hC}:${ids.C}`, `b admitted D, P, C (${onB.replace(/[0-9a-f]{64}/g, (t) => Object.entries(ids).find(([, v]) => v === t)![0])})`);

  // b's beacons held back while a is set up and paused (its node beats nothing; the beacons stand in its log).
  const bBeacons = (await r("b").hydrate("b")).beacons;
  r("b").p2p!.beacons("b", []);

  // ------------------------------------------------ a: holds none of them; meshed with b on the topic
  await bring("a", topic);
  await until("a and b meshed on the topic", () => (subscribers("a", topic) > 0 && subscribers("b", topic) > 0) || undefined);
  check(await admittedOn("a", topic) === "", "a admitted nothing yet");
  await stepCheck("a up", ids);

  // ------------------------------------------------ C's Atomic BEEF alone to a: undecided, paused, nothing asked
  const cBeef = C.toAtomicBEEF();
  const t0 = Date.now();
  const sc = await submit("a", cBeef, topic);
  const scText = await sc.text();
  say(`a: POST /${APP}/submit C alone (${cBeef.length} bytes, C + its BUMP) → ${sc.status} ${scText.slice(0, 160)} (${Date.now() - t0} ms)`);
  await sleep(3000);
  await r("a").settled();
  const paused = await stepCheck("C alone → paused", ids);
  const firstC = paused.find((x) => x.txid === ids.C && Array.isArray(x.waiting));
  check(!!firstC && (firstC.waiting as string[]).join() === ids.P, `C undecided: paused waiting [P] (color-topic MissingParents), no verdict`);
  check(await admittedOn("a", topic) === "", "a admitted nothing: no beat, no want — it waits");

  // ------------------------------------------------ b beats again: a's pull brings D then P; C resumes and is admitted
  r("b").p2p!.beacons("b", bBeacons);
  const t1 = Date.now();
  const all = await until("a admits C", async () => { await r("a").settled(); const x = await admittedOn("a", topic); return x.includes(ids.C) ? x : undefined; }, 90_000).catch(() => undefined);
  say(`a: admitted after ${Date.now() - t1} ms from b's beat`);
  const rs = await stepCheck("b's beat → pulled → admitted", ids);
  // P's admission sends C's resume; the pull lists C too (a lacks it as admitted) and delivers it at its height:
  // whichever lands first ends the pause and launches C's thread, the other finds nothing to do. Either way C is
  // admitted once, from its pause, with nothing rejected.
  const cAdmits = rs.filter((x) => x.admitted === true && (x.txid === ids.C || ((x.admissions ?? []) as Array<{ txid?: string }>).some((a) => a.txid === ids.C))).length;
  const resumes = rs.filter((x) => x.op === "resume" && x.txid === ids.C && x.outcome !== "woke").map((x) => String(x.outcome)); // "woke": the resume thread's wake at the end of the thread it launched
  check(cAdmits === 1 && resumes.length === 1 && ["launched", "none"].includes(resumes[0]!), `C's pause ended on P's admission: resumed once (${resumes.join()}), admitted once (${cAdmits})`);
  check(!rs.some((x) => x.txid === ids.P && Array.isArray(x.waiting)), "P pulled after D: decided at once, never paused");
  check(all === onB, `a's admitted set equals b's (${(all ?? "").replace(/[0-9a-f]{64}/g, (t) => Object.entries(ids).find(([, v]) => v === t)?.[0] ?? t)})`);
  check(admittedTxids(rs).has(ids.D) && admittedTxids(rs).has(ids.P) && admittedTxids(rs).has(ids.C), "a's results admit D, P and C");
  await sleep(1500);
  await r("a").settled();
  await stepCheck("settled", ids);
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
process.stdout.write(failures ? `undecided (${BACKEND}): ${failures} FAILED\n` : `undecided (${BACKEND}): all ok\n`);
process.exit(failures ? 1 : 0);

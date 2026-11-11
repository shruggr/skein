// A large bundle through the chain app (skein-chain 0.11.0), as in the live case: shruggr/skein-chain at
// a pinned tag (or $SKEIN_CHAIN_DIR) and the test caller programs/test/ingester on a router with a (fake)
// Arcade; a chain of N (BUNDLE_N, default 200) bare transactions over a proven funding, the last one's
// BEEF (the whole ancestry) ingested by one in-VM call: every one of them gets its intake status
// (pending); the intake's time is printed. The stores replay to themselves exactly.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/chain-bundle.ts

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MerklePath, P2PKH, PrivateKey, Transaction, UnlockingScript } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { RawBox } from "../../src/client/raw.ts";
import { dirSource, stockSystemFiles } from "../../src/host/boot.ts";
import { main } from "../../src/host/cli.ts";
import { ownerCli } from "../../src/testapps.ts";
import { FakeArcade } from "../../src/host/fake-arcade.ts";
import { testHost, until } from "../../src/host/testhost.ts";
import { ephemeralWallet } from "../../src/wallet.ts";
import { storeSpec } from "../../src/runtime/index-store.ts";
import { openStoreFile } from "../../src/host/stores.ts";
import { emittedEvents } from "../../src/host/p2p.ts";
import { BACKEND, ROCKS_MODE } from "./backend.ts";
import { txCid } from "../../src/host/feeds.ts";

// The app under test: SKEIN_CHAIN_DIR names a checkout, else this commit.
const CHAIN_REPO = "https://github.com/shruggr/skein-chain";
const CHAIN_REV = process.env.SKEIN_CHAIN_REV ?? "v0.11.0"; // skein-chain 0.11.0: a saved merkle path links every transaction it covers; status by subscription
const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };

// ---------------------------------------------------------------- regtest (as equiv/overlay.ts)

const sha256d = (b: Uint8Array) => createHash("sha256").update(createHash("sha256").update(b).digest()).digest();
const internal = (displayHex: string) => Buffer.from(displayHex, "hex").reverse();
const display = (h: Uint8Array) => Buffer.from(h).reverse().toString("hex");
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

const arcade = await FakeArcade.start();
const afters: Array<() => unknown> = [];
// The caller is the instance's owner (#79: the chain app's rows admit $owner and $self).
const callerKey = PrivateKey.fromRandom(), callerId = callerKey.toPublicKey().toString();
const h = await testHost({ after: (f) => afters.push(f) }, { ownerKey: callerKey, genesis: { defaults: { walletNetwork: "regtest" } }, arc: { url: arcade.url, token: "the-chain-arcade-token", events: arcade.eventsUrl }, arcRetry: { min: 300, max: 1000 }, rocks: ROCKS_MODE });
let store = "";
const bootStores: string[] = [];
/** The app's checkout at the pinned commit (for its bin/chain.wasm in a system tree). */
function cloneChain(home: string): string {
  const dir = join(home, "skein-chain");
  for (const args of [["clone", "-q", CHAIN_REPO, dir], ["-C", dir, "checkout", "-q", CHAIN_REV]]) {
    const r = spawnSync("git", args, { stdio: ["ignore", "ignore", "inherit"] });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: exit ${r.status}`);
  }
  return dir;
}
try {
  const callerWallet = ephemeralWallet(callerKey);
  const callerMailbox = await h.inbox(callerKey, "caller");
  const inst = h.instance("ch");
  await h.router.start();
  const owner = new RawBox(h.owner, `${h.base}/@ch`);
  await owner.send(inst, "peers", { op: "add", key: callerId, url: callerMailbox });
  await h.router.settled();
  store = storeSpec(h.db.get("ch")!);
  const k = async () => (await h.router.hydrate("ch")).kernel;
  const record = async (name: string) => {
    const kk = await k();
    const root = await kk.call("head", name) as CID | null;
    return root ? await kk.store.get(root) as Record<string, unknown> : undefined;
  };

  // ------------------------------------------------ install
  const out: string[] = [], err: string[] = [];
  const cli = async (...args: string[]) => {
    out.length = 0; err.length = 0;
    // #124: install/uninstall are the owner's messages, planned and sent on the owner's session (src/testapps.ts ownerCli).
    const o = args[0] === "install" || args[0] === "uninstall" ? await ownerCli({ home: h.home, port: h.router.port!, owner: h.owner, settled: () => h.router.settled() }, args) : undefined;
    if (o) { out.push(...o.out); err.push(...o.err); }
    const code = o ? o.code : await main(args, {
      vars: { SKEIN_HOME: h.home, HOME: h.home }, out: (l) => out.push(l), err: (l) => err.push(l),
    });
    await h.router.settled();
    if (process.env.VERBOSE) for (const l of [...out, ...err]) process.stdout.write(`  | ${l}\n`);
    return code;
  };
  const spec = process.env.SKEIN_CHAIN_DIR ?? `${CHAIN_REPO}#${CHAIN_REV}`;
  const code = await cli("install", spec, "--instance", "ch");
  check(code === 0, `skein install skein-chain: exit ${code} ${err.join(" ")}`);
  const routeLines = out.filter((l) => /^ {2}route /.test(l)).map((l) => l.trim().replace(/\s+/g, " "));
  check(routeLines.some((l) => l.startsWith("route event chain ")) && routeLines.some((l) => l.startsWith("route mailbox chain [kernel.beef] ")) && routeLines.some((l) => l.startsWith("route mailbox chain/status ")) && routeLines.length === 3,
    `the prompt shows its routes (#143: no sender; the BEEF decoded at the door): ${routeLines.join(" | ")}`);
  const app = await record("chain/app");
  check(app?.kind === "app" && app.name === "chain" && app.version === "0.11.0", `the head chain/app is the app record (0.11.0: ${String(app?.version)})`);
  const rows = ((await (await k()).dispatch()).rows as Array<Record<string, unknown>>).filter((r) => r.app === "chain");
  check(rows.length === 3 && rows.every((r) => !("sender" in r) && !("optional" in r)) && rows.map((r) => `${r.transport} ${r.address}`).join(",") === "event chain,mailbox chain,mailbox chain/status"
    && JSON.stringify(rows[1]!.filters) === '["kernel.beef"]',
  `its routes in the table (#143: event chain; mailbox chain with kernel.beef; mailbox chain/status): ${rows.map((r) => `${r.transport} ${r.address} ${JSON.stringify(r.filters ?? [])}`).join(", ")}`);

  // ------------------------------------------------ the chain: block 1 holds the funding alone
  const alice = PrivateKey.fromRandom();
  const fund = new Transaction();
  fund.addInput({ sourceTXID: "72".repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex("51"), sequence: 0xffffffff });
  for (let i = 0; i < 3; i++) fund.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 10_000 });
  const fundTxid = fund.id("hex");
  fund.merklePath = new MerklePath(1, [[{ offset: 0, hash: fundTxid, txid: true }]]);
  const h1 = mine(sha256d(REGTEST_GENESIS), internal(fundTxid), 1_790_200_000);
  await h.router.chainHeaders("ch", "chain", [h1]);
  await h.router.settled();
  const state = async () => {
    const r = await record("chain/state") as { kind?: string; network?: string } | undefined;
    return r;
  };
  const st1 = await state();
  check(st1?.kind === "chain-state" && st1.network === "regtest", `the feed's header reached the chain app: chain/state is a chain-state on regtest (${JSON.stringify(st1 && { kind: st1.kind, network: st1.network })})`);

  
  // ------------------------------------------------ the test caller (programs/test/ingester)
  const callerBox = new RawBox(callerWallet, `${h.base}/@ch`);
  const send = async (box: string, body: Record<string, unknown>) => (await callerBox.send(inst, box, body)).id.toString();
  type Rec = Record<string, unknown>;
  const facts = async (name: string) => {
    const res = await fetch(`${h.base}/@ch/events/${name}`);
    if (res.status !== 200) throw new Error(`GET /events/${name}: ${res.status}`);
    return (await res.json() as Array<{ record: Rec }>).map((x) => x.record);
  };
  const statuses = async (txid: string) => (await facts(`chain/tx/${txid}`)).map((r) => `${String(r.status)}${r.height !== undefined ? `@${String(r.height)}` : ""}${r.reason !== undefined ? `:${String(r.reason)}` : ""}`).join(",");
  const outputs = async (op: string) => (await facts(`chain/output/${op}`)).map((r) => `${String(r.state)}:${String(r.spentBy).slice(0, 8)}`).join(",");
  const proofsOf = async (txid: string) => (await facts(`chain/proof/${txid}`)).map((r) => `${String(r.height)}/${String(r.position)}`).join(",");
  const eventually = async (what: string, f: () => Promise<string>, want: string) => {
    let got = "";
    await until(what, async () => { await h.router.settled(); got = await f(); return got === want || undefined; }, 20_000).catch(() => undefined);
    return got;
  };
  const postsOf = (txid: string) => arcade.posts.filter((b) => FakeArcade.txOf(b).id("hex") === txid).length;
  const ci = await cli("install", process.env.INGESTER_DIR ?? join(here, "../../programs/test/ingester"), "--instance", "ch");
  check(ci === 0, `install the test caller app (programs/test/ingester): exit ${ci} ${err.join(" ")}`);
  const spendOf = async (src: Transaction, vout: number, sats: number) => {
    const t = new Transaction();
    t.addInput({ sourceTransaction: src, sourceOutputIndex: vout, unlockingScriptTemplate: new P2PKH().unlock(alice), sequence: 0xffffffff });
    t.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: sats });
    await t.sign();
    return t;
  };


  // A LARGE BUNDLE (like the live case): a chain of N bare transactions over a proven funding, one
  // in-VM ingest of the last one's BEEF (it carries the whole ancestry).
  let got = "";
  const N = Number(process.env.BUNDLE_N ?? 200);
  const txs: Transaction[] = [];
  let prevTx = fund;
  for (let i = 0; i < N; i++) { const t = await spendOf(prevTx, 0, 9_000 - i); txs.push(t); prevTx = t; }
  const last = txs.at(-1)!.id("hex");
  const bundle = new Uint8Array(txs.at(-1)!.toBEEF());
  const t0 = Date.now();
  await send("ingester", { beef: bundle });
  got = await eventually("last pending", async () => ((await statuses(last)).startsWith("pending") ? "pending" : ""), "pending");
  await h.router.settled();
  const t1 = Date.now();
  check(got === "pending", `the last of ${N} pending`);
  let allPending = true;
  for (const t of txs) allPending = allPending && (await statuses(t.id("hex"))).startsWith("pending");
  check(allPending, `every one of the ${N} has its intake status`);
  process.stdout.write(`BUNDLE: ${N} transactions, ${bundle.length} bytes; intake (send → every handler settled): ${t1 - t0} ms\n`);
} catch (e) {
  check(false, `threw: ${(e as Error).stack}`);
} finally {
  const [removeHome, ...rest] = afters;
  for (const f of rest.reverse()) await f();
  await arcade.close();
  for (const s of [store, ...bootStores]) {
    if (!s) continue;
    const rp = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), s], { encoding: "utf8" });
    process.stdout.write(rp.stdout);
    if (rp.status !== 0) process.stdout.write(rp.stderr);
    check(rp.status === 0 && /identical .*the source store reproduced exactly/.test(rp.stdout), `${s === store ? "the installed" : "the booted"} instance's store replays to itself exactly`);
  }
  if (!process.env.KEEP) await removeHome?.();
}
process.stdout.write(failures ? `chain-bundle (${BACKEND}): ${failures} FAILED\n` : `chain-bundle (${BACKEND}): all ok\n`);
process.exit(failures ? 1 : 0);

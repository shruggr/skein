// The chain app's proof events (skein-chain 0.11.0, skein-sdk 0.21.0) end to end: shruggr/skein-chain at
// a pinned tag (or $SKEIN_CHAIN_DIR) installed by the owner's messages into an instance of the stock
// system on a router with a (fake) Arcade, and a test caller (programs/test/ingester: a message in box
// `ingester` → the chain app's `ingest` as an in-VM call in that step). A saved merkle path links every
// transaction it covers (chain/proof/<txid> once, held or not): one taken in after its link is mined at
// intake and never broadcast, its unproven child posted once in Extended Format; linked later, mined by
// its subscription; a rejection's cascade (input-rejected, its root) and its revival; blocks leaving and
// rejoining the best chain (chain/block/<hash>); one BUMP for two proven entries. The stores replay to
// themselves exactly.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/chain-proof-events.ts

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

  // THE LIVE SEQUENCE. Block 2 = {P, X}: P spends fund:0, X spends P; C spends X, unmined.
  const p = await spendOf(fund, 0, 9_500), x = await spendOf(p, 0, 9_000), cTx = await spendOf(x, 0, 8_500);
  const P = p.id("hex"), X = x.id("hex"), C = cTx.id("hex");
  const h2 = mine(sha256d(h1), sha256d(Buffer.concat([internal(P), internal(X)])), 1_790_200_600);
  await h.router.chainHeaders("ch", "chain", [h2]);
  await h.router.settled();
  // 1. P with its path (X's leaf unflagged), by message.
  p.merklePath = new MerklePath(2, [[{ offset: 0, hash: P, txid: true }, { offset: 1, hash: X }]]);
  await send("chain", { fn: "ingest", args: { beef: new Uint8Array(p.toBEEF()) } });
  let got = await eventually("P mined", () => statuses(P), "mined@2");
  check(got === "mined@2", `P with its path: mined@2 (${got})`);
  got = await eventually("chain/proof/X", () => proofsOf(X), "2/1");
  check(got === "2/1", `the path links X too (unheld, unflagged): chain/proof/<X> {height 2, position 1} once (${got})`);
  check((await facts(`chain/tx/${X}`)).length === 0, "X not held yet: no chain/tx fact");
  // 2. X bare with its unproven child C, by an in-VM ingest (P's raw bytes carried, no BUMP for it).
  const pBare = new Transaction(); // P again without its proof
  p.merklePath = undefined;
  void pBare;
  await send("ingester", { beef: new Uint8Array(cTx.toBEEF()) });
  got = await eventually("C pending,seen", () => statuses(C), "pending,seen");
  check(got.startsWith("pending"), `C: pending at intake (${got})`);
  got = await statuses(X);
  check(got === "mined@2", `X's first and only fact: mined@2 (${got})`);
  check(postsOf(X) === 0, `X never broadcast (${postsOf(X)} posts)`);
  check(postsOf(C) === 1, `C broadcast once (${postsOf(C)})`);
  const cPost = arcade.posts.find((b) => FakeArcade.txOf(b).id("hex") === C);
  check(!!cPost, "C's posted body found");
  // The host turned C's outgoing BEEF into Extended Format: C's input source (X) was linked, i.e. X
  // went in the bundle proven-with-its-source data, not as a bare tx a BUMP covers (that is what made
  // @bsv/sdk drop the inputs and the host fall back to raw before).
  const ef = cPost ? Buffer.from(cPost).subarray(4, 10).toString("hex") : "";
  check(ef === "0000000000ef", `C posted in Extended Format (marker ${ef}): its proven parent X linked in our outgoing bundle`);
  got = await eventually("P.0 spent by X", () => outputs(`${P}.0`), `spent:${X.slice(0, 8)}`);
  check(got === `spent:${X.slice(0, 8)}`, `X's chain/tx subscription (outputs) fired: chain/output/<P>.0 spent by X (${got})`);
  got = await eventually("X.0 spent by C", () => outputs(`${X}.0`), `spent:${C.slice(0, 8)}`);
  check(got === `spent:${C.slice(0, 8)}`, `chain/output/<X>.0 spent by C (${got})`);

  // PROOF AFTER THE TRANSACTION. Block 3 = {R, Y}: R spends fund:1, Y spends R; both come bare first.
  const r = await spendOf(fund, 1, 9_500), y = await spendOf(r, 0, 9_000);
  const R = r.id("hex"), Y = y.id("hex");
  await send("ingester", { beef: new Uint8Array(y.toBEEF()) });
  got = await eventually("Y pending,seen", () => statuses(Y), "pending,seen");
  check(got === "pending,seen", `Y bare: pending, then seen (${got})`);
  const h3 = mine(sha256d(h2), sha256d(Buffer.concat([internal(R), internal(Y)])), 1_790_201_200);
  await h.router.chainHeaders("ch", "chain", [h3]);
  await h.router.settled();
  // The broadcaster's proof of R only; its path covers Y.
  arcade.emit(R, { txStatus: "MINED", blockHash: display(sha256d(h3)), blockHeight: 3, merklePath: new MerklePath(3, [[{ offset: 0, hash: R, txid: true }, { offset: 1, hash: Y }]]).toHex() });
  got = await eventually("Y mined by subscription", () => statuses(Y), "pending,seen,mined@3");
  check(got === "pending,seen,mined@3", `R's proof covers Y: chain/proof/<Y>, Y's subscription raises mined@3 once (${got})`);
  got = await proofsOf(Y);
  check(got === "3/1", `chain/proof/<Y> {3, 1} (${got})`);
  got = await outputs(`${R}.0`);
  check(got === `spent:${Y.slice(0, 8)}`, `chain/output/<R>.0 spent by Y (${got})`);

  // PARENTS BY SUBSCRIPTION. G spends fund:2, H spends G, I spends H; all bare.
  const g = await spendOf(fund, 2, 9_500), hh = await spendOf(g, 0, 9_000), ii = await spendOf(hh, 0, 8_500);
  const G = g.id("hex"), H = hh.id("hex"), I = ii.id("hex");
  await send("ingester", { beef: new Uint8Array(ii.toBEEF()) });
  got = await eventually("I pending,seen", () => statuses(I), "pending,seen");
  check(got === "pending,seen", `G, H, I bare: I pending, then seen (${got})`);
  arcade.emit(G, { txStatus: "REJECTED", extraInfo: "test" });
  got = await eventually("G rejected", () => statuses(G), "pending,seen,rejected:REJECTED");
  check(got === "pending,seen,rejected:REJECTED", `G rejected by the network (${got})`);
  got = await eventually("H input-rejected", () => statuses(H), "pending,seen,rejected:input-rejected");
  check(got === "pending,seen,rejected:input-rejected", `H rejected input-rejected by G's fact, through its parents subscription (${got})`);
  got = await eventually("I input-rejected", () => statuses(I), "pending,seen,rejected:input-rejected");
  check(got === "pending,seen,rejected:input-rejected", `I rejected input-rejected by H's fact (${got})`);
  const iRej = (await facts(`chain/tx/${I}`)).at(-1)!;
  check(iRej.by === G, `I's input-rejected names the root G (${String(iRej.by).slice(0, 8)})`);
  // G mined after all (a proof overrides a rejection): H and I revived, broadcast again.
  const hPosts = postsOf(H), iPosts = postsOf(I);
  const h4 = mine(sha256d(h3), internal(G), 1_790_201_800);
  await h.router.chainHeaders("ch", "chain", [h4]);
  await h.router.settled();
  arcade.emit(G, { txStatus: "MINED", blockHash: display(sha256d(h4)), blockHeight: 4, merklePath: new MerklePath(4, [[{ offset: 0, hash: G, txid: true }]]).toHex() });
  got = await eventually("G mined", () => statuses(G), "pending,seen,rejected:REJECTED,mined@4");
  check(got === "pending,seen,rejected:REJECTED,mined@4", `G mined, over its rejection (${got})`);
  got = await eventually("H revived", () => statuses(H), "pending,seen,rejected:input-rejected,pending,seen");
  check(got.startsWith("pending,seen,rejected:input-rejected,pending"), `H revived by G's fact: pending again (${got})`);
  got = await eventually("I revived", () => statuses(I), "pending,seen,rejected:input-rejected,pending,seen");
  check(got.startsWith("pending,seen,rejected:input-rejected,pending"), `I revived by H's fact (${got})`);
  check(postsOf(H) === hPosts + 1 && postsOf(I) === iPosts + 1, `H and I broadcast again (${postsOf(H) - hPosts}, ${postsOf(I) - iPosts})`);

  // REORG OUT AND BACK BY SUBSCRIPTION. Blocks 3 (R, Y) and 4 (G) leave; then come back.
  const fork2: Uint8Array[] = [];
  for (let i = 0; i < 3; i++) fork2.push(mine(sha256d(fork2.at(-1) ?? h2), Buffer.alloc(32, 0x71 + i), 1_790_400_000 + i * 600));
  await h.router.chainHeaders("ch", "chain", fork2);
  await h.router.settled();
  got = await eventually("R reorged", () => statuses(R), "pending,seen,mined@3,seen:reorged");
  check(got === "pending,seen,mined@3,seen:reorged", `R seen/reorged by its block's fact (${got})`);
  got = await eventually("Y reorged", () => statuses(Y), "pending,seen,mined@3,seen:reorged");
  check(got === "pending,seen,mined@3,seen:reorged", `Y seen/reorged (${got})`);
  got = await eventually("G reorged", () => statuses(G), "pending,seen,rejected:REJECTED,mined@4,seen:reorged");
  check(got.endsWith("mined@4,seen:reorged"), `G seen/reorged — not rejected again (${got})`);
  const back: Uint8Array[] = [h3, h4];
  for (let i = 0; i < 2; i++) back.push(mine(sha256d(back.at(-1)!), Buffer.alloc(32, 0x81 + i), 1_790_500_000 + i * 600));
  await h.router.chainHeaders("ch", "chain", back);
  await h.router.settled();
  got = await eventually("R back", () => statuses(R), "pending,seen,mined@3,seen:reorged,mined@3");
  check(got === "pending,seen,mined@3,seen:reorged,mined@3", `R mined again when its block came back (${got})`);
  got = await eventually("G back", () => statuses(G), "pending,seen,rejected:REJECTED,mined@4,seen:reorged,mined@4");
  check(got.endsWith("seen:reorged,mined@4"), `G mined again (${got})`);

  // A SECOND FUNDING (block 7) for the rest.
  const fund2 = new Transaction();
  fund2.addInput({ sourceTXID: "73".repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex("51"), sequence: 0xffffffff });
  for (let i = 0; i < 4; i++) fund2.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 10_000 });
  const F2 = fund2.id("hex");
  const h7 = mine(sha256d(back.at(-1)!), internal(F2), 1_790_600_000);
  await h.router.chainHeaders("ch", "chain", [h7]);
  await h.router.settled();
  fund2.merklePath = new MerklePath(7, [[{ offset: 0, hash: F2, txid: true }]]);
  await send("chain", { fn: "ingest", args: { beef: new Uint8Array(fund2.toBEEF()) } });
  got = await eventually("fund2 mined", () => statuses(F2), "mined@7");
  check(got === "mined@7", `a second funding at 7 (${got})`);

  // DOUBLE SPEND: A2 bare spends fund2:0; B2 (proven at 8) spends it too — A2 rejected double-spent by B2.
  const a2 = await spendOf(fund2, 0, 9_000), b2 = await spendOf(fund2, 0, 8_000);
  const A2 = a2.id("hex"), B2 = b2.id("hex");
  await send("ingester", { beef: new Uint8Array(a2.toBEEF()) });
  got = await eventually("A2 pending,seen", () => statuses(A2), "pending,seen");
  const h8 = mine(sha256d(h7), internal(B2), 1_790_600_600);
  await h.router.chainHeaders("ch", "chain", [h8]);
  await h.router.settled();
  b2.merklePath = new MerklePath(8, [[{ offset: 0, hash: B2, txid: true }]]);
  await send("chain", { fn: "ingest", args: { beef: new Uint8Array(b2.toBEEF()) } });
  got = await eventually("A2 double-spent", () => statuses(A2), "pending,seen,rejected:double-spent");
  check(got === "pending,seen,rejected:double-spent", `A2 rejected double-spent, in B2's proof step (${got})`);
  check((await facts(`chain/tx/${A2}`)).at(-1)?.by === B2, "A2's rejection names B2");
  got = await eventually("fund2.0 spent by B2", () => outputs(`${F2}.0`), `spent:${A2.slice(0, 8)},spent:${B2.slice(0, 8)}`);
  check(got === `spent:${A2.slice(0, 8)},spent:${B2.slice(0, 8)}`, `chain/output/<fund2>.0: spent by A2, then by B2 (${got})`);

  // A PARENT REJECTED ALREADY: K rejected; L (spending K) arrives — rejected input-rejected at intake, never broadcast.
  const kTx = await spendOf(fund2, 1, 9_000), lTx = await spendOf(kTx, 0, 8_500);
  const K = kTx.id("hex"), L = lTx.id("hex");
  await send("ingester", { beef: new Uint8Array(kTx.toBEEF()) });
  got = await eventually("K pending,seen", () => statuses(K), "pending,seen");
  arcade.emit(K, { txStatus: "REJECTED", extraInfo: "test" });
  got = await eventually("K rejected", () => statuses(K), "pending,seen,rejected:REJECTED");
  check(got === "pending,seen,rejected:REJECTED", `K rejected (${got})`);
  await send("ingester", { beef: new Uint8Array(lTx.toBEEF()) });
  got = await eventually("L input-rejected", () => statuses(L), "rejected:input-rejected");
  check(got === "rejected:input-rejected", `L, arriving after K's rejection: rejected input-rejected at intake (${got})`);
  check(postsOf(L) === 0, `L never broadcast (${postsOf(L)})`);

  // A PARKED PATH: M's proof (block 10) arrives before its header — applied when the header comes.
  const m2 = await spendOf(fund2, 2, 9_000), n2 = await spendOf(fund2, 3, 9_000);
  const M = m2.id("hex"), N = n2.id("hex");
  await send("ingester", { beef: new Uint8Array(m2.toBEEF()) });
  await send("ingester", { beef: new Uint8Array(n2.toBEEF()) });
  got = await eventually("M pending,seen", () => statuses(M), "pending,seen");
  got = await eventually("N pending,seen", () => statuses(N), "pending,seen");
  const h9 = mine(sha256d(h8), Buffer.alloc(32, 0x91), 1_790_601_200);
  const h10 = mine(sha256d(h9), internal(M), 1_790_601_800);
  arcade.emit(M, { txStatus: "MINED", blockHash: display(sha256d(h10)), blockHeight: 10, merklePath: new MerklePath(10, [[{ offset: 0, hash: M, txid: true }]]).toHex() });
  // N's "proof" for block 12, whose real root will be another: a bogus parked path.
  arcade.emit(N, { txStatus: "MINED", blockHash: "ab".repeat(32), blockHeight: 12, merklePath: new MerklePath(12, [[{ offset: 0, hash: N, txid: true }]]).toHex() });
  await sleep(500);
  await h.router.settled();
  check(!(await statuses(M)).includes("mined"), `M not mined before its header (${await statuses(M)})`);
  await h.router.chainHeaders("ch", "chain", [h9, h10]);
  await h.router.settled();
  got = await eventually("M mined", () => statuses(M), "pending,seen,mined@10");
  check(got === "pending,seen,mined@10", `M's parked path applied when its header came (${got})`);
  const h11 = mine(sha256d(h10), Buffer.alloc(32, 0x92), 1_790_602_400);
  const h12 = mine(sha256d(h11), Buffer.alloc(32, 0x93), 1_790_603_000);
  await h.router.chainHeaders("ch", "chain", [h11, h12]);
  await h.router.settled();
  const h13 = mine(sha256d(h12), Buffer.alloc(32, 0x94), 1_790_603_600);
  await h.router.chainHeaders("ch", "chain", [h13]);
  await h.router.settled();
  got = await statuses(N);
  check(got === "pending,seen", `N's bogus parked path dropped when block 12 came; N untouched (${got})`);
  const st13 = await record("chain/state") as { maps?: Record<string, unknown> } | undefined;
  check(st13?.maps?.parked === null, `nothing left parked; later headers fine (${JSON.stringify(st13?.maps?.parked)})`);

  // THE STALE-ROW SEQUENCE: P3, X3 in block 15; reorg out; block 17' = {P3, C3}; a second reorg from 14.
  const fund3 = new Transaction();
  fund3.addInput({ sourceTXID: "74".repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex("51"), sequence: 0xffffffff });
  fund3.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 10_000 });
  const F3 = fund3.id("hex");
  const h14 = mine(sha256d(h13), internal(F3), 1_790_604_200);
  await h.router.chainHeaders("ch", "chain", [h14]);
  await h.router.settled();
  fund3.merklePath = new MerklePath(14, [[{ offset: 0, hash: F3, txid: true }]]);
  await send("chain", { fn: "ingest", args: { beef: new Uint8Array(fund3.toBEEF()) } });
  const p3 = await spendOf(fund3, 0, 9_500), x3 = await spendOf(p3, 0, 9_000), c3 = await spendOf(x3, 0, 8_500);
  const P3 = p3.id("hex"), X3 = x3.id("hex"), C3 = c3.id("hex");
  await send("ingester", { beef: new Uint8Array(x3.toBEEF()) });
  got = await eventually("X3 pending,seen", () => statuses(X3), "pending,seen");
  const h15 = mine(sha256d(h14), sha256d(Buffer.concat([internal(P3), internal(X3)])), 1_790_604_800);
  await h.router.chainHeaders("ch", "chain", [h15]);
  await h.router.settled();
  arcade.emit(P3, { txStatus: "MINED", blockHash: display(sha256d(h15)), blockHeight: 15, merklePath: new MerklePath(15, [[{ offset: 0, hash: P3, txid: true }, { offset: 1, hash: X3 }]]).toHex() });
  got = await eventually("X3 mined", () => statuses(X3), "pending,seen,mined@15");
  check(got === "pending,seen,mined@15", `X3 mined by P3's path (${got})`);
  const alt: Uint8Array[] = [];
  for (let i = 0; i < 2; i++) alt.push(mine(sha256d(alt.at(-1) ?? h14), Buffer.alloc(32, 0xa1 + i), 1_790_605_000 + i * 600));
  await h.router.chainHeaders("ch", "chain", alt);
  await h.router.settled();
  got = await eventually("P3 reorged", () => statuses(P3), "pending,seen,mined@15,seen:reorged");
  check(got === "pending,seen,mined@15,seen:reorged", `first reorg: P3 seen/reorged (${got})`);
  await send("ingester", { beef: new Uint8Array(c3.toBEEF()) });
  got = await eventually("C3 pending,seen", () => statuses(C3), "pending,seen");
  const alt17 = mine(sha256d(alt.at(-1)!), sha256d(Buffer.concat([internal(P3), internal(C3)])), 1_790_606_200);
  await h.router.chainHeaders("ch", "chain", [alt17]);
  await h.router.settled();
  arcade.emit(P3, { txStatus: "MINED", blockHash: display(sha256d(alt17)), blockHeight: 17, merklePath: new MerklePath(17, [[{ offset: 0, hash: P3, txid: true }, { offset: 1, hash: C3 }]]).toHex() });
  got = await eventually("C3 mined", () => statuses(C3), "pending,seen,mined@17");
  check(got === "pending,seen,mined@17", `block 17' = {P3, C3}: C3 mined (${got})`);
  got = await eventually("P3 mined@17", () => statuses(P3), "pending,seen,mined@15,seen:reorged,mined@17");
  check(got === "pending,seen,mined@15,seen:reorged,mined@17", `P3 re-linked at 17 (${got})`);
  const x3Facts = (await facts(`chain/tx/${X3}`)).length;
  const f2: Uint8Array[] = [];
  for (let i = 0; i < 4; i++) f2.push(mine(sha256d(f2.at(-1) ?? h14), Buffer.alloc(32, 0xb1 + i), 1_790_607_000 + i * 600));
  await h.router.chainHeaders("ch", "chain", f2);
  await h.router.settled();
  got = await eventually("C3 reorged", () => statuses(C3), "pending,seen,mined@17,seen:reorged");
  check(got === "pending,seen,mined@17,seen:reorged", `second reorg from 14: C3 (proven only through 17') seen/reorged (${got})`);
  got = await eventually("P3 reorged again", () => statuses(P3), "pending,seen,mined@15,seen:reorged,mined@17,seen:reorged");
  check(got.endsWith("mined@17,seen:reorged"), `P3 seen/reorged again (${got})`);
  check((await facts(`chain/tx/${X3}`)).length === x3Facts, `X3, off our chain already, gets no new fact (block 15 not raised again)`);

  // CHILDREN: W rejected by the network; its child V (input-rejected) proven later — W's rejection
  // lifted (unproven, broadcast once more); the broadcaster's REJECTED for it then is refused; no loop.
  const fund4 = new Transaction();
  fund4.addInput({ sourceTXID: "75".repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex("51"), sequence: 0xffffffff });
  for (let i = 0; i < 3; i++) fund4.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 10_000 });
  const F4 = fund4.id("hex");
  const h19 = mine(sha256d(f2.at(-1)!), internal(F4), 1_790_610_000);
  await h.router.chainHeaders("ch", "chain", [h19]);
  await h.router.settled();
  fund4.merklePath = new MerklePath(19, [[{ offset: 0, hash: F4, txid: true }]]);
  await send("chain", { fn: "ingest", args: { beef: new Uint8Array(fund4.toBEEF()) } });
  const w4 = await spendOf(fund4, 0, 9_500), v4 = await spendOf(w4, 0, 9_000);
  const W = w4.id("hex"), V = v4.id("hex");
  await send("ingester", { beef: new Uint8Array(v4.toBEEF()) });
  got = await eventually("V pending,seen", () => statuses(V), "pending,seen");
  arcade.emit(W, { txStatus: "REJECTED", extraInfo: "test" });
  got = await eventually("V input-rejected", () => statuses(V), "pending,seen,rejected:input-rejected");
  check(got === "pending,seen,rejected:input-rejected", `V input-rejected by W (${got})`);
  const wPosts = postsOf(W);
  const h20 = mine(sha256d(h19), internal(V), 1_790_610_600);
  await h.router.chainHeaders("ch", "chain", [h20]);
  await h.router.settled();
  arcade.mode = "reject"; // the broadcaster refuses W again when it is re-broadcast
  arcade.emit(V, { txStatus: "MINED", blockHash: display(sha256d(h20)), blockHeight: 20, merklePath: new MerklePath(20, [[{ offset: 0, hash: V, txid: true }]]).toHex() });
  got = await eventually("V mined", () => statuses(V), "pending,seen,rejected:input-rejected,mined@20");
  check(got === "pending,seen,rejected:input-rejected,mined@20", `V mined over its input-rejected (${got})`);
  got = await eventually("W lifted", () => statuses(W), "pending,seen,rejected:REJECTED,pending");
  check(got === "pending,seen,rejected:REJECTED,pending", `W's rejection lifted by its proven child: unproven again (${got})`);
  await sleep(1500);
  await h.router.settled();
  arcade.mode = "ok";
  got = await statuses(W);
  check(got === "pending,seen,rejected:REJECTED,pending", `the broadcaster's REJECTED for W refused (a proven child): no new fact, no loop (${got})`);
  check(postsOf(W) === wPosts + 1, `W re-broadcast once (${postsOf(W) - wPosts})`);

  // A SHARED BUMP AT INTAKE: S1 and S2 mined in one block (21), one BEEF, one BUMP for both.
  const s1t = await spendOf(fund4, 1, 9_000), s2t = await spendOf(fund4, 2, 9_000);
  const S1 = s1t.id("hex"), S2 = s2t.id("hex");
  const h21 = mine(sha256d(h20), sha256d(Buffer.concat([internal(S1), internal(S2)])), 1_790_611_200);
  await h.router.chainHeaders("ch", "chain", [h21]);
  await h.router.settled();
  const shared = new MerklePath(21, [[{ offset: 0, hash: S1, txid: true }, { offset: 1, hash: S2, txid: true }]]);
  s1t.merklePath = shared; s2t.merklePath = shared;
  const { Beef } = await import("@bsv/sdk");
  const bb = new Beef();
  bb.mergeTransaction(s1t); bb.mergeTransaction(s2t);
  check(bb.bumps.length === 1 && bb.txs.length === 2, `the bundle: two proven entries, ONE BUMP (${bb.bumps.length} bumps, ${bb.txs.length} txs)`);
  await send("chain", { fn: "ingest", args: { beef: new Uint8Array(bb.toBinary()) } });
  got = await eventually("S1 mined", () => statuses(S1), "mined@21");
  check(got === "mined@21" && (await statuses(S2)) === "mined@21", `both mined at intake from the one BUMP (${got}, ${await statuses(S2)})`);
  check((await proofsOf(S1)) === "21/0" && (await proofsOf(S2)) === "21/1", `one chain/proof each (${await proofsOf(S1)} ${await proofsOf(S2)})`);
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
process.stdout.write(failures ? `chain-proof-events (${BACKEND}): ${failures} FAILED\n` : `chain-proof-events (${BACKEND}): all ok\n`);
process.exit(failures ? 1 : 0);

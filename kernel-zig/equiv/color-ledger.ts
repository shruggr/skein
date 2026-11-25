// skein-1color 0.19.0 on a real kernel (skein 0.8.0: a step reads its own events) with skein-overlay
// 0.27.0 and skein-chain 0.11.0: a token's deploy D, its transfer C1 (D:0 → B) and a burning
// transfer C2 (C1:0 → A, 400 of 1000 burned), all mined in one block and posted in ONE BEEF, are
// admitted in ONE overlay step (submit.zig `admitHeard`: every item the chain state takes now,
// oldest first). The lookup's hooks for C1 and C2 read the facts the overlay raised for D and C1
// earlier in that same step: D's and C1's outputs are debited, C2's burn counted —
//   holders: A 600 only; supply 600; burned 400; burns 1;
//   facts: 1color/topic/output/<D>.0 spent by C1, <C1>.0 spent by C2, <C2>.0 admitted;
//          1color/color/burn/<C2>/<tokenId> {tokenId, amount: 400, at}.
// The store then replays to itself exactly. One backend (SKEIN_EQUIV_STORE; default sqlite).
//
// It runs from a skein checkout: copy it into <skein>/kernel-zig/equiv/ and
//   SKEIN_1COLOR_DIR=<this repo> SKEIN_CHAIN_DIR=<skein-chain> node --experimental-strip-types --no-warnings kernel-zig/equiv/color-ledger.ts

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Beef, MerklePath, P2PKH, PrivateKey, Script, Transaction, UnlockingScript } from "@bsv/sdk";
import { CID } from "multiformats/cid";
import { ownerCli } from "../../src/testapps.ts";
import { RawBox } from "../../src/client/raw.ts";
import { storeSpec } from "../../src/runtime/index-store.ts";
import { openStoreFile } from "../../src/host/stores.ts";
import { BACKEND, routerStore, storeFor } from "./backend.ts";
import { FakeArcade } from "../../src/host/fake-arcade.ts";
import { HostDb } from "../../src/host/instances.ts";
import { Router } from "../../src/host/router.ts";
import { ephemeralWallet } from "../../src/wallet.ts";

const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
const home = mkdtempSync(join(tmpdir(), "skein-kz-ledger-"));
let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, f: () => Promise<T | undefined> | T | undefined, ms = 30_000): Promise<T> {
  for (const end = Date.now() + ms; ;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
}
const dirOf = (env: string) => { const d = process.env[env]; if (!d) throw new Error(`${env}: the checkout to test`); return d; };
const copyOf = (src: string, dst: string) => { cpSync(src, dst, { recursive: true, filter: (p) => !/\/(\.git|zig-out|\.zig-cache|zig-pkg|equiv|node_modules|web|www)$/.test(p) }); return dst; };

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

/** Every overlay step's result record in a store, each once. */
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

// ---------------------------------------------------------------- 1Color scripts (BRC-162 binary)

/** A minimal script-number push of `n` (BRC-162 `pushAmount`). */
function pushAmount(n: number): number[] {
  if (n === 0) return [0x00];
  if (n <= 16) return [0x50 + n];
  const b: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) b.push(v % 256);
  if (b.at(-1)! & 0x80) b.push(0);
  return [b.length, ...b];
}
const p2pkh = (k: PrivateKey) => new P2PKH().lock(k.toPublicKey().toHash()).toBinary();
/** A deploy: `OP_0 <amount> OP_2DROP <P2PKH>`. */
const deployScript = (amount: number, k: PrivateKey) => Script.fromBinary([0x00, ...pushAmount(amount), 0x6d, ...p2pkh(k)]);
/** A value output of the token `idDisplay` (deployed at output 0): `<id 32, internal> <amount> OP_2DROP <P2PKH>`. */
const valueScript = (idDisplay: string, amount: number, k: PrivateKey) => Script.fromBinary([0x20, ...internal(idDisplay), ...pushAmount(amount), 0x6d, ...p2pkh(k)]);

function spend(source: Transaction, vout: number, owner: PrivateKey, lock: Script): Transaction {
  const t = new Transaction();
  t.addInput({ sourceTransaction: source, sourceOutputIndex: vout, unlockingScriptTemplate: new P2PKH().unlock(owner), sequence: 0xffffffff });
  t.addOutput({ lockingScript: lock, satoshis: 1 });
  return t;
}

// ---------------------------------------------------------------- one router, one instance

const key = (h: string) => new PrivateKey(h, 16);
const ownerKey = key("2222");
const owner = ownerKey.toPublicKey().toString();
const ownerWallet = ephemeralWallet(ownerKey);
const arcade = await FakeArcade.start();
const H = "ledger";
const hostHome = join(home, H);
mkdirSync(hostHome, { recursive: true });
const db = new HostDb(join(hostHome, "host.db"));
db.add(H, { store: storeFor(hostHome, H) });
const r = new Router({
  db, walletFor: () => ephemeralWallet(key("1111")), home: hostHome, owner, idleMs: 0, answerWaitMs: 4000,
  kernel: { command: kernel, env: { SKEIN_HOME: hostHome } }, ...routerStore(hostHome),
  genesis: { defaults: { walletNetwork: "regtest" } },
  arc: { url: arcade.url, token: "the-ledger-arcade-token", events: arcade.eventsUrl }, arcRetry: { min: 300, max: 800 },
  log: (s: string, l: string) => { if (process.env.VERBOSE) process.stdout.write(`  | [${s}] ${l}\n`); },
});
const store = () => storeSpec(db.get(H)!);
const origin = () => r.originOf(H);
type Row = { id: string; event: string; record: Record<string, unknown> };
const events = async (name: string): Promise<Row[]> => {
  const res = await fetch(`${origin()}/events/${name}`);
  if (res.status !== 200) throw new Error(`GET /events/${name}: ${res.status} ${await res.text()}`);
  return await res.json() as Row[];
};

const A = key("3333"), B = key("4444");
// The chain: the funding transaction mined at 1.
const fund = new Transaction();
fund.addInput({ sourceTXID: "72".repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex("51"), sequence: 0xffffffff });
fund.addOutput({ lockingScript: new P2PKH().lock(A.toPublicKey().toHash()), satoshis: 10_000 });
const fundTxid = fund.id("hex");
fund.merklePath = new MerklePath(1, [[{ offset: 0, hash: "cb".repeat(32) }, { offset: 1, hash: fundTxid, txid: true }]]);
const h1 = mine(sha256d(REGTEST_GENESIS), sha256d(Buffer.concat([internal("cb".repeat(32)), internal(fundTxid)])), 1_790_200_000);

try {
  const colorDir = copyOf(dirOf("SKEIN_1COLOR_DIR"), join(home, "1color"));
  const chainDir = copyOf(dirOf("SKEIN_CHAIN_DIR"), join(home, "chain"));
  const mf = JSON.parse(readFileSync(join(colorDir, "etc/app.json"), "utf8")) as { version: string };
  const cmf = JSON.parse(readFileSync(join(chainDir, "etc/app.json"), "utf8")) as { version: string };
  check(mf.version === "0.19.0" && cmf.version === "0.11.0", `skein-1color ${mf.version}, skein-chain ${cmf.version}`);

  await r.listen(0);
  await r.hydrate(H);
  const hostOf = { home: hostHome, port: r.port!, owner: ownerWallet, settled: () => r.settled() };
  for (const dir of [chainDir, colorDir]) {
    const o = await ownerCli(hostOf, ["install", dir, "--instance", H]);
    if (o.code !== 0) throw new Error(`install ${dir}: ${o.err.join(" ")}`);
    await r.settled();
  }
  await r.chainHeaders(H, "chain", [h1]);
  await r.settled();

  // The token: D deploys 1000 to A; C1 moves all 1000 to B; C2 moves 600 of it back to A (400 burned).
  const D = spend(fund, 0, A, deployScript(1000, A));
  await D.sign();
  const id = D.id("hex");
  const tokenId = `${id}_0`;
  const topic = `tm_color_${tokenId}`;
  const C1 = spend(D, 0, A, valueScript(id, 1000, B));
  await C1.sign();
  const C2 = spend(C1, 0, B, valueScript(id, 600, A));
  await C2.sign();
  const [d, c1, c2] = [D.id("hex"), C1.id("hex"), C2.id("hex")];
  // One block at 2: D, C1, C2 and a filler leaf.
  const filler = "ab".repeat(32);
  const left = sha256d(Buffer.concat([internal(d), internal(c1)]));
  const right = sha256d(Buffer.concat([internal(c2), internal(filler)]));
  const root = sha256d(Buffer.concat([left, right]));
  const disp = (b: Uint8Array) => Buffer.from(b).reverse().toString("hex");
  const h2 = mine(sha256d(h1), root, 1_790_200_600);
  await r.chainHeaders(H, "chain", [h2]);
  await r.settled();
  const path = new MerklePath(2, [[{ offset: 0, hash: d, txid: true }, { offset: 1, hash: c1, txid: true }, { offset: 2, hash: c2, txid: true }, { offset: 3, hash: filler }], [{ offset: 0, hash: disp(left) }, { offset: 1, hash: disp(right) }]]);
  for (const t of [D, C1, C2]) t.merklePath = path;

  // Register the token's topic and its lookup (root's two messages, box 1color/register).
  const identity = (await r.hydrate(H)).identity;
  const box = new RawBox(ownerWallet, `http://127.0.0.1:${r.port}/@${H}`);
  await box.send(identity, "1color/register", { fn: "register", args: { topic, program: "color-topic" } });
  await r.settled();
  await box.send(identity, "1color/register", { fn: "registerLookup", args: { service: `ls_color_${tokenId}`, program: "color-lookup", topics: [topic] } });
  await r.settled();

  // ONE BEEF, D then C1 then C2 (each proven).
  const beef = new Beef();
  beef.mergeTransaction(fund);
  beef.mergeTransaction(D);
  beef.mergeTransaction(C1);
  beef.mergeTransaction(C2);
  const sp = await fetch(`${origin()}/1color/submit`, { method: "POST", headers: { "x-topics": topic }, body: Uint8Array.from(beef.toBinary()) });
  const spt = await sp.text();
  check(sp.status === 200, `the BEEF posted (${sp.status} ${spt.slice(0, 160)})`);
  await until("C2 admitted", async () => (await events(`1color/topic/tx/${c2}`)).some((x) => x.record.verdict === "admitted") || undefined);
  await r.settled();

  const steps = (await overlayResults(store())).filter((x) => x.admitted === true);
  check(steps.length === 1 && steps[0]!.txid === c2, `D, C1, C2 admitted in ONE overlay step (${steps.length} admitting step(s), last ${String(steps[0]?.txid).slice(0, 8)}…)`);
  const outD = await events(`1color/topic/output/${d}.0`);
  const outC1 = await events(`1color/topic/output/${c1}.0`);
  const outC2 = await events(`1color/topic/output/${c2}.0`);
  check(outD.map((x) => x.record.state).join() === "admitted,spent" && outD[1]!.record.spentBy === c1, `1color/topic/output/<D>.0: admitted, spent by C1 (${outD.map((x) => x.record.state).join()})`);
  check(outC1.map((x) => x.record.state).join() === "admitted,spent" && outC1[1]!.record.spentBy === c2, `1color/topic/output/<C1>.0: admitted, spent by C2 (${outC1.map((x) => x.record.state).join()})`);
  check(outC2.map((x) => x.record.state).join() === "admitted", `1color/topic/output/<C2>.0: admitted (${outC2.map((x) => x.record.state).join()})`);
  const stepOf = (row: Row) => row.id.split(".")[0];
  check(new Set([...outD, ...outC1, ...outC2].map(stepOf)).size === 1, `every output fact placed in the same step (ids ${[...outD, ...outC1, ...outC2].map((x) => x.id.split(".").slice(0, 2).join(".")).join(" ")})`);
  const burn = await events(`1color/color/burn/${c2}/${tokenId}`);
  check(burn.length === 1 && burn[0]!.record.amount === 400 && burn[0]!.record.tokenId === tokenId && burn[0]!.record.app === "1color", `the burn: 1color/color/burn/<C2>/<tokenId> {amount 400} once (${JSON.stringify(burn.map((x) => x.record))})`);
  check(burn.length === 1 && stepOf(burn[0]!) === stepOf(outD[0]!), "the burn raised in that same step");

  const hr = await fetch(`${origin()}/1color/${tokenId}/holders`);
  const hj = await hr.json() as { count: number; rows: Array<{ address: string; balance: number }>; supply: number; burned: number; burns: number; authorities: number };
  const aAddr = A.toPublicKey().toAddress("testnet").toString();
  check(hr.status === 200 && hj.count === 1 && hj.rows.length === 1 && hj.rows[0]!.balance === 600, `holders: one, 600 (${JSON.stringify(hj.rows)}; A ${aAddr})`);
  check(hj.supply === 600 && hj.burned === 400 && hj.burns === 1 && hj.authorities === 0, `supply 600, burned 400, burns 1 (${hj.supply}, ${hj.burned}, ${hj.burns})`);

  // BRC-207 over the token's lookup: admission all three outputs; spendability only C2's.
  const q207 = (type: string) => ({ service: `ls_color_${tokenId}`, query: { type, version: 1, assetId: tokenId, topic, outpoints: [`${d}.0`, `${c1}.0`, `${c2}.0`] } });
  const lk = async (type: string) => ((await (await fetch(`${origin()}/1color/lookup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(q207(type)) })).json()) as { outputs?: Array<{ outputIndex: number }> }).outputs?.length;
  check((await lk("color-admission")) === 3 && (await lk("color-spendability")) === 1, `BRC-207: admission 3, spendability 1 (${await lk("color-admission")}, ${await lk("color-spendability")})`);
} catch (e) {
  check(false, `threw: ${(e as Error).stack}`);
} finally {
  const spec = store();
  await r.stop();
  await arcade.close();
  db.close();
  const rp = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), spec], { encoding: "utf8" });
  process.stdout.write(rp.stdout);
  if (rp.status !== 0) process.stdout.write(rp.stderr);
  check(rp.status === 0 && /identical .*the source store reproduced exactly/.test(rp.stdout), "the store replays to itself exactly");
}
if (process.env.KEEP) process.stdout.write(`kept ${home}\n`); else rmSync(home, { recursive: true, force: true });
process.stdout.write(failures ? `color-ledger (${BACKEND}): ${failures} FAILED\n` : `color-ledger (${BACKEND}): all ok\n`);
process.exit(failures ? 1 : 0);

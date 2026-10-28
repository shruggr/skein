// The host chain (#156 piece two, #133): the header chain held once per host,
// kept by the kernel process, every instance's chain state pointing at it.
//
//   1. Two instances on one RocksDB host (one `skein-kernel host`), the chain
//      app installed in both (src/testapps.ts CHAIN_APP, or $SKEIN_CHAIN_DIR):
//      the host sends three header runs (`headers` frames, Router.chainHeaders,
//      the feed's path); both instances' chain/state `headers` roots are the
//      host chain record's, and the tip read off them is the host's; a proof
//      ingested on A (its block at 5) is proven; a heavier branch replacing 5
//      and 6 reverts it (unproven, its broadcast registered again: the fake
//      Arcade gets it again) and leaves B pointing at the new record; the gate:
//      a host chain block readable through every set, A's own record not
//      through B's.
//   2. serve (SQLite): the same runs on one serve instance (its host chain in
//      its own store) yield the same chain/state CID as a third instance on the
//      RocksDB host that took the same runs.
//   3. The stores replay to themselves exactly after the processes stopped.
//   4. Timings: per block, a `headers` frame and the event to 8 instances on
//      the RocksDB host; a `chain-import` of an image of HOSTCHAIN_IMPORT
//      headers (default 20 160; the rack-shaped 970 000 by hand) on RocksDB
//      and on SQLite.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/hostchain.ts

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MerklePath, P2PKH, PrivateKey, Transaction, UnlockingScript } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import { RawBox } from "../../src/client/raw.ts";
import { FakeArcade } from "../../src/host/fake-arcade.ts";
import { Kernel, KernelHost, type KernelSurface } from "../../src/host/kernel.ts";
import { testHost, until } from "../../src/host/testhost.ts";
import { CHAIN_APP } from "../../src/testapps.ts";
import { storeSpec } from "../../src/runtime/index-store.ts";

const here = dirname(fileURLToPath(import.meta.url));
const kernelBin = process.env.SKEIN_KERNEL ?? join(here, "../zig-out/bin/skein-kernel");
let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };

// ---------------------------------------------------------------- regtest

const sha256d = (b: Uint8Array) => createHash("sha256").update(createHash("sha256").update(b).digest()).digest();
const internal = (displayHex: string) => Buffer.from(displayHex, "hex").reverse();
const display = (h: Uint8Array) => Buffer.from(h).reverse().toString("hex");
const REGTEST_GENESIS = Buffer.from("0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4adae5494dffff7f2002000000", "hex");
const TARGET = 0x7fffffn << BigInt(8 * (0x20 - 3));
function mine(prev: Uint8Array, merkleRoot: Uint8Array, time: number): Buffer {
  const h = Buffer.alloc(80);
  h.writeInt32LE(1, 0);
  Buffer.from(prev).copy(h, 4);
  Buffer.from(merkleRoot).copy(h, 36);
  h.writeUInt32LE(time, 68);
  h.writeUInt32LE(0x207fffff, 72);
  for (let nonce = 0; ; nonce++) {
    h.writeUInt32LE(nonce, 76);
    if (BigInt("0x" + Buffer.from(sha256d(h)).reverse().toString("hex")) <= TARGET) return h;
  }
}
const blockCid = (raw: Uint8Array) => CID.createV1(0xb0, Digest.create(0x56, sha256d(raw)));

type State = { kind: string; network: string; maps: Record<string, CID | null> };
/** The tip of a headers map (the kernel's MST: [left, [[key, value, right] …]]): its rightmost key. */
async function tipOf(k: KernelSurface, root: CID | null | undefined): Promise<number | undefined> {
  let node = root ?? undefined, last: number | undefined;
  while (node) {
    const [, es] = await k.store.get(node) as unknown as [CID | null, Array<[Uint8Array, CID, CID | null]>];
    if (!es.length) break;
    const e = es[es.length - 1]!;
    last = Buffer.from(e[0]).readUInt32BE(0);
    node = e[2] ?? undefined;
  }
  return last;
}

const afters: Array<() => unknown> = [];
const rmR: Array<() => unknown> = [], rmS: Array<() => unknown> = [];
const arcade = await FakeArcade.start();
const ownerKey = PrivateKey.fromRandom();
const net = { genesis: { defaults: { walletNetwork: "regtest" } } };
const rh = await testHost({ after: (f) => (rmR.length ? afters : rmR).push(f) }, { ownerKey, ...net, rocks: true, arc: { url: arcade.url, token: "hc", events: arcade.eventsUrl }, arcRetry: { min: 300, max: 1000 } });
const sh = await testHost({ after: (f) => (rmS.length ? afters : rmS).push(f) }, { ownerKey, ...net });
const stores: string[] = [];
const timings: string[] = [];
try {
  for (const x of ["a", "b", "c"]) rh.instance(x);
  sh.instance("s");
  await rh.router.start();
  await sh.router.start();
  for (const x of ["a", "b", "c"]) await rh.install(x, [CHAIN_APP]);
  await sh.install("s", [CHAIN_APP]);
  const k = async (h: typeof rh, x: string) => (await h.router.hydrate(x)).kernel;
  const stateOf = async (h: typeof rh, x: string) => {
    const kk = await k(h, x);
    const c = await kk.call("head", "chain/state") as CID | null;
    return c ? { cid: c, st: await kk.store.get(c) as unknown as State } : undefined;
  };
  const host = KernelHost.acquire(join(rh.home, "store-rocksdb"), {});
  afters.push(() => host.release());

  // ------------------------------------------------ three runs; block 4 holds the funding alone, block 5 its child
  const alice = PrivateKey.fromRandom();
  const fund = new Transaction();
  fund.addInput({ sourceTXID: "72".repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex("51"), sequence: 0xffffffff });
  fund.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 10_000 });
  fund.merklePath = new MerklePath(4, [[{ offset: 0, hash: fund.id("hex"), txid: true }]]);
  const child = new Transaction();
  child.addInput({ sourceTransaction: fund, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(alice), sequence: 0xffffffff });
  child.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 9_000 });
  await child.sign();
  const fundTxid = child.id("hex");
  const hs: Buffer[] = [REGTEST_GENESIS];
  const next = (root: Uint8Array) => { const h = mine(sha256d(hs.at(-1)!), root, 1_790_400_000 + hs.length * 600); hs.push(h); return h; };
  const runs = [[1, 2, 3], [4, 5], [6]].map((r) => r.map((n) => next(n === 4 ? internal(fund.id("hex")) : n === 5 ? internal(fundTxid) : sha256d(Buffer.from(`b${n}`)))));
  const send = async (raws: Buffer[], to: Array<[typeof rh, string]>) => {
    for (const [h, x] of to) await h.router.chainHeaders(x, "chain", raws);
    for (const [h] of to) await h.router.settled();
  };
  const all: Array<[typeof rh, string]> = [[rh, "a"], [rh, "b"], [rh, "c"], [sh, "s"]];
  for (const r of runs) await send(r, all);
  const tip1 = (await host.chainTip())!;
  const rec1 = await host.get(tip1.root) as Uint8Array;
  const hostRec = dagCbor.decode(rec1) as { kind: string; maps: { headers: CID; heights: CID }; tip: { height: number; hash: string } };
  check(hostRec.kind === "host-chain" && tip1.height === 6 && tip1.hash === display(sha256d(hs[6]!)), `the host chain after three runs: tip 6 ${tip1.hash.slice(0, 16)}…`);
  for (const x of ["a", "b"]) {
    const s = (await stateOf(rh, x))!;
    check(String(s.st.maps.headers) === String(hostRec.maps.headers) && String(s.st.maps.heights) === String(hostRec.maps.heights), `${x}: chain/state names the host chain record's headers and heights roots (pointed at, not copied)`);
    check(await tipOf(await k(rh, x), s.st.maps.headers) === tip1.height, `${x}: the tip read off its chain/state is the host's (${tip1.height})`);
  }

  // ------------------------------------------------ a proof on A, then a heavier branch replacing 5 and 6
  child.merklePath = new MerklePath(5, [[{ offset: 0, hash: fundTxid, txid: true }]]);
  const toA = new RawBox(rh.owner, `${rh.base}/@a`);
  // The funding first (proven at 4), then its child (proven at 5): a BEEF of a proven transaction carries no parents.
  await toA.send(rh.keyOf("a").toPublicKey().toString(), "chain", { fn: "ingest", args: { beef: new Uint8Array(fund.toBEEF()) } });
  await rh.router.settled();
  await toA.send(rh.keyOf("a").toPublicKey().toString(), "chain", { fn: "ingest", args: { beef: new Uint8Array(child.toBEEF()) } });
  await rh.router.settled();
  const prog = async () => (((await (await k(rh, "a")).store.get(await (await k(rh, "a")).call("head", "chain/app") as CID)) as { programs: Record<string, CID> }).programs.chain!);
  const status = async () => {
    const c = await (await k(rh, "a")).invoke(await prog(), "status", dagCbor.encode({ txid: fundTxid }));
    return c.ok ? (dagCbor.decode(c.result) as { state: string; height?: number }) : { state: `error ${c.error}` };
  };
  const st0 = await until("A's proof", async () => { const s = await status(); return s.state === "proven" ? s : undefined; }, 15_000).catch(async () => await status());
  check(st0.state === "proven" && st0.height === 5, `A: a proof against the host chain's header at 5 verifies (${JSON.stringify(st0)})`);
  const postsBefore = arcade.posts.length;
  const alt5 = mine(sha256d(hs[4]!), sha256d(Buffer.from("alt5")), 1_790_500_000);
  const alt6 = mine(sha256d(alt5), sha256d(Buffer.from("alt6")), 1_790_500_600);
  const alt7 = mine(sha256d(alt6), sha256d(Buffer.from("alt7")), 1_790_501_200);
  await send([alt5, alt6, alt7], all);
  const tip2 = (await host.chainTip())!;
  const r2 = await host.chainHeaders([alt6, alt7]); // known headers again: nothing new
  check(tip2.height === 7 && String(r2.root) === String(tip2.root) && r2.added === 0, `the heavier branch replaced 5 and 6 on the host chain: tip 7; the same run again adds nothing (${r2.added})`);
  const st1 = await status();
  check(st1.state === "unproven", `A: its proof at the replaced 5 reverted: ${st1.state}`);
  await until("the broadcast again", () => arcade.posts.slice(postsBefore).some((b) => FakeArcade.txOf(b).id("hex") === fundTxid) || undefined, 15_000).catch(() => undefined);
  check(arcade.posts.slice(postsBefore).some((b) => FakeArcade.txOf(b).id("hex") === fundTxid), "A: its broadcast registered again and sent (the fake Arcade got it again)");
  const hostRec2 = dagCbor.decode((await host.get(tip2.root))!) as { maps: { headers: CID } };
  const sb = (await stateOf(rh, "b"))!;
  check(String(sb.st.maps.headers) === String(hostRec2.maps.headers) && await tipOf(await k(rh, "b"), sb.st.maps.headers) === 7, "B: consistent, pointing at the new record (tip 7)");
  const sa = (await stateOf(rh, "a"))!;
  check(String(sa.st.maps.headers) === String(hostRec2.maps.headers), "A: pointing at the new record");

  // ------------------------------------------------ the gate (#133)
  const hdr6 = blockCid(alt6);
  check((await host.has(hdr6, "a")) && (await host.has(hdr6, "b")) && (await host.has(tip2.root, "c")), "a block of the host chain is readable through every instance's set");
  check((await host.has(sa.cid, "a")) && !(await host.has(sa.cid, "b")), "A's own chain/state record is invisible through B's set");

  // ------------------------------------------------ serve (SQLite): the same runs, the same chain/state
  const sc = (await stateOf(rh, "c"))!, ss = (await stateOf(sh, "s"))!;
  check(String(sc.cid) === String(ss.cid), `serve's chain/state (its host chain in its own store) is the RocksDB host's for the same runs: ${String(ss.cid).slice(-12)} = ${String(sc.cid).slice(-12)}`);
  const sTip = await (await k(sh, "s")).chainTip();
  check(String(sTip?.root) === String(tip2.root), "and its host chain record is the same CID");

  // ------------------------------------------------ timing: a block, its frame and the event to 8 instances
  const eight = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"];
  for (const x of eight) rh.instance(x);
  for (const x of eight) await rh.install(x, [CHAIN_APP]);
  await Promise.all(eight.map(async (x) => { await rh.router.chainHeaders(x, "chain", [alt7]); }));
  await rh.router.settled();
  const per: number[] = [];
  let prev = alt7;
  for (let i = 0; i < 5; i++) {
    const nb = mine(sha256d(prev), sha256d(Buffer.from(`t${i}`)), 1_790_600_000 + i * 600);
    prev = nb;
    const t0 = performance.now();
    await Promise.all(eight.map((x) => rh.router.chainHeaders(x, "chain", [nb])));
    await rh.router.settled();
    per.push(performance.now() - t0);
  }
  const tips = await Promise.all(eight.map(async (x) => await tipOf(await k(rh, x), (await stateOf(rh, x))!.st.maps.headers)));
  check(tips.every((t) => t === 12), `8 instances followed 5 blocks: tips ${tips.join(",")}`);
  const med = [...per].sort((x, y) => x - y)[2]!;
  timings.push(`per block, one headers frame and the chain event stepped on 8 instances (RocksDB host): median ${med.toFixed(1)} ms (${per.map((x) => x.toFixed(1)).join(", ")})`);
  for (const x of ["a", "b", "c"]) stores.push(storeSpec(rh.db.get(x)!));
  stores.push(storeSpec(sh.db.get("s")!));
} catch (e) {
  check(false, `threw: ${(e as Error).stack}`);
}

// ---------------------------------------------------------------- timing: an image of N headers imported
const N = Number(process.env.HOSTCHAIN_IMPORT ?? 20160);
try {
  const t0 = performance.now();
  const chain: Buffer[] = [REGTEST_GENESIS];
  while (chain.length < N) chain.push(mine(sha256d(chain.at(-1)!), sha256d(Buffer.from(`i${chain.length}`)), 1_700_000_000 + chain.length * 600));
  // The image layout (sdk chain/src/image.zig): chain/headers/<8 digits> blobs of 2016, chain/tip.
  const git = (kind: string, body: Buffer) => { const obj = Buffer.concat([Buffer.from(`${kind} ${body.length}\0`), body]); return { cid: CID.createV1(0x78, Digest.create(0x11, createHash("sha1").update(obj).digest())), obj }; };
  const objs: Array<{ cid: CID; obj: Buffer }> = [];
  const entry = (mode: string, name: string, c: CID) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(c.multihash.digest)]);
  const blobs: Buffer[] = [];
  for (let i = 0; i < chain.length; i += 2016) {
    const b = git("blob", Buffer.concat(chain.slice(i, i + 2016)));
    objs.push(b);
    blobs.push(entry("100644", String(i).padStart(8, "0"), b.cid));
  }
  const headers = git("tree", Buffer.concat(blobs)); objs.push(headers);
  const tipBlob = git("blob", Buffer.from(`{"height":${chain.length - 1},"hash":"${display(sha256d(chain.at(-1)!))}"}\n`)); objs.push(tipBlob);
  const chainTree = git("tree", Buffer.concat([entry("40000", "headers", headers.cid), entry("100644", "tip", tipBlob.cid)])); objs.push(chainTree);
  const root = git("tree", entry("40000", "chain", chainTree.cid)); objs.push(root);
  timings.push(`an image of ${N} regtest headers mined and written: ${(performance.now() - t0).toFixed(0)} ms`);

  for (const backend of ["rocksdb", "sqlite"] as const) {
    const home = mkdtempSync(join(tmpdir(), "hc-import-"));
    try {
      let kk: KernelSurface, kh: KernelHost | undefined;
      const env = { SKEIN_HOME: home, SKEIN_NETWORK: "regtest" };
      if (backend === "rocksdb") {
        kh = KernelHost.acquire(join(home, "db"), { command: kernelBin, env });
        kk = await kh.open({ db: `rocksdb:${join(home, "db")}#img`, handle: "img", domain: "localhost" });
      } else kk = new Kernel({ db: join(home, "img.db"), handle: "img", domain: "localhost", command: kernelBin, env });
      for (const o of objs) await kk.putBlock(o.cid, o.obj);
      const t1 = performance.now();
      const got = await kk.chainImport(root.cid);
      const ms = performance.now() - t1;
      check(got.height === N - 1 && got.added === N, `chain-import (${backend}): ${got.added} headers, tip ${got.height}`);
      timings.push(`chain-import of ${N} headers (${backend}): ${ms.toFixed(0)} ms`);
      const t2 = performance.now();
      const nb = mine(sha256d(chain.at(-1)!), sha256d(Buffer.from("next")), 1_900_000_000);
      const r = await kk.chainHeaders([nb]);
      check(r.height === N, `then a header on it (${backend}): tip ${r.height}`);
      timings.push(`one headers frame on a ${N}-header host chain (${backend}): ${(performance.now() - t2).toFixed(1)} ms`);
      await kk.stop();
      await kh?.release();
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
} catch (e) {
  check(false, `import timing threw: ${(e as Error).stack}`);
}

for (const f of afters.reverse()) await f();
await arcade.close();
for (const s of stores) {
  const rp = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), s], { encoding: "utf8" });
  process.stdout.write(rp.stdout);
  if (rp.status !== 0) process.stdout.write(rp.stderr);
  check(rp.status === 0 && /identical .*the source store reproduced exactly/.test(rp.stdout), `${s.replace(/^.*[#/]/, "")}: replays to itself exactly after the process stopped`);
}
if (!process.env.KEEP) for (const f of [...rmR, ...rmS]) await f();
for (const t of timings) process.stdout.write(`  timing: ${t}\n`);
process.stdout.write(failures ? `hostchain: ${failures} FAILED\n` : "hostchain: all ok\n");
process.exit(failures ? 1 : 0);

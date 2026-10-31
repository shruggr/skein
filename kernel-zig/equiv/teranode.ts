// The Teranode headers tracker (#156) end to end on regtest, tonight's case: a
// host with NO headers source makes instance alice and installs the chain app
// into her — the image chain and the host chain are empty, so she has no chain.
// The host restarts with the tracker (a fake Teranode mesh and data hub,
// src/host/fake-teranode.ts): at start the tracker syncs the whole chain from
// the hub into the image chain, the empty host chain imports it (the wasm
// kernel's SQLite database) or takes it in `headers` runs (RocksDB), then alice
// is hydrated and sent the chain event; her chain state holds the chain, a
// proof against a header of it verifies, the next announced block moves her
// on, and her store replays to itself exactly.
//
// SKEIN_EQUIV_STORE=wasm: the instances sets of the host's SQLite database on
// the wasm kernel; =rocksdb: sets of one RocksDB database in one `skein-kernel
// host` process.
//
//   SKEIN_EQUIV_STORE=wasm node --experimental-strip-types --no-warnings kernel-zig/equiv/teranode.ts

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MerklePath, P2PKH, PrivateKey, Transaction, UnlockingScript } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { RawBox } from "../../src/client/raw.ts";
import { FakeTeranode, mineHeader } from "../../src/host/fake-teranode.ts";
import { testHost, until } from "../../src/host/testhost.ts";
import { storeSpec } from "../../src/runtime/index-store.ts";
import { CHAIN_APP } from "../../src/testapps.ts";
import { BACKEND, ROCKS_MODE, WASM_MODE } from "./backend.ts";

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };
const sha256d = (b: Uint8Array) => createHash("sha256").update(createHash("sha256").update(b).digest()).digest();
const display = (h: Uint8Array) => Buffer.from(h).reverse().toString("hex");

// A funding transaction proven in block 4 of the regtest chain the hub serves.
const alice = PrivateKey.fromRandom();
const fund = new Transaction();
fund.addInput({ sourceTXID: "72".repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex("51"), sequence: 0xffffffff });
fund.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 10_000 });
fund.merklePath = new MerklePath(4, [[{ offset: 0, hash: fund.id("hex"), txid: true }]]);
const N = 2500;
const f = await FakeTeranode.start();
for (let i = 1; i <= N; i++) f.chain.push(mineHeader(sha256d(f.chain.at(-1)!), i, i === 4 ? Buffer.from(fund.id("hex"), "hex").reverse() : undefined));

const afters: Array<() => unknown> = [];
const ownerKey = PrivateKey.fromRandom();
const regtest = { genesis: { defaults: { walletNetwork: "regtest" } } };
const store = { sqlite: WASM_MODE, rocks: ROCKS_MODE };
let spec = "";
try {
  // ------------------------------------------------ no headers source: alice made, the chain app installed, no chain
  const h1 = await testHost({ after: (x) => afters.push(x) }, { ownerKey, ...regtest, ...store });
  h1.instance("alice");
  await h1.router.start();
  await h1.install("alice", [CHAIN_APP]);
  await h1.router.settled();
  const empty = await h1.router.hostChainTips();
  check(h1.router.image.tip() === undefined && empty.length === 1 && empty[0]!.tip === undefined, `no headers source: the image chain and the host chain empty (${empty.map((x) => `${x.name}: ${x.tip?.height ?? "empty"}`).join(", ")})`);
  await h1.router.stop();

  // ------------------------------------------------ the next start, with the tracker
  const t0 = Date.now();
  const h2 = await testHost({ after: (x) => afters.push(x) }, { ownerKey, ...regtest, ...store, reuse: { home: h1.home, keyOf: h1.keyOf }, teranode: { bootstrap: [f.addr()], hub: f.hub, dht: false, discoveryMs: 300 } });
  await h2.router.start();
  const tips = await h2.router.hostChainTips();
  check(h2.router.image.tip()?.height === N && tips[0]?.tip?.height === N && tips[0]?.tip?.hash === display(sha256d(f.chain[N]!)), `at start: the first sync from the hub (${N + 1} headers) and the host chain filled: tip ${tips[0]?.tip?.height} in ${Date.now() - t0} ms`);
  const line = (re: RegExp) => h2.lines.findIndex((l) => re.test(l));
  const filled = Math.max(line(/imported from the image chain/), line(/headers from the image chain/));
  check(filled >= 0 && line(/hydrated alice/) > filled, `the host chain filled before alice was hydrated (${h2.lines[filled]?.replace(/^\[\w+\] /, "")})`);
  const k = async () => (await h2.router.hydrate("alice")).kernel;
  const tipOf = async () => {
    const kk = await k();
    const c = await kk.call("head", "chain/state") as CID | null;
    if (!c) return undefined;
    const st = await kk.store.get(c) as unknown as { maps: { headers: CID | null } };
    let node = st.maps.headers ?? undefined, last: number | undefined;
    while (node) {
      const [, es] = await kk.store.get(node) as unknown as [CID | null, Array<[Uint8Array, CID, CID | null]>];
      if (!es.length) break;
      last = Buffer.from(es.at(-1)![0]).readUInt32BE(0);
      node = es.at(-1)![2] ?? undefined;
    }
    return last;
  };
  const got = await until("alice's chain state", async () => ((await tipOf()) === N ? N : undefined), 20_000).catch(async () => await tipOf());
  check(got === N, `alice's chain state (the chain event at her start) holds the chain to ${got}`);

  // ------------------------------------------------ a proof against it
  const toA = new RawBox(h2.owner, `${h2.base}/@alice`);
  await toA.send(h2.keyOf("alice").toPublicKey().toString(), "chain", { fn: "ingest", args: { beef: new Uint8Array(fund.toBEEF()) } });
  await h2.router.settled();
  const status = async () => {
    const kk = await k();
    const prog = ((await kk.store.get(await kk.call("head", "chain/app") as CID)) as { programs: Record<string, CID> }).programs.chain!;
    const c = await kk.invoke(prog, "status", dagCbor.encode({ txid: fund.id("hex") }));
    return c.ok ? (dagCbor.decode(c.result) as { state: string; height?: number }) : { state: `error ${c.error}` };
  };
  const st = await until("the proof", async () => { const s = await status(); return s.state === "proven" ? s : undefined; }, 15_000).catch(async () => await status());
  check(st.state === "proven" && st.height === 4, `alice takes a proof against the header at 4: ${JSON.stringify(st)}`);

  // ------------------------------------------------ the next block, announced on the mesh
  await until("the tracker on the block topic", () => f.subscribers() > 0 || undefined, 15_000);
  f.mineTo(N + 1);
  await f.announce(N + 1);
  const moved = await until("alice moved on", async () => ((await tipOf()) === N + 1 ? N + 1 : undefined), 20_000).catch(async () => await tipOf());
  check(moved === N + 1, `the announced block ${N + 1}: the host chain and alice's chain state moved on (${moved})`);
  await h2.router.settled();
  spec = storeSpec(h2.db.get("alice")!);
} catch (e) {
  check(false, `threw: ${(e as Error).stack}`);
} finally {
  const [removeHome, ...rest] = afters;
  for (const x of rest.reverse()) await x();
  await f.stop();
  if (spec) {
    const rp = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), spec], { encoding: "utf8" });
    process.stdout.write(rp.stdout);
    if (rp.status !== 0) process.stdout.write(rp.stderr);
    check(rp.status === 0 && /identical .*the source store reproduced exactly/.test(rp.stdout), "her store replays to itself exactly");
  }
  if (!process.env.KEEP) await removeHome?.();
}

process.stdout.write(failures ? `teranode (${BACKEND}): ${failures} FAILED\n` : `teranode (${BACKEND}): all ok\n`);
process.exit(failures ? 1 : 0);

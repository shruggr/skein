// The shared host store (#96, #133): instances as sets of one LMDB
// environment, the member set the read gate, the chain's set the one
// exception.
//
// 1. The gate: two instances, alice and bob, in one environment. A record and
//    a program (app-demo's module and a program record) only bob put: for
//    alice `has` is false and `get` absent (her kernel), her `call` of that
//    program fails as absent while bob's runs it, and the host's reader
//    (lmdb-js, src/host/stores.ts) sees the same. A block both put is
//    held once. Each set's size counter is the sum of its own members' bytes
//    (a block both hold counted for each), bob's blocks not in alice's.
// 2. The chain's set: a block put under `host/chain` straight into the
//    environment (equiv/lmdb-env.ts, as the host's chain service will, #156)
//    is readable by both kernels and by the host's reader, and counts in no
//    instance's size.
// 3. Timing: 8 instances on one router each admit N entries (events nothing
//    takes: a log append and its commit each) and put N blocks, all at once —
//    on SQLite files and in one LMDB environment. SKEIN_EQUIV_BENCH_DIR puts
//    the hosts on a disk (the default is $TMPDIR, often tmpfs: no fsync cost).
// (Replay is not checked here: the test puts blocks outside the log. The
// stores the drivers write are replayed on both backends by replays.ts.)
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/lmdb.ts

import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";
import { sha256 } from "multiformats/hashes/sha2";
import { CID } from "multiformats/cid";
import { encode } from "../../src/runtime/cid.ts";
import { programRecord } from "../../src/runtime/programs.ts";
import { storeSpec } from "../../src/runtime/index-store.ts";
import { openStoreFile } from "../../src/host/stores.ts";
import { NotFound } from "../../src/runtime/store.ts";
import { HostDb } from "../../src/host/instances.ts";
import { Router } from "../../src/host/router.ts";
import { fakeDiscovery } from "../../src/host/fake-discovery.ts";
import { Signer } from "../../src/host/signer.ts";
import { testHost } from "../../src/host/testhost.ts";
import { ephemeralWallet } from "../../src/wallet.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "../..");
const kernel = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };
const absent = async (p: Promise<unknown>) => p.then(() => false, (e) => e instanceof NotFound || /not ?found/i.test((e as Error).message));
const envTool = (...args: string[]) => {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", join(here, "lmdb-env.ts"), ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`lmdb-env.ts ${args[0]}: ${r.stderr}`);
  return r.stdout.trim();
};

// ---------------------------------------------------------------- 1, 2: the gate and the chain's set

const afters: Array<() => unknown> = [];
try {
  const h = await testHost({ after: (f) => afters.push(f) }, { lmdb: true });
  const env = join(h.home, "store");
  h.instance("alice");
  h.instance("bob");
  await h.router.start();
  const kA = (await h.router.hydrate("alice")).kernel;
  const kB = (await h.router.hydrate("bob")).kernel;
  check(h.db.get("alice")!.store === `lmdb:${env}` && h.db.get("bob")!.store === `lmdb:${env}`, "host.db: both rows name the one environment (lmdb:<dir>; the set the handle)");

  // A record only bob put.
  const only = await kB.store.put({ kind: "only-bob", n: 1 } as never);
  check(await kB.hasBlock(only), "bob holds the record he put");
  check(!(await kA.hasBlock(only)), "alice's kernel: has → false for a block only bob put");
  check(await absent(kA.store.get(only)), "alice's kernel: get → absent");

  // A program only bob holds: its module and its record.
  const wasm = new Uint8Array(readFileSync(join(ROOT, "programs/test/app-demo/bin/app-demo.wasm")));
  const module = CID.create(1, 0x55, await sha256.digest(wasm));
  await kB.putBlock(module, wasm);
  const prog = await kB.store.put(programRecord("demo", module) as never);
  const arg = encode({}).bytes;
  const callB = await kB.invoke(prog, "demo.counter.get", arg);
  const callA = await kA.invoke(prog, "demo.counter.get", arg);
  check(callB.ok || !/not ?found|absent|no such/i.test(callB.error), `bob's call of the program runs it (${callB.ok ? "ok" : callB.error})`);
  check(!callA.ok && /not ?found|absent|no such|missing|not a wasm program record in the store/i.test(callA.error), `alice's call of the same program fails as absent (${callA.ok ? "ok?!" : callA.error})`);

  // The host's reader: the same gate.
  const rA = openStoreFile(storeSpec(h.db.get("alice")!), { readOnly: true });
  const rB = openStoreFile(storeSpec(h.db.get("bob")!), { readOnly: true });
  check(!(await rA.has(only)) && (await absent(rA.get(only))) && (await rB.has(only)), "the host's reader (lmdb-js): absent for alice, there for bob");
  check(!(await rA.has(module)) && (await rB.has(module)), "… and the module, likewise");

  // A block both put: held once, in both sets.
  const both = await kA.store.put({ kind: "both", n: 2 } as never);
  await kB.store.put({ kind: "both", n: 2 } as never);
  check((await kA.hasBlock(both)) && (await kB.hasBlock(both)), "a block both put: in both sets");

  // The chain's set: written straight into the environment (as the chain service will).
  const header = encode({ kind: "a header", height: 7 });
  envTool("chain-put", env, Buffer.from(header.cid.bytes).toString("hex"), Buffer.from(header.bytes).toString("hex"));
  check((await kA.hasBlock(header.cid)) && (await kB.hasBlock(header.cid)), "a block under host/chain: both kernels have it");
  check(JSON.stringify(await kA.store.get(header.cid)) === JSON.stringify({ kind: "a header", height: 7 }), "… alice's kernel reads it");
  check((await rA.has(header.cid)) && (await rB.has(header.cid)), "… and the host's reader, for both");

  // Sizes: each set's counter is its own members' bytes.
  await h.router.settled();
  const sz = JSON.parse(envTool("sizes", env, "alice", "bob", "host/chain")) as Record<string, { size: number; sum: number; members: number }>;
  check(sz.alice!.size === sz.alice!.sum && sz.bob!.size === sz.bob!.sum, `each set's size is the sum of its members' bytes (alice ${sz.alice!.size}, bob ${sz.bob!.size})`);
  check(sz.bob!.size - sz.alice!.size >= wasm.length, `bob's size carries the module only he holds (${wasm.length} bytes), alice's not`);
  check(sz["host/chain"]!.members === 1 && sz["host/chain"]!.size === 0, "the chain's block counts in no set's size (host/chain: one member, no counter)");
  await rA.close(); await rB.close();
  await h.router.stop();
} catch (e) {
  check(false, `threw: ${(e as Error).stack}`);
}

for (const f of afters.reverse()) await f();

// ---------------------------------------------------------------- 3: 8 instances writing at once

const N = Number(process.env.SKEIN_EQUIV_BENCH_N ?? 100);
async function bench(lmdb: boolean): Promise<number> {
  const home = await fs.mkdtemp(join(process.env.SKEIN_EQUIV_BENCH_DIR ?? tmpdir(), `skein-kz-bench-${lmdb ? "lmdb" : "sqlite"}-`));
  const db = new HostDb(join(home, "host.db"));
  const names = Array.from({ length: Number(process.env.SKEIN_EQUIV_BENCH_K ?? 8) }, (_, i) => `w${i}`);
  const keys = new Map(names.map((n, i) => [n, new PrivateKey((0x1000 + i).toString(16), 16)]));
  for (const n of names) db.add(n, { store: lmdb ? `lmdb:${join(home, "store")}` : join(home, "instances", n, "runtime.db"), identity: keys.get(n)!.toPublicKey().toString() });
  const router: Router = new Router({
    db, walletFor: (row) => ephemeralWallet(keys.get(row.handle)!), home, idleMs: 0, owner: new PrivateKey("0bee", 16).toPublicKey().toString(), providerKeyFor: (x) => new Signer(new PrivateKey("a77e57", 16)).providerKey(x),
    discovery: fakeDiscovery(db, () => router), kernel: { command: kernel, env: { SKEIN_HOME: home } }, log: () => {},
  });
  try {
    await router.listen(0);
    for (const n of names) await router.hydrate(n);
    await router.settled();
    const t0 = performance.now();
    await Promise.all(names.map(async (n) => {
      const k = (await router.hydrate(n)).kernel;
      for (let i = 0; i < N; i++) {
        await router.admitEvent(n, "bench", { kind: "bench", n: i, who: n });
        const b = encode({ kind: "bench-block", who: n, i, pad: "x".repeat(200) });
        await k.putBlock(b.cid, b.bytes);
      }
    }));
    await router.settled();
    const ms = performance.now() - t0;
    for (const n of names) {
      const k = (await router.hydrate(n)).kernel;
      const len = (await k.store.get((await k.tip())!) as unknown as { n: number }).n + 1;
      if (len < N + 1) throw new Error(`${n}: ${len} entries, not ${N + 1}`);
    }
    return ms;
  } finally {
    await router.stop();
    db.close();
    if (!process.env.KEEP) await fs.rm(home, { recursive: true, force: true });
  }
}
try {
  const s = await bench(false);
  const l = await bench(true);
  process.stdout.write(`timing: 8 instances × ${N} entries + ${N} blocks each, at once (${process.env.SKEIN_EQUIV_BENCH_DIR ?? `$TMPDIR ${tmpdir()}`}): SQLite ${Math.round(s)} ms, LMDB (one environment) ${Math.round(l)} ms\n`);
  check(true, "8 instances wrote at once into one environment");
} catch (e) {
  check(false, `the 8-instance run threw: ${(e as Error).stack}`);
}

process.stdout.write(failures ? `lmdb: ${failures} FAILED\n` : "lmdb: all ok\n");
process.exit(failures ? 1 : 0);

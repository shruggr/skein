// The one-process kernel (#158): `skein-kernel host`, every instance of a host
// in one process, a pool of workers, RocksDB inside it.
//
// a. 8 instances on one router, N entries each (events nothing takes: a log
//    append, the entry processed, its commit), submitted interleaved from the
//    host side — each instance's final state CID equals a serial run's (one
//    instance after another), and SQLite's (`serve`, a file each).
// b. The same with SKEIN_WORKERS=1.
// c. A `call` on instance A issued while A is mid-step — the step blocked on a
//    `wallet` request the test answers late — comes back before the step ends,
//    with the state as committed before the step (the entry pending, the state
//    pointer of that moment), not an error and not the state after.
// d. The member gate: a block only B put is absent for A (A's kernel, A's
//    call, the host's reader through A's set); a block in `host/chain` is
//    readable by both. (Nothing writes `host/chain` yet, #156: the test opens
//    it as a set of the process and puts the block there.)
// e. Replay after stop: each RocksDB set of (a), the host process stopped,
//    replayed (`skein-kernel replay`): the same state CID.
// Timings: (a) with N workers against 1, the serial run, SQLite's; the commit
// cost (one instance, entries one after another) on RocksDB and SQLite.
// SKEIN_EQUIV_BENCH_DIR puts the hosts on a disk (default $TMPDIR, often tmpfs).
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/pool.ts

import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey, type WalletInterface } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { encode } from "../../src/runtime/cid.ts";
import { storeSpec } from "../../src/runtime/index-store.ts";
import type { Stamp } from "../../src/runtime/syscalls.ts";
import { openStoreFile } from "../../src/host/stores.ts";
import { HostDb } from "../../src/host/instances.ts";
import { KernelHost, type HostedKernel } from "../../src/host/kernel.ts";
import { Router } from "../../src/host/router.ts";
import { fakeDiscovery } from "../../src/host/fake-discovery.ts";
import { Signer } from "../../src/host/signer.ts";
import { rawCid } from "../../src/host/boot.ts";
import { writeGenesis } from "../../src/host/genesis.ts";
import { ephemeralWallet } from "../../src/wallet.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "../..");
const kernel = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };
const N = Number(process.env.SKEIN_EQUIV_POOL_N ?? 500);
const K = Number(process.env.SKEIN_EQUIV_POOL_K ?? 8);
const BENCH = process.env.SKEIN_EQUIV_BENCH_DIR ?? tmpdir();
const TIME: Stamp = [1_800_000_000, 0];
const homes: string[] = [];

// ---------------------------------------------------------------- a, b: 8 instances, interleaved

type Run = { states: Map<string, string>; ms: number; specs: Map<string, string> };

async function run(o: { backend: "rocksdb" | "sqlite"; serial?: boolean; workers?: number; n?: number; k?: number }): Promise<Run> {
  const home = await fs.mkdtemp(join(BENCH, `skein-kz-pool-${o.backend}-`));
  homes.push(home);
  const db = new HostDb(join(home, "host.db"));
  const names = Array.from({ length: o.k ?? K }, (_, i) => `w${i}`);
  const keys = new Map(names.map((n, i) => [n, new PrivateKey((0x1000 + i).toString(16), 16)]));
  const rocks = join(home, "store-rocksdb");
  for (const n of names) db.add(n, { store: o.backend === "rocksdb" ? `rocksdb:${rocks}` : join(home, "instances", n, "runtime.db"), identity: keys.get(n)!.toPublicKey().toString(), domain: "localhost" });
  // No listen: the port the geneses name is fixed (and the clock): the same instances, the same CIDs, run after run.
  const router: Router = new Router({
    db, walletFor: (row) => ephemeralWallet(keys.get(row.handle)!), home, idleMs: 0, port: 4999, now: () => TIME,
    owner: new PrivateKey("0bee", 16).toPublicKey().toString(), providerKeyFor: (x) => new Signer(new PrivateKey("a77e57", 16)).providerKey(x),
    discovery: fakeDiscovery(db, () => router), cron: false,
    kernel: { command: kernel, env: { SKEIN_HOME: home, ...(o.workers ? { SKEIN_WORKERS: String(o.workers) } : {}) } },
    ...(o.backend === "rocksdb" ? { rocksStore: rocks } : {}),
    log: (s, l) => { if (process.env.VERBOSE) process.stdout.write(`  | [${s}] ${l}\n`); },
  });
  const specs = new Map(names.map((n) => [n, storeSpec(db.get(n)!)]));
  try {
    for (const n of names) await router.hydrate(n);
    await router.settled();
    const entry = (n: string, i: number) => router.admitEvent(n, "bench", { kind: "bench", n: i, who: n });
    const t0 = performance.now();
    if (o.serial) {
      for (const n of names) for (let i = 0; i < (o.n ?? N); i++) await entry(n, i);
    } else {
      // Interleaved: every instance's entries in its own order, all instances at once.
      await Promise.all(names.map(async (n) => { for (let i = 0; i < (o.n ?? N); i++) await entry(n, i); }));
    }
    await router.settled();
    const ms = performance.now() - t0;
    const states = new Map<string, string>();
    for (const n of names) {
      const s = openStoreFile(specs.get(n)!, { readOnly: true }) as ReturnType<typeof openStoreFile> & { state(): { cid: CID; cursor: number } };
      const st = s.state();
      states.set(n, `${st.cid.toString()}@${st.cursor}`);
      await s.close();
    }
    return { states, ms, specs };
  } finally {
    await router.stop();
    db.close();
  }
}

const same = (a: Map<string, string>, b: Map<string, string>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

let pooled: Run | undefined;
try {
  const serial = await run({ backend: "rocksdb", serial: true });
  pooled = await run({ backend: "rocksdb" });
  const one = await run({ backend: "rocksdb", workers: 1 });
  const sqlite = await run({ backend: "sqlite" });
  const cursorOk = [...pooled.states.values()].every((v) => Number(v.split("@")[1]) === N + 1);
  check(cursorOk, `a: every instance processed its genesis and ${N} entries (${[...pooled.states.values()][0]})`);
  check(same(pooled.states, serial.states), `a: ${K} instances × ${N} entries interleaved on the pool: each final state CID equals the serial run's`);
  check(same(one.states, serial.states), "b: the same with SKEIN_WORKERS=1");
  check(same(sqlite.states, serial.states), "a: … and SQLite's (serve, a file each): the same CIDs");
  process.stdout.write(`timing: ${K} instances × ${N} entries — RocksDB pool, default workers ${pooled.ms.toFixed(0)} ms; 1 worker ${one.ms.toFixed(0)} ms; serial (one instance after another, default workers) ${serial.ms.toFixed(0)} ms; SQLite (a serve process each) ${sqlite.ms.toFixed(0)} ms\n`);
  // Commit cost: one instance, entries one after another (each a log append + its processing, two commits).
  const c1 = await run({ backend: "rocksdb", serial: true, k: 1 });
  const c2 = await run({ backend: "sqlite", serial: true, k: 1 });
  process.stdout.write(`timing: commit cost (one instance, ${N} entries one after another): RocksDB ${(c1.ms / N).toFixed(3)} ms/entry, SQLite ${(c2.ms / N).toFixed(3)} ms/entry (on ${BENCH})\n`);
} catch (e) {
  check(false, `a/b threw: ${(e as Error).stack}`);
}

// ---------------------------------------------------------------- e: replay after stop

if (pooled) {
  for (const [n, spec] of pooled.specs) {
    const out = join(dirname(spec.slice("rocksdb:".length)), `replay-${n}.db`);
    const r = spawnSync(kernel, ["replay", spec, out], { encoding: "utf8", maxBuffer: 1 << 28 });
    const rep = r.status === 0 ? JSON.parse(r.stdout) as { index: { record: string } } : undefined;
    const want = pooled.states.get(n)!.split("@")[0];
    check(rep?.index.record === want, `e: ${n}'s set, the host process stopped, replays to the same state CID (${rep?.index.record?.slice(-8) ?? r.stderr.slice(0, 200)})`);
  }
}

// ---------------------------------------------------------------- c, d: a call beside a step; the gate

/** A wallet whose getPublicKey waits, once armed, for `release` (the step blocks on its `wallet` request). */
function gatedWallet(key: PrivateKey) {
  const w = ephemeralWallet(key);
  let armed = false;
  let called!: () => void;
  let release!: () => void;
  const calledP = new Promise<void>((r) => { called = r; });
  const releaseP = new Promise<void>((r) => { release = r; });
  const proxy = new Proxy(w, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r);
      if (p === "getPublicKey" && armed) return async (...args: unknown[]) => { called(); await releaseP; return (v as (...a: unknown[]) => unknown).apply(t, args); };
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as WalletInterface;
  return { wallet: proxy, arm: () => { armed = true; }, called: calledP, release };
}

try {
  const home = await fs.mkdtemp(join(tmpdir(), "skein-kz-pool-cd-"));
  homes.push(home);
  const dir = join(home, "store-rocksdb");
  const host = KernelHost.acquire(dir, { command: kernel, env: { SKEIN_HOME: home }, log: (l) => { if (process.env.VERBOSE) process.stdout.write(`  | [kernel] ${l}\n`); } });
  const keyA = new PrivateKey("a1", 16), keyB = new PrivateKey("b2", 16);
  const ga = gatedWallet(keyA);
  const open = (h: string, wallet?: WalletInterface) => host.open({ db: `rocksdb:${dir}#${h}`, handle: h, domain: "localhost", ...(wallet ? { wallet } : {}), log: (l) => { if (process.env.VERBOSE) process.stdout.write(`  | [${h}] ${l}\n`); } });
  const probeWasm = readFileSync(join(ROOT, "kernel-zig/test/call/probe.wasm"));
  const wireWasm = readFileSync(join(ROOT, "wasm/wire-probe.wasm"));
  const genesis = async (k: HostedKernel, key: PrivateKey, h: string) => {
    const identity = key.toPublicKey().toString();
    const pm = rawCid(probeWasm), wm = rawCid(wireWasm);
    await k.putBlock(pm, probeWasm);
    await k.putBlock(wm, wireWasm);
    const probe = await k.store.put({ kind: "program", name: "probe", code: { wasm: pm }, inputs: {}, services: [], description: "the call probe" } as never) as CID;
    const wire = await k.store.put({ kind: "program", name: "wire-probe", code: { wasm: wm }, inputs: {}, services: [], description: "the wallet probe" } as never) as CID;
    await writeGenesis(k, { identity, root: [identity], handle: h, domain: "localhost", dispatch: [{ transport: "event", address: "probe", program: wire.toString() }], scopes: {} });
    await k.start();
    await k.idle();
    return probe;
  };
  const kA = await open("alice", ga.wallet);
  const kB = await open("bob", ephemeralWallet(keyB));
  const probeA = await genesis(kA, keyA, "alice");
  await genesis(kB, keyB, "bob");

  // c: the step blocks on its wallet request; a call meanwhile.
  const before = await host.state("alice");
  ga.arm();
  const ev = await kA.store.put({ kind: "probe-event", n: 1 } as never);
  // The admit is answered once the entry is appended; its step runs on after it, on the instance's worker.
  const step = kA.admit({ box: "probe", event: ev } as never);
  await ga.called;
  let released = false;
  const during = await host.state("alice");
  const t0 = performance.now();
  const inp = await kA.invoke(probeA, "input", new Uint8Array());
  const callMs = performance.now() - t0;
  const input = inp.ok ? dagCbor.decode(inp.result) as { state?: CID; pending?: CID[] } : undefined;
  check(inp.ok && !released, `c: the call answered while the step waits on the wallet (${inp.ok ? `${callMs.toFixed(1)} ms` : inp.error})`);
  check((await host.state("alice"))!.equals(during!), "c: … and the step had not committed meanwhile");
  check(!!input?.state && !!during && input.state.equals(during), `c: its state is the state as committed at that moment (${input?.state?.toString().slice(-8)} = ${during?.toString().slice(-8)})`);
  check((input?.pending?.length ?? 0) === 1, `c: the entry being stepped is pending there (not processed): ${input?.pending?.length ?? 0} pending`);
  check(!!before && !before.equals(during!), "c: (the entry's log append was committed before the step: the pointer moved once, to the entry, not past it)");
  released = true;
  ga.release();
  const entry = await step;
  await kA.idle();
  const after = await host.state("alice");
  const inp2 = await kA.invoke(probeA, "input", new Uint8Array());
  const input2 = inp2.ok ? dagCbor.decode(inp2.result) as { state?: CID; pending?: CID[] } : undefined;
  check(!!after && !after.equals(during!) && !!input2?.state?.equals(after) && (input2?.pending?.length ?? 1) === 0, `c: after the step: a new state, the call sees it, nothing pending (entry ${entry.toString().slice(-8)})`);

  // d: the gate.
  const only = await kB.store.put({ kind: "only-bob", n: 1 } as never);
  check(await kB.hasBlock(only), "d: bob holds the record he put");
  check(!(await kA.hasBlock(only)), "d: alice's kernel: has → false for a block only bob put");
  const gotA = await kA.store.get(only).then(() => true, () => false);
  check(!gotA, "d: alice's kernel: get → absent");
  const probeB = await kB.store.put({ kind: "program", name: "probe2", code: { wasm: rawCid(probeWasm) }, inputs: {}, services: [], description: "bob's own" } as never) as CID;
  const callA = await kA.invoke(probeB, "echo", new TextEncoder().encode("x"));
  const callB = await kB.invoke(probeB, "echo", new TextEncoder().encode("x"));
  check(callB.ok && !callA.ok && /not a wasm program record in the store|not ?found/i.test(callA.error), `d: a program record only bob holds: bob's call runs it, alice's fails as absent (${callA.ok ? "ok?!" : callA.error})`);
  const rA = openStoreFile(`rocksdb:${dir}#alice`, { readOnly: true }), rB = openStoreFile(`rocksdb:${dir}#bob`, { readOnly: true });
  check(!(await rA.has(only)) && (await rB.has(only)), "d: the host's reader (through the kernel, the set's gate): absent for alice, there for bob");
  check(await host.has(only) && !!(await host.get(only)) && !(await host.has(only, "alice")), "d: the host-level read without a set sees every block; with alice's, not bob's");
  // host/chain: opened as a set of the process (test only: nothing writes it yet, #156), a block put there.
  const chain = await host.open({ db: `rocksdb:${dir}#host/chain`, handle: "host/chain", domain: "localhost" });
  const header = encode({ kind: "a header", height: 7 });
  await chain.putBlock(header.cid, header.bytes);
  await chain.stop();
  check((await kA.hasBlock(header.cid)) && (await kB.hasBlock(header.cid)), "d: a block in host/chain: both kernels have it");
  check((await rA.has(header.cid)) && (await rB.has(header.cid)), "d: … and the host's reader, for both sets");
  check(JSON.stringify(await host.instances()) === JSON.stringify(["alice", "bob"].sort()) || (await host.instances()).sort().join() === "alice,bob", `the process's open instances: ${(await host.instances()).sort().join(", ")}`);
  await kA.stop();
  await kB.stop();
  check((await host.instances()).length === 0, "close: both instances closed, the process still running");
  await host.release();
  await host.exited();
  check(true, "stop: the process exited after the last release");
} catch (e) {
  check(false, `c/d threw: ${(e as Error).stack}`);
}

if (!process.env.KEEP) for (const h of homes) await fs.rm(h, { recursive: true, force: true });
process.stdout.write(failures ? `pool: ${failures} FAILED\n` : "pool: all ok\n");
process.exit(failures ? 1 : 0);

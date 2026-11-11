// A thread resting on an event name (skein 0.5.4) end to end: one router, one instance `ox`,
// three apps installed by the owner's messages — programs/test/event-demo's module as `evx`,
// `evy` and `evz`; evx an event route `go` (a host's event there emits facts), evy and evz an
// event route `rest` (a host's event there starts a thread of the app's own program that calls
// `on(name)` with no fn, and its step ends resting):
//
//   - threads A (evy, tag y1), B (evz, z1), C (evy, y2) rest on `evx/r`, in that order, and D
//     (evz, d) on `evx/other`;
//   - three facts under `evx/r` (and one under `evx/q`, nobody's): each wakes A, B, C in the
//     order they began resting, each a step at the emitting entry told the fact's record, name
//     and place; D is never woken by them; A, B, C rest on the name again (they call nothing)
//     and so each is woken by all three; one fact under `evx/other` wakes D alone;
//   - the context intact: each wake carries its thread's own tag, and its thread's step count
//     goes 2, 3, 4;
//   - a crash in the middle of a delivery: S (evy, slow) then T (evz) rest on `evx/slow`; a
//     host's event in `evx/go` emits it; the kernel is killed while S's step runs; nothing of the
//     entry was committed, and once restarted each is woken once;
//   - index-store.ts derives the kernel's waits index (`awaits`) from the chains;
//   - the store replays to itself exactly — on SQLite, with SKEIN_EQUIV_STORE=rocksdb on RocksDB,
//     with =wasm on the WASM host.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/rest-on.ts

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { ownerCli } from "../../src/testapps.ts";
import { HostDb } from "../../src/host/instances.ts";
import { Signer } from "../../src/host/signer.ts";
import { Router } from "../../src/host/router.ts";
import { openStoreFile } from "../../src/host/stores.ts";
import { buildTree, derive, type IndexStore } from "../../src/runtime/index-store.ts";
import { ephemeralWallet } from "../../src/wallet.ts";
import { BACKEND, WASM_MODE, routerStore, specFor, storeFor } from "./backend.ts";

const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
const home = mkdtempSync(join(tmpdir(), "skein-kz-reston-"));
let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const wasm = join(here, "../../programs/test/event-demo/bin/event-demo.wasm");
function appTree(name: string, routes: Array<Record<string, unknown>> = []): string {
  const dir = join(home, "apps", name);
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "etc"), { recursive: true });
  copyFileSync(wasm, join(dir, "bin/event-demo.wasm"));
  writeFileSync(join(dir, "etc/app.json"), JSON.stringify({
    kind: "app", name, version: "0.1.0", programs: { demo: "bin/event-demo.wasm" }, provides: [], requires: [],
    routes: [{ address: "", handler: "demo" }, ...routes],
    description: `skein 0.5.4's test app ${name}: event-demo's module`,
  }, null, 2));
  return dir;
}

const ownerKey = new PrivateKey("2222", 16);
const owner = ownerKey.toPublicKey().toString();
const ownerWallet = ephemeralWallet(ownerKey);
const signer = new Signer(new PrivateKey("e1e2e3", 16));
const handle = "ox";
const hdb = new HostDb(join(home, "host.db"));
hdb.add(handle, { store: storeFor(home, handle) });
const lines: string[] = [];
const r = new Router({
  db: hdb, home, owner, idleMs: 0, walletFor: (row: { handle: string }) => signer.wallet(row.handle),
  providerKeyFor: (n: string) => signer.providerKey(n), peerKeyFor: (x: string) => signer.peerKey(x), answerWaitMs: 6000,
  kernel: { command: kernel, env: { SKEIN_HOME: home } }, ...routerStore(home),
  log: (s: string, l: string) => { lines.push(`[${s}] ${l}`); if (process.env.VERBOSE) process.stdout.write(`  | [${s}] ${l}\n`); },
});

type Woke = { box: string; event: CID; place: { s: number; i: number; thread: CID }; tag: string; thread: CID; step: number; prev: CID | null };
const idOfPlace = (p: { s: number; i: number; thread: CID }) => `${p.s}.${p.i}.${p.thread}`;

try {
  await r.listen(0);
  await r.hydrate(handle);
  const base = `http://127.0.0.1:${r.port}/@${handle}`;
  for (const app of ["evx", "evy", "evz"]) {
    const routes = app === "evx" ? [{ transport: "event", address: "go", handler: "demo" }] : [{ transport: "event", address: "rest", handler: "demo" }];
    const o = await ownerCli({ home, port: r.port!, owner: ownerWallet, settled: () => r.settled() }, ["install", appTree(app, routes), "--instance", handle]);
    await r.settled();
    check(o.code === 0, `skein install ${app}: exit ${o.code} ${o.err.join(" ")}`);
  }
  const emit = async (names: string[], value: number) => { await r.admitEvent(handle, "evx/go", { kind: "event-demo-emit", names, value }); await r.settled(); };
  const rest = async (app: string, name: string, tag: string, spin?: number) => { await r.admitEvent(handle, `${app}/rest`, { kind: "event-demo-rest", name, tag, ...(spin !== undefined ? { spin } : {}) }); await r.settled(); };
  const read = async (path: string): Promise<Array<{ id: string; event: string; record: Record<string, unknown> }>> => {
    const res = await fetch(`${base}/events/${path}`);
    if (res.status !== 200) throw new Error(`GET /events/${path}: ${res.status} ${await res.text()}`);
    return await res.json() as Array<{ id: string; event: string; record: Record<string, unknown> }>;
  };
  const withStore = async <T>(f: (st: IndexStore) => Promise<T>): Promise<T> => {
    const st = openStoreFile(specFor(home, handle), { readOnly: true }) as unknown as IndexStore;
    try { return await f(st); } finally { st.close(); }
  };
  /** Every wake an app's threads took, oldest first (its head `<app>/woke`, chained by `prev`). */
  const wokeBy = (app: string) => withStore(async (st) => {
    const out: Woke[] = [];
    const h = st.heads().find((x) => x.name === `${app}/woke`);
    for (let c: CID | null = h ? h.root : null; c; ) { const v = dagCbor.decode(await st.bytes(c)) as Woke; out.unshift(v); c = v.prev; }
    return out;
  });
  const all = async () => [...await wokeBy("evy"), ...await wokeBy("evz")];
  /** The wake lines (`event <name> … → <thread> (rests on it)`) logged since `from`, as "<name> <thread short>". */
  const woken = (from: number) => lines.slice(from).map((l) => / event (\S+) \S+ → (\S+) \(rests on it\)/.exec(l)).filter((m): m is RegExpExecArray => !!m).map((m) => `${m[1]} ${m[2]}`);
  const short = (c: CID) => c.toString().slice(-8);

  // ------------------------------------------------ four threads begin resting
  await rest("evy", "evx/r", "y1");
  await rest("evz", "evx/r", "z1");
  await rest("evy", "evx/r", "y2");
  await rest("evz", "evx/other", "d");
  const resting = lines.filter((l) => / step 1 → waiting/.test(l) && /demo|event-demo/.test(l)).length;
  check(resting >= 4, `each rest step ends with its thread resting (${resting} steps → waiting)`);

  // ------------------------------------------------ three facts under the name, one under another nobody's
  const n1 = lines.length;
  await emit(["evx/r"], 1);
  await emit(["evx/q"], 0); // nobody rests on it
  await emit(["evx/r"], 2);
  await emit(["evx/r"], 3);
  const w = await all();
  const tagOf = new Map(w.map((x) => [short(x.thread), x.tag]));
  const order = woken(n1).map((s) => { const [nm, t] = s.split(" "); return `${nm} ${tagOf.get(t!) ?? t}`; });
  const want = ["y1", "z1", "y2"].map((t) => `evx/r ${t}`);
  check(order.join(", ") === [...want, ...want, ...want].join(", "), `each fact wakes A, B, C in the order they began resting: ${order.join(", ")}`);
  const onR = w.filter((x) => x.box === "evx/r");
  const facts = await read("evx/r");
  const byTag = (t: string) => onR.filter((x) => x.tag === t);
  check(["y1", "z1", "y2"].every((t) => byTag(t).length === 3), `each resting thread woken by all three (y1 ${byTag("y1").length}, z1 ${byTag("z1").length}, y2 ${byTag("y2").length}): it rests on the name again`);
  check(["y1", "z1", "y2"].every((t) => byTag(t).map((x) => idOfPlace(x.place)).join(" ") === facts.map((f) => f.id).join(" ")), "each wake told the fact's place (the index's id), in log order");
  const recs = await withStore(async (st) => Promise.all(byTag("y1").map(async (x) => dagCbor.decode(await st.bytes(x.event)) as Record<string, unknown>)));
  check(recs.map((x) => `${x.event}:${x.value}`).join(" ") === "evx/r:1 evx/r:2 evx/r:3", "and the fact's record");
  check(["y1", "z1", "y2"].every((t) => byTag(t).map((x) => x.step).join(" ") === "2 3 4" && new Set(byTag(t).map((x) => x.thread.toString())).size === 1), "the context intact: one thread per tag, its steps 2, 3, 4");
  check(w.every((x) => x.tag !== "d"), "a thread resting on another name (evx/other) is never woken by them; nothing by evx/q");
  const n2 = lines.length;
  await emit(["evx/other"], 4);
  const d = (await wokeBy("evz")).filter((x) => x.tag === "d");
  check(woken(n2).length === 1 && d.length === 1 && d[0]!.box === "evx/other", `a fact under evx/other wakes D alone (${woken(n2).join(", ")})`);

  // ------------------------------------------------ a crash in the middle of a delivery
  const spin = Number(process.env.SKEIN_EQUIV_SPIN ?? (WASM_MODE ? 4_000_000 : 40_000_000));
  await rest("evy", "evx/slow", "s", spin);
  await rest("evz", "evx/slow", "t");
  const before = (await all()).length;
  const n3 = lines.length;
  const started = Date.now();
  await r.admitEvent(handle, "evx/go", { kind: "event-demo-emit", names: ["evx/slow"], value: 7 });
  for (const end = Date.now() + 30_000; woken(n3).length === 0 && Date.now() < end; ) await sleep(20);
  await sleep(200);
  const k = (await r.hydrate(handle)).kernel as unknown as { machine?: { worker: { terminate(): Promise<number> } }; proc?: { kill(s: string): void }; host?: { proc?: { kill(s: string): void } }; exited(): Promise<void> };
  if (k.machine) await k.machine.worker.terminate(); else if (k.host?.proc) k.host.proc.kill("SIGKILL"); else k.proc!.kill("SIGKILL");
  await k.exited();
  const killedAfter = Date.now() - started;
  check(woken(n3).length === 1, `the kernel was killed while S's slow step ran (${killedAfter} ms after the event; spin ${spin}; ${woken(n3).length} wake logged)`);
  if (BACKEND !== "rocksdb") {
    const committed = (await all()).length;
    const indexed = await withStore(async (st) => st.events({ name: "evx/slow" }).length);
    check(committed === before && indexed === 0, "nothing of the entry was committed (no wake, the fact not indexed)");
  }
  await r.hydrate(handle);
  await r.settled();
  for (const end = Date.now() + 60_000; ((await all()).filter((x) => x.box === "evx/slow").length < 2) && Date.now() < end; ) { await sleep(200); await r.settled(); }
  const slow = (await all()).filter((x) => x.box === "evx/slow");
  check(slow.filter((x) => x.tag === "s").length === 1 && slow.filter((x) => x.tag === "t").length === 1, `restarted: each resting thread woken once (s ${slow.filter((x) => x.tag === "s").length}, t ${slow.filter((x) => x.tag === "t").length})`);
  check((await read("evx/slow")).length === 1, "the fact indexed once");

  // ------------------------------------------------ the TypeScript derivation (index-store.ts) = the kernel's waits index
  const same = await withStore(async (st) => {
    const dv = await derive(st);
    const want = st.state().roots.awaits;
    const got = buildTree(dv.pairs.awaits).root;
    const names = dv.pairs.awaits.filter(([key]) => key[0]! >= 0x20).length;
    return { ok: !!want && !!got && want.equals(got), names };
  });
  check(same.ok && same.names === 6, `index-store.ts derives the kernel's waits index from the chains (${same.names} rests by name, the same root)`);
} catch (e) {
  check(false, `threw: ${(e as Error).stack}`);
} finally {
  await r.stop();
  hdb.close();
  const spec = specFor(home, handle);
  const rp = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), spec], { encoding: "utf8", env: { ...process.env, SKEIN_KERNEL_BIN: kernel } });
  process.stdout.write(rp.stdout);
  if (rp.status !== 0) process.stdout.write(rp.stderr);
  check(rp.status === 0 && /identical .*the source store reproduced exactly/.test(rp.stdout), `the store replays to itself exactly, the rests in the state CID (${BACKEND})`);
}

if (process.env.KEEP) process.stdout.write(`kept ${home}\n`); else rmSync(home, { recursive: true, force: true });
process.stdout.write(failures ? `rest-on (${BACKEND}): ${failures} FAILED\n` : `rest-on (${BACKEND}): all ok\n`);
process.exit(failures ? 1 : 0);

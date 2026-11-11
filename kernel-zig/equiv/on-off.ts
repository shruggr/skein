// The kernel's subscriptions (skein 0.5.2, 0.5.3) end to end: one router, one instance
// `ox`, three apps installed by the owner's messages — programs/test/event-demo's
// module as `evx`, `evy` and `evz` (a mailbox route each, and evx an event route
// `go` — the host's wiring into its box; nothing else in their manifests: a
// subscription is made in a step, `on(name, fn)`, and ended there, `off(name, fn)`):
//
//   - refusals as the call is made: a name that is no fact's (a trailing `/`,
//     an intention), a role the app has not;
//   - evy then evz subscribe to `evx/a`, evz then evy to `evx/b`: a fact under
//     each steps both, in the order the subscriptions were made, each a step
//     told the fact's name, its `fn`, its record and its place;
//   - a fact under a name nobody subscribed to (`evx/c`) steps nothing;
//   - evy subscribes to `evx/late` after a fact under it: it hears the next
//     one only (no history);
//   - evy's `off(evx/a, heard)`: the next fact under it steps evz alone;
//   - two fns of one app on one name (evy's `heard` and `other` on `evx/two`),
//     `off` one (0.5.3): the next fact steps only the other;
//   - a crash in the middle of a delivery: evy ("slow") and evz subscribe to
//     `evx/slow`; a host's event in `evx/go` emits it; the kernel is killed
//     while evy's step runs; nothing of the
//     entry was committed, and once restarted each subscription is stepped
//     once — the cursor (entries processed) resumes it, nothing twice;
//   - the store replays to itself exactly (the subscriptions in the state CID)
//     — on SQLite, with SKEIN_EQUIV_STORE=rocksdb on RocksDB, with =wasm on the
//     WASM host.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/on-off.ts

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { RawBox } from "../../src/client/raw.ts";
import { ownerCli } from "../../src/testapps.ts";
import { HostDb } from "../../src/host/instances.ts";
import { Signer } from "../../src/host/signer.ts";
import { Router } from "../../src/host/router.ts";
import { openStoreFile } from "../../src/host/stores.ts";
import { ephemeralWallet } from "../../src/wallet.ts";
import { BACKEND, WASM_MODE, routerStore, specFor, storeFor } from "./backend.ts";

const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
const home = mkdtempSync(join(tmpdir(), "skein-kz-onoff-"));
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
    description: `skein 0.5.2's test app ${name}: event-demo's module`,
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

type Heard = { box: string; fn: string; event: CID; place: { s: number; i: number; thread: CID }; prev: CID | null };
const idOfPlace = (p: { s: number; i: number; thread: CID }) => `${p.s}.${p.i}.${p.thread}`;

try {
  await r.listen(0);
  const identity = (await r.hydrate(handle)).identity;
  const base = `http://127.0.0.1:${r.port}/@${handle}`;
  for (const app of ["evx", "evy", "evz"]) {
    const routes = app === "evx" ? [{ transport: "event", address: "go", handler: "demo" }] : [];
    const o = await ownerCli({ home, port: r.port!, owner: ownerWallet, settled: () => r.settled() }, ["install", appTree(app, routes), "--instance", handle]);
    await r.settled();
    check(o.code === 0, `skein install ${app}: exit ${o.code} ${o.err.join(" ")}`);
  }
  const box = new RawBox(ownerWallet, base);
  const send = async (app: string, body: Record<string, unknown>) => { await box.send(identity, app, body); await r.settled(); };
  const emit = (names: string[], value: number, spin?: number) => send("evx", { kind: "event-demo-emit", names, value, ...(spin !== undefined ? { spin } : {}) });
  const on = (app: string, name: string, fn: string) => send(app, { kind: "event-demo-on", name, fn });
  const off = (app: string, name: string, fn: string) => send(app, { kind: "event-demo-off", name, fn });
  const read = async (path: string): Promise<Array<{ id: string; event: string; record: Record<string, unknown> }>> => {
    const res = await fetch(`${base}/events/${path}`);
    if (res.status !== 200) throw new Error(`GET /events/${path}: ${res.status} ${await res.text()}`);
    return await res.json() as Array<{ id: string; event: string; record: Record<string, unknown> }>;
  };
  const withStore = async <T>(f: (st: IndexStore) => Promise<T>): Promise<T> => {
    const st = openStoreFile(specFor(home, handle), { readOnly: true }) as unknown as IndexStore;
    try { return await f(st); } finally { st.close(); }
  };
  /** Every fact an app heard, oldest first (its head `<app>/heard`, chained by `prev`). */
  const heardBy = (app: string) => withStore(async (st) => {
    const out: Heard[] = [];
    const h = st.heads().find((x) => x.name === `${app}/heard`);
    for (let c: CID | null = h ? h.root : null; c; ) { const v = dagCbor.decode(await st.bytes(c)) as Heard; out.unshift(v); c = v.prev; }
    return out;
  });
  const heardNames = async (app: string) => (await heardBy(app)).map((h) => h.box);
  /** The delivery lines (`event <name> … → <app>.<fn> …`) logged since `from`, as "<name> <app>.<fn>". */
  const delivered = (from: number) => lines.slice(from).map((l) => / event (\S+) \S+ → (\S+) /.exec(l)).filter((m): m is RegExpExecArray => !!m).map((m) => `${m[1]} ${m[2]}`);

  // ------------------------------------------------ refusals, as the call is made
  const n0 = lines.length;
  await on("evy", "evx/", "heard");
  await on("evy", "fetch", "heard");
  await on("evy", "evx/a", "nope.heard");
  check(lines.slice(n0).filter((l) => /on: "evx\/" is not a fact's name/.test(l)).length === 1, "on: a name with an empty segment is refused");
  check(lines.slice(n0).filter((l) => /on: "fetch" is not a fact's name/.test(l)).length === 1, "on: an intention's name is refused");
  check(lines.slice(n0).filter((l) => /on: "nope" is not a program of app evy/.test(l)).length === 1, "on: a role the app has not is refused");

  // ------------------------------------------------ two apps on one name, stepped in the order made
  await on("evy", "evx/a", "heard");
  await on("evz", "evx/a", "demo.heard");
  await on("evz", "evx/b", "heard");
  await on("evy", "evx/b", "heard");
  await on("evy", "evx/a", "heard"); // the same again: one subscription
  let n1 = lines.length;
  await emit(["evx/a"], 1);
  await emit(["evx/b"], 2);
  await emit(["evx/c"], 3); // nobody's
  check(delivered(n1).join(", ") === "evx/a evy.heard, evx/a evz.heard, evx/b evz.heard, evx/b evy.heard", `each subscription stepped once, in the order made: ${delivered(n1).join(", ")}`);
  check((await heardNames("evy")).join(" ") === "evx/a evx/b" && (await heardNames("evz")).join(" ") === "evx/a evx/b", "a name nobody subscribed to steps nothing (evx/c)");
  const facts = await read("evx/");
  const hy = await heardBy("evy");
  const factOf = (n: string) => facts.find((x) => x.event === n)!;
  check(hy.every((h) => h.fn === "heard" && idOfPlace(h.place) === factOf(h.box).id), "each step told the fact's name, its fn and its place (the index's id)");
  const recA = await withStore(async (st) => dagCbor.decode(await st.bytes(hy[0]!.event)) as Record<string, unknown>);
  check(recA.event === "evx/a" && recA.value === 1 && recA.app === "evx", "and its record");

  // ------------------------------------------------ no history
  await emit(["evx/late"], 4);
  await on("evy", "evx/late", "heard");
  await emit(["evx/late"], 5);
  const late = (await heardBy("evy")).filter((h) => h.box === "evx/late");
  const lateRec = late.length === 1 ? await withStore(async (st) => dagCbor.decode(await st.bytes(late[0]!.event)) as Record<string, unknown>) : undefined;
  check(late.length === 1 && lateRec?.value === 5, "an on made after a fact does not hear it; it hears the next");

  // ------------------------------------------------ off
  await off("evy", "evx/a", "heard");
  n1 = lines.length;
  await emit(["evx/a"], 6);
  check(delivered(n1).join(", ") === "evx/a evz.heard", `off: the next fact steps the others only (${delivered(n1).join(", ")})`);
  const n2 = lines.length;
  await off("evy", "evx/a", "heard"); // none left: nothing to end
  check(!lines.slice(n2).some((l) => /errored/.test(l)), "an off of a name the app has no subscription to changes nothing");

  // ------------------------------------------------ off(name, fn) ends that one subscription only (0.5.3)
  await on("evy", "evx/two", "heard");
  await on("evy", "evx/two", "other");
  n1 = lines.length;
  await emit(["evx/two"], 8);
  check(delivered(n1).join(", ") === "evx/two evy.heard, evx/two evy.other", `two fns of one app on one name: both stepped (${delivered(n1).join(", ")})`);
  await off("evy", "evx/two", "other");
  n1 = lines.length;
  await emit(["evx/two"], 9);
  check(delivered(n1).join(", ") === "evx/two evy.heard", `off(name, fn): only the other fn is stepped (${delivered(n1).join(", ")})`);

  // ------------------------------------------------ a crash in the middle of a delivery
  await on("evy", "evx/slow", "slow");
  await on("evz", "evx/slow", "heard");
  const before = { evy: (await heardBy("evy")).length, evz: (await heardBy("evz")).length };
  const spin = Number(process.env.SKEIN_EQUIV_SPIN ?? (WASM_MODE ? 400_000 : 40_000_000));
  const n3 = lines.length;
  const started = Date.now();
  // A host's event into evx's box `evx/go` (its event route): admitted (the entry durable), processed after — not settled: evy's step is slow.
  await r.admitEvent(handle, "evx/go", { kind: "event-demo-emit", names: ["evx/slow"], value: 7, spin });
  for (const end = Date.now() + 30_000; !delivered(n3).includes("evx/slow evy.slow") && Date.now() < end; ) await sleep(20);
  await sleep(200);
  const k = (await r.hydrate(handle)).kernel as unknown as { machine?: { worker: { terminate(): Promise<number> } }; proc?: { kill(s: string): void }; host?: { proc?: { kill(s: string): void } }; exited(): Promise<void> };
  if (k.machine) await k.machine.worker.terminate(); else if (k.host?.proc) k.host.proc.kill("SIGKILL"); else k.proc!.kill("SIGKILL");
  await k.exited();
  const killedAfter = Date.now() - started;
  const midway = delivered(n3).includes("evx/slow evy.slow") && !delivered(n3).includes("evx/slow evz.heard");
  check(midway, `the kernel was killed while evy's slow step ran (${killedAfter} ms after the send; spin ${spin})`);
  if (BACKEND !== "rocksdb") {
    const committed = { evy: (await heardBy("evy")).length, evz: (await heardBy("evz")).length };
    const indexed = await withStore(async (st) => st.events({ name: "evx/slow" }).length);
    check(committed.evy === before.evy && committed.evz === before.evz && indexed === 0, "nothing of the entry was committed (no heard, the fact not indexed)");
  }
  await r.hydrate(handle);
  await r.settled();
  for (const end = Date.now() + 60_000; ((await heardBy("evz")).filter((h) => h.box === "evx/slow").length === 0) && Date.now() < end; ) { await sleep(200); await r.settled(); }
  const slowY = (await heardBy("evy")).filter((h) => h.box === "evx/slow");
  const slowZ = (await heardBy("evz")).filter((h) => h.box === "evx/slow");
  check(slowY.length === 1 && slowZ.length === 1, `restarted: each subscription stepped once (evy ${slowY.length}, evz ${slowZ.length})`);
  check((await read("evx/slow")).length === 1, "the fact indexed once");

} catch (e) {
  check(false, `threw: ${(e as Error).stack}`);
} finally {
  await r.stop();
  hdb.close();
  const spec = specFor(home, handle);
  const rp = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), spec], { encoding: "utf8", env: { ...process.env, SKEIN_KERNEL_BIN: kernel } });
  process.stdout.write(rp.stdout);
  if (rp.status !== 0) process.stdout.write(rp.stderr);
  check(rp.status === 0 && /identical .*the source store reproduced exactly/.test(rp.stdout), `the store replays to itself exactly, the subscriptions in the state CID (${BACKEND})`);
}

if (process.env.KEEP) process.stdout.write(`kept ${home}\n`); else rmSync(home, { recursive: true, force: true });
process.stdout.write(failures ? `on-off (${BACKEND}): ${failures} FAILED\n` : `on-off (${BACKEND}): all ok\n`);
process.exit(failures ? 1 : 0);

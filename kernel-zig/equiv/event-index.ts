// The kernel's event index (skein 0.5.0) end to end: one router, one instance
// `ix`, two apps installed by the owner's messages — programs/test/event-demo's
// module as `evx` and `evy` (a mailbox route each):
//
//   - a name not under the emitting app's own (`evy/x` from evx, `pool`) is
//     refused as it is emitted: the step errors with the kernel's reason;
//   - evx emits facts under three names (evx/pool/a, evx/pool/b, evx/output/o,
//     some twice), evy one under its own;
//   - the host's read GET /@ix/events/<name path> (a name, a prefix, latest,
//     after, limit) answers what the index holds, and evy's in-step read (the
//     `events` import, head `evy/read`) the same rows: the same places, the
//     same records;
//   - the stream (Accept: text/event-stream) sends the same read, then a fact
//     as its step is committed, with the id the index gives it;
//   - the instance's store replays to itself exactly (the index in the state
//     CID) — on SQLite, and with SKEIN_EQUIV_STORE=rocksdb on RocksDB; replays.ts
//     also replays the log into the other backends to the same state.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/event-index.ts

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
import { SseStream, type SseEvent } from "../../src/host/feeds.ts";
import { openStoreFile } from "../../src/host/stores.ts";
import { type IndexStore } from "../../src/runtime/index-store.ts";
import { ephemeralWallet } from "../../src/wallet.ts";
import { BACKEND, routerStore, specFor, storeFor } from "./backend.ts";

const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
const home = mkdtempSync(join(tmpdir(), "skein-kz-evix-"));
let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, f: () => Promise<T | undefined> | T | undefined, ms = 20_000): Promise<T> {
  for (const end = Date.now() + ms; ;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

// ---------------------------------------------------------------- the two apps: event-demo's module
const wasm = join(here, "../../programs/test/event-demo/bin/event-demo.wasm");
function appTree(name: string, routes: Array<Record<string, unknown>>): string {
  const dir = join(home, "apps", name);
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "etc"), { recursive: true });
  copyFileSync(wasm, join(dir, "bin/event-demo.wasm"));
  writeFileSync(join(dir, "etc/app.json"), JSON.stringify({
    kind: "app", name, version: "0.1.0", programs: { demo: "bin/event-demo.wasm" }, provides: [], requires: [],
    routes: [{ address: "", handler: "demo" }, ...routes],
    description: `skein 0.5.0's test app ${name}: event-demo's module`,
  }, null, 2));
  return dir;
}

const ownerKey = new PrivateKey("2222", 16);
const owner = ownerKey.toPublicKey().toString();
const ownerWallet = ephemeralWallet(ownerKey);
const signer = new Signer(new PrivateKey("e1e2e3", 16));
const handle = "ix";
const hdb = new HostDb(join(home, "host.db"));
hdb.add(handle, { store: storeFor(home, handle) });
const lines: string[] = [];
const r = new Router({
  db: hdb, home, owner, idleMs: 0, walletFor: (row: { handle: string }) => signer.wallet(row.handle),
  providerKeyFor: (n: string) => signer.providerKey(n), peerKeyFor: (x: string) => signer.peerKey(x), answerWaitMs: 6000,
  kernel: { command: kernel, env: { SKEIN_HOME: home } }, ...routerStore(home),
  log: (s: string, l: string) => { lines.push(`[${s}] ${l}`); if (process.env.VERBOSE) process.stdout.write(`  | [${s}] ${l}\n`); },
});

type Row = { id: string; event: string; record: Record<string, unknown> };
const idOfPlace = (p: { s: number; i: number; thread: CID }) => `${p.s}.${p.i}.${p.thread}`;

try {
  await r.listen(0);
  const identity = (await r.hydrate(handle)).identity;
  const base = `http://127.0.0.1:${r.port}/@${handle}`;
  const install = async (app: string, routes: Array<Record<string, unknown>> = []) => {
    const o = await ownerCli({ home, port: r.port!, owner: ownerWallet, settled: () => r.settled() }, ["install", appTree(app, routes), "--instance", handle]);
    await r.settled();
    check(o.code === 0, `skein install ${app}: exit ${o.code} ${o.err.join(" ")}`);
  };
  await install("evx");
  await install("evy");
  const box = new RawBox(ownerWallet, base);
  const send = async (app: string, body: Record<string, unknown>) => { await box.send(identity, app, body); await r.settled(); };
  const emit = (names: string[], value: number) => send("evx", { kind: "event-demo-emit", names, value });
  const read = async (path: string, q = ""): Promise<Row[]> => {
    const res = await fetch(`${base}/events/${path}${q ? `?${q}` : ""}`);
    if (res.status !== 200) throw new Error(`GET /events/${path}?${q}: ${res.status} ${await res.text()}`);
    return await res.json() as Row[];
  };
  /** A record by CID, and a head's record, read from the instance's store (a reader beside the kernel). */
  const withStore = async <T>(f: (st: IndexStore) => Promise<T>): Promise<T> => {
    const st = openStoreFile(specFor(home, handle), { readOnly: true }) as unknown as IndexStore;
    try { return await f(st); } finally { st.close(); }
  };
  const recordOf = (c: CID) => withStore(async (st) => dagCbor.decode(await st.bytes(c)) as Record<string, unknown>);
  const headRecord = (name: string) => withStore(async (st) => {
    const h = st.heads().find((x) => x.name === name);
    return h ? dagCbor.decode(await st.bytes(h.root)) as Record<string, unknown> : undefined;
  });

  // ------------------------------------------------ the name rule
  const nLines = lines.length;
  await emit(["evy/x"], 0);
  await emit(["pool"], 0);
  const refused = lines.slice(nLines).filter((l) => /an app emits under its own name/.test(l));
  check(refused.length >= 2, `a name not under the app's own is refused as it is emitted (${refused.length} refusals logged)`);
  check((await read("", "")).length === 0, "nothing indexed by a refused emit");

  // ------------------------------------------------ facts under three names
  await emit(["evx/pool/a", "evx/pool/b"], 1);
  await emit(["evx/output/o"], 2);
  await emit(["evx/pool/a"], 3);
  await send("evy", { kind: "event-demo-emit", names: ["evy/own"], value: 4 }); // evy's own fact: indexed

  const all = await read("");
  check(all.map((x) => `${x.event}=${x.record.value}`).join(",") === "evx/pool/a=1,evx/pool/b=1,evx/output/o=2,evx/pool/a=3,evy/own=4", `GET /events/: every fact, newest last: ${all.map((x) => `${x.event}=${x.record.value}`).join(",")}`);
  check(all.every((x) => /^\d+\.\d+\.b[a-z2-7]+$/.test(x.id)), "each id is a place <s>.<i>.<thread> (0.8.0: the step number, the index in emitted, the thread)");
  const pool = await read("evx/pool/");
  check(pool.map((x) => `${x.event}=${x.record.value}`).join(",") === "evx/pool/a=1,evx/pool/b=1,evx/pool/a=3", "a prefix: the names it starts");
  const a = await read("evx/pool/a");
  check(a.length === 2 && a[0]!.record.value === 1 && a[1]!.record.value === 3, "a name: its facts");
  const latest = await read("evx/pool/", "latest=1");
  check(latest.map((x) => `${x.event}=${x.record.value}`).join(",") === "evx/pool/b=1,evx/pool/a=3", `latest: the last per name: ${latest.map((x) => `${x.event}=${x.record.value}`).join(",")}`);
  const after = await read("evx/", `after=${all[0]!.id}&limit=2`);
  check(after.map((x) => `${x.event}=${x.record.value}`).join(",") === "evx/pool/b=1,evx/output/o=2", "after a place, the first two");

  // ------------------------------------------------ the in-step read = the host's read
  const stepRead = async (query: Record<string, unknown>) => {
    await send("evy", { kind: "event-demo-read", query });
    const h = await headRecord("evy/read");
    const rows = dagCbor.decode(h!.answer as Uint8Array) as Array<{ name: string; place: { s: number; i: number; thread: CID }; cid: CID; record: Record<string, unknown> }>;
    return rows.map((x) => `${idOfPlace(x.place)} ${x.name} ${JSON.stringify(x.record.value)}`);
  };
  const hostRows = (rows: Row[]) => rows.map((x) => `${x.id} ${x.event} ${JSON.stringify(x.record.value)}`);
  check((await stepRead({ prefix: "evx/pool/" })).join("|") === hostRows(pool).join("|"), "in the step: a prefix, as the host read it");
  check((await stepRead({ name: "evx/pool/a" })).join("|") === hostRows(a).join("|"), "in the step: a name, as the host read it");
  check((await stepRead({ prefix: "evx/pool/", latest: true })).join("|") === hostRows(latest).join("|"), "in the step: latest, as the host read it");
  const p0 = placeOfId(all[0]!.id);
  check((await stepRead({ prefix: "evx/", after: p0, limit: 2 })).join("|") === hostRows(after).join("|"), "in the step: after and limit, as the host read it");
  const nLines2 = lines.length;
  await send("evy", { kind: "event-demo-read", query: { name: "x", prefix: "y" } });
  check(lines.slice(nLines2).some((l) => /events: want \{name/.test(l)), "a query that is not one: the step errors with the import's reason");

  // ------------------------------------------------ the stream: the same read, then live
  const got: Array<{ id: string; event: string; data: Record<string, unknown> }> = [];
  const s = new SseStream(`${base}/events/evx/pool/`, (e: SseEvent) => { got.push({ id: e.id!, event: e.event!, data: JSON.parse(e.data) as Record<string, unknown> }); }, { backoff: { min: 100, max: 100 } }).start();
  await until("the stream's read", () => got.length >= 3 || undefined);
  check(got.map((g) => g.id).join(" ") === pool.map((x) => x.id).join(" "), "the stream sends the same read first");
  await emit(["evx/pool/c", "evx/output/p"], 5);
  await until("the live fact", () => got.length >= 4 || undefined);
  await sleep(300);
  const now = await read("evx/pool/");
  check(got.length === 4 && got[3]!.event === "evx/pool/c" && got[3]!.id === now.at(-1)!.id, "then live: only the prefix's names, with the index's id");
  await s.stop();
} catch (e) {
  check(false, `threw: ${(e as Error).stack}`);
} finally {
  await r.stop();
  hdb.close();
  const spec = specFor(home, handle);
  const rp = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), spec], { encoding: "utf8", env: { ...process.env, SKEIN_KERNEL_BIN: kernel } });
  process.stdout.write(rp.stdout);
  if (rp.status !== 0) process.stdout.write(rp.stderr);
  check(rp.status === 0 && /identical .*the source store reproduced exactly/.test(rp.stdout), `the store replays to itself exactly, the event index in the state CID (${BACKEND})`);
}

function placeOfId(id: string): { s: number; i: number; thread: CID } {
  const [s, i, t] = id.split(".");
  return { s: Number(s), i: Number(i), thread: CID.parse(t!) };
}

if (process.env.KEEP) process.stdout.write(`kept ${home}\n`); else rmSync(home, { recursive: true, force: true });
process.stdout.write(failures ? `event-index (${BACKEND}): ${failures} FAILED\n` : `event-index (${BACKEND}): all ok\n`);
process.exit(failures ? 1 : 0);

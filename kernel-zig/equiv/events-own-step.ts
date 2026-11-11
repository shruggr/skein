// A step reads its own facts (skein 0.8.0): the `events` import answers the
// index as it stood before the step PLUS the facts the step emitted so far —
// its in-VM callees' too, one step — at the places its update will give them.
// One router, one instance `os`, programs/test/event-demo's module as `evy`
// (its `event-demo-emit-read`: emit, then read, in one step). Each in-step
// answer is compared with the host's GET /@os/events read of the same query
// once the step is committed: the same rows, the same places, the same records.
//
//   - emit then read: a name, a prefix, latest;
//   - two different records under one name: latest is the second; the same
//     record twice: one fact;
//   - an in-VM callee's emits seen by the caller after the call, and the
//     caller's earlier emits seen by a callee's read;
//   - `after` (a committed place) and `limit` across the committed / pending
//     boundary; `latest` with `limit` where a pending fact displaces the index's
//     row for its name;
//   - an errored step leaves nothing (no fact, no head);
//   - fact names of 300 and 9,000 bytes: subscribed, emitted, read in the step and
//     from the host, delivered; no host aborts (skein-sdk 0.21.1's prefix scan);
//   - 2,500 then 5,000 emits in one step, a latest read after each: the time
//     grows about linearly (the dedupe and the in-step read are O(1) per call);
//     the step's log line is bounded (its first ids and the count) and no host
//     aborts on it (before 0.8.0 a line of 8191 bytes or more aborted the
//     RocksDB host: host.zig sayRaw);
//   - the store replays to itself exactly — SQLite by default,
//     SKEIN_EQUIV_STORE=rocksdb / =wasm the others.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/events-own-step.ts

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
import type { IndexStore } from "../../src/runtime/index-store.ts";
import { ephemeralWallet } from "../../src/wallet.ts";
import { BACKEND, routerStore, specFor, storeFor } from "./backend.ts";

const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
const home = mkdtempSync(join(tmpdir(), "skein-kz-own-"));
let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };

const wasm = join(here, "../../programs/test/event-demo/bin/event-demo.wasm");
function appTree(name: string): string {
  const dir = join(home, "apps", name);
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "etc"), { recursive: true });
  copyFileSync(wasm, join(dir, "bin/event-demo.wasm"));
  writeFileSync(join(dir, "etc/app.json"), JSON.stringify({
    kind: "app", name, version: "0.1.0", programs: { demo: "bin/event-demo.wasm" }, provides: [], requires: [],
    routes: [{ address: "", handler: "demo" }],
    description: `skein 0.8.0's test app ${name}: event-demo's module`,
  }, null, 2));
  return dir;
}

const ownerKey = new PrivateKey("2323", 16);
const owner = ownerKey.toPublicKey().toString();
const ownerWallet = ephemeralWallet(ownerKey);
const signer = new Signer(new PrivateKey("e4e5e6", 16));
const handle = "os";
const hdb = new HostDb(join(home, "host.db"));
hdb.add(handle, { store: storeFor(home, handle) });
const lines: string[] = [];
const r = new Router({
  db: hdb, home, owner, idleMs: 0, walletFor: (row: { handle: string }) => signer.wallet(row.handle),
  providerKeyFor: (n: string) => signer.providerKey(n), peerKeyFor: (x: string) => signer.peerKey(x), answerWaitMs: 60000,
  kernel: { command: kernel, env: { SKEIN_HOME: home } }, ...routerStore(home),
  log: (s: string, l: string) => { lines.push(`[${s}] ${l}`); if (process.env.VERBOSE) process.stdout.write(`  | [${s}] ${l}\n`); },
});

type Place = { s: number; i: number; thread: CID };
type Row = { id: string; event: string; record: Record<string, unknown> };
const idOfPlace = (p: Place) => `${p.s}.${p.i}.${p.thread}`;

try {
  await r.listen(0);
  const identity = (await r.hydrate(handle)).identity;
  const base = `http://127.0.0.1:${r.port}/@${handle}`;
  const o = await ownerCli({ home, port: r.port!, owner: ownerWallet, settled: () => r.settled() }, ["install", appTree("evy"), "--instance", handle]);
  await r.settled();
  check(o.code === 0, `skein install evy: exit ${o.code} ${o.err.join(" ")}`);
  const box = new RawBox(ownerWallet, base);
  const send = async (body: Record<string, unknown>) => { await box.send(identity, "evy", body); await r.settled(); };
  const withStore = async <T>(f: (st: IndexStore) => Promise<T>): Promise<T> => {
    const st = openStoreFile(specFor(home, handle), { readOnly: true }) as unknown as IndexStore;
    try { return await f(st); } finally { st.close(); }
  };
  const headRecord = (name: string) => withStore(async (st) => {
    const h = st.heads().find((x) => x.name === name);
    return h ? { cid: h.root.toString(), rec: dagCbor.decode(await st.bytes(h.root)) as Record<string, unknown> } : undefined;
  });
  const hostRead = async (path: string, q = ""): Promise<Row[]> => {
    const res = await fetch(`${base}/events/${path}${q ? `?${q}` : ""}`);
    if (res.status !== 200) throw new Error(`GET /events/${path}?${q}: ${res.status} ${await res.text()}`);
    return await res.json() as Row[];
  };
  const hostRows = (rows: Row[]) => rows.map((x) => `${x.id} ${x.event} ${JSON.stringify(x.record.value)}`);
  /** One step: emit `names` (value), then read `query`; its answer as rows "<place> <name> <value>". */
  const emitRead = async (body: Record<string, unknown>) => {
    await send({ kind: "event-demo-emit-read", ...body });
    const h = await headRecord("evy/read");
    const rows = dagCbor.decode(h!.rec.answer as Uint8Array) as Array<{ name: string; place: Place; record: Record<string, unknown> }>;
    return { rows: rows.map((x) => `${idOfPlace(x.place)} ${x.name} ${JSON.stringify(x.record.value)}`), places: rows.map((x) => x.place), reads: h!.rec.reads as number, head: h!.cid };
  };
  const emit = (names: string[], value: number) => send({ kind: "event-demo-emit", names, value });
  const vals = (rows: string[]) => rows.map((x) => x.split(" ").slice(1).join("=")).join(",");

  // ------------------------------------------------ emit then read: a name, a prefix, latest
  {
    const x = await emitRead({ names: ["evy/a/x"], value: 1, query: { name: "evy/a/x" } });
    const host = hostRows(await hostRead("evy/a/x"));
    check(x.rows.length === 1 && x.rows.join("|") === host.join("|"), `a name: the step's own fact, at the place the index gives it (${x.rows.join("|")} = ${host.join("|")})`);
    const p = await emitRead({ names: ["evy/a/y", "evy/a/z"], value: 2, query: { prefix: "evy/a/" } });
    check(vals(p.rows) === "evy/a/x=1,evy/a/y=2,evy/a/z=2" && p.rows.join("|") === hostRows(await hostRead("evy/a/")).join("|"), `a prefix: the committed fact then the step's own, in place order (${vals(p.rows)})`);
    const l = await emitRead({ names: ["evy/a/x"], value: 3, query: { prefix: "evy/a/", latest: true } });
    check(vals(l.rows) === "evy/a/y=2,evy/a/z=2,evy/a/x=3" && l.rows.join("|") === hostRows(await hostRead("evy/a/", "latest=1")).join("|"), `latest: the step's own fact is its name's last (${vals(l.rows)})`);
  }

  // ------------------------------------------------ two records under one name; the same record twice
  {
    await send({ kind: "event-demo-emit-read", names: ["evy/b/x"], value: 1, query: { name: "evy/b/x" } });
    const two = await emitRead({ names: ["evy/b/x"], value: 2, query: { name: "evy/b/x", latest: true } });
    check(vals(two.rows) === "evy/b/x=2", `latest after two different records: the second (${vals(two.rows)})`);
    const same = await emitRead({ names: ["evy/c/x", "evy/c/x"], value: 7, query: { name: "evy/c/x" } });
    const host = await hostRead("evy/c/x");
    check(same.rows.length === 1 && host.length === 1 && same.rows.join("|") === hostRows(host).join("|"), `the same record twice in a step: one fact (${same.rows.length} in the step, ${host.length} indexed)`);
  }

  // ------------------------------------------------ in-VM calls: callee → caller, caller → callee
  {
    const ce = await emitRead({ names: ["evy/d/x", "evy/d/y"], value: 4, via: "callee-emit", query: { prefix: "evy/d/" } });
    check(vals(ce.rows) === "evy/d/x=4,evy/d/y=4" && ce.rows.join("|") === hostRows(await hostRead("evy/d/")).join("|"), `a callee's emits, read by its caller after the call (${vals(ce.rows)})`);
    const cr = await emitRead({ names: ["evy/e/x"], value: 5, via: "callee-read", query: { name: "evy/e/x" } });
    check(vals(cr.rows) === "evy/e/x=5" && cr.rows.join("|") === hostRows(await hostRead("evy/e/x")).join("|"), `the caller's emits, read by a callee it calls after them (${vals(cr.rows)})`);
  }

  // ------------------------------------------------ after and limit across the boundary; latest + limit
  {
    await emit(["evy/f/a", "evy/f/b"], 1); // committed: f/a=1, f/b=1
    const committed = await hostRead("evy/f/");
    const after = placeOfId(committed[0]!.id);
    const pg = await emitRead({ names: ["evy/f/c", "evy/f/d"], value: 2, query: { prefix: "evy/f/", after, limit: 2 } });
    check(vals(pg.rows) === "evy/f/b=1,evy/f/c=2" && pg.rows.join("|") === hostRows(await hostRead("evy/f/", `after=${committed[0]!.id}&limit=2`)).join("|"), `after a committed place, limit 2: the last committed and the step's first (${vals(pg.rows)})`);
    // The step's place, used as a cursor in the next step: what follows it.
    const next = await emitRead({ names: [], value: 0, query: { prefix: "evy/f/", after: pg.places[1] } });
    check(vals(next.rows) === "evy/f/d=2", `a place read in its own step pages on in the next (${vals(next.rows)})`);
    await emit(["evy/g/a"], 1);
    await emit(["evy/g/b"], 1);
    const ll = await emitRead({ names: ["evy/g/a"], value: 2, query: { prefix: "evy/g/", latest: true, limit: 1 } });
    check(vals(ll.rows) === "evy/g/b=1" && ll.rows.join("|") === hostRows(await hostRead("evy/g/", "latest=1&limit=1")).join("|"), `latest + limit 1: the step's g/a displaces the index's, g/b is first (${vals(ll.rows)})`);
  }

  // ------------------------------------------------ an errored step leaves nothing
  {
    const before = await headRecord("evy/read");
    const n0 = lines.length;
    await send({ kind: "event-demo-emit-read", names: ["evy/h/x"], value: 9, query: { name: "evy/h/x" }, fail: true });
    const after = await headRecord("evy/read");
    check(lines.slice(n0).some((l) => /failing as asked/.test(l)), "the step errored");
    check((await hostRead("evy/h/x")).length === 0 && before!.cid === after!.cid, "an errored step: no fact indexed, no head moved");
  }

  // ------------------------------------------------ long fact names (skein-sdk 0.21.1: any prefix length)
  for (const len of [300, 9000]) {
    const long = `evy/long${len}/${"x".repeat(len - `evy/long${len}/`.length)}`;
    await send({ kind: "event-demo-on", name: long, fn: "heard" });
    const r1 = await emitRead({ names: [long], value: len, query: { name: long } });
    const heard = await headRecord("evy/heard");
    check(r1.rows.length === 1 && vals(r1.rows) === `${long}=${len}` && (await hostRead(long)).length === 1, `a ${len}-byte fact name: read in its step and from the host`);
    check(heard?.rec.box === long && !lines.some((l) => /SIGABRT|panic|exited/.test(l)), `a ${len}-byte fact name: delivered to its subscription; no host aborted`);
  }

  // ------------------------------------------------ many emits in one step, a read after each
  {
    const time = async (count: number, name: string) => {
      const t0 = performance.now();
      const x = await emitRead({ names: [name], value: 0, count, query: { name, latest: true } });
      return { ms: performance.now() - t0, x };
    };
    const n0 = lines.length;
    const small = await time(2500, "evy/m/small");
    const big = await time(5000, "evy/m/big");
    check(big.x.reads === 5000 && vals(big.x.rows) === "evy/m/big=4999", `5,000 emits, a latest read after each: the last read saw the step's last fact (${vals(big.x.rows)}, ${big.x.reads} reads)`);
    check((await hostRead("evy/m/big")).length === 5000, "5,000 facts indexed");
    const stepLines = lines.slice(n0).filter((l) => /event-demo step \d+ → finished · emitted /.test(l));
    check(stepLines.length === 2 && stepLines.every((l) => l.length < 1024) && /\(5000 in all\)/.test(stepLines[1]!), `the steps' lines are bounded: ${stepLines.map((l) => l.length).join(", ")} bytes, "${stepLines[1]?.replace(/^.*· emitted /, "emitted ")}"`);
    check(!lines.some((l) => /SIGABRT|panic/.test(l)), "no host aborted");
    const ratio = big.ms / small.ms;
    check(ratio < 3.5, `linear: 2,500 in ${small.ms.toFixed(0)} ms, 5,000 in ${big.ms.toFixed(0)} ms (×${ratio.toFixed(2)}; quadratic would be ×4)`);
  }
} catch (e) {
  check(false, `threw: ${(e as Error).stack}`);
} finally {
  await r.stop();
  hdb.close();
  const spec = specFor(home, handle);
  const rp = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), spec], { encoding: "utf8", env: { ...process.env, SKEIN_KERNEL_BIN: kernel } });
  process.stdout.write(rp.stdout);
  if (rp.status !== 0) process.stdout.write(rp.stderr);
  check(rp.status === 0 && /identical .*the source store reproduced exactly/.test(rp.stdout), `the store replays to itself exactly, the in-step reads with it (${BACKEND})`);
}

function placeOfId(id: string): Place {
  const [s, i, t] = id.split(".");
  return { s: Number(s), i: Number(i), thread: CID.parse(t!) };
}

if (process.env.KEEP) process.stdout.write(`kept ${home}\n`); else rmSync(home, { recursive: true, force: true });
process.stdout.write(failures ? `events-own-step (${BACKEND}): ${failures} FAILED\n` : `events-own-step (${BACKEND}): all ok\n`);
process.exit(failures ? 1 : 0);

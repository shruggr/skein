// Facts are placed by the instance's step number (skein 0.8.0): every thread
// update the scheduler appends carries the next `ord`, and a fact's place is
// {s: that ord, i, thread}. So "the latest fact under a name" is the one the
// later step raised, whichever thread and whichever entry drove it. One
// router, one instance `oq`, programs/test/order-probe's module as `op`:
//
//   - S1: in one entry an OLD thread (resting, woken at its step 2) raises
//     op/x/s1 = "rested", and the fact it raises with it steps a FRESH
//     subscription thread (its step 1) that raises op/x/s1 = "heard": latest
//     is "heard" (before 0.8.0, ordered by the thread's own seq, "rested");
//     the fresh thread's in-step read says the same;
//   - S2, the reverse (fresh first, old second): latest is "rested";
//   - the places' `s` follow the order the steps were logged in;
//   - SSE: a stream resumed with Last-Event-ID = S1's first fact gets the
//     second (before, it sorted lower and was never sent);
//   - a restart: the kernel killed and started again, a step after it is
//     numbered after every step before it, its fact the latest;
//   - index-store.ts derives the kernel's events, resting and awaits maps
//     from the chains (the rebuild = the live index);
//   - the store replays to itself exactly — SQLite by default,
//     SKEIN_EQUIV_STORE=rocksdb / =wasm the others.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/event-order.ts

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
import { buildTree, derive, type IndexStore } from "../../src/runtime/index-store.ts";
import { ephemeralWallet } from "../../src/wallet.ts";
import { BACKEND, routerStore, specFor, storeFor } from "./backend.ts";

const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
const home = mkdtempSync(join(tmpdir(), "skein-kz-ord-"));
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

const wasm = join(here, "../../programs/test/order-probe/bin/order-probe.wasm");
function appTree(name: string): string {
  const dir = join(home, "apps", name);
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "etc"), { recursive: true });
  copyFileSync(wasm, join(dir, "bin/order-probe.wasm"));
  writeFileSync(join(dir, "etc/app.json"), JSON.stringify({
    kind: "app", name, version: "0.1.0", programs: { probe: "bin/order-probe.wasm" }, provides: [], requires: [],
    routes: [{ address: "", handler: "probe" }],
    description: `skein 0.8.0's test app ${name}: order-probe's module`,
  }, null, 2));
  return dir;
}

const ownerKey = new PrivateKey("2424", 16);
const owner = ownerKey.toPublicKey().toString();
const ownerWallet = ephemeralWallet(ownerKey);
const signer = new Signer(new PrivateKey("e7e8e9", 16));
const handle = "oq";
const hdb = new HostDb(join(home, "host.db"));
hdb.add(handle, { store: storeFor(home, handle) });
const lines: string[] = [];
const r = new Router({
  db: hdb, home, owner, idleMs: 0, walletFor: (row: { handle: string }) => signer.wallet(row.handle),
  providerKeyFor: (n: string) => signer.providerKey(n), peerKeyFor: (x: string) => signer.peerKey(x), answerWaitMs: 20000,
  kernel: { command: kernel, env: { SKEIN_HOME: home } }, ...routerStore(home),
  log: (s: string, l: string) => { lines.push(`[${s}] ${l}`); if (process.env.VERBOSE) process.stdout.write(`  | [${s}] ${l}\n`); },
});

type Place = { s: number; i: number; thread: CID };
type Row = { id: string; event: string; record: Record<string, unknown> };
const sOf = (id: string) => Number(id.split(".")[0]);

try {
  await r.listen(0);
  const identity = (await r.hydrate(handle)).identity;
  const base = `http://127.0.0.1:${r.port}/@${handle}`;
  const o = await ownerCli({ home, port: r.port!, owner: ownerWallet, settled: () => r.settled() }, ["install", appTree("op"), "--instance", handle]);
  await r.settled();
  check(o.code === 0, `skein install op: exit ${o.code} ${o.err.join(" ")}`);
  const box = new RawBox(ownerWallet, base);
  const send = async (body: Record<string, unknown>) => { await box.send(identity, "op", body); await r.settled(); };
  const withStore = async <T>(f: (st: IndexStore) => Promise<T>): Promise<T> => {
    const st = openStoreFile(specFor(home, handle), { readOnly: true }) as unknown as IndexStore;
    try { return await f(st); } finally { st.close(); }
  };
  const hostRead = async (path: string, q = ""): Promise<Row[]> => {
    const res = await fetch(`${base}/events/${path}${q ? `?${q}` : ""}`);
    if (res.status !== 200) throw new Error(`GET /events/${path}?${q}: ${res.status} ${await res.text()}`);
    return await res.json() as Row[];
  };
  const vals = (rows: Row[]) => rows.map((x) => String(x.record.value)).join(",");
  const inStep = () => withStore(async (st) => {
    const h = st.heads().find((x) => x.name === "op/read");
    const head = dagCbor.decode(await st.bytes(h!.root)) as { answer: Uint8Array };
    const rows = dagCbor.decode(head.answer) as Array<{ place: Place; record: Record<string, unknown> }>;
    return rows.map((x) => `${x.place.s}.${x.place.i}.${x.place.thread} ${String(x.record.value)}`);
  });

  // SSE on op/x/ from the start: every fact live, with its id.
  const live: Array<{ id: string; value: string }> = [];
  const s1 = new SseStream(`${base}/events/op/x/`, (e: SseEvent) => { live.push({ id: e.id!, value: String((JSON.parse(e.data) as { value: unknown }).value) }); }, { backoff: { min: 100, max: 100 } }).start();
  await sleep(300);

  // ------------------------------------------------ S1: old thread first, fresh thread second
  await send({ kind: "rest", name: "op/t/s1", then: "op/u/s1" });
  await send({ kind: "on", name: "op/u/s1" });
  const n1 = lines.length;
  await send({ kind: "go", name: "op/t/s1" });
  const s1all = await hostRead("op/x/s1");
  const s1latest = await hostRead("op/x/s1", "latest=1");
  check(vals(s1all) === "rested,heard", `S1 in one entry: the old thread's fact, then the fresh thread's (${s1all.map((x) => `${x.id.split(".").slice(0, 2).join(".")} ${String(x.record.value)}`).join(" | ")})`);
  check(vals(s1latest) === "heard", `S1 latest: the later step's ("heard"; before 0.8.0 "rested") (${vals(s1latest)})`);
  const mine = await inStep();
  check(mine.length === 1 && mine[0] === `${s1latest[0]!.id} heard`, `S1, in the fresh thread's own step: latest is its own fact, at its final place (${mine.join(" | ")})`);
  // The step numbers follow the log: the old thread's step line comes before the fresh thread's.
  const order = lines.slice(n1).filter((l) => / order-probe step \d+ → .* · emitted /.test(l)).map((l) => /\] (\S{8}) order-probe step/.exec(l)![1]);
  check(order.length >= 3 && sOf(s1all[0]!.id) < sOf(s1all[1]!.id) && s1all[0]!.id.endsWith(order[1]!) && s1all[1]!.id.endsWith(order[2]!), `S1: s follows the order the steps ran (logged: ${order.join(" → ")}; s ${sOf(s1all[0]!.id)} < ${sOf(s1all[1]!.id)})`);

  // ------------------------------------------------ S2: fresh thread first, old thread second
  await send({ kind: "on", name: "op/t/s2" });
  await send({ kind: "rest", name: "op/t/s2" });
  await send({ kind: "go", name: "op/t/s2" });
  check(vals(await hostRead("op/x/s2")) === "heard,rested" && vals(await hostRead("op/x/s2", "latest=1")) === "rested", `S2: the fresh thread's, then the old thread's; latest "rested" (${vals(await hostRead("op/x/s2"))})`);

  // ------------------------------------------------ SSE: live, then resumed after S1's first fact
  await until("the live facts", () => live.length >= 4 || undefined);
  await s1.stop();
  check(live.map((x) => x.value).join(",") === "rested,heard,heard,rested", `live: every fact in the order committed (${live.map((x) => x.value).join(",")})`);
  const first = s1all[0]!.id;
  const resumed: string[] = [];
  const s2 = new SseStream(`${base}/events/op/x/`, (e: SseEvent) => { resumed.push(`${e.id} ${String((JSON.parse(e.data) as { value: unknown }).value)}`); }, { backoff: { min: 100, max: 100 }, lastId: first }).start();
  await until("the resumed read", () => resumed.length >= 3 || undefined);
  await s2.stop();
  check(resumed[0] === `${s1all[1]!.id} heard` && resumed.length === 3, `SSE resumed after S1's first fact: the second comes next, nothing lost (${resumed.map((x) => x.split(" ")[1]).join(",")})`);

  // ------------------------------------------------ a restart: numbered after everything before it
  const before = (await hostRead("op/x/", "")).map((x) => sOf(x.id));
  const steps0 = await withStore(async (st) => Number((dagCbor.decode(await st.bytes(st.state().cid)) as { steps: number }).steps));
  const k = (await r.hydrate(handle)).kernel as unknown as { machine?: { worker: { terminate(): Promise<number> } }; proc?: { kill(s: string): void }; host?: { proc?: { kill(s: string): void } }; exited(): Promise<void> };
  if (k.machine) await k.machine.worker.terminate(); else if (k.host?.proc) k.host.proc.kill("SIGKILL"); else k.proc!.kill("SIGKILL");
  await k.exited();
  await r.hydrate(handle);
  await r.settled();
  await send({ kind: "on", name: "op/t/s3" });
  await send({ kind: "go", name: "op/t/s3" });
  const after = await hostRead("op/x/s3");
  check(after.length === 1 && sOf(after[0]!.id) > Math.max(...before) && sOf(after[0]!.id) > steps0, `after a restart (the state's steps ${steps0}), a step is numbered after every one before it (s ${after[0] && sOf(after[0].id)} > ${Math.max(...before)})`);
  check(vals(await hostRead("op/x/", "latest=1")).split(",").includes("heard"), "and its fact reads as the latest under its name");

  // ------------------------------------------------ the rebuild (index-store.ts derive) = the live index
  const same = await withStore(async (st) => {
    const d = await derive(st);
    const roots = st.state().roots;
    const eq = (m: "events" | "resting" | "awaits") => { const want = roots[m]; const got = buildTree(d.pairs[m]).root; return (want === null && got === null) || (!!want && !!got && want.equals(got)); };
    return { events: eq("events"), resting: eq("resting"), awaits: eq("awaits"), n: d.pairs.events.length };
  });
  check(same.events && same.resting && same.awaits, `index-store.ts derives the kernel's events (${same.n} keys), resting and awaits maps from the chains: the same roots (${JSON.stringify(same)})`);
} catch (e) {
  check(false, `threw: ${(e as Error).stack}`);
} finally {
  await r.stop();
  hdb.close();
  const spec = specFor(home, handle);
  const rp = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), spec], { encoding: "utf8", env: { ...process.env, SKEIN_KERNEL_BIN: kernel } });
  process.stdout.write(rp.stdout);
  if (rp.status !== 0) process.stdout.write(rp.stderr);
  check(rp.status === 0 && /identical .*the source store reproduced exactly/.test(rp.stdout), `the store replays to itself exactly, every step number with it (${BACKEND})`);
}

if (process.env.KEEP) process.stdout.write(`kept ${home}\n`); else rmSync(home, { recursive: true, force: true });
process.stdout.write(failures ? `event-order (${BACKEND}): ${failures} FAILED\n` : `event-order (${BACKEND}): all ok\n`);
process.exit(failures ? 1 : 0);

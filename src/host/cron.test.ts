// Jobs (#60, cron.ts): the router as the clock. On a script clock without a
// kernel: an `every` job fires at boot and at its interval (a late tick is one
// firing, never a burst), an `at` job once and never again after a restart, a
// restart fires an `every` job once, a stopped instance is woken only for a
// box something subscribes. With the real kernel: a system tree's
// etc/config.json jobs carried by its genesis, the cron event starting
// cron-demo, which rests on a deadline and is woken; the instance idle-stopped
// and hydrated for its next firing; a box nothing subscribes wakes nothing
// (while it is stopped: a running instance takes every job's event).
// And `skein-host event`: one plain event admitted now, refused while a
// router serves the host with no control socket here (control.test.ts: over it).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";
import type { CID } from "multiformats/cid";
import { msStamp } from "../runtime/syscalls.ts";
import { dirSource } from "./boot.ts";
import { main } from "./cli.ts";
import { Cron, cronEvent, jobKey, jobsIn, jobsOf, type JobSpec } from "./cron.ts";
import { genesisRecord, resolveSystem } from "./genesis.ts";
import { KERNEL_BIN } from "./kernel.ts";
import { testHost, until } from "./testhost.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEMO_WASM = join(ROOT, "programs/cron-demo/cron-demo.wasm");
const skip = !existsSync(KERNEL_BIN) && "kernel-zig not built";

/** A Cron on a script clock with a fake instance: what it admitted, as `handle box name due`. */
function scripted(o: { state?: "running" | "stopped" | "gone"; subscribed?: boolean; fired?: Set<string> } = {}) {
  const c = { t: 1_000_000, state: o.state ?? "running", subscribed: o.subscribed ?? true };
  const admitted: string[] = [];
  const lines: string[] = [];
  const fired = o.fired ?? new Set<string>();
  const cron = new Cron({
    now: () => c.t,
    admit: async (h, box, ev) => { admitted.push(`${h} ${box} ${String(ev.name)} ${String(ev.due)}`); return "bafy…entry"; },
    state: () => c.state, subscribed: async () => c.subscribed,
    fired: { has: (h, k) => fired.has(`${h} ${k}`), mark: (h, k) => { fired.add(`${h} ${k}`); } },
    log: (_s, l) => lines.push(l),
  });
  return { c, cron, admitted, lines, fired };
}

test("cron: an every job fires at boot, then at its interval; a late tick is one firing on the grid, no burst", async (t) => {
  const s = scripted();
  t.after(() => s.cron.stop());
  const t0 = s.c.t;
  s.cron.declare("a", [{ box: "tick", every: 1000, name: "beat" }]);
  await s.cron.tick();
  assert.deepEqual(s.admitted, [`a tick beat ${t0}`], "at boot");
  s.c.t += 999;
  await s.cron.tick();
  assert.equal(s.admitted.length, 1, "not before its interval");
  s.c.t += 1;
  await s.cron.tick();
  assert.deepEqual(s.admitted.slice(1), [`a tick beat ${t0 + 1000}`], "at the interval");
  s.c.t += 5500; // five intervals missed
  await s.cron.tick();
  assert.deepEqual(s.admitted.slice(2), [`a tick beat ${t0 + 2000}`], "one firing, however late");
  assert.equal(s.cron.of("a")[0]!.next, t0 + 7000, "the next grid point after now");
  // A re-declaration (a re-hydration after an idle stop) is not a boot: the schedule stands.
  s.cron.declare("a", [{ box: "tick", every: 1000, name: "beat" }]);
  await s.cron.tick();
  assert.equal(s.admitted.length, 3);
});

test("cron: an at job fires once — at `at`, or at boot if missed — and never again after a restart; an every job fires once after a restart", async (t) => {
  const s = scripted();
  t.after(() => s.cron.stop());
  const at = s.c.t + 500;
  const jobs: JobSpec[] = [{ box: "once", at, name: "later" }, { box: "tick", every: 60_000, name: "beat" }];
  s.cron.declare("a", jobs);
  await s.cron.tick();
  assert.deepEqual(s.admitted, [`a tick beat ${s.c.t}`], "the every job at boot; the at job not yet");
  s.c.t = at;
  await s.cron.tick();
  await s.cron.tick();
  assert.deepEqual(s.admitted.slice(1), [`a once later ${at}`], "the at job, once");
  assert.ok(s.fired.has(`a ${jobKey(jobs[0]!)}`), "remembered as fired");
  await s.cron.stop();

  // The host restarts (a new router, the same host.db) hours later.
  const r = scripted({ fired: s.fired });
  t.after(() => r.cron.stop());
  r.c.t = at + 3 * 3600_000;
  r.cron.declare("a", jobs);
  await r.cron.tick();
  await r.cron.tick();
  assert.deepEqual(r.admitted, [`a tick beat ${r.c.t}`], "the every job once (no catch-up for the hours missed); the at job not again");

  // An at job missed while the host was down, never fired: once at boot.
  const m = scripted();
  t.after(() => m.cron.stop());
  m.cron.declare("b", [{ box: "once", at: m.c.t - 10_000 }]);
  await m.cron.tick();
  await m.cron.tick();
  assert.deepEqual(m.admitted, [`b once undefined ${m.c.t - 10_000}`]);
});

test("cron: a stopped instance is woken for a box something subscribes, not for one nothing does; a gone one's jobs are dropped", async (t) => {
  const s = scripted({ state: "stopped", subscribed: false });
  t.after(() => s.cron.stop());
  s.cron.declare("a", [{ box: "nobody", every: 1000, name: "idle" }]);
  await s.cron.tick();
  assert.deepEqual(s.admitted, []);
  assert.match(s.lines.at(-1)!, /idle due: stopped, and nothing in it subscribes nobody: not woken/);
  s.c.subscribed = true;
  s.c.t += 1000;
  await s.cron.tick();
  assert.equal(s.admitted.length, 1, "woken for it");
  assert.match(s.lines.at(-1)!, /\(woken for it\)$/);
  s.c.state = "gone";
  s.c.t += 1000;
  await s.cron.tick();
  assert.equal(s.admitted.length, 1);
  assert.deepEqual(s.cron.of("a"), [], "dropped");
});

test("cron: jobs in etc/config.json, checked, carried by the genesis; the event record", () => {
  const k = "02" + "11".repeat(32);
  const c = { identity: k, owner: k, handle: "w", domain: "localhost" };
  const jobs = [{ box: "tick", every: 30_000, name: "beat", body: { kind: "amm-p2p-timer", job: "heartbeat" } }, { box: "once", at: 1_700_000_000_000 }];
  const g = genesisRecord(c, resolveSystem(c, {}, [], { jobs }));
  assert.deepEqual(jobsOf(g), jobs);
  assert.equal(genesisRecord(c, resolveSystem(c, {}, [])).jobs, undefined);
  assert.throws(() => jobsIn([{ box: "x" }]), /neither or both of every and at/);
  assert.throws(() => jobsIn([{ box: "x", every: 0 }]), /positive whole number/);
  assert.throws(() => jobsIn([{ every: 5 }]), /names no box/);
  assert.throws(() => jobsIn([{ box: "x", at: 5, body: [1] }]), /body that is not a map/);
  assert.throws(() => jobsIn({}), /jobs is a list/);
  assert.deepEqual(cronEvent(jobs[0]!, 7), { kind: "amm-p2p-timer", job: "heartbeat", name: "beat", due: 7 }, "the body's kind stands");
  assert.deepEqual(cronEvent(jobs[1]!, 9), { kind: "cron", due: 9 });
});

/** A system tree: cron-demo subscribed (sender-less) to `tick`, and the jobs. */
async function cronTree(t: { after(f: () => unknown): void }, jobs: JobSpec[]) {
  const dir = await fs.mkdtemp(join(tmpdir(), "skein-cron-tree-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(join(dir, "bin"));
  await fs.mkdir(join(dir, "etc"));
  await fs.writeFile(join(dir, "bin/cron-demo.wasm"), readFileSync(DEMO_WASM));
  await fs.writeFile(join(dir, "etc/subscriptions.json"), JSON.stringify([{ box: "tick", handler: "cron-demo" }]));
  await fs.writeFile(join(dir, "etc/config.json"), JSON.stringify({ jobs }));
  return dir;
}

type Entry = { prev?: CID; event?: CID; box?: string };
/** The event entries of an instance's log, oldest first: box and record. */
async function events(k: { store: { get(c: CID): Promise<unknown>; log: { tip(): Promise<CID | undefined> } } }): Promise<Array<{ box: string; ev: Record<string, unknown> }>> {
  const out: Array<{ box: string; ev: Record<string, unknown> }> = [];
  for (let c = await k.store.log.tip(); c;) {
    const e = await k.store.get(c) as Entry;
    if (e.event) out.unshift({ box: e.box!, ev: await k.store.get(e.event) as Record<string, unknown> });
    c = e.prev;
  }
  return out;
}

test("cron through the router: a tree's job starts cron-demo at boot, which rests on a deadline and wakes; idle-stopped, it is hydrated for the next firing; a box nothing subscribes wakes nothing", { skip, timeout: 120_000 }, async (t) => {
  let skew = 0;
  const h = await testHost(t, { idleMs: 400, now: () => msStamp(Date.now() + skew) });
  const dir = await cronTree(t, [{ box: "tick", every: 60_000, name: "beat", body: { rest: 150 } }, { box: "nobody", every: 60_000, name: "idle" }]);
  h.agent("cronny");
  const d = await dirSource(dir);
  await h.router.bootRow("cronny", { kind: "tree", root: d.root, objects: d.objects });
  await h.router.start();
  const said = (re: RegExp) => h.lines.some((l) => re.test(l));
  await until("the boot firing's thread woke", () => said(/^\[cronny\] \S+ cron-demo step 2 → finished/) || undefined);
  assert.ok(said(/^\[cronny\] \S+ cron-demo step 1 → waiting/), "step 1 rested on its deadline");
  assert.ok(said(/^\[cronny\] cron: beat → tick as /), "admitted at boot");
  assert.ok(said(/^\[cronny\] cron: idle → nobody as /), "the running instance's other job admitted too (nothing runs for it)");
  const k = (await h.router.hydrate("cronny")).kernel;
  const first = await events(k);
  assert.deepEqual(first.map((e) => `${e.box} ${String(e.ev.kind)} ${String(e.ev.name)}`), ["tick cron beat", "nobody cron idle"]);
  const due0 = first[0]!.ev.due as number;

  // Idle: stopped (its thread finished, no deadline left).
  await until("idle-stopped", () => !h.router.loaded.has("cronny") || undefined, 20_000);
  const n = h.lines.length;
  skew += 60_000;
  await h.router.cron.tick();
  await until("the second firing's thread woke", () => h.lines.slice(n).some((l) => /^\[cronny\] \S+ cron-demo step 2 → finished/.test(l)) || undefined);
  assert.ok(h.lines.slice(n).some((l) => /^\[router\] hydrated cronny/.test(l)), "hydrated for the job");
  assert.ok(h.lines.slice(n).some((l) => /^\[cronny\] cron: beat → tick as \S+ \(woken for it\)$/.test(l)));
  const later = await events((await h.router.hydrate("cronny")).kernel);
  assert.deepEqual(later.slice(2).map((e) => `${e.box} ${String(e.ev.name)}`), ["tick beat", "nobody idle"], "beat woke it; idle's then went into the running instance");
  assert.equal(later[2]!.ev.due, due0 + 60_000, "due on the grid");
});

test("cron: a stopped instance with only an unsubscribed job is not woken", { skip, timeout: 120_000 }, async (t) => {
  let skew = 0;
  const h = await testHost(t, { idleMs: 300, now: () => msStamp(Date.now() + skew) });
  const dir = await cronTree(t, [{ box: "nobody", every: 60_000, name: "idle" }]);
  h.agent("quiet");
  const d = await dirSource(dir);
  await h.router.bootRow("quiet", { kind: "tree", root: d.root, objects: d.objects });
  await h.router.start();
  await until("idle-stopped", () => !h.router.loaded.has("quiet") || undefined, 20_000);
  skew += 60_000;
  await h.router.cron.tick();
  assert.ok(h.lines.some((l) => /^\[quiet\] cron: idle due: stopped, and nothing in it subscribes nobody: not woken$/.test(l)), h.lines.join("\n"));
  assert.ok(!h.router.loaded.has("quiet"), "still stopped");
});

test("skein-host event: one plain event admitted now through a router of its own; refused while a router serves the host", { skip, timeout: 120_000 }, async (t) => {
  const home = await fs.mkdtemp(join(tmpdir(), "skein-event-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const probe = createServer((req, res) => { res.writeHead(req.url === "/manifest.json" ? 200 : 404, { "content-type": "application/json" }).end(JSON.stringify({ metanet: {} })); });
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  const vars: Record<string, string | undefined> = { HOME: home, SKEIN_HOME: home, SKEIN_MASTER_KEY: "77".repeat(32), SKEIN_OWNER: PrivateKey.fromRandom().toPublicKey().toString(), SKEIN_ROUTER_PORT: String(port), PATH: process.env.PATH };
  const out: string[] = [], err: string[] = [];
  const env = { vars, out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
  const dir = await cronTree(t, []);
  assert.equal(await main(["add", "evt", "--boot", dir], env), 0, err.join("\n"));

  assert.equal(await main(["event", "evt", "tick", "{\"name\":\"manual\",\"rest\":1}"], env), 1, "a router answers: refused");
  assert.match(err.at(-1)!, /a router serves this host at http:\/\/127\.0\.0\.1:\d+, but no control socket answers/);
  await new Promise<void>((r) => probe.close(() => r()));

  assert.equal(await main(["event", "evt", "tick", "{\"name\":\"manual\",\"rest\":1}"], env), 0, err.join("\n"));
  assert.match(out.at(-1)!, /^evt: cron event admitted into tick as \S+$/);
  assert.ok(out.some((l) => /^\[evt\] \S+ cron-demo step 1 → waiting/.test(l)), "its handler ran, and rests on its deadline");
  assert.equal(await main(["event", "evt", "tick", "[1]"], env), 2, "an event is an object");
  assert.equal(await main(["event", "nope", "tick"], env), 1);

  const { openStoreFile } = await import("../runtime/index-store.ts");
  const s = openStoreFile(join(home, "instances/evt/runtime.db"), { readOnly: true });
  try {
    const evs = await events({ store: s } as never);
    assert.equal(evs.length, 1);
    assert.equal(evs[0]!.box, "tick");
    assert.equal(evs[0]!.ev.kind, "cron");
    assert.equal(evs[0]!.ev.name, "manual");
    assert.equal(typeof evs[0]!.ev.due, "number");
  } finally { s.close(); }
});

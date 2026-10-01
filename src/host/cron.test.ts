// The cron provider (#69, cron.ts): scheduling is a message to a provider.
// On a script clock without a kernel: a tick request's shape and its errors;
// an `every` schedule ticks at once and at its interval (a late tick is one
// tick, never a burst), `at` once and then gone, a name replaced, `stop`; the
// schedules kept (host.db) and taken up again at a host start, an `every`
// one ticking once there. With the real kernel: cron-demo asks the host's
// cron provider (a `local` address-book entry) for ticks, rests on a deadline
// at each and is woken; idle-stopped, it is hydrated for the next tick; a box
// nothing subscribes wakes nothing; stopped. And the same program against a
// remote cron service — the same request to a key its address book reaches
// by `mailbox`, over BRC-103/104 into a second router (src/peers/cron.ts) —
// gets its ticks the same way. And `skein-host event`: one tick-now message
// from the cron provider, refused while a router serves the host with no
// control socket here (control.test.ts: over it).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { RawBox } from "../client/raw.ts";
import { CronPeer } from "../peers/cron.ts";
import { msStamp } from "../runtime/syscalls.ts";
import { ephemeralWallet } from "../wallet.ts";
import { dirSource } from "./boot.ts";
import { main } from "./cli.ts";
import { Cron, cronRequestOf, dbSchedules, tickBody, type Schedule } from "./cron.ts";
import { HostDb } from "./instances.ts";
import { KERNEL_BIN } from "./kernel.ts";
import { fetchHttp } from "./router.ts";
import { testHost, until } from "./testhost.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEMO_WASM = join(ROOT, "programs/cron-demo/cron-demo.wasm");
const skip = !existsSync(KERNEL_BIN) && "kernel-zig not built";
const KEY = "02".padEnd(66, "a");

/** A Cron on a script clock: what it sent, as `instance box name due`. */
function scripted(o: { wake?: boolean; store?: ReturnType<typeof dbSchedules>; t?: number } = {}) {
  const c = { t: o.t ?? 1_000_000, wake: o.wake ?? true };
  const sent: string[] = [];
  const lines: string[] = [];
  const cron = new Cron({
    now: () => c.t, store: o.store,
    tick: async (s, body) => { sent.push(`${s.instance} ${s.box} ${String(body.name)} ${String(body.due)}`); },
    wake: async () => c.wake,
    log: (_s, l) => lines.push(l),
  });
  cron.start();
  return { c, cron, sent, lines };
}

test("cron: a tick request's shape; the tick's body", () => {
  assert.deepEqual(cronRequestOf({ fn: "tick", every: 1000, box: "tick", name: "beat", body: { rest: 5 } }), { fn: "tick", name: "beat", spec: { box: "tick", every: 1000, body: { rest: 5 } } });
  assert.deepEqual(cronRequestOf({ fn: "tick", at: 7, box: "once", name: "x" }), { fn: "tick", name: "x", spec: { box: "once", at: 7 } });
  assert.deepEqual(cronRequestOf({ fn: "stop", name: "beat" }), { fn: "stop", name: "beat" });
  assert.match(String(cronRequestOf({ fn: "tick", box: "x", name: "n" })), /one of every and at/);
  assert.match(String(cronRequestOf({ fn: "tick", every: 0, box: "x", name: "n" })), /positive whole number/);
  assert.match(String(cronRequestOf({ fn: "tick", every: 5, name: "n" })), /box is a box name/);
  assert.match(String(cronRequestOf({ fn: "tick", every: 5, box: ":ack", name: "n" })), /box is a box name/);
  assert.match(String(cronRequestOf({ fn: "tick", every: 5, box: "x" })), /names its schedule/);
  assert.match(String(cronRequestOf({ fn: "tick", at: 5, box: "x", name: "n", body: [1] })), /body is a map/);
  assert.match(String(cronRequestOf({ fn: "wait", name: "n" })), /the cron provider takes/);
  assert.deepEqual(tickBody({ name: "beat", body: { kind: "amm-p2p-timer", job: "heartbeat" } }, 7), { kind: "amm-p2p-timer", job: "heartbeat", name: "beat", due: 7 }, "the body's kind stands");
  assert.deepEqual(tickBody({ name: "x" }, 9), { kind: "cron", name: "x", due: 9 });
});

test("cron: every ticks at once, then at its interval; a late tick is one tick on the grid; at once and gone; a name replaced; stop", async (t) => {
  const s = scripted();
  t.after(() => s.cron.stop());
  const t0 = s.c.t;
  assert.deepEqual(s.cron.request("a", KEY, "req1", { fn: "tick", every: 1000, box: "tick", name: "beat" }), { name: "beat", next: t0 });
  await s.cron.tick();
  assert.deepEqual(s.sent, [`a tick beat ${t0}`], "at once");
  s.c.t += 999;
  await s.cron.tick();
  assert.equal(s.sent.length, 1, "not before its interval");
  s.c.t += 1;
  await s.cron.tick();
  assert.deepEqual(s.sent.slice(1), [`a tick beat ${t0 + 1000}`], "at the interval");
  s.c.t += 5500; // five intervals missed
  await s.cron.tick();
  assert.deepEqual(s.sent.slice(2), [`a tick beat ${t0 + 2000}`], "one tick, however late");
  assert.equal(s.cron.of("a")[0]!.next, t0 + 7000, "the next grid point after now");

  // `at`: once, at its time (past: at once), then gone.
  const at = s.c.t + 300;
  assert.deepEqual(s.cron.request("a", KEY, "req2", { fn: "tick", at, box: "once", name: "later" }), { name: "later", next: at });
  await s.cron.tick();
  assert.equal(s.sent.length, 3);
  s.c.t = at;
  await s.cron.tick();
  assert.deepEqual(s.sent.slice(3), [`a once later ${at}`]);
  assert.deepEqual(s.cron.of("a").map((x) => x.name), ["beat"], "gone once it ticked");

  // The same name again: replaced (a new interval ticks at once); stop ends it; an error is an answer.
  s.cron.request("a", KEY, "req3", { fn: "tick", every: 60_000, box: "tick", name: "beat" });
  assert.deepEqual(s.cron.of("a").map((x) => [x.name, x.every, x.request]), [["beat", 60_000, "req3"]]);
  assert.deepEqual(s.cron.request("a", KEY, "req4", { fn: "stop", name: "beat" }), { name: "beat", stopped: true });
  assert.deepEqual(s.cron.request("a", KEY, "req5", { fn: "stop", name: "beat" }), { name: "beat", stopped: false });
  assert.deepEqual(s.cron.of("a"), []);
  assert.match(String(s.cron.request("a", KEY, "req6", { fn: "tick", box: "x", name: "n" }).error), /one of every and at/);
});

test("cron: the schedules kept in host.db and taken up at a start — an every one ticks once there, an at one at its time; a stopped instance not woken for it", async (t) => {
  const home = await fs.mkdtemp(join(tmpdir(), "skein-cron-db-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const db = new HostDb(join(home, "host.db"));
  t.after(() => db.close());
  const one = scripted({ store: dbSchedules(db) });
  const t0 = one.c.t;
  one.cron.request("a", KEY, "r1", { fn: "tick", every: 60_000, box: "tick", name: "beat", body: { rest: 5 } });
  one.cron.request("a", KEY, "r2", { fn: "tick", at: t0 + 600_000, box: "once", name: "later" });
  await one.cron.tick();
  assert.deepEqual(one.sent, [`a tick beat ${t0}`]);
  await one.cron.stop();
  assert.deepEqual(db.schedules().map((r) => [r.instance, r.name, r.recipient, r.request]), [["a", "beat", KEY, "r1"], ["a", "later", KEY, "r2"]]);

  // A restart 10 s on: beat ticks once at the start, later waits for its time.
  const two = scripted({ store: dbSchedules(db), t: t0 + 10_000 });
  t.after(() => two.cron.stop());
  await two.cron.tick();
  assert.deepEqual(two.sent, [`a tick beat ${t0 + 10_000}`], "a restart is a late tick: once");
  assert.deepEqual((two.cron.of("a").find((x) => x.name === "beat") as Schedule).body, { rest: 5 }, "its body kept");
  two.c.t = t0 + 600_000;
  two.c.wake = false;
  await two.cron.tick();
  assert.deepEqual(two.sent.length, 1, "not woken: nothing sent");
  assert.ok(two.lines.some((l) => /^cron: later \(once at .+\) due: stopped, and nothing in it subscribes once: not woken$/.test(l)), two.lines.join("\n"));
  assert.deepEqual(db.schedules().map((r) => r.name), ["beat"], "the at schedule is done");
});

/**
 * A system tree: cron-demo for the owner's `schedule` box and (sender-less)
 * the `tick` box; the messagebox (its routes, so the owner can send, and the
 * mailbox transport's delivery) and resolve (the owner's `peers` box).
 */
async function cronTree(t: { after(f: () => unknown): void }) {
  const dir = await fs.mkdtemp(join(tmpdir(), "skein-cron-tree-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(join(dir, "bin"));
  await fs.mkdir(join(dir, "etc"));
  await fs.writeFile(join(dir, "bin/cron-demo.wasm"), readFileSync(DEMO_WASM));
  for (const p of ["messagebox", "resolve"]) await fs.writeFile(join(dir, `bin/${p}.wasm`), readFileSync(join(ROOT, `wasm/${p}.wasm`)));
  await fs.writeFile(join(dir, "etc/subscriptions.json"), JSON.stringify([
    { sender: "$owner", box: "schedule", handler: "cron-demo" }, { box: "tick", handler: "cron-demo" },
    { sender: "$owner", box: "peers", handler: "resolve" }, { box: ":ack", handler: "messagebox" },
  ]));
  return dir;
}

type Entry = { prev?: CID; request?: CID; transport?: string };
type Pkg = { kind: string; message?: { box: string; sender: Uint8Array }; body?: Uint8Array };
/** The provider messages (`local` requests) of an instance's log in `box`, oldest first: their bodies. */
async function provided(k: { store: { get(c: CID): Promise<unknown>; log: { tip(): Promise<CID | undefined> } } }, box: string): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (let c = await k.store.log.tip(); c;) {
    const e = await k.store.get(c) as Entry;
    if (e.request && e.transport === "local") {
      const r = await k.store.get(e.request) as Pkg;
      if (r.kind === "message" && r.message?.box === box && r.body) out.unshift(dagCbor.decode(r.body) as Record<string, unknown>);
    }
    c = e.prev;
  }
  return out;
}

test("cron through the router: cron-demo asks the host's cron provider; each tick rests on a deadline and wakes; idle-stopped, hydrated for the next; a box nothing subscribes wakes nothing; stopped", { skip, timeout: 120_000 }, async (t) => {
  let skew = 0;
  const h = await testHost(t, { idleMs: 400, now: () => msStamp(Date.now() + skew) });
  const dir = await cronTree(t);
  const id = h.agent("cronny");
  const d = await dirSource(dir);
  await h.router.bootRow("cronny", { kind: "tree", root: d.root, objects: d.objects });
  await h.router.start();
  const said = (re: RegExp, from = 0) => h.lines.slice(from).some((l) => re.test(l));
  const owner = new RawBox(h.owner, h.origin("cronny"));
  await owner.send(id, "schedule", { name: "beat", every: 60_000, rest: 150 });
  // Two threads come to rest: the schedule's (the provider's answer) and the tick's (woken by the waker).
  await until("the first tick's thread woke", () => h.lines.filter((l) => /^\[cronny\] \S+ cron-demo step 2 → finished/.test(l)).length >= 2 || undefined);
  assert.ok(said(/^\[cronny\] cron: beat \(tick every 60000 ms\) scheduled/), "the provider took the request");
  assert.ok(said(/^\[cronny\] cron: beat \(tick every 60000 ms\) → tick$/), "and ticked at once");
  assert.equal(h.router.cron.of("cronny")[0]!.recipient, id, "the ticks go to the instance that asked");
  const k = (await h.router.hydrate("cronny")).kernel;
  const answers = await provided(k, "cron");
  assert.equal(answers.length, 1);
  assert.equal(answers[0]!.name, "beat");
  const ticks = await provided(k, "tick");
  assert.deepEqual(ticks.map((x) => [x.kind, x.name, x.rest]), [["cron", "beat", 150]]);
  const due0 = ticks[0]!.due as number;
  // Another schedule, into a box nothing subscribes.
  await owner.send(id, "schedule", { name: "idle", every: 60_000, box: "nobody" });
  await until("scheduled idle", () => said(/^\[cronny\] cron: idle \(nobody every 60000 ms\) → nobody$/) || undefined);

  // Idle: stopped (its threads finished, no deadline left).
  await until("idle-stopped", () => !h.router.loaded.has("cronny") || undefined, 20_000);
  const n = h.lines.length;
  skew += 60_000;
  await h.router.cron.tick();
  await until("the second tick's thread woke", () => h.lines.slice(n).filter((l) => /^\[cronny\] \S+ cron-demo step 2 → finished/.test(l)).length >= 1 || undefined);
  assert.ok(said(/^\[router\] hydrated cronny/, n), "hydrated for the tick");
  const later = await provided((await h.router.hydrate("cronny")).kernel, "tick");
  assert.equal(later.at(-1)!.due, due0 + 60_000, "due on the grid");

  // Stopped: no more ticks.
  const m = h.lines.length;
  await owner.send(id, "schedule", { name: "beat", stop: true });
  await until("stopped", () => said(/^\[cronny\] cron: beat stopped$/, m) || undefined);
  await until("the answer", () => said(/^\[cronny\] \S+ cron-demo step 2 → finished/, m) || undefined);
  assert.deepEqual(h.router.cron.of("cronny").map((s) => s.name), ["idle"]);
});

test("cron: a stopped instance with only an unsubscribed box is not woken", { skip, timeout: 120_000 }, async (t) => {
  let skew = 0;
  const h = await testHost(t, { idleMs: 300, now: () => msStamp(Date.now() + skew) });
  const dir = await cronTree(t);
  const id = h.agent("quiet");
  const d = await dirSource(dir);
  await h.router.bootRow("quiet", { kind: "tree", root: d.root, objects: d.objects });
  await h.router.start();
  await new RawBox(h.owner, h.origin("quiet")).send(id, "schedule", { name: "idle", every: 60_000, box: "nobody" });
  await until("scheduled", () => h.lines.some((l) => /^\[quiet\] cron: idle \(nobody every 60000 ms\) → nobody$/.test(l)) || undefined);
  await until("idle-stopped", () => !h.router.loaded.has("quiet") || undefined, 20_000);
  skew += 60_000;
  await h.router.cron.tick();
  assert.ok(h.lines.some((l) => /^\[quiet\] cron: idle \(nobody every 60000 ms\) due: stopped, and nothing in it subscribes nobody: not woken$/.test(l)), h.lines.join("\n"));
  assert.ok(!h.router.loaded.has("quiet"), "still stopped");
});

test("cron, remote: the same program, the cron provider reached by mailbox over BRC-103/104 on a second router; its ticks come back the same way", { skip, timeout: 120_000 }, async (t) => {
  // Host B: the cron service — its mailbox instance (the service's key) and the service reading it.
  const b = await testHost(t);
  const svcKey = PrivateKey.fromRandom(), svc = svcKey.toPublicKey().toString();
  b.mailbox("cronsvc", svc);
  await b.router.start();
  // Host A: the agent, whose http goes out for real (to B).
  const a = await testHost(t, { http: fetchHttp });
  const dir = await cronTree(t);
  const id = a.agent("cronny");
  const d = await dirSource(dir);
  await a.router.bootRow("cronny", { kind: "tree", root: d.root, objects: d.objects });
  await a.router.start();
  const w = ephemeralWallet(svcKey);
  const peer = new CronPeer({
    inbox: new RawBox(w, b.origin("cronsvc")), outbox: (url) => new RawBox(w, url),
    addressOf: (key) => key === id ? a.origin("cronny") : undefined, log: (l) => b.lines.push(`[cronsvc] ${l}`),
  });
  t.after(() => peer.stop());
  peer.start(100);

  // The owner, as admin: the cron provider is the remote service now, by mailbox (the host's own taken out).
  const owner = new RawBox(a.owner, a.origin("cronny"));
  await owner.send(id, "peers", { op: "remove", key: Uint8Array.from(Buffer.from(a.router.providers.key("cron"), "hex")) });
  await owner.send(id, "peers", { op: "add", key: Uint8Array.from(Buffer.from(svc, "hex")), transport: "mailbox", address: b.origin("cronsvc"), role: "cron" });
  await a.router.settled();
  await owner.send(id, "schedule", { name: "beat", every: 60_000, rest: 100 });
  const said = (re: RegExp) => a.lines.some((l) => re.test(l));
  await until("the remote tick's thread woke", () => a.lines.filter((l) => /^\[cronny\] \S+ cron-demo step 2 → finished/.test(l)).length >= 2 || undefined, 60_000);
  assert.ok(said(/^\[cronny\] \S+ cron-demo step 2 → finished/), "the schedule's answer came back (a message from the service's key, replyTo the request)");
  assert.deepEqual(a.router.cron.of("cronny"), [], "the host's own cron provider was not asked");
  assert.deepEqual(peer.cron.of(id).map((s) => [s.name, s.box, s.every]), [["beat", "tick", 60_000]], "the remote service keeps the schedule");
  assert.ok(b.lines.some((l) => /^\[cronsvc\] cron: beat \(tick every 60000 ms\) → tick$/.test(l)), b.lines.filter((l) => l.startsWith("[cronsvc]")).join("\n"));
  assert.ok(said(/^\[cronny\] \S+ cron-demo step 1 → waiting/), "the tick started cron-demo, which rested on its deadline");
});

test("skein-host event: one tick-now message from the cron provider through a router of its own; refused while a router serves the host", { skip, timeout: 120_000 }, async (t) => {
  const home = await fs.mkdtemp(join(tmpdir(), "skein-event-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const probe = createServer((req, res) => { res.writeHead(req.url === "/manifest.json" ? 200 : 404, { "content-type": "application/json" }).end(JSON.stringify({ metanet: {} })); });
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  const vars: Record<string, string | undefined> = { HOME: home, SKEIN_HOME: home, SKEIN_MASTER_KEY: "77".repeat(32), SKEIN_OWNER: PrivateKey.fromRandom().toPublicKey().toString(), SKEIN_ROUTER_PORT: String(port), PATH: process.env.PATH };
  const out: string[] = [], err: string[] = [];
  const env = { vars, out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
  const dir = await cronTree(t);
  assert.equal(await main(["add", "evt", "--boot", dir], env), 0, err.join("\n"));

  assert.equal(await main(["event", "evt", "tick", "{\"name\":\"manual\",\"rest\":1}"], env), 1, "a router answers: refused");
  assert.match(err.at(-1)!, /a router serves this host at http:\/\/127\.0\.0\.1:\d+, but no control socket answers/);
  await new Promise<void>((r) => probe.close(() => r()));

  assert.equal(await main(["event", "evt", "tick", "{\"name\":\"manual\",\"rest\":1}"], env), 0, err.join("\n"));
  assert.match(out.at(-1)!, /^evt: cron from the cron provider into tick as \S+$/);
  assert.ok(out.some((l) => /^\[evt\] \S+ cron-demo step 1 → waiting/.test(l)), "its handler ran, and rests on its deadline");
  assert.equal(await main(["event", "evt", "tick", "[1]"], env), 2, "an event is an object");
  assert.equal(await main(["event", "nope", "tick"], env), 1);

  const { openStoreFile } = await import("../runtime/index-store.ts");
  const s = openStoreFile(join(home, "instances/evt/runtime.db"), { readOnly: true });
  try {
    const evs = await provided({ store: s } as never, "tick");
    assert.equal(evs.length, 1);
    assert.equal(evs[0]!.kind, "cron");
    assert.equal(evs[0]!.name, "manual");
    assert.equal(typeof evs[0]!.due, "number");
  } finally { s.close(); }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryStore } from "./memory.ts";
import { Scheduler } from "./scheduler.ts";
import { shellRunner } from "./runners/shell.ts";
import { field, isSettled, nodesOf, nodeView, tipOf } from "./runners/util.ts";
import { drive, openThread } from "./testkit.ts";
import type { CID } from "multiformats/cid";

function setup(opts: Parameters<typeof shellRunner>[0] = {}) {
  const store = memoryStore();
  const lines: string[] = [];
  const sched = new Scheduler(store, [shellRunner(opts)], { log: (l) => lines.push(l) });
  const settled = (t: CID) => async () => isSettled((await tipOf(store, t))?.state);
  return { store, sched, lines, settled };
}

test("shell: echo hi end to end", async () => {
  const { store, sched, lines, settled } = setup();
  const t = await openThread(store, "shell", { cmd: "echo hi; echo oops >&2" });
  await drive(sched, settled(t));
  const tip = (await tipOf(store, t))!;
  assert.equal(tip.state, "finished");
  assert.equal(tip.note, "exit 0");
  const v = await nodeView(store, tip.resolution!);
  assert.deepEqual(v.origin.request, { cmd: "echo hi; echo oops >&2" });
  const text = v.emits.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");
  assert.match(text, /hi\n/);
  assert.match(text, /oops\n/);
  assert.deepEqual(v.emits.at(-1), { type: "conclusion", text: "exit 0", exitCode: 0, signal: null });
  assert.equal(v.rest?.state, "finished");
  assert.equal(await store.live.handles.get(t), undefined);
  assert.equal(lines.filter((l) => l.includes("→")).length, 2, lines.join("\n")); // new→running, running→finished
});

test("shell: non-zero exit is a finished result, not an error", async () => {
  const { store, sched, settled } = setup();
  const t = await openThread(store, "shell", { cmd: "exit 3" });
  await drive(sched, settled(t));
  const tip = (await tipOf(store, t))!;
  assert.equal(tip.state, "finished");
  const v = await nodeView(store, tip.resolution!);
  assert.equal(field(v.emits.at(-1), "exitCode"), 3);
});

test("shell: timeout and spawn failure are errored blew-up", async () => {
  const { store, sched, settled } = setup({ killGraceMs: 100 });
  const slow = await openThread(store, "shell", { cmd: "sleep 5 | cat", timeoutMs: 100 });
  const bad = await openThread(store, "shell", { cmd: "true", cwd: "/nonexistent/skein" });
  await drive(sched, async () => (await settled(slow)()) && (await settled(bad)()));
  for (const [t, re] of [[slow, /timeout/], [bad, /spawn failed/]] as const) {
    const tip = (await tipOf(store, t))!;
    assert.equal(tip.state, "errored");
    assert.equal(tip.error?.kind, "blew-up");
    assert.match(tip.error!.message, re);
  }
});

test("scheduler: a crashed shell (pid gone, no exit recorded) is marked errored", async () => {
  const { store, sched } = setup();
  const t = await openThread(store, "shell", { cmd: "sleep 100" });
  await store.chains.append(t, { state: "running" });
  await store.live.handles.set(t, { pid: 2 ** 30, startedAt: Date.now() }); // above any pid_max
  await sched.tick();
  const tip = (await tipOf(store, t))!;
  assert.equal(tip.state, "errored");
  assert.equal(tip.error?.kind, "blew-up");
  assert.match(tip.error!.message, /lost: pid/);
  assert.equal(await store.live.handles.get(t), undefined);
});

test("scheduler: a refused start leaves the tip untouched; waiters wake when a dependency settles", async () => {
  const { store, sched } = setup({ maxConcurrent: 0 });
  const t = await openThread(store, "shell", { cmd: "true" });
  await sched.tick();
  assert.ok((await store.chains.tip(t)).equals(t));
  assert.equal((await nodesOf(store, t)).length, 0);

  // A thread waiting on t is re-entered (start) only once t has settled.
  const started: string[] = [];
  const waiter = {
    kind: "probe",
    async start(th: CID) { started.push(`${th} ${(await tipOf(store, t))?.state}`); },
    async check() { return { state: "running" as const }; },
  };
  const s2 = new Scheduler(store, [waiter, shellRunner()], { log: () => {} });
  const w = await openThread(store, "probe", {});
  await store.chains.append(w, { state: "waiting", waitingOn: [t] });
  await drive(s2, () => started.length > 0);
  assert.deepEqual(started, [`${w} finished`]);
});

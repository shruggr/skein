import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryStore } from "../memory.ts";
import { Scheduler } from "../scheduler.ts";
import { davidRunner, resolveDavid } from "./david.ts";
import { nodesOf, nodeView, tipOf } from "./util.ts";
import { collect, drive, openThread } from "../testkit.ts";

test("david: waits with the question in front of him; resolveDavid finishes it", async () => {
  const store = memoryStore();
  const sched = new Scheduler(store, [davidRunner()], { log: () => {} });
  const t = await openThread(store, "david", { say: "Which branch?", page: "# Branches\n- main" });
  await sched.tick();
  await sched.tick(); // idempotent: no second node, no duplicate update
  const tip = (await tipOf(store, t))!;
  assert.equal(tip.state, "waiting");
  assert.equal(tip.waitingOn, undefined);
  assert.equal(tip.seq, 1);
  const [q] = await nodesOf(store, t);
  assert.deepEqual((await nodeView(store, q)).emits, [
    { type: "say", text: "Which branch?" },
    { type: "page", markdown: "# Branches\n- main" },
  ]);
  assert.deepEqual((await collect(store.live.resting({ runner: "david", state: ["waiting"] }))).map(String), [String(t)]);

  const reply = await resolveDavid(store, t, { text: "main", refs: [{ to: "git-raw:abc", rel: "about" }] });
  const done = (await tipOf(store, t))!;
  assert.equal(done.state, "finished");
  assert.ok(done.resolution!.equals(reply));
  const r = await nodeView(store, reply);
  assert.deepEqual(r.origin.prev.map(String), [String(q)]);
  assert.ok(r.origin.refs.some((x) => x.rel === "replies-to" && String(x.to) === String(t)));
  assert.deepEqual(r.emits, [{ type: "conclusion", text: "main" }]);
  await assert.rejects(resolveDavid(store, t, { text: "again" }), /already finished/);
});

test("david: a nudge stays hidden until its time", async () => {
  const store = memoryStore();
  const sched = new Scheduler(store, [davidRunner()], { log: () => {} });
  const until = Date.now() + 80;
  const t = await openThread(store, "david", { say: "stand up and stretch", until });
  await sched.tick();
  assert.equal((await tipOf(store, t))!.until, until);
  assert.equal((await nodesOf(store, t)).length, 0);
  await drive(sched, async () => (await nodesOf(store, t)).length > 0);
  const tip = (await tipOf(store, t))!;
  assert.equal(tip.state, "waiting");
  assert.equal(tip.until, undefined);
});

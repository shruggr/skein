import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryStore } from "./memory.ts";
import { NotFound } from "./store.ts";
import { encode } from "./cid.ts";
import type { CID } from "multiformats/cid";
import type { NodeOrigin, ThreadOrigin, ThreadUpdate } from "./types.ts";
import type { Store } from "./store.ts";
import { collect } from "../testkit.ts";

let at = 0;
const openThread = (s: Store, program: string, args: unknown, launchedBy?: CID) =>
  s.chains.open({ kind: "thread", program: encode({ kind: "program", name: program }).cid, args, ...(launchedBy ? { launchedBy } : {}), at: ++at } satisfies ThreadOrigin);
const openNode = (s: Store, n: Omit<NodeOrigin, "kind" | "at">) => s.chains.open({ kind: "node", ...n, at: ++at } satisfies NodeOrigin);

test("blocks: put is idempotent and content-addressed", async () => {
  const s = memoryStore();
  const a = await s.put({ kind: "x", n: 1 });
  const b = await s.put({ kind: "x", n: 1 });
  assert.ok(a.equals(b));
  assert.equal(a.code, 0x71);
  assert.deepEqual(await s.get(a), { kind: "x", n: 1 });
  await assert.rejects(s.get(await memoryStore().put({ kind: "y" })), NotFound);
  await assert.rejects(s.put({ kind: "x", bad: undefined }), /undefined/);
});

test("chains: append numbers seq, links prev, moves tip; history in order", async () => {
  const s = memoryStore();
  const t = await openThread(s, "shell", { cmd: "true" });
  assert.ok((await s.chains.tip(t)).equals(t));
  const u1 = await s.chains.append(t, { at: 50, state: "running" });
  const u2 = await s.chains.append(t, { at: 50, state: "finished" });
  const b2 = await s.get<ThreadUpdate>(u2);
  assert.equal(b2.seq, 2);
  assert.ok(b2.prev.equals(u1));
  assert.ok(b2.origin.equals(t));
  assert.equal(typeof b2.at, "number");
  assert.ok((await s.chains.tip(t)).equals(u2));
  assert.deepEqual((await collect(s.chains.history(t))).map(String), [t, u1, u2].map(String));
  assert.ok((await s.chains.originOf(u2)).equals(t));
});

test("live + edges: resting, due, waitersOn, refs, rebuild", async () => {
  const s = memoryStore();
  const a = await openThread(s, "shell", { cmd: "a" });
  const b = await openThread(s, "loop", { x: 1 });
  const n = await openNode(s, { thread: b, prev: [], request: "hi", refs: [{ to: "file:///tmp/x", rel: "about" }] });
  const c = await openThread(s, "shell", { cmd: "c" }, n);
  await s.chains.append(b, { at: 50, state: "waiting", waitingOn: [a], until: 5 });
  await s.chains.append(a, { at: 50, state: "finished" });

  const str = (xs: unknown[]) => xs.map(String).sort();
  assert.deepEqual(str(await collect(s.live.resting())), str([b, c]));
  assert.deepEqual(str(await collect(s.live.due(10))), str([b]));
  assert.deepEqual(await collect(s.live.due(1)), []);
  assert.deepEqual(str(await collect(s.live.waitersOn(a))), str([b]));
  assert.deepEqual(str(await collect(s.edges.query({ kind: "node", thread: b }))), str([n]));
  assert.deepEqual(str(await collect(s.edges.query({ kind: "thread", parentless: false }))), str([c]));
  assert.deepEqual(str(await collect(s.edges.query({ state: ["finished"] }))), str([a]));
  assert.ok((await s.edges.refsTo(c)).some((r) => r.rel === "launched" && r.from.equals(n)));
  assert.ok((await s.edges.refsFrom(b)).some((r) => r.rel === "depends-on" && String(r.to) === String(a)));
  assert.deepEqual(await s.edges.refsFrom(n), [{ to: "file:///tmp/x", rel: "about" }, { to: c, rel: "launched" }]);

  await s.edges.rebuild();
  assert.deepEqual(str(await collect(s.live.waitersOn(a))), str([b]));
  assert.deepEqual(str(await collect(s.live.resting())), str([b, c]));
  const next = await s.chains.append(a, { at: 50, state: "dropped" });
  assert.equal((await s.get<ThreadUpdate>(next)).seq, 2);
});

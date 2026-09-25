import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CID, encode, fmt } from "./cid.ts";
import { openStore } from "./sqlite.ts";
import { NotFound, type Store } from "./store.ts";
import type { NodeOrigin, ThreadOrigin, ThreadUpdate } from "./types.ts";

async function all<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}
const strs = (cids: CID[]) => cids.map(fmt);

function thread(runner: string, at: number, launchedBy?: CID): ThreadOrigin {
  return { kind: "thread", runner, spec: { n: at }, ...(launchedBy ? { launchedBy } : {}), at };
}

function withStore(fn: (s: Store) => Promise<void>) {
  return async () => {
    const s = openStore(":memory:");
    try { await fn(s); } finally { await s.close(); }
  };
}

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), "skein-"));
  return { path: join(dir, "skein.db"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("blocks: put is idempotent, get/has, NotFound", withStore(async (s) => {
  const a = await s.put({ kind: "page", markdown: "# hi" });
  const b = await s.put({ markdown: "# hi", kind: "page" });
  assert.ok(a.equals(b));
  assert.deepEqual(await s.get(a), { kind: "page", markdown: "# hi" });
  assert.equal(await s.has(a), true);
  const missing = encode({ kind: "elsewhere" }).cid;
  assert.equal(await s.has(missing), false);
  await assert.rejects(s.get(missing), (e) => e instanceof NotFound && e.cid === fmt(missing));
}));

test("chains: open, append, tip, history, originOf", withStore(async (s) => {
  const o = await s.chains.open(thread("shell", 100));
  assert.ok((await s.chains.tip(o)).equals(o));
  assert.deepEqual(strs(await all(s.chains.history(o))), [fmt(o)]);

  const before = Date.now();
  const u1 = await s.chains.append(o, { state: "running" });
  // Chain fields are the store's; a caller's attempt to set them is ignored.
  const u2 = await s.chains.append(o, { state: "waiting", until: 5, seq: 99, prev: o, at: 1, origin: u1 });
  const u3 = await s.chains.append(o, { state: "finished", note: undefined });

  const b1 = await s.get<ThreadUpdate>(u1);
  const b2 = await s.get<ThreadUpdate>(u2);
  const b3 = await s.get<ThreadUpdate>(u3);
  assert.ok(b1.origin.equals(o) && b1.prev.equals(o) && b1.seq === 1);
  assert.ok(b2.origin.equals(o) && b2.prev.equals(u1) && b2.seq === 2 && b2.until === 5);
  assert.ok(b3.prev.equals(u2) && b3.seq === 3 && !("note" in b3));
  assert.ok(b1.at >= before && b2.at >= b1.at && b3.at >= b2.at);

  assert.ok((await s.chains.tip(o)).equals(u3));
  assert.deepEqual(strs(await all(s.chains.history(o))), strs([o, u1, u2, u3]));
  for (const c of [o, u1, u2, u3]) assert.ok((await s.chains.originOf(c)).equals(o));

  // Re-opening the same origin is a no-op, not a reset.
  assert.ok((await s.chains.open(thread("shell", 100))).equals(o));
  assert.ok((await s.chains.tip(o)).equals(u3));

  const stray = await s.put({ kind: "page" });
  await assert.rejects(s.chains.tip(stray), NotFound);
  await assert.rejects(s.chains.append(stray, { state: "running" }), NotFound);
  await assert.rejects(s.chains.originOf(stray), NotFound);
  await assert.rejects(all(s.chains.history(stray)), NotFound);
}));

test("chains: concurrent appends on one origin get seq 1..n with no gaps", withStore(async (s) => {
  const o = await s.chains.open(thread("loop", 1));
  const n = 50;
  const cids = await Promise.all(Array.from({ length: n }, (_, i) => s.chains.append(o, { state: "running", note: `n${i}` })));
  const seqs = (await Promise.all(cids.map((c) => s.get<ThreadUpdate>(c)))).map((b) => b.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, Array.from({ length: n }, (_, i) => i + 1));
  const hist = await all(s.chains.history(o));
  assert.equal(hist.length, n + 1);
  for (let i = 1; i < hist.length; i++) {
    const b = await s.get<ThreadUpdate>(hist[i]);
    assert.equal(b.seq, i);
    assert.ok(b.prev.equals(hist[i - 1]));
  }
}));

test("chains: two connections to one file interleave without forking", async () => {
  const f = tmpFile();
  const a = openStore(f.path);
  const b = openStore(f.path);
  try {
    const o = await a.chains.open(thread("shell", 1));
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).chains.append(o, { state: "running", note: `${i}` })));
    const hist = await all(b.chains.history(o));
    assert.equal(hist.length, 21);
    for (let i = 1; i < hist.length; i++) assert.equal((await a.get<ThreadUpdate>(hist[i])).seq, i);
  } finally {
    await a.close(); await b.close(); f.done();
  }
});

test("edges.query: filters and newest-first order", withStore(async (s) => {
  const root = await s.chains.open(thread("loop", 100));             // parentless
  const n1 = await s.chains.open({ kind: "node", thread: root, prev: [], request: "go", refs: [], at: 110 } satisfies NodeOrigin);
  const t1 = await s.chains.open(thread("shell", 120, n1));
  const t2 = await s.chains.open(thread("model", 130, n1));
  const n2 = await s.chains.open({ kind: "node", thread: root, prev: [n1], request: "again", refs: [], at: 140 } satisfies NodeOrigin);
  const other = await s.chains.open(thread("david", 150));          // parentless
  await s.chains.append(t1, { state: "finished" });
  await s.chains.append(t2, { state: "running" });
  await s.chains.append(root, { state: "waiting", waitingOn: [t1, t2] });

  const q = async (f: Parameters<Store["edges"]["query"]>[0]) => strs(await all(s.edges.query(f)));
  assert.deepEqual(await q({}), strs([other, n2, t2, t1, n1, root]));
  assert.deepEqual(await q({ kind: "thread" }), strs([other, t2, t1, root]));
  assert.deepEqual(await q({ kind: "node" }), strs([n2, n1]));
  assert.deepEqual(await q({ thread: root }), strs([n2, n1]));
  assert.deepEqual(await q({ runner: "shell" }), strs([t1]));
  assert.deepEqual(await q({ state: ["running", "waiting"] }), strs([t2, root]));
  assert.deepEqual(await q({ state: ["finished"] }), strs([t1]));
  assert.deepEqual(await q({ parentless: true }), strs([other, root]));
  assert.deepEqual(await q({ parentless: false }), strs([t2, t1]));
  assert.deepEqual(await q({ since: 120, before: 140 }), strs([t2, t1]));
  assert.deepEqual(await q({ kind: "thread", limit: 2 }), strs([other, t2]));
  assert.deepEqual(await q({ kind: "thread", parentless: true, since: 101 }), strs([other]));
}));

test("edges: refsFrom / refsTo from node refs, launchedBy and updates", withStore(async (s) => {
  const root = await s.chains.open(thread("loop", 1));
  const asset = await s.put({ kind: "page", markdown: "x" });
  const n = await s.chains.open({
    kind: "node", thread: root, prev: [], request: "r", at: 2,
    refs: [
      { to: asset, rel: "produced" },
      { to: "file:///etc/hosts", rel: "about", locator: "#L1-2" },
    ],
  } satisfies NodeOrigin);
  const t = await s.chains.open(thread("shell", 3, n));
  const res = await s.put({ kind: "result" });
  await s.chains.append(n, { emit: { type: "launched", thread: t } });
  await s.chains.append(n, { rest: { state: "waiting", waitingOn: [t] } });
  await s.chains.append(root, { state: "waiting", waitingOn: [t] });
  await s.chains.append(root, { state: "waiting", waitingOn: [t] }); // repeated pointer collapses
  await s.chains.append(t, { state: "finished", resolution: res });

  const from = await s.edges.refsFrom(n);
  assert.equal(from.length, 4);
  assert.ok(from[0].to instanceof CID && from[0].to.equals(asset) && from[0].rel === "produced" && !("locator" in from[0]));
  assert.deepEqual(from[1], { to: "file:///etc/hosts", rel: "about", locator: "#L1-2" });
  assert.deepEqual(from.slice(2).map((r) => [fmt(r.to as CID), r.rel]), [[fmt(t), "launched"], [fmt(t), "depends-on"]]);

  const tRefs = await s.edges.refsFrom(t);
  assert.deepEqual(tRefs.map((r) => [fmt(r.to as CID), r.rel]), [[fmt(n), "launched-by"], [fmt(res), "resolves"]]);
  assert.deepEqual((await s.edges.refsFrom(root)).map((r) => r.rel), ["depends-on"]);

  const to = (await s.edges.refsTo(t)).map((r) => [fmt(r.from), r.rel]).sort();
  assert.deepEqual(to, [[fmt(n), "depends-on"], [fmt(n), "launched"], [fmt(root), "depends-on"]].sort());
  const toAsset = await s.edges.refsTo(asset);
  assert.equal(toAsset.length, 1);
  assert.ok(toAsset[0].from.equals(n) && (toAsset[0].to as CID).equals(asset));
  assert.deepEqual(await s.edges.refsFrom(asset), []);
}));

test("live: resting, due, waitersOn", withStore(async (s) => {
  const fresh = await s.chains.open(thread("shell", 1));             // no updates yet: resting
  const run = await s.chains.open(thread("shell", 2));
  const done = await s.chains.open(thread("model", 3));
  const nudge = await s.chains.open(thread("david", 4));
  const later = await s.chains.open(thread("david", 5));
  const waiter = await s.chains.open(thread("loop", 6));
  await s.chains.open({ kind: "node", thread: waiter, prev: [], request: "", refs: [], at: 7 } satisfies NodeOrigin);
  await s.chains.append(run, { state: "running" });
  await s.chains.append(done, { state: "running" });
  await s.chains.append(done, { state: "finished" });
  await s.chains.append(nudge, { state: "waiting", until: 1000 });
  await s.chains.append(later, { state: "waiting", until: 2000 });
  await s.chains.append(waiter, { state: "waiting", waitingOn: [run, done] });

  assert.deepEqual(strs(await all(s.live.resting())), strs([fresh, run, nudge, later, waiter]));
  assert.deepEqual(strs(await all(s.live.resting({ runner: "david" }))), strs([nudge, later]));
  assert.deepEqual(strs(await all(s.live.resting({ state: ["running"] }))), strs([run]));
  assert.deepEqual(strs(await all(s.live.resting({ limit: 2 }))), strs([fresh, run]));
  assert.deepEqual(strs(await all(s.live.resting({ state: ["finished"] }))), []);

  assert.deepEqual(strs(await all(s.live.due(999))), []);
  assert.deepEqual(strs(await all(s.live.due(1000))), strs([nudge]));
  assert.deepEqual(strs(await all(s.live.due(5000))), strs([nudge, later]));

  assert.deepEqual(strs(await all(s.live.waitersOn(run))), strs([waiter]));
  assert.deepEqual(strs(await all(s.live.waitersOn(done))), strs([waiter]));
  assert.deepEqual(strs(await all(s.live.waitersOn(nudge))), []);

  // Only the tip counts: once the waiter moves on it stops waiting and stops being due.
  await s.chains.append(waiter, { state: "running" });
  await s.chains.append(nudge, { state: "running" });
  assert.deepEqual(strs(await all(s.live.waitersOn(run))), []);
  assert.deepEqual(strs(await all(s.live.due(5000))), strs([later]));
}));

test("live.handles: set, overwrite, get, clear", withStore(async (s) => {
  const t = await s.chains.open(thread("shell", 1));
  assert.equal(await s.live.handles.get(t), undefined);
  await s.live.handles.set(t, { pid: 1, cmd: "ls" });
  await s.live.handles.set(t, { pid: 2, cmd: "ls -l" });
  assert.deepEqual(await s.live.handles.get(t), { pid: 2, cmd: "ls -l" });
  await s.live.handles.clear(t);
  assert.equal(await s.live.handles.get(t), undefined);
  await s.live.handles.clear(t); // clearing twice is fine
}));

test("edges.rebuild reproduces tips, updates and edges from blocks alone", async () => {
  const f = tmpFile();
  const s = openStore(f.path);
  const raw = new DatabaseSync(f.path);
  const snap = () => ["chains", "updates", "edges"].map((t) =>
    raw.prepare(`SELECT * FROM ${t} ORDER BY 1, 2, 3`).all());
  try {
    const root = await s.chains.open(thread("loop", 10));
    const n = await s.chains.open({
      kind: "node", thread: root, prev: [], request: "r", at: 11,
      refs: [{ to: "git-raw:abc", rel: "about", locator: "#L3" }],
    } satisfies NodeOrigin);
    const t = await s.chains.open(thread("shell", 12, n));
    await s.chains.open(thread("david", 13));                         // never appended to
    const custom = await s.chains.open({ kind: "log", at: 14 });      // non-thread chain with updates
    await s.chains.append(custom, { line: "hello" });
    await s.chains.append(n, { emit: { type: "launched", thread: t } });
    await s.chains.append(n, { rest: { state: "waiting", waitingOn: [t] } });
    await s.chains.append(root, { state: "waiting", waitingOn: [t], until: 99 });
    await s.chains.append(t, { state: "running" });
    await s.chains.append(t, { state: "finished", resolution: n });
    await s.live.handles.set(t, { pid: 7 });
    await s.put({ kind: "page", markdown: "not a chain" });

    const want = snap();
    const tips = await Promise.all([root, n, t, custom].map((c) => s.chains.tip(c)));

    raw.exec("DELETE FROM edges; DELETE FROM updates; DELETE FROM chains;");
    await assert.rejects(s.chains.tip(root), NotFound);
    assert.deepEqual(await all(s.live.resting()), []);

    await s.edges.rebuild();
    assert.deepEqual(snap(), want);
    const again = await Promise.all([root, n, t, custom].map((c) => s.chains.tip(c)));
    assert.deepEqual(strs(again), strs(tips));
    assert.deepEqual(await s.live.handles.get(t), { pid: 7 }); // handles are not part of the index

    await s.edges.rebuild(); // idempotent on an intact index too
    assert.deepEqual(snap(), want);
  } finally {
    raw.close(); await s.close(); f.done();
  }
});

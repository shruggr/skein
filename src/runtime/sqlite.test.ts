import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as Digest from "multiformats/hashes/digest";
import { CID, encode, fmt } from "./cid.ts";
import { rawCid } from "./programs.ts";
import { openStore, type SqliteStore } from "./sqlite.ts";
import { NotFound, type Store } from "./store.ts";
import { GIT_RAW } from "./tree.ts";
import type { NodeOrigin, ThreadOrigin, ThreadUpdate } from "./types.ts";

async function all<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}
const strs = (cids: CID[]) => cids.map(fmt);

const P = (name: string) => encode({ kind: "program", name }).cid;

function thread(program: string, at: number, launchedBy?: CID): ThreadOrigin {
  return { kind: "thread", program: P(program), args: { n: at }, ...(launchedBy ? { launchedBy } : {}), at };
}

function withStore(fn: (s: SqliteStore) => Promise<void>) {
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

  const u1 = await s.chains.append(o, { state: "running", at: 101 });
  // Chain fields are the store's; a caller's attempt to set them is ignored. `at` is the caller's (log time).
  const u2 = await s.chains.append(o, { state: "waiting", until: 5, seq: 99, prev: o, at: 102, origin: u1 });
  const u3 = await s.chains.append(o, { state: "finished", note: undefined, at: 103 });
  await assert.rejects(s.chains.append(o, { state: "running" }), /at/); // no clock in the store

  const b1 = await s.get<ThreadUpdate>(u1);
  const b2 = await s.get<ThreadUpdate>(u2);
  const b3 = await s.get<ThreadUpdate>(u3);
  assert.ok(b1.origin.equals(o) && b1.prev.equals(o) && b1.seq === 1);
  assert.ok(b2.origin.equals(o) && b2.prev.equals(u1) && b2.seq === 2 && b2.until === 5);
  assert.ok(b3.prev.equals(u2) && b3.seq === 3 && !("note" in b3));
  assert.deepEqual([b1.at, b2.at, b3.at], [101, 102, 103]);

  assert.ok((await s.chains.tip(o)).equals(u3));
  assert.deepEqual(strs(await all(s.chains.history(o))), strs([o, u1, u2, u3]));
  for (const c of [o, u1, u2, u3]) assert.ok((await s.chains.originOf(c)).equals(o));

  // Re-opening the same origin is a no-op, not a reset.
  assert.ok((await s.chains.open(thread("shell", 100))).equals(o));
  assert.ok((await s.chains.tip(o)).equals(u3));

  const stray = await s.put({ kind: "page" });
  await assert.rejects(s.chains.tip(stray), NotFound);
  await assert.rejects(s.chains.append(stray, { at: 5000, state: "running" }), NotFound);
  await assert.rejects(s.chains.originOf(stray), NotFound);
  await assert.rejects(all(s.chains.history(stray)), NotFound);
}));

test("chains: concurrent appends on one origin get seq 1..n with no gaps", withStore(async (s) => {
  const o = await s.chains.open(thread("loop", 1));
  const n = 50;
  const cids = await Promise.all(Array.from({ length: n }, (_, i) => s.chains.append(o, { at: 5000, state: "running", note: `n${i}` })));
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
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).chains.append(o, { at: 5000, state: "running", note: `${i}` })));
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
  await s.chains.append(t1, { at: 5000, state: "finished" });
  await s.chains.append(t2, { at: 5000, state: "running" });
  await s.chains.append(root, { at: 5000, state: "waiting", waitingOn: [t1, t2] });

  const q = async (f: Parameters<Store["edges"]["query"]>[0]) => strs(await all(s.edges.query(f)));
  assert.deepEqual(await q({}), strs([other, n2, t2, t1, n1, root]));
  assert.deepEqual(await q({ kind: "thread" }), strs([other, t2, t1, root]));
  assert.deepEqual(await q({ kind: "node" }), strs([n2, n1]));
  assert.deepEqual(await q({ thread: root }), strs([n2, n1]));
  assert.deepEqual(await q({ program: P("shell") }), strs([t1]));
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
  await s.chains.append(n, { at: 5000, emit: { type: "launched", thread: t } });
  await s.chains.append(n, { at: 5000, rest: { state: "waiting", waitingOn: [t] } });
  await s.chains.append(root, { at: 5000, state: "waiting", waitingOn: [t] });
  await s.chains.append(root, { at: 5000, state: "waiting", waitingOn: [t] }); // repeated pointer collapses
  await s.chains.append(t, { at: 5000, state: "finished", resolution: res });

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
  await s.chains.append(run, { at: 5000, state: "running" });
  await s.chains.append(done, { at: 5000, state: "running" });
  await s.chains.append(done, { at: 5000, state: "finished" });
  await s.chains.append(nudge, { at: 5000, state: "waiting", until: 1000 });
  await s.chains.append(later, { at: 5000, state: "waiting", until: 2000 });
  await s.chains.append(waiter, { at: 5000, state: "waiting", waitingOn: [run, done] });

  assert.deepEqual(strs(await all(s.live.resting())), strs([fresh, run, nudge, later, waiter]));
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
  await s.chains.append(waiter, { at: 5000, state: "running" });
  await s.chains.append(nudge, { at: 5000, state: "running" });
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
    await s.chains.append(custom, { at: 5000, line: "hello" });
    await s.chains.append(n, { at: 5000, emit: { type: "launched", thread: t } });
    await s.chains.append(n, { at: 5000, rest: { state: "waiting", waitingOn: [t] } });
    await s.chains.append(root, { at: 5000, state: "waiting", waitingOn: [t], until: 99 });
    await s.chains.append(t, { at: 5000, state: "running" });
    await s.chains.append(t, { at: 5000, state: "finished", resolution: n });
    await s.live.handles.set(t, { pid: 7 });
    await s.put({ kind: "page", markdown: "not a chain" });

    // Raw and git-raw blocks (wasm modules, git blobs/trees) are not dag-cbor
    // and must not be decoded during rebuild.
    const wasm = new Uint8Array([0, 97, 115, 109]);
    const rawBlock = rawCid(wasm);
    await s.putBlock(rawBlock, wasm);
    const gitBytes = Buffer.from("blob 5\0hello");
    const gitBlock = CID.createV1(GIT_RAW, Digest.create(0x11, createHash("sha1").update(gitBytes).digest()));
    await s.putBlock(gitBlock, gitBytes);

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
    assert.deepEqual(await s.bytes(rawBlock), wasm); // raw/git-raw blocks: skipped, not lost
    assert.deepEqual(await s.bytes(gitBlock), new Uint8Array(gitBytes));

    await s.edges.rebuild(); // idempotent on an intact index too
    assert.deepEqual(snap(), want);
  } finally {
    raw.close(); await s.close(); f.done();
  }
});

test("edges.query orderBy tipAt: most recent update first; origins without updates use their own at", withStore(async (s) => {
  const a = await s.chains.open(thread("loop", 100));
  const b = await s.chains.open(thread("loop", 200));
  const c = await s.chains.open(thread("loop", 60_000)); // no updates: tip_at = at, the latest
  await s.chains.append(a, { at: 5000, state: "running" }); // a's tip_at = 5000
  const q = async (f: Parameters<Store["edges"]["query"]>[0]) => strs(await all(s.edges.query(f)));
  assert.deepEqual(await q({ kind: "thread" }), strs([c, b, a]));
  assert.deepEqual(await q({ kind: "thread", orderBy: "tipAt" }), strs([c, a, b]));
  assert.deepEqual(await q({ kind: "thread", orderBy: "at" }), strs([c, b, a]));
}));

test("findByPrefix and bytes", withStore(async (s) => {
  const a = await s.chains.open(thread("loop", 1));
  const b = await s.chains.open(thread("shell", 2));
  const u = await s.chains.append(a, { at: 5000, state: "running" });
  const plain = await s.put({ kind: "page", markdown: "x" });
  assert.deepEqual(strs(await s.findByPrefix(fmt(a))), [fmt(a)]);
  assert.deepEqual(strs(await s.findByPrefix(fmt(b).slice(0, 20))), [fmt(b)]);
  assert.deepEqual(strs(await s.findByPrefix("bafy")).sort(), strs([a, b]).sort()); // origins only
  assert.deepEqual(await s.findByPrefix(fmt(u)), []);
  assert.deepEqual(await s.findByPrefix(fmt(plain)), []);
  assert.deepEqual(await s.findByPrefix("zzz"), []);

  assert.deepEqual(await s.bytes(plain), encode({ kind: "page", markdown: "x" }).bytes);
  await assert.rejects(s.bytes(encode({ nope: 1 }).cid), NotFound);
}));

test("a file from before tip_at is migrated: column added, index rebuilt", async () => {
  const f = tmpFile();
  try {
    const s = openStore(f.path);
    const t = await s.chains.open(thread("loop", 10));
    const u = await s.chains.append(t, { at: 5000, state: "running" });
    await s.close();
    const raw = new DatabaseSync(f.path);
    raw.exec("DROP INDEX chains_tip_at; ALTER TABLE chains DROP COLUMN tip_at;");
    raw.close();
    const again = openStore(f.path);
    const want = (await again.get<ThreadUpdate>(u)).at;
    const raw2 = new DatabaseSync(f.path);
    assert.equal(raw2.prepare("SELECT tip_at FROM chains WHERE origin = ?").get(t.bytes)?.tip_at, want);
    raw2.close();
    assert.deepEqual(strs(await all(again.edges.query({ orderBy: "tipAt" }))), [fmt(t)]);
    await again.close();
  } finally {
    f.done();
  }
});

test("log: one outcome per emit; outcomeOf and byEnvelope each find only their own kind (memory and sqlite)", async () => {
  const { memoryStore } = await import("./memory.ts");
  for (const s of [memoryStore(), openStore(":memory:")] as Store[]) {
    const time: [number, number] = [1, 0];
    const sig = new Uint8Array([1]);
    const env = encode({ env: 1 }).cid, emit = encode({ kind: "emit", n: 1 }).cid;
    const g = await s.log.append({ kind: "log", prev: null, n: 0, time, genesis: encode({ g: 1 }).cid, sig });
    const e1 = await s.log.append({ kind: "log", prev: g, n: 1, time, envelope: env, box: "chat", body: encode({ b: 1 }).cid, sig });
    const o = await s.log.append({ kind: "log", prev: e1, n: 2, time, outcome: { emit, status: "failed", reason: "no account" }, sig });
    await assert.rejects(s.log.append({ kind: "log", prev: o, n: 3, time, outcome: { emit, status: "delivered" }, sig }), (e: Error & { reason?: string }) => e.reason === "duplicate-outcome");
    assert.ok((await s.log.outcomeOf(emit))!.equals(o));
    assert.equal(await s.log.outcomeOf(env), undefined);
    assert.ok((await s.log.byEnvelope(env))!.equals(e1));
    assert.equal(await s.log.byEnvelope(emit), undefined);
    await s.close();
  }
});

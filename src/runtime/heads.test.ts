// Named heads: the chain operations on both stores, then end to end — an
// import sets `main` when there is none, `run` with no tree starts from it, the
// owner moves it explicitly (box `head`), nothing else moves it, and replay
// with no wallet rebuilds the same head chain.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CID } from "multiformats/cid";
import { envelopeCid } from "../client/client.ts";
import { bundlesOf, collect, installWasm, instance, results, send, type Instance } from "../testkit.ts";
import { encode, fmt } from "./cid.ts";
import { advanceHead, headOrigin, headTree, MAIN, type HeadUpdate } from "./heads.ts";
import { copyLog } from "./log.ts";
import { memoryStore } from "./memory.ts";
import { PROGRAM_CIDS } from "./programs.ts";
import { Runtime, witnessFrom } from "./scheduler.ts";
import { EMPTY_TREE } from "./shell.ts";
import { openStore } from "./sqlite.ts";
import type { Store } from "./store.ts";
import type { ThreadOrigin, ThreadUpdate } from "./types.ts";

const text = (b: unknown) => Buffer.from(b as Uint8Array).toString("utf8");
const stores: Array<[string, () => Store]> = [["memory", memoryStore], ["sqlite", () => openStore(":memory:")]];

for (const [name, make] of stores) {
  test(`heads (${name}): none until moved; a move is a chain update; the same tree again writes nothing; the tree must be in the store`, async () => {
    const s = make();
    const tree = await s.put({ kind: "blob", n: 1 }), other = await s.put({ kind: "blob", n: 2 });
    const by = { thread: await s.put({ kind: "blob", n: 3 }), input: await s.put({ kind: "blob", n: 4 }), at: 7 };
    assert.equal(await headTree(s, MAIN), undefined);
    assert.ok(headOrigin(MAIN).equals(encode({ kind: "head", name: "main" }).cid), "the origin is the name's record");

    const u1 = await advanceHead(s, MAIN, tree, by);
    assert.ok((await headTree(s, MAIN))!.equals(tree));
    const r1 = await s.get(u1) as unknown as HeadUpdate;
    assert.deepEqual({ ...r1, origin: fmt(r1.origin), prev: fmt(r1.prev), tree: fmt(r1.tree), thread: fmt(r1.thread), input: fmt(r1.input) },
      { origin: fmt(headOrigin(MAIN)), prev: fmt(headOrigin(MAIN)), seq: 1, tree: fmt(tree), thread: fmt(by.thread), input: fmt(by.input), at: 7 });
    assert.ok((await advanceHead(s, MAIN, tree, { ...by, at: 8 })).equals(u1), "same tree: no new update");
    const u2 = await advanceHead(s, MAIN, other, { ...by, at: 9 });
    assert.ok((await headTree(s, MAIN))!.equals(other));
    assert.deepEqual((await collect(s.chains.history(headOrigin(MAIN)))).map(fmt), [headOrigin(MAIN), u1, u2].map(fmt));
    assert.equal(await headTree(s, "feature"), undefined, "heads are independent");

    await assert.rejects(advanceHead(s, MAIN, encode({ absent: 1 }).cid, by), /not in the store/);
    await assert.rejects(advanceHead(s, "", tree, by), /bad name/);
    await assert.rejects(advanceHead(s, "a b", tree, by), /bad name/);
    assert.ok((await headTree(s, MAIN))!.equals(other), "a refused move leaves the head");
    await s.close();
  });
}

async function dir(t: { after(fn: () => Promise<void>): void }, files: Record<string, string>): Promise<string> {
  const d = await fs.mkdtemp(join(tmpdir(), "skein-heads-"));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  for (const [f, body] of Object.entries(files)) await fs.writeFile(join(d, f), body);
  return d;
}

async function settle(i: Instance) { await i.delivery.poll(); await i.rt.idle(); }

async function importDir(i: Instance, d: string): Promise<CID> {
  const { root, bundles } = await bundlesOf(d);
  for (const b of bundles) await send(i, "objects", b);
  await settle(i);
  return root;
}

/** Run `cmd` (with `tree`, or none) and return the owner's result for it. */
async function run(i: Instance, cmd: string, tree?: CID): Promise<Record<string, unknown>> {
  const env = await send(i, "run", tree ? { cmd, tree } : { cmd });
  await settle(i);
  const cid = await envelopeCid(env);
  const r = (await results(i)).find((x) => (x.body.replyTo as CID).equals(cid));
  assert.ok(r, "a result for the run");
  return r.body;
}

const mainOf = (i: Instance) => headTree(i.store, MAIN);

test("heads: import sets `main` once; run with no tree starts from it; the owner moves it; nothing else does; replay rebuilds it", async (t) => {
  const a = await dir(t, { "a.txt": "alpha\n" });
  const b = await dir(t, { "b.txt": "beta\n" });
  const i = await instance();

  // No main yet: a run with no tree is over the empty tree.
  const empty = await run(i, "ls");
  assert.equal(empty.exitCode, 0, text(empty.stderr));
  assert.ok((empty.tree as CID).equals(EMPTY_TREE));
  assert.equal(await mainOf(i), undefined);

  // The first import becomes main; a second does not move it.
  const ra = await importDir(i, a);
  assert.ok((await mainOf(i))!.equals(ra), "import sets main when the instance has none");
  const rb = await importDir(i, b);
  assert.ok((await mainOf(i))!.equals(ra), "…and only then");

  const r1 = await run(i, "cat *.txt; echo y > more.txt");
  assert.equal(text(r1.stdout), "alpha\n", "no tree: main's");
  assert.ok(!(r1.tree as CID).equals(ra), "the run wrote a new tree…");
  assert.ok((await mainOf(i))!.equals(ra), "…which does not become main");
  assert.equal(text((await run(i, "cat *.txt", rb)).stdout), "beta\n", "a named tree still wins");

  // The owner commits "main is now rb".
  await send(i, "head", { name: "main", tree: rb });
  await settle(i);
  t.diagnostic(i.lines.join("\n"));
  assert.ok((await mainOf(i))!.equals(rb));
  const [h] = await collect(i.store.edges.query({ kind: "thread", program: PROGRAM_CIDS["head-handler"] }));
  const [u] = await collect(i.store.chains.history(h)).then((cs) => Promise.all(cs.slice(1).map((c) => i.store.get(c)))) as Array<ThreadUpdate & { calls?: CID[]; heads: CID[] }>;
  assert.equal(u.state, "finished");
  const origin = await i.store.get<ThreadOrigin>(h);
  const body = await i.store.get((origin.args as { body: CID }).body) as Record<string, unknown>;
  assert.deepEqual([body.name, String(body.tree)], ["main", String(rb)], "the handler read the plaintext request from the entry");
  assert.equal(u.calls, undefined, "no wallet call");
  const move = await i.store.get(u.heads[0]) as unknown as HeadUpdate;
  assert.ok(move.tree.equals(rb) && move.thread.equals(h) && move.origin.equals(headOrigin(MAIN)), "the step lists the head update it wrote, which names the step's thread");
  assert.equal(text((await run(i, "cat *.txt")).stdout), "beta\n", "no tree: the new main");

  // A head can only name a tree the instance holds: the step errors, main stays.
  await send(i, "head", { name: "main", tree: encode({ absent: 1 }).cid });
  await settle(i);
  assert.ok((await mainOf(i))!.equals(rb));
  const last = (await collect(i.store.edges.query({ kind: "thread", program: PROGRAM_CIDS["head-handler"] })))[0];
  const tip = await i.store.get<ThreadUpdate>(await i.store.chains.tip(last));
  assert.equal(tip.state, "errored");
  assert.match(tip.error!.message, /not in the store/);

  // Replay: the log alone, no wallet; every thread and the head chain come back identical.
  await i.rt.stop();
  const fresh = memoryStore();
  await installWasm(fresh);
  await copyLog(i.store, fresh);
  const rt = new Runtime({ store: fresh, witness: await witnessFrom(i.store), outbox: { send: () => {} } });
  await rt.start();
  await rt.idle();
  for (const th of await collect(i.store.edges.query({ kind: "thread" }))) assert.ok((await fresh.chains.tip(th)).equals(await i.store.chains.tip(th)), `thread ${fmt(th)}`);
  assert.ok((await fresh.chains.tip(headOrigin(MAIN))).equals(await i.store.chains.tip(headOrigin(MAIN))), "the head chain replays to the same tip");
  await rt.stop();
});

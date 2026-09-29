// Named heads: the chain operations on a store (heads.ts). The kernel's own
// heads are tested with it (kernel-zig/src/heads.zig; kernel-zig/equiv).

import { test } from "node:test";
import assert from "node:assert/strict";
import { collect } from "../testkit.ts";
import { encode, fmt } from "./cid.ts";
import { advanceHead, headOrigin, headTree, MAIN, type HeadUpdate } from "./heads.ts";
import { openStore } from "./sqlite.ts";

test("heads: none until moved; a move is a chain update; the same tree again writes nothing; the tree must be in the store", async () => {
  const s = openStore(":memory:");
  const tree = await s.put({ kind: "blob", n: 1 }), other = await s.put({ kind: "blob", n: 2 });
  const by = { thread: await s.put({ kind: "blob", n: 3 }), input: await s.put({ kind: "blob", n: 4 }), at: 7 };
  assert.equal(await headTree(s, MAIN), undefined);
  assert.ok(headOrigin(MAIN).equals(encode({ kind: "head", name: "main" }).cid), "the origin is the name's record");

  const u1 = await advanceHead(s, MAIN, tree, by);
  assert.ok((await headTree(s, MAIN))!.equals(tree));
  const r1 = await s.get(u1) as unknown as HeadUpdate;
  assert.deepEqual({ ...r1, origin: fmt(r1.origin), prev: fmt(r1.prev), tree: fmt(r1.tree), thread: fmt(r1.thread!), input: fmt(r1.input) },
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

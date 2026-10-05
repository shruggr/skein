// Named heads, read (heads.ts): the kernel writes them (kernel-zig/src/heads.zig;
// kernel-zig/equiv); here a chain in the kernel's shape is read back.

import { test } from "node:test";
import assert from "node:assert/strict";
import { encode } from "./cid.ts";
import { headOrigin, headTree, MAIN, type HeadOrigin } from "./heads.ts";
import { openStore } from "./sqlite.ts";

test("heads: none until moved; the tree the chain's tip names; heads are independent; a bad name refused", async () => {
  const s = openStore(":memory:");
  const tree = await s.put({ kind: "blob", n: 1 }), other = await s.put({ kind: "blob", n: 2 });
  const by = { thread: null, input: await s.put({ kind: "blob", n: 4 }), at: 7 };
  assert.equal(await headTree(s, MAIN), undefined);
  assert.ok(headOrigin(MAIN).equals(encode({ kind: "head", name: "main" }).cid), "the origin is the name's record");

  // Updates as heads.zig writes them: {tree, owner, thread, input, at}.
  const origin = await s.chains.open({ kind: "head", name: MAIN } satisfies HeadOrigin);
  await s.chains.append(origin, { tree, owner: "main", ...by });
  assert.ok((await headTree(s, MAIN))!.equals(tree));
  await s.chains.append(origin, { tree: other, owner: "main", ...by, at: 9 });
  assert.ok((await headTree(s, MAIN))!.equals(other), "the tip's tree");
  assert.equal(await headTree(s, "feature"), undefined, "heads are independent");

  assert.throws(() => headOrigin(""), /bad name/);
  assert.throws(() => headOrigin("a b"), /bad name/);
  await s.close();
});

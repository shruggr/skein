// 0.9.1: a step's line on the wasm kernel (the one production runs) carries its time and its fuel.
// (skein next: the deadline import and the waker are gone, SPEC 5; their test with them.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { imageTree, NEXT_APP, testHost } from "./testhost.ts";

test("0.9.1: a step's line on the wasm kernel carries its time and its fuel", { timeout: 120_000 }, async (t) => {
  const h = await testHost(t);
  await h.instance("w", await imageTree(join(h.home, "img"), { apps: [NEXT_APP] }));
  await h.router.start();
  await h.request("w", "POST", "/next/user", {});
  await h.router.settled();
  const line = h.lines.find((l) => /^\[w\] \S+ next step 1 → /.test(l));
  assert.match(line ?? "", /^\[w\] \S+ next step 1 → finished · \d+\.\d ms · fuel [1-9]\d*$/, h.lines.filter((l) => l.startsWith("[w]")).join("\n"));
});

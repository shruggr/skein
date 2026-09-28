// The overlay routes' request parsing (#36); the routes end to end are kernel-zig/equiv/overlay.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTopics } from "./overlay.ts";

test("X-Topics: the SDK's comma list and the JSON array", () => {
  assert.deepEqual(parseTopics("tm_a,tm_b"), ["tm_a", "tm_b"]);
  assert.deepEqual(parseTopics(" tm_a , tm_b "), ["tm_a", "tm_b"]);
  assert.deepEqual(parseTopics('["tm_a","tm_b"]'), ["tm_a", "tm_b"]);
  assert.throws(() => parseTopics("tm_a,,tm_b"));
  assert.throws(() => parseTopics("[1]"));
});

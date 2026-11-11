import { test } from "node:test";
import assert from "node:assert/strict";
import { lineWriter, stampLines } from "./stamp.ts";

test("stampLines: an ISO UTC stamp before each line of a chunk", () => {
  const at = new Date("2026-11-11T10:22:33.123Z");
  assert.equal(stampLines("[router] up", at), "2026-11-11T10:22:33.123Z [router] up");
  assert.equal(stampLines("Error: x\n    at y", at), "2026-11-11T10:22:33.123Z Error: x\n2026-11-11T10:22:33.123Z     at y");
  assert.match(lineWriter(true)("a"), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z a$/);
  assert.equal(lineWriter(false)("a"), "a");
});

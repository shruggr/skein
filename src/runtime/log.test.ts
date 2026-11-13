// The log entry's shape (skein next) (log.ts isLogEntry, as kernel-zig/src/log.zig
// has it), and nextEntry over a store's tip.

import { test } from "node:test";
import assert from "node:assert/strict";
import { encode } from "./cid.ts";
import { isLogEntry, nextEntry } from "./log.ts";
import { openStore } from "./sqlite.ts";

const cid = encode({ kind: "blob" }).cid;
const base = { kind: "log", prev: null, n: 0, time: [1, 2] };

test("isLogEntry (skein next, SPEC 2): one of genesis | request (+door) | event+name (+door)", () => {
  for (const ok of [{ genesis: cid }, { request: cid, door: { checks: [] } }, { event: cid, name: "chain", door: { checks: [] } }]) assert.ok(isLogEntry({ ...base, ...ok }), JSON.stringify(Object.keys(ok)));
  for (const bad of [
    {}, { genesis: cid, request: cid }, { event: cid }, { event: cid, name: "" }, { genesis: cid, name: "x" },
    { request: "not a cid" },
  ]) assert.ok(!isLogEntry({ ...base, ...bad }), JSON.stringify(bad, (_k, v) => v?.["/"] ? "cid" : v));
  assert.ok(!isLogEntry({ ...base, kind: "entry", genesis: cid }) && !isLogEntry({ ...base, n: "0", genesis: cid }) && !isLogEntry(null));
});

test("nextEntry: the first entry of an empty store", async () => {
  const s = openStore(":memory:");
  const e0 = await nextEntry(s, { genesis: cid }, [5, 0]);
  assert.deepEqual({ ...e0, genesis: String((e0 as { genesis: unknown }).genesis) }, { kind: "log", prev: null, n: 0, time: [5, 0], genesis: String(cid) });
  assert.ok(isLogEntry(e0));
  await s.close();
});

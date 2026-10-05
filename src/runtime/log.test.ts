// The log entry's shape in format 8 (log.ts isLogEntry, as kernel-zig/src/log.zig
// has it), and nextEntry over a store's tip.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as dagCbor from "@ipld/dag-cbor";
import { encode } from "./cid.ts";
import { isLogEntry, nextEntry } from "./log.ts";
import { openStore } from "./sqlite.ts";

const cid = encode({ kind: "blob" }).cid;
const base = { kind: "log", prev: null, n: 0, time: [1, 2] };

test("isLogEntry: format 8 — one of genesis | mail | event+box | request+transport; no older fields", () => {
  for (const ok of [{ genesis: cid }, { mail: cid }, { event: cid, box: "chain" }, { request: cid, transport: "http" }]) assert.ok(isLogEntry({ ...base, ...ok }), JSON.stringify(Object.keys(ok)));
  for (const bad of [
    {}, { genesis: cid, mail: cid }, { event: cid }, { event: cid, box: "" }, { mail: cid, box: "x" },
    { request: cid }, { request: cid, transport: "" }, { genesis: cid, transport: "http" },
    { genesis: cid, sig: new Uint8Array(70) }, { wake: cid }, { envelope: cid, box: "b", body: cid }, { outcome: { emit: cid, status: "delivered" } },
    { mail: "not a cid" },
  ]) assert.ok(!isLogEntry({ ...base, ...bad }), JSON.stringify(bad, (_k, v) => v instanceof Uint8Array ? "bytes" : v?.["/"] ? "cid" : v));
  assert.ok(!isLogEntry({ ...base, kind: "entry", genesis: cid }) && !isLogEntry({ ...base, n: "0", genesis: cid }) && !isLogEntry(null));
  // The kernel's vectors (kernel-zig/test/format2.json): an unsigned entry passes, a signed one is refused.
  const f = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../kernel-zig/test/format2.json"), "utf8")) as { entry: string; entrySigned: string };
  assert.ok(isLogEntry(dagCbor.decode(Buffer.from(f.entry, "hex"))));
  assert.ok(!isLogEntry(dagCbor.decode(Buffer.from(f.entrySigned, "hex"))));
});

test("nextEntry: the first entry of an empty store", async () => {
  const s = openStore(":memory:");
  const e0 = await nextEntry(s, { genesis: cid }, [5, 0]);
  assert.deepEqual({ ...e0, genesis: String((e0 as { genesis: unknown }).genesis) }, { kind: "log", prev: null, n: 0, time: [5, 0], genesis: String(cid) });
  assert.ok(isLogEntry(e0));
  await s.close();
});

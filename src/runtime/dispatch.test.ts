// The route table's fold and match against the cases dispatch.zig is
// checked against (kernel-zig/test/dispatch-cases.json, #115, #143): the
// same table and package give the same route in both.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CID } from "multiformats/cid";
import { fold, forEvent, forHttp, forLibp2p, forMail, isFilterRef, rowKey, type DispatchRow, type Op } from "./dispatch.ts";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const f = JSON.parse(readFileSync(new URL("../../kernel-zig/test/dispatch-cases.json", import.meta.url), "utf8")) as {
  keys: Record<string, string>; cid: string;
  tables: Array<{ name: string; updates: Json[]; fold: string[]; cases: Array<Record<string, any>> }>;
};

/** A fixture value as the kernel holds it: "$<name>" a key, "$cid" the CID. */
function value(j: Json): unknown {
  if (typeof j === "string") {
    if (j === "$cid") return CID.parse(f.cid);
    if (j.startsWith("$") && f.keys[j.slice(1)]) return Uint8Array.from(Buffer.from(f.keys[j.slice(1)]!, "hex"));
    return j;
  }
  if (Array.isArray(j)) return j.map(value);
  if (j && typeof j === "object") return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, value(v)]));
  return j;
}

const id = (m: { row: DispatchRow } | undefined): string | null => m ? m.row.id as string : null;

for (const t of f.tables) {
  test(`dispatch: ${t.name}`, () => {
    const rows = fold(t.updates.map(value) as Array<{ op: Op; row: DispatchRow }>);
    assert.deepEqual(rows.map((r) => r.id), t.fold, "fold");
    t.cases.forEach((c, i) => {
      let got: unknown;
      if (c.kind === "mail") got = id(forMail(rows, c.box));
      else if (c.kind === "event") got = id(forEvent(rows, c.box));
      else if (c.kind === "http") got = id(forHttp(rows, c.path));
      else if (c.kind === "libp2p") got = id(forLibp2p(rows, c.name));
      else throw new Error(`case ${i}: kind ${c.kind}`);
      assert.deepEqual(got, c.want, `case ${i} (${c.kind} ${c.path ?? c.box ?? c.name})`);
    });
  });
}

test("dispatch: a route's key text separates the exact \"/x\" from the prefix \"/x\" (no address has a space); a filter's name is the kernel's or <app>.<filter>", () => {
  const p = CID.parse(f.cid);
  assert.notEqual(rowKey({ transport: "http", address: "/x" }), rowKey({ transport: "http", address: "/x", prefix: true }));
  assert.equal(rowKey({ transport: "http", address: "/x", prefix: true }), rowKey({ transport: "http", address: "/x", prefix: true, program: p } as DispatchRow));
  for (const ok of ["kernel.brc104", "kernel.beef", "amm.quote", "site.get"]) assert.ok(isFilterRef(ok), ok);
  for (const no of ["kernel.nope", "beef", ".x", "a/b.c", "x."]) assert.ok(!isFilterRef(no), no);
});

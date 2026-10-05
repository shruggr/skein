// The dispatch table's fold and match against the cases dispatch.zig is
// checked against (kernel-zig/test/dispatch-cases.json, #115): the same
// table and package give the same row, or the same refusal, in both.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CID } from "multiformats/cid";
import { fold, forEvent, forHttp, forLibp2p, forMail, rowKey, type DispatchRow, type Op, type Who } from "./dispatch.ts";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const f = JSON.parse(readFileSync(new URL("../../kernel-zig/test/dispatch-cases.json", import.meta.url), "utf8")) as {
  keys: Record<string, string>; cid: string;
  tables: Array<{ name: string; reads?: Json; updates: Json[]; fold: string[]; cases: Array<Record<string, any>> }>;
};

/** A fixture value as the kernel holds it: "$<name>" a key, "$cid" the CID, "$bytes32" 32 bytes. */
function value(j: Json): unknown {
  if (typeof j === "string") {
    if (j === "$cid") return CID.parse(f.cid);
    if (j === "$bytes32") return new Uint8Array(32);
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
    const reads = t.reads === undefined ? undefined : value(t.reads) as Who["reads"];
    t.cases.forEach((c, i) => {
      const who: Who = { ...(c.who?.key ? { key: f.keys[c.who.key] } : {}), ...(reads ? { reads } : {}) };
      let got: unknown;
      if (c.kind === "mail") got = id(forMail(rows, f.keys[c.sender]!, c.box));
      else if (c.kind === "event") got = id(forEvent(rows, c.box));
      else if (c.kind === "http") { const m = forHttp(rows, c.path, who); got = "refused" in m ? { refused: m.refused } : id(m); }
      else if (c.kind === "libp2p") got = id(forLibp2p(rows, c.name, who));
      else throw new Error(`case ${i}: kind ${c.kind}`);
      assert.deepEqual(got, c.want, `case ${i} (${c.kind} ${c.path ?? c.box ?? c.name})`);
    });
  });
}

test("dispatch: a row's key text separates an exact \"/x*\" from the prefix \"/x\" (K5)", () => {
  const p = CID.parse(f.cid);
  assert.notEqual(rowKey({ transport: "http", address: "/x*", sender: "*" }), rowKey({ transport: "http", address: "/x", prefix: true, sender: "*" }));
  assert.equal(rowKey({ transport: "http", address: "/x", prefix: true, sender: "*" }), rowKey({ transport: "http", address: "/x", prefix: true, sender: "*", program: p } as DispatchRow));
});

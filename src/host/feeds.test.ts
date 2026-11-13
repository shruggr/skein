// feeds.ts without a kernel (skein next, SPEC 8: the header feeds are gone): the status record
// Arcade's JSON becomes (with the transaction's CID); a tree's config naming `feeds` is refused.

import { test } from "node:test";
import assert from "node:assert/strict";
import { statusOf, txCid } from "./feeds.ts";

test("feeds: Arcade's status record", () => {
  const txid = "aa".repeat(31) + "01";
  const s = statusOf({ txid, txStatus: "MINED", merklePath: "fe01", blockHeight: 103 }) as Record<string, unknown>;
  assert.ok((s.subject as ReturnType<typeof txCid>).equals(txCid(txid)));
  assert.equal(txCid(txid).code, 0xb1);
  assert.deepEqual([...(s.merklePath as Uint8Array)], [0xfe, 0x01]);
  assert.equal(s.txStatus, "MINED");
  assert.equal(statusOf({ txStatus: "MINED" }), "no txid");
});

test("feeds (skein next, SPEC 8): an instance declares no header source — a system's etc/config.json `feeds` is refused, a genesis carries none; no session default", async () => {
  const { resolveSystem, genesisRecord } = await import("./genesis.ts");
  const k = "02" + "11".repeat(32);
  const { checkConfig } = await import("./genesis.ts");
  const c = { identity: k, handle: "w", domain: "localhost" };
  assert.throws(() => checkConfig({ feeds: [{ kind: "headers", url: "http://ct.test/sse" }] }), /`feeds` gone/);
  const g = genesisRecord(c, resolveSystem(c, {}, []));
  assert.equal(g.feeds, undefined);
  assert.equal((g.defaults as Record<string, string>).sessionTtlMs, undefined, "no session settings (SPEC 3)");
});

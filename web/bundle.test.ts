// Import bundling: ≤1 MiB envelopes, blobs first, the root tree last, every object once.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BUNDLE_LIMIT, chunk, decodeBundle } from "../src/client/bundle.ts";
import { hashFiles, importOrder } from "./tree.ts";

const kind = (b: Uint8Array) => new TextDecoder().decode(b.subarray(0, 5));

test("a directory bundles into ≤1 MiB envelopes in import order", async () => {
  // 40 files of ~100 KiB (random-ish, distinct) over 5 directories: ~4 MiB of blobs.
  const files = Array.from({ length: 40 }, (_, i) => ({
    path: `d${i % 5}/f${i}.bin`,
    bytes: Uint8Array.from({ length: 100_000 }, (_, j) => (j * (i + 7) + i) & 0xff),
  }));
  files.push({ path: "big.bin", bytes: new Uint8Array(BUNDLE_LIMIT + 10).fill(1) }); // alone, oversized
  const { root, records } = await hashFiles(files);
  const ordered = importOrder(root, records);
  const bundles = [...chunk(ordered)];
  assert.ok(bundles.length >= 5, `${bundles.length} bundles`);
  const back = bundles.flatMap(decodeBundle);
  // Every record exactly once, in order.
  assert.deepEqual(back.map((r) => r.cid.toString()), ordered.map((r) => r.cid.toString()));
  assert.equal(new Set(back.map((r) => r.cid.toString())).size, records.length);
  for (const b of bundles) {
    const rs = decodeBundle(b);
    if (rs.length > 1) assert.ok(b.length <= BUNDLE_LIMIT, `bundle of ${rs.length} is ${b.length} bytes`);
    else assert.ok(rs[0]!.bytes.length > BUNDLE_LIMIT - 64 || b.length <= BUNDLE_LIMIT);
  }
  // Blobs, then trees, the root tree last.
  const kinds = back.map((r) => kind(r.bytes));
  assert.equal(kinds.lastIndexOf("blob "), kinds.filter((k) => k === "blob ").length - 1);
  assert.equal(back.at(-1)!.cid.toString(), root.toString());
  assert.equal(kinds.filter((k) => k === "tree ").length, 6); // root + d0..d4
});

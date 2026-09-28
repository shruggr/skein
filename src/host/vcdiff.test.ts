// The ordfs/patch vcdiff decoder against deltas an independent encoder made
// (go-deltasync/vcdiff, what 1sat-stack's gateway uses; vcdiff.vectors.txt:
// source hex, target hex, delta hex per line), and the minimal encoder here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { vcdiffDecode, vcdiffEncode, VcdiffError } from "./vcdiff.ts";

const hex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
const vectors = readFileSync(new URL("./vcdiff.vectors.txt", import.meta.url), "utf8").trim().split("\n").map((l) => l.split(" ").map(hex) as [Uint8Array, Uint8Array, Uint8Array]);

test("vcdiff: decodes go-deltasync's deltas (copy from source, add, copy within the target)", () => {
  assert.equal(vectors.length, 3);
  for (const [src, target, delta] of vectors) assert.deepEqual(vcdiffDecode(delta, src), target);
});

test("vcdiff: the minimal encoder round-trips; refusals", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  for (const [s, t] of [["hello world", "hello there"], ["", "fresh"], ["base", ""], ["same", "same"], ["abcXdef", "abcYYdef"]] as const) {
    assert.deepEqual(vcdiffDecode(vcdiffEncode(enc(t), enc(s)), enc(s)), enc(t), `${s} → ${t}`);
  }
  assert.throws(() => vcdiffDecode(enc("not a delta")), VcdiffError);
  const [src, , delta] = vectors[1]!;
  assert.throws(() => vcdiffDecode(delta.subarray(0, delta.length - 3), src), VcdiffError, "truncated");
  const secondary = Uint8Array.from(delta); secondary[4] = 1;
  assert.throws(() => vcdiffDecode(secondary, src), /secondary compression/);
  assert.throws(() => vcdiffDecode(delta, src.subarray(0, 10)), /out of range/, "a shorter base than the delta was made against");
});

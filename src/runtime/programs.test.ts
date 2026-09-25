import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { MODULES, rawCid } from "./programs.ts";

test("programs: the pinned module CIDs are the committed wasm files", async () => {
  for (const [name, cid] of Object.entries(MODULES)) {
    assert.ok(rawCid(await readFile(new URL(`../../wasm/${name}.wasm`, import.meta.url))).equals(cid), `${name}.wasm`);
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { FILES, MODULES, moduleFile, rawCid } from "./programs.ts";

test("programs: the pinned module CIDs are the committed wasm files", async () => {
  for (const [name, cid] of Object.entries(MODULES)) {
    assert.ok(rawCid(await readFile(new URL(`../../wasm/${moduleFile(name)}`, import.meta.url))).equals(cid), `${name}.wasm`);
  }
  for (const [name, cid] of Object.entries(FILES)) {
    assert.ok(rawCid(await readFile(new URL(`../../wasm/${name}`, import.meta.url))).equals(cid), name);
  }
});

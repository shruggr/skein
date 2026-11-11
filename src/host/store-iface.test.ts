// The browser build's storage interface (the JS shim behind kernel-zig/src/web_store.zig): its two
// implementations answer the same script with the same bytes — kernel-zig/web/kernel.js MemoryStore
// (under the IndexedDB store, web/store.js) and src/host/store-sqlite.ts SqliteSetStore (the wasm
// host's set of its one SQLite database). The native backends are compared once in
// kernel-zig/src/store_iface_test.zig; nothing else compares stores.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { MemoryStore } from "../../kernel-zig/web/kernel.js";
import { openHostDb, SqliteSetStore } from "./store-sqlite.ts";

interface Shim {
  getBlock(cid: Uint8Array): Uint8Array | undefined;
  hasBlock(cid: Uint8Array): boolean;
  putBlock(cid: Uint8Array, bytes: Uint8Array): boolean;
  getPointer(name: string): Uint8Array | undefined;
  setPointer(name: string, cid: Uint8Array): boolean;
  begin(): void;
  commit(): boolean;
  rollback(): void;
}

async function block(s: string): Promise<{ cid: Uint8Array; bytes: Uint8Array }> {
  const bytes = dagCbor.encode(s);
  return { cid: CID.createV1(dagCbor.code, await sha256.digest(bytes)).bytes, bytes };
}

/** The script; `reopen` gives the store again as a restart would. Its transcript. */
async function script(open: () => Shim, reopen: () => Shim): Promise<string[]> {
  const out: string[] = [];
  const hex = (v: Uint8Array | undefined) => (v ? Buffer.from(v).toString("hex") : "none");
  const [x, y, z] = await Promise.all(["x: committed outside a batch", "y: in a batch rolled back", "z: in a batch committed"].map(block));
  let s = open();
  out.push(`get x before = ${hex(s.getBlock(x!.cid))}`, `has x before = ${s.hasBlock(x!.cid)}`, `pointer p before = ${hex(s.getPointer("p"))}`);
  s.putBlock(x!.cid, x!.bytes);
  s.putBlock(x!.cid, x!.bytes);
  out.push(`get x = ${hex(s.getBlock(x!.cid))}`, `has x = ${s.hasBlock(x!.cid)}`);
  s.setPointer("p", x!.cid);
  out.push(`pointer p = ${hex(s.getPointer("p"))}`);
  s.begin();
  s.putBlock(y!.cid, y!.bytes);
  s.setPointer("p", y!.cid);
  s.setPointer("q", y!.cid);
  out.push(`in batch: get y = ${hex(s.getBlock(y!.cid))}`, `in batch: has y = ${s.hasBlock(y!.cid)}`, `in batch: pointer p = ${hex(s.getPointer("p"))}`);
  s.rollback();
  out.push(`rolled back: get y = ${hex(s.getBlock(y!.cid))}`, `rolled back: has y = ${s.hasBlock(y!.cid)}`, `rolled back: pointer p = ${hex(s.getPointer("p"))}`, `rolled back: pointer q = ${hex(s.getPointer("q"))}`);
  s.begin();
  s.putBlock(z!.cid, z!.bytes);
  s.putBlock(z!.cid, z!.bytes);
  s.setPointer("p", z!.cid);
  s.commit();
  out.push(`committed: get z = ${hex(s.getBlock(z!.cid))}`, `committed: pointer p = ${hex(s.getPointer("p"))}`);
  s = reopen();
  for (const [n, b] of [["x", x!], ["y", y!], ["z", z!]] as const) out.push(`reopened: get ${n} = ${hex(s.getBlock(b.cid))}`, `reopened: has ${n} = ${s.hasBlock(b.cid)}`);
  out.push(`reopened: pointer p = ${hex(s.getPointer("p"))}`, `reopened: pointer q = ${hex(s.getPointer("q"))}`);
  return out;
}

test("the shim's storage interface: MemoryStore and the wasm host's SqliteSetStore answer the same script with the same bytes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "skein-store-iface-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const mem = new MemoryStore() as unknown as Shim;
  const memory = await script(() => mem, () => mem);
  const path = join(dir, "store.sqlite");
  let db = openHostDb(path);
  const sqlite = await script(() => new SqliteSetStore(db, "iface"), () => { db.close(); db = openHostDb(path); return new SqliteSetStore(db, "iface"); });
  db.close();
  assert.deepEqual(sqlite, memory);
  assert.ok(memory.some((l) => l.startsWith("reopened: get z = ") && !l.endsWith("none")), "the script reads what it wrote");
  assert.ok(memory.includes("reopened: get y = none"), "nothing of the rollback");
});

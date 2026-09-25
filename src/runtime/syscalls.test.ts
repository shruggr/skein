import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { encode } from "./cid.ts";
import { MODULES, rawCid } from "./programs.ts";
import { Bindings, isBind, seedStream } from "./syscalls.ts";

test("programs: the pinned module CIDs are the committed wasm files", async () => {
  for (const [name, cid] of Object.entries(MODULES)) {
    assert.ok(rawCid(await readFile(new URL(`../../wasm/${name}.wasm`, import.meta.url))).equals(cid), `${name}.wasm`);
  }
});

test("syscalls: the seed stream is a pure function of seed and read order, not of read sizes", () => {
  const seed = new Uint8Array(32).fill(3);
  const a = seedStream(seed), b = seedStream(seed);
  const whole = a(100);
  const parts = Buffer.concat([b(1), b(31), b(33), b(35)]);
  assert.deepEqual(Buffer.from(whole), parts);
  assert.notDeepEqual(Buffer.from(seedStream(new Uint8Array(32).fill(4))(100)), Buffer.from(whole));
});

test("syscalls: bindings are the defaults until an admin bind, from its log position on", () => {
  const clock = "02" + "a".repeat(64), other = "03" + "b".repeat(64);
  const b = new Bindings({ clock });
  assert.deepEqual(b.at(0, "clock_time_get"), { kind: "peer", to: clock });
  assert.deepEqual(b.at(0, "clock_time_get:monotonic"), { kind: "pure" });
  const bind = { kind: "bind", syscall: "clock_time_get", to: other } as const;
  assert.ok(isBind(bind));
  assert.ok(!isBind({ kind: "bind", syscall: "fd_write", to: other }));
  b.apply(10, bind);
  b.apply(12, { kind: "bind", syscall: "random_get", to: { bundle: encode({ kind: "bundle" }).cid } });
  assert.deepEqual(b.at(9, "clock_time_get"), { kind: "peer", to: clock });
  assert.deepEqual(b.at(10, "clock_time_get"), { kind: "peer", to: other });
  assert.equal(b.at(12, "random_get").kind, "bundle");
  assert.equal(b.at(11, "random_get").kind, "peer");
});

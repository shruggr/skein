import { test } from "node:test";
import assert from "node:assert/strict";
import * as dagCbor from "@ipld/dag-cbor";
import { sha256 } from "multiformats/hashes/sha2";
import { CID, decode, encode, fmt, fromBytes, isCID, parse } from "./cid.ts";

test("cid matches the multiformats reference path (sync sha256 is the same hash)", async () => {
  const value = { kind: "thread", runner: "shell", spec: { cmd: "ls" }, at: 1 };
  const bytes = dagCbor.encode(value);
  const ref = CID.createV1(dagCbor.code, await sha256.digest(bytes));
  const { cid, bytes: ours } = encode(value);
  assert.ok(cid.equals(ref));
  assert.deepEqual(ours, bytes);
  assert.equal(cid.version, 1);
  assert.equal(cid.code, 0x71);
  assert.equal(cid.multihash.code, 0x12);
});

test("encoding is canonical: key order does not change the cid", () => {
  assert.ok(encode({ a: 1, b: 2 }).cid.equals(encode({ b: 2, a: 1 }).cid));
  assert.ok(!encode({ a: 1 }).cid.equals(encode({ a: 2 }).cid));
});

test("links and bytes round-trip", () => {
  const link = encode({ x: 1 }).cid;
  const value = { link, list: [link], raw: new Uint8Array([1, 2, 3]), nested: { n: null } };
  const back = decode<typeof value>(encode(value).bytes);
  assert.ok(isCID(back.link) && back.link.equals(link));
  assert.ok(back.list[0].equals(link));
  assert.deepEqual(back.raw, new Uint8Array([1, 2, 3]));
  assert.equal(back.nested.n, null);
});

test("undefined properties are dropped, not encoded", () => {
  assert.ok(encode({ a: 1, b: undefined, c: { d: undefined } }).cid.equals(encode({ a: 1, c: {} }).cid));
  assert.throws(() => encode({ a: [undefined] }));
});

test("fmt/parse round-trip as base32 and binary", () => {
  const { cid } = encode({ hello: "world" });
  const s = fmt(cid);
  assert.match(s, /^bafy[a-z2-7]+$/);
  assert.ok(parse(s).equals(cid));
  assert.ok(fromBytes(cid.bytes).equals(cid));
  assert.throws(() => parse("not-a-cid"));
});

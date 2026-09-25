// CID helpers. Blocks are dag-cbor, hashed sha2-256, identified by CIDv1.
// Everything here is synchronous on purpose: the store encodes inside its
// write transactions, and an await there would let appends interleave.

import { createHash } from "node:crypto";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";

export { CID };

const SHA2_256 = 0x12;

/** Encode a value as a dag-cbor block. Undefined properties are dropped (not an IPLD type). */
export function encode(value: unknown): { cid: CID; bytes: Uint8Array } {
  const bytes = dagCbor.encode(strip(value));
  const digest = Digest.create(SHA2_256, createHash("sha256").update(bytes).digest());
  return { cid: CID.createV1(dagCbor.code, digest), bytes };
}

export function decode<T = unknown>(bytes: Uint8Array): T {
  return dagCbor.decode(bytes) as T;
}

/** Accepts any multibase the CID parser knows; base32 (`bafy…`) is what we emit. */
export function parse(s: string): CID {
  return CID.parse(s);
}

export function fmt(cid: CID): string {
  return cid.toString();
}

/** CID from its binary form (how the index stores them). */
export function fromBytes(bytes: Uint8Array): CID {
  return CID.decode(bytes);
}

export function isCID(x: unknown): x is CID {
  return CID.asCID(x) !== null;
}

// Callers build update bodies with optional fields left undefined; dag-cbor
// rejects undefined outright. Only plain objects are rewritten — CIDs, bytes
// and arrays pass through (undefined inside an array is still an error).
function strip(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(strip);
  if (CID.asCID(v) || ArrayBuffer.isView(v)) return v;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = strip(x);
  return out;
}

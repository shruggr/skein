// Records into ≤1 MiB dag-cbor bundles: { records: [{ cid, bytes }] }. A record
// that alone exceeds the limit travels alone in an oversized bundle (the
// messagebox takes up to its body limit; 1sat serve: 30 MB of JSON).

import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";

export const BUNDLE_LIMIT = 1 << 20;
export interface Rec { cid: CID; bytes: Uint8Array }

// dag-cbor overhead per record: map header, two keys, a tag-42 CID (<=~45 bytes) and a byte-string header.
const PER_RECORD = 64;
const HEADER = 16;

export function* chunk(records: Iterable<Rec>, limit = BUNDLE_LIMIT): Generator<Uint8Array> {
  let batch: Rec[] = [];
  let size = HEADER;
  for (const r of records) {
    const n = r.bytes.length + PER_RECORD;
    if (batch.length && size + n > limit) {
      yield encodeBundle(batch);
      batch = [];
      size = HEADER;
    }
    batch.push(r);
    size += n;
  }
  if (batch.length) yield encodeBundle(batch);
}

export function encodeBundle(records: Rec[]): Uint8Array {
  return dagCbor.encode({ records: records.map((r) => ({ cid: r.cid, bytes: r.bytes })) });
}

export function decodeBundle(bytes: Uint8Array): Rec[] {
  const v = dagCbor.decode(bytes) as { records?: Rec[] };
  if (!v || !Array.isArray(v.records)) throw new Error("not a bundle");
  return v.records;
}

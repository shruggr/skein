// Records into ≤1 MiB dag-cbor bundles: { records: [{ cid, bytes }], root? }; `root`
// (the imported tree) rides on the last bundle only. A record
// that alone exceeds the limit travels alone in an oversized bundle (the
// messagebox takes up to its body limit; 1sat serve: 30 MB of JSON).

import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { scan, type ScanOptions } from "../dev/scan.ts";
import type { TreeBlocks } from "../runtime/tree.ts";

export const BUNDLE_LIMIT = 1 << 20;
export interface Rec { cid: CID; bytes: Uint8Array }

// dag-cbor overhead per record: map header, two keys, a tag-42 CID (<=~45 bytes) and a byte-string header.
const PER_RECORD = 64;
const HEADER = 16;

export function* chunk(records: Iterable<Rec>, limit = BUNDLE_LIMIT, root?: CID): Generator<Uint8Array> {
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
  if (batch.length) yield encodeBundle(batch, root);
}

export function encodeBundle(records: Rec[], root?: CID): Uint8Array {
  return dagCbor.encode({ records: records.map((r) => ({ cid: r.cid, bytes: r.bytes })), ...(root && { root }) });
}

export function decodeBundle(bytes: Uint8Array): Rec[] {
  const v = dagCbor.decode(bytes) as { records?: Rec[] };
  if (!v || !Array.isArray(v.records)) throw new Error("not a bundle");
  return v.records;
}

/** A directory as git objects held in memory: [root, records]. `opts.ignore` as scan's. */
export async function hashDir(dir: string, opts: ScanOptions = {}): Promise<{ root: CID; records: Rec[] }> {
  const m = new Map<string, Rec>();
  const blocks: TreeBlocks = {
    has: async (cid) => m.has(cid.toString()),
    bytes: async (cid) => { const r = m.get(cid.toString()); if (!r) throw new Error(`missing ${cid}`); return r.bytes; },
    putBlock: async (cid, bytes) => { m.set(cid.toString(), { cid, bytes }); },
  };
  const root = await scan(blocks, dir, opts);
  return { root, records: [...m.values()] };
}

/**
 * Records of the tree `root` as the kernel's `objects` operation takes them: ≤ 1 MiB bundles, blobs
 * before trees and the root tree last (a receiver storing in order never holds a tree whose children
 * have not arrived), the last bundle naming the root. `skip` drops records the receiver has; if it has
 * the root tree it has everything, and nothing is sent.
 */
export async function recordBundles(root: CID, all: Rec[], o: { limit?: number; skip?: (cid: CID) => Promise<boolean> } = {}): Promise<{ root: CID; records: number; bundles: Uint8Array[] }> {
  const rootKey = root.toString();
  const records: Rec[] = [];
  if (!(await o.skip?.(root))) for (const r of all) if (r.cid.toString() === rootKey || !(await o.skip?.(r.cid))) records.push(r);
  const rank = (r: Rec) => (r.cid.toString() === rootKey ? 2 : new TextDecoder().decode(r.bytes.subarray(0, 5)) === "tree " ? 1 : 0);
  records.sort((a, b) => rank(a) - rank(b));
  return { root, records: records.length, bundles: [...chunk(records, o.limit, root)] };
}

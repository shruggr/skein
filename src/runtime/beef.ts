// The BEEF pointer record (#121), read on the host's side: the exact wire
// bytes back from the record the kernel's door wrote and the blocks it names
// (kernel-zig/src/beef.zig `encode`; skein-sdk `chain.record.beefOf` for
// programs). The door is lossless for anything a signature covers: a reader
// of the log puts the bytes back and re-checks the signature over them.
//
//   {kind: "beef", form: "beef" | "atomic" | "outpoint", version: 1 | 2,
//    subject: <bitcoin-tx CID>, vout?, txs: [<bitcoin-tx CID>], marks: [<bump index> | null | "txid"],
//    bumps: [{height, path: <raw CID: the BUMP as received>, block: <bitcoin-block CID> | null, proves: [<tx index>]}]}

import { CID } from "multiformats/cid";

export interface BeefRecord {
  kind: "beef";
  form: "beef" | "atomic" | "outpoint";
  version: 1 | 2;
  subject: CID;
  vout?: number;
  txs: CID[];
  marks: Array<number | null | "txid">;
  bumps: Array<{ height: number; path: CID; block: CID | null; proves: number[] }>;
}

export function isBeefRecord(x: unknown): x is BeefRecord {
  const r = x as Partial<BeefRecord> | null;
  return !!r && typeof r === "object" && r.kind === "beef" && Array.isArray(r.txs) && Array.isArray(r.marks) && Array.isArray(r.bumps);
}

const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };

function varint(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) { const b = new Uint8Array(3); b[0] = 0xfd; new DataView(b.buffer).setUint16(1, n, true); return b; }
  if (n <= 0xffffffff) { const b = new Uint8Array(5); b[0] = 0xfe; new DataView(b.buffer).setUint32(1, n, true); return b; }
  const b = new Uint8Array(9); b[0] = 0xff; new DataView(b.buffer).setBigUint64(1, BigInt(n), true); return b;
}

/** A bitcoin CID's hash (the txid in internal byte order). */
const hashOf = (c: CID): Uint8Array => c.multihash.digest;

/** The wire bytes a pointer record stands for; `bytes` reads a block (a transaction, a BUMP's bytes). */
export async function beefOf(r: BeefRecord, bytes: (cid: CID) => Promise<Uint8Array>): Promise<Uint8Array> {
  const out: Uint8Array[] = [];
  if (r.form === "atomic" || r.form === "outpoint") {
    out.push(r.form === "atomic" ? Uint8Array.of(1, 1, 1, 1) : Uint8Array.of(0x16, 0xa7, 0xbe, 0xef), hashOf(CID.asCID(r.subject)!));
    if (r.form === "outpoint") out.push(u32(r.vout ?? 0));
  }
  out.push(Uint8Array.of(r.version, 0, 0xbe, 0xef), varint(r.bumps.length));
  for (const b of r.bumps) out.push(await bytes(CID.asCID(b.path)!));
  out.push(varint(r.txs.length));
  for (const [i, t] of r.txs.entries()) {
    const m = r.marks[i];
    const c = CID.asCID(t)!;
    if (m === "txid") { out.push(Uint8Array.of(2), hashOf(c)); continue; }
    const raw = await bytes(c);
    if (r.version === 1) out.push(raw, ...(m === null ? [Uint8Array.of(0)] : [Uint8Array.of(1), varint(m)]));
    else out.push(...(m === null ? [Uint8Array.of(0)] : [Uint8Array.of(1), varint(m)]), raw);
  }
  const n = out.reduce((s, x) => s + x.length, 0);
  const all = new Uint8Array(n);
  let at = 0;
  for (const x of out) { all.set(x, at); at += x.length; }
  return all;
}

// The BEEF envelope and pointer record (#121, #146), read on the host's side:
// the exact wire bytes back from what the kernel's door wrote — the envelope
// where the bytes were, the pointer record it links, and the blocks that names
// (kernel-zig/src/beef.zig `wire`; skein-sdk `chain.record.wireOf` for
// programs). The door is lossless for anything a signature covers: a reader
// of the log puts the bytes back and re-checks the signature over them.
//
// The envelope is not BEEF (#146): it sits where the bytes were, beside the
// link to the pointer record, which is the BEEF alone (two envelopes over the
// same BEEF share one record).
//
//   envelope  {form: "beef" | "atomic" | "outpoint" | "subject", beef: <pointer record CID>,
//              subject?: <bitcoin-tx CID> (an enveloped form's; a bare BEEF's subject is its last
//              transaction), vout?: <an Outpoint BEEF's output>}
//   record    {kind: "beef", version: 1 | 2, txs: [<bitcoin-tx CID>], marks: [<bump index> | null | "txid"],
//              bumps: [{height, path: <raw CID: the BUMP as received>, block: <bitcoin-block CID> | null, proves: [<tx index>]}]}
//
// The forms' prefixes: Atomic BEEF (BRC-95) 01 01 01 01 ‖ txid; Outpoint BEEF
// (BRC-158) 16 a7 be ef ‖ txid ‖ vout (u32 LE); Subject BEEF (BRC-233)
// 57 09 be ef ‖ txid, its BEEF a V2 only.

import { CID } from "multiformats/cid";

export type BeefForm = "beef" | "atomic" | "outpoint" | "subject";

export interface BeefEnvelope {
  form: BeefForm;
  beef: CID;
  subject?: CID;
  vout?: number;
}

export interface BeefRecord {
  kind: "beef";
  version: 1 | 2;
  txs: CID[];
  marks: Array<number | null | "txid">;
  bumps: Array<{ height: number; path: CID; block: CID | null; proves: number[] }>;
}

const FORMS: readonly BeefForm[] = ["beef", "atomic", "outpoint", "subject"];

export function isBeefRecord(x: unknown): x is BeefRecord {
  const r = x as Partial<BeefRecord> | null;
  return !!r && typeof r === "object" && r.kind === "beef" && Array.isArray(r.txs) && Array.isArray(r.marks) && Array.isArray(r.bumps);
}

export function isBeefEnvelope(x: unknown): x is BeefEnvelope {
  const e = x as Partial<BeefEnvelope> | null;
  return !!e && typeof e === "object" && FORMS.includes(e.form as BeefForm) && CID.asCID(e.beef) !== null;
}

/** The transaction a BEEF is about: an enveloped form's subject, else the record's last transaction. */
export function subjectOf(e: BeefEnvelope, r: BeefRecord): CID | undefined {
  return e.subject ?? r.txs[r.txs.length - 1];
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

const PREFIX: Record<Exclude<BeefForm, "beef">, Uint8Array> = {
  atomic: Uint8Array.of(1, 1, 1, 1),
  outpoint: Uint8Array.of(0x16, 0xa7, 0xbe, 0xef),
  subject: Uint8Array.of(0x57, 0x09, 0xbe, 0xef),
};

const concat = (out: Uint8Array[]): Uint8Array => {
  const all = new Uint8Array(out.reduce((s, x) => s + x.length, 0));
  let at = 0;
  for (const x of out) { all.set(x, at); at += x.length; }
  return all;
};

/** The BEEF a pointer record stands for (no envelope); `bytes` reads a block (a transaction, a BUMP's bytes). */
export async function beefOf(r: BeefRecord, bytes: (cid: CID) => Promise<Uint8Array>): Promise<Uint8Array> {
  const out: Uint8Array[] = [Uint8Array.of(r.version, 0, 0xbe, 0xef), varint(r.bumps.length)];
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
  return concat(out);
}

/** The wire bytes an envelope stands for: its prefix, then the BEEF its record stands for. */
export async function wireOf(e: BeefEnvelope, r: BeefRecord, bytes: (cid: CID) => Promise<Uint8Array>): Promise<Uint8Array> {
  const inner = await beefOf(r, bytes);
  if (e.form === "beef") return inner;
  if (e.form === "subject" && r.version !== 2) throw new Error("a Subject BEEF (BRC-233) carries a BEEF V2 only");
  if (!e.subject) throw new Error(`a ${e.form} envelope names no subject`);
  const out = [PREFIX[e.form], hashOf(CID.asCID(e.subject)!)];
  if (e.form === "outpoint") out.push(u32(e.vout ?? 0));
  out.push(inner);
  return concat(out);
}

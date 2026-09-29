// Bitcoin blocks decoded the IPLD way (issue #42) — the TypeScript twin of
// kernel-zig/src/bitcoin.zig, for the readers (the explorer, packets, the
// index derivation in index-store.ts). All dbl-sha2-256, the hash in internal
// byte order:
//
//   bitcoin-block (0xb0), an 80-byte header:
//     {version, previousblockhash → link(bitcoin-block) | null (genesis),
//      merkleroot → link(bitcoin-tx), time, bits, nonce}
//   bitcoin-tx (0xb1), a transaction:
//     {version, vin: [{txid → link(bitcoin-tx), vout, script, sequence} | {coinbase, sequence}],
//      vout: [{value, script}], locktime}
//   bitcoin-tx (0xb1), exactly 64 bytes: a merkle tree node [left → link, right → link]
//     (IPLD's convention: a 64-byte transaction is malformed by convention, so
//     64 bytes always reads as a node)
//
// Forward links (`bitcoinLinks`, what packets and the explorer follow):
// inputs → the spent txid, rel `spends`, locator = vout (a coinbase input
// links nothing); header → `prev`, `merkleroot`; merkle node → `child`,
// locator 0 / 1. Edges (`bitcoinEdges`, what a kept block contributes to the
// index, index.zig; #42 decided 2026-09-30): a transaction's inputs only —
// headers and merkle nodes contribute none.

import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";

export const BITCOIN_BLOCK = 0xb0, BITCOIN_TX = 0xb1, DBL_SHA2_256 = 0x56;

export const hashCid = (code: number, h: Uint8Array) => CID.createV1(code, Digest.create(DBL_SHA2_256, Uint8Array.from(h)));
export const displayHash = (h: Uint8Array) => Buffer.from(h).reverse().toString("hex");
export const isBitcoin = (c: CID) => (c.code === BITCOIN_BLOCK || c.code === BITCOIN_TX) && c.multihash.code === DBL_SHA2_256;

const isNull = (h: Uint8Array) => h.every((b) => b === 0);

export interface Input { prev: Uint8Array; vout: number; script: Uint8Array; sequence: number }
export interface Output { value: bigint; script: Uint8Array }
export interface Tx { version: number; inputs: Input[]; outputs: Output[]; locktime: number }

/** A transaction's standard serialization (no segwit: BSV); throws when malformed. */
export function parseTx(b: Uint8Array): Tx {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 0;
  const need = (n: number) => { if (n > b.length - i) throw new Error("malformed transaction"); };
  const u32 = () => { need(4); const v = dv.getUint32(i, true); i += 4; return v; };
  const u64 = () => { need(8); const v = dv.getBigUint64(i, true); i += 8; return v; };
  const varint = (): number => {
    need(1);
    const f = b[i++];
    if (f === 0xfd) { need(2); const v = dv.getUint16(i, true); i += 2; return v; }
    if (f === 0xfe) return u32();
    if (f === 0xff) return Number(u64());
    return f;
  };
  const bytes = () => { const n = varint(); need(n); const v = b.subarray(i, i + n); i += n; return v; };
  const take = (n: number) => { need(n); const v = b.subarray(i, i + n); i += n; return v; };
  const version = u32() | 0;
  const nin = varint();
  if (nin > (b.length - i) / 41) throw new Error("malformed transaction");
  const inputs: Input[] = [];
  for (let k = 0; k < nin; k++) inputs.push({ prev: take(32), vout: u32(), script: bytes(), sequence: u32() });
  const nout = varint();
  if (nout > (b.length - i) / 9) throw new Error("malformed transaction");
  const outputs: Output[] = [];
  for (let k = 0; k < nout; k++) outputs.push({ value: u64(), script: bytes() });
  const locktime = u32();
  if (i !== b.length) throw new Error("malformed transaction");
  return { version, inputs, outputs, locktime };
}

const isCoinbase = (x: Input) => x.vout === 0xffffffff && isNull(x.prev);

/** The typed node for a bitcoin block's bytes; undefined when it is not one (or does not decode). */
export function decodeBitcoin(cid: CID, b: Uint8Array): unknown {
  if (!isBitcoin(cid)) return undefined;
  if (cid.code === BITCOIN_BLOCK) {
    if (b.length !== 80) return undefined;
    const dv = new DataView(b.buffer, b.byteOffset, 80);
    return {
      version: dv.getInt32(0, true),
      previousblockhash: isNull(b.subarray(4, 36)) ? null : hashCid(BITCOIN_BLOCK, b.subarray(4, 36)),
      merkleroot: hashCid(BITCOIN_TX, b.subarray(36, 68)),
      time: dv.getUint32(68, true),
      bits: dv.getUint32(72, true),
      nonce: dv.getUint32(76, true),
    };
  }
  if (b.length === 64) return [hashCid(BITCOIN_TX, b.subarray(0, 32)), hashCid(BITCOIN_TX, b.subarray(32, 64))];
  let tx: Tx;
  try { tx = parseTx(b); } catch { return undefined; }
  return {
    version: tx.version,
    vin: tx.inputs.map((x) => isCoinbase(x) ? { coinbase: x.script, sequence: x.sequence } : { txid: hashCid(BITCOIN_TX, x.prev), vout: x.vout, script: x.script, sequence: x.sequence }),
    vout: tx.outputs.map((o) => ({ value: Number(o.value), script: o.script })),
    locktime: tx.locktime,
  };
}

export interface BitcoinLink { to: CID; rel: string; locator: number | null }

/** The links a bitcoin block holds, in order (kernel-zig/src/bitcoin.zig `links`); none when it is not one or does not decode. */
export function bitcoinLinks(cid: CID, b: Uint8Array): BitcoinLink[] {
  if (!isBitcoin(cid)) return [];
  if (cid.code === BITCOIN_BLOCK) {
    if (b.length !== 80) return [];
    const out: BitcoinLink[] = [];
    if (!isNull(b.subarray(4, 36))) out.push({ to: hashCid(BITCOIN_BLOCK, b.subarray(4, 36)), rel: "prev", locator: null });
    out.push({ to: hashCid(BITCOIN_TX, b.subarray(36, 68)), rel: "merkleroot", locator: null });
    return out;
  }
  if (b.length === 64) return [0, 1].map((k) => ({ to: hashCid(BITCOIN_TX, b.subarray(32 * k, 32 * k + 32)), rel: "child", locator: k }));
  try {
    return parseTx(b).inputs.filter((x) => !isCoinbase(x)).map((x) => ({ to: hashCid(BITCOIN_TX, x.prev), rel: "spends", locator: x.vout }));
  } catch { return []; }
}

/** The edges a kept bitcoin block contributes (kernel-zig/src/bitcoin.zig `edgesOf`): a transaction's `spends` links; none for a header or a merkle node. */
export function bitcoinEdges(cid: CID, b: Uint8Array): BitcoinLink[] {
  if (!isBitcoin(cid) || cid.code !== BITCOIN_TX || b.length === 64) return [];
  return bitcoinLinks(cid, b);
}

/** What a bitcoin block is, for display. */
export function bitcoinKind(cid: CID, b: Uint8Array): "header" | "merkle node" | "transaction" | undefined {
  if (!isBitcoin(cid)) return undefined;
  if (cid.code === BITCOIN_BLOCK) return b.length === 80 ? "header" : undefined;
  return b.length === 64 ? "merkle node" : "transaction";
}

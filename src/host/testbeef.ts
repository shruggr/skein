// A BEEF whose BUMP checks, and the chain state it checks against (#121, #164): block 170's header,
// its spend (the first person-to-person transaction) and a BUMP proving it beside the coinbase —
// kernel-zig/src/door_test.zig's fixture, for the TS tests and equiv drivers. `chainState170` is the
// chain app's record shape ({kind: "chain-state", maps: {headers: <MST root>}}, the MST height (u32
// big-endian) → the header), one header, as blocks to put (root's `objects`, or the store directly)
// and the record to point the head `chain/state` at.

import { createHash } from "node:crypto";
import type { CID } from "multiformats/cid";
import { BITCOIN_BLOCK, BITCOIN_TX, hashCid } from "../runtime/bitcoin.ts";
import { encode } from "../runtime/cid.ts";

const unhex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const sha256d = (b: Uint8Array) => Uint8Array.from(createHash("sha256").update(createHash("sha256").update(b).digest()).digest());

export const HEIGHT_170 = 170;
export const HEADER_170 = unhex("0100000055bd840a78798ad0da853f68974f3d183e2bd1db6a842c1feecf222a00000000ff104ccb05421ab93e63f8c3ce5c2c2e9dbb37de2764b3a3175c8166562cac7d51b96a49ffff001d283e9e70");
export const TX_170 = unhex("0100000001c997a5e56e104102fa209c6a852dd90660a20b2d9c352423edce25857fcd3704000000004847304402204e45e16932b8af514961a1d3a1a25fdf3f4f7732e9d624c6c61548ab5fb8cd410220181522ec8eca07de4860a4acdd12909d831cc56cbbac4622082221a8768d1d0901ffffffff0200ca9a3b00000000434104ae1a62fe09c5f51b13905f07f06b99a2f7159b2225f374cd378d71302fa28414e7aab37397f554a7df5f142c21c1b7303b8a0626f1baded5c72a704f7e6cd84cac00286bee0000000043410411db93e1dcdb8a016b49840f8c53bc1eb68a382e97b1482ecad7b148a6909a5cb2e0eaddfb84ccf9744464f82e160bfa9b8b64f9d4c03f999b8643f656b412a3ac00000000");
const COINBASE_170 = unhex("82501c1178fa0b222c1f3d474ec726b832013f0a532b44bb620cce8624a5feb1");

/** The transaction's `bitcoin-tx` block CID (its txid). */
export const TX_170_CID: CID = hashCid(BITCOIN_TX, sha256d(TX_170));

/**
 * BEEF V1 of TX_170 with its BUMP (height 170, two leaves: the coinbase, the transaction). `bad`: one
 * byte of the coinbase's hash flipped, so the BUMP's merkle root is not the header's.
 */
export function beef170(o: { bad?: boolean } = {}): Uint8Array {
  const cb = Uint8Array.from(COINBASE_170);
  if (o.bad) cb[0]! ^= 0xff;
  const bump = [0xaa, 1, 2, 0, 0, ...cb, 1, 2, ...sha256d(TX_170)];
  return Uint8Array.from([1, 0, 0xbe, 0xef, 1, ...bump, 1, ...TX_170, 1, 0]);
}

/** The chain state holding block 170's header: its blocks (the header, the MST node, the record) and the record's CID. */
export function chainState170(): { blocks: Array<{ cid: CID; bytes: Uint8Array }>; state: CID } {
  const header = { cid: hashCid(BITCOIN_BLOCK, sha256d(HEADER_170)), bytes: HEADER_170 };
  const key = new Uint8Array(4);
  new DataView(key.buffer).setUint32(0, HEIGHT_170);
  const node = encode([null, [[key, header.cid, null]]]);
  const state = encode({ kind: "chain-state", network: "main", maps: { headers: node.cid } });
  return { blocks: [header, { cid: node.cid, bytes: node.bytes }, { cid: state.cid, bytes: state.bytes }], state: state.cid };
}

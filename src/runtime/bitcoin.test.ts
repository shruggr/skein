// bitcoin.ts: the typed decode and the links (issue #42), on mainnet vectors
// (the same as kernel-zig/src/bitcoin.zig's tests).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CID } from "multiformats/cid";
import { BITCOIN_BLOCK, BITCOIN_TX, bitcoinLinks, decodeBitcoin, displayHash, hashCid } from "./bitcoin.ts";

const dbl = (b: Uint8Array) => createHash("sha256").update(createHash("sha256").update(b).digest()).digest();
const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const cidOf = (code: number, b: Uint8Array) => hashCid(code, dbl(b));
const id = (c: CID) => displayHash(c.multihash.digest);

const HEADER_170 = "0100000055bd840a78798ad0da853f68974f3d183e2bd1db6a842c1feecf222a00000000ff104ccb05421ab93e63f8c3ce5c2c2e9dbb37de2764b3a3175c8166562cac7d51b96a49ffff001d283e9e70";
const TX_F418 = "0100000001c997a5e56e104102fa209c6a852dd90660a20b2d9c352423edce25857fcd3704000000004847304402204e45e16932b8af514961a1d3a1a25fdf3f4f7732e9d624c6c61548ab5fb8cd410220181522ec8eca07de4860a4acdd12909d831cc56cbbac4622082221a8768d1d0901ffffffff0200ca9a3b00000000434104ae1a62fe09c5f51b13905f07f06b99a2f7159b2225f374cd378d71302fa28414e7aab37397f554a7df5f142c21c1b7303b8a0626f1baded5c72a704f7e6cd84cac00286bee0000000043410411db93e1dcdb8a016b49840f8c53bc1eb68a382e97b1482ecad7b148a6909a5cb2e0eaddfb84ccf9744464f82e160bfa9b8b64f9d4c03f999b8643f656b412a3ac00000000";

test("bitcoin-block: block 170's header decodes with prev and merkleroot links", () => {
  const b = hex(HEADER_170);
  const c = cidOf(BITCOIN_BLOCK, b);
  assert.equal(id(c), "00000000d1145790a8694403d4063f323d499e655c83426834d4ce2f8dd4a2ee");
  const v = decodeBitcoin(c, b) as Record<string, unknown>;
  assert.equal(v.version, 1);
  assert.equal(id(v.previousblockhash as CID), "000000002a22cfee1f2c846adbd12b3e183d4f97683f85dad08a79780a84bd55");
  assert.equal((v.previousblockhash as CID).code, BITCOIN_BLOCK);
  assert.equal(id(v.merkleroot as CID), "7dac2c5666815c17a3b36427de37bb9d2e2c5ccec3f8633eb91a4205cb4c10ff");
  assert.equal((v.merkleroot as CID).code, BITCOIN_TX);
  assert.deepEqual([v.time, v.bits, v.nonce], [1231731025, 0x1d00ffff, 1889418792]);
  assert.deepEqual(bitcoinLinks(c, b).map((l) => [l.rel, id(l.to), l.locator]), [
    ["prev", "000000002a22cfee1f2c846adbd12b3e183d4f97683f85dad08a79780a84bd55", null],
    ["merkleroot", "7dac2c5666815c17a3b36427de37bb9d2e2c5ccec3f8633eb91a4205cb4c10ff", null],
  ]);
});

test("bitcoin-tx: inputs link what they spend (locator = vout); 64 bytes is a merkle node", () => {
  const b = hex(TX_F418);
  const c = cidOf(BITCOIN_TX, b);
  assert.equal(id(c), "f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16");
  const v = decodeBitcoin(c, b) as { vin: Array<Record<string, unknown>>; vout: Array<Record<string, unknown>>; locktime: number };
  assert.equal(id(v.vin[0].txid as CID), "0437cd7f8525ceed2324359c2d0ba26006d92d856a9c20fa0241106ee5a597c9");
  assert.equal(v.vin[0].vout, 0);
  assert.deepEqual(v.vout.map((o) => o.value), [1_000_000_000, 4_000_000_000]);
  assert.deepEqual(bitcoinLinks(c, b).map((l) => [l.rel, id(l.to), l.locator]), [["spends", "0437cd7f8525ceed2324359c2d0ba26006d92d856a9c20fa0241106ee5a597c9", 0]]);
  assert.deepEqual(bitcoinLinks(c, b.subarray(0, b.length - 1)), [], "a malformed transaction links nothing");

  const node = Uint8Array.from([...hex("b1fea52486ce0c62bb442b530a3f0132b826c74e473d1f2c220bfa78111c5082").reverse(), ...hex("f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16").reverse()]);
  const nc = cidOf(BITCOIN_TX, node);
  assert.equal(id(nc), "7dac2c5666815c17a3b36427de37bb9d2e2c5ccec3f8633eb91a4205cb4c10ff");
  const pair = decodeBitcoin(nc, node) as CID[];
  assert.deepEqual(pair.map(id), ["b1fea52486ce0c62bb442b530a3f0132b826c74e473d1f2c220bfa78111c5082", "f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16"]);
  assert.deepEqual(bitcoinLinks(nc, node).map((l) => [l.rel, l.locator]), [["child", 0], ["child", 1]]);
});

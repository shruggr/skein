// beef.ts (#121, #146): the wire bytes back from an envelope and its pointer record, for each form.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Beef, MerklePath, P2PKH, PrivateKey, Transaction, UnlockingScript } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import { subjectOf, wireOf, type BeefEnvelope, type BeefForm, type BeefRecord } from "./beef.ts";

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest();
const txCid = (txidHex: string) => CID.createV1(0xb1, Digest.create(0x56, Buffer.from(txidHex, "hex").reverse()));
const rawCid = (b: Uint8Array) => CID.createV1(0x55, Digest.create(0x12, sha256(b)));

/** The envelope and record the door writes for `wire` (kernel-zig/src/beef.zig `envelope`, `record`), and its blocks. */
function recordOf(wire: Uint8Array, form: BeefForm = "beef", vout?: number): { e: BeefEnvelope; r: BeefRecord; blocks: Map<string, Uint8Array> } {
  const inner = form === "beef" ? wire : wire.subarray(form === "outpoint" ? 40 : 36);
  const b = Beef.fromBinary(Array.from(inner));
  const blocks = new Map<string, Uint8Array>();
  const txs = b.txs.map((t) => { const c = txCid(t.txid); if (t.rawTx) blocks.set(c.toString(), Uint8Array.from(t.rawTx)); return c; });
  const marks = b.txs.map((t) => t.isTxidOnly ? "txid" as const : t.bumpIndex ?? null);
  const bumps = b.bumps.map((p) => { const bytes = Uint8Array.from(p.toBinary()); const c = rawCid(bytes); blocks.set(c.toString(), bytes); return { height: p.blockHeight, path: c, block: null, proves: [] }; });
  const r: BeefRecord = { kind: "beef", version: inner[0] as 1 | 2, txs, marks, bumps };
  const beef = CID.createV1(0x71, Digest.create(0x12, sha256(dagCbor.encode(r))));
  const subject = form === "beef" ? undefined : CID.createV1(0xb1, Digest.create(0x56, wire.subarray(4, 36)));
  return { e: { form, beef, ...(subject ? { subject } : {}), ...(vout !== undefined ? { vout } : {}) }, r, blocks };
}

test("wireOf: the exact bytes of V1, V2, Atomic, Outpoint and Subject from the envelope, the record and its blocks", async () => {
  const k = PrivateKey.fromRandom();
  const fund = new Transaction();
  fund.addInput({ sourceTXID: "11".repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex("51"), sequence: 0xffffffff });
  fund.addOutput({ lockingScript: new P2PKH().lock(k.toPublicKey().toHash()), satoshis: 10_000 });
  fund.merklePath = new MerklePath(7, [[{ offset: 0, hash: "22".repeat(32) }, { offset: 1, hash: fund.id("hex"), txid: true }]]);
  const child = new Transaction();
  child.addInput({ sourceTransaction: fund, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(k) });
  child.addOutput({ lockingScript: new P2PKH().lock(k.toPublicKey().toHash()), satoshis: 9_000 });
  await child.sign();
  const v1 = Uint8Array.from(child.toBEEF());
  const beef = new Beef();
  beef.mergeTransaction(child);
  const v2 = Uint8Array.from(beef.toBinary());
  const atomic = Uint8Array.from(child.toAtomicBEEF());
  const outpoint = Uint8Array.from([0x16, 0xa7, 0xbe, 0xef, ...Buffer.from(child.id("hex"), "hex").reverse(), 0, 0, 0, 0, ...v2]);
  // BRC-233: the subject the funding transaction, not the last one.
  const subject = Uint8Array.from([0x57, 0x09, 0xbe, 0xef, ...Buffer.from(fund.id("hex"), "hex").reverse(), ...v2]);
  for (const [wire, form, vout] of [[v1, "beef"], [v2, "beef"], [atomic, "atomic"], [outpoint, "outpoint", 0], [subject, "subject"]] as Array<[Uint8Array, BeefForm, number?]>) {
    const { e, r, blocks } = recordOf(wire, form, vout);
    const got = await wireOf(e, r, async (c) => blocks.get(c.toString())!);
    assert.equal(Buffer.from(got).toString("hex"), Buffer.from(wire).toString("hex"), `${form} v${r.version}`);
  }
  // The subject: the envelope's, else the last transaction.
  assert.equal(subjectOf(recordOf(v2).e, recordOf(v2).r)!.toString(), recordOf(v2).r.txs.at(-1)!.toString());
  const s = recordOf(subject, "subject");
  assert.equal(Buffer.from(subjectOf(s.e, s.r)!.multihash.digest).reverse().toString("hex"), fund.id("hex"));
  // Subject BEEF is V2 only.
  await assert.rejects(wireOf({ ...s.e }, recordOf(v1).r, async (c) => recordOf(v1).blocks.get(c.toString())!));
});

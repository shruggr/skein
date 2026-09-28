// Bootstrap packets (#4): the writer's synthetic transactions read back and
// verified offline; each refusal (incomplete, hash mismatch, scope mismatch,
// unproven) by the reason; ordfs/dir manifests and ordfs/patch files resolved
// to the git objects they stand for.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Beef, Script, Transaction } from "@bsv/sdk";
import { CID } from "multiformats/cid";
import { decode, encode } from "../runtime/cid.ts";
import { blobCid, hashBlob, hashTree } from "../runtime/tree.ts";
import { dirSource, MemBlocks, rawCid } from "./boot.ts";
import { carrierScript, closure, decodePacket, encodeDir, readPacket, rootsTracker, txCid, writePacket, type PacketRecord } from "./packet.ts";
import { vcdiffEncode } from "./vcdiff.ts";

const MODULE = Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]); // an empty wasm module

async function fixture(t: { after(f: () => unknown): void }) {
  const dir = await fs.mkdtemp(join(tmpdir(), "skein-packet-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(join(dir, "bin"));
  await fs.mkdir(join(dir, "etc"));
  await fs.mkdir(join(dir, "skills/deep"), { recursive: true });
  await fs.writeFile(join(dir, "SOUL.md"), "You are a test.\n");
  await fs.writeFile(join(dir, "skills/deep/x.sh"), "#!/bin/sh\necho x\n", { mode: 0o755 });
  await fs.symlink("SOUL.md", join(dir, "link"));
  await fs.writeFile(join(dir, "bin/probe.cid"), `${rawCid(MODULE)}\n`);
  await fs.writeFile(join(dir, "etc/subscriptions.json"), JSON.stringify([{ sender: "$owner", box: "run", handler: "probe" }]));
  const src = await dirSource(dir);
  await src.objects.putBlock(rawCid(MODULE), MODULE); // the module bin/probe.cid names
  return src;
}

const refuses = async (p: Promise<unknown>, code: string) => {
  await assert.rejects(p, (e: Error & { code?: string }) => { assert.equal(e.code, code, e.message); return true; });
};

test("packet: written and read back in both forms, with and without an index; the closure includes bin/*.cid modules", async (t) => {
  const { root, objects } = await fixture(t);
  const want = await closure(root, (c) => objects.get(c));
  assert.deepEqual(want.missing, []);
  assert.ok(want.blocks.some((b) => b.cid.equals(rawCid(MODULE))), "the module is in the closure");
  for (const o of [{ form: "ordfs" as const }, { form: "git" as const }, { form: "ordfs" as const, noIndex: true }, { form: "git" as const, noIndex: true, maxOutputs: 1 }]) {
    const w = await writePacket(root, objects, o);
    const p = decodePacket(w.bytes);
    assert.ok(p.scope.equals(root));
    assert.equal(!!p.index, !o.noIndex);
    const v = await readPacket(w.bytes, { scope: root });
    assert.equal(v.kind, "tree");
    assert.deepEqual(new Set(v.list.map((b) => b.cid.toString())), new Set(want.blocks.map((b) => b.cid.toString())), JSON.stringify(o));
    for (const b of v.list) assert.deepEqual(Buffer.from(b.bytes), Buffer.from((await objects.get(b.cid))!), `${b.cid} ${JSON.stringify(o)}`);
    if (o.maxOutputs === 1) assert.equal(w.txids.length, want.blocks.length, "one object per transaction");
  }
});

test("packet: refused — scope mismatch, hash mismatch, incomplete", async (t) => {
  const { root, objects } = await fixture(t);
  const w = await writePacket(root, objects, { form: "git", maxOutputs: 1 });
  await refuses(readPacket(w.bytes, { scope: blobCid(new TextEncoder().encode("other")) }), "scope-mismatch");

  // The index sends a CID to another object's output.
  const p = decode<PacketRecord>(w.bytes);
  const swapped = { ...p, index: p.index!.map((e, i, all) => i === 1 ? { ...e, tx: all[2]!.tx, vout: all[2]!.vout } : e) };
  await refuses(readPacket(encode(swapped).bytes), "hash-mismatch");

  // A transaction left out of the bag: its object is missing.
  const beef = Beef.fromBinary(Array.from(p.beef));
  const drop = beef.txs[3]!.txid;
  const less = new Beef();
  for (const b of beef.txs) if (b.txid !== drop) less.mergeTransaction(b.tx!);
  await refuses(readPacket(encode({ ...p, beef: Uint8Array.from(less.toBinary()) }).bytes), "incomplete");
  await refuses(readPacket(encode({ ...p, index: undefined, beef: Uint8Array.from(less.toBinary()) }).bytes), "incomplete");

  // A module the tree names by CID but the source does not hold: the writer refuses too.
  const bare = new MemBlocks();
  for (const b of (await closure(root, (c) => objects.get(c))).blocks) if (!b.cid.equals(rawCid(MODULE))) await bare.putBlock(b.cid, b.bytes);
  await refuses(writePacket(root, bare), "incomplete");
});

test("packet: chain inclusion only when asked — merkle paths against the headers", async (t) => {
  const { root, objects } = await fixture(t);
  const mined = await writePacket(root, objects, { mined: true, maxOutputs: 3 });
  assert.ok(Object.keys(mined.roots).length === mined.txids.length && mined.txids.length > 1);
  await readPacket(mined.bytes, { chainTracker: rootsTracker(mined.roots) });
  const wrong = { ...mined.roots, 1: "00".repeat(32) };
  await refuses(readPacket(mined.bytes, { chainTracker: rootsTracker(wrong) }), "unproven");
  const unmined = await writePacket(root, objects);
  await readPacket(unmined.bytes); // offline: content addressing only
  await refuses(readPacket(unmined.bytes, { chainTracker: rootsTracker(mined.roots) }), "unproven");
});

test("packet: an ordfs/patch file is resolved through its base (a gib edit); without the base the packet is incomplete", async () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const v1 = enc("line one\nline two\n"), v2 = enc("line one\nline 2, edited\nline three\n");
  const tx = (outs: Uint8Array[], n: number) => {
    const x = new Transaction();
    x.addInput({ sourceTXID: String(n).padStart(64, "0"), sourceOutputIndex: 0, unlockingScript: new Script(), sequence: 0xffffffff });
    for (const s of outs) x.addOutput({ lockingScript: Script.fromBinary(Array.from(s)), satoshis: 0 });
    return x;
  };
  const base = tx([carrierScript("text/plain", v1)], 1);
  const op = Buffer.alloc(36); Buffer.from(base.id("hex") as string, "hex").reverse().copy(op); op.writeUInt32LE(0, 32);
  const patch = carrierScript("ordfs/patch", Buffer.concat([Buffer.from([0]), op, vcdiffEncode(v2, v1)]));
  const edit = tx([patch, carrierScript("ordfs/dir", encodeDir([{ name: "notes.txt", mode: "100644", vout: 0 }]))], 2);
  const scope = hashTree([{ mode: "100644", name: "notes.txt", cid: hashBlob(v2).cid }]).cid;
  const bag = (txs: Transaction[]) => { const b = new Beef(); for (const x of txs) b.mergeTransaction(x); return Uint8Array.from(b.toBinary()); };
  const packet = (txs: Transaction[], index?: PacketRecord["index"]) => encode({ kind: "skein-packet", version: 1, scope, beef: bag(txs), ...(index ? { index } : {}) }).bytes;
  const v = await readPacket(packet([base, edit]));
  assert.deepEqual(Buffer.from(v.list.find((b) => b.cid.equals(hashBlob(v2).cid))!.bytes), Buffer.from(hashBlob(v2).object));
  // With an index naming only the root manifest: the children come from the manifest.
  await readPacket(packet([base, edit], [{ tx: txCid(edit.id("hex") as string), vout: 1, cid: scope }]));
  await refuses(readPacket(packet([edit])), "incomplete");
});

test("packet: a dag-cbor scope must be a state record (a checkpoint)", async () => {
  const rec = encode({ kind: "not-state" });
  const objects = new MemBlocks();
  await objects.putBlock(rec.cid, rec.bytes);
  const w = await writePacket(rec.cid, objects);
  await refuses(readPacket(w.bytes), "malformed");
  assert.ok(CID.asCID(decodePacket(w.bytes).scope));
});

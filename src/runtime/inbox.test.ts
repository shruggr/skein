// The edge: admission screening — signature, the messagebox's authenticated
// sender, freshness, duplicates, and the plaintext against the sender-signed
// contentHash — and what an admitted entry holds: the signed part and the
// plaintext body, no ciphertext, no key.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { contentHash, encryptContent, seal, sign, signedPart } from "../envelope.ts";
import { instance, iso, send, T0 } from "../testkit.ts";
import { encode } from "./cid.ts";
import { readLog } from "./log.ts";

test("screening: a good envelope is admitted with its plaintext; a bad signature, a forged messagebox sender, a stale or future `created`, and a duplicate are rejected — all acknowledged", async () => {
  const i = await instance();
  const good = await send(i, "run", { cmd: "true", tree: encode({}).cid });
  // A tampered envelope: the metadata no longer matches the signature.
  const tampered = { ...(await seal(i.owner.wallet, { recipient: { identityKey: i.identity, handle: "skein", domain: "localhost" }, body: dagCbor.encode({ a: 1 }), created: iso(i.clock.now()) })), quoteId: "x" };
  i.hub.inject(i.identity, "run", { sender: i.owner.identity, body: JSON.stringify(tampered) });
  // A valid envelope, but the messagebox says someone else submitted it.
  const forged = await seal(i.owner.wallet, { recipient: { identityKey: i.identity, handle: "skein", domain: "localhost" }, body: dagCbor.encode({ b: 2 }), created: iso(i.clock.now()) });
  i.hub.inject(i.identity, "run", { sender: PrivateKey.fromRandom().toPublicKey().toString(), body: JSON.stringify(forged) });
  // Outside the ±10 min window, both ways.
  await send(i, "run", { c: 3 }, iso([T0[0] - 11 * 60, 0]));
  await send(i, "run", { c: 4 }, iso([T0[0] + 11 * 60, 0]));
  // Inside it.
  await send(i, "run", { c: 5 }, iso([T0[0] - 9 * 60, 0]));

  const admitted = await i.edge.poll();
  assert.equal(admitted.length, 2);
  assert.ok(admitted.some((a) => a.envelope === encode(signedPart(good)).cid.toString()));
  const reasons = i.lines.filter((l) => l.includes("rejected")).join("\n");
  assert.match(reasons, /signature does not verify/);
  assert.match(reasons, /messagebox sender .* is not envelope.sender/);
  assert.equal((reasons.match(/outside ±600000 ms/g) ?? []).length, 2);
  assert.equal(i.hub.pending(i.identity, "run").length, 0, "rejections are acknowledged too");

  // The same envelope delivered again (a replayed message) is refused by its record CID.
  i.hub.inject(i.identity, "run", { sender: i.owner.identity, body: JSON.stringify(good) });
  assert.equal((await i.edge.poll()).length, 0);
  assert.match(i.lines.at(-1)!, /already admitted/);
  const goodBody = dagCbor.encode({ cmd: "true", tree: encode({}).cid });
  await assert.rejects(i.rt.admitEnvelope(signedPart(good), "run", goodBody), /already admitted/);

  const log = await readLog(i.store);
  assert.equal(log.length, 3, "genesis + two admissions");
  await i.rt.stop();
});

test("admission: the entry holds the signed part and the plaintext body — no ciphertext, no key; the body's CID is the signed contentHash", async () => {
  const i = await instance();
  const value = { cmd: "true", tree: encode({}).cid };
  const good = await send(i, "run", value);
  await i.edge.poll();
  const [, { entry }] = await readLog(i.store);
  assert.deepEqual(Object.keys(entry).sort(), ["body", "box", "envelope", "kind", "n", "prev", "sig", "time"]);
  const env = await i.store.get(entry.envelope!) as Record<string, unknown>;
  assert.equal("content" in env, false, "the wire encryption is not kept");
  assert.deepEqual(env, JSON.parse(JSON.stringify(signedPart(good))));
  assert.ok(entry.envelope!.equals(encode(signedPart(good)).cid), "the envelope CID is the signed part's: the message id");
  assert.deepEqual(await i.store.bytes(entry.body!), dagCbor.encode(value), "the plaintext, as the sender encoded it");
  assert.equal(Buffer.from(entry.body!.multihash.digest).toString("hex"), good.contentHash, "sha2-256 of the body is the signed contentHash");
  assert.ok(encode(await i.store.get(entry.body!)).cid.equals(entry.body!));
  await i.rt.stop();
});

test("contentHash: content that does not match the signed hash is rejected at the edge and at admit", async () => {
  const i = await instance();
  const to = { identityKey: i.identity, handle: "skein", domain: "localhost" };
  const signed = await sign(i.owner.wallet, { recipient: to, body: dagCbor.encode({ cmd: "echo signed" }), created: iso(i.clock.now()) });
  // A valid signature over a hash of one body, with another body encrypted as the content.
  const tampered = { ...signed, content: await encryptContent(i.owner.wallet, i.identity, dagCbor.encode({ cmd: "rm -rf /" })) };
  i.hub.inject(i.identity, "run", { sender: i.owner.identity, body: JSON.stringify(tampered) });
  assert.equal((await i.edge.poll()).length, 0);
  assert.match(i.lines.join("\n"), /rejected: envelope: the content does not match its signed contentHash/);
  assert.equal(i.hub.pending(i.identity, "run").length, 0, "acknowledged");
  // The runtime checks the binding too.
  await assert.rejects(i.rt.admitEnvelope(signedPart(tampered), "run", dagCbor.encode({ cmd: "rm -rf /" })), /does not match the envelope's contentHash/);
  // And a good one, for contrast.
  const ok = await seal(i.owner.wallet, { recipient: to, body: dagCbor.encode({ cmd: "echo ok" }), created: iso(i.clock.now()) });
  assert.equal(ok.contentHash, contentHash(dagCbor.encode({ cmd: "echo ok" })));
  i.hub.inject(i.identity, "run", { sender: i.owner.identity, body: JSON.stringify(ok) });
  assert.equal((await i.edge.poll()).length, 1);
  assert.equal((await readLog(i.store)).length, 2, "genesis + the good one");
  await i.rt.stop();
});

test("screening: the freshness window is configurable", async () => {
  const i = await instance({ freshnessMs: 60 * 60_000 });
  await send(i, "run", { c: 1 }, iso([T0[0] - 30 * 60, 0]));
  assert.equal((await i.edge.poll()).length, 1);
  await i.rt.stop();
});

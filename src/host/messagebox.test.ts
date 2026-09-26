// The messagebox delivery provider: screening — signature, the messagebox's
// authenticated sender, duplicates, and the plaintext against the
// sender-signed contentHash; no freshness window — and what an admitted entry
// holds: the signed part and the plaintext body, no ciphertext, no key,
// stamped and signed by the host.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { contentHash, encryptContent, seal, sign, signedPart } from "../envelope.ts";
import { instance, iso, send, T0 } from "../testkit.ts";
import { encode } from "../runtime/cid.ts";
import { readLog, verifyEntry } from "../runtime/log.ts";
import { admitEntry } from "./entry.ts";

test("screening: a good envelope is admitted with its plaintext; a bad signature, a forged messagebox sender and a duplicate are rejected — all acknowledged", async () => {
  const i = await instance();
  const good = await send(i, "run", { cmd: "true", tree: encode({}).cid });
  // A tampered envelope: the metadata no longer matches the signature.
  const tampered = { ...(await seal(i.owner.wallet, { recipient: { identityKey: i.identity, handle: "skein", domain: "localhost" }, body: dagCbor.encode({ a: 1 }), created: iso(i.clock.now()) })), quoteId: "x" };
  i.hub.inject(i.identity, "run", { sender: i.owner.identity, body: JSON.stringify(tampered) });
  // A valid envelope, but the messagebox says someone else submitted it.
  const forged = await seal(i.owner.wallet, { recipient: { identityKey: i.identity, handle: "skein", domain: "localhost" }, body: dagCbor.encode({ b: 2 }), created: iso(i.clock.now()) });
  i.hub.inject(i.identity, "run", { sender: PrivateKey.fromRandom().toPublicKey().toString(), body: JSON.stringify(forged) });

  const admitted = await i.delivery.poll();
  assert.equal(admitted.length, 1);
  assert.ok(admitted.some((a) => a.envelope === encode(signedPart(good)).cid.toString()));
  const reasons = i.lines.filter((l) => l.includes("rejected")).join("\n");
  assert.match(reasons, /signature does not verify/);
  assert.match(reasons, /messagebox sender .* is not envelope.sender/);
  assert.equal(i.hub.pending(i.identity, "run").length, 0, "rejections are acknowledged too");

  // The same envelope delivered again (a replayed message) is refused by its record CID.
  i.hub.inject(i.identity, "run", { sender: i.owner.identity, body: JSON.stringify(good) });
  assert.equal((await i.delivery.poll()).length, 0);
  assert.match(i.lines.at(-1)!, /already admitted/);
  // …and by the runtime, whoever delivers it.
  const goodBody = dagCbor.encode({ cmd: "true", tree: encode({}).cid });
  await assert.rejects(admitEntry(i.rt, i.host.wallet, { envelope: encode(signedPart(good)).cid, box: "run", body: encode(dagCbor.decode(goodBody)).cid }, { envelope: signedPart(good), body: goodBody }), /already admitted/);

  const log = await readLog(i.store);
  assert.equal(log.length, 2, "genesis + one admission");
  await i.rt.stop();
});

test("admission: the entry holds the signed part and the plaintext body — no ciphertext, no key; the body's CID is the signed contentHash", async () => {
  const i = await instance();
  const value = { cmd: "true", tree: encode({}).cid };
  const good = await send(i, "run", value);
  await i.delivery.poll();
  const [, { entry }] = await readLog(i.store);
  assert.deepEqual(Object.keys(entry).sort(), ["body", "box", "envelope", "kind", "n", "prev", "sig", "time"]);
  assert.ok(verifyEntry(entry, i.host.identity), "stamped and signed by the host");
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
  assert.equal((await i.delivery.poll()).length, 0);
  assert.match(i.lines.join("\n"), /rejected: envelope: the content does not match its signed contentHash/);
  assert.equal(i.hub.pending(i.identity, "run").length, 0, "acknowledged");
  // The runtime checks the binding too, whoever delivers it.
  const bad = dagCbor.encode({ cmd: "rm -rf /" });
  await assert.rejects(admitEntry(i.rt, i.host.wallet, { envelope: encode(signedPart(tampered)).cid, box: "run", body: encode(dagCbor.decode(bad)).cid }, { envelope: signedPart(tampered), body: bad }), /does not match the envelope's contentHash/);
  // And a good one, for contrast.
  const ok = await seal(i.owner.wallet, { recipient: to, body: dagCbor.encode({ cmd: "echo ok" }), created: iso(i.clock.now()) });
  assert.equal(ok.contentHash, contentHash(dagCbor.encode({ cmd: "echo ok" })));
  i.hub.inject(i.identity, "run", { sender: i.owner.identity, body: JSON.stringify(ok) });
  assert.equal((await i.delivery.poll()).length, 1);
  assert.equal((await readLog(i.store)).length, 2, "genesis + the good one");
  await i.rt.stop();
});

test("freshness: the provider judges none — a stale or a future `created` is admitted; the entry carries both `created` and the host's stamp", async () => {
  const i = await instance();
  const old = await send(i, "run", { c: 1 }, iso([T0[0] - 24 * 3600, 0]));
  const ahead = await send(i, "run", { c: 2 }, iso([T0[0] + 3600, 0]));
  assert.equal((await i.delivery.poll()).length, 2);
  const log = (await readLog(i.store)).slice(1);
  assert.deepEqual(log.map(({ entry }) => entry.time), [T0, T0], "arrival: the host's stamp");
  const created = await Promise.all(log.map(async ({ entry }) => (await i.store.get(entry.envelope!) as unknown as { created: string }).created));
  assert.deepEqual(created, [old.created, ahead.created], "the sender's `created`, in the signed part: (created, stamp) is there for the instance to judge, deterministically");
  await i.rt.stop();
});

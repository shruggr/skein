import { test } from "node:test";
import assert from "node:assert/strict";
import { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { seal } from "./envelope.ts";
import { asEnvelope, inspect, isCborEnvelope, openCbor, sealCbor, verifyCbor, wrapCbor } from "./envelope-cbor.ts";
import { ephemeralWallet } from "./wallet.ts";

test("§7.3 envelopes: sealed, verified over the dag-cbor preimage, opened; bytes not hex; carried as BRC-231 bytes or wrapped in JSON; the §7.2 form still reads", async () => {
  const a = PrivateKey.fromRandom(), b = PrivateKey.fromRandom();
  const body = dagCbor.encode({ text: "hi" });
  const env = await sealCbor(ephemeralWallet(a), { recipient: { identityKey: b.toPublicKey().toString(), handle: "b", domain: "localhost" }, body });
  assert.ok(isCborEnvelope(env));
  assert.equal(env.sender.identityKey.length, 33);
  assert.equal(env.contentHash.length, 32);
  assert.ok(verifyCbor(env));
  assert.ok(!verifyCbor({ ...env, created: "2000-01-01T00:00:00.000Z" }), "a changed member breaks the signature");
  assert.deepEqual((await openCbor(ephemeralWallet(b), env)).body, body);
  await assert.rejects(openCbor(ephemeralWallet(a), env), /not this wallet/);
  const bytes = dagCbor.encode(env);
  for (const carried of [bytes, wrapCbor(env), JSON.stringify(wrapCbor(env))]) {
    const back = asEnvelope(carried);
    assert.ok(back && isCborEnvelope(back));
    const x = inspect(back);
    assert.deepEqual([x.form, x.sender, x.recipient, x.verified], ["cbor", a.toPublicKey().toString(), b.toPublicKey().toString(), true]);
  }
  const json = await seal(ephemeralWallet(a), { recipient: { identityKey: b.toPublicKey().toString(), handle: "b", domain: "localhost" }, body });
  const j = inspect(asEnvelope(JSON.stringify(json))!);
  assert.deepEqual([j.form, j.verified], ["json", true]);
  assert.notEqual(j.id.toString(), inspect(env).id.toString());
  assert.equal(asEnvelope("nonsense"), undefined);
});

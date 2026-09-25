import { test } from "node:test";
import assert from "node:assert/strict";
import { PrivateKey, ProtoWallet } from "@bsv/sdk";
import { decrypt as sdkDecrypt, encrypt as sdkEncrypt } from "@bsv/sdk/messages/EncryptedMessage";
import { brc78Decode, brc78Encode, canonical, open, seal, verify, type Envelope } from "./envelope.ts";
import { ephemeralWallet } from "./wallet.ts";

test("envelope: canonical form reproduces BRC-169 Appendix A.7 exactly", () => {
  const env = {
    metanetHandles: "1.0" as const,
    recipient: { handle: "deggen", tag: "conf2036", domain: "lkup.net" },
    sender: { identityKey: "0375b162a37d8794cfdcf72938d9467931e8586885b93c0da97051ecb512f46646", handle: "crumbs", domain: "nexus.example" },
    created: "2026-07-30T09:15:00Z",
    quoteId: "0d34cb39c1c6fe06cd4a346867e1e334",
    payment: {
      derivationPrefix: "D1vMjXw0XVElldVZgrWk4w==",
      derivationSuffix: "nEK2VVSJFSCulgp/tHd1ng==",
      protocol: "3241645161d8",
      satoshis: 21545,
      beef: "<Atomic BEEF, BRC-95, elided>",
    },
    content: "<BRC-78 encrypted payload, elided>",
    signature: "304402201ffa604f518febbc5dae08ce24b934943028663018fc69149dcf7c0fc6d016360220127dd6991f1a9797b7ad989cd56ae9c8d2b155e015f17f1c3a94e63ace9504b4",
  };
  assert.equal(canonical(env),
    `{"created":"2026-07-30T09:15:00Z","metanetHandles":"1.0","payment":{"beef":"<Atomic BEEF, BRC-95, elided>","derivationPrefix":"D1vMjXw0XVElldVZgrWk4w==","derivationSuffix":"nEK2VVSJFSCulgp/tHd1ng==","protocol":"3241645161d8","satoshis":21545},"quoteId":"0d34cb39c1c6fe06cd4a346867e1e334","recipient":{"domain":"lkup.net","handle":"deggen","tag":"conf2036"},"sender":{"domain":"nexus.example","handle":"crumbs","identityKey":"0375b162a37d8794cfdcf72938d9467931e8586885b93c0da97051ecb512f46646"}}`);
});

test("envelope: seal → verify → open round trip between two wallets", async () => {
  const alice = ephemeralWallet(), bob = ephemeralWallet();
  const bobKey = (await bob.getPublicKey({ identityKey: true })).publicKey;
  const aliceKey = (await alice.getPublicKey({ identityKey: true })).publicKey;
  const body = Uint8Array.of(0xa1, 0x61, 0x61, 0x01); // {a: 1}
  const env = await seal(alice, { recipient: { identityKey: bobKey, handle: "bob", domain: "localhost" }, sender: { handle: "alice" }, body });
  assert.equal(env.sender.identityKey, aliceKey);
  assert.ok(verify(env));
  const m = brc78Decode(Buffer.from(env.content, "base64"));
  assert.equal(m.sender, aliceKey);
  assert.equal(m.recipient, bobKey);
  assert.equal(m.keyId.length, 32);
  const opened = await open(bob, env);
  assert.deepEqual(opened.body, body);
  assert.equal(opened.senderIdentityKey, aliceKey);
  // A JSON round trip (what the messagebox carries) still verifies.
  assert.ok(verify(JSON.parse(JSON.stringify(env)) as Envelope));
});

test("envelope: tampered metadata fails verify; the wrong recipient cannot open", async () => {
  const alice = ephemeralWallet(), bob = ephemeralWallet(), eve = ephemeralWallet();
  const bobKey = (await bob.getPublicKey({ identityKey: true })).publicKey;
  const env = await seal(alice, { recipient: { identityKey: bobKey, handle: "bob", domain: "localhost" }, body: Uint8Array.of(1, 2, 3) });
  assert.ok(verify(env));
  assert.equal(verify({ ...env, created: "2020-01-01T00:00:00Z" }), false);
  assert.equal(verify({ ...env, recipient: { ...env.recipient, handle: "mallory" } }), false);
  const eveKey = (await eve.getPublicKey({ identityKey: true })).publicKey;
  assert.equal(verify({ ...env, sender: { identityKey: eveKey } }), false);
  await assert.rejects(open(eve, env), /addressed to/);
  // Eve rewriting the recipient field inside the content cannot decrypt either.
  const m = brc78Decode(Buffer.from(env.content, "base64"));
  const forged = { ...env, content: Buffer.from(brc78Encode({ ...m, recipient: eveKey })).toString("base64") };
  await assert.rejects(open(eve, forged));
});

test("envelope: BRC-78 content interoperates with @bsv/sdk's EncryptedMessage", async () => {
  const aKey = PrivateKey.fromRandom(), bKey = PrivateKey.fromRandom();
  const b = new ProtoWallet(bKey), a = new ProtoWallet(aKey);
  // SDK-encrypted → opened through the wallet.
  const bytes = Uint8Array.from(sdkEncrypt([1, 2, 3, 4], aKey, bKey.toPublicKey()));
  const env = { content: Buffer.from(bytes).toString("base64") } as Envelope;
  assert.deepEqual((await open(b as never, env)).body, Uint8Array.of(1, 2, 3, 4));
  // Wallet-sealed → decrypted by the SDK.
  const sealed = await seal(a as never, { recipient: { identityKey: bKey.toPublicKey().toString(), handle: "b", domain: "x" }, body: Uint8Array.of(9, 8) });
  assert.deepEqual(sdkDecrypt([...Buffer.from(sealed.content, "base64")], bKey), [9, 8]);
});

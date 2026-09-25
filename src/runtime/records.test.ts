import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { BigNumber, ECDSA, PublicKey, Signature } from "@bsv/sdk";
import { decode, encode } from "./cid.ts";
import {
  genesis, isGenesis, isMessage, isProgram, matches, messageBytes, messageDigest, program,
  signMessage, subscription, subscriptionIn, verifyMessage, type Message,
} from "./records.ts";
import { ephemeralWallet, identityOf, signerFor } from "../wallet.ts";

const wasm = encode({ kind: "blob", n: 1 }).cid;

test("message: signed over dag-cbor without sig; verifies from the record alone", async () => {
  const signer = await signerFor(ephemeralWallet(), "david");
  const m = await signMessage(signer, { to: "admin", seq: 1, body: { kind: "line", text: "hi", nope: undefined }, refs: [{ to: wasm, rel: "about" }], at: 5 });
  assert.equal(m.from, signer.identity);
  assert.deepEqual(m.body, { kind: "line", text: "hi" });
  assert.ok(isMessage(m));

  // The scheme, checked with nothing but @bsv/sdk primitives: DER ECDSA over sha256(dag-cbor(record − sig)).
  const { sig: _, ...rest } = m;
  const bytes = encode(rest).bytes;
  assert.deepEqual(messageBytes(m), bytes);
  const digest = createHash("sha256").update(bytes).digest();
  assert.deepEqual(messageDigest(m), new Uint8Array(digest));
  const sig = Signature.fromDER([...m.sig]);
  assert.ok(ECDSA.verify(new BigNumber([...digest]), sig, PublicKey.fromString(m.from)));

  // Over the wire and back: the wallet is out of reach, the record still verifies.
  const received = decode<Message>(encode(m).bytes);
  assert.equal(await verifyMessage(received), true);
});

test("message: any change breaks the signature", async () => {
  const signer = await signerFor(ephemeralWallet(), "david");
  const other = await identityOf(ephemeralWallet(), "david");
  const m = await signMessage(signer, { seq: 3, body: { text: "pay 1 sat" }, at: 9 });
  const flipped = new Uint8Array(m.sig); flipped[10] ^= 1;
  for (const bad of [
    { ...m, body: { text: "pay 1000 sats" } },
    { ...m, seq: 4 },
    { ...m, at: 10 },
    { ...m, to: "someone" },
    { ...m, from: other },
    { ...m, sig: flipped },
    { ...m, sig: new Uint8Array([1, 2, 3]) },
    { ...m, from: "not a key" },
    { ...m, extra: 1 },           // unsigned fields are covered too
  ]) assert.equal(await verifyMessage(bad), false, JSON.stringify(Object.keys(bad)));
  assert.equal(await verifyMessage({ ...m }), true);
});

test("subscription: matches from/to/body kind/body subset; carried signed by admin", async () => {
  const w = ephemeralWallet();
  const david = await signerFor(w, "david");
  const stranger = await signerFor(ephemeralWallet(), "david");
  const admin = await signerFor(w, "admin");
  const line = { kind: "line", text: "yes", meta: { lang: "en", n: 1 }, ref: wasm };
  const fromDavid = await signMessage(david, { to: admin.identity, seq: 0, at: 1, body: line });
  const fromStranger = await signMessage(stranger, { to: admin.identity, seq: 0, at: 1, body: line });

  const sub = subscription({ from: david.identity, kind: "line" }, "resolve-waiter", 1);
  assert.ok(matches(sub, fromDavid));
  assert.ok(!matches(sub, fromStranger));
  assert.ok(matches(subscription({ to: admin.identity }, wasm, 1), fromStranger));
  assert.ok(!matches(subscription({ to: "elsewhere" }, wasm, 1), fromDavid));
  assert.ok(!matches(subscription({ kind: "tick" }, wasm, 1), fromDavid));
  assert.ok(matches(subscription({ body: { meta: { lang: "en" } } }, wasm, 1), fromDavid));   // nested subset
  assert.ok(matches(subscription({ body: { ref: encode({ kind: "blob", n: 1 }).cid } }, wasm, 1), fromDavid)); // CIDs by value
  assert.ok(!matches(subscription({ body: { meta: { lang: "fr" } } }, wasm, 1), fromDavid));
  assert.ok(!matches(subscription({ body: { missing: undefined } }, wasm, 1), fromDavid));
  assert.ok(matches(subscription({}, wasm, 1), fromDavid));

  const carrying = await signMessage(admin, { seq: 0, at: 1, body: sub });
  assert.equal(await verifyMessage(carrying), true);
  assert.ok(subscriptionIn(carrying, admin.identity));
  assert.equal(subscriptionIn(carrying, david.identity), undefined);  // only the admin's count
  assert.equal(subscriptionIn(fromDavid, david.identity), undefined); // not a subscription
  assert.throws(() => subscription({ from: 7 as unknown as string }, wasm, 1), TypeError);
});

test("program and genesis: validated on construction", async () => {
  const p = program({ name: "shell", code: { ts: "export default () => 1" }, inputs: { type: "object" }, services: ["execution"], description: "run a command" });
  assert.ok(isProgram(p));
  assert.ok(isProgram(program({ name: "w", code: { wasm }, inputs: {}, services: [], description: "" })));
  assert.throws(() => program({ name: "x", code: { ts: "", wasm } as never, inputs: {}, services: [], description: "" }), TypeError);
  assert.throws(() => program({ name: "", code: { ts: "" }, inputs: {}, services: [], description: "" }), TypeError);
  const root = await identityOf(ephemeralWallet(), "root");
  assert.ok(isGenesis(genesis(root, "ripper", 1)));
  assert.deepEqual(genesis(root, undefined, 1), { kind: "genesis", root, at: 1 });
  assert.throws(() => genesis("nope", undefined, 1), TypeError);
});

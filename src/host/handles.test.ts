// BRC-169 resolution as the host answers it (#100, handles.ts): the type
// identifier and the SDK's signing against the spec's worked example (§4.5,
// A.3), the certificate the host issues, and the router's manifest and
// resolve answer (§5.1–§5.3) checked as a resolver checks them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Certificate, PrivateKey, ProtoWallet, Utils } from "@bsv/sdk";
import { HANDLE_CERTIFICATE_TYPE, HANDLES_VERSION, issueHandleCertificate, NO_REVOCATION_OUTPOINT, RESOLUTION_TTL, serialOf } from "./handles.ts";
import { Oracle } from "./oracle.ts";
import { testHost } from "./testhost.ts";

const b64 = (s: string) => Utils.toBase64(Utils.toArray(s, "utf8"));
const unb64 = (s: string) => Utils.toUTF8(Utils.toArray(s, "base64"));

test("handles: the handle-certificate type is §4.5's; the SDK signs A.3's certificate to the printed signature", async () => {
  assert.equal(HANDLE_CERTIFICATE_TYPE, "XgCFdUfxEcI+3xtDjsIuSAjMl5EwzCUjsQc45ds1lC8=");
  // A.1: the lkup.net certifier; A.3: the certificate for @deggen@lkup.net.
  const lkup = new ProtoWallet(PrivateKey.fromHex("2641016ccb8e5602f53467fd6a8d91e2c58d44b8f727bd843da3f5f71e79e4c8"));
  const c = new Certificate(HANDLE_CERTIFICATE_TYPE, "JMNxKTvlkhOO88EJZRgnpTKL78dC1XwxQ9REUysjy08=",
    "0359c5f3bfe249f6c0ca99d0e9cc1517da51a511f3d04f18e47a5d7ae55f04008c", "",
    "2b09f724127b5213ead87842deade00ef6cb1a834c951d1612e162f5891fb3cb.0", { handle: "ZGVnZ2Vu", domain: "bGt1cC5uZXQ=" });
  await c.sign(lkup);
  assert.equal(c.certifier, "0371f0ec5992a9d38e09fe528e367890969c66eaebdb01b4d35a2fc0d61251b3f9");
  assert.equal(Utils.toHex(c.toBinary(false)),
    "5e00857547f111c23edf1b438ec22e4808cc979130cc2523b10738e5db35942f" +
    "24c371293be592138ef3c109651827a5328befc742d57c3143d444532b23cb4f" +
    "0359c5f3bfe249f6c0ca99d0e9cc1517da51a511f3d04f18e47a5d7ae55f04008c" +
    "0371f0ec5992a9d38e09fe528e367890969c66eaebdb01b4d35a2fc0d61251b3f9" +
    "2b09f724127b5213ead87842deade00ef6cb1a834c951d1612e162f5891fb3cb" +
    "00" + "02" + "06646f6d61696e0c62477431634335755a58513d" + "0668616e646c6508" + "5a47566e5a325675");
  assert.equal(c.signature, "30450221008becb25058954be7cf6f8c46d3a0411a85a9aed55ef90466651fc75374e2bdcf02205a232796a1c2dd0bd7096428a5e6fb766eee404f441a93a261986486ba3b553c");
  assert.equal(await c.verify(), true);
});

test("handles: the host's certificate for a binding verifies against the certifier key, is the same on every issue, and carries the disabled revocation outpoint", async () => {
  const certifierKey = new Oracle(PrivateKey.fromRandom()).certifierKey();
  const certifier = new ProtoWallet(certifierKey);
  const subject = PrivateKey.fromRandom().toPublicKey().toString();
  const c = await issueHandleCertificate(certifier, "david", "id.skein.nexus", subject);
  assert.equal(c.type, HANDLE_CERTIFICATE_TYPE);
  assert.equal(c.subject, subject);
  assert.equal(c.certifier, certifierKey.toPublicKey().toString());
  assert.equal(c.serialNumber, serialOf("david", "id.skein.nexus", subject));
  assert.deepEqual(c.fields, { handle: b64("david"), domain: b64("id.skein.nexus") });
  assert.equal(c.revocationOutpoint, NO_REVOCATION_OUTPOINT);
  assert.equal(NO_REVOCATION_OUTPOINT, "0000000000000000000000000000000000000000000000000000000000000000.0");
  assert.equal(await c.verify(), true);
  // As a resolver holds it: the JSON, back through the SDK.
  const j = JSON.parse(JSON.stringify(c)) as Certificate;
  assert.equal(await new Certificate(j.type, j.serialNumber, j.subject, j.certifier, j.revocationOutpoint, j.fields, j.signature).verify(), true);
  // Deterministic: the same binding, the same certificate.
  assert.equal((await issueHandleCertificate(certifier, "david", "id.skein.nexus", subject)).signature, c.signature);
  // Another binding, another serial; a tampered field does not verify.
  assert.notEqual(serialOf("david", "id.skein.nexus", PrivateKey.fromRandom().toPublicKey().toString()), c.serialNumber);
  assert.equal(await new Certificate(c.type, c.serialNumber, c.subject, c.certifier, c.revocationOutpoint, { ...c.fields, handle: b64("mallory") }, c.signature).verify(), false);
});

test("handles: the router's manifest names the certifier key; a resolution is §5.2's, its certificate the host's; errors are §5.3's", async (t) => {
  const h = await testHost(t);
  const alpha = h.agent("alpha");
  h.mailbox("david", h.ownerId);
  const manifest = await (await fetch(`${h.base}/manifest.json`)).json() as { metanet: { trust: { publicKey: string }; handles: { version: string; resolve: string } } };
  assert.equal(manifest.metanet.handles.version, HANDLES_VERSION);
  assert.equal(manifest.metanet.handles.resolve, `${h.base}/.well-known/metanet-handles/resolve`);
  const { publicKey: certifierKey } = await h.router.certifier.getPublicKey({ identityKey: true });
  assert.equal(manifest.metanet.trust.publicKey, certifierKey);

  for (const [q, handle, key] of [["alpha", "alpha", alpha], ["david", "david", h.ownerId], ["@David+tag@localhost", "david", h.ownerId]] as const) {
    const r = await fetch(`${manifest.metanet.handles.resolve}?handle=${encodeURIComponent(q)}`);
    assert.equal(r.status, 200);
    const a = await r.json() as Record<string, unknown> & { certificate: Certificate };
    // What 1sat-sdk's resolveHandle checks: the version's major, the subject.
    assert.equal(manifest.metanet.handles.version.split(".")[0], "1");
    assert.equal(a.certificate.subject, a.identityKey);
    // §5.2.
    assert.deepEqual({ ...a, certificate: undefined }, { metanetHandles: "1.0", handle, domain: "localhost", identityKey: key, certificate: undefined, messagebox: h.origin(handle), ttl: RESOLUTION_TTL, revoked: false });
    // §4.1: the type, the certifier the manifest names, the fields, the signature.
    const c = a.certificate;
    assert.equal(c.type, HANDLE_CERTIFICATE_TYPE);
    assert.equal(c.certifier, manifest.metanet.trust.publicKey);
    assert.equal(unb64(c.fields.handle!), handle);
    assert.equal(unb64(c.fields.domain!), "localhost");
    assert.equal(c.revocationOutpoint, NO_REVOCATION_OUTPOINT);
    assert.equal(await new Certificate(c.type, c.serialNumber, c.subject, c.certifier, c.revocationOutpoint, c.fields, c.signature).verify(), true);
  }

  const missing = await fetch(`${h.base}/.well-known/metanet-handles/resolve?handle=nobody`);
  assert.equal(missing.status, 404);
  assert.deepEqual(((await missing.json()) as { error: { code: string } }).error.code, "handle-not-found");
  const empty = await fetch(`${h.base}/.well-known/metanet-handles/resolve`);
  assert.equal(empty.status, 400);
  assert.deepEqual(await empty.json(), { metanetHandles: "1.0", error: { code: "malformed-handle", message: "want ?handle=<handle>" } });
});

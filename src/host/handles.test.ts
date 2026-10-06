// BRC-169 as a host answers it (#100, #103, #104, #113): the type identifier
// and the SDK's signing against the spec's worked example (§4.5, A.3); the
// certifier (handles.ts): the resolver's copy and the holder's copy of one
// binding under the serial number it is given, and its `issue` answer. Then
// the host skein's onboarding app as the host's BRC-169 server, end to end:
// the manifest (§5.1: the certifier key from its address book, the host's
// name, note and icon from its config, the endpoints on the host's origin),
// a resolution (§5.2) of a registered handle checked as a resolver checks it,
// §5.3's errors; the holder's signed profile kept by the app (POST
// /account/profile) and served with resolve and search (§5.6).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { outpointToBytes } from "@1sat/templates";
import { decodeProfile, encodeProfile } from "@1sat/utils";
import { AuthFetch, Certificate, MasterCertificate, PrivateKey, ProtoWallet, Utils } from "@bsv/sdk";
import { ephemeralWallet } from "../wallet.ts";
import { certify, HANDLE_CERTIFICATE_TYPE, issueHandleCertificate, issueSubjectCertificate, NO_REVOCATION_OUTPOINT } from "./handles.ts";
import { KERNEL_BIN } from "./kernel.ts";
import { Signer } from "./signer.ts";
import { testHost } from "./testhost.ts";

const b64 = (s: string) => Utils.toBase64(Utils.toArray(s, "utf8"));
const unb64 = (s: string) => Utils.toUTF8(Utils.toArray(s, "base64"));
const serial = () => Utils.toBase64(Array.from(crypto.getRandomValues(new Uint8Array(32))));
const PROFILE_PROTOCOL: [1, string] = [1, "metanet handles profile"];

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

test("handles: the resolver's copy verifies against the certifier key, under the serial it is given, with the disabled revocation outpoint", async () => {
  const certifierKey = new Signer(PrivateKey.fromRandom()).certifierKey();
  const certifier = new ProtoWallet(certifierKey);
  const subject = PrivateKey.fromRandom().toPublicKey().toString();
  const sn = serial();
  const c = await issueHandleCertificate(certifier, "david", "skein.nexus", subject, sn);
  assert.equal(c.type, HANDLE_CERTIFICATE_TYPE);
  assert.equal(c.subject, subject);
  assert.equal(c.certifier, certifierKey.toPublicKey().toString());
  assert.equal(c.serialNumber, sn);
  assert.deepEqual(c.fields, { handle: b64("david"), domain: b64("skein.nexus") });
  assert.equal(c.revocationOutpoint, NO_REVOCATION_OUTPOINT);
  assert.equal(NO_REVOCATION_OUTPOINT, "0000000000000000000000000000000000000000000000000000000000000000.0");
  assert.equal(await c.verify(), true);
  const j = JSON.parse(JSON.stringify(c)) as Certificate;
  assert.equal(await new Certificate(j.type, j.serialNumber, j.subject, j.certifier, j.revocationOutpoint, j.fields, j.signature).verify(), true);
  // Deterministic for one serial; another serial is another certificate; a tampered field does not verify.
  assert.equal((await issueHandleCertificate(certifier, "david", "skein.nexus", subject, sn)).signature, c.signature);
  assert.notEqual((await issueHandleCertificate(certifier, "david", "skein.nexus", subject, serial())).signature, c.signature);
  assert.equal(await new Certificate(c.type, c.serialNumber, c.subject, c.certifier, c.revocationOutpoint, { ...c.fields, handle: b64("mallory") }, c.signature).verify(), false);
});

test("handles: the holder's copy (#103) is the binding's certificate with encrypted fields and a keyring for its subject; only the subject reads it", async () => {
  const certifier = new ProtoWallet(new Signer(PrivateKey.fromRandom()).certifierKey());
  const { publicKey: certifierKey } = await certifier.getPublicKey({ identityKey: true });
  const subjectKey = PrivateKey.fromRandom(), subject = subjectKey.toPublicKey().toString();
  const sn = serial();
  const { certificate: c, keyringForSubject } = await issueSubjectCertificate(certifier, "david", "skein.nexus", subject, sn);
  const plain = await issueHandleCertificate(certifier, "david", "skein.nexus", subject, sn);
  assert.deepEqual([c.type, c.serialNumber, c.subject, c.certifier, c.revocationOutpoint], [plain.type, plain.serialNumber, plain.subject, plain.certifier, plain.revocationOutpoint]);
  assert.deepEqual(Object.keys(keyringForSubject).sort(), ["domain", "handle"]);
  const m = new MasterCertificate(c.type, c.serialNumber, c.subject, c.certifier, c.revocationOutpoint, c.fields, keyringForSubject, c.signature);
  assert.equal(await m.verify(), true);
  assert.deepEqual({ ...await MasterCertificate.decryptFields(new ProtoWallet(subjectKey), keyringForSubject, c.fields, certifierKey) }, { handle: "david", domain: "skein.nexus" });
  await assert.rejects(MasterCertificate.decryptFields(new ProtoWallet(PrivateKey.fromRandom()), keyringForSubject, c.fields, certifierKey));
  const again = await issueSubjectCertificate(certifier, "david", "skein.nexus", subject, sn);
  assert.notEqual(again.certificate.fields.handle, c.fields.handle, "fresh ciphertexts on every issue");
});

test("handles: the certifier provider's issue (#113) — both copies under the serial asked, the issuance echoed; refusals", async () => {
  const certifier = new ProtoWallet(PrivateKey.fromRandom());
  const subject = PrivateKey.fromRandom().toPublicKey();
  const sn = serial();
  const a = await certify(certifier, "issue", { handle: "dave", domain: "skein.nexus", subject: Uint8Array.from(subject.encode(true) as number[]), serialNumber: sn, issuance: "x" }) as { certificate: Certificate; holder: { certificate: Certificate; keyringForSubject: Record<string, string> }; serialNumber: string; issuance: string };
  assert.equal(a.serialNumber, sn);
  assert.equal(a.issuance, "x");
  assert.equal(a.certificate.serialNumber, sn);
  assert.equal(a.holder.certificate.serialNumber, sn);
  assert.equal(a.certificate.subject, subject.toString());
  assert.equal(unb64(a.certificate.fields.handle!), "dave");
  assert.equal(await new Certificate(a.certificate.type, a.certificate.serialNumber, a.certificate.subject, a.certificate.certifier, a.certificate.revocationOutpoint, a.certificate.fields, a.certificate.signature).verify(), true);
  await assert.rejects(certify(certifier, "sign", {}), /box issue/);
  await assert.rejects(certify(certifier, "issue", { handle: "dave", domain: "x", subject: "nope", serialNumber: sn }), /subject/);
  await assert.rejects(certify(certifier, "issue", { handle: "dave", domain: "x", subject: subject.toString(), serialNumber: "short" }), /serialNumber/);
});

test("handles: the host skein serves BRC-169 (#113) — the manifest (the certifier key, the host's name from the app's config), a registered handle's resolution as a resolver checks it, §5.3's errors; the holder's profile kept by the app, served with resolve and search", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built", timeout: 180_000 }, async (t) => {
  const h = await testHost(t);
  await h.hostSkein({ name: "Test host", note: "handles for the tests", icon: "https://example.test/icon.png" });
  const register = async (key: PrivateKey, username: string) => {
    const { signature } = await new ProtoWallet(key).createSignature({ protocolID: [2, "skein register"], keyID: username, counterparty: "anyone", data: Utils.toArray(`register ${username}@localhost`, "utf8") });
    // #135: a registration is a signed request, over the registrant's session with the host's origin.
    const r = await new AuthFetch(ephemeralWallet(key)).fetch(`${h.base}/account/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, identityKey: key.toPublicKey().toString(), signature: Utils.toHex(signature) }) });
    assert.equal(r.status, 200, await r.clone().text());
  };
  const daveKey = PrivateKey.fromRandom(), dave = daveKey.toPublicKey().toString();
  const erinKey = PrivateKey.fromRandom();
  await register(daveKey, "dave");
  await register(erinKey, "erin");

  // §5.1: the trust anchor is the certifier's key (the host skein's address book), the host's presentation the app's config.
  const manifest = await (await fetch(`${h.base}/manifest.json`)).json() as { metanet: { trust: Record<string, string>; handles: { version: string; resolve: string; search: string } } };
  const { publicKey: certifierKey } = await h.router.certifier.getPublicKey({ identityKey: true });
  assert.equal(certifierKey, h.router.providers.key("certifier"), "the certifier key is the certifier provider's");
  assert.deepEqual(manifest.metanet.trust, { name: "Test host", note: "handles for the tests", icon: "https://example.test/icon.png", publicKey: certifierKey });
  assert.deepEqual(manifest.metanet.handles, { version: "1.0", resolve: `${h.base}/.well-known/metanet-handles/resolve`, search: `${h.base}/.well-known/metanet-handles/search` });

  // §5.2, as 1sat-sdk's resolveHandle checks it, and the certificate as §4.1 has it.
  for (const q of ["dave", "@Dave+tag@localhost"]) {
    const r = await fetch(`${manifest.metanet.handles.resolve}?handle=${encodeURIComponent(q)}`);
    assert.equal(r.status, 200);
    const a = await r.json() as Record<string, unknown> & { certificate: Certificate };
    assert.equal(a.certificate.subject, a.identityKey);
    assert.deepEqual({ ...a, certificate: undefined }, { metanetHandles: "1.0", handle: "dave", domain: "localhost", identityKey: dave, certificate: undefined, messagebox: h.origin("dave"), ttl: 300, revoked: false });
    const c = a.certificate;
    assert.equal(c.type, HANDLE_CERTIFICATE_TYPE);
    assert.equal(c.certifier, manifest.metanet.trust.publicKey);
    assert.equal(unb64(c.fields.handle!), "dave");
    assert.equal(unb64(c.fields.domain!), "localhost");
    assert.equal(c.revocationOutpoint, NO_REVOCATION_OUTPOINT);
    assert.equal(await new Certificate(c.type, c.serialNumber, c.subject, c.certifier, c.revocationOutpoint, c.fields, c.signature).verify(), true);
  }
  const missing = await fetch(`${h.base}/.well-known/metanet-handles/resolve?handle=nobody`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { metanetHandles: "1.0", error: { code: "handle-not-found", message: "no handle nobody@localhost here" } });
  assert.equal((await fetch(`${h.base}/.well-known/metanet-handles/resolve?handle=dave@elsewhere.test`)).status, 404, "another domain is not ours");
  const empty = await fetch(`${h.base}/.well-known/metanet-handles/resolve`);
  assert.equal(empty.status, 400);
  assert.deepEqual(await empty.json(), { metanetHandles: "1.0", error: { code: "malformed-handle", message: "want ?handle=<handle>" } });

  const resolve = async (handle: string) => await (await fetch(`${manifest.metanet.handles.resolve}?handle=${handle}`)).json() as Record<string, unknown>;
  const search = async (q: string, limit?: number) => await (await fetch(`${manifest.metanet.handles.search}?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ""}`)).json() as { metanetHandles: string; results: Array<Record<string, unknown>>; truncated: boolean };
  assert.equal((await resolve("dave")).profile, undefined, "no profile yet: none served");

  // The profile (#104): the holder signs the DAG-CBOR record; the page posts it to the host (#113: kept by the app).
  const avatar = `${"ab".repeat(32)}_1`;
  const bytes = Uint8Array.from(encodeProfile({ domain: "localhost", name: "Dave D", avatar: outpointToBytes(avatar)! }));
  const sign = async (key: PrivateKey, b: Uint8Array) => Utils.toHex((await new ProtoWallet(key).createSignature({ protocolID: PROFILE_PROTOCOL, keyID: "1", counterparty: "anyone", data: Array.from(b) })).signature);
  const post = async (body: Record<string, unknown>) => await fetch(`${h.base}/account/profile`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const ok = await post({ handle: "dave", record: Utils.toBase64(Array.from(bytes)), signature: await sign(daveKey, bytes) });
  assert.equal(ok.status, 200, await ok.clone().text());

  const a = await resolve("dave");
  const p = a.profile as { record: string; signature: string; protocolID: [1, string]; keyID: string };
  assert.deepEqual(p.protocolID, PROFILE_PROTOCOL);
  assert.equal(p.keyID, "1");
  assert.deepEqual(Utils.toArray(p.record, "base64"), Array.from(bytes), "the record: the signed DAG-CBOR bytes, base64");
  const v = await new ProtoWallet("anyone").verifySignature({ protocolID: p.protocolID, keyID: p.keyID, counterparty: a.identityKey as string, data: Utils.toArray(p.record, "base64"), signature: Utils.toArray(p.signature, "hex") });
  assert.equal(v.valid, true);
  assert.deepEqual(decodeProfile(Utils.toArray(p.record, "base64")), { domain: "localhost", name: "Dave D", avatar: outpointToBytes(avatar)! });
  assert.equal(a.displayName, "Dave D");
  assert.equal(a.avatarURL, `https://api.1sat.app/content/${avatar}`);

  // Search: by handle, by profile name (any case); the bound; nothing.
  const byName = await search("dave d");
  assert.deepEqual(byName.results.map((r) => [r.handle, r.identityKey, r.displayName, r.avatarURL]), [["dave", dave, "Dave D", `https://api.1sat.app/content/${avatar}`]]);
  assert.deepEqual(byName.results[0]!.profile, a.profile);
  assert.equal(byName.truncated, false);
  assert.deepEqual((await search("ERI")).results.map((r) => r.handle), ["erin"]);
  assert.deepEqual((await search("")).results.map((r) => r.handle), ["dave", "erin"]);
  const one = await search("", 1);
  assert.deepEqual([one.results.map((r) => r.handle), one.truncated], [["dave"], true]);
  assert.deepEqual(await search("nobody"), { metanetHandles: "1.0", results: [], truncated: false });

  // Refused, and nothing changes: another key's signature (401), another domain in the record, a handle not here.
  const forged = await post({ handle: "dave", record: Utils.toBase64(Array.from(bytes)), signature: await sign(erinKey, bytes) });
  assert.equal(forged.status, 401);
  const away = Uint8Array.from(encodeProfile({ domain: "elsewhere.test", name: "Dave D" }));
  assert.equal((await post({ handle: "dave", record: Utils.toBase64(Array.from(away)), signature: await sign(daveKey, away) })).status, 400);
  assert.equal((await post({ handle: "nobody", record: Utils.toBase64(Array.from(bytes)), signature: await sign(daveKey, bytes) })).status, 404);
  assert.deepEqual((await resolve("dave")).profile, a.profile, "the kept profile stands");
});

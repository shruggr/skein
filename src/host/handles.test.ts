// BRC-169 resolution as the host answers it (#100, handles.ts): the type
// identifier and the SDK's signing against the spec's worked example (§4.5,
// A.3), the certificate the host issues, and the router's manifest and
// resolve answer (§5.1–§5.3) checked as a resolver checks them; the holder's
// copy a registration answers with (#103), as a wallet's acquireCertificate
// takes it. The profile (#104): the owner of a mailbox instance signs it and
// writes it there (`objects`, `head profile`); resolve and search serve it;
// the manifest carries the host's name, note and icon and the search URL.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { outpointToBytes } from "@1sat/templates";
import { decodeProfile, encodeProfile } from "@1sat/utils";
import { Certificate, MasterCertificate, PrivateKey, ProtoWallet, Utils } from "@bsv/sdk";
import { RawBox } from "../client/raw.ts";
import { encode } from "../runtime/cid.ts";
import { ephemeralWallet } from "../wallet.ts";
import { HANDLE_CERTIFICATE_TYPE, HANDLES_VERSION, issueHandleCertificate, issueSubjectCertificate, NO_REVOCATION_OUTPOINT, ORDFS_CONTENT, PROFILE_KEY_ID, PROFILE_PROTOCOL, RESOLUTION_TTL, serialOf } from "./handles.ts";
import { KERNEL_BIN } from "./kernel.ts";
import { Oracle } from "./oracle.ts";
import { testHost, until } from "./testhost.ts";

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
  assert.deepEqual(manifest.metanet.trust, { publicKey: certifierKey }, "no SKEIN_HOST_NAME/NOTE/ICON: the trust anchor is the key alone");

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

test("handles: the holder's copy (#103) is the binding's certificate with encrypted fields and a keyring for its subject; only the subject reads it", async () => {
  const certifier = new ProtoWallet(new Oracle(PrivateKey.fromRandom()).certifierKey());
  const { publicKey: certifierKey } = await certifier.getPublicKey({ identityKey: true });
  const subjectKey = PrivateKey.fromRandom(), subject = subjectKey.toPublicKey().toString();
  const { certificate: c, keyringForSubject } = await issueSubjectCertificate(certifier, "david", "id.skein.nexus", subject);
  const plain = await issueHandleCertificate(certifier, "david", "id.skein.nexus", subject);
  // The resolution's binding: type, serial, subject, certifier, revocation outpoint.
  assert.deepEqual([c.type, c.serialNumber, c.subject, c.certifier, c.revocationOutpoint], [plain.type, plain.serialNumber, plain.subject, plain.certifier, plain.revocationOutpoint]);
  assert.deepEqual(Object.keys(keyringForSubject).sort(), ["domain", "handle"]);
  // What acquireCertificate (direct) does with it: a MasterCertificate, verified, its fields decrypted by the subject.
  const fields = c.fields as Record<string, string>;
  const m = new MasterCertificate(c.type as string, c.serialNumber as string, c.subject as string, c.certifier as string, c.revocationOutpoint as string, fields, keyringForSubject, c.signature as string);
  assert.equal(await m.verify(), true);
  assert.deepEqual({ ...await MasterCertificate.decryptFields(new ProtoWallet(subjectKey), keyringForSubject, fields, certifierKey) }, { handle: "david", domain: "id.skein.nexus" });
  await assert.rejects(MasterCertificate.decryptFields(new ProtoWallet(PrivateKey.fromRandom()), keyringForSubject, fields, certifierKey));
  // Issued again: the same serial, fresh ciphertexts.
  const again = await issueSubjectCertificate(certifier, "david", "id.skein.nexus", subject);
  assert.equal(again.certificate.serialNumber, c.serialNumber);
  assert.notEqual((again.certificate.fields as Record<string, string>).handle, fields.handle);
});

test("handles: the profile (#104) — the owner signs it and writes it to the mailbox instance (objects, head profile); resolve carries it and the hints derived from it; search finds it by handle or name; the manifest names the host and the search endpoint", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  const h = await testHost(t, { trust: { name: "Test host", note: "handles for the tests", icon: "https://example.test/icon.png" } });
  const daveKey = PrivateKey.fromRandom(), dave = daveKey.toPublicKey().toString();
  h.mailbox("dave", dave);
  h.mailbox("erin", PrivateKey.fromRandom().toPublicKey().toString());
  await h.router.start();

  const manifest = await (await fetch(`${h.base}/manifest.json`)).json() as { metanet: { trust: Record<string, string>; handles: { search: string } } };
  const { publicKey: certifierKey } = await h.router.certifier.getPublicKey({ identityKey: true });
  assert.deepEqual(manifest.metanet.trust, { name: "Test host", note: "handles for the tests", icon: "https://example.test/icon.png", publicKey: certifierKey });
  assert.equal(manifest.metanet.handles.search, `${h.base}/.well-known/metanet-handles/search`);
  const resolve = async (handle: string) => await (await fetch(`${h.base}/.well-known/metanet-handles/resolve?handle=${handle}`)).json() as Record<string, unknown>;
  const search = async (q: string, limit?: number) => await (await fetch(`${manifest.metanet.handles.search}?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ""}`)).json() as { metanetHandles: string; results: Array<Record<string, unknown>>; truncated: boolean };
  assert.equal((await resolve("dave")).profile, undefined, "no profile yet: none served");

  // The page's shape (skein-site): the DAG-CBOR profile, signed by dave's wallet, put by `objects`, the head moved by `head`.
  const avatar = `${"ab".repeat(32)}_1`;
  const bytes = Uint8Array.from(encodeProfile({ domain: "localhost", name: "Dave D", avatar: outpointToBytes(avatar)! }));
  const wallet = ephemeralWallet(daveKey);
  const { signature } = await wallet.createSignature({ protocolID: PROFILE_PROTOCOL, keyID: PROFILE_KEY_ID, counterparty: "anyone", data: Array.from(bytes) });
  const rec = encode({ profile: bytes, signature: Uint8Array.from(signature) });
  const box = new RawBox(wallet, `${h.base}/@dave`);
  const instance = h.keyOf("dave").toPublicKey().toString();
  await box.send(instance, "objects", { records: [{ cid: rec.cid, bytes: rec.bytes }] });
  await box.send(instance, "head", { name: "profile", tree: rec.cid });
  await h.router.settled();

  const a = await until("the profile in dave's resolution", async () => { const x = await resolve("dave"); return x.profile ? x : undefined; });
  const p = a.profile as { record: string; signature: string; protocolID: [1, string]; keyID: string };
  assert.deepEqual(p.protocolID, [1, "metanet handles profile"]);
  assert.equal(p.keyID, "1");
  assert.deepEqual(Utils.toArray(p.record, "base64"), Array.from(bytes), "the record: the signed DAG-CBOR bytes, base64");
  // As a client verifies it: the handle's identity key, the protocol, anyone's view.
  const v = await new ProtoWallet("anyone").verifySignature({ protocolID: p.protocolID, keyID: p.keyID, counterparty: a.identityKey as string, data: Utils.toArray(p.record, "base64"), signature: Utils.toArray(p.signature, "hex") });
  assert.equal(v.valid, true);
  assert.deepEqual(decodeProfile(Utils.toArray(p.record, "base64")), { domain: "localhost", name: "Dave D", avatar: outpointToBytes(avatar)! });
  assert.equal(a.displayName, "Dave D");
  assert.equal(a.avatarURL, `${ORDFS_CONTENT}/${avatar}`);

  // Search: by handle, by profile name (any case); the bound; nothing.
  const byName = await search("dave d");
  assert.deepEqual(byName.results.map((r) => [r.handle, r.identityKey, r.displayName, r.avatarURL]), [["dave", dave, "Dave D", `${ORDFS_CONTENT}/${avatar}`]]);
  assert.deepEqual(byName.results[0]!.profile, a.profile);
  assert.equal(byName.truncated, false);
  assert.deepEqual((await search("ERI")).results.map((r) => r.handle), ["erin"]);
  assert.deepEqual((await search("")).results.map((r) => r.handle), ["dave", "erin"]);
  const one = await search("", 1);
  assert.deepEqual([one.results.map((r) => r.handle), one.truncated], [["dave"], true]);
  assert.deepEqual(await search("nobody"), { metanetHandles: "1.0", results: [], truncated: false });

  // A record signed by another key is not served: the head moves, nothing is attested.
  const { signature: forged } = await new ProtoWallet(PrivateKey.fromRandom()).createSignature({ protocolID: PROFILE_PROTOCOL, keyID: PROFILE_KEY_ID, counterparty: "anyone", data: Array.from(bytes) });
  const bad = encode({ profile: bytes, signature: Uint8Array.from(forged) });
  await box.send(instance, "objects", { records: [{ cid: bad.cid, bytes: bad.bytes }] });
  await box.send(instance, "head", { name: "profile", tree: bad.cid });
  await h.router.settled();
  await until("the forged profile not served", async () => ((await resolve("dave")).profile === undefined ? true : undefined));
  assert.equal((await search("dave d")).results.length, 0, "and search no longer finds the name");
});

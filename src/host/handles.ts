// The host's BRC-169 certifier (#100, #113; ~/Work/bsv/BRCs peer-to-peer/0169.md
// §4.1, §4.5): the key that signs the handle certificates, and nothing else.
// What a handle is, who holds it, which serial number its certificate gets
// and what was issued when are the host skein's: its onboarding app
// (shruggr/skein-onboard) registers the handle, puts the issuance record,
// takes its hash as the serial number, asks the certifier provider to sign
// (`issue`, providers.ts), and records the answer under its own head. The key
// stays here, outside every instance: the certifier key (signer.ts
// certifierKey: the master secret's child under [2, "skein provider"], key ID
// `certifier`), which the manifest the app serves publishes as
// `metanet.trust.publicKey` (the address book's `certifier` entry).
//
// One issue is two signatures of the same binding (type, serial number,
// subject, certifier, revocation outpoint):
//
// - **The resolver's copy**: `fields.handle` and `fields.domain` Base64 of the
//   plaintext, as in §A.3, not BRC-52 field encryption — resolve answers it to
//   anyone, and a resolver checks the fields against what it resolved (§4.1
//   rule 3). The SDK's Certificate serializes and signs it (BRC-52: protocol
//   [2, "certificate signature"], key ID `<type> <serialNumber>`,
//   counterparty anyone; RFC 6979, so the same bytes for the same binding).
// - **The holder's copy** (#103): BRC-52 field encryption and a keyring for
//   the subject (the SDK's MasterCertificate.issueCertificateForSubject),
//   because a BRC-100 wallet's `acquireCertificate` (direct) takes only that:
//   it rebuilds a MasterCertificate, which wants a keyring entry per field,
//   and decrypts the fields with it. Its field ciphertexts (and so its
//   signature) differ on every issue.
//
// Revocation is not implemented: the host has no wallet. §4.1 wants an
// outpoint the certifier controls and spends on revocation; the certificate
// carries BRC-52's disabled sentinel (64 zeros, vout 0) instead. The
// onboarding app keeps every issue (a new serial each time, the earlier
// records the trail), which is what revocation will need.

import { Certificate, Hash, MasterCertificate, type ProtoWallet, Utils } from "@bsv/sdk";

/** §4.5: the handle-certificate type, base64(SHA-256("metanet-handles handle certificate v1")). */
export const HANDLE_CERTIFICATE_TYPE = Utils.toBase64(Hash.sha256(Utils.toArray("metanet-handles handle certificate v1", "utf8")));

/**
 * The revocation outpoint every certificate carries: BRC-52's disabled
 * sentinel. Revocation not implemented — the host has no wallet (#100).
 */
export const NO_REVOCATION_OUTPOINT = `${"00".repeat(32)}.0`;

/** The well-known paths of BRC-169's resolve (§5.2) and search (§5.6) endpoints, on the host's own origin. */
export const RESOLVE_PATH = "/.well-known/metanet-handles/resolve";
export const SEARCH_PATH = "/.well-known/metanet-handles/search";

/** A certificate as JSON carries it. */
export type CertificateJson = { type: string; serialNumber: string; subject: string; certifier: string; revocationOutpoint: string; fields: Record<string, string>; signature: string };

const KEY = /^0[23][0-9a-f]{64}$/;
const SERIAL = /^[A-Za-z0-9+/]{43}=$/;

const asJson = (c: { type: string; serialNumber: string; subject: string; certifier: string; revocationOutpoint: string; fields: Record<string, string>; signature?: string }): CertificateJson =>
  ({ type: c.type, serialNumber: c.serialNumber, subject: c.subject, certifier: c.certifier, revocationOutpoint: c.revocationOutpoint, fields: { ...c.fields }, signature: c.signature ?? "" });

/** §4.1: the resolver's copy of the certificate for handle@domain → subject under `serialNumber`, signed by the certifier. */
export async function issueHandleCertificate(certifier: ProtoWallet, handle: string, domain: string, subject: string, serialNumber: string): Promise<Certificate> {
  const { publicKey } = await certifier.getPublicKey({ identityKey: true });
  const fields = { handle: Utils.toBase64(Utils.toArray(handle, "utf8")), domain: Utils.toBase64(Utils.toArray(domain, "utf8")) };
  const c = new Certificate(HANDLE_CERTIFICATE_TYPE, serialNumber, subject, publicKey, NO_REVOCATION_OUTPOINT, fields);
  await c.sign(certifier);
  return c;
}

/**
 * The holder's copy (#103, §4.6): the same binding with BRC-52 encrypted
 * fields, and `keyringForSubject` for the wallet's `acquireCertificate`
 * (acquisitionProtocol "direct", keyringRevealer "certifier").
 */
export async function issueSubjectCertificate(certifier: ProtoWallet, handle: string, domain: string, subject: string, serialNumber: string): Promise<{ certificate: CertificateJson; keyringForSubject: Record<string, string> }> {
  const c = await MasterCertificate.issueCertificateForSubject(certifier, subject, { handle, domain }, HANDLE_CERTIFICATE_TYPE, async () => NO_REVOCATION_OUTPOINT, serialNumber);
  return { certificate: asJson(c), keyringForSubject: { ...c.masterKeyring } };
}

/**
 * The certifier provider's work (#113, providers.ts): a message from the
 * host skein in box `issue`, body {handle, domain, subject: bytes(33),
 * serialNumber, issuance?} → {certificate, holder: {certificate,
 * keyringForSubject}, serialNumber, issuance?}. A refusal throws (the
 * provider answers {error}).
 */
export async function certify(certifier: ProtoWallet, box: string, b: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (box !== "issue") throw new Error(`the certifier takes box issue, not ${box}`);
  const handle = typeof b.handle === "string" ? b.handle : "";
  const domain = typeof b.domain === "string" ? b.domain : "";
  const subject = b.subject instanceof Uint8Array ? Buffer.from(b.subject).toString("hex") : typeof b.subject === "string" ? b.subject : "";
  const serialNumber = typeof b.serialNumber === "string" ? b.serialNumber : "";
  if (!handle || !domain) throw new Error("issue wants {handle, domain, subject, serialNumber}");
  if (!KEY.test(subject)) throw new Error("subject: not an identity key (33 bytes)");
  if (!SERIAL.test(serialNumber)) throw new Error("serialNumber: base64 of 32 bytes");
  const plain = await issueHandleCertificate(certifier, handle, domain, subject, serialNumber);
  const holder = await issueSubjectCertificate(certifier, handle, domain, subject, serialNumber);
  return { certificate: asJson(plain as unknown as CertificateJson), holder, serialNumber, ...(b.issuance !== undefined ? { issuance: b.issuance } : {}) };
}

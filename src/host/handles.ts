// BRC-169 resolution as the host answers it (#100; ~/Work/bsv/BRCs
// peer-to-peer/0169.md §4.1, §4.5, §5.1–§5.4): the host is the ecosystem's
// certifier. Its certifier key (oracle.ts certifierKey) is published in the
// manifest as `metanet.trust.publicKey`, and every resolution carries a
// BRC-52 handle certificate it issues for the binding handle@domain → the
// identity host.db names. The SDK's Certificate serializes and signs it
// (BRC-52: protocol [2, "certificate signature"], key ID `<type>
// <serialNumber>`, counterparty anyone).
//
// The fields are Base64 of the plaintext, as in §A.3, not BRC-52 field
// encryption: the resolution is answered to anyone, and a resolver checks
// `fields.handle` and `fields.domain` against what it resolved (§4.1 rule 3).
// The serial number is SHA-256 of `<handle>@<domain> <identityKey>`: one per
// binding, the same on every resolve; the signature is deterministic (RFC
// 6979), so a binding's certificate is the same bytes every time.
//
// Revocation is not implemented: the host has no wallet. §4.1 wants an
// outpoint the certifier controls and spends on revocation; the certificate
// carries BRC-52's disabled sentinel (64 zeros, vout 0) instead. A verifier
// that checks the outpoint (§4.2) finds no UTXO to check.

import { Certificate, Hash, ProtoWallet, Utils } from "@bsv/sdk";

/** §4.5: the handle-certificate type, base64(SHA-256("metanet-handles handle certificate v1")). */
export const HANDLE_CERTIFICATE_TYPE = Utils.toBase64(Hash.sha256(Utils.toArray("metanet-handles handle certificate v1", "utf8")));

/**
 * The revocation outpoint every certificate carries: BRC-52's disabled
 * sentinel. Revocation not implemented — the host has no wallet (#100).
 */
export const NO_REVOCATION_OUTPOINT = `${"00".repeat(32)}.0`;

/** The metanet.handles version this host implements (§5.1), and the resolution's `metanetHandles` (§5.2). */
export const HANDLES_VERSION = "1.0";

/**
 * §5.4: how long a resolution may be cached (s). Five minutes: with no
 * revocation outpoint, the ttl is the only bound on how long a resolver
 * keeps a binding host.db no longer holds.
 */
export const RESOLUTION_TTL = 300;

/** The manifest's `metanet` object (§5.1): the trust anchor (the certifier key) and the resolve endpoint. */
export function manifest(certifier: string, resolve: string): { metanet: { trust: { publicKey: string }; handles: { version: string; resolve: string } } } {
  return { metanet: { trust: { publicKey: certifier }, handles: { version: HANDLES_VERSION, resolve } } };
}

/** The serial number of the certificate for one binding: base64(SHA-256(`<handle>@<domain> <identityKey>`)). */
export function serialOf(handle: string, domain: string, identityKey: string): string {
  return Utils.toBase64(Hash.sha256(Utils.toArray(`${handle}@${domain} ${identityKey}`, "utf8")));
}

/** §4.1: the handle certificate for handle@domain → identityKey, issued and signed by the certifier. */
export async function issueHandleCertificate(certifier: ProtoWallet, handle: string, domain: string, identityKey: string): Promise<Certificate> {
  const { publicKey } = await certifier.getPublicKey({ identityKey: true });
  const fields = { handle: Utils.toBase64(Utils.toArray(handle, "utf8")), domain: Utils.toBase64(Utils.toArray(domain, "utf8")) };
  const c = new Certificate(HANDLE_CERTIFICATE_TYPE, serialOf(handle, domain, identityKey), identityKey, publicKey, NO_REVOCATION_OUTPOINT, fields);
  await c.sign(certifier);
  return c;
}

/** §5.2: the answer for a registered handle. */
export async function resolution(certifier: ProtoWallet, handle: string, domain: string, identityKey: string, messagebox: string): Promise<Record<string, unknown>> {
  const c = await issueHandleCertificate(certifier, handle, domain, identityKey);
  const certificate = { type: c.type, serialNumber: c.serialNumber, subject: c.subject, certifier: c.certifier, revocationOutpoint: c.revocationOutpoint, fields: c.fields, signature: c.signature };
  return { metanetHandles: HANDLES_VERSION, handle, domain, identityKey, certificate, messagebox, ttl: RESOLUTION_TTL, revoked: false };
}

/** §5.3: an error answer's body. */
export function resolutionError(code: "malformed-handle" | "handle-not-found", message: string): Record<string, unknown> {
  return { metanetHandles: HANDLES_VERSION, error: { code, message } };
}

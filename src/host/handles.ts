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
// The holder's copy (#103): the certificate a registration answers with is
// the same binding issued for its subject — BRC-52 field encryption and a
// keyring for the subject (the SDK's MasterCertificate.issueCertificateForSubject),
// because a BRC-100 wallet's `acquireCertificate` (direct) takes only that:
// it rebuilds a MasterCertificate, which wants a keyring entry per field, and
// decrypts the fields with it. Same type, serial and certifier as the
// resolution's; the field ciphertexts (and so the signature) differ on every
// issue. The resolution stays plaintext, so that any resolver can make §4.1's
// check 3.
//
// The profile (#104): the handle holder's signed profile record — the OpNS
// name coin's `profile` value (1sat-sdk#83), DAG-CBOR {domain, name?,
// avatar?} by @1sat/utils' encodeProfile, `avatar` the 36-byte outpoint of an
// image inscription — signed by the holder's identity key with the wallet's
// createSignature under [1, "metanet handles profile"], key ID "1",
// counterparty anyone, over those bytes. The owner of a mailbox instance
// writes it there: `objects` with the record {profile: <the bytes>,
// signature: <DER>}, then `head` `profile` → it (no program). The host reads
// that head from the instance's store and serves it beside the resolution
// and in search (§5.1 item 3: an added field) as `profile: {record:
// <base64 of the DAG-CBOR bytes>, signature: <hex DER>, protocolID, keyID}`
// — only when the signature verifies for the handle's identity key and its
// `domain` is the handle's — plus §5.6's unattested hints derived from it for
// standard clients: `displayName` (the name) and `avatarURL` (the avatar's
// content at an ORDFS gateway).
//
// Revocation is not implemented: the host has no wallet. §4.1 wants an
// outpoint the certifier controls and spends on revocation; the certificate
// carries BRC-52's disabled sentinel (64 zeros, vout 0) instead. A verifier
// that checks the outpoint (§4.2) finds no UTXO to check.

import { outpointFromBytes } from "@1sat/templates";
import { decodeProfile, type Profile } from "@1sat/utils";
import { Certificate, Hash, MasterCertificate, ProtoWallet, Utils } from "@bsv/sdk";

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

/** The well-known paths of the resolve (§5.2) and search (§5.6) endpoints. */
export const RESOLVE_PATH = "/.well-known/metanet-handles/resolve";
export const SEARCH_PATH = "/.well-known/metanet-handles/search";
/** §5.6: the most results a search answers with (the spec's bound), and the default. */
export const SEARCH_MAX = 100;
export const SEARCH_DEFAULT = 20;

/** The host's own presentation in `metanet.trust` (§5.1; SKEIN_HOST_NAME, SKEIN_HOST_NOTE, SKEIN_HOST_ICON): each optional. */
export interface TrustInfo { name?: string; note?: string; icon?: string }

/** The manifest's `metanet` object (§5.1): the trust anchor (the host's name, note and icon when set; the certifier key), the resolve and search endpoints. */
export function manifest(certifier: string, origin: string, trust: TrustInfo = {}): { metanet: { trust: TrustInfo & { publicKey: string }; handles: { version: string; resolve: string; search: string } } } {
  const t: TrustInfo = {};
  for (const k of ["name", "note", "icon"] as const) if (trust[k]) t[k] = trust[k];
  return { metanet: { trust: { ...t, publicKey: certifier }, handles: { version: HANDLES_VERSION, resolve: `${origin}${RESOLVE_PATH}`, search: `${origin}${SEARCH_PATH}` } } };
}

/** The profile signature's protocol and key ID (#104): counterparty anyone, so anyone with the identity key verifies it. */
export const PROFILE_PROTOCOL: [1, string] = [1, "metanet handles profile"];
export const PROFILE_KEY_ID = "1";
/** The head a mailbox instance's owner points at the signed profile record. */
export const PROFILE_HEAD = "profile";
/** Where `avatarURL` points (SKEIN_ORDFS_URL): a public ORDFS gateway's content route, `<base>/<txid>_<vout>`. */
export const ORDFS_CONTENT = "https://api.1sat.app/content";

/** The record the head `profile` names: the DAG-CBOR profile's bytes and the holder's signature over them. */
export interface ProfileRecord { profile: Uint8Array; signature: Uint8Array }

/** A profile as the host serves it: the signed record, and the hints derived from it (§5.6). */
export interface ServedProfile {
  profile: { record: string; signature: string; protocolID: [1, string]; keyID: string };
  displayName?: string;
  avatarURL?: string;
}

/**
 * The signed profile record checked for the handle holder (#104): the
 * signature verifies for `identityKey` under PROFILE_PROTOCOL and the
 * record's `domain` is the handle's. The decoded profile, or undefined.
 */
export async function verifiedProfile(rec: unknown, identityKey: string, domain: string): Promise<Profile | undefined> {
  const r = rec as Partial<ProfileRecord> | null;
  if (!(r?.profile instanceof Uint8Array) || !(r.signature instanceof Uint8Array)) return undefined;
  try {
    const v = await new ProtoWallet("anyone").verifySignature({ protocolID: PROFILE_PROTOCOL, keyID: PROFILE_KEY_ID, counterparty: identityKey, data: Array.from(r.profile), signature: Array.from(r.signature) });
    if (!v.valid) return undefined;
    const p = decodeProfile(Array.from(r.profile));
    return p.domain === domain ? p : undefined;
  } catch { return undefined; }
}

/** The fields a resolution and a search result carry for a verified profile record (#104); {} for none. */
export async function profileFields(rec: unknown, identityKey: string, domain: string, ordfs = ORDFS_CONTENT): Promise<ServedProfile | Record<string, never>> {
  const p = await verifiedProfile(rec, identityKey, domain);
  if (!p) return {};
  const r = rec as ProfileRecord;
  const avatar = p.avatar ? outpointFromBytes(p.avatar) : null;
  return {
    profile: { record: Utils.toBase64(Array.from(r.profile)), signature: Utils.toHex(Array.from(r.signature)), protocolID: PROFILE_PROTOCOL, keyID: PROFILE_KEY_ID },
    ...(p.name ? { displayName: p.name } : {}),
    ...(avatar && ordfs ? { avatarURL: `${ordfs.replace(/\/+$/, "")}/${avatar}` } : {}),
  };
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

/**
 * The handle certificate for its subject to keep (#103, §4.6): the binding's
 * certificate with BRC-52 encrypted fields, and `keyringForSubject` for the
 * wallet's `acquireCertificate` (acquisitionProtocol "direct", keyringRevealer
 * "certifier"). The field values are the plaintext strings.
 */
export async function issueSubjectCertificate(certifier: ProtoWallet, handle: string, domain: string, identityKey: string): Promise<{ certificate: Record<string, unknown>; keyringForSubject: Record<string, string> }> {
  const c = await MasterCertificate.issueCertificateForSubject(certifier, identityKey, { handle, domain }, HANDLE_CERTIFICATE_TYPE, async () => NO_REVOCATION_OUTPOINT, serialOf(handle, domain, identityKey));
  return { certificate: { type: c.type, serialNumber: c.serialNumber, subject: c.subject, certifier: c.certifier, revocationOutpoint: c.revocationOutpoint, fields: c.fields, signature: c.signature }, keyringForSubject: c.masterKeyring };
}

/** §5.2: the answer for a registered handle; `extra`: added fields (§5.1 item 3: the profile, #104). */
export async function resolution(certifier: ProtoWallet, handle: string, domain: string, identityKey: string, messagebox: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const c = await issueHandleCertificate(certifier, handle, domain, identityKey);
  const certificate = { type: c.type, serialNumber: c.serialNumber, subject: c.subject, certifier: c.certifier, revocationOutpoint: c.revocationOutpoint, fields: c.fields, signature: c.signature };
  return { metanetHandles: HANDLES_VERSION, handle, domain, identityKey, certificate, messagebox, ttl: RESOLUTION_TTL, revoked: false, ...extra };
}

/** §5.3: an error answer's body. */
export function resolutionError(code: "malformed-handle" | "handle-not-found", message: string): Record<string, unknown> {
  return { metanetHandles: HANDLES_VERSION, error: { code, message } };
}

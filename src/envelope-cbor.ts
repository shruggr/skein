// BRC-169 §7.3 envelopes — the dag-cbor form (issue #33, #21; BRC-231 bodies):
// the §7.2 members with identity key, contentHash and signature as byte
// strings and `content` the BRC-78 bytes; the signature over SHA-256 of the
// dag-cbor of the map without `content` and `signature` (no canonicalisation
// step: dag-cbor is deterministic). Same signing key as §7.2 (skein's: [2,
// "metanet handles envelope"], key "1", counterparty anyone). A signature is
// over the encoding it was made in, so a relay delivers an envelope in the
// encoding it was submitted in and never transcodes; the kernel keeps each in
// its own form (kernel-zig/src/envelope.zig). A message's id is the CID of its
// signed part as kept.

import { createHash, randomBytes } from "node:crypto";
import * as dagCbor from "@ipld/dag-cbor";
import type { WalletInterface } from "@bsv/sdk";
import { brc78Decode, brc78Encode, ENVELOPE_KEY_ID, ENVELOPE_PROTOCOL, isEnvelope, MESSAGE_ENCRYPTION, signedPart, verify, type Envelope } from "./envelope.ts";
import { verifyAnyone } from "./runtime/identity.ts";
import { encode } from "./runtime/cid.ts";
import { CID } from "multiformats/cid";

export interface CborEnvelope {
  metanetHandles: "1.0";
  recipient: { handle: string; tag?: string; domain: string };
  sender: { identityKey: Uint8Array; handle?: string; domain?: string };
  created: string;
  quoteId?: string;
  contentHash: Uint8Array;
  content: Uint8Array;
  signature: Uint8Array;
}
export type CborSigned = Omit<CborEnvelope, "content">;

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const isBytes = (x: unknown): x is Uint8Array => x instanceof Uint8Array;

export function isCborSigned(x: unknown): x is CborSigned {
  const e = x as CborSigned | null;
  return !!e && typeof e === "object" && e.metanetHandles === "1.0" && !!e.recipient && typeof e.recipient.handle === "string" && typeof e.recipient.domain === "string"
    && !!e.sender && isBytes(e.sender.identityKey) && e.sender.identityKey.length === 33 && typeof e.created === "string"
    && isBytes(e.contentHash) && e.contentHash.length === 32 && isBytes(e.signature);
}
export const isCborEnvelope = (x: unknown): x is CborEnvelope => isCborSigned(x) && isBytes((x as CborEnvelope).content);

/** The preimage: dag-cbor of the envelope without content and signature. */
export function preimage(env: Partial<CborEnvelope>): Uint8Array {
  const { content: _c, signature: _s, ...rest } = env;
  return dagCbor.encode(strip(rest));
}

export function cborSignedPart(env: CborEnvelope | CborSigned): CborSigned {
  const { content: _c, ...rest } = env as CborEnvelope;
  return rest;
}

export function verifyCbor(env: CborEnvelope | CborSigned): boolean {
  if (!isCborSigned(env)) return false;
  const key = hex(env.sender.identityKey);
  const c = (env as CborEnvelope).content;
  if (c !== undefined) {
    try { if (brc78Decode(c).sender !== key) return false; } catch { return false; }
  }
  return verifyAnyone(key, ENVELOPE_PROTOCOL, ENVELOPE_KEY_ID, preimage(env), env.signature);
}

/** Seal `body` (dag-cbor) to `recipient` in the §7.3 form. */
export async function sealCbor(wallet: WalletInterface, args: { recipient: { identityKey: string; handle: string; domain: string }; sender?: { handle?: string; domain?: string }; body: Uint8Array; created?: string }): Promise<CborEnvelope> {
  const { publicKey: me } = await wallet.getPublicKey({ identityKey: true });
  const unsigned = strip({
    metanetHandles: "1.0" as const,
    recipient: { handle: args.recipient.handle, domain: args.recipient.domain },
    sender: { identityKey: Uint8Array.from(Buffer.from(me, "hex")), handle: args.sender?.handle, domain: args.sender?.domain },
    created: args.created ?? new Date().toISOString(),
    contentHash: Uint8Array.from(createHash("sha256").update(args.body).digest()),
  });
  const hash = [...createHash("sha256").update(preimage(unsigned)).digest()];
  const { signature } = await wallet.createSignature({ hashToDirectlySign: hash, protocolID: ENVELOPE_PROTOCOL, keyID: ENVELOPE_KEY_ID, counterparty: "anyone" });
  const keyId = new Uint8Array(randomBytes(32));
  const { ciphertext } = await wallet.encrypt({ protocolID: MESSAGE_ENCRYPTION, keyID: Buffer.from(keyId).toString("base64"), counterparty: args.recipient.identityKey, plaintext: [...args.body] });
  const content = brc78Encode({ sender: me, recipient: args.recipient.identityKey, keyId, ciphertext: Uint8Array.from(ciphertext) });
  return { ...unsigned, content, signature: Uint8Array.from(signature) } as CborEnvelope;
}

/** Decrypt a §7.3 envelope's content as its recipient; checked against contentHash. */
export async function openCbor(wallet: WalletInterface, env: CborEnvelope): Promise<{ body: Uint8Array; senderIdentityKey: string }> {
  const m = brc78Decode(env.content);
  const { publicKey: me } = await wallet.getPublicKey({ identityKey: true });
  if (m.recipient !== me) throw new Error(`envelope: addressed to ${m.recipient}, not this wallet (${me})`);
  const { plaintext } = await wallet.decrypt({ protocolID: MESSAGE_ENCRYPTION, keyID: Buffer.from(m.keyId).toString("base64"), counterparty: m.sender, ciphertext: [...m.ciphertext] });
  const body = Uint8Array.from(plaintext);
  if (!Buffer.from(createHash("sha256").update(body).digest()).equals(Buffer.from(env.contentHash))) throw new Error("envelope: the content does not match its signed contentHash");
  return { body, senderIdentityKey: m.sender };
}

/** Either form: what a recipient needs from an envelope it was handed. */
export type AnyEnvelope = Envelope | CborEnvelope;

export function formOf(x: unknown): "json" | "cbor" | undefined {
  if (isCborEnvelope(x)) return "cbor";
  if (isEnvelope(x)) return "json";
  return undefined;
}

/** The sender's identity key (hex), the recipient (hex, from BRC-78), whether the signature verifies, the signed part and the message id (its CID as kept). */
export function inspect(env: AnyEnvelope): { form: "json" | "cbor"; sender: string; recipient: string; verified: boolean; signed: object; id: CID } {
  if (isCborEnvelope(env)) {
    const signed = cborSignedPart(env);
    return { form: "cbor", sender: hex(env.sender.identityKey), recipient: brc78Decode(env.content).recipient, verified: verifyCbor(env), signed, id: encode(signed).cid };
  }
  const e = env as Envelope;
  const signed = signedPart(e);
  return { form: "json", sender: e.sender.identityKey, recipient: brc78Decode(Buffer.from(e.content, "base64")).recipient, verified: verify(e), signed, id: encode(signed).cid };
}

// ---------------------------------------------------------------- session replies (#33)

/**
 * A reply on a BRC-104 session with the recipient's native messagebox: the
 * compact §7.3 form, {type: "reply", replyTo, body} — sender, recipient,
 * host and the envelope signature left out, because the session supplies
 * them. It travels as BRC-231 bytes (so the signed request carries the body
 * itself). The first message on a session, and anything for an external box,
 * is a full envelope.
 */
export interface CompactReply { type: "reply"; replyTo: CID; body: Uint8Array }

export function isCompactReply(x: unknown): x is CompactReply {
  const r = x as CompactReply | null;
  return !!r && typeof r === "object" && !(r instanceof Uint8Array) && r.type === "reply" && CID.asCID(r.replyTo) !== null && isBytes(r.body);
}

/**
 * The record a session reply is kept as — the same entry shape as a full
 * envelope's ({envelope, box, body}), its envelope record carrying the proof:
 * the BRC-104 signature over `payload` (the signed request) with the session
 * nonces; `messageId` is SHA-256 of that payload.
 */
export function sessionRecord(r: CompactReply, sender: string, created: string, s: { payload: Uint8Array; signature: Uint8Array; nonce: string; yourNonce: string }) {
  return {
    type: "reply" as const, replyTo: r.replyTo, sender: { identityKey: Uint8Array.from(Buffer.from(sender, "hex")) }, created,
    contentHash: Uint8Array.from(createHash("sha256").update(r.body).digest()),
    messageId: Uint8Array.from(createHash("sha256").update(s.payload).digest()),
    session: { payload: s.payload, signature: s.signature, nonce: s.nonce, yourNonce: s.yourNonce },
  };
}

/** How a JSON client carries §7.3 bytes in a BRC-33 JSON body: {"dag-cbor": "<base64>"}. */
export const wrapCbor = (env: CborEnvelope): { "dag-cbor": string } => ({ "dag-cbor": Buffer.from(dagCbor.encode(env)).toString("base64") });

/**
 * A BRC-33 body as an envelope: §7.3 dag-cbor (its bytes, as BRC-231 carries
 * them, or `{"dag-cbor": "<base64>"}`, how a JSON client carries those bytes,
 * or the decoded map), or §7.2 JSON (the object, or its JSON text).
 */
export function asEnvelope(raw: unknown): AnyEnvelope | undefined {
  let v: unknown = raw;
  try {
    for (let i = 0; i < 2 && typeof v === "string"; i++) v = JSON.parse(v);
  } catch { return undefined; }
  const wrapped = v && typeof v === "object" && !(v instanceof Uint8Array) ? (v as Record<string, unknown>)["dag-cbor"] : undefined;
  if (typeof wrapped === "string") v = Uint8Array.from(Buffer.from(wrapped, "base64"));
  if (v instanceof Uint8Array) {
    const bytes = v;
    try { v = dagCbor.decode(bytes); } catch {
      try { v = JSON.parse(new TextDecoder().decode(bytes)); } catch { return undefined; }
    }
  }
  if (isCborEnvelope(v) || isEnvelope(v)) return v as AnyEnvelope;
  return undefined;
}

function strip<T>(v: T): T {
  if (v === null || typeof v !== "object" || Array.isArray(v) || v instanceof Uint8Array) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = strip(x);
  return out as T;
}

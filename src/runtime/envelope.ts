// BRC-169 §7.2 envelopes: the shape and the checks that need no wallet —
// the signed part, contentHash, RFC 8785 canonical form, BRC-78 framing, the
// signature against sender.identityKey. src/envelope.ts adds the wallet
// operations (sign, encrypt, open) for the client and the peers. See
// src/envelope.ts for the wire format.

import { createHash } from "node:crypto";
import type { WalletProtocol } from "@bsv/sdk";
import { verifyAnyone } from "./identity.ts";

export const ENVELOPE_PROTOCOL: [2, "metanet handles envelope"] = [2, "metanet handles envelope"];
export const ENVELOPE_KEY_ID = "send";
export const MESSAGE_ENCRYPTION: WalletProtocol = [2, "message encryption"];
export const BRC78_VERSION = Uint8Array.of(0x42, 0x42, 0x10, 0x33);

export interface Envelope {
  metanetHandles: "1.0";
  recipient: { handle: string; tag?: string; domain: string };
  sender: { identityKey: string; handle?: string; domain?: string };
  created: string; // ISO 8601
  quoteId?: string;
  payment?: unknown;
  contentHash: string; // hex SHA-256 of the plaintext content
  content: string;   // base64 of BRC-78 bytes
  signature: string; // hex DER
}

/** The sender-signed part: the envelope without its wire encryption. What an instance keeps. */
export type Signed = Omit<Envelope, "content">;

export function signedPart(env: Envelope | Signed): Signed {
  const { content: _c, ...rest } = env as Envelope;
  return rest;
}

/** hex SHA-256 of the plaintext content. */
export const contentHash = (body: Uint8Array): string => createHash("sha256").update(body).digest("hex");

// ---------------------------------------------------------------- RFC 8785

/**
 * RFC 8785 (JCS) canonical JSON of the envelope without `content` and
 * `signature`: keys sorted by UTF-16 code units, no whitespace, strings and
 * numbers as ECMAScript JSON.stringify writes them (which is what JCS
 * specifies). Undefined members are omitted.
 */
export function canonical(env: Partial<Envelope>): string {
  const { content: _c, signature: _s, ...rest } = env as Envelope;
  return jcs(rest);
}

export function jcs(v: unknown): string {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new TypeError("JCS: non-finite number");
    return JSON.stringify(v); // ES Number::toString, -0 → "0": exactly JCS
  }
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : jcs(x))).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort(); // default sort compares UTF-16 code units
    return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs(o[k])}`).join(",")}}`;
  }
  throw new TypeError(`JCS: cannot canonicalize ${typeof v}`);
}

// ---------------------------------------------------------------- BRC-78

export interface Brc78 {
  version: Uint8Array; // 4 bytes, 0x42421033
  sender: string;      // compressed identity key, hex
  recipient: string;
  keyId: Uint8Array;   // 32 bytes
  ciphertext: Uint8Array;
}

export function brc78Encode(m: { sender: string; recipient: string; keyId: Uint8Array; ciphertext: Uint8Array }): Uint8Array {
  if (m.keyId.length !== 32) throw new TypeError("BRC-78: key id must be 32 bytes");
  const s = Buffer.from(m.sender, "hex"), r = Buffer.from(m.recipient, "hex");
  if (s.length !== 33 || r.length !== 33) throw new TypeError("BRC-78: identities must be 33-byte compressed keys");
  return Buffer.concat([BRC78_VERSION, s, r, m.keyId, m.ciphertext]);
}

export function brc78Decode(bytes: Uint8Array): Brc78 {
  if (bytes.length < 4 + 33 + 33 + 32 + 32) throw new TypeError("BRC-78: too short");
  const version = bytes.subarray(0, 4);
  if (!Buffer.from(version).equals(BRC78_VERSION)) throw new TypeError(`BRC-78: version ${Buffer.from(version).toString("hex")}, want 42421033`);
  return {
    version,
    sender: Buffer.from(bytes.subarray(4, 37)).toString("hex"),
    recipient: Buffer.from(bytes.subarray(37, 70)).toString("hex"),
    keyId: bytes.subarray(70, 102),
    ciphertext: bytes.subarray(102),
  };
}

// ---------------------------------------------------------------- verify

/**
 * The signature against sender.identityKey, with no wallet: the signing key is
 * derived per BRC-42 (invoice "2-metanet handles envelope-1", counterparty
 * anyone). Also checks the shape, and, when `content` is present, that the
 * BRC-78 content names the same sender. Works on the signed part alone.
 */
export function verify(env: Envelope | Signed): boolean {
  if (!isSigned(env)) return false;
  if ("content" in env && env.content !== undefined) {
    try {
      if (typeof env.content !== "string" || brc78Decode(Buffer.from(env.content, "base64")).sender !== env.sender.identityKey) return false;
    } catch {
      return false;
    }
  }
  return verifyAnyone(env.sender.identityKey, ENVELOPE_PROTOCOL, ENVELOPE_KEY_ID, Buffer.from(canonical(env), "utf8"), Buffer.from(env.signature, "hex"));
}

const KEY = /^0[23][0-9a-f]{64}$/;

export function isSigned(x: unknown): x is Signed {
  const e = x as Partial<Envelope> | null;
  return !!e && typeof e === "object" && e.metanetHandles === "1.0"
    && !!e.recipient && typeof e.recipient.handle === "string" && typeof e.recipient.domain === "string"
    && (e.recipient.tag === undefined || typeof e.recipient.tag === "string")
    && !!e.sender && typeof e.sender.identityKey === "string" && KEY.test(e.sender.identityKey)
    && typeof e.created === "string" && typeof e.contentHash === "string" && /^[0-9a-f]{64}$/.test(e.contentHash)
    && typeof e.signature === "string" && /^[0-9a-f]+$/i.test(e.signature);
}

export function isEnvelope(x: unknown): x is Envelope {
  return isSigned(x) && typeof (x as Partial<Envelope>).content === "string";
}


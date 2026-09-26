// BRC-169 §7.2 envelopes, as skein sends and receives them (docs/MESSAGES.md).
// Shared by the client (src/client) and the instance's edge
// (src/runtime/inbox.ts). Outside src/runtime: sealing draws a random BRC-78
// key id and reads the clock for `created`, which the machine never does.
//
//   contentHash  hex SHA-256 of the plaintext content (the dag-cbor body): in
//              the signed part, so the sender's signature covers the content
//              and anyone holding the plaintext can check who wrote it.
//   content    base64 of a BRC-78 portable encrypted message: version
//              0x42421033, sender identity (33), recipient identity (33), key id
//              (32, random per message), then the wallet's ciphertext under
//              protocol [2, "message encryption"], keyID base64(key id),
//              counterparty the recipient (AES-256-GCM, IV prepended).
//   signature  hex DER, by the sender's wallet under [2, "metanet handles
//              envelope"], key id "1", counterparty anyone, over sha256 of the
//              RFC 8785 canonical envelope without `content` and `signature`.
//              Anyone can derive the key from sender.identityKey (verify()).
//
// The encryption is wire-level only: it keeps the messagebox operator out. The
// recipient keeps the signed part (`Signed`: everything but `content`) and the
// plaintext; its CID is the message's id (`replyTo` names it).

import { createHash, randomBytes } from "node:crypto";
import type { WalletInterface, WalletProtocol } from "@bsv/sdk";
import { verifyAnyone } from "./runtime/identity.ts";

export const ENVELOPE_PROTOCOL: [2, "metanet handles envelope"] = [2, "metanet handles envelope"];
export const ENVELOPE_KEY_ID = "1";
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

// ---------------------------------------------------------------- seal, verify, open

/** A `created` value: ISO 8601 of a time in ms since the epoch. */
export const isoTime = (ms: number): string => new Date(ms).toISOString();

export interface SealArgs {
  recipient: { identityKey: string; handle: string; domain: string };
  sender?: { handle?: string; domain?: string };
  body: Uint8Array; // dag-cbor
  created?: string;
  quoteId?: string;
  payment?: unknown;
}

/** The signed part for `body`: metadata with its contentHash, signed by the wallet. No encryption. */
export async function sign(wallet: WalletInterface, args: SealArgs): Promise<Signed> {
  const { publicKey: me } = await wallet.getPublicKey({ identityKey: true });
  const unsigned: Omit<Envelope, "content" | "signature"> = strip({
    metanetHandles: "1.0" as const,
    recipient: { handle: args.recipient.handle, domain: args.recipient.domain },
    sender: { identityKey: me, handle: args.sender?.handle, domain: args.sender?.domain },
    created: args.created ?? new Date().toISOString(),
    quoteId: args.quoteId,
    payment: args.payment,
    contentHash: contentHash(args.body),
  });
  const hash = [...createHash("sha256").update(canonical(unsigned)).digest()];
  const { signature } = await wallet.createSignature({ hashToDirectlySign: hash, protocolID: ENVELOPE_PROTOCOL, keyID: ENVELOPE_KEY_ID, counterparty: "anyone" });
  return { ...unsigned, signature: Buffer.from(signature).toString("hex") };
}

/** The wire encryption: `body` as BRC-78 content from this wallet to `recipient`, base64. */
export async function encryptContent(wallet: WalletInterface, recipient: string, body: Uint8Array): Promise<string> {
  const { publicKey: me } = await wallet.getPublicKey({ identityKey: true });
  const keyId = new Uint8Array(randomBytes(32));
  const { ciphertext } = await wallet.encrypt({
    protocolID: MESSAGE_ENCRYPTION,
    keyID: Buffer.from(keyId).toString("base64"),
    counterparty: recipient,
    plaintext: [...body],
  });
  return Buffer.from(brc78Encode({ sender: me, recipient, keyId, ciphertext: Uint8Array.from(ciphertext) })).toString("base64");
}

/** sign + encryptContent: the envelope as sent. */
export async function seal(wallet: WalletInterface, args: SealArgs): Promise<Envelope> {
  const signed = await sign(wallet, args);
  return { ...signed, content: await encryptContent(wallet, args.recipient.identityKey, args.body) };
}

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

/**
 * Decrypt `content` as its recipient and check it against `contentHash`.
 * Throws if this wallet is not the recipient, the content was altered, or the
 * plaintext is not what the sender signed.
 */
export async function open(wallet: WalletInterface, env: Envelope): Promise<{ body: Uint8Array; senderIdentityKey: string }> {
  const m = brc78Decode(Buffer.from(env.content, "base64"));
  const { publicKey: me } = await wallet.getPublicKey({ identityKey: true });
  if (m.recipient !== me) throw new Error(`envelope: addressed to ${m.recipient}, not this wallet (${me})`);
  const { plaintext } = await wallet.decrypt({
    protocolID: MESSAGE_ENCRYPTION,
    keyID: Buffer.from(m.keyId).toString("base64"),
    counterparty: m.sender,
    ciphertext: [...m.ciphertext],
  });
  const body = Uint8Array.from(plaintext);
  if (contentHash(body) !== env.contentHash) throw new Error("envelope: the content does not match its signed contentHash");
  return { body, senderIdentityKey: m.sender };
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

function strip<T>(v: T): T {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = strip(x);
  return out as T;
}

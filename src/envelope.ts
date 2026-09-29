// BRC-169 §7.2 envelopes, as skein sends and receives them (docs/MESSAGES.md).
// The wallet operations (sign, encrypt, seal, open) for the client (src/client),
// the peers and the host, over the
// pure part in src/runtime/envelope.ts (re-exported here). Outside
// src/runtime: `seal` draws a random BRC-78 key id and reads the clock for
// `created`, which the machine never does — an instance's own envelopes are
// sealed inside the step by the program (programs/envelope), from the step's
// stamp and random stream, through the wallet import.
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
import type { WalletInterface } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { brc78Decode, brc78Encode, canonical, contentHash, ENVELOPE_KEY_ID, ENVELOPE_PROTOCOL, MESSAGE_ENCRYPTION, signedPart, type Envelope, type Signed } from "./runtime/envelope.ts";

export * from "./runtime/envelope.ts";

// ---------------------------------------------------------------- sign, seal, open

/** A `created` value: ISO 8601 of a time in ms since the epoch. */
/** An envelope's id: CIDv1 dag-cbor, sha2-256 of the dag-cbor encoded signed part (the envelope without `content`). */
export async function envelopeCid(env: Envelope | Signed): Promise<CID> {
  return CID.createV1(dagCbor.code, await sha256.digest(dagCbor.encode(signedPart(env))));
}

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

function strip<T>(v: T): T {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = strip(x);
  return out as T;
}

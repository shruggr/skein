// BRC-103/104 at the host (skein next, SPEC.md sections 2 and 8): the instance holds no session
// table. The host answers the ONE handshake for an instance (POST /.well-known/auth at its origin)
// with the stock @bsv/sdk self-checking nonce (createNonce: 16 random bytes ‖ HMAC [2, "server
// hmac"] under the INSTANCE's key, through the signer the host runs for it), the initial response
// signed as the instance; it keeps the client's handshake nonce in memory only (per instance, the
// bound the front door had: 1024 sessions, the oldest evicted), and signs each reply on that
// session. A signed request on a session the host no longer holds is answered 401 BEFORE the kernel
// is asked (a plain 401: the stock AuthFetch takes it as a stale session and shakes hands again).
// Nothing of a session is logged. The kernel checks every signed request itself: the server nonce
// as the instance's (verifyHmac through the signer) and the signature under [2, "auth message
// signature"], key `<nonce> <yourNonce>` (kernel-zig authfetch.zig, scheduler.zig).
//
// The framing (SimplifiedFetchTransport's): a request signs requestId ‖ method ‖ path ‖ query ‖
// the x-bsv-* (not x-bsv-auth-*), content-type and authorization headers ‖ body; a reply signs
// requestId ‖ status ‖ the x-bsv-* (not x-bsv-auth-*) and authorization headers ‖ body (an absent
// or empty field is varint -1).

import { createNonce, Random, Utils, type WalletInterface } from "@bsv/sdk";

export const AUTH_PROTOCOL: [2, string] = [2, "auth message signature"];
export const AUTH_VERSION = "0.1";
/** The handshake's path at an instance's origin. */
export const HANDSHAKE_PATH = "/.well-known/auth";
/** The sessions the host keeps per instance (the front door's MAX_SESSIONS): the oldest goes first. */
export const MAX_SESSIONS = 1024;

const b64 = (b: Uint8Array | number[]) => Buffer.from(b).toString("base64");
const fromB64 = (s: string) => [...Buffer.from(s, "base64")];
const utf8 = (s: string) => new TextEncoder().encode(s);
const KEY = /^0[23][0-9a-f]{64}$/;

// ---------------------------------------------------------------- SimplifiedFetchTransport's framing

class W {
  parts: number[] = [];
  varint(v: number): void {
    if (v < 0) { this.parts.push(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff); return; } // -1: absent
    if (v < 0xfd) this.parts.push(v);
    else if (v <= 0xffff) this.parts.push(0xfd, v & 0xff, v >> 8);
    else if (v <= 0xffffffff) { const b = Buffer.alloc(4); b.writeUInt32LE(v); this.parts.push(0xfe, ...b); }
    else { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); this.parts.push(0xff, ...b); }
  }
  bytes(b: Uint8Array | number[]): void { for (const x of b) this.parts.push(x); }
  field(b: Uint8Array): void { if (b.length === 0) this.varint(-1); else { this.varint(b.length); this.bytes(b); } }
  out(): Uint8Array { return Uint8Array.from(this.parts); }
}

/** The headers a request signs: x-bsv-* (not x-bsv-auth-*), content-type (its media type), authorization; lower-cased, sorted. */
export function signedRequestHeaders(h: Record<string, string>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k0, v0] of Object.entries(h)) {
    const k = k0.toLowerCase();
    let v = v0;
    if (k === "content-type") v = v.split(";")[0]!.trim();
    if ((k.startsWith("x-bsv-") || k === "content-type" || k === "authorization") && !k.startsWith("x-bsv-auth")) out.push([k, v]);
  }
  return out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The payload a request signs (authfetch.zig requestPayload). */
export function requestPayload(rid: Uint8Array, method: string, path: string, query: string, headers: Record<string, string>, body: Uint8Array): Uint8Array {
  const w = new W();
  w.bytes(rid);
  const m = utf8(method);
  w.varint(m.length); w.bytes(m);
  w.field(utf8(path)); w.field(utf8(query));
  const hs = signedRequestHeaders(headers);
  w.varint(hs.length);
  for (const [k, v] of hs) { const kb = utf8(k), vb = utf8(v); w.varint(kb.length); w.bytes(kb); w.varint(vb.length); w.bytes(vb); }
  w.field(body);
  return w.out();
}

/** A reply's signed headers: x-bsv-* but x-bsv-auth-*, and authorization; lower-cased. */
export function signedResponseHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k0, v] of Object.entries(h)) {
    const k = k0.toLowerCase();
    if ((k.startsWith("x-bsv-") && !k.startsWith("x-bsv-auth")) || k === "authorization") out[k] = v;
  }
  return out;
}

/** The payload a reply signs: request id, status, the signed headers sorted, the body. */
export function responsePayload(rid: Uint8Array, status: number, headers: Record<string, string>, body: Uint8Array): Uint8Array {
  const w = new W();
  w.bytes(rid);
  w.varint(status);
  const hs = Object.entries(signedResponseHeaders(headers)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  w.varint(hs.length);
  for (const [k, v] of hs) { const kb = utf8(k), vb = utf8(v); w.varint(kb.length); w.bytes(kb); w.varint(vb.length); w.bytes(vb); }
  w.field(body);
  return w.out();
}

// ---------------------------------------------------------------- the request's signature layer

/** Whether a request carries BRC-104 headers (x-bsv-auth-*). */
export const isSigned = (headers: Record<string, string>): boolean => Object.keys(headers).some((h) => h.toLowerCase().startsWith("x-bsv-auth-"));

/** The x-bsv-auth-* headers of a signed request, gathered (log.zig's brc104 signature), or a problem. */
export interface Brc104Headers { version: string; identityKey: string; nonce: string; yourNonce: string; requestId: string; signature: string }

export function brc104Headers(h: Record<string, string>): Brc104Headers | { problem: string } {
  const get = (k: string) => h[`x-bsv-auth-${k}`];
  const version = get("version"), identityKey = get("identity-key"), nonce = get("nonce"), yourNonce = get("your-nonce"), requestId = get("request-id"), signature = get("signature");
  if (!version || !identityKey || !nonce || !yourNonce || !requestId || !signature) return { problem: "a BRC-104 request names x-bsv-auth-version, -identity-key, -nonce, -your-nonce, -request-id and -signature" };
  if (!KEY.test(identityKey.toLowerCase())) return { problem: "x-bsv-auth-identity-key: not an identity key (33 bytes, hex)" };
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(signature)) return { problem: "x-bsv-auth-signature: not hex" };
  if (Buffer.from(requestId, "base64").length !== 32) return { problem: "x-bsv-auth-request-id: not 32 bytes (base64)" };
  return { version, identityKey: identityKey.toLowerCase(), nonce, yourNonce, requestId, signature };
}

/** The request record's `signature` for a BRC-104 request (log.zig: brc104). */
export function brc104Signature(a: Brc104Headers): Record<string, unknown> {
  return {
    scheme: "brc104", version: a.version, identityKey: Uint8Array.from(Buffer.from(a.identityKey, "hex")),
    nonce: a.nonce, yourNonce: a.yourNonce, requestId: a.requestId, signature: Uint8Array.from(Buffer.from(a.signature, "hex")),
  };
}

// ---------------------------------------------------------------- the handshake and the sessions

/** A session the host keeps (memory only): the client's identity and its handshake nonce, under our server nonce. */
export interface Session { client: string; clientNonce: string }

/** The sessions, per instance: in memory, at most MAX_SESSIONS each, the oldest evicted. */
export class Sessions {
  private by = new Map<string, Map<string, Session>>();
  readonly max: number;
  constructor(max = MAX_SESSIONS) { this.max = max; }

  get(handle: string, serverNonce: string): Session | undefined { return this.by.get(handle)?.get(serverNonce); }
  put(handle: string, serverNonce: string, s: Session): void {
    let m = this.by.get(handle);
    if (!m) this.by.set(handle, (m = new Map()));
    m.set(serverNonce, s);
    while (m.size > this.max) m.delete(m.keys().next().value!);
  }
  /** Every session of an instance forgotten (a stop; tests: a host that lost them). */
  forget(handle?: string): void { if (handle === undefined) this.by.clear(); else this.by.delete(handle); }
  size(handle: string): number { return this.by.get(handle)?.size ?? 0; }
}

export type HttpAnswer = { status: number; headers: Record<string, string>; body: Uint8Array };

const jsonAnswer = (status: number, v: unknown): HttpAnswer => ({ status, headers: { "content-type": "application/json" }, body: utf8(JSON.stringify(v)) });

/**
 * The handshake (BRC-103 initialRequest → initialResponse), answered for the instance whose signer
 * is `wallet`: the server nonce made by createNonce under the instance's key, the response signed as
 * the instance over clientNonce ‖ serverNonce (key `<clientNonce> <serverNonce>`, counterparty the
 * client), the session kept in `sessions`. Nothing logged.
 */
export async function handshake(sessions: Sessions, handle: string, wallet: WalletInterface, body: Uint8Array): Promise<HttpAnswer> {
  let m: Record<string, unknown>;
  try { m = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>; } catch { return jsonAnswer(400, { status: "error", code: "ERR_BAD_REQUEST", description: "the handshake is a JSON AuthMessage" }); }
  if (!m || typeof m !== "object" || m.messageType !== "initialRequest") return jsonAnswer(400, { status: "error", code: "ERR_BAD_REQUEST", description: "this host takes the initialRequest here (no certificates are requested or sent)" });
  const client = typeof m.identityKey === "string" ? m.identityKey.toLowerCase() : "";
  const clientNonce = typeof m.initialNonce === "string" ? m.initialNonce : "";
  if (!KEY.test(client) || !clientNonce) return jsonAnswer(400, { status: "error", code: "ERR_BAD_REQUEST", description: "an initialRequest names identityKey and initialNonce" });
  const serverNonce = await createNonce(wallet);
  const { signature } = await wallet.createSignature({
    data: [...fromB64(clientNonce), ...fromB64(serverNonce)], protocolID: AUTH_PROTOCOL, keyID: `${clientNonce} ${serverNonce}`, counterparty: client,
  });
  const { publicKey } = await wallet.getPublicKey({ identityKey: true });
  sessions.put(handle, serverNonce, { client, clientNonce });
  return jsonAnswer(200, {
    version: AUTH_VERSION, messageType: "initialResponse", identityKey: publicKey, initialNonce: serverNonce, yourNonce: clientNonce,
    requestedCertificates: { certifiers: [], types: {} }, signature,
  });
}

/** A plain 401 for a session the host does not hold (no x-bsv-auth headers: the stock client shakes hands again). */
export function sessionGone(why = "the session is not known here (shake hands again)"): HttpAnswer {
  return jsonAnswer(401, { status: "error", code: "ERR_SESSION_NOT_FOUND", description: why });
}

/**
 * A reply signed on the request's session: x-bsv-auth-version, -identity-key (the instance), -nonce
 * (fresh), -your-nonce (the client's handshake nonce), -request-id (the request's), -signature over
 * responsePayload with key `<nonce> <clientNonce>`, counterparty the client.
 */
export async function signReply(wallet: WalletInterface, s: Session, requestId: string, a: HttpAnswer): Promise<HttpAnswer> {
  const nonce = b64(Random(32));
  const rid = Uint8Array.from(Buffer.from(requestId, "base64"));
  const data = responsePayload(rid, a.status, a.headers, a.body);
  const { signature } = await wallet.createSignature({ data: [...data], protocolID: AUTH_PROTOCOL, keyID: `${nonce} ${s.clientNonce}`, counterparty: s.client });
  const { publicKey } = await wallet.getPublicKey({ identityKey: true });
  return {
    status: a.status, body: a.body,
    headers: {
      ...a.headers, "x-bsv-auth-version": AUTH_VERSION, "x-bsv-auth-identity-key": publicKey, "x-bsv-auth-nonce": nonce,
      "x-bsv-auth-your-nonce": s.clientNonce, "x-bsv-auth-request-id": requestId, "x-bsv-auth-signature": Utils.toHex(signature),
    },
  };
}

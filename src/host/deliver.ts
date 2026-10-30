// The `deliver` intention (#157): a message to a `mailbox` recipient, carried
// by the HOST — a step never waits on the outside world. The instance's
// delivery thread (programs/messagebox/deliver.zig) emits
//
//   {kind: "event", event: "deliver", app?, transport: "mailbox", url, message: <the mail record>,
//    nonce: bytes(32)}            the nonce: sha256(thread ‖ step ‖ place) — the kernel's
//
// and awaits it. The host makes the exchange the kernel's authfetch used to
// make in the step (kernel-zig/src/authfetch.zig before #157):
//
//   1. BRC-103's handshake at <url>/.well-known/auth, the session kept per
//      (instance, base URL) in memory — made again when the server answers
//      401 (it forgot the session) — its answer's signature checked;
//   2. the BRC-104 request: POST <url>/sendMessage, BRC-231 CBOR {message:
//      {recipient, messageBox, body, subject?, nonce}} (the BRC-33 message and
//      the emit's own subject and nonce: the recipient keeps the record under
//      the same CID), the request id = the event's nonce (so is the request's
//      x-bsv-auth-nonce: everything about it derives from the emit's place),
//      signed by the instance's key through its wallet (the signer the kernel
//      asks), outside any step;
//   3. the answer, as the record the instance admits (box `deliver`): {kind:
//      "delivery", replyTo: <the event>, peer, nonce: <our session nonce>,
//      yourNonce: <the answer's nonce>, signature, status, headers?: <the
//      answer's signed headers>, body} — it stands on its own at the door
//      (door.zig deliveryAnswer: the server's signature over it).
//
// No answer, or an unsigned one (something in front of the server): nothing
// to admit — the thread rests, and the kernel offers the intention again at
// its next start. No timers, no retries but the one fresh handshake a 401 on a
// held session calls for (BRC-103's own).

import type { WalletInterface } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import type { HttpRequest, HttpResponse, MailRecord } from "./providers.ts";

export const AUTH_PROTOCOL: [2, string] = [2, "auth message signature"];
const VERSION = "0.1";

/** The `deliver` event a step records (#157). */
export interface DeliverEvent { kind: "event"; event: "deliver"; transport: string; url: string; message: CID; nonce: Uint8Array; app?: string }

/** The answer the instance admits (box `deliver`). */
export interface DeliveryAnswer {
  kind: "delivery"; replyTo: CID; peer: Uint8Array; nonce: string; yourNonce: string; signature: Uint8Array;
  status: number; headers?: Record<string, string>; body: Uint8Array;
  [k: string]: unknown;
}

type Session = { server: string; ours: string; theirs: string };

const hex = (b: Uint8Array | number[]) => Buffer.from(b).toString("hex");
const b64 = (b: Uint8Array | number[]) => Buffer.from(b).toString("base64");

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
const utf8 = (s: string) => new TextEncoder().encode(s);

/** The headers a request signs: x-bsv-* (not x-bsv-auth*), content-type (its media type), authorization; lower-cased, sorted. */
function signedRequestHeaders(h: Record<string, string>): Array<[string, string]> {
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

/** The answer's signed headers: x-bsv-* but x-bsv-auth-*, and authorization; lower-cased. */
export function signedResponseHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k0, v] of Object.entries(h)) {
    const k = k0.toLowerCase();
    if ((k.startsWith("x-bsv-") && !k.startsWith("x-bsv-auth")) || k === "authorization") out[k] = v;
  }
  return out;
}

/** The payload a response signs (authfetch.zig responsePayload): request id, status, the signed headers sorted, the body. */
export function responsePayload(rid: Uint8Array, status: number, headers: Record<string, string>, body: Uint8Array): Uint8Array {
  const w = new W();
  w.bytes(rid);
  w.varint(status);
  const hs = Object.entries(headers).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  w.varint(hs.length);
  for (const [k, v] of hs) { const kb = utf8(k), vb = utf8(v); w.varint(kb.length); w.bytes(kb); w.varint(vb.length); w.bytes(vb); }
  w.field(body);
  return w.out();
}

// ---------------------------------------------------------------- the carrier

export interface DelivererOptions {
  /** One HTTP exchange (the router's: this host's own URLs in process). */
  http(req: HttpRequest, from: string): Promise<HttpResponse>;
  log?(source: string, line: string): void;
}

export class Deliverer {
  readonly o: DelivererOptions;
  /** BRC-103 sessions, per instance and server base URL, in memory. */
  private sessions = new Map<string, Session>();

  constructor(o: DelivererOptions) { this.o = o; }

  /**
   * Carry one `deliver` event for instance `handle` (its wallet: the instance's key), its mail record
   * and the body's dag-cbor bytes: the answer to admit, or undefined (no answer that stands).
   */
  async carry(handle: string, wallet: WalletInterface, eventCid: CID, ev: DeliverEvent, mail: MailRecord, body: Uint8Array): Promise<DeliveryAnswer | undefined> {
    if (ev.transport !== "mailbox") throw new Error(`deliver: no transport ${ev.transport} here`);
    if (!(ev.nonce instanceof Uint8Array) || ev.nonce.length !== 32) throw new Error("deliver: the event has no 32-byte nonce");
    const base = ev.url.replace(/\/+$/, "");
    const identity = (await wallet.getPublicKey({ identityKey: true })).publicKey;
    const key = `${handle} ${base}`;
    const message: Record<string, unknown> = { recipient: mail.recipient, messageBox: mail.box, body, nonce: mail.nonce };
    if (mail.subject) message.subject = mail.subject;
    const reqBody = dagCbor.encode({ message });
    for (let fresh = false; ; fresh = true) {
      let s = this.sessions.get(key);
      const held = !!s && !fresh;
      if (!s || fresh) {
        s = await this.handshake(handle, wallet, identity, base);
        if (!s) return undefined;
        this.sessions.set(key, s);
      }
      const r = await this.send(handle, wallet, identity, base, s, ev.nonce, reqBody);
      if (!r) return undefined;
      if (r.status === 401 && held) { this.sessions.delete(key); continue; } // the server forgot the session: shake hands again, once
      const sig = r.headers["x-bsv-auth-signature"];
      if (!sig) { this.o.log?.(handle, `deliver → ${base}: HTTP ${r.status}, unsigned: nothing to admit (the thread rests; offered again at the next start)`); return undefined; }
      const from = r.headers["x-bsv-auth-identity-key"] ?? "";
      if (from !== s.server) { this.o.log?.(handle, `deliver → ${base}: the answer is from another identity than the session's: nothing to admit`); return undefined; }
      const headers = signedResponseHeaders(r.headers);
      return {
        kind: "delivery", replyTo: eventCid, peer: Uint8Array.from(Buffer.from(s.server, "hex")), nonce: s.ours, yourNonce: r.headers["x-bsv-auth-nonce"] ?? "",
        signature: Uint8Array.from(Buffer.from(sig, "hex")), status: r.status, ...(Object.keys(headers).length ? { headers } : {}), body: r.body,
      };
    }
  }

  /** BRC-103: our nonce to <base>/.well-known/auth; the answer's signature over both nonces checked. */
  private async handshake(handle: string, wallet: WalletInterface, identity: string, base: string): Promise<Session | undefined> {
    const first = globalThis.crypto.getRandomValues(new Uint8Array(16)).map((b) => 33 + (b % 94)); // printable: the keyID reads the same as UTF-8 on every side
    const { hmac } = await wallet.createHmac({ protocolID: [2, "server hmac"], keyID: new TextDecoder().decode(first), data: [...first], counterparty: "self" });
    const ours = b64([...first, ...hmac]);
    const body = JSON.stringify({ version: VERSION, messageType: "initialRequest", identityKey: identity, initialNonce: ours, requestedCertificates: { certifiers: [], types: {} } });
    let r: HttpResponse;
    try {
      r = await this.o.http({ method: "POST", url: `${base}/.well-known/auth`, headers: { "content-type": "application/json" }, body: utf8(body) }, handle);
    } catch (e) {
      this.o.log?.(handle, `deliver → ${base}: handshake: ${(e as Error).message} (the thread rests)`);
      return undefined;
    }
    if (r.status !== 200) { this.o.log?.(handle, `deliver → ${base}: handshake: HTTP ${r.status} (the thread rests)`); return undefined; }
    let j: { identityKey?: string; initialNonce?: string; yourNonce?: string; signature?: number[] };
    try { j = JSON.parse(new TextDecoder().decode(r.body)); } catch { this.o.log?.(handle, `deliver → ${base}: handshake: the answer is not JSON`); return undefined; }
    if (typeof j.identityKey !== "string" || typeof j.initialNonce !== "string" || j.yourNonce !== ours || !Array.isArray(j.signature)) { this.o.log?.(handle, `deliver → ${base}: handshake: a malformed answer`); return undefined; }
    const data = [...Buffer.from(ours, "base64"), ...Buffer.from(j.initialNonce, "base64")];
    try {
      const { valid } = await wallet.verifySignature({ protocolID: AUTH_PROTOCOL, keyID: `${ours} ${j.initialNonce}`, counterparty: j.identityKey, data, signature: j.signature });
      if (!valid) throw new Error("invalid");
    } catch {
      this.o.log?.(handle, `deliver → ${base}: handshake: the server's signature does not verify`);
      return undefined;
    }
    return { server: j.identityKey, ours, theirs: j.initialNonce };
  }

  /** BRC-104: the request signed on the session (request id and nonce = the event's nonce). Undefined: no answer. */
  private async send(handle: string, wallet: WalletInterface, identity: string, base: string, s: Session, rid: Uint8Array, body: Uint8Array): Promise<HttpResponse | undefined> {
    const u = new URL(base);
    const path = `${u.pathname === "/" ? "" : u.pathname}/sendMessage`;
    const headers: Record<string, string> = { "content-type": "application/cbor" };
    const nonce = b64(rid);
    const payload = requestPayload(rid, "POST", path, "", headers, body);
    const { signature } = await wallet.createSignature({ protocolID: AUTH_PROTOCOL, keyID: `${nonce} ${s.theirs}`, counterparty: s.server, data: [...payload] });
    const all = {
      ...headers, "x-bsv-auth-version": VERSION, "x-bsv-auth-identity-key": identity, "x-bsv-auth-nonce": nonce,
      "x-bsv-auth-your-nonce": s.theirs, "x-bsv-auth-signature": hex(signature), "x-bsv-auth-request-id": nonce,
    };
    try {
      const r = await this.o.http({ method: "POST", url: `${u.origin}${path}`, headers: all, body }, handle);
      const lower: Record<string, string> = {};
      for (const [k, v] of Object.entries(r.headers)) lower[k.toLowerCase()] = v;
      return { status: r.status, headers: lower, body: r.body };
    } catch (e) {
      this.o.log?.(handle, `deliver → ${base}: ${(e as Error).message} (the thread rests; offered again at the next start)`);
      return undefined;
    }
  }
}

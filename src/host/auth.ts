// BRC-103/104 sessions belong to the instance (#33, decided 2026-09-29): the
// router only forwards. Each authentication message for an instance's
// identity — the handshake at `/.well-known/auth`, every signed request, the
// signature on every response — goes into that instance as a plain `event`
// entry in the reserved box `:auth`, where the messagebox program
// (programs/messagebox/auth.zig) verifies and signs through the instance's
// oracle (the kernel's `wallet` import: recorded calls) and keeps the
// sessions as records (head `sessions`). The router awaits the step and reads
// its answer (head `auth`) for the synchronous HTTP reply. It keeps no auth
// state: which instance an HTTP request is for is its route (router.ts
// `front`), and nothing else.
//
// The request payload a general message signs is rebuilt from the raw request
// (method, path, query, the x-bsv-* / content-type / authorization headers,
// the body as sent), as @bsv/sdk's SimplifiedFetchTransport frames it, so a
// JSON body and a BRC-231 CBOR body verify alike; the response payload is
// framed the same way and signed by the instance.

import type { IncomingMessage, ServerResponse } from "node:http";
import { Utils } from "@bsv/sdk";
import type { CID } from "multiformats/cid";
import type { Stamp } from "../runtime/syscalls.ts";
import { admit2, keyHex } from "./genesis.ts";
import type { Kernel } from "./kernel.ts";

/** The reserved box authentication messages are admitted in (a sender-less subscription → the messagebox program). */
export const AUTH_BOX = ":auth";
/** A signed request header by which a client asks for compact (session) messages from the instance on this session. */
export const COMPACT_HEADER = "x-bsv-skein-compact";

/** The BRC-104 general message a request arrived as, and the instance whose session it is. */
export interface Session { payload: Uint8Array; signature: Uint8Array; nonce: string; yourNonce: string; instance: string }

export interface AuthedRequest {
  identityKey: string;
  session: Session;
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  body: Uint8Array;
}

export interface AppResponse {
  status: number;
  /** Content type of `body`; default application/json. */
  type?: string;
  body: Uint8Array | string | object;
}

const bytesOf = (r: AppResponse): { type: string; body: Uint8Array } => {
  if (r.body instanceof Uint8Array) return { type: r.type ?? "application/octet-stream", body: r.body };
  if (typeof r.body === "string") return { type: r.type ?? "text/plain", body: new TextEncoder().encode(r.body) };
  return { type: r.type ?? "application/json", body: new TextEncoder().encode(JSON.stringify(r.body)) };
};

export function send(res: ServerResponse, r: AppResponse, headers: Record<string, string> = {}): void {
  const { type, body } = bytesOf(r);
  res.writeHead(r.status, { ...headers, "content-type": type, "content-length": String(body.length) });
  res.end(body);
}

export const WELL_KNOWN = "/.well-known/auth";

/** An instance's answer to one authentication message (the record its head `auth` names). */
export type Answer = { kind: "auth-answer"; event: CID; op: string; ok: boolean; error?: string } & Record<string, unknown>;

export interface SessionHost {
  /** Run `f` with the instance's kernel, serially with its other admissions. */
  withKernel<T>(handle: string, f: (k: Kernel) => Promise<T>): Promise<T>;
  now(): Stamp;
}

/**
 * One authentication message into the instance, answered: put the event
 * record, admit it in `:auth`, wait for the step, read the answer. Call it
 * inside the instance's serial queue (`ask` does that).
 */
export async function askIn(k: Kernel, record: Record<string, unknown>, now: Stamp): Promise<Answer> {
  const ev = await k.store.put({ kind: "auth", ...record } as never);
  await admit2(k, { box: AUTH_BOX, event: ev } as never, {}, now);
  await k.idle();
  const head = await k.call("head", "auth") as CID | null;
  const answer = head ? await k.store.get(head) as unknown as Answer : undefined;
  if (!answer || !answer.event || !answer.event.equals(ev)) {
    throw new Error("the instance did not answer the authentication message (its genesis must route `:auth` to the messagebox program)");
  }
  return answer;
}

/** The HTTP side of the instances' sessions: the handshake and signed requests, forwarded. */
export class InstanceSessions {
  readonly h: SessionHost;
  constructor(h: SessionHost) { this.h = h; }

  ask(handle: string, record: Record<string, unknown>): Promise<Answer> {
    return this.h.withKernel(handle, (k) => askIn(k, record, this.h.now()));
  }

  /**
   * One HTTP request for `handle`'s identity (its path with any routing
   * prefix removed): the handshake, or a signed request answered by `app` and
   * signed back by the instance, or 401 for one without auth headers.
   */
  async handle(req: IncomingMessage, res: ServerResponse, raw: Uint8Array, handle: string, path: string, app: (r: AuthedRequest) => Promise<AppResponse>): Promise<void> {
    const url = new URL(req.url ?? "/", "http://router");
    if (path === WELL_KNOWN) return this.handshake(res, raw, handle);
    const requestId = req.headers["x-bsv-auth-request-id"];
    if (typeof requestId !== "string") return send(res, { status: 401, body: { status: "error", code: "UNAUTHORIZED", message: "Mutual-authentication failed!" } });
    const h = (k: string) => { const v = req.headers[k]; if (typeof v !== "string" || !v) throw new Error(`missing ${k}`); return v; };
    let m: { identityKey: string; nonce: string; yourNonce: string; signature: Uint8Array; payload: Uint8Array };
    try {
      m = {
        identityKey: h("x-bsv-auth-identity-key"), nonce: h("x-bsv-auth-nonce"), yourNonce: h("x-bsv-auth-your-nonce"),
        signature: Uint8Array.from(Buffer.from(h("x-bsv-auth-signature"), "hex")), payload: requestPayload(req, requestId, path, url.search, raw),
      };
      h("x-bsv-auth-version");
      if (!/^0[23][0-9a-f]{64}$/.test(m.identityKey)) throw new Error("bad identity key");
    } catch {
      return send(res, { status: 400, body: { status: "error", code: "ERR_AUTH_MALFORMED", description: "The authentication request is malformed." } });
    }
    let verified: Answer;
    try {
      verified = await this.ask(handle, { op: "request", identityKey: Uint8Array.from(Buffer.from(m.identityKey, "hex")), nonce: m.nonce, yourNonce: m.yourNonce, signature: m.signature, payload: m.payload });
    } catch (e) {
      return send(res, { status: 500, body: { status: "error", code: "ERR_INTERNAL", description: (e as Error).message } });
    }
    // A plain 401 (no auth headers): the stock client takes it as a stale session and shakes hands again.
    if (!verified.ok) return send(res, { status: 401, body: { status: "error", code: "ERR_AUTH_FAILED", description: `Authentication failed: ${verified.error ?? "refused"}` } });
    let out: AppResponse;
    try {
      const session: Session = { payload: m.payload, signature: m.signature, nonce: m.nonce, yourNonce: m.yourNonce, instance: handle };
      out = await app({ identityKey: m.identityKey, session, method: req.method!, path, query: url.searchParams, headers: req.headers, body: raw });
    } catch (e) {
      out = { status: 500, body: { status: "error", code: "ERR_INTERNAL", description: (e as Error).message } };
    }
    const { type, body } = bytesOf(out);
    const w = new Utils.Writer();
    w.write(Utils.toArray(requestId, "base64"));
    w.writeVarIntNum(out.status);
    w.writeVarIntNum(0);
    if (body.length) { w.writeVarIntNum(body.length); w.write(Array.from(body)); } else w.writeVarIntNum(-1);
    let signed: Answer;
    try {
      signed = await this.ask(handle, { op: "respond", yourNonce: m.yourNonce, payload: Uint8Array.from(w.toArray()) });
      if (!signed.ok) throw new Error(signed.error ?? "refused");
    } catch (e) {
      return send(res, { status: 500, body: { status: "error", code: "ERR_RESPONSE_SIGNING_FAILED", description: (e as Error).message } });
    }
    res.writeHead(out.status, {
      "content-type": type, "content-length": String(body.length),
      "x-bsv-auth-version": "0.1", "x-bsv-auth-identity-key": keyHex(signed.identityKey), "x-bsv-auth-nonce": String(signed.nonce),
      "x-bsv-auth-your-nonce": String(signed.yourNonce), "x-bsv-auth-signature": Buffer.from(signed.signature as Uint8Array).toString("hex"), "x-bsv-auth-request-id": requestId,
    });
    res.end(body);
  }

  private async handshake(res: ServerResponse, raw: Uint8Array, handle: string): Promise<void> {
    try {
      const m = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
      if (typeof m.initialNonce !== "string" && typeof m.nonce !== "string") throw new Error("no nonce");
    } catch {
      return send(res, { status: 400, body: { status: "error", code: "ERR_AUTH_MALFORMED", description: "The BRC-104 handshake message is malformed." } });
    }
    let a: Answer;
    try {
      a = await this.ask(handle, { op: "handshake", message: raw });
    } catch (e) {
      return send(res, { status: 500, body: { status: "error", code: "ERR_INTERNAL", description: (e as Error).message } });
    }
    if (!a.ok) return send(res, { status: 401, body: { status: "error", code: "ERR_AUTH_FAILED", description: `Authentication failed: ${a.error ?? "refused"}` } });
    const signature = Buffer.from(a.signature as Uint8Array);
    const message = {
      version: "0.1", messageType: "initialResponse", identityKey: keyHex(a.identityKey), initialNonce: a.initialNonce, yourNonce: a.yourNonce,
      requestedCertificates: { certifiers: [], types: {} }, signature: [...signature],
    };
    send(res, { status: 200, body: message }, {
      "x-bsv-auth-version": "0.1", "x-bsv-auth-message-type": "initialResponse", "x-bsv-auth-identity-key": message.identityKey,
      "x-bsv-auth-nonce": String(a.initialNonce), "x-bsv-auth-your-nonce": String(a.yourNonce), "x-bsv-auth-signature": signature.toString("hex"),
    });
  }
}

/** The payload a BRC-104 HTTP request signs (SimplifiedFetchTransport's framing), rebuilt from the request as it came. */
export function requestPayload(req: IncomingMessage, requestId: string, path: string, search: string, raw: Uint8Array): Uint8Array {
  const w = new Utils.Writer();
  w.write(Utils.toArray(requestId, "base64"));
  w.writeVarIntNum(req.method!.length);
  w.write(Utils.toArray(req.method!));
  const text = (s: string) => { if (s.length) { const b = Utils.toArray(s); w.writeVarIntNum(b.length); w.write(b); } else w.writeVarIntNum(-1); };
  text(path);
  text(search);
  const included: Array<[string, string]> = [];
  for (const [k0, v] of Object.entries(req.headers)) {
    const k = k0.toLowerCase();
    let value = Array.isArray(v) ? v[0] ?? "" : typeof v === "string" ? v : "";
    if (k === "content-type") value = value.split(";")[0]!.trim();
    if ((k.startsWith("x-bsv-") || k === "content-type" || k === "authorization") && !k.startsWith("x-bsv-auth")) included.push([k, value]);
  }
  included.sort(([a], [b]) => a.localeCompare(b));
  w.writeVarIntNum(included.length);
  for (const [k, v] of included) {
    const kb = Utils.toArray(k, "utf8"), vb = Utils.toArray(v, "utf8");
    w.writeVarIntNum(kb.length); w.write(kb); w.writeVarIntNum(vb.length); w.write(vb);
  }
  if (raw.length) { w.writeVarIntNum(raw.length); w.write(Array.from(raw)); } else w.writeVarIntNum(-1);
  return Uint8Array.from(w.toArray());
}

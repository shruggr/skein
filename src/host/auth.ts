// BRC-103/104 mutual authentication on the server side, over node:http: what
// @bsv/auth-express-middleware does for `1sat serve`, as a transport for
// @bsv/sdk's Peer. The router terminates auth here (#33): one handshake at
// `/.well-known/auth` authenticates a client for every route; each request
// after it is a signed general message whose response is signed back.
//
// The request payload is rebuilt from the raw request bytes (method, path,
// query, the x-bsv-* / content-type / authorization headers, the body as
// sent), so a JSON body and a BRC-231 CBOR body verify alike.

import type { IncomingMessage, ServerResponse } from "node:http";
import { Peer, SessionManager, Utils, normalizeBRC100ByteFields, type AuthMessage, type Transport, type WalletInterface } from "@bsv/sdk";

/** The BRC-104 general message a request arrived as: its signed payload, the signature and the session nonces. */
export interface Session { payload: Uint8Array; signature: Uint8Array; nonce: string; yourNonce: string }

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

const WELL_KNOWN = "/.well-known/auth";
const TIMEOUT_MS = 30_000;

export class AuthServer implements Transport {
  readonly peer: Peer;
  private callback?: (m: AuthMessage) => Promise<void>;
  private handshakes = new Map<string, ServerResponse>();
  private responses = new Map<string, ServerResponse>();

  constructor(wallet: WalletInterface) {
    this.peer = new Peer(wallet, this, undefined, new SessionManager());
  }

  async onData(callback: (m: AuthMessage) => Promise<void>): Promise<void> { this.callback = callback; }

  /** Peer → client: the handshake response, or a signed general response. */
  async send(m: AuthMessage): Promise<void> {
    if (m.messageType !== "general") {
      const res = this.handshakes.get(m.yourNonce!);
      if (!res) throw new Error("no open handshake for this nonce");
      this.handshakes.delete(m.yourNonce!);
      const headers: Record<string, string> = {
        "x-bsv-auth-version": m.version, "x-bsv-auth-message-type": m.messageType, "x-bsv-auth-identity-key": m.identityKey,
        "x-bsv-auth-nonce": m.nonce ?? "", "x-bsv-auth-your-nonce": m.yourNonce ?? "", "x-bsv-auth-signature": Utils.toHex(m.signature ?? []),
      };
      send(res, { status: 200, body: m }, headers);
      return;
    }
    const reader = new Utils.Reader(m.payload!);
    const requestId = Utils.toBase64(reader.read(32));
    const res = this.responses.get(requestId);
    if (!res) throw new Error("no response handle for this request");
    this.responses.delete(requestId);
    const status = reader.readVarIntNum();
    const nHeaders = reader.readVarIntNum();
    const headers: Record<string, string> = {};
    for (let i = 0; i < nHeaders; i++) {
      const k = Utils.toUTF8(reader.read(reader.readVarIntNum()));
      headers[k] = Utils.toUTF8(reader.read(reader.readVarIntNum()));
    }
    const n = reader.readVarIntNum();
    const body = n > 0 ? Uint8Array.from(reader.read(n)) : new Uint8Array();
    const pending = (res as ServerResponse & { __type?: string }).__type ?? "application/json";
    res.writeHead(status, {
      ...headers, "content-type": pending, "content-length": String(body.length),
      "x-bsv-auth-version": m.version, "x-bsv-auth-identity-key": m.identityKey, "x-bsv-auth-nonce": m.nonce ?? "",
      "x-bsv-auth-your-nonce": m.yourNonce ?? "", "x-bsv-auth-signature": Utils.toHex(m.signature ?? []), "x-bsv-auth-request-id": requestId,
    });
    res.end(body);
  }

  /**
   * Handle one HTTP request with its raw body: the handshake, or an
   * authenticated request answered by `app` (whose response is signed), or
   * 401 for one without auth headers.
   */
  async handle(req: IncomingMessage, res: ServerResponse, raw: Uint8Array, app: (r: AuthedRequest) => Promise<AppResponse>): Promise<void> {
    const url = new URL(req.url ?? "/", "http://router");
    if (url.pathname === WELL_KNOWN) return this.handshake(res, raw);
    const requestId = req.headers["x-bsv-auth-request-id"];
    if (typeof requestId !== "string") return send(res, { status: 401, body: { status: "error", code: "UNAUTHORIZED", message: "Mutual-authentication failed!" } });
    const h = (k: string) => { const v = req.headers[k]; if (typeof v !== "string" || !v) throw new Error(`missing ${k}`); return v; };
    let message: AuthMessage;
    try {
      const w = new Utils.Writer();
      w.write(Utils.toArray(requestId, "base64"));
      w.writeVarIntNum(req.method!.length);
      w.write(Utils.toArray(req.method!));
      const text = (s: string) => { if (s.length) { const b = Utils.toArray(s); w.writeVarIntNum(b.length); w.write(b); } else w.writeVarIntNum(-1); };
      text(url.pathname);
      text(url.search);
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
      message = {
        messageType: "general", version: h("x-bsv-auth-version"), identityKey: h("x-bsv-auth-identity-key"),
        nonce: h("x-bsv-auth-nonce"), yourNonce: h("x-bsv-auth-your-nonce"), payload: w.toArray(), signature: Utils.toArray(h("x-bsv-auth-signature"), "hex"),
      };
    } catch {
      return send(res, { status: 400, body: { status: "error", code: "ERR_AUTH_MALFORMED", description: "The authentication request is malformed." } });
    }
    const sessionNonce = message.yourNonce!;
    const verified = new Promise<string>((resolve, reject) => {
      const id = this.peer.listenForGeneralMessages((sender, payload) => {
        if (sender !== message.identityKey || Utils.toBase64(payload.slice(0, 32)) !== requestId) return;
        this.peer.stopListeningForGeneralMessages(id);
        clearTimeout(t);
        resolve(sender);
      });
      const t = setTimeout(() => { this.peer.stopListeningForGeneralMessages(id); reject(new Error("timed out")); }, TIMEOUT_MS);
      this.callback!(message).catch((e: Error) => { this.peer.stopListeningForGeneralMessages(id); clearTimeout(t); reject(e); });
    });
    let identityKey: string;
    try {
      identityKey = await verified;
    } catch {
      return send(res, { status: 401, body: { status: "error", code: "ERR_AUTH_FAILED", description: "Authentication failed." } });
    }
    let out: AppResponse;
    try {
      const session: Session = { payload: Uint8Array.from(message.payload!), signature: Uint8Array.from(message.signature!), nonce: message.nonce!, yourNonce: message.yourNonce! };
      out = await app({ identityKey, session, method: req.method!, path: url.pathname, query: url.searchParams, headers: req.headers, body: raw });
    } catch (e) {
      out = { status: 500, body: { status: "error", code: "ERR_INTERNAL", description: (e as Error).message } };
    }
    const { type, body } = bytesOf(out);
    const w = new Utils.Writer();
    w.write(Utils.toArray(requestId, "base64"));
    w.writeVarIntNum(out.status);
    w.writeVarIntNum(0);
    if (body.length) { w.writeVarIntNum(body.length); w.write(Array.from(body)); } else w.writeVarIntNum(-1);
    (res as ServerResponse & { __type?: string }).__type = type;
    this.responses.set(requestId, res);
    try {
      await this.peer.toPeer(w.toArray(), sessionNonce);
    } catch (e) {
      this.responses.delete(requestId);
      if (!res.headersSent) send(res, { status: 500, body: { status: "error", code: "ERR_RESPONSE_SIGNING_FAILED", description: (e as Error).message } });
    }
  }

  private async handshake(res: ServerResponse, raw: Uint8Array): Promise<void> {
    let m: AuthMessage;
    try {
      m = normalizeBRC100ByteFields(JSON.parse(new TextDecoder().decode(raw)), ["payload", "signature"]) as AuthMessage;
      if (typeof m.initialNonce !== "string" && typeof m.nonce !== "string") throw new Error("no nonce");
    } catch {
      return send(res, { status: 400, body: { status: "error", code: "ERR_AUTH_MALFORMED", description: "The BRC-104 handshake message is malformed." } });
    }
    const key = m.initialNonce ?? m.nonce!;
    this.handshakes.set(key, res);
    setTimeout(() => { if (this.handshakes.get(key) === res) { this.handshakes.delete(key); if (!res.headersSent) send(res, { status: 408, body: { status: "error", code: "ERR_AUTH_TIMEOUT" } }); } }, TIMEOUT_MS).unref();
    try {
      await this.callback!(m);
    } catch {
      this.handshakes.delete(key);
      if (!res.headersSent) send(res, { status: 401, body: { status: "error", code: "ERR_AUTH_FAILED", description: "Authentication failed." } });
    }
  }
}

// Raw BRC-33 on a BRC-104 session (#40): what a client speaks to an
// instance's front door once it knows where it is. No BRC-169 envelope: the
// session proves who sends, the URL is the recipient's messagebox, the body is
// dag-cbor (BRC-231: an application/cbor request, recipient and body as
// bytes). One AuthFetch per box URL — the stock AuthFetch keeps one session
// per origin, so a URL with a `/@<handle>` path prefix (a host's dev form)
// gets its handshake sent under the prefix too.
//
//   const mb = new RawBox(wallet, "http://127.0.0.1:8100/@martha")   (or http://martha.localhost:8100)
//   await mb.send(martha, "chat", {text: "hi"})     → {id}: the message's id (what a reply's replyTo names)
//   await mb.list("chat")                           → [{messageId, sender, body, value}]
//   await mb.ack([messageId])

import { AuthFetch, Peer, SimplifiedFetchTransport, type WalletInterface } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { encode } from "../runtime/cid.ts";

export interface Listed {
  /** The message's id: its record's CID (text). */
  messageId: string;
  /** The sender's identity key (hex). */
  sender: string;
  /** The body's dag-cbor bytes. */
  body: Uint8Array;
  /** The body decoded. */
  value: unknown;
  /** The message itself: its mail record as the messagebox keeps it (a signed one verifies on its own, K2). */
  message?: Record<string, unknown>;
}

const hexOf = (b: Uint8Array): string => Buffer.from(b).toString("hex");

export class RawBox {
  readonly url: string;
  readonly af: AuthFetch;
  private readonly fetchFn: typeof fetch;
  private readonly wallet: WalletInterface;
  private readonly originator?: string;
  private peer?: Promise<void>;

  constructor(wallet: WalletInterface, url: string, o: { fetch?: typeof fetch; originator?: string } = {}) {
    this.url = url.replace(/\/+$/, "");
    const u = new URL(this.url);
    const prefix = u.pathname === "/" ? "" : u.pathname;
    // A bound fetch: the browser's must be called on the window.
    const base = o.fetch ?? (((input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init)) as typeof fetch);
    // AuthFetch shakes hands at <origin>/.well-known/auth: under the path prefix, if the URL has one.
    const f = prefix
      ? ((input: string | URL | Request, init?: RequestInit) => {
          const s = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          const w = new URL(s);
          if (w.origin === u.origin && w.pathname === "/.well-known/auth") w.pathname = `${prefix}/.well-known/auth`;
          return base(input instanceof Request ? new Request(w, input) : w.href, init);
        }) as typeof fetch
      : base;
    this.af = new AuthFetch(wallet, undefined, undefined, o.originator, {}, f);
    this.fetchFn = f;
    this.wallet = wallet;
    this.originator = o.originator;
  }

  /**
   * The session's peer, made here rather than by AuthFetch (#83): the stock
   * AuthFetch's peer keeps the SDK's default cap on a message's payload
   * (16 MiB counted at four per byte: about 4 MiB), and an install's
   * `objects` message carries a module whole (the shell's coreutils is
   * 10 MB). The peer takes `maxGeneralPayloadBytes: null`, the SDK's own
   * option for leaving the capacity to the transport; the receiving front
   * door judges what it takes. Such a request takes seconds to check and
   * send, so it waits up to five minutes (the SDK's default is 30 s).
   */
  private ensurePeer(wallet: WalletInterface, originator?: string): Promise<void> {
    this.peer ??= (async () => {
      const origin = new URL(this.url).origin;
      const peer = new Peer(wallet, new SimplifiedFetchTransport(origin, this.fetchFn, { requestTimeoutMs: 300_000 }), undefined, undefined, undefined, originator, { maxGeneralPayloadBytes: null });
      await peer.ready;
      (this.af.peers as Record<string, unknown>)[origin] = { peer, pendingCertificateRequests: [] };
    })();
    return this.peer;
  }

  private async post(path: string, body: Record<string, unknown>): Promise<{ status: number; v: Record<string, unknown> }> {
    await this.ensurePeer(this.wallet, this.originator);
    const r = await this.af.fetch(`${this.url}${path}`, { method: "POST", headers: { "content-type": "application/cbor" }, body: dagCbor.encode(body) as unknown as BodyInit });
    const bytes = new Uint8Array(await r.arrayBuffer());
    let v: Record<string, unknown> = {};
    try { v = dagCbor.decode(bytes) as Record<string, unknown>; } catch { v = { status: "error", description: new TextDecoder().decode(bytes) }; }
    return { status: r.status, v };
  }

  /**
   * A message to `recipient` (hex) in `box`: `body` a record (encoded here) or its dag-cbor bytes. Its id.
   * `sign`: signed as an emit is (BRC-169's way: [2, "metanet handles envelope"], key "send", counterparty
   * anyone, over the mail record without `signature`), so the record verifies on its own wherever it is
   * carried next — a browser host appends it for its front door (K2), and admits no unsigned message.
   */
  async send(recipient: string, box: string, body: unknown, o: { sign?: boolean } = {}): Promise<{ id: CID }> {
    const bytes = body instanceof Uint8Array ? body : dagCbor.encode(body);
    const to = Uint8Array.from(Buffer.from(recipient, "hex"));
    let signed: Record<string, unknown> = {};
    if (o.sign) {
      const me = (await this.wallet.getPublicKey({ identityKey: true }, this.originator)).publicKey;
      const nonce = globalThis.crypto.getRandomValues(new Uint8Array(16));
      const unsigned = { kind: "mail", op: "put", sender: Uint8Array.from(Buffer.from(me, "hex")), recipient: to, box, body: encode(dagCbor.decode(bytes)).cid, nonce };
      const { signature } = await this.wallet.createSignature({ protocolID: [2, "metanet handles envelope"], keyID: "send", counterparty: "anyone", data: [...dagCbor.encode(unsigned)] }, this.originator);
      signed = { signature: Uint8Array.from(signature), nonce };
    }
    const r = await this.post("/sendMessage", { message: { recipient: to, messageBox: box, body: bytes, ...signed } });
    if (r.status !== 200) throw new Error(`sendMessage ${box}: HTTP ${r.status} ${String(r.v.code ?? "")} ${String(r.v.description ?? "")}`.trim());
    return { id: CID.parse(String(r.v.id ?? r.v.messageId)) };
  }

  /**
   * A BRC-33 request with a JSON body on the session (`path` under the box URL, e.g. "/sendMessage"):
   * what any BRC-100 wallet's BRC-104 client sends (`1sat authfetch POST <origin>/sendMessage --body @file`,
   * the owner's admin messages `skein plan` writes, src/client/admin.ts). The status and the answer's text.
   */
  async postJson(path: string, json: string): Promise<{ status: number; text: string }> {
    await this.ensurePeer(this.wallet, this.originator);
    const r = await this.af.fetch(`${this.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: json });
    return { status: r.status, text: await r.text() };
  }

  /** The messages in the caller's `box`, oldest first. */
  async list(box: string): Promise<Listed[]> {
    const r = await this.post("/listMessages", { messageBox: box });
    if (r.status !== 200) throw new Error(`listMessages ${box}: HTTP ${r.status} ${String(r.v.description ?? "")}`);
    return ((r.v.messages ?? []) as Array<{ messageId: string; sender: Uint8Array; body: Uint8Array; message?: Record<string, unknown> }>).map((m) => ({
      messageId: m.messageId, sender: hexOf(m.sender), body: m.body, value: dagCbor.decode(m.body), ...(m.message ? { message: m.message } : {}),
    }));
  }

  async ack(ids: string[]): Promise<void> {
    if (!ids.length) return;
    const r = await this.post("/acknowledgeMessage", { messageIds: ids });
    if (r.status !== 200) throw new Error(`acknowledgeMessage: HTTP ${r.status} ${String(r.v.description ?? "")}`);
  }
}

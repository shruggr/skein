// The host's providers (#70): recipients with identities of their own, which
// carry an instance's messages out. A step emits a signed message (the
// kernel's `emit`); once its step is committed the kernel hands it here (the
// serve frame `emit`: {message, body, transport, address}) and this module
// delivers it by the address book's transport:
//
//   local    the provider named `address` on this host — handed over directly
//   libp2p   the instance's libp2p node: `topic:<name>` publishes the
//            package, a peer ID gets it as one frame on /skein/message/1.0.0;
//            the libp2p provider answers {replyTo, seqno, recipients} | {replyTo, sent: true}
//
// (A `mailbox` recipient's message never comes here: the instance delivers
// it itself, over its own BRC-103/104 session, through the `fetch` provider.)
//
// Every answer is a signed message from the provider to the instance — the
// same record an `emit` makes, {kind: "mail", op: "put", sender, recipient,
// box, body, signature}, signed under [2, "metanet handles envelope"], key
// "send", counterparty anyone, its body {replyTo: <the message>, …} — appended
// as a `local` request ({kind: "message", message, body}): the instance's
// front door checks it and routes it by `replyTo` to the thread awaiting
// that message. The host verifies nothing of what it carries in; a provider
// does check that a message it is asked to act on is signed by its sender
// and is for it.
//
// The stock providers (box → body → answer body; every answer has `replyTo`,
// and a failure is {replyTo, error}):
//
//   fetch      fetch {method, url, headers?, body?, timeoutMs?}
//              → {status, headers, body}: the HTTP proxy. A URL of this host's own
//              is answered in process (no socket); any other goes out when the host
//              allows it (SKEIN_HTTP=fetch, or the router's `http` option)
//   waker      wake {at: ms}  → at `at`: {at}. What the kernel's `deadline` emits
//   libp2p     publish {topic, body}   → {seqno: bytes(8), recipients}
//              dial {peer, protocol}   → {stream}; then each frame read from the
//                                        stream, in box `frame`: {stream, body}, and
//                                        its end: {stream, closed: true, error?}
//              send {stream, body}     → {}
//              close {stream}          → {}
//   broadcast  broadcast {tx: bytes}   → {status, body}: the host's Arcade's answer to
//                                        POST /tx (arc.ts; 503 when it has none or it is
//                                        unreachable), as the broadcast route answered it (#58)
//              status {txid}           → {status, body}: its GET /tx/<txid>
//
// How this host obtains the providers' keys is its own business (oracle.ts:
// children of its master secret); the instance knows them from its address
// book (the genesis seeds them: `addressBook`, role = the provider's name).

import { randomBytes } from "node:crypto";
import { ProtoWallet, Utils, type PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { encode } from "../runtime/cid.ts";

/** The signing every message gets (BRC-169 §7.2, on skein's mail record). */
export const MESSAGE_PROTOCOL: [2, string] = [2, "metanet handles envelope"];
export const MESSAGE_KEY_ID = "send";
/** The stream protocol a signed message travels on to a libp2p recipient. */
export const MESSAGE_STREAM = "/skein/message/1.0.0";

/** A signed message as the kernel keeps it. */
export interface MailRecord {
  kind: "mail"; op: "put"; sender: Uint8Array; recipient: Uint8Array; box: string; body: CID; subject?: CID; nonce?: Uint8Array; signature: Uint8Array;
  [k: string]: unknown;
}
/** What the kernel hands over (the serve frame `emit`). */
export interface Outgoing { message: MailRecord; body: Uint8Array; transport: string; address: string }

/** The stock providers' names (and the roles the address book gives them). */
export const PROVIDERS = ["fetch", "waker", "libp2p", "broadcast"] as const;
export type ProviderName = typeof PROVIDERS[number];

export type HttpRequest = { method: string; url: string; headers?: Record<string, string>; body?: Uint8Array; timeoutMs?: number };
export type HttpResponse = { status: number; headers: Record<string, string>; body: Uint8Array };

export interface ProvidersOptions {
  /** A provider's key (the reference host: a child of its master secret). */
  keyOf(name: ProviderName): PrivateKey;
  /** Append a signed message (its package) into `handle` as a `local` request. */
  append(handle: string, pkg: { kind: "message"; message: MailRecord; body: Uint8Array }): Promise<unknown>;
  /** The HTTP proxy's network: one request, this host's own URLs in process. */
  fetch(req: HttpRequest, from: string): Promise<HttpResponse>;
  /** The broadcaster (#58's Arcade), when the host has one. */
  broadcast?: { submit(tx: Uint8Array, from: string): Promise<HttpResponse>; status(txid: string, from: string): Promise<HttpResponse> };
  /** The libp2p host, when there is one: the instance's node does the work. */
  p2p?: {
    publish(handle: string, topic: string, body: Uint8Array): Promise<{ seqno: Uint8Array; recipients: number }>;
    dial(handle: string, peer: string, protocol: string, frames: (f: { body: Uint8Array } | { closed: true; error?: string }) => void): Promise<number>;
    send(handle: string, stream: number, body: Uint8Array): Promise<void>;
    close(handle: string, stream: number): Promise<void>;
  };
  /** The clock (ms), as entries are stamped. */
  now(): number;
  log?(source: string, line: string): void;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

export class Providers {
  readonly o: ProvidersOptions;
  private wallets = new Map<string, ProtoWallet>();
  private keys = new Map<string, string>();
  /** Messages taken (handle + CID), so a message handed over again (a kernel's start) is acted on once. */
  private taken = new Set<string>();
  /** The waker's timers, by handle + the wake-me's CID. */
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Messages being carried now, and the waker's answers being appended. */
  private inflight = new Set<Promise<unknown>>();
  private stopped = false;

  constructor(o: ProvidersOptions) { this.o = o; }

  private say(source: string, line: string): void { this.o.log?.(source, line); }

  /** A provider's identity key (hex). */
  key(name: ProviderName): string {
    let k = this.keys.get(name);
    if (!k) this.keys.set(name, (k = this.o.keyOf(name).toPublicKey().toString()));
    return k;
  }

  private wallet(name: ProviderName): ProtoWallet {
    let w = this.wallets.get(name);
    if (!w) this.wallets.set(name, (w = new ProtoWallet(this.o.keyOf(name))));
    return w;
  }

  /** The address book entries a genesis seeds for this host's providers (role = name). */
  entries(names: readonly ProviderName[] = PROVIDERS): Array<{ key: Uint8Array; transport: "local"; address: string; role: string }> {
    return names.map((n) => ({ key: Uint8Array.from(Buffer.from(this.key(n), "hex")), transport: "local" as const, address: n, role: n }));
  }

  /** Stop the timers; nothing more is carried. */
  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** A message from `handle` to carry out (the kernel's `emit` notice). */
  deliver(handle: string, out: Outgoing): void {
    if (this.stopped) return;
    const id = encode(out.message).cid;
    const k = `${handle} ${id}`;
    if (this.taken.has(k)) return;
    this.taken.add(k);
    if (this.taken.size > 100_000) this.taken.delete(this.taken.values().next().value!);
    const p = this.carry(handle, id, out).catch((e) => this.say(handle, `provider: message ${id.toString().slice(-8)}: ${(e as Error).message}`));
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  private track(p: Promise<unknown>): void {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  /** Whether anything is being carried now (a waker's timer is not: it is waiting). */
  busy(): boolean { return this.inflight.size > 0; }

  /** Until what is being carried now is done (tests, the corpus: Router.settled). */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  private async carry(handle: string, id: CID, out: Outgoing): Promise<void> {
    if (out.transport === "libp2p") return await this.libp2pRecipient(handle, id, out);
    if (out.transport !== "local") throw new Error(`no transport ${out.transport} here`);
    const name = out.address as ProviderName;
    if (!PROVIDERS.includes(name)) throw new Error(`no provider ${out.address} on this host`);
    if (hex(out.message.recipient) !== this.key(name)) throw new Error(`the message is not for the ${name} provider`);
    if (!(await this.signed(out))) throw new Error("the message's signature does not verify: not acted on");
    let body: Record<string, unknown>;
    try { body = dagCbor.decode(out.body) as Record<string, unknown>; } catch { return await this.answer(handle, name, out.message, id, { error: "the body is not dag-cbor" }); }
    const box = out.message.box;
    try {
      switch (name) {
        case "fetch": return await this.fetch(handle, out.message, id, box, body);
        case "waker": return this.wake(handle, out.message, id, box, body);
        case "libp2p": return await this.p2p(handle, out.message, id, box, body);
        case "broadcast": return await this.broadcast(handle, out.message, id, box, body);
      }
    } catch (e) {
      await this.answer(handle, name, out.message, id, { error: (e as Error).message });
    }
  }

  /** The sender's signature over the record (BRC-169's way): anyone checks it with the sender's key. */
  private async signed(out: Outgoing): Promise<boolean> {
    const { signature, ...rest } = out.message;
    try {
      const v = await new ProtoWallet("anyone").verifySignature({ protocolID: MESSAGE_PROTOCOL, keyID: MESSAGE_KEY_ID, counterparty: hex(out.message.sender), data: [...dagCbor.encode(rest)], signature: [...signature] });
      return v.valid;
    } catch { return false; }
  }

  /** A signed message from provider `name` to the instance that sent `to`, in `to`'s box: {replyTo, …answer}, appended. */
  async answer(handle: string, name: ProviderName, to: MailRecord, id: CID, answer: Record<string, unknown>, box = to.box): Promise<void> {
    if (this.stopped) return;
    const body = dagCbor.encode({ replyTo: id, ...answer });
    // Its own message (two like answers — two frames alike — are two messages: `nonce`), about what the question was about (`subject`).
    const unsigned = {
      kind: "mail" as const, op: "put" as const, sender: Uint8Array.from(Buffer.from(this.key(name), "hex")), recipient: to.sender, box, body: encode(dagCbor.decode(body)).cid,
      nonce: Uint8Array.from(randomBytes(16)), ...(to.subject ? { subject: to.subject } : {}),
    };
    const { signature } = await this.wallet(name).createSignature({ protocolID: MESSAGE_PROTOCOL, keyID: MESSAGE_KEY_ID, counterparty: "anyone", data: [...dagCbor.encode(unsigned)] });
    const message: MailRecord = { ...unsigned, signature: Uint8Array.from(signature) };
    await this.o.append(handle, { kind: "message", message, body });
  }

  // ---------------------------------------------------------------- fetch: the HTTP proxy

  private async fetch(handle: string, m: MailRecord, id: CID, box: string, b: Record<string, unknown>): Promise<void> {
    if (box !== "fetch") return await this.answer(handle, "fetch", m, id, { error: `the fetch provider takes box "fetch", not ${box}` });
    if (typeof b.method !== "string" || typeof b.url !== "string") return await this.answer(handle, "fetch", m, id, { error: "fetch wants {method, url, headers?, body?, timeoutMs?}" });
    const headers: Record<string, string> = {};
    if (b.headers && typeof b.headers === "object") for (const [k, v] of Object.entries(b.headers as Record<string, unknown>)) if (typeof v === "string") headers[k.toLowerCase()] = v;
    let r: HttpResponse;
    try {
      r = await this.o.fetch({ method: b.method, url: b.url, headers, ...(b.body instanceof Uint8Array ? { body: b.body } : {}), ...(typeof b.timeoutMs === "number" ? { timeoutMs: b.timeoutMs } : {}) }, handle);
    } catch (e) {
      return await this.answer(handle, "fetch", m, id, { error: (e as Error).message });
    }
    await this.answer(handle, "fetch", m, id, { status: r.status, headers: r.headers, body: r.body });
  }

  // ---------------------------------------------------------------- the waker

  private wake(handle: string, m: MailRecord, id: CID, box: string, b: Record<string, unknown>): void {
    if (box !== "wake" || typeof b.at !== "number") { void this.answer(handle, "waker", m, id, { error: "the waker takes {at: ms} in box \"wake\"" }); return; }
    const at = b.at;
    const k = `${handle} ${id}`;
    const fire = () => {
      this.timers.delete(k);
      if (this.o.now() < at) { this.timers.set(k, setTimeout(fire, Math.max(1, at - this.o.now()))); return; }
      this.track(this.answer(handle, "waker", m, id, { at }).catch((e) => this.say(handle, `waker: ${(e as Error).message}`)));
    };
    // A timer's longest wait is about 24.8 days; a later wake waits in steps.
    this.timers.set(k, setTimeout(fire, Math.min(2 ** 31 - 1, Math.max(0, at - this.o.now()) + 1)));
  }

  // ---------------------------------------------------------------- libp2p

  private async p2p(handle: string, m: MailRecord, id: CID, box: string, b: Record<string, unknown>): Promise<void> {
    const p = this.o.p2p;
    if (!p) return await this.answer(handle, "libp2p", m, id, { error: "this host runs no libp2p" });
    switch (box) {
      case "publish": {
        if (typeof b.topic !== "string" || !(b.body instanceof Uint8Array)) return await this.answer(handle, "libp2p", m, id, { error: "publish wants {topic, body}" });
        const r = await p.publish(handle, b.topic, b.body);
        return await this.answer(handle, "libp2p", m, id, { seqno: r.seqno, recipients: r.recipients });
      }
      case "dial": {
        if (typeof b.peer !== "string" || typeof b.protocol !== "string") return await this.answer(handle, "libp2p", m, id, { error: "dial wants {peer, protocol}" });
        // Each frame, and the end, is a message in box `frame` answering the dial: the thread awaits the dial's CID.
        let stream = -1;
        const queue: Array<Record<string, unknown>> = [];
        let ready = false;
        const frames = (f: { body: Uint8Array } | { closed: true; error?: string }) => {
          const x = { ...("body" in f ? { body: f.body } : { closed: true, ...(f.error ? { error: f.error } : {}) }) };
          if (!ready) { queue.push(x); return; }
          this.track(this.answer(handle, "libp2p", m, id, { stream, ...x }, "frame").catch((e) => this.say(handle, `libp2p: frame: ${(e as Error).message}`)));
        };
        stream = await p.dial(handle, b.peer, b.protocol, frames);
        await this.answer(handle, "libp2p", m, id, { stream });
        ready = true;
        for (const x of queue) await this.answer(handle, "libp2p", m, id, { stream, ...x }, "frame");
        return;
      }
      case "send": {
        if (typeof b.stream !== "number" || !(b.body instanceof Uint8Array)) return await this.answer(handle, "libp2p", m, id, { error: "send wants {stream, body}" });
        await p.send(handle, b.stream, b.body);
        return await this.answer(handle, "libp2p", m, id, {});
      }
      case "close": {
        if (typeof b.stream !== "number") return await this.answer(handle, "libp2p", m, id, { error: "close wants {stream}" });
        await p.close(handle, b.stream);
        return await this.answer(handle, "libp2p", m, id, {});
      }
      default:
        return await this.answer(handle, "libp2p", m, id, { error: `the libp2p provider takes publish, dial, send, close: not ${box}` });
    }
  }

  /** A message to a libp2p recipient: its package published on the topic, or written to the peer on MESSAGE_STREAM. */
  private async libp2pRecipient(handle: string, id: CID, out: Outgoing): Promise<void> {
    const p = this.o.p2p;
    const pkg = dagCbor.encode({ message: out.message, body: out.body });
    const fail = (error: string) => this.answer(handle, "libp2p", out.message, id, { error }, "sent");
    if (!p) return await fail("this host runs no libp2p");
    try {
      if (out.address.startsWith("topic:")) {
        const r = await p.publish(handle, out.address.slice("topic:".length), pkg);
        return await this.answer(handle, "libp2p", out.message, id, { seqno: r.seqno, recipients: r.recipients }, "sent");
      }
      const s = await p.dial(handle, out.address, MESSAGE_STREAM, () => {});
      await p.send(handle, s, pkg);
      await p.close(handle, s);
      await this.answer(handle, "libp2p", out.message, id, { sent: true }, "sent");
    } catch (e) {
      await fail((e as Error).message);
    }
  }

  // ---------------------------------------------------------------- the broadcaster

  private async broadcast(handle: string, m: MailRecord, id: CID, box: string, b: Record<string, unknown>): Promise<void> {
    const arc = this.o.broadcast;
    const none = { status: 503, body: Utils.toArray(JSON.stringify({ status: 503, title: "no Arcade", extraInfo: "this host has no Arcade (SKEIN_ARC_URL)" }), "utf8") };
    if (box === "broadcast") {
      if (!(b.tx instanceof Uint8Array)) return await this.answer(handle, "broadcast", m, id, { error: "broadcast wants {tx: bytes}" });
      const r = arc ? await arc.submit(b.tx, handle) : { status: none.status, body: Uint8Array.from(none.body), headers: {} };
      return await this.answer(handle, "broadcast", m, id, { status: r.status, body: r.body });
    }
    if (box === "status") {
      if (typeof b.txid !== "string") return await this.answer(handle, "broadcast", m, id, { error: "status wants {txid}" });
      const r = arc ? await arc.status(b.txid, handle) : { status: none.status, body: Uint8Array.from(none.body), headers: {} };
      return await this.answer(handle, "broadcast", m, id, { status: r.status, body: r.body });
    }
    return await this.answer(handle, "broadcast", m, id, { error: `the broadcaster takes broadcast, status: not ${box}` });
  }
}

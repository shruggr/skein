// The host's providers (#70): recipients with identities of their own, which
// carry an instance's messages out. A step emits a message (the kernel's
// `emit`; unsigned since #126 step 4: the host carries what its own kernel
// hands it); once its step is committed the kernel hands it here (the
// serve frame `emit`: {message, body, transport, address}) and this module
// delivers it by the address book's transport:
//
//   local    the provider named `address` on this host — handed over directly;
//            `self` (#79): a message the instance sent itself (one of its apps to
//            another: the wallet or an overlay to the chain app) — appended
//            back into the same instance
//            as a `local` request, as it is (unsigned: the front door finds the
//            record in the instance's store, its own emit)
//   libp2p   the instance's libp2p node: `topic:<name>` publishes the
//            package, a peer ID gets it as one frame on /skein/message/1.0.0;
//            the libp2p provider answers {replyTo, seqno, recipients} | {replyTo, sent: true}
//   event    (#65, #119, #126) not a message: an event (`address` its name).
//            `broadcast` — {kind: "broadcast", tx: <cid>, beef?}, the
//            transaction's bytes as `body` — to the host's broadcaster (arc.ts: a
//            durable queue, retries, one Arcade session; none: dropped with a line);
//            `subscribe`/`unsubscribe`/`beacon`/`unbeacon` to the libp2p node;
//            `deadline`/`fetch` are intentions (#126): the host signs the request
//            for one with the instance's key and gives it to the service it is
//            wired to (`route`: its waker, its HTTP proxy), whose signed answer
//            names the event and carries the request (intention, below);
//            `payment` (#130) — the kernel's pay step's, the host's own: its
//            billing (billing.ts, Router.payment) keeps and broadcasts it
//
// (A `mailbox` recipient's message never comes here: the instance delivers
// it itself, with the kernel's authfetch, #126.)
//
// Every answer is a signed message from the provider to the instance — the
// record an `emit` makes, {kind: "mail", op: "put", sender, recipient, box,
// body, nonce}, with its `signature` (#126 step 4: a `local` package has no
// session of the instance's to prove its sender), signed under [2, "metanet handles envelope"], key
// "send", counterparty anyone, its body {replyTo: <the message>, …} — appended
// as a `local` request ({kind: "message", message, body}): the instance's
// front door checks it and routes it by `replyTo` to the thread awaiting
// that message. The host verifies nothing of what it carries in; a provider
// checks that a message it is asked to act on is for it (the instance's
// message comes from the instance's own kernel: no signature, #126 step 4).
//
// The stock providers (box → body → answer body; every answer has `replyTo`,
// and a failure is {replyTo, error}):
//
//   fetch      a `fetch` intention's signed request (#126) → {replyTo: <the event>,
//              request, status, headers, body}; a message fetch {method, url,
//              headers?, body?, timeoutMs?, maxBytes?} (a module before skein-sdk
//              0.7.0) → {status, headers, body}: the HTTP proxy. A URL of this host's own
//              is answered in process (no socket); any other goes out when the host
//              allows it (SKEIN_HTTP=fetch, or the router's `http` option). `body`
//              is bytes either way. `maxBytes` (#91): a response body over it is
//              not carried in — the answer is {error} (SKEIN_HTTP=fetch stops
//              reading at the limit)
//   waker      a `deadline` intention's signed request (#126: a step's deadline, a
//              shell's sleep) → at `at`: {replyTo: <the event>, request, at}; a
//              wake-me message wake {at: ms} (a kernel before #126) → {at}
//   cron       cron {fn: "tick", every | at, box, body?, name} → {name, next};
//              then each tick, a message of its own (no `replyTo`) in `box`:
//              {...body, kind: body.kind ?? "cron", name, due}
//              cron {fn: "stop", name} → {name, stopped} (#69, cron.ts)
//   libp2p     publish {topic, body}   → {seqno: bytes(8), recipients}
//              dial {peer, protocol}   → {stream}; then each frame read from the
//                                        stream, in box `frame`: {stream, body}, and
//                                        its end: {stream, closed: true, error?}
//              send {stream, body}     → {}
//              close {stream}          → {}
//   status     takes no messages (#65): it speaks first. Each status of a transaction
//              an instance holds (but a proof: that is an event, arc.ts) is a message
//              from it in box `chain/status` (the chain app's, #128), `subject` the
//              transaction's CID, body {kind: "status", txid, txStatus, blockHash?,
//              blockHeight?, extraInfo?}; an instance admits it only if it has a row from
//              this key on `chain/status`
//   manager    the instance manager (#89, #90): it creates, starts and stops this
//              host's instances. It takes messages from the host skein only (the
//              operator's instance, `skein-host init`): its entry is in the host
//              skein's address book alone, and a message from any other instance
//              or key is not acted on and not answered (a line in the host's log).
//              create {handle, owner, image?, claim} → {handle, identity: bytes(33), url}:
//                     the identity derived, the instance booted from the image
//                     (`default`, the only one so far), `claim` — the owner's own
//                     signed claim {message, body}, naming no recipient (#127) —
//                     forwarded into it, then — claimed — its hostname published
//                     and it started (Router.createInstance). Refused (an answer
//                     {error}): a bad or taken handle, a bad owner key, another
//                     image, no claim, another key's claim, a refused claim
//              start {handle}   → {handle, started: true, url}: published and started
//              stop {handle}    → {handle, stopped: true}: unpublished and stopped
//              create {handle, owner, image: "mailbox", domain?} (#113): a mailbox
//                     instance for `owner` (the front door and the messagebox,
//                     keeping its mail), published at once; the same owner and
//                     handle again: the same answer (it exists). `domain` (both
//                     images): the handle's domain, recorded with the row
//              (`list` later.) It signs no claim (#127): it forwards the owner's,
//              as signed
//   certifier  the host's BRC-169 certifier (#100, #113): the host skein's alone,
//              as the manager. Its key is the certifier key, the manifest's
//              metanet.trust.publicKey (the master's child, key ID `certifier`).
//              issue {handle, domain, subject: bytes(33), serialNumber, issuance?}
//              → {certificate, holder: {certificate, keyringForSubject}, serialNumber,
//              issuance?}: the handle certificate for handle@domain → subject under
//              that serial number, signed — plaintext fields (what resolve answers)
//              and the subject's copy with encrypted fields and its keyring (what a
//              wallet's acquireCertificate takes) — handles.ts. It records nothing:
//              the host skein's onboarding app records the issue
//   billing    (#130) the host's billing key: it takes no messages and is in no address
//              book; it signs the host's ticks to the instances whose host row names it
//              (billing.ts) — the key an owner grants (`skein plan host`)
//
// How this host obtains the providers' keys is its own business (signer.ts:
// children of its master secret); the instance knows them from its address
// book (the genesis seeds them: `addressBook`, transport `local`, address the
// provider's name — no role, #126).

import { randomBytes } from "node:crypto";
import { ProtoWallet, type PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { encode } from "../runtime/cid.ts";

/** The signing a provider's answer and an intention's request get (BRC-169 §7.2, on skein's mail record); an emit is unsigned (#126 step 4). */
export const MESSAGE_PROTOCOL: [2, string] = [2, "metanet handles envelope"];
export const MESSAGE_KEY_ID = "send";
/** The stream protocol a signed message travels on to a libp2p recipient. */
export const MESSAGE_STREAM = "/skein/message/1.0.0";

/** A message as the kernel keeps it: an emit's unsigned, a provider's answer and an intention's request signed. */
export interface MailRecord {
  kind: "mail"; op: "put"; sender: Uint8Array; recipient: Uint8Array; box: string; body: CID; subject?: CID; nonce?: Uint8Array; signature?: Uint8Array;
  [k: string]: unknown;
}
/** What the kernel hands over (the serve frame `emit`). */
export interface Outgoing { message: MailRecord; body: Uint8Array; transport: string; address: string }

/** The stock providers' names (each one's address on this host: `local`, <name>). */
export const PROVIDERS = ["fetch", "waker", "cron", "libp2p", "status", "manager", "certifier", "billing"] as const;
/** The providers only the host skein's address book names (#90, #113): they act for it alone. */
export const HOST_SKEIN_PROVIDERS: readonly ProviderName[] = ["manager", "certifier"];
/** Keys no address book names (#130: the host's billing key signs its ticks; it is not reached). */
export const UNADDRESSED: readonly ProviderName[] = ["billing"];
export type ProviderName = typeof PROVIDERS[number];

/** The intentions a step records and the runtime answers (#126). */
export type Intention = "fetch" | "deadline";
const SERVICE: Record<Intention, { box: string; provider: ProviderName }> = { fetch: { box: "fetch", provider: "fetch" }, deadline: { box: "wake", provider: "waker" } };

export type HttpRequest = { method: string; url: string; headers?: Record<string, string>; body?: Uint8Array; timeoutMs?: number; maxBytes?: number };
export type HttpResponse = { status: number; headers: Record<string, string>; body: Uint8Array };

export interface ProvidersOptions {
  /** A provider's key (the reference host: a child of its master secret). */
  keyOf(name: ProviderName): PrivateKey;
  /** The instance `handle`'s identity key (33 bytes), or undefined when it is not known. */
  identity(handle: string): Promise<Uint8Array | undefined>;
  /** Append a message (its package: a provider's signed answer, or the loopback's own emit) into `handle` as a `local` request. */
  append(handle: string, pkg: { kind: "message"; message: MailRecord; body: Uint8Array }): Promise<unknown>;
  /**
   * Sign `data` with the instance `handle`'s own key, BRC-169's way ([2, "metanet handles
   * envelope"], key "send", counterparty anyone) → the DER signature (#126: the request the
   * runtime sends for an intention a step recorded is the instance's, signed by its wallet).
   */
  sign(handle: string, data: Uint8Array): Promise<Uint8Array>;
  /**
   * Where this host sends an intention (#126) — host wiring, not an instance setting nor an
   * address-book role: the service by name (`fetch`: the HTTP proxy; `deadline`: the waker), on
   * this host (`local`, the only transport wired so far). Default: this host's own providers.
   */
  route?: Partial<Record<Intention, { transport: "local"; address: ProviderName }>>;
  /** The HTTP proxy's network: one request, this host's own URLs in process. */
  fetch(req: HttpRequest, from: string): Promise<HttpResponse>;
  /** The broadcaster (#58, #65: the host's Arcade), when the host has one: a broadcast event's transaction and BEEF, queued. */
  broadcast?(handle: string, tx: Uint8Array, beef?: Uint8Array): void;
  /** The libp2p node's subscriptions (#119) and beacons (#126): a `subscribe` / `unsubscribe` / `beacon` / `unbeacon` record {kind: "event", event, app, topic, …} from `handle`. Absent: no libp2p node (dropped). */
  topicEvent?(handle: string, record: Record<string, unknown>): void;
  /** The cron provider's schedule (#69, cron.ts): a request from `handle` (key `sender`), the message `id` → the answer body. Absent: no cron provider. */
  cron?(handle: string, sender: string, id: string, body: unknown): Record<string, unknown>;
  /**
   * The instance manager (#90, Router): `from()` names the host skein (its
   * handle and identity, hex) — the one sender it acts for (none: it acts for
   * nobody); `request` does a create, start or stop → the answer body.
   */
  manager?: {
    from(): { handle: string; identity: string } | undefined;
    request(box: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  /** The certifier (#113): an issue request from the host skein → the answer body (handles.ts). Absent: none. */
  certifier?(box: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** #130: a `payment` event from `handle` — its pay step's (the kernel lets no other step emit one). Absent: no billing (ignored). */
  payment?(handle: string, record: Record<string, unknown>): void;
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

/** The fetch provider's refusal of a response over the request's `maxBytes` (#91). */
export const tooLarge = (max: number) => `the response is larger than maxBytes (${max} bytes): not carried in`;

export class Providers {
  readonly o: ProvidersOptions;
  private wallets = new Map<string, ProtoWallet>();
  private keys = new Map<string, string>();
  /** Messages taken (handle + CID), so a message handed over again (a kernel's start) is acted on once. */
  private taken = new Set<string>();
  /** The waker's timers, by handle + the wake-me's CID. */
  private timers = new Map<string, { at: number; handle: string; timer: ReturnType<typeof setTimeout>; fire(): void }>();
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

  /** The address book entries a genesis seeds for this host's providers: key, transport `local`, address the name (#126: no role). */
  entries(names: readonly ProviderName[] = PROVIDERS.filter((n) => !HOST_SKEIN_PROVIDERS.includes(n) && !UNADDRESSED.includes(n))): Array<{ key: Uint8Array; transport: "local"; address: string }> {
    return names.map((n) => ({ key: Uint8Array.from(Buffer.from(this.key(n), "hex")), transport: "local" as const, address: n }));
  }

  /** Stop the timers; nothing more is carried. */
  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t.timer);
    this.timers.clear();
  }

  /** A message (or an event, #65) from `handle` to carry out (the kernel's `emit` notice). */
  deliver(handle: string, out: Outgoing): void {
    if (this.stopped) return;
    if (out.transport === "event") return this.event(handle, out);
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

  /**
   * An event out (#65, #119): addressed to no one, acted on by its name —
   * `broadcast` → the broadcaster (Arcade); `subscribe` / `unsubscribe` → the
   * libp2p node (the topics it subscribes: p2p.ts; delivery is the kernel's, by the subscription); any other name: a log
   * line, nothing else (the step is not told). A broadcast is acted on every
   * time it is handed over (a kernel's start hands over again what a waiting
   * thread awaits: the queue takes a transaction once); any other event is
   * handed over once.
   */
  private event(handle: string, out: Outgoing): void {
    const m = out.message as unknown as Record<string, unknown>;
    if (out.address === "broadcast" && m.kind === "broadcast") {
      if (!this.o.broadcast) { this.say(handle, "broadcast: this host has no Arcade (SKEIN_ARC_URL): dropped"); return; }
      this.o.broadcast(handle, out.body, m.beef instanceof Uint8Array ? m.beef : undefined);
      return;
    }
    if ((out.address === "deadline" || out.address === "fetch") && m.kind === "event" && m.event === out.address) {
      const k = `${handle} ${encode(m).cid}`;
      if (this.taken.has(k)) return; // handed over again (a kernel's start): kept already
      this.taken.add(k);
      const p = this.intention(handle, out.address, m).catch((e) => { this.taken.delete(k); this.say(handle, `provider: ${out.address}: ${(e as Error).message}`); });
      this.track(p);
      return;
    }
    if (out.address === "payment" && m.kind === "event" && m.event === "payment") {
      // #130: the payee is the host: its billing keeps it (and broadcasts it).
      if (!this.o.payment) { this.say(handle, "payment: this host bills no one: ignored"); return; }
      this.o.payment(handle, m);
      return;
    }
    if ((out.address === "subscribe" || out.address === "unsubscribe" || out.address === "beacon" || out.address === "unbeacon") && m.kind === "event" && m.event === out.address) {
      if (!this.o.topicEvent) { this.say(handle, `${out.address}: this host has no libp2p node: ignored`); return; }
      this.o.topicEvent(handle, m);
      return;
    }
    this.say(handle, `provider: an event ${out.address} this host has no wiring for: ignored`);
  }

  private async carry(handle: string, id: CID, out: Outgoing): Promise<void> {
    if (out.transport === "libp2p") return await this.libp2pRecipient(handle, id, out);
    if (out.transport !== "local") throw new Error(`no transport ${out.transport} here`);
    // #79: the loopback — the instance's message to itself, appended back as it is (its front door checks it).
    if (out.address === "self") {
      if (hex(out.message.sender) !== hex(out.message.recipient)) throw new Error("a loopback message is the instance's to itself");
      await this.o.append(handle, { kind: "message", message: out.message, body: out.body });
      return;
    }
    const name = out.address as ProviderName;
    if (!PROVIDERS.includes(name)) throw new Error(`no provider ${out.address} on this host`);
    if (hex(out.message.recipient) !== this.key(name)) throw new Error(`the message is not for the ${name} provider`);
    if (HOST_SKEIN_PROVIDERS.includes(name)) {
      // #90, #113: the host skein's alone — any other sender's message is not acted on, and not answered.
      const host = this.o.manager?.from();
      if (!host || handle !== host.handle || hex(out.message.sender) !== host.identity) throw new Error(`the ${name === "manager" ? "instance manager" : name} takes messages from the host skein only: not acted on`);
    }
    let body: Record<string, unknown>;
    try { body = dagCbor.decode(out.body) as Record<string, unknown>; } catch { return await this.answer(handle, name, out.message, id, { error: "the body is not dag-cbor" }); }
    const box = out.message.box;
    try {
      switch (name) {
        case "fetch": return await this.fetch(handle, out.message, id, box, body);
        case "waker": return this.wake(handle, out.message, id, box, body);
        case "libp2p": return await this.p2p(handle, out.message, id, box, body);
        case "cron": return await this.cron(handle, out.message, id, box, body);
        case "status": return await this.answer(handle, "status", out.message, id, { error: "the status provider takes no messages: it sends statuses to the instances that subscribe to it (box \"chain/status\")" });
        case "manager": return await this.answer(handle, "manager", out.message, id, await this.o.manager!.request(box, body));
        case "certifier": {
          if (!this.o.certifier) return await this.answer(handle, "certifier", out.message, id, { error: "this host has no certifier" });
          return await this.answer(handle, "certifier", out.message, id, await this.o.certifier(box, body));
        }
        case "billing": return await this.answer(handle, "billing", out.message, id, { error: "the host's billing key takes no messages (#130: it signs the host's ticks)" });
      }
    } catch (e) {
      await this.answer(handle, name, out.message, id, { error: (e as Error).message });
    }
  }

  /** A signed message from provider `name` to the instance that sent `to`, in `to`'s box: {replyTo, …answer}, appended. */
  async answer(handle: string, name: ProviderName, to: MailRecord, id: CID, answer: Record<string, unknown>, box = to.box): Promise<void> {
    await this.send(handle, name, to.sender, box, { replyTo: id, ...answer }, to.subject);
  }

  /**
   * A signed message from provider `name` to `recipient` (the instance
   * `handle`), in `box`, its body `body` — an answer, a tick (#69), a status
   * (#65) — appended there as a `local` request (what the append answers:
   * the entry). Its own message (two like bodies are two messages:
   * `nonce`), about `subject` if given.
   */
  async send(handle: string, name: ProviderName, recipient: Uint8Array, box: string, body: Record<string, unknown>, subject?: CID): Promise<unknown> {
    if (this.stopped) return undefined;
    const bytes = dagCbor.encode(body);
    const unsigned = {
      kind: "mail" as const, op: "put" as const, sender: Uint8Array.from(Buffer.from(this.key(name), "hex")), recipient, box, body: encode(dagCbor.decode(bytes)).cid,
      nonce: Uint8Array.from(randomBytes(16)), ...(subject ? { subject } : {}),
    };
    const { signature } = await this.wallet(name).createSignature({ protocolID: MESSAGE_PROTOCOL, keyID: MESSAGE_KEY_ID, counterparty: "anyone", data: [...dagCbor.encode(unsigned)] });
    const message: MailRecord = { ...unsigned, signature: Uint8Array.from(signature) };
    return await this.o.append(handle, { kind: "message", message, body: bytes });
  }

  // ---------------------------------------------------------------- fetch: the HTTP proxy

  /** A message to the fetch provider (a module on an SDK before #126: fetch was a message to it). */
  private async fetch(handle: string, m: MailRecord, id: CID, box: string, b: Record<string, unknown>): Promise<void> {
    if (box !== "fetch") return await this.answer(handle, "fetch", m, id, { error: `the fetch provider takes box "fetch", not ${box}` });
    await this.answer(handle, "fetch", m, id, await this.proxy(handle, b));
  }

  /** The HTTP proxy (#70, #126): one request {method, url, headers?, body?, timeoutMs?, maxBytes?} → {status, headers, body} | {error}. */
  private async proxy(handle: string, b: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (typeof b.method !== "string" || typeof b.url !== "string") return { error: "fetch wants {method, url, headers?, body?, timeoutMs?, maxBytes?}" };
    const num = (x: unknown) => typeof x === "number" ? x : typeof x === "bigint" ? Number(x) : undefined;
    const maxBytes = num(b.maxBytes) !== undefined && num(b.maxBytes)! >= 0 ? num(b.maxBytes) : undefined;
    const timeoutMs = num(b.timeoutMs);
    const headers: Record<string, string> = {};
    if (b.headers && typeof b.headers === "object") for (const [k, v] of Object.entries(b.headers as Record<string, unknown>)) if (typeof v === "string") headers[k.toLowerCase()] = v;
    let r: HttpResponse;
    try {
      r = await this.o.fetch({ method: b.method, url: b.url, headers, ...(b.body instanceof Uint8Array ? { body: b.body } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(maxBytes !== undefined ? { maxBytes } : {}) }, handle);
    } catch (e) {
      return { error: (e as Error).message };
    }
    if (maxBytes !== undefined && r.body.length > maxBytes) return { error: tooLarge(maxBytes) };
    return { status: r.status, headers: r.headers, body: r.body };
  }

  // ---------------------------------------------------------------- the waker

  /**
   * An intention a step recorded (#126: a `deadline`, a `fetch` event), handed
   * over once its step is committed: the request is the instance's, signed by
   * its wallet — the mail record {kind: "mail", op: "put", sender: <the
   * instance>, recipient: <the service's key>, box, body: <the event's CID>,
   * nonce, signature} — sent where this host is wired (`route`: its own waker
   * or HTTP proxy, `local`). The service's answer is a signed message from its
   * key whose body names the event (`replyTo`) and carries that request
   * (`request`), appended as a `local` request: the front door checks its
   * signature, the kernel the request's (scheduler.zig intentionAnswer), and
   * the thread awaiting the event steps — `woke` at a deadline, `reply` with a
   * fetch's response ({status, headers, body} | {error}).
   */
  private async intention(handle: string, name: Intention, ev: Record<string, unknown>): Promise<void> {
    const r = this.o.route?.[name] ?? { transport: "local" as const, address: SERVICE[name].provider };
    if (r.transport !== "local") throw new Error(`no transport ${String(r.transport)} wired for ${name}`);
    if (!PROVIDERS.includes(r.address)) throw new Error(`no provider ${r.address} on this host`);
    const id = encode(ev).cid;
    const identity = await this.o.identity(handle);
    if (!identity) throw new Error("the instance's identity is not known");
    const unsigned = {
      kind: "mail" as const, op: "put" as const, sender: identity, recipient: Uint8Array.from(Buffer.from(this.key(r.address), "hex")), box: SERVICE[name].box, body: id, nonce: Uint8Array.from(randomBytes(16)),
    };
    const request: MailRecord = { ...unsigned, signature: await this.o.sign(handle, dagCbor.encode(unsigned)) };
    const reply = (answer: Record<string, unknown>) => this.send(handle, r.address, identity, SERVICE[name].box, { replyTo: id, request, ...answer });
    if (name === "deadline") {
      const at = typeof ev.at === "number" ? ev.at : typeof ev.at === "bigint" ? Number(ev.at) : NaN;
      if (!Number.isFinite(at)) throw new Error("a deadline with no `at`");
      this.timer(handle, id, at, () => this.track(reply({ at }).catch((e) => this.say(handle, `waker: ${(e as Error).message}`))));
      return;
    }
    await reply(await this.proxy(handle, ev));
  }

  /** Run `fire` at `at` (by the clock `now`), once per (handle, id). */
  private timer(handle: string, id: CID, at: number, fire: () => void): void {
    const k = `${handle} ${id}`;
    if (this.timers.has(k)) return;
    // A timer's longest wait is about 24.8 days; a later wake waits in steps.
    const arm = () => this.timers.set(k, { at, handle, fire: go, timer: setTimeout(go, Math.min(2 ** 31 - 1, Math.max(0, at - this.o.now()) + 1)) });
    const go = () => {
      this.timers.delete(k);
      if (this.o.now() < at) { arm(); return; }
      fire();
    };
    arm();
  }

  /** A wake-me message (a kernel before #126: a deadline was a message to the waker), kept for such a log's waiting threads. */
  private wake(handle: string, m: MailRecord, id: CID, box: string, b: Record<string, unknown>): void {
    if (box !== "wake" || typeof b.at !== "number") { void this.answer(handle, "waker", m, id, { error: "the waker takes {at: ms} in box \"wake\"" }); return; }
    this.timer(handle, id, b.at, () => this.track(this.answer(handle, "waker", m, id, { at: b.at }).catch((e) => this.say(handle, `waker: ${(e as Error).message}`))));
  }

  /**
   * Answer now every wake-me that is due by the clock (`now`): what the
   * timers do in real time, for a clock that is not (a script clock: tests,
   * the corpus). The answers are being appended when it returns (idle()).
   */
  wakeDue(): void {
    const now = this.o.now();
    for (const [k, t] of [...this.timers]) if (t.at <= now) { clearTimeout(t.timer); this.timers.delete(k); t.fire(); }
  }

  /** The earliest wake the waker owes `handle` (ms), if any (the host page). */
  nextWake(handle: string): number | undefined {
    let next: number | undefined;
    for (const t of this.timers.values()) if (t.handle === handle && (next === undefined || t.at < next)) next = t.at;
    return next;
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

  // ---------------------------------------------------------------- cron (#69)

  private async cron(handle: string, m: MailRecord, id: CID, box: string, b: Record<string, unknown>): Promise<void> {
    if (!this.o.cron) return await this.answer(handle, "cron", m, id, { error: "this host keeps no schedules" });
    if (box !== "cron") return await this.answer(handle, "cron", m, id, { error: `the cron provider takes box "cron", not ${box}` });
    await this.answer(handle, "cron", m, id, this.o.cron(handle, hex(m.sender), id.toString(), b));
  }
}

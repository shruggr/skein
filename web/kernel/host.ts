// A skein host in the browser (issue #35, #16): the wasm kernel in a Worker
// (kernel-zig/web) over an IndexedDB store, and this page as everything
// outside it — the host contract of the router (src/host/router.ts), for one
// instance whose identity is the connected wallet's (#16: the same identity
// is the user, the instance and the host; three interfaces, wired apart).
//
//   the imports out   wallet  → the page's BRC-100 wallet (Yours through
//                               @1sat/connect; a wallet in the tab over a test key in tests), over the
//                               BRC-100 wire (WalletWireProcessor)
//   what it carries   emit    → the page is the host's providers (#70,
//                               src/host/providers.ts): the HTTP proxy `fetch`
//                               and the `waker` (setTimeout), and the bytes of
//                               the kernel's `authfetch` (the instance delivers
//                               its messages itself — the messagebox program's
//                               delivery thread, a BRC-104 client — and resolves
//                               handles through the proxy). Each provider answers
//                               with a signed message from its own key, admitted
//                               as a `local` request. The keys: children of a
//                               provider master the page keeps (localStorage, per
//                               store); the genesis seeds them in the address book.
//   the call in       admit + drain: the page's own messages (a chat, an
//                     install) as the user, on the page wallet's BRC-104
//                     session with its instance — `http` request entries to
//                     the instance's front door (`/sendMessage`), which
//                     verifies them as it does any client's (frontFetch, #126
//                     step 4: the session is the sender's proof; nothing is
//                     signed inside a message) — and the providers' answers
//                     (`local` requests: the waker's among them, a deadline's
//                     or a shell's sleep, #69).
//
// The mailbox: registering this identity on the host creates its mailbox
// instance (#40) — the user's, read with the user's wallet, never the
// instance's inbox (#126 step 4: a skein receives mail only where it
// verifies the sender itself, and the page's instance has no front door
// anyone else reaches). The genesis names it as the owner's messagebox, so
// what the instance sends its owner (this identity) lands there; the page
// polls it and shows every message (from the instance, from peers), and
// admits none into the instance: if the user wants the instance to act on
// one, the user sends it a message of their own. An intermittent host
// (#16): nothing runs while the tab is closed; mail waits in the mailbox
// instance and wakes fire late, at the next open.

import { AuthFetch, KeyDeriver, PrivateKey, WalletWireProcessor, type WalletInterface } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { MESSAGE_KEY_ID, MESSAGE_PROTOCOL, Providers, type HttpRequest, type HttpResponse, type Outgoing, type ProviderName } from "../../src/host/providers.ts";
import type { CID } from "multiformats/cid";
// @ts-expect-error: plain JS module (kernel-zig/web/client.js)
import { KernelWorker } from "../../kernel-zig/web/client.js";
import { RawBox } from "../../src/client/raw.ts";
import { admit2, keyBytes, writeGenesis } from "../../src/host/genesis.ts";
import type { Kernel } from "../../src/host/kernel.ts";
import { encode } from "../../src/runtime/cid.ts";
import { DEFAULTS } from "../../src/runtime/log.ts";
import { NotFound, Rejected } from "../../src/runtime/store.ts";
import { msStamp, type Stamp } from "../../src/runtime/syscalls.ts";

type Reply = { ok?: unknown; error?: string | null; rejected?: string | null };

/** The boxes the page collects from its mailbox besides the ones the subscriptions route. */
const COLLECT = ["chat", "turn", "results", "completions"];

export interface HostOptions {
  wallet: WalletInterface;
  /** The skein host (the router), e.g. http://127.0.0.1:8100: where this identity registers its mailbox instance and handles resolve. */
  host: string;
  handle: string;
  domain?: string;
  /** The inference peer's identity (hex) and name, for the genesis. */
  infer?: string;
  inferHandle?: { handle: string; domain: string };
  defaults?: Record<string, string>;
  /** The IndexedDB database. Default skein-<handle>. */
  db?: string;
  /** Where the kernel and its shim are served, and the pinned modules. */
  kernelUrl?: string;
  workerUrl?: string;
  wasmBase?: string;
  pollMs?: number;
  log?(line: string): void;
  /** A message in this identity's mailbox (the instance's to its owner, a peer's to the user): the page shows it. */
  onMessage?(m: { from: string; box: string; body: unknown; id: string }): void;
}

const now = (): Stamp => msStamp(Date.now());

/**
 * The page's provider master (#70): a secret the page keeps (localStorage,
 * one per store), whose BRC-42 children are its providers' keys — the waker
 * and the HTTP proxy sign their answers with them, and the genesis names
 * their public keys. Not the wallet's: a provider signs by itself, unasked.
 * Lost (cleared site data), the instance's address book names keys no page
 * holds: start a new store. Without storage, a fresh one for this session.
 */
function providerMaster(db: string): PrivateKey {
  const name = `skein-provider-master:${db}`;
  try {
    const had = globalThis.localStorage?.getItem(name);
    if (had) return PrivateKey.fromHex(had);
    const k = PrivateKey.fromRandom();
    globalThis.localStorage?.setItem(name, k.toHex().padStart(64, "0"));
    return k;
  } catch {
    return PrivateKey.fromRandom();
  }
}

/** The kernel in the worker, with the surface src/host's helpers use (writeGenesis, admit2: Kernel in kernel.ts). */
export class WebKernel {
  readonly kw: KernelWorker;
  constructor(kw: KernelWorker) { this.kw = kw; }

  private static unwrap(r: Reply): unknown {
    if (typeof r.rejected === "string") throw new Rejected(r.rejected as Rejected["reason"], String(r.error));
    if (typeof r.error === "string") throw new Error(r.error);
    return r.ok ?? null;
  }
  async call(op: string, v: unknown = null): Promise<unknown> {
    return WebKernel.unwrap(dagCbor.decode(await this.kw.call("call", dagCbor.encode({ op, v }))) as Reply);
  }
  readonly store = {
    get: async (cid: CID) => { const v = await this.call("get", cid); if (v === null) throw new NotFound(cid.toString()); return v; },
    put: async (value: unknown) => await this.call("put", value) as CID,
    has: async (cid: CID) => (await this.call("get", cid)) !== null,
    log: {
      tip: async () => (await this.call("tip") as CID | null) ?? undefined,
      byEnvelope: async (e: CID) => (await this.call("byEnvelope", e) as CID | null) ?? undefined,
      append: async (entry: unknown) => await this.call("append", entry) as CID,
    },
  };
  /** The one call in: admitted and durable when this resolves (processing is drain's). */
  async admit(entry: unknown, records: { body?: Uint8Array; request?: Record<string, unknown> } = {}): Promise<CID> {
    const frame: Record<string, unknown> = { entry };
    if (records.body) frame.body = records.body;
    if (records.request) frame.request = records.request;
    return WebKernel.unwrap(dagCbor.decode(await this.kw.call("admit", dagCbor.encode(frame))) as Reply) as CID;
  }
  async drain(): Promise<void> { await this.kw.call("drain"); }
  /** The answer of the thread a request entry launched, as it stands after the drain (#66: kernel-zig/src/web.zig `answer`). */
  async answer(entry: CID): Promise<{ state: string; thread?: CID; answer?: Uint8Array; error?: string; refused?: { status?: number; code?: string; reason?: string } }> {
    return await this.call("answer", entry) as { state: string; thread?: CID; answer?: Uint8Array; error?: string };
  }
  async start(): Promise<void> { WebKernel.unwrap(dagCbor.decode(await this.kw.call("start")) as Reply); }
  async idle(): Promise<void> {}
  async genesis(): Promise<unknown> { return await this.call("genesis"); }
  async boxes(): Promise<string[]> { return await this.call("boxes") as string[]; }
  async state(): Promise<{ state: CID; log: CID | null; cursor: number }> { return WebKernel.unwrap(dagCbor.decode(await this.kw.call("state")) as Reply) as { state: CID; log: CID | null; cursor: number }; }
}

export class BrowserHost {
  readonly o: HostOptions;
  kernel!: WebKernel;
  identity = "";
  private box!: RawBox;
  /** The page's client of its own instance: a BRC-104 session over frontFetch. */
  private own!: RawBox;
  /** This identity's mailbox instance on the host. */
  mailbox = "";
  private queue: Promise<unknown> = Promise.resolve();
  private pollTimer?: ReturnType<typeof setTimeout>;
  private wire: WalletWireProcessor;
  private stopped = false;
  /** The page as the host's providers (#70): the HTTP proxy and the waker (a deadline's and a shell's sleep, #69). */
  readonly providers: Providers;
  /** What happened, for the page and the tests. */
  readonly events: Array<{ kind: string; [k: string]: unknown }> = [];

  constructor(o: HostOptions) {
    this.o = o;
    this.wire = new WalletWireProcessor(o.wallet);
    const master = new KeyDeriver(providerMaster(o.db ?? `skein-${o.handle}`));
    this.providers = new Providers({
      keyOf: (name: ProviderName) => master.derivePrivateKey([2, "skein provider"], name, "self"),
      append: (_h, pkg) => this.appendLocal(pkg),
      identity: async () => this.identity ? keyBytes(this.identity) : undefined,
      sign: async (_h, data) => Uint8Array.from((await this.o.wallet.createSignature({ protocolID: MESSAGE_PROTOCOL, keyID: MESSAGE_KEY_ID, counterparty: "anyone", data: [...data] })).signature),
      fetch: (req) => this.http(req),
      now: () => Date.now(),
      log: (_s, l) => this.log(l),
    });
  }

  private log(line: string): void { this.o.log?.(line); }
  get origin(): string { return new URL(this.o.host).origin; }
  get domain(): string { return this.o.domain ?? "localhost"; }

  /** Admissions and drains one at a time, in order (the router's serial()). */
  private serial<T>(f: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(f);
    this.queue = next.catch(() => {});
    return next;
  }

  async start(): Promise<void> {
    this.identity = (await this.o.wallet.getPublicKey({ identityKey: true })).publicKey;
    const kw = new KernelWorker({
      wasm: this.o.kernelUrl ?? "/kernel/skein-kernel.wasm",
      workerUrl: this.o.workerUrl ?? "/web/worker.js",
      onRequest: (op: string, v: Uint8Array) => this.answer(op, v),
      onNotify: (op: string, v: Uint8Array | string) => this.notified(op, v),
    });
    await kw.ready;
    this.kernel = new WebKernel(kw);
    const blocks = await kw.call("openIdb", 1, this.o.db ?? `skein-${this.o.handle}`);
    this.log(`store: IndexedDB ${this.o.db ?? `skein-${this.o.handle}`} (${blocks} blocks)`);
    await kw.call("open", 1);
    await this.install();
    this.mailbox = await this.register();
    this.box = new RawBox(this.o.wallet, this.mailbox);
    if (!(await this.kernel.store.log.tip())) {
      const e = await writeGenesis(this.kernel as unknown as Kernel, {
        identity: this.identity, owner: this.identity, handle: this.o.handle, domain: this.domain,
        infer: this.o.infer, inferHandle: this.o.inferHandle, ownerHandle: { handle: this.o.handle, domain: this.domain },
        defaults: this.o.defaults ? { ...DEFAULTS, ...this.o.defaults } : undefined,
        ownerMessagebox: this.mailbox, resolveOrigin: this.origin,
        // #70: the page's providers, and this identity's mailbox (the owner's).
        addressBook: [...this.providers.entries(["fetch", "waker"]), { key: keyBytes(this.identity), transport: "mailbox", address: this.mailbox, handle: this.o.handle, domain: this.domain }],
      }, now());
      this.log(`genesis ${e}`);
    }
    await this.serial(async () => { await this.kernel.start(); await this.kernel.drain(); });
    this.own = new RawBox(this.o.wallet, this.ownUrl, { fetch: this.frontFetch });
    void this.pollLoop();
  }

  stop(): void {
    this.stopped = true;
    this.providers.stop();
    clearTimeout(this.pollTimer);
    this.kernel?.kw.terminate();
  }

  /** The pinned modules and support files the store lacks, fetched and checked against their CIDs (skein-dev install). */
  private async install(): Promise<void> {
    const list = dagCbor.decode(await this.kernel.kw.call("modules")) as Array<{ name: string; file: string; cid: CID }>;
    let n = 0;
    for (const m of list) {
      if (await this.kernel.kw.call("hasBlock", 1, m.cid.bytes)) continue;
      const r = await fetch(`${this.o.wasmBase ?? "/wasm"}/${m.file}`);
      if (!r.ok) throw new Error(`install ${m.file}: HTTP ${r.status}`);
      await this.kernel.kw.call("putBlock", m.cid.bytes, new Uint8Array(await r.arrayBuffer()));
      n++;
    }
    if (n) this.log(`installed ${n} modules`);
  }

  /**
   * This identity's mailbox instance on the host (messages to it wait there
   * while the tab is closed): its URL. #113: the host skein's onboarding app
   * takes the registration, signed over `register <handle>@<domain>` — the
   * host's handle domain, from /.well-known/skein-host.
   */
  private async register(): Promise<string> {
    const { domain } = await (await fetch(`${this.origin}/.well-known/skein-host`)).json() as { domain: string };
    const sig = await this.o.wallet.createSignature({ protocolID: [2, "skein register"], keyID: this.o.handle, counterparty: "anyone", data: [...new TextEncoder().encode(`register ${this.o.handle}@${domain}`)] });
    // #135: a registration is a signed request, over this identity's session with the host's origin.
    const r = await new AuthFetch(this.o.wallet).fetch(`${this.origin}/account/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: this.o.handle, identityKey: this.identity, signature: [...sig.signature].map((b) => b.toString(16).padStart(2, "0")).join("") }) });
    const j = await r.json() as { messagebox?: string; error?: string };
    this.log(`register ${this.o.handle}: HTTP ${r.status}${j.messagebox ? ` · ${j.messagebox}` : ` ${j.error ?? ""}`}`);
    if (!j.messagebox) throw new Error(`register ${this.o.handle}: ${j.error ?? r.status}`);
    return j.messagebox;
  }

  // ---------------------------------------------------------------- the kernel's requests (it waits on them)

  private async answer(op: string, v: Uint8Array): Promise<Uint8Array> {
    const arg = dagCbor.decode(v);
    switch (op) {
      case "wallet":
        return dagCbor.encode(Uint8Array.from(await this.wire.transmitToWallet([...(arg as Uint8Array)])));
      case "http": {
        // #126: the kernel's authfetch — it signs and verifies; the page moves the bytes. No answer at all: {error}.
        const q = arg as { method: string; url: string; headers?: Record<string, string>; body?: Uint8Array; timeoutMs?: number };
        try {
          const r = await this.http({ method: q.method, url: q.url, headers: q.headers ?? {}, ...(q.body?.length ? { body: q.body } : {}), ...(q.timeoutMs !== undefined ? { timeoutMs: Number(q.timeoutMs) } : {}) });
          return dagCbor.encode({ status: r.status, headers: r.headers, body: r.body });
        } catch (e) {
          return dagCbor.encode({ error: (e as Error).message });
        }
      }
    }
    throw new Error(`this host answers no ${op}`);
  }

  /** The page's HTTP: the HTTP proxy's network (#70) and authfetch's bytes (#126). */
  private async http(req: HttpRequest): Promise<HttpResponse> {
    const r = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body as BodyInit | undefined, signal: AbortSignal.timeout(req.timeoutMs ?? 30_000) });
    this.events.push({ kind: "http", method: req.method, url: req.url, status: r.status });
    return { status: r.status, headers: Object.fromEntries(r.headers.entries()), body: new Uint8Array(await r.arrayBuffer()) };
  }

  // ---------------------------------------------------------------- what the kernel tells

  private notified(op: string, v: Uint8Array | string): void {
    if (op === "say" || op === "panic") { this.log(String(v)); return; }
    // #70: a signed message the instance emitted, its step committed: the page's providers carry it.
    if (op === "emit") { this.providers.deliver(this.o.handle, dagCbor.decode(v as Uint8Array) as Outgoing); return; }
  }

  /** A provider's answer (#70): a signed message, appended as a `local` request; the front door checks it and routes it. */
  private async appendLocal(pkg: Record<string, unknown>): Promise<CID> {
    return await this.serial(async () => {
      // #121: the record goes with the frame; the kernel's door puts it.
      const e = await admit2(this.kernel as unknown as Kernel, { request: encode(pkg).cid, transport: "local" } as never, { request: pkg }, now());
      await this.kernel.drain();
      return e;
    });
  }

  // ---------------------------------------------------------------- the call in: the messagebox

  private async pollLoop(): Promise<void> {
    if (this.stopped) return;
    try { await this.poll(); } catch (e) { this.log(`poll: ${(e as Error).message}`); }
    this.pollTimer = setTimeout(() => void this.pollLoop(), this.o.pollMs ?? 1000);
  }

  /**
   * listMessages in every box the subscriptions route (and COLLECT) on this
   * identity's mailbox instance: each message — the instance's to its owner,
   * a peer's to the user — shown (`onMessage`, an event `message`) and
   * acknowledged. None is admitted into the instance (#126 step 4): the
   * mailbox is the user's, and the user's own message is how the instance
   * hears of one.
   */
  async poll(): Promise<number> {
    let n = 0;
    const boxes = [...new Set([...(await this.kernel.boxes()), ...COLLECT])];
    for (const box of boxes) {
      for (const m of await this.box.list(box)) {
        this.events.push({ kind: "message", box, sender: m.sender, body: m.value, id: m.messageId });
        this.o.onMessage?.({ from: m.sender, box, body: m.value, id: m.messageId });
        await this.box.ack([m.messageId]);
        n++;
      }
    }
    return n;
  }

  // ---------------------------------------------------------------- the call in: the page

  /** The instance's origin as the page addresses it: nothing goes to the network (frontFetch carries every request in). */
  private get ownUrl(): string { return `http://${this.o.handle}.instance.invalid`; }

  /**
   * The page's requests to its own instance (#126 step 4): a fetch over the
   * instance's front door, no socket — each request appended as an `http`
   * request entry ({kind: "http", method, path, route, query, headers,
   * body}), processed, and answered with what its thread answered (signed on
   * the session inside, through the page wallet: the instance's signer). The
   * page is a client of its instance like any other, on its wallet's BRC-104
   * session; what it sends is a plain BRC-33 message.
   */
  private readonly frontFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const req = input instanceof Request ? input : new Request(url, init);
    const body = new Uint8Array(await req.arrayBuffer());
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    const record = { kind: "http", method: req.method, path: url.pathname, route: url.pathname, query: url.search, headers, body };
    const a = await this.serial(async () => {
      const e = await admit2(this.kernel as unknown as Kernel, { request: encode(record).cid, transport: "http" } as never, { request: record }, now());
      await this.kernel.drain();
      return await this.kernel.answer(e);
    });
    const json = (status: number, code: string, description: string) => new Response(JSON.stringify({ status: "error", code, description }), { status, headers: { "content-type": "application/json" } });
    if (a.state === "refused") return json(a.refused?.status ?? 400, a.refused?.code ?? "ERR_REFUSED", a.refused?.reason ?? "refused");
    if (a.state === "errored") return json(500, "ERR_FRONT_DOOR", a.error ?? "errored");
    if (a.state !== "finished" || !a.answer) return json(503, "ERR_UNAVAILABLE", `not answered (its thread is ${a.state})`);
    const r = dagCbor.decode(a.answer) as { status?: number; headers?: Record<string, string>; body?: Uint8Array };
    if (typeof r.status !== "number") return json(500, "ERR_FRONT_DOOR", "the request's thread ended with no answer the page serves");
    return new Response(r.body?.length ? r.body as BodyInit : null, { status: r.status, headers: r.headers ?? {} });
  }) as typeof fetch;

  /**
   * A message from this identity — the instance's owner — in `box`, on the
   * page wallet's session with its instance (#126 step 4): what an install
   * client sends (#83: the kernel's `objects`, `head`, `dispatch`
   * operations). "sent <id>" (the message's id: what a reply names).
   */
  async send(box: string, body: Uint8Array): Promise<string> {
    const { id } = await this.own.send(this.identity, box, body);
    this.events.push({ kind: "sent", box, message: id.toString() });
    this.log(`${box}: sent ${id.toString().slice(-8)}`);
    return `sent ${id}`;
  }

  /** The user's chat to the instance (#16): a message from this identity on its session. Its id (what a reply names). */
  async chat(text: string, replyTo?: CID): Promise<string> {
    const r = await this.send("chat", dagCbor.encode(replyTo ? { text, replyTo } : { text }));
    return r.split(" ")[1]!;
  }
}

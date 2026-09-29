// A skein host in the browser (issue #35, #16): the wasm kernel in a Worker
// (kernel-zig/web) over an IndexedDB store, and this page as everything
// outside it — the host contract of the router (src/host/router.ts), for one
// instance whose identity is the connected wallet's (#16: the same identity
// is the user, the instance and the host; three interfaces, wired apart).
//
//   the imports out   wallet  → the page's BRC-100 wallet (Yours through
//                               @1sat/connect; a ProtoWallet in tests), over the
//                               BRC-100 wire (WalletWireProcessor)
//                     http    → fetch: the instance's own programs deliver its
//                               messages (#40: the messagebox program, a BRC-104
//                               client) and resolve handles (the resolve program,
//                               BRC-169) — there is no emit and no resolve
//   the call in       admit + drain, from: the page (a chat: a message from the
//                     user admitted directly), a poll of this identity's
//                     mailbox instance on the host (listMessages on a BRC-104
//                     session; each message admitted, acknowledged once
//                     durable), a timer for wakes.
//
// The mailbox: registering this identity on the host creates its mailbox
// instance (#40); the genesis names it as the owner's messagebox, so what the
// instance sends its owner (this identity) lands there too — the page shows
// those (sender = this identity) and admits the rest. An intermittent host
// (#16): nothing runs while the tab is closed; inbound waits in the mailbox
// instance and wakes fire late, at the next open.

import { WalletWireProcessor, type WalletInterface } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
// @ts-expect-error: plain JS module (kernel-zig/web/client.js)
import { KernelWorker } from "../../kernel-zig/web/client.js";
import { RawBox } from "../../src/client/raw.ts";
import { admit2, keyBytes, writeGenesis } from "../../src/host/genesis.ts";
import type { Kernel } from "../../src/host/kernel.ts";
import { DEFAULTS, stampMs } from "../../src/runtime/log.ts";
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
  /** A message the instance sent to this identity: the page shows it. */
  onMessage?(m: { from: string; box: string; body: unknown; id: string }): void;
}

const now = (): Stamp => msStamp(Date.now());

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
  async admit(entry: unknown, records: { body?: Uint8Array } = {}): Promise<CID> {
    const frame: Record<string, unknown> = { entry };
    if (records.body) frame.body = records.body;
    return WebKernel.unwrap(dagCbor.decode(await this.kw.call("admit", dagCbor.encode(frame))) as Reply) as CID;
  }
  async drain(): Promise<void> { await this.kw.call("drain"); }
  async start(): Promise<void> { WebKernel.unwrap(dagCbor.decode(await this.kw.call("start")) as Reply); }
  async idle(): Promise<void> {}
  async genesis(): Promise<unknown> { return await this.call("genesis"); }
  async boxes(): Promise<string[]> { return await this.call("boxes") as string[]; }
  async sleepers(): Promise<Array<{ thread: CID; until: number }>> { return await this.call("sleepers") as Array<{ thread: CID; until: number }>; }
  async state(): Promise<{ state: CID; log: CID | null; cursor: number }> { return WebKernel.unwrap(dagCbor.decode(await this.kw.call("state")) as Reply) as { state: CID; log: CID | null; cursor: number }; }
}

export class BrowserHost {
  readonly o: HostOptions;
  kernel!: WebKernel;
  identity = "";
  private box!: RawBox;
  /** This identity's mailbox instance on the host. */
  mailbox = "";
  private queue: Promise<unknown> = Promise.resolve();
  private pollTimer?: ReturnType<typeof setTimeout>;
  private wakeTimer?: ReturnType<typeof setTimeout>;
  private wire: WalletWireProcessor;
  private stopped = false;
  /** What happened, for the page and the tests. */
  readonly events: Array<{ kind: string; [k: string]: unknown }> = [];

  constructor(o: HostOptions) {
    this.o = o;
    this.wire = new WalletWireProcessor(o.wallet);
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
      }, now());
      this.log(`genesis ${e}`);
    }
    await this.serial(async () => { await this.kernel.start(); await this.kernel.drain(); });
    await this.scheduleWake(await this.kernel.sleepers());
    void this.pollLoop();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    clearTimeout(this.wakeTimer);
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

  /** This identity's mailbox instance on the host (messages to it wait there while the tab is closed): its URL. */
  private async register(): Promise<string> {
    const sig = await this.o.wallet.createSignature({ protocolID: [2, "skein register"], keyID: this.o.handle, counterparty: "anyone", data: [...new TextEncoder().encode(`register ${this.o.handle}`)] });
    const r = await fetch(`${this.origin}/account/register`, { method: "POST", body: JSON.stringify({ username: this.o.handle, identityKey: this.identity, signature: [...sig.signature].map((b) => b.toString(16).padStart(2, "0")).join("") }) });
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
        const req = dagCbor.decode(arg as Uint8Array) as { method: string; url: string; headers?: Record<string, string>; body?: Uint8Array };
        const r = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body as BodyInit | undefined });
        this.events.push({ kind: "http", method: req.method, url: req.url, status: r.status });
        return dagCbor.encode(dagCbor.encode({ status: r.status, headers: Object.fromEntries(r.headers.entries()), body: new Uint8Array(await r.arrayBuffer()) }));
      }
    }
    throw new Error(`this host answers no ${op}`);
  }

  // ---------------------------------------------------------------- what the kernel tells

  private notified(op: string, v: Uint8Array | string): void {
    if (op === "say" || op === "panic") { this.log(String(v)); return; }
    if (op === "sleepers") { void this.scheduleWake(dagCbor.decode(v as Uint8Array) as Array<{ thread: CID; until: number }>); return; }
  }

  private async scheduleWake(s: Array<{ thread: CID; until: number }>): Promise<void> {
    clearTimeout(this.wakeTimer);
    if (!s.length || this.stopped) return;
    this.wakeTimer = setTimeout(() => void this.wake(), Math.max(0, s[0]!.until - Date.now()) + 1);
  }

  /** The waker: admit a wake for every sleeper that is due (late ones too: the tab may have been closed). */
  private async wake(): Promise<void> {
    await this.serial(async () => {
      for (const { thread, until } of await this.kernel.sleepers()) {
        if (until > Date.now()) break;
        const e = await admit2(this.kernel as unknown as Kernel, { wake: thread }, {}, now());
        this.log(`wake ${thread.toString().slice(-8)} as ${e.toString().slice(-8)}`);
      }
      await this.kernel.drain();
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
   * identity's mailbox instance: what the instance sent its owner (this
   * identity) is shown; the rest admitted as messages (durable), processed,
   * acknowledged.
   */
  async poll(): Promise<number> {
    let n = 0;
    const boxes = [...new Set([...(await this.kernel.boxes()), ...COLLECT])];
    for (const box of boxes) {
      for (const m of await this.box.list(box)) {
        if (m.sender === this.identity) {
          this.events.push({ kind: "message", box, body: m.value, id: m.messageId });
          this.o.onMessage?.({ from: m.sender, box, body: m.value, id: m.messageId });
        } else {
          const r = await this.admitMessage(m.sender, box, m.body);
          this.log(`inbox ${box} from ${m.sender.slice(-8)}: ${r}`);
        }
        await this.box.ack([m.messageId]);
        n++;
      }
    }
    return n;
  }

  /** A message from `sender` to this identity, admitted as the host's word (the mailbox verified its session). Its id. */
  private async admitMessage(sender: string, box: string, body: Uint8Array): Promise<string> {
    const bodyCid = await this.kernel.store.put(dagCbor.decode(body));
    const mail = await this.kernel.store.put({ kind: "mail", op: "put", sender: keyBytes(sender), recipient: keyBytes(this.identity), box, body: bodyCid });
    return await this.serial(async () => {
      try {
        const e = await admit2(this.kernel as unknown as Kernel, { mail } as never, { body }, now());
        this.events.push({ kind: "admitted", box, sender, message: mail.toString(), entry: e.toString() });
        await this.kernel.drain();
        return `admitted ${mail.toString().slice(-8)} as ${e.toString().slice(-8)}`;
      } catch (e) {
        if (e instanceof Rejected && e.reason === "duplicate-envelope") return "a duplicate";
        return `rejected: ${(e as Error).message}`;
      }
    });
  }

  // ---------------------------------------------------------------- the call in: the page

  /** The user's chat to the instance: a message from this identity, admitted directly (#16). Its id (what a reply names). */
  async chat(text: string, replyTo?: CID): Promise<string> {
    const body = dagCbor.encode(replyTo ? { text, replyTo } : { text });
    void stampMs;
    const r = await this.admitMessage(this.identity, "chat", body);
    this.log(`chat: ${r}`);
    if (!r.startsWith("admitted")) throw new Error(r);
    return r.split(" ")[1]!;
  }
}

// A skein host in the browser (issue #35, #16): the wasm kernel in a Worker
// (kernel-zig/web) over an IndexedDB store, and this page as everything
// outside it — the host contract of the router (src/host/router.ts), for one
// instance whose identity is the connected wallet's (#16: the same identity
// is the user, the instance and the host; three interfaces, wired apart).
//
//   the imports out   wallet  → the page's BRC-100 wallet (Yours through
//                               @1sat/connect; a ProtoWallet in tests), over the
//                               BRC-100 wire (WalletWireProcessor)
//                     resolve → fetch: the router's paymail PKI (/bsvalias/id/…)
//                     http    → fetch
//                     emit    → the kernel's `send`: a message to another
//                               identity goes to the messagebox host (BRC-231
//                               over BRC-104, as the instance), its outcome
//                               admitted back; one addressed to this identity
//                               is the page's (shown, not sent)
//   the call in       admit + drain, from: the page (a chat: an envelope from
//                     the user sealed and admitted directly, keeping the
//                     envelope shape), a poll of the external messagebox
//                     (listMessages as this identity, screened as the router
//                     screens, acknowledged once durable), a timer for wakes.
//
// An intermittent host (#16): nothing runs while the tab is closed; inbound
// waits in the messagebox and wakes fire late, at the next open.

import { AuthFetch, WalletWireProcessor, type WalletInterface } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
// @ts-expect-error: plain JS module (kernel-zig/web/client.js)
import { KernelWorker } from "../../kernel-zig/web/client.js";
import { asEnvelope, inspect, isCborEnvelope, openCbor, sealCbor, type AnyEnvelope, type CborEnvelope } from "../../src/envelope-cbor.ts";
import { open, type Envelope } from "../../src/envelope.ts";
import { cborBoxClient } from "../../src/host/brc231.ts";
import { admit2, keyBytes, keyHex, writeGenesis } from "../../src/host/genesis.ts";
import type { Kernel } from "../../src/host/kernel.ts";
import type { MessageBox } from "../../src/host/messagebox.ts";
import { DEFAULTS, stampMs } from "../../src/runtime/log.ts";
import { NotFound, Rejected } from "../../src/runtime/store.ts";
import { msStamp, type Stamp } from "../../src/runtime/syscalls.ts";

type Reply = { ok?: unknown; error?: string | null; rejected?: string | null };
type Outbound = { to: Uint8Array; box: string; envelope: unknown; emit: CID; thread: CID; cid: CID };

export interface HostOptions {
  wallet: WalletInterface;
  /** The messagebox host, e.g. http://127.0.0.1:8100/messagebox; its origin also resolves handles (/bsvalias/id). */
  messagebox: string;
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
  onMessage?(m: { from: string; box: string; body: unknown; envelope: CID }): void;
}

const now = (): Stamp => msStamp(Date.now());
const isHex = (s: unknown): s is string => typeof s === "string" && /^0[23][0-9a-f]{64}$/.test(s);

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
  async admit(entry: unknown, records: { envelope?: object; body?: Uint8Array } = {}): Promise<CID> {
    const frame: Record<string, unknown> = { entry };
    if (records.envelope) frame.envelope = records.envelope;
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
  private box!: MessageBox;
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
  get origin(): string { return new URL(this.o.messagebox).origin; }
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
    this.box = cborBoxClient(this.o.wallet, this.o.messagebox);
    if (!(await this.kernel.store.log.tip())) {
      await this.register();
      const e = await writeGenesis(this.kernel as unknown as Kernel, {
        identity: this.identity, owner: this.identity, handle: this.o.handle, domain: this.domain,
        infer: this.o.infer, inferHandle: this.o.inferHandle, ownerHandle: { handle: this.o.handle, domain: this.domain },
        defaults: this.o.defaults ? { ...DEFAULTS, ...this.o.defaults } : undefined,
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

  /** A mailbox for this identity on the messagebox host (replies to it wait there while the tab is closed). */
  private async register(): Promise<void> {
    const r = await new AuthFetch(this.o.wallet).fetch(`${this.origin}/account/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: this.o.handle }) });
    this.log(`register ${this.o.handle}: HTTP ${r.status}`);
  }

  // ---------------------------------------------------------------- the kernel's requests (it waits on them)

  private async answer(op: string, v: Uint8Array): Promise<Uint8Array> {
    const arg = dagCbor.decode(v);
    switch (op) {
      case "wallet":
        return dagCbor.encode(Uint8Array.from(await this.wire.transmitToWallet([...(arg as Uint8Array)])));
      case "resolve": {
        const { handle, domain } = arg as { handle: string; domain: string };
        let res: Record<string, unknown>;
        try {
          const r = await fetch(`${this.origin}/bsvalias/id/${encodeURIComponent(`${handle}@${domain}`)}`);
          const j = await r.json() as { pubkey?: string; error?: string };
          res = isHex(j.pubkey) ? { identityKey: keyBytes(j.pubkey), via: "host" } : { identityKey: new Uint8Array(), error: j.error ?? `${handle}@${domain}: unknown` };
        } catch (e) {
          res = { identityKey: new Uint8Array(), error: (e as Error).message };
        }
        this.events.push({ kind: "resolve", handle, domain, identityKey: keyHex(res.identityKey) });
        return dagCbor.encode(res);
      }
      case "http": {
        const req = dagCbor.decode(arg as Uint8Array) as { method: string; url: string; headers?: Record<string, string>; body?: Uint8Array };
        const r = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body as BodyInit | undefined });
        return dagCbor.encode(dagCbor.encode({ status: r.status, headers: Object.fromEntries(r.headers.entries()), body: new Uint8Array(await r.arrayBuffer()) }));
      }
    }
    throw new Error(`this host answers no ${op}`);
  }

  // ---------------------------------------------------------------- what the kernel tells

  private notified(op: string, v: Uint8Array | string): void {
    if (op === "say" || op === "panic") { this.log(String(v)); return; }
    if (op === "send") { const o = dagCbor.decode(v as Uint8Array) as Outbound; void this.route(o); return; }
    if (op === "sleepers") { void this.scheduleWake(dagCbor.decode(v as Uint8Array) as Array<{ thread: CID; until: number }>); return; }
  }

  /** An emit: to another identity through the messagebox host, or to this one (the page); the outcome goes back in. */
  private async route(o: Outbound): Promise<void> {
    const to = keyHex(o.to);
    let status: "delivered" | "failed" = "delivered";
    let reason: string | undefined;
    if (to === this.identity) {
      try {
        const env = o.envelope as AnyEnvelope;
        const body = dagCbor.decode((isCborEnvelope(env) ? await openCbor(this.o.wallet, env) : await open(this.o.wallet, env as Envelope)).body);
        this.events.push({ kind: "message", box: o.box, body, envelope: o.cid.toString() });
        this.o.onMessage?.({ from: this.identity, box: o.box, body, envelope: o.cid });
      } catch (e) { status = "failed"; reason = (e as Error).message; }
    } else {
      try {
        const body = isCborEnvelope(o.envelope) ? dagCbor.encode(o.envelope) : o.envelope as object;
        await this.box.send({ recipient: to, box: o.box, body });
        this.events.push({ kind: "sent", to, box: o.box, envelope: o.cid.toString() });
      } catch (e) { status = "failed"; reason = (e as Error).message; }
    }
    this.log(`outbox ${o.box} → ${to.slice(-8)}: ${status}${reason ? ` (${reason})` : ""}`);
    await this.serial(async () => {
      await admit2(this.kernel as unknown as Kernel, { outcome: { emit: o.emit, status, ...(reason ? { reason } : {}) } } as never, {}, now());
      await this.kernel.drain();
    });
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

  /** listMessages for every box the subscriptions route; each message screened, admitted (durable), processed, acknowledged. */
  async poll(): Promise<number> {
    let n = 0;
    for (const box of await this.kernel.boxes()) {
      for (const m of await this.box.list(box)) {
        const r = await this.admitMessage(m.sender ?? "", box, m.body);
        this.log(`inbox ${box} from ${(m.sender ?? "?").slice(-8)}: ${r}`);
        await this.box.ack([m.messageId]);
        n++;
      }
    }
    return n;
  }

  /** router.ts screen + deliver: a BRC-169 envelope in either form, signed by `sender`, to this identity, new, decrypting to canonical dag-cbor. */
  private async admitMessage(sender: string, box: string, raw: unknown): Promise<string> {
    // A BRC-231 listing gives every body as bytes: a §7.3 envelope's dag-cbor, or a JSON sender's §7.2 envelope as its UTF-8 text.
    let env = asEnvelope(raw);
    if (!env && raw instanceof Uint8Array) try { env = asEnvelope(JSON.parse(new TextDecoder().decode(raw))); } catch { /* neither */ }
    if (!env) return "rejected: not a BRC-169 envelope";
    let x: ReturnType<typeof inspect>;
    try { x = inspect(env); } catch (e) { return `rejected: ${(e as Error).message}`; }
    if (!x.verified) return "rejected: the signature does not verify";
    if (sender && sender !== x.sender) return "rejected: the authenticated sender is not the envelope's";
    if (x.recipient !== this.identity) return "rejected: not addressed to this instance";
    let body: Uint8Array;
    try { body = (isCborEnvelope(env) ? await openCbor(this.o.wallet, env) : await open(this.o.wallet, env as Envelope)).body; } catch (e) { return `rejected: ${(e as Error).message}`; }
    const bodyCid = await this.kernel.store.put(dagCbor.decode(body));
    return await this.serial(async () => {
      if (await this.kernel.store.log.byEnvelope(x.id)) return "a duplicate";
      try {
        const e = await admit2(this.kernel as unknown as Kernel, { envelope: x.id, box, body: bodyCid }, { envelope: x.signed, body }, now());
        this.events.push({ kind: "admitted", box, sender: x.sender, envelope: x.id.toString(), entry: e.toString() });
        await this.kernel.drain();
        return `admitted ${x.id.toString().slice(-8)} as ${e.toString().slice(-8)}`;
      } catch (e) {
        if (e instanceof Rejected && e.reason === "duplicate-envelope") return "a duplicate";
        return `rejected: ${(e as Error).message}`;
      }
    });
  }

  // ---------------------------------------------------------------- the call in: the page

  /** The user's chat to the instance: sealed by the wallet as an envelope from this identity and admitted directly (#16). */
  async chat(text: string, replyTo?: CID): Promise<CID> {
    const env: CborEnvelope = await sealCbor(this.o.wallet, {
      recipient: { identityKey: this.identity, handle: this.o.handle, domain: this.domain },
      body: dagCbor.encode(replyTo ? { text, replyTo } : { text }),
      created: new Date(stampMs(now())).toISOString(),
    });
    const r = await this.admitMessage(this.identity, "chat", env);
    this.log(`chat: ${r}`);
    if (!r.startsWith("admitted")) throw new Error(r);
    return inspect(env).id;
  }
}

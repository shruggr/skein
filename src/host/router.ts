// The host as a router (#33): a light web server in front of the instances.
//
// It takes a BRC-33 request — `/sendMessage`, `/listMessages`,
// `/acknowledgeMessage`, under BRC-103/104 mutual auth (auth.ts), the paths
// and shapes the TypeScript messagebox (`1sat serve`) exposes, so the stock
// @bsv/message-box-client works against it unchanged — looks up which
// instance serves the recipient (host.db: an instance's own identity, or a
// mailbox it keeps for another identity), hydrates that instance if it is not
// loaded (starts its kernel over its store: kernel.ts), makes the one call in
// (admit an entry) and returns the response. Nothing runs between requests: a
// kernel with nothing to do is stopped after `idleMs`.
//
//   POST /.well-known/auth                      the BRC-104 handshake
//   POST [/messagebox]/sendMessage              deliver: admit into the recipient instance, or keep it in a mailbox
//   POST [/messagebox]/listMessages             the caller's mailbox, in arrival order
//   POST [/messagebox]/acknowledgeMessage       delete from the caller's mailbox
//   POST /account/register {username}           a mailbox for the caller (kept by the mailbox host instance)
//   GET  /bsvalias/id/<handle>@<domain>         paymail PKI for rows and mailboxes (the resolvers' fallback)
//
// The waker is the router's timer: it keeps the earliest sleeper deadline per
// instance (the kernel reports its sleepers) and, when it comes, hydrates the
// instance and admits the wake. An instance's emits come back here too
// (`send`): to another instance or a kept mailbox they are delivered in
// process; the result goes back into the emitter as an `outcome` entry. The
// router is also the instances' oracle (oracle.ts): it answers each kernel's
// `wallet` import from that instance's derived key.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { CID } from "multiformats/cid";
import type { WalletInterface } from "@bsv/sdk";
import { brc78Decode, isEnvelope, open, signedPart, verify, type Envelope } from "../envelope.ts";
import { decode, encode } from "../runtime/cid.ts";
import { rootIdentity, type KeyWallet } from "../runtime/identity.ts";
import { DEFAULTS, short, stampMs } from "../runtime/log.ts";
import type { Runtime, Outbound } from "../runtime/scheduler.ts";
import { Rejected } from "../runtime/store.ts";
import type { Stamp } from "../runtime/syscalls.ts";
import { AuthServer, send, type AppResponse, type AuthedRequest } from "./auth.ts";
import { admitEntry, ensureGenesis, now as clockNow } from "./entry.ts";
import { configFor, hostResolver } from "./host.ts";
import type { HostDb, InstanceRow } from "./instances.ts";
import { Kernel, type Sleeper } from "./kernel.ts";
import { memoryMail, type MailStore } from "./mail.ts";

type Named = { handle: string; domain: string };

export interface RouterOptions {
  db: HostDb;
  /** Each row's oracle: the wallet its kernel's `wallet` import is answered from. */
  walletFor(row: InstanceRow): Promise<WalletInterface> | WalletInterface;
  /** Signs every entry (the log format before #33's format 2). */
  host: KeyWallet;
  /** The router's own identity for BRC-104. */
  authWallet: WalletInterface;
  /** A new instance's genesis: the owner (required to write one), the inference peer, their names. */
  owner?: string;
  infer?: string;
  ownerHandle?: Named;
  inferHandle?: Named;
  fuelPerStep?: string;
  /** Stop a kernel this long after its last call (ms); 0: never. Default 5 minutes. */
  idleMs?: number;
  /** The instance (handle) that keeps mailboxes registered here; default the first enabled row. */
  mailboxHost?: string;
  mail?: MailStore;
  /** Tests: the clock entries are stamped with. */
  now?: () => Stamp;
  /** Lines, by source: an instance's handle, or "router". */
  log?(source: string, line: string): void;
  /** Kernel process settings. */
  kernel?: { command?: string; env?: Record<string, string | undefined> };
  /** The resolver's origin for BRC-169/paymail beyond the rows (default: none; rows and mailboxes only). */
  resolveOrigin?: string;
}

interface Loaded { row: InstanceRow; kernel: Kernel; identity: string; wallet: WalletInterface }

export interface Delivered { status: number; body: Record<string, unknown> }

const ok = (recipient: string, messageId: string): Delivered => ({ status: 200, body: { status: "success", message: "Your message has been sent to 1 recipient(s).", results: [{ recipient, messageId }] } });
const err = (status: number, code: string, description: string): Delivered => ({ status, body: { status: "error", code, description } });
const KEY = /^0[23][0-9a-f]{64}$/;

export class Router {
  readonly o: RouterOptions;
  readonly auth: AuthServer;
  readonly mail: MailStore;
  readonly loaded = new Map<string, Loaded>();
  private loading = new Map<string, Promise<Loaded>>();
  private queues = new Map<string, Promise<unknown>>();
  /** handle → the earliest sleeper deadline (ms), kept while the kernel is stopped. */
  readonly deadlines = new Map<string, number>();
  private timer?: ReturnType<typeof setTimeout>;
  private idleTimer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private hostKey?: Promise<string>;
  server?: Server;

  constructor(o: RouterOptions) {
    this.o = o;
    this.auth = new AuthServer(o.authWallet);
    this.mail = o.mail ?? memoryMail();
    const idle = o.idleMs ?? 300_000;
    if (idle > 0) this.idleTimer = setInterval(() => void this.reap(idle), Math.max(50, Math.min(idle / 4, 10_000)));
  }

  private say(source: string, line: string): void { this.o.log?.(source, line); }
  private now(): Stamp { return (this.o.now ?? clockNow)(); }

  /** Hydrate every enabled row once (recovery at hydrate time; it reports its sleepers), then let them idle out. */
  async start(): Promise<void> {
    for (const row of this.o.db.list("enabled")) {
      try { await this.hydrate(row.handle); } catch (e) { this.say(row.handle, `not started: ${(e as Error).message}`); }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.idleTimer);
    this.server?.close();
    await Promise.all([...this.loaded.values()].map((l) => l.kernel.stop()));
    this.loaded.clear();
  }

  /** Run `f` after everything else queued for this instance (admissions are serial per instance). */
  serial<T>(handle: string, f: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(handle) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(f);
    const tail = next.catch(() => {});
    this.queues.set(handle, tail);
    void tail.then(() => { if (this.queues.get(handle) === tail) this.queues.delete(handle); });
    return next;
  }

  // ---------------------------------------------------------------- hydration

  /** The instance's kernel, started (and its genesis written) if it is not loaded. */
  hydrate(handle: string): Promise<Loaded> {
    const l = this.loaded.get(handle);
    if (l && !l.kernel.gone) return Promise.resolve(l);
    let p = this.loading.get(handle);
    if (!p) {
      p = this.load(handle).finally(() => this.loading.delete(handle));
      this.loading.set(handle, p);
    }
    return p;
  }

  private async load(handle: string): Promise<Loaded> {
    if (this.stopped) throw new Error("the router is stopping");
    const row = this.o.db.get(handle);
    if (!row || row.status !== "enabled") throw new Error(`no enabled instance ${handle}`);
    const wallet = await this.o.walletFor(row);
    const identity = await rootIdentity(wallet);
    if (row.identity && row.identity !== identity) throw new Error(`its oracle is ${short(identity)}, not the recorded identity ${short(row.identity)}`);
    const rows = (h: string, d: string) => this.o.db.identityOf(h, d);
    const resolve = hostResolver(rows, this.o.resolveOrigin);
    const kernel = new Kernel({
      db: row.store, handle: row.handle, domain: row.domain, wallet, command: this.o.kernel?.command, env: this.o.kernel?.env,
      resolve: async (h, d) => {
        if (!this.o.resolveOrigin) { const k = rows(h, d); return k ? { identityKey: k, via: "host" } : { identityKey: "", error: `${h}@${d}: not an instance or mailbox on this host` }; }
        return await resolve(h, d);
      },
      log: (line) => this.say(handle, line),
      sleepers: (s) => this.sleepersOf(handle, s),
      exited: (code, signal) => {
        if (this.loaded.get(handle)?.kernel === kernel) this.loaded.delete(handle);
        if (code !== 0) this.say(handle, `kernel exited (${signal ?? `code ${code}`})`);
      },
    });
    kernel.outbox = { send: (out: Outbound) => this.route(handle, identity, out) };
    try {
      if (!(await kernel.store.log.tip())) {
        if (!this.o.owner) throw new Error("an empty store needs the owner's identity key (SKEIN_OWNER) for its genesis");
        const config = configFor(row, { owner: this.o.owner, infer: this.o.infer, ownerHandle: this.o.ownerHandle, inferHandle: this.o.inferHandle });
        if (this.o.fuelPerStep) config.defaults = { ...DEFAULTS, fuelPerStep: this.o.fuelPerStep };
        const g = await ensureGenesis(kernel.store, wallet, this.o.host, config, this.now());
        this.say(handle, `genesis ${g.entry}`);
      }
      const g = await kernel.genesis() as { identity?: string; host?: string };
      if (g.identity !== identity) throw new Error(`the oracle (${short(identity)}) is not this instance's identity (${short(String(g.identity))})`);
      const hostKey = await (this.hostKey ??= rootIdentity(this.o.host));
      if (g.host !== undefined && g.host !== hostKey) throw new Error(`the router's entry key (${short(hostKey)}) is not this instance's host (${short(String(g.host))})`);
      await kernel.start();
      await kernel.running(identity);
      void kernel.idle().catch(() => {}); // busy until what start resumed is done
      if (!row.identity) this.o.db.add(row.handle, { identity });
    } catch (e) {
      await kernel.stop(1000);
      throw e;
    }
    const l: Loaded = { row, kernel, identity, wallet };
    this.loaded.set(handle, l);
    this.say("router", `hydrated ${handle} (${short(identity)})`);
    return l;
  }

  /** The kernel counts as busy until it has processed what was just admitted (its `idle` answers after the drain). */
  private settle(l: Loaded): void { void l.kernel.idle().catch(() => {}); }

  /** Stop kernels idle for `ms` with nothing queued. Their deadlines stay with the waker. */
  private async reap(ms: number): Promise<void> {
    for (const [handle, l] of this.loaded) {
      if (l.kernel.busy > 0 || this.queues.has(handle) || Date.now() - l.kernel.last < ms) continue;
      this.loaded.delete(handle);
      this.say("router", `${handle}: idle, stopped`);
      await l.kernel.stop();
    }
  }

  // ---------------------------------------------------------------- the waker

  private sleepersOf(handle: string, s: Sleeper[]): void {
    if (s.length) this.deadlines.set(handle, s[0]!.until);
    else this.deadlines.delete(handle);
    this.schedule();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.stopped || !this.deadlines.size) return;
    const next = Math.min(...this.deadlines.values());
    this.timer = setTimeout(() => void this.wake(), Math.max(0, next - stampMs(this.now())) + 1);
  }

  /** Hydrate every instance whose deadline has come and admit its wakes. */
  async wake(): Promise<void> {
    const t = this.now();
    const due = [...this.deadlines].filter(([, until]) => until <= stampMs(t)).map(([h]) => h);
    for (const handle of due) {
      this.deadlines.delete(handle);
      try {
        await this.serial(handle, async () => {
          const l = await this.hydrate(handle);
          const at = this.now();
          for (const { thread, until } of l.kernel.sleepersDue()) {
            if (until > stampMs(at)) break;
            const e = await admitEntry(l.kernel as unknown as Runtime, this.o.host, { wake: thread }, {}, at);
            this.say(handle, `tick: wake ${short(thread)} as ${short(e)}`);
          }
          this.settle(l);
        });
      } catch (e) {
        this.say(handle, `wake: ${(e as Error).message}`);
      }
    }
    this.schedule();
  }

  // ---------------------------------------------------------------- delivery

  /** Who keeps mail for `identity`: its own instance, or the instance keeping its mailbox. */
  private destination(identity: string): { instance: InstanceRow } | { mailbox: string } | undefined {
    const row = this.o.db.byIdentity(identity);
    if (row) return { instance: row };
    const mb = this.o.db.mailbox(identity);
    if (mb) return { mailbox: mb.instance };
    return undefined;
  }

  /**
   * One BRC-33 message from an authenticated `sender`: admitted into the
   * recipient instance (screened and decrypted through its oracle), or kept
   * in the mailbox of a hosted identity.
   */
  async deliver(m: { sender: string; recipient: string; box: string; body: unknown; messageId: string }): Promise<Delivered> {
    const d = this.destination(m.recipient);
    if (!d) return err(403, "ERR_ACCOUNT_REQUIRED", "Recipient has no account on this host");
    if ("mailbox" in d) {
      await this.mail.put(m.recipient, m.box, { messageId: m.messageId, sender: m.sender, body: m.body, createdAt: new Date().toISOString() });
      return ok(m.recipient, m.messageId);
    }
    const handle = d.instance.handle;
    return await this.serial(handle, async () => {
      const l = await this.hydrate(handle);
      const s = await this.screen(l, m.sender, m.body);
      if (!s.ok) {
        if (s.duplicate) return ok(m.recipient, m.messageId);
        this.say(handle, `inbox ${m.box} ${m.messageId.slice(0, 12)}: rejected: ${s.reason}`);
        return err(400, "ERR_REJECTED", s.reason);
      }
      const signed = signedPart(s.envelope);
      const envelope = encode(signed).cid;
      try {
        const entry = await admitEntry(l.kernel as unknown as Runtime, this.o.host, { envelope, box: m.box, body: encode(decode(s.body)).cid }, { envelope: signed, body: s.body }, this.now());
        this.say(handle, `inbox ${m.box}: admitted ${short(envelope)} as ${short(entry)}`);
        this.settle(l);
      } catch (e) {
        if (e instanceof Rejected && e.reason === "duplicate-envelope") return ok(m.recipient, m.messageId);
        throw e;
      }
      return ok(m.recipient, m.messageId);
    });
  }

  /** docs/MESSAGES.md "Replay protection": a BRC-169 envelope, signed by the authenticated sender, to this instance, new, decrypting to canonical dag-cbor matching contentHash. */
  private async screen(l: Loaded, sender: string, raw: unknown): Promise<{ ok: true; envelope: Envelope; body: Uint8Array } | { ok: false; reason: string; duplicate?: boolean }> {
    let env: unknown = raw;
    try {
      for (let i = 0; i < 2 && typeof env === "string"; i++) env = JSON.parse(env);
    } catch {
      return { ok: false, reason: "body is not JSON" };
    }
    if (!isEnvelope(env)) return { ok: false, reason: "body is not a BRC-169 envelope" };
    if (!verify(env)) return { ok: false, reason: "envelope signature does not verify" };
    if (sender !== env.sender.identityKey) return { ok: false, reason: `authenticated sender ${short(sender)} is not envelope.sender ${short(env.sender.identityKey)}` };
    try {
      if (brc78Decode(Buffer.from(env.content, "base64")).recipient !== l.identity) return { ok: false, reason: "not addressed to this instance" };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
    const id = encode(signedPart(env)).cid;
    if (await l.kernel.store.log.byEnvelope(id)) return { ok: false, reason: `envelope ${short(id)} was already admitted`, duplicate: true };
    let body: Uint8Array;
    try {
      body = (await open(l.wallet, env)).body;
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
    try {
      if (!Buffer.from(encode(decode(body)).bytes).equals(body)) return { ok: false, reason: "the body is not canonical dag-cbor" };
    } catch {
      return { ok: false, reason: "the body is not dag-cbor" };
    }
    return { ok: true, envelope: env, body };
  }

  /** An instance's emit: delivered here or refused; its outcome goes back into the emitter. */
  private async route(handle: string, identity: string, o: Outbound): Promise<void> {
    const what = `outbox ${o.box} → ${short(o.to)}: ${short(o.cid)}`;
    let r: Delivered;
    try {
      r = await this.deliver({ sender: identity, recipient: o.to, box: o.box, body: o.envelope, messageId: o.cid.toString() });
    } catch (e) {
      r = err(500, "ERR_INTERNAL", (e as Error).message);
    }
    const failed = r.status !== 200;
    const reason = failed ? `Message Box send failed with HTTP ${r.status} (${String(r.body.code)}): ${String(r.body.description)}` : undefined;
    this.say(handle, `${what}${failed ? `: ${reason}: failed` : ""}`);
    void this.serial(handle, async () => {
      const l = await this.hydrate(handle);
      await admitEntry(l.kernel as unknown as Runtime, this.o.host, { outcome: { emit: o.emit as CID, status: failed ? "failed" : "delivered", ...(reason ? { reason } : {}) } }, {}, this.now());
      this.settle(l);
    }).catch((e: Error) => this.say(handle, `${what}: outcome not admitted: ${e.message}`));
  }

  // ---------------------------------------------------------------- HTTP

  /** The BRC-33 routes, the registration and the paymail PKI, after auth. */
  private async app(r: AuthedRequest): Promise<AppResponse> {
    const path = r.path.replace(/^\/messagebox(?=\/)/, "");
    let body: Record<string, unknown> = {};
    try { if (r.body.length) body = JSON.parse(new TextDecoder().decode(r.body)) as Record<string, unknown>; } catch { return { status: 400, body: { status: "error", code: "ERR_BAD_JSON", description: "The body is not JSON." } }; }
    if (r.method !== "POST") return { status: 404, body: { status: "error", code: "ERR_NOT_FOUND" } };
    switch (path) {
      case "/sendMessage": {
        const m = body.message as Record<string, unknown> | undefined;
        if (!m) return { status: 400, body: { status: "error", code: "ERR_MESSAGE_REQUIRED", description: "Please provide a valid message to send!" } };
        if (typeof m.messageBox !== "string" || !m.messageBox.trim()) return { status: 400, body: { status: "error", code: "ERR_INVALID_MESSAGEBOX", description: "Invalid message box." } };
        if (m.body === undefined || m.body === null || m.body === "") return { status: 400, body: { status: "error", code: "ERR_INVALID_MESSAGE_BODY", description: "Invalid message body." } };
        const recipient = Array.isArray(m.recipient) ? m.recipient[0] : m.recipient;
        const messageId = Array.isArray(m.messageId) ? m.messageId[0] : m.messageId;
        if (typeof recipient !== "string" || !KEY.test(recipient.trim())) return { status: 400, body: { status: "error", code: "ERR_INVALID_RECIPIENT_KEY", description: `Invalid recipient key: ${String(recipient)}` } };
        if (typeof messageId !== "string" || !messageId.trim()) return { status: 400, body: { status: "error", code: "ERR_MESSAGEID_REQUIRED", description: "Missing messageId." } };
        const d = await this.deliver({ sender: r.identityKey, recipient: recipient.trim(), box: m.messageBox.trim(), body: m.body, messageId });
        return { status: d.status, body: d.body };
      }
      case "/listMessages": {
        const box = body.messageBox;
        if (typeof box !== "string" || !box) return { status: 400, body: { status: "error", code: "ERR_MESSAGEBOX_REQUIRED", description: "Please provide the name of a valid MessageBox!" } };
        const ms = await this.mail.list(r.identityKey, box);
        return { status: 200, body: { status: "success", messages: ms.map((m) => ({ messageId: m.messageId, body: JSON.stringify({ message: m.body }), sender: m.sender, createdAt: m.createdAt, updatedAt: m.createdAt })) } };
      }
      case "/acknowledgeMessage": {
        const ids = body.messageIds;
        if (!Array.isArray(ids) || !ids.length || ids.some((x) => typeof x !== "string")) return { status: 400, body: { status: "error", code: "ERR_INVALID_MESSAGE_ID", description: "Message IDs must be formatted as an array of strings!" } };
        const n = await this.mail.ack(r.identityKey, ids as string[]);
        if (!n) return { status: 400, body: { status: "error", code: "ERR_INVALID_ACKNOWLEDGMENT", description: "Message not found!" } };
        return { status: 200, body: { status: "success" } };
      }
      case "/account/register": return this.register(r.identityKey, body.username);
    }
    return { status: 404, body: { status: "error", code: "ERR_NOT_FOUND" } };
  }

  /** A mailbox for `identity` under `username` (kept by the mailbox host instance). 409 if the name is another's. */
  register(identity: string, username: unknown, domain = "localhost"): AppResponse {
    const name = typeof username === "string" ? username.trim().toLowerCase() : "";
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) return { status: 400, body: { error: "invalid username" } };
    if (this.o.db.byIdentity(identity)) return { status: 409, body: { error: "this identity is an instance on this host" } };
    const taken = this.o.db.get(name) ?? this.o.db.mailboxByHandle(name, domain);
    if (taken && ("instance" in taken ? taken.identity !== identity : true)) return { status: 409, body: { error: `username ${name} is taken` } };
    const mine = this.o.db.mailbox(identity);
    if (mine && mine.handle === name) return { status: 409, body: { error: `already registered as ${name}` } };
    const keeper = this.o.mailboxHost ?? this.o.db.list("enabled")[0]?.handle;
    if (!keeper) return { status: 503, body: { error: "no instance to keep the mailbox" } };
    const mb = this.o.db.addMailbox(identity, name, domain, mine?.instance ?? keeper);
    this.say("router", `registered ${name}@${domain} (${short(identity)}), kept by ${mb.instance}`);
    return { status: 200, body: { identityKey: identity, username: name, handle: `${name}@${domain}` } };
  }

  /** The HTTP handler: CORS, paymail, and everything else behind auth. */
  handler(): (req: IncomingMessage, res: ServerResponse) => void {
    return (req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "*");
      res.setHeader("Access-Control-Allow-Methods", "*");
      res.setHeader("Access-Control-Expose-Headers", "*");
      if (req.method === "OPTIONS") { res.writeHead(200).end(); return; }
      const path = new URL(req.url ?? "/", "http://router").pathname;
      if (req.method === "GET") {
        const m = /^\/bsvalias\/id\/([^/]+)$/.exec(path);
        if (m) {
          const [handle, domain = "localhost"] = decodeURIComponent(m[1]!).split("@");
          const key = this.o.db.identityOf(handle!, domain);
          send(res, key ? { status: 200, body: { bsvalias: "1.0", handle: `${handle}@${domain}`, pubkey: key } } : { status: 404, body: { error: "not found" } });
          return;
        }
        send(res, { status: 404, body: { status: "error", code: "ERR_NOT_FOUND" } });
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        this.auth.handle(req, res, new Uint8Array(Buffer.concat(chunks)), (r) => this.app(r))
          .catch((e: Error) => { if (!res.headersSent) send(res, { status: 500, body: { status: "error", code: "ERR_INTERNAL", description: e.message } }); });
      });
    };
  }

  /** Listen on host:port (0: any). */
  listen(port: number, host = "127.0.0.1"): Promise<Server> {
    const server = createServer(this.handler());
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => { server.off("error", reject); resolve(server); });
    });
  }
}

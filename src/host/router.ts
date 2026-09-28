// The host as a reverse proxy (#40): each instance is an HTTP server — its
// front door (programs/frontdoor) — at an origin of its own, and the router
// only picks the instance a request is for and forwards it. Routing comes
// before authentication, because a BRC-104 handshake does not name its
// recipient: the URL is the recipient. The router holds no auth state and no
// mailbox: it keeps the hostname → instance map (host.db), the kernels it has
// hydrated, the waker, the feeds, the fuel ledger.
//
//   http://<handle>.localhost:<port>/…   an instance's origin (the Host header). The stock AuthFetch keeps one
//                                         session per origin, and shakes hands at <origin>/.well-known/auth: this
//                                         is the form it is served by. (SKEIN_INSTANCE_ORIGIN: another template.)
//   http://<host>:<port>/@<handle>/…      the same instance for our own clients (a dev form): the router strips
//                                         the prefix for the routes; the client signs the path it sent, and its
//                                         handshake goes under the prefix (src/client/raw.ts).
//   GET  /manifest.json                   BRC-169: metanet.handles.resolve
//   GET  /.well-known/metanet-handles/resolve?handle=h   {handle, domain, identityKey, messagebox}: an agent's own
//                                         identity; for a mailbox instance, its owner's — and the instance's origin
//   GET  /bsvalias/id/<handle>@<domain>   paymail PKI (identity keys by handle)
//   POST /account/register {username, identityKey, signature}   a mailbox instance for that identity (the
//                                         signature: [2, "skein register"], key ID the username, counterparty
//                                         anyone, over "register <username>")
//   POST /callback/<handle>               ARC's status callback (an arc-callback feed), no auth
//
// A request for an instance is one kernel `call` of its front door (the raw
// request in; the answer, signed on the session, out): hydrate on demand,
// `admit` the entries the front door returns, and charge the call's fuel to
// the ledger (caller, op). A read — a poll — writes nothing: no entry, no
// byte. The instances' outbound http (the messagebox's delivery, a resolve)
// comes back here through the kernels' `http`: a URL of this host's own is
// answered in process (the same path, no socket), any other goes out.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { ProtoWallet, Utils, type WalletInterface } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { rootIdentity } from "../runtime/identity.ts";
import { DEFAULTS, short, stampMs } from "../runtime/log.ts";
import { Rejected } from "../runtime/store.ts";
import type { Stamp } from "../runtime/syscalls.ts";
import { Feeds, feedsOf, type FeedSpec } from "./feeds.ts";
import { now as clockNow } from "./entry.ts";
import { boot, bootStore, type BootSource, type Booted } from "./boot.ts";
import { admitAll, callFrontDoor, headerMap, type FrontAnswer } from "./frontdoor.ts";
import { admit2, keyHex, type Genesis2Config } from "./genesis.ts";
import type { HostDb, InstanceRow } from "./instances.ts";
import { Kernel, type HttpRequest, type HttpResponse, type Sleeper } from "./kernel.ts";

type Named = { handle: string; domain: string };

export interface RouterOptions {
  db: HostDb;
  /** Each row's oracle: the wallet its kernel's `wallet` import is answered from. */
  walletFor(row: InstanceRow): Promise<WalletInterface> | WalletInterface;
  /** A new agent's genesis: its owner (required to write one), the inference peer, their names. */
  owner?: string;
  infer?: string;
  ownerHandle?: Named;
  inferHandle?: Named;
  fuelPerStep?: string;
  /** A new genesis's extra seed subscriptions and defaults (over DEFAULTS), e.g. the wallet's (#29). */
  genesis?: { subscriptions?: Array<{ sender?: string; box: string; handler: CID }>; defaults?: Record<string, string>; feeds?: FeedSpec[] };
  /** The router-held feeds' limits (feeds.ts). */
  feeds?: { maxQueue?: number; backoff?: { min: number; max: number } };
  /** Answers programs' HTTP to URLs that are not this host's (#15, #40); default: SKEIN_HTTP=fetch performs them (fetchHttp), else refused. */
  http?(req: HttpRequest): Promise<HttpResponse>;
  /** Stop a kernel this long after its last call (ms); 0: never. Default 5 minutes. */
  idleMs?: number;
  /** Where a new mailbox instance's store goes: <home>/instances/<handle>/runtime.db. */
  home?: string;
  /** An instance's origin, `{handle}` and `{port}` filled in; default http://{handle}.localhost:{port}. */
  instanceOrigin?: string;
  /** This host's own origin (the manifest, a genesis's resolveOrigin); default http://127.0.0.1:{port}. */
  origin?: string;
  /** The owner's messagebox URL for a new agent's genesis; default the owner's mailbox instance here, if there is one. */
  ownerMessagebox?: string;
  /** How often the fuel ledger is written (ms); default 5000. */
  ledgerMs?: number;
  /** Tests: the clock entries are stamped with. */
  now?: () => Stamp;
  /** Lines, by source: an instance's handle, or "router". */
  log?(source: string, line: string): void;
  /** Kernel process settings. */
  kernel?: { command?: string; env?: Record<string, string | undefined> };
}

interface Loaded { row: InstanceRow; kernel: Kernel; identity: string; wallet: WalletInterface }

/** A request as the router takes it: the full URL (its host is the Host header's), lower-cased headers, the body. */
export interface RouterRequest { method: string; url: string; headers: Record<string, string>; body: Uint8Array }
export interface RouterResponse { status: number; headers: Record<string, string>; body: Uint8Array }

const json = (status: number, v: unknown): RouterResponse => ({ status, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(v)) });
const KEY = /^0[23][0-9a-f]{64}$/;
export const REGISTER_PROTOCOL: [2, string] = [2, "skein register"];

/**
 * SKEIN_HTTP=fetch: programs' http requests performed for real. A wasi:http
 * request's options (#15, recorded with the request, in ns) are applied here:
 * connect + first-byte bound the wait for the response head, between-bytes
 * each read of the body.
 */
export async function fetchHttp(req: HttpRequest): Promise<HttpResponse> {
  const o = req.options ?? {};
  const head = (o.connectTimeout ?? 0) + (o.firstByteTimeout ?? 0);
  const ctl = new AbortController();
  const timer = head > 0 ? setTimeout(() => ctl.abort(new Error("timed out waiting for the response")), Math.ceil(head / 1e6)) : undefined;
  try {
    const r = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body as BodyInit | undefined, signal: ctl.signal });
    clearTimeout(timer);
    const headers = Object.fromEntries(r.headers.entries());
    if (!o.betweenBytesTimeout || !r.body) return { status: r.status, headers, body: new Uint8Array(await r.arrayBuffer()) };
    const chunks: Uint8Array[] = [];
    const reader = r.body.getReader();
    for (;;) {
      let t: ReturnType<typeof setTimeout> | undefined;
      const stall = new Promise<never>((_, no) => { t = setTimeout(() => no(new Error("timed out between bytes")), Math.ceil(o.betweenBytesTimeout! / 1e6)); });
      const { done, value } = await Promise.race([reader.read(), stall]).finally(() => clearTimeout(t));
      if (done) break;
      chunks.push(value);
    }
    return { status: r.status, headers, body: Buffer.concat(chunks) };
  } finally {
    clearTimeout(timer);
  }
}

export class Router {
  readonly o: RouterOptions;
  readonly feeds: Feeds;
  readonly loaded = new Map<string, Loaded>();
  private loading = new Map<string, Promise<Loaded>>();
  private queues = new Map<string, Promise<unknown>>();
  /** handle → the earliest sleeper deadline (ms), kept while the kernel is stopped. */
  readonly deadlines = new Map<string, number>();
  private timer?: ReturnType<typeof setTimeout>;
  private idleTimer?: ReturnType<typeof setInterval>;
  private ledgerTimer?: ReturnType<typeof setInterval>;
  /** The fuel of calls not yet written to the ledger: instance\0caller\0op → {calls, fuel}. */
  private owed = new Map<string, { calls: number; fuel: number }>();
  private stopped = false;
  servers: Server[] = [];
  port = 0;

  constructor(o: RouterOptions) {
    this.o = o;
    this.feeds = new Feeds({
      admit: (h, box, ev) => this.admitEvent(h, box, ev), log: (s, l) => this.say(s, l),
      maxQueue: o.feeds?.maxQueue, backoff: o.feeds?.backoff,
    });
    const idle = o.idleMs ?? 300_000;
    if (idle > 0) this.idleTimer = setInterval(() => void this.reap(idle), Math.max(50, Math.min(idle / 4, 10_000)));
    this.ledgerTimer = setInterval(() => this.flushLedger(), o.ledgerMs ?? 5000);
  }

  private say(source: string, line: string): void { this.o.log?.(source, line); }
  private now(): Stamp { return (this.o.now ?? clockNow)(); }
  /** The router's clock, as entries are stamped. */
  nowStamp(): Stamp { return this.now(); }

  /** This host's own origin. */
  origin(): string { return (this.o.origin ?? "http://127.0.0.1:{port}").replace("{port}", String(this.port)); }
  /** An instance's origin: where its front door is, what BRC-169 publishes as its messagebox. */
  originOf(handle: string): string {
    return (this.o.instanceOrigin ?? "http://{handle}.localhost:{port}").replace("{handle}", handle).replace("{port}", String(this.port));
  }

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
    clearInterval(this.ledgerTimer);
    this.flushLedger();
    for (const s of this.servers) s.close();
    this.feeds.stop();
    await Promise.all([...this.loaded.values()].map((l) => l.kernel.stop()));
    this.loaded.clear();
  }

  /**
   * A plain entry (#29): an event from a feed the router holds (a header, a
   * proof, a transaction status), put as a record and admitted into the
   * instance in `box`. The kernel routes it by its `subject` to the thread
   * awaiting that record, else to a sender-less subscription on `box`.
   */
  async admitEvent(handle: string, box: string, event: Record<string, unknown>): Promise<CID> {
    return await this.serial(handle, async () => {
      const l = await this.hydrate(handle);
      const cid = await l.kernel.store.put(event as never);
      const e = await admit2(l.kernel, { box, event: cid } as never, {}, this.now());
      this.settle(l);
      return e;
    });
  }

  /** Until nothing is queued and every loaded kernel has processed what it was given (tests, corpus). */
  async settled(): Promise<void> {
    for (let i = 0; i < 1000; i++) {
      await Promise.all([...this.queues.values()]);
      await Promise.all([...this.loaded.values()].map((l) => l.kernel.idle().catch(() => {})));
      await new Promise((r) => setImmediate(r));
      if (!this.queues.size && [...this.loaded.values()].every((l) => l.kernel.busy === 0)) return;
    }
  }

  /** Run `f` after everything else queued for this instance (the waker's and the feeds' admissions are serial per instance). */
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
    const kernel = new Kernel({
      db: row.store, handle: row.handle, domain: row.domain, wallet, command: this.o.kernel?.command, env: this.o.kernel?.env,
      log: (line) => this.say(handle, line),
      http: (req) => this.http(req),
      sleepers: (s) => this.sleepersOf(handle, s),
      exited: (code, signal) => {
        if (this.loaded.get(handle)?.kernel === kernel) this.loaded.delete(handle);
        if (code !== 0) this.say(handle, `kernel exited (${signal ?? `code ${code}`})`);
      },
    });
    try {
      if (!(await kernel.store.log.tip())) {
        // No tree was loaded into this store (`skein-host add --boot/--packet` does that): the stock system, through the same loader.
        const b = await boot(kernel, { kind: "code" }, this.genesisConfig(row, identity), this.now());
        this.say(handle, `genesis ${b.entry}`);
      }
      const g = await kernel.genesis() as { identity?: unknown } | null;
      if (!g) throw new Error("the store's log does not start with a genesis this kernel reads (format 3, #40): start a new store (re-genesis)");
      if (keyHex(g.identity) !== identity) throw new Error(`the oracle (${short(identity)}) is not this instance's identity (${short(keyHex(g.identity))})`);
      await kernel.start();
      await kernel.running(identity);
      void kernel.idle().catch(() => {}); // busy until what start resumed is done
      if (!row.identity) this.o.db.add(row.handle, { identity });
      this.feeds.declare(handle, feedsOf(g as Record<string, unknown>));
    } catch (e) {
      await kernel.stop(1000);
      throw e;
    }
    const l: Loaded = { row, kernel, identity, wallet };
    this.loaded.set(handle, l);
    this.say("router", `hydrated ${handle} (${short(identity)})`);
    return l;
  }

  /**
   * Boot a row's empty store from a system tree or a checkpoint (issue #4,
   * boot.ts) before its first hydration; the row's identity is its oracle's.
   */
  async bootRow(handle: string, src: BootSource): Promise<Booted> {
    const row = this.o.db.get(handle);
    if (!row) throw new Error(`no instance ${handle}`);
    if (this.loaded.has(handle)) throw new Error(`${handle} is loaded: boot only an empty store`);
    const identity = await rootIdentity(await this.o.walletFor(row));
    const c = src.kind === "checkpoint" ? { identity, owner: this.o.owner ?? identity, handle: row.handle, domain: row.domain } : this.genesisConfig(row, identity, src.kind === "code");
    const b = await bootStore({ db: row.store, handle: row.handle, domain: row.domain, command: this.o.kernel?.command, env: this.o.kernel?.env, log: (l) => this.say(handle, l) }, src, c, this.now());
    this.o.db.add(row.handle, { identity, ...(b.tree ? { tree: b.tree.toString() } : {}) });
    return b;
  }

  /** The owner's messagebox: configured, else its mailbox instance here. */
  ownerMessagebox(): string | undefined {
    if (this.o.ownerMessagebox) return this.o.ownerMessagebox;
    const mb = this.o.owner ? this.o.db.mailboxOf(this.o.owner) : undefined;
    return mb ? this.originOf(mb.handle) : undefined;
  }

  /** What this host brings to a new instance's genesis (boot.ts): the owner and its messagebox, the inference peer, their names, the host's defaults. */
  genesisConfig(row: Pick<InstanceRow, "handle" | "domain"> & Partial<Pick<InstanceRow, "kind" | "owner">>, identity: string, code = true): Genesis2Config {
    if (row.kind === "mailbox") {
      if (!row.owner) throw new Error(`${row.handle}: a mailbox instance names its owner`);
      return { identity, owner: row.owner, handle: row.handle, domain: row.domain, mailbox: true };
    }
    if (!this.o.owner) throw new Error("an empty store needs the owner's identity key (SKEIN_OWNER) for its genesis");
    const hostDefaults = { ...this.o.genesis?.defaults, ...(this.o.fuelPerStep ? { fuelPerStep: this.o.fuelPerStep } : {}) };
    const warn = (l: string) => this.say(row.handle, l);
    const facts = { ownerMessagebox: this.ownerMessagebox(), resolveOrigin: this.origin() };
    if (!code) {
      // A system tree: its config wins; the host fills what it leaves unset. SKEIN_FUEL_PER_STEP stays an explicit (dev) override.
      return {
        identity, owner: this.o.owner, handle: row.handle, domain: row.domain, infer: this.o.infer, ownerHandle: this.o.ownerHandle, inferHandle: this.o.inferHandle,
        feeds: this.o.genesis?.feeds, defaults: this.o.genesis?.defaults, overrides: this.o.fuelPerStep ? { fuelPerStep: this.o.fuelPerStep } : undefined, warn, ...facts,
      };
    }
    return {
      identity, owner: this.o.owner, handle: row.handle, domain: row.domain, infer: this.o.infer, ownerHandle: this.o.ownerHandle, inferHandle: this.o.inferHandle,
      // Code genesis takes DEFAULTS under the host's.
      defaults: Object.keys(hostDefaults).length ? { ...DEFAULTS, ...hostDefaults } : undefined,
      subscriptions: this.o.genesis?.subscriptions,
      feeds: this.o.genesis?.feeds,
      ...facts,
    };
  }

  /**
   * A mailbox instance for identity `owner` (#40): registering an outside
   * identity is creating its mailbox instance — the front door and the
   * messagebox, keeping mail for it from anyone. Its genesis is written at the
   * first hydration. 409 if the handle is taken by someone else.
   */
  addMailbox(handle: string, owner: string, domain = "localhost"): InstanceRow {
    const name = handle.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) throw Object.assign(new Error("invalid username"), { status: 400 });
    if (!KEY.test(owner)) throw Object.assign(new Error("invalid identity key"), { status: 400 });
    const had = this.o.db.get(name);
    if (had && !(had.kind === "mailbox" && had.owner === owner)) throw Object.assign(new Error(`username ${name} is taken`), { status: 409 });
    const mine = this.o.db.mailboxOf(owner);
    if (mine && mine.handle !== name) throw Object.assign(new Error(`already registered as ${mine.handle}`), { status: 409 });
    if (had) return had;
    const home = this.o.home ?? ".";
    const row = this.o.db.add(name, { domain, kind: "mailbox", owner, store: join(home, "instances", name, "runtime.db") });
    this.say("router", `mailbox instance ${name}@${domain} for ${short(owner)} at ${this.originOf(name)}`);
    return row;
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
            const e = await admit2(l.kernel, { wake: thread }, {}, at);
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

  // ---------------------------------------------------------------- the fuel ledger

  private charge(instance: string, caller: string, op: string, fuel: number): void {
    const k = `${instance}\0${caller}\0${op}`;
    const x = this.owed.get(k) ?? { calls: 0, fuel: 0 };
    x.calls += 1;
    x.fuel += fuel;
    this.owed.set(k, x);
  }

  /** Write what calls cost since the last flush (host.db, never the log). */
  flushLedger(): void {
    if (!this.owed.size) return;
    const rows = [...this.owed].map(([k, v]) => { const [instance, caller, op] = k.split("\0") as [string, string, string]; return { instance, caller, op, ...v }; });
    this.owed.clear();
    try { this.o.db.charge(rows); } catch (e) { this.say("router", `ledger: ${(e as Error).message}`); }
  }

  // ---------------------------------------------------------------- HTTP

  /** Whether a URL is this host's own (answered in process: no DNS, no socket). */
  isLocal(url: string): boolean {
    let u: URL;
    try { u = new URL(url); } catch { return false; }
    if (!this.port) return false;
    const mine = (o: string) => { try { return new URL(o).host === u.host; } catch { return false; } };
    if (mine(this.origin())) return true;
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    if (port !== String(this.port)) return false;
    const h = u.hostname.toLowerCase();
    return h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "::1" || h.endsWith(".localhost");
  }

  /** Which instance a URL is for: `/@<handle>` (stripped for the routes), or a `<handle>.` host name. */
  target(url: URL): { handle: string; route: string } | undefined {
    const enabled = (h: string) => this.o.db.get(h)?.status === "enabled";
    const m = /^\/@([^/]+)(\/.*)?$/.exec(url.pathname);
    if (m) { const h = decodeURIComponent(m[1]!); return enabled(h) ? { handle: h, route: m[2] ?? "/" } : undefined; }
    const name = url.hostname.toLowerCase();
    const label = name.includes(".") ? name.split(".")[0]! : "";
    if (label && enabled(label)) return { handle: label, route: url.pathname };
    return undefined;
  }

  /** A program's HTTP request (the kernel's `http`): this host's own URLs in process, the rest as configured. */
  async http(req: HttpRequest): Promise<HttpResponse> {
    if (this.isLocal(req.url)) {
      const r = await this.dispatch({ method: req.method, url: req.url, headers: headerMap(req.headers ?? {}), body: req.body ?? new Uint8Array() });
      return { status: r.status, headers: r.headers, body: r.body };
    }
    const f = this.o.http ?? (process.env.SKEIN_HTTP === "fetch" ? fetchHttp : undefined);
    if (!f) throw new Error(`this host answers no http beyond its own (${req.url})`);
    return await f(req);
  }

  /** One request, whoever made it: a socket's, or an instance's own http. */
  async dispatch(req: RouterRequest): Promise<RouterResponse> {
    const url = new URL(req.url);
    const t = this.target(url);
    if (t) return await this.forward(t.handle, t.route, url, req);
    const path = url.pathname;
    if (req.method === "GET" && path === "/manifest.json") {
      return json(200, { metanet: { handles: { resolve: `${this.origin()}/.well-known/metanet-handles/resolve` } } });
    }
    if (req.method === "GET" && path === "/.well-known/metanet-handles/resolve") {
      const q = (url.searchParams.get("handle") ?? "").replace(/^@/, "");
      const [h0, d] = q.includes("@") ? q.split("@") : [q, "localhost"];
      const handle = h0!.split("+")[0]!.toLowerCase(), domain = (d ?? "localhost").toLowerCase();
      const row = this.o.db.get(handle);
      const key = this.o.db.identityOf(handle, domain);
      if (!row || row.status !== "enabled" || !key) return json(404, { status: "error", code: "ERR_NOT_FOUND", description: `no handle ${handle}@${domain} here` });
      return json(200, { handle, domain, identityKey: key, messagebox: this.originOf(handle) });
    }
    const pki = /^\/bsvalias\/id\/([^/]+)$/.exec(path);
    if (req.method === "GET" && pki) {
      const [handle, domain = "localhost"] = decodeURIComponent(pki[1]!).split("@");
      const key = this.o.db.identityOf(handle!, domain);
      return key ? json(200, { bsvalias: "1.0", handle: `${handle}@${domain}`, pubkey: key }) : json(404, { error: "not found" });
    }
    const callback = /^\/callback\/([^/]+)$/.exec(path);
    if (req.method === "POST" && callback) {
      const r = this.feeds.callback(decodeURIComponent(callback[1]!), req.headers, req.body);
      return json(r.status, r.body);
    }
    if (req.method === "POST" && path === "/account/register") return await this.register(req.body);
    return json(404, { status: "error", code: "ERR_NOT_FOUND", description: "no instance here: an instance is at http://<handle>.localhost:<port>/ or /@<handle>/" });
  }

  /** POST /account/register {username, identityKey, signature}: a mailbox instance for a key its holder signed for. */
  private async register(raw: Uint8Array): Promise<RouterResponse> {
    let b: { username?: unknown; identityKey?: unknown; signature?: unknown };
    try { b = JSON.parse(new TextDecoder().decode(raw)); } catch { return json(400, { error: "the body is not JSON" }); }
    const username = typeof b.username === "string" ? b.username.trim().toLowerCase() : "";
    const key = typeof b.identityKey === "string" ? b.identityKey : "";
    const sig = typeof b.signature === "string" ? b.signature : "";
    if (!KEY.test(key) || !/^[0-9a-f]+$/i.test(sig)) return json(400, { error: "want {username, identityKey, signature (hex)}" });
    try {
      const v = await new ProtoWallet("anyone").verifySignature({ protocolID: REGISTER_PROTOCOL, keyID: username, counterparty: key, data: Utils.toArray(`register ${username}`, "utf8"), signature: Utils.toArray(sig, "hex") });
      if (!v.valid) throw new Error("invalid");
    } catch { return json(401, { error: "the signature does not verify for that identity" }); }
    try {
      const row = this.addMailbox(username, key);
      return json(200, { identityKey: key, username: row.handle, handle: `${row.handle}@${row.domain}`, messagebox: this.originOf(row.handle) });
    } catch (e) {
      return json((e as { status?: number }).status ?? 500, { error: (e as Error).message });
    }
  }

  /** A request for an instance: one kernel call of its front door; what it returns admitted; its fuel charged. */
  private async forward(handle: string, route: string, url: URL, req: RouterRequest): Promise<RouterResponse> {
    let l: Loaded;
    try { l = await this.hydrate(handle); } catch (e) { return json(503, { status: "error", code: "ERR_UNAVAILABLE", description: (e as Error).message }); }
    const caller = req.headers["x-bsv-auth-identity-key"] ?? "";
    const a: FrontAnswer = await callFrontDoor(l.kernel, { method: req.method, path: url.pathname, route, query: url.search, headers: req.headers, body: req.body }, { now: stampMs(this.now()) });
    this.charge(handle, caller, route, a.fuel);
    if (a.admit?.length) {
      try {
        await admitAll(l.kernel, a.admit, () => this.now());
      } catch (e) {
        // A replayed message is already in: the answer stands. Anything else is the host's failure.
        if (!(e instanceof Rejected && e.reason === "duplicate-envelope")) {
          this.say(handle, `admit: ${(e as Error).message}`);
          return json(500, { status: "error", code: "ERR_ADMIT", description: (e as Error).message });
        }
      }
      this.settle(l);
    }
    if (a.then) {
      // An answer a step computes (an overlay's submit): once what was admitted is processed.
      await l.kernel.idle();
      const t = await l.kernel.invoke(a.then.program, a.then.fn, a.then.arg, { now: stampMs(this.now()) });
      this.charge(handle, caller, `${route} (then)`, t.fuel);
      if (!t.ok) return json(500, { status: "error", code: "ERR_INTERNAL", description: t.error });
      const r = dagCbor.decode(t.result) as { status?: number; type?: string; body?: Uint8Array };
      return { status: r.status ?? 200, headers: { "content-type": r.type ?? "application/json" }, body: r.body ?? new Uint8Array() };
    }
    return { status: a.status, headers: a.headers, body: a.body };
  }

  /** The HTTP handler: CORS, then dispatch. */
  handler(): (req: IncomingMessage, res: ServerResponse) => void {
    return (req, res) => {
      const cors: Record<string, string> = {
        "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*", "access-control-expose-headers": "*",
      };
      if (req.method === "OPTIONS") { res.writeHead(200, cors).end(); return; }
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const url = `http://${req.headers.host ?? `127.0.0.1:${this.port}`}${req.url ?? "/"}`;
        this.dispatch({ method: req.method ?? "GET", url, headers: headerMap(req.headers), body: new Uint8Array(Buffer.concat(chunks)) })
          .then((r) => { res.writeHead(r.status, { ...cors, ...r.headers, "content-length": String(r.body.length) }); res.end(r.body); })
          .catch((e: Error) => { if (!res.headersSent) { res.writeHead(500, { ...cors, "content-type": "application/json" }); res.end(JSON.stringify({ status: "error", code: "ERR_INTERNAL", description: e.message })); } });
      });
    };
  }

  /**
   * Listen on `port` (0: any) at each of `hosts` (default the IPv4 and IPv6
   * loopbacks: `<handle>.localhost` resolves to either).
   */
  async listen(port: number, hosts: string | string[] = ["127.0.0.1", "::1"]): Promise<Server> {
    const list = Array.isArray(hosts) ? hosts : [hosts];
    for (const [i, host] of list.entries()) {
      const server = createServer(this.handler());
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(i === 0 ? port : this.port, host, () => { server.off("error", reject); resolve(); });
        });
      } catch (e) {
        if (i === 0) throw e;
        this.say("router", `not listening on ${host}: ${(e as Error).message}`);
        continue;
      }
      if (i === 0) this.port = (server.address() as { port: number }).port;
      this.servers.push(server);
    }
    return this.servers[0]!;
  }
}

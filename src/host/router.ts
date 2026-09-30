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
//   POST /arc/v1/tx                       the host's broadcaster (#58, arc.ts): a transaction to Arcade, under the
//   GET  /arc/v1/tx/<txid>                host's callback token, answered with Arcade's answer; its status. An
//                                         instance's genesis names it as `defaults.walletArc` when the host has an Arcade
//   POST /arc/callback                    Arcade's webhook (Bearer: the host token)
//
// The broadcaster's one SSE subscription (arc.ts) routes each status to every
// instance whose state holds the transaction (a `has` of its CID, cached).
//
// A request for an instance is one kernel `call` of its front door (the raw
// request in; the answer, signed on the session, out): hydrate on demand,
// `admit` the entries the front door returns, and charge the call's fuel to
// the ledger (caller, op). A read — a poll — writes nothing: no entry, no
// byte. The instances' outbound http (the messagebox's delivery, a resolve)
// comes back here through the kernels' `http`: a URL of this host's own is
// answered in process (the same path, no socket), any other goes out.
//
// The libp2p host (#51, p2p.ts) is the router's too: one node per instance
// whose genesis declares `libp2p`, each topic message and stream frame one
// front-door call (fn "libp2p", `p2pInbound`: the verdict back to GossipSub,
// an accept's entry admitted first, the fuel charged), and the kernels'
// `libp2p` import answered here (`p2pRequest`); a frame for a thread resting
// on `receive` admits its wake (`wakeThread`).
//
// The router is the instances' clock too (#60, cron.ts): each genesis's
// `jobs`, a plain `cron` event admitted into the job's box when it is due
// (an idle-stopped instance hydrated for one only if something in it
// subscribes that box).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { ProtoWallet, Utils, type WalletInterface } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { rootIdentity } from "../runtime/identity.ts";
import { DEFAULTS, short, stampMs } from "../runtime/log.ts";
import { Rejected } from "../runtime/store.ts";
import type { Stamp } from "../runtime/syscalls.ts";
import { ARC_ROUTE, Broadcaster, type ArcConfig } from "./arc.ts";
import { Feeds, feedsOf, txCid, type FeedSpec } from "./feeds.ts";
import { Cron, jobsOf, type JobSpec } from "./cron.ts";
import { currentSubscriptions } from "../runtime/subscriptions.ts";
import { openStoreFile } from "../runtime/index-store.ts";
import { existsSync } from "node:fs";
import { now as clockNow } from "./clock.ts";
import { boot, bootStore, type BootSource, type Booted } from "./boot.ts";
import { admitAll, callFrontDoor, headerMap, type FrontAnswer } from "./frontdoor.ts";
import { admit2, keyHex, type Genesis2Config, type Libp2pSpec, type RouteSpec } from "./genesis.ts";
import type { HostDb, InstanceRow } from "./instances.ts";
import { Kernel, type HttpRequest, type HttpResponse, type Sleeper } from "./kernel.ts";
import { DEFAULT_LISTEN, libp2pOf, P2PHost, type InboundAnswer, type InboundCall, type P2PHostConfig, type P2PRequest, type P2PResult } from "./p2p.ts";
import { peerIdFromMultihash } from "@libp2p/peer-id";
import * as Digest from "multiformats/hashes/digest";
import type { PrivateKey } from "@bsv/sdk";

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
  genesis?: { subscriptions?: Array<{ sender?: string; box: string; handler: CID }>; defaults?: Record<string, string>; feeds?: FeedSpec[]; libp2p?: Libp2pSpec; routes?: RouteSpec[]; jobs?: JobSpec[] };
  /** The router-held feeds' limits (feeds.ts); the backoff is the broadcaster's subscription's too. */
  feeds?: { maxQueue?: number; backoff?: { min: number; max: number } };
  /** The host's Arcade (#58, arc.ts): the broadcast route, the status subscription, a new genesis's `walletArc`. Absent: no broadcaster. */
  arc?: ArcConfig;
  /** Tests: how the broadcaster reaches Arcade. */
  arcFetch?: typeof fetch;
  /** Answers programs' HTTP to URLs that are not this host's (#15, #40); default: SKEIN_HTTP=fetch performs them (fetchHttp), else refused. */
  http?(req: HttpRequest): Promise<HttpResponse>;
  /** Stop a kernel this long after its last call (ms); 0: never (the default: instances are not stopped until resource contention appears, and a stop drops its in-memory sessions). */
  idleMs?: number;
  /** Where a new mailbox instance's store goes: <home>/instances/<handle>/runtime.db. */
  home?: string;
  /** An instance's origin, `{handle}` and `{port}` filled in; default http://{handle}.localhost:{port}. */
  instanceOrigin?: string;
  /** This host's own origin (the manifest, a genesis's resolveOrigin); default http://127.0.0.1:{port}. */
  origin?: string;
  /** The port it serves on, for origins named before it listens (a boot, `skein-host add`); listening sets it. */
  port?: number;
  /** The owner's messagebox URL for a new agent's genesis; default the owner's mailbox instance here, if there is one. */
  ownerMessagebox?: string;
  /** How often the fuel ledger is written (ms); default 5000. */
  ledgerMs?: number;
  /** Tests: the clock entries are stamped with (and jobs fall due by: cron.ts). */
  now?: () => Stamp;
  /** The instances' jobs (#60, cron.ts): false — this router fires none (a one-shot command's router is no clock). Default true. */
  cron?: boolean;
  /** Lines, by source: an instance's handle, or "router". */
  log?(source: string, line: string): void;
  /** Kernel process settings. */
  kernel?: { command?: string; env?: Record<string, string | undefined> };
  /** The libp2p host (#51, p2p.ts): its host-wide settings (default: loopback TCP + WS, no DHT, no mDNS). */
  libp2p?: P2PHostConfig;
  /** An instance's libp2p peer key (oracle.ts peerKey). Absent: no libp2p host; the kernels' `libp2p` is refused. */
  peerKeyFor?(handle: string): PrivateKey;
  /** How often the libp2p host redials bootstrap peers and runs topic rendezvous (ms); default 30 000. */
  libp2pDiscoveryMs?: number;
}

interface Loaded { row: InstanceRow; kernel: Kernel; identity: string; wallet: WalletInterface }

/** A request as the router takes it: the full URL (its host is the Host header's), lower-cased headers, the body. */
export interface RouterRequest { method: string; url: string; headers: Record<string, string>; body: Uint8Array; /** The instance whose `http` this is (none for a socket's). */ from?: string }
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

/**
 * The warning for an agent whose genesis names no owner messagebox
 * (`defaults.ownerMessagebox`): its sends to the owner — every answer to him —
 * fail, since nothing else tells it where his mailbox is. Undefined if it names one.
 */
export function noOwnerMessagebox(genesis: Record<string, unknown> | null | undefined): string | undefined {
  const d = genesis?.defaults as Record<string, unknown> | undefined;
  if (typeof d?.ownerMessagebox === "string" && d.ownerMessagebox) return undefined;
  return "WARNING: its genesis names no owner messagebox (defaults.ownerMessagebox): nothing it sends the owner (its answers) can be delivered. " +
    "Create the owner's mailbox instance (skein-host add <name> --mailbox --owner <key>) or set SKEIN_OWNER_MESSAGEBOX, then re-genesis it (a new store)";
}

/** A sendMessage request's box and recipient, for the delivery log line ("" if the body is neither CBOR nor JSON). */
function describeDelivery(req: HttpRequest): string {
  const b = req.body ?? new Uint8Array();
  let m: { messageBox?: unknown; recipient?: unknown } | undefined;
  try { m = (dagCbor.decode(b) as { message?: typeof m }).message; } catch {
    try { m = (JSON.parse(new TextDecoder().decode(b)) as { message?: typeof m }).message; } catch { /* neither */ }
  }
  if (!m) return "";
  const to = m.recipient instanceof Uint8Array ? Buffer.from(m.recipient).toString("hex") : typeof m.recipient === "string" ? m.recipient : "";
  return `${String(m.messageBox ?? "?")}${to ? ` for ${short(to)}` : ""}`;
}

/** An error answer's description (JSON {description | error}), else its first 200 bytes. */
function errorOf(body: Uint8Array): string {
  const t = new TextDecoder().decode(body.subarray(0, 2000));
  try { const j = JSON.parse(t) as { description?: unknown; error?: unknown }; return String(j.description ?? j.error ?? t.slice(0, 200)); } catch { return t.slice(0, 200); }
}

export class Router {
  readonly o: RouterOptions;
  readonly feeds: Feeds;
  /** The instances' jobs (#60). */
  readonly cron: Cron;
  /** The host's broadcaster (#58): present when the host has an Arcade. */
  readonly arc?: Broadcaster;
  /** The libp2p host (#51): one node per instance whose genesis declares libp2p. */
  readonly p2p?: P2PHost;
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
  private closing?: Promise<void>;
  servers: Server[] = [];
  port = 0;

  constructor(o: RouterOptions) {
    this.o = o;
    this.feeds = new Feeds({
      admit: (h, box, ev) => this.admitEvent(h, box, ev), log: (s, l) => this.say(s, l),
      maxQueue: o.feeds?.maxQueue, backoff: o.feeds?.backoff,
    });
    this.cron = new Cron({
      now: () => stampMs(this.now()), admit: (h, box, ev) => this.admitEvent(h, box, ev), log: (s, l) => this.say(s, l),
      state: (h) => {
        const row = this.o.db.get(h);
        if (!row || row.status !== "enabled") return "gone";
        const l = this.loaded.get(h);
        return (l && !l.kernel.gone) || this.loading.has(h) ? "running" : "stopped";
      },
      subscribed: (h, box) => this.subscribes(h, box),
      fired: { has: (h, k) => this.o.db.jobFired(h, k), mark: (h, k, due) => this.o.db.markJobFired(h, k, due) },
    });
    if (o.arc) {
      this.arc = new Broadcaster({
        arc: o.arc, db: o.db, fetch: o.arcFetch, backoff: o.feeds?.backoff, log: (s, l) => this.say(s, l),
        admit: (h, box, ev) => this.admitEvent(h, box, ev),
        instances: () => ({ all: this.o.db.list("enabled").map((r) => r.handle), running: [...this.loaded].filter(([, l]) => !l.kernel.gone).map(([h]) => h) }),
        holds: async (h, txid) => await (await this.hydrate(h)).kernel.hasBlock(txCid(txid)),
      });
    }
    if (o.peerKeyFor) {
      this.p2p = new P2PHost({
        host: o.libp2p ?? { listen: DEFAULT_LISTEN, bootstrap: [], dht: "off", relays: [], mdns: false },
        keyOf: o.peerKeyFor, discoveryMs: o.libp2pDiscoveryMs,
        inbound: (h, c) => this.p2pInbound(h, c),
        wake: (h, t) => void this.wakeThread(h, t).catch((e) => this.say(h, `wake ${short(t.toString())}: ${(e as Error).message}`)),
        log: (s, l) => this.say(s, l),
      });
    }
    const idle = o.idleMs ?? 0;
    if (idle > 0) this.idleTimer = setInterval(() => void this.reap(idle), Math.max(50, Math.min(idle / 4, 10_000)));
    this.ledgerTimer = setInterval(() => this.flushLedger(), o.ledgerMs ?? 5000);
  }

  private say(source: string, line: string): void { this.o.log?.(source, line); }
  private now(): Stamp { return (this.o.now ?? clockNow)(); }
  /** The router's clock, as entries are stamped. */
  nowStamp(): Stamp { return this.now(); }

  /** This host's own origin. */
  origin(): string { return (this.o.origin ?? "http://127.0.0.1:{port}").replace("{port}", String(this.port || this.o.port || 0)); }
  /** The broadcast route (#58), as a genesis's `walletArc` names it: the wallet calls <it>/v1/tx. */
  arcRoute(): string { return `${this.origin()}${ARC_ROUTE}`; }
  /** An instance's origin: where its front door is, what BRC-169 publishes as its messagebox. */
  originOf(handle: string): string {
    return (this.o.instanceOrigin ?? "http://{handle}.localhost:{port}").replace("{handle}", handle).replace("{port}", String(this.port || this.o.port || 0));
  }

  /** Hydrate every enabled row once (recovery at hydrate time; it reports its sleepers), then let them idle out. */
  async start(): Promise<void> {
    for (const row of this.o.db.list("enabled")) {
      try { await this.hydrate(row.handle); } catch (e) { this.say(row.handle, `not started: ${(e as Error).message}`); }
    }
  }

  /**
   * Stop everything this router started (#61), once: the waker's, the
   * idle reaper's and the ledger's timers (the owed fuel written first), its
   * servers and their connections, the header feeds' and the broadcaster's
   * SSE clients, the libp2p nodes, and every kernel process it spawned — one
   * still hydrating included. Afterwards nothing of it keeps the process
   * alive: `skein-host run`'s shutdown and every one-shot command that builds
   * a router (`add --boot/--packet`) end with it.
   */
  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  /** The same as `close()`. */
  stop(): Promise<void> { return this.close(); }

  private async shutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.idleTimer);
    clearInterval(this.ledgerTimer);
    this.flushLedger();
    const closed = this.servers.map((s) => new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections(); }));
    this.servers = [];
    await Promise.all([this.cron.stop(), this.feeds.stop(), this.arc?.stop(), this.p2p?.stop()]);
    // A kernel still hydrating: its load finishes (or fails) first, then it is stopped with the rest.
    await Promise.all([...this.loading.values()].map((p) => p.catch(() => {})));
    await Promise.all([...this.loaded.values()].map((l) => l.kernel.stop()));
    this.loaded.clear();
    await Promise.all(closed);
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

  /**
   * A thread resting on a libp2p `receive` (#51): a frame arrived on its
   * stream, so admit its wake now (before its deadline). The kernel steps a
   * sleeper early only if its last update recorded a pending `receive`.
   */
  async wakeThread(handle: string, thread: CID): Promise<CID> {
    return await this.serial(handle, async () => {
      const l = await this.hydrate(handle);
      const e = await admit2(l.kernel, { wake: thread }, {}, this.now());
      this.say(handle, `libp2p: wake ${short(thread.toString())} as ${short(e.toString())} (a frame arrived)`);
      this.settle(l);
      return e;
    });
  }

  /**
   * An inbound libp2p message or stream frame (#51): one kernel call of the
   * front door (fn "libp2p") with the tagged input; its fuel charged to the
   * ledger (caller: the peer ID, op: `libp2p:<topic | protocol>`); the entries
   * an accept returns admitted before the verdict goes back to GossipSub.
   * A front door that fails to answer is `ignore` (no penalty).
   */
  async p2pInbound(handle: string, call: InboundCall): Promise<InboundAnswer> {
    const l = await this.hydrate(handle);
    const source = `libp2p:${call.topic ?? call.protocol ?? "?"}`;
    let from = "";
    try { from = peerIdFromMultihash(Digest.decode(call.from)).toString(); } catch { /* not a peer ID: the front door rejects it */ }
    const a = await l.kernel.invoke("frontdoor", "libp2p", dagCbor.encode(call), { now: stampMs(this.now()) });
    this.charge(handle, from, source, a.fuel);
    if (!a.ok) { this.say(handle, `${source} from ${from}: the front door failed: ${a.error}`); return { verdict: "ignore", reason: a.error }; }
    const r = dagCbor.decode(a.result) as { verdict?: string; reason?: string; body?: Uint8Array; close?: boolean; admit?: FrontAnswer["admit"] };
    const verdict = r.verdict === "accept" || r.verdict === "reject" ? r.verdict : "ignore";
    if (r.admit?.length) {
      try {
        await admitAll(l.kernel, r.admit, () => this.now());
      } catch (e) {
        // A redelivered message (#42/#51: its `p2p` event record already admitted — the kernel's
        // `unique` index refuses it, nothing written) is ignore toward GossipSub: no penalty, no forward.
        const dup = e instanceof Rejected && e.reason === "duplicate-envelope";
        if (!dup) this.say(handle, `${source}: admit: ${(e as Error).message}`);
        else if (process.env.SKEIN_LIBP2P_VERBOSE) this.say(handle, `${source} from ${from}: ignore (already admitted)`);
        return { verdict: "ignore", reason: dup ? "already admitted" : (e as Error).message };
      }
      this.settle(l);
    }
    if (verdict !== "accept" || process.env.SKEIN_LIBP2P_VERBOSE) this.say(handle, `${source} from ${from}: ${verdict}${r.reason ? ` (${r.reason})` : ""}`);
    return { verdict, ...(r.body instanceof Uint8Array ? { body: r.body } : {}), ...(r.close ? { close: true } : {}), ...(r.reason ? { reason: r.reason } : {}) };
  }

  /** The kernel's `libp2p` import (#51): answered by the libp2p host; the kernel records the answer. */
  async p2pRequest(handle: string, req: P2PRequest, thread?: CID): Promise<P2PResult> {
    if (!this.p2p) return { error: "this host runs no libp2p" };
    return await this.p2p.request(handle, req, thread);
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
      http: (req) => this.http(req, handle),
      libp2p: (req, thread) => this.p2pRequest(handle, req, thread),
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
      if (row.kind !== "mailbox") { const w = noOwnerMessagebox(g); if (w) this.say(handle, w); }
      this.feeds.declare(handle, feedsOf(g as Record<string, unknown>));
      if (this.o.cron !== false) this.cron.declare(handle, jobsOf(g as Record<string, unknown>));
      const p2p = libp2pOf(g as Record<string, unknown>);
      if (this.p2p && p2p) {
        // Its node, before anything it runs can publish or dial; a failure to start it is logged, not fatal.
        await this.p2p.declare(handle, p2p).catch((e) => this.say(handle, `libp2p: not started: ${(e as Error).message}`));
      }
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
   * Whether a stopped instance's subscriptions route a sender-less event in
   * `box` to a handler (the kernel's rule for a plain entry no thread awaits):
   * read from its store file, read-only, with no kernel.
   */
  async subscribes(handle: string, box: string): Promise<boolean> {
    const row = this.o.db.get(handle);
    if (!row || !existsSync(row.store)) return false;
    const s = openStoreFile(row.store, { readOnly: true });
    try {
      const rules = await currentSubscriptions(s);
      return !!rules?.some((r) => r.match.sender == null && (r.match.box == null || r.match.box === box));
    } finally { s.close(); }
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
    // #58: with an Arcade, the wallet broadcasts through the host's route (the configured defaults win).
    const genesisDefaults = this.arc ? { walletArc: this.arcRoute(), ...this.o.genesis?.defaults } : this.o.genesis?.defaults;
    const hostDefaults = { ...genesisDefaults, ...(this.o.fuelPerStep ? { fuelPerStep: this.o.fuelPerStep } : {}) };
    const warn = (l: string) => this.say(row.handle, l);
    const facts = { ownerMessagebox: this.ownerMessagebox(), resolveOrigin: this.origin() };
    if (!code) {
      // A system tree: its config wins; the host fills what it leaves unset. SKEIN_FUEL_PER_STEP stays an explicit (dev) override.
      return {
        identity, owner: this.o.owner, handle: row.handle, domain: row.domain, infer: this.o.infer, ownerHandle: this.o.ownerHandle, inferHandle: this.o.inferHandle,
        feeds: this.o.genesis?.feeds, jobs: this.o.genesis?.jobs, defaults: genesisDefaults, overrides: this.o.fuelPerStep ? { fuelPerStep: this.o.fuelPerStep } : undefined, warn, ...facts,
      };
    }
    return {
      identity, owner: this.o.owner, handle: row.handle, domain: row.domain, infer: this.o.infer, ownerHandle: this.o.ownerHandle, inferHandle: this.o.inferHandle,
      // Code genesis takes DEFAULTS under the host's.
      defaults: Object.keys(hostDefaults).length ? { ...DEFAULTS, ...hostDefaults } : undefined,
      subscriptions: this.o.genesis?.subscriptions,
      feeds: this.o.genesis?.feeds, jobs: this.o.genesis?.jobs,
      libp2p: this.o.genesis?.libp2p, extraRoutes: this.o.genesis?.routes,
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

  /**
   * A program's HTTP request (the kernel's `http`): this host's own URLs in
   * process, the rest as configured. A delivery (`POST …/sendMessage`, from
   * instance `from`) is logged in one line: where it went, how, and the result.
   */
  async http(req: HttpRequest, from?: string): Promise<HttpResponse> {
    const local = this.isLocal(req.url);
    const delivery = req.method === "POST" && /\/sendMessage$/.test(new URL(req.url, "http://x").pathname);
    const said = (what: string) => { if (delivery) this.say(from ?? "router", `deliver${((d) => d ? ` ${d}` : "")(describeDelivery(req))} → ${req.url} (${local ? "local" : "remote"}): ${what}`); };
    try {
      let r: HttpResponse;
      if (local) {
        const d = await this.dispatch({ method: req.method, url: req.url, headers: headerMap(req.headers ?? {}), body: req.body ?? new Uint8Array(), ...(from ? { from } : {}) });
        r = { status: d.status, headers: d.headers, body: d.body };
      } else {
        const f = this.o.http ?? (process.env.SKEIN_HTTP === "fetch" ? fetchHttp : undefined);
        if (!f) throw new Error(`this host answers no http beyond its own (${req.url})`);
        r = await f(req);
      }
      said(r.status === 200 ? "200 delivered" : `HTTP ${r.status} ${errorOf(r.body)}`.trimEnd());
      return r;
    } catch (e) {
      said(`failed: ${(e as Error).message}`);
      throw e;
    }
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
    if (path === `${ARC_ROUTE}/callback` || path.startsWith(`${ARC_ROUTE}/v1/tx`)) return await this.arcRequest(req, path);
    if (req.method === "POST" && path === "/account/register") return await this.register(req.body);
    return json(404, { status: "error", code: "ERR_NOT_FOUND", description: "no instance here: an instance is at http://<handle>.localhost:<port>/ or /@<handle>/" });
  }

  /** The broadcaster's routes (#58, arc.ts); 503 (a transient failure to a wallet) when the host has no Arcade. */
  private async arcRequest(req: RouterRequest, path: string): Promise<RouterResponse> {
    const tx = new RegExp(`^${ARC_ROUTE}/v1/tx(?:/([^/]+))?$`).exec(path);
    if (!this.arc) {
      if (tx) return json(503, { status: 503, title: "no Arcade", extraInfo: "this host has no Arcade (SKEIN_ARC_URL)" });
      return json(404, { status: "error", code: "ERR_NOT_FOUND", description: "this host has no Arcade" });
    }
    if (req.method === "POST" && path === `${ARC_ROUTE}/callback`) return await this.arc.callback(req.headers, req.body);
    if (req.method === "POST" && tx && tx[1] === undefined) return await this.arc.submit(req.body, req.from);
    if (req.method === "GET" && tx?.[1] !== undefined) return await this.arc.status(decodeURIComponent(tx[1]), req.from);
    return json(404, { status: "error", code: "ERR_NOT_FOUND", description: `no ${req.method} ${path}` });
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
    // The host is up: its one status subscription (#58), resumed where it left off.
    this.arc?.start();
    return this.servers[0]!;
  }
}

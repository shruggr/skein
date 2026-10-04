// The host as a reverse proxy (#40): each instance is an HTTP server — its
// front door (programs/frontdoor) — at an origin of its own, and the router
// only picks the instance a request is for and forwards it. Routing comes
// before authentication, because a BRC-104 handshake does not name its
// recipient: the URL is the recipient. The router holds no auth state and no
// mailbox: it keeps the hostname → instance map (host.db), the kernels it has
// hydrated, the providers (the waker and the cron provider among them), the
// feeds, the broadcaster, the fuel ledger.
//
//   http://<handle>.localhost:<port>/…   an instance's origin (the Host header). The stock AuthFetch keeps one
//                                         session per origin, and shakes hands at <origin>/.well-known/auth: this
//                                         is the form it is served by. (SKEIN_INSTANCE_ORIGIN: another template.)
//   http://<host>:<port>/@<handle>/…      the same instance for our own clients (a dev form): the router strips
//                                         the prefix for the routes; the client signs the path it sent, and its
//                                         handshake goes under the prefix (src/client/raw.ts).
//   GET  /manifest.json                   BRC-169 §5.1: metanet.trust.publicKey (the certifier key), metanet.handles
//   GET  /.well-known/metanet-handles/resolve?handle=h   BRC-169 §5.2 (handles.ts): an agent's own identity; for a
//                                         mailbox instance, its owner's — the instance's origin the messagebox, and
//                                         the handle certificate the host issues for the binding
//   GET  /bsvalias/id/<handle>@<domain>   paymail PKI (identity keys by handle)
//   POST /account/register {username, identityKey, signature}   a mailbox instance for that identity (the
//                                         signature: [2, "skein register"], key ID the username, counterparty
//                                         anyone, over "register <username>")
//   POST /arc/callback                    Arcade's webhook (Bearer: the host token)
//
// The broadcaster (#58, #65, arc.ts) takes the instances' broadcast events
// (a durable queue in host.db, retries, one Arcade session) and routes what
// Arcade says of a transaction to every instance whose state holds it (a
// `has` of its CID, cached): a proof as an unsigned event in box `chain`,
// any other status as a signed message from the status provider.
//
// A request for an instance (#68, #66) is appended as received — one
// `request` entry, verified by nothing here — and the client's connection
// held until the thread the kernel steps the front door on comes to rest;
// its answer, signed on the session inside, is the response (frontdoor.ts).
// Past `answerWaitMs`, or at shutdown, 503 + Retry-After. Every request is an
// entry; a read moves nothing.
//
// What the instances send out goes through the host's providers (#70,
// providers.ts): each kernel hands over the signed messages its steps
// emitted to a `local` provider or a libp2p recipient, and the provider's
// answer comes back as a signed message, a `local` request entry. The HTTP
// proxy (`fetch`) answers a URL of this host's own in process (the same
// path, no socket) and sends any other out; the waker keeps the instances'
// deadlines and their shells' sleeps (#69); the cron provider their
// schedules, each tick a signed message (#69, cron.ts; host.db
// `cron_schedule`); the status provider tells the instances that subscribe
// to it how their transactions stand (#65); the libp2p node is the
// instance's own (p2p.ts); the instance manager (#90) creates, starts and
// stops instances for the host skein alone (host.db `host_settings`:
// `skein-host init` made it; createInstance claims a new instance before
// its row is enabled, which publishes its hostname). Each genesis it writes names the providers' keys
// in its address book (`addressBook`). A kernel's broadcast events go to the
// broadcaster (#65).
//
// The libp2p host (#51, p2p.ts) is the router's too: one node per instance
// whose genesis declares `libp2p` or whose dispatch table has a libp2p row
// (#72, #77: a topic or a protocol), each topic message and stream
// frame one request entry (`p2pInbound`: the verdict or the frame's answer
// read off its thread and handed back to GossipSub or the stream). The node
// follows the dispatch table: once the kernel has processed what the host
// handed it (`settle`), the router reads the head (a kernel read), and when
// it moved, declares the instance's libp2p config again — an install's
// topics subscribed, an uninstall's unsubscribed, live (`syncP2p`).
//
// Nothing here is an instance's clock but its providers (#69): a schedule
// originates in a program's step, as a message to the cron provider; an
// idle-stopped instance is hydrated for a tick only if something in it
// subscribes the tick's box (from the cron provider, or from anyone).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Server as NetServer } from "node:net";
import { join } from "node:path";
import { KeyDeriver, PrivateKey, ProtoWallet, Utils, type WalletInterface } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { rootIdentity } from "../runtime/identity.ts";
import { DEFAULTS, short, stampMs } from "../runtime/log.ts";
import type { Stamp } from "../runtime/syscalls.ts";
import { ARC_ROUTE, Broadcaster, type ArcConfig } from "./arc.ts";
import { Feeds, feedsOf, txCid, type FeedSpec } from "./feeds.ts";
import { Cron, dbSchedules } from "./cron.ts";
import { currentDispatch, takesEvent, takesMail } from "../runtime/dispatch.ts";
import { openStoreFile } from "../runtime/index-store.ts";
import { existsSync } from "node:fs";
import { now as clockNow } from "./clock.ts";
import { boot, bootStore, imageSource, type BootSource, type Booted } from "./boot.ts";
import { ANSWER_WAIT_MS, appendRequest, frontDoor, headerMap, unavailable, type FrontAnswer } from "./frontdoor.ts";
import { admit2, keyBytes, keyHex, type AddressSeed, type Genesis2Config, type Libp2pSpec, type RouteSpec } from "./genesis.ts";
import type { HostDb, InstanceRow } from "./instances.ts";
import { Kernel } from "./kernel.ts";
import { DEFAULT_LISTEN, libp2pConfig, P2PHost, type InboundAnswer, type InboundCall, type P2PHostConfig } from "./p2p.ts";
import { peerIdFromMultihash } from "@libp2p/peer-id";
import { Providers, tooLarge, type HttpRequest, type HttpResponse, type ProviderName } from "./providers.ts";
import { closeControl, listenControl } from "./control.ts";
import { manifest, resolution, resolutionError } from "./handles.ts";
import * as Digest from "multiformats/hashes/digest";

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
  /** A new genesis's extra seed rows — boxes (a sender in hex, `$owner`, or a provider's `$<name>`: `$status`, `$cron`, …) and routes — and defaults (over DEFAULTS), e.g. the wallet's (#29). */
  genesis?: { subscriptions?: Array<{ sender?: string; box: string; handler: CID }>; defaults?: Record<string, string>; feeds?: FeedSpec[]; libp2p?: Libp2pSpec; routes?: RouteSpec[] };
  /** The router-held feeds' limits (feeds.ts); the backoff is the broadcaster's subscription's too. */
  feeds?: { maxQueue?: number; backoff?: { min: number; max: number } };
  /** The host's Arcade (#58, #65, arc.ts): where the broadcast events go, the status subscription, the `status` provider. Absent: no broadcaster (a broadcast event is dropped). */
  arc?: ArcConfig;
  /** Tests: how the broadcaster reaches Arcade. */
  arcFetch?: typeof fetch;
  /** The broadcaster's queue: how soon a broadcast Arcade did not take is posted again (ms, doubling; default 1 000 → 300 000). */
  arcRetry?: { min: number; max: number };
  /** The HTTP proxy's network (#70, the `fetch` provider) for URLs that are not this host's; default: SKEIN_HTTP=fetch performs them (fetchHttp), else refused. */
  http?(req: HttpRequest): Promise<HttpResponse>;
  /** Stop a kernel this long after its last call (ms); 0: never (the default: instances are not stopped until resource contention appears). */
  idleMs?: number;
  /** How long a synchronous client waits on its request's thread (#66) before 503 + Retry-After (ms); default SKEIN_ANSWER_WAIT_MS, else two minutes. */
  answerWaitMs?: number;
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
  /** Tests: the clock entries are stamped with (and ticks fall due by: cron.ts). */
  now?: () => Stamp;
  /** The cron provider's clock (#69, cron.ts): false — this router sends no ticks (a one-shot command's router is no clock; it still keeps a schedule a step asks for, in host.db). Default true. */
  cron?: boolean;
  /** Lines, by source: an instance's handle, or "router". */
  log?(source: string, line: string): void;
  /** Kernel process settings. */
  kernel?: { command?: string; env?: Record<string, string | undefined> };
  /** The libp2p host (#51, p2p.ts): its host-wide settings (default: loopback TCP + WS, no DHT, no mDNS). */
  libp2p?: P2PHostConfig;
  /** An instance's libp2p peer key (oracle.ts peerKey). Absent: no libp2p host; the kernels' `libp2p` is refused. */
  peerKeyFor?(handle: string): PrivateKey;
  /**
   * A provider's key (#70, oracle.ts providerKey: the HTTP proxy `fetch`, the
   * `waker`, `cron`, `libp2p`, `status`), which each new genesis's address
   * book names. Absent: keys of this router's own, made fresh (a test's; a
   * restarted router would not be the providers its instances know).
   */
  providerKeyFor?(name: ProviderName): PrivateKey;
  /**
   * The certifier key (#100, oracle.ts certifierKey): BRC-169's trust anchor,
   * the manifest's `metanet.trust.publicKey`, which signs the handle
   * certificate in every resolution (handles.ts). Absent: a key of this
   * router's own, made fresh (a test's).
   */
  certifierKey?: PrivateKey;
  /** How often the libp2p host redials bootstrap peers and runs topic rendezvous (ms); default 30 000. */
  libp2pDiscoveryMs?: number;
}

interface Loaded {
  row: InstanceRow; kernel: Kernel; identity: string; wallet: WalletInterface;
  /** The genesis (its `libp2p`), and the dispatch table's tip as the libp2p node last followed it (#72, #77). */
  genesis: Record<string, unknown>;
  dispatchTip?: string;
}

/** A request as the router takes it: the full URL (its host is the Host header's), lower-cased headers, the body. */
export interface RouterRequest { method: string; url: string; headers: Record<string, string>; body: Uint8Array; /** The instance whose `http` this is (none for a socket's). */ from?: string }
export interface RouterResponse { status: number; headers: Record<string, string>; body: Uint8Array }

const json = (status: number, v: unknown): RouterResponse => ({ status, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(v)) });
const KEY = /^0[23][0-9a-f]{64}$/;
/** A handle as an instance's hostname label (#90: what the instance manager creates). */
export const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const REGISTER_PROTOCOL: [2, string] = [2, "skein register"];

/**
 * SKEIN_HTTP=fetch: the HTTP proxy's requests (#70, the `fetch` provider)
 * performed for real; `timeoutMs` (default 30 000) bounds the whole exchange,
 * `maxBytes` (#91) the response body: reading stops past it, and the request
 * fails.
 */
export async function fetchHttp(req: HttpRequest): Promise<HttpResponse> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`timed out after ${req.timeoutMs ?? 30_000} ms`)), req.timeoutMs ?? 30_000);
  try {
    const r = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body as BodyInit | undefined, signal: ac.signal });
    const headers = Object.fromEntries(r.headers.entries());
    if (req.maxBytes === undefined || !r.body) return { status: r.status, headers, body: new Uint8Array(await r.arrayBuffer()) };
    const chunks: Uint8Array[] = [];
    let n = 0;
    for await (const c of r.body as unknown as AsyncIterable<Uint8Array>) {
      n += c.length;
      if (n > req.maxBytes) { ac.abort(); throw new Error(tooLarge(req.maxBytes)); }
      chunks.push(c);
    }
    return { status: r.status, headers, body: new Uint8Array(Buffer.concat(chunks)) };
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
  // An image (#89) names no owner: the claim brings the owner's messagebox (into the address book).
  if (genesis && genesis.owner === undefined) return undefined;
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
  /** The cron provider's schedules (#69). */
  readonly cron: Cron;
  /** The host's broadcaster (#58, #65): present when the host has an Arcade. */
  readonly arc?: Broadcaster;
  /** The libp2p host (#51): one node per instance whose genesis declares libp2p. */
  readonly p2p?: P2PHost;
  /** The host's providers (#70): what carries the instances' messages out. */
  readonly providers: Providers;
  /** The certifier (#100): signs the BRC-169 handle certificates. */
  readonly certifier: ProtoWallet;
  readonly loaded = new Map<string, Loaded>();
  private loading = new Map<string, Promise<Loaded>>();
  /** Rows being created (#90): hydrated before their hostname is published (disabled until claimed). */
  private unpublished = new Set<string>();
  private queues = new Map<string, Promise<unknown>>();
  /** The libp2p nodes following their dispatch tables (#72: syncP2p after a settle). */
  private syncing = new Set<Promise<unknown>>();
  private idleTimer?: ReturnType<typeof setInterval>;
  private ledgerTimer?: ReturnType<typeof setInterval>;
  /** The fuel of calls not yet written to the ledger: instance\0caller\0op → {calls, fuel}. */
  private owed = new Map<string, { calls: number; fuel: number }>();
  private stopped = false;
  private closing?: Promise<void>;
  /** Settles when the router starts shutting down: every client still waiting on a thread is answered 503 (#66). */
  private stopping: Promise<void>;
  private stopNow!: () => void;
  /** Requests being forwarded (their clients held on a thread). */
  private inflight = new Set<Promise<RouterResponse>>();
  servers: Server[] = [];
  port = 0;
  /** The control socket (control.ts), while this router listens on one. */
  private control?: { server: NetServer; path: string };

  constructor(o: RouterOptions) {
    this.o = o;
    this.stopping = new Promise<void>((r) => { this.stopNow = r; });
    this.certifier = new ProtoWallet(o.certifierKey ?? PrivateKey.fromRandom());
    this.feeds = new Feeds({
      admit: (h, box, ev) => this.admitEvent(h, box, ev), log: (s, l) => this.say(s, l),
      maxQueue: o.feeds?.maxQueue, backoff: o.feeds?.backoff,
    });
    this.cron = new Cron({
      now: () => stampMs(this.now()), store: dbSchedules(o.db), log: (s, l) => this.say(s, l),
      tick: async (s, body) => {
        const row = this.o.db.get(s.instance);
        if (!row || row.status !== "enabled") { this.cron.forget(s.instance); throw new Error("the instance is gone"); }
        await this.providers.send(s.instance, "cron", keyBytes(s.recipient), s.box, body);
      },
      // An idle-stopped instance is hydrated for a tick only if something in it takes the box (from the cron provider, or anyone).
      wake: async (s) => {
        const l = this.loaded.get(s.instance);
        if ((l && !l.kernel.gone) || this.loading.has(s.instance)) return true;
        return await this.subscribes(s.instance, s.box, this.providers.key("cron"));
      },
    });
    if (o.arc) {
      this.arc = new Broadcaster({
        arc: o.arc, db: o.db, fetch: o.arcFetch, backoff: o.feeds?.backoff, ...(o.arcRetry ? { retry: o.arcRetry } : {}), log: (s, l) => this.say(s, l),
        admit: (h, box, ev) => this.admitEvent(h, box, ev),
        status: async (h, body, subject) => {
          const id = this.o.db.get(h)?.identity;
          if (!id) throw new Error("its identity is not known yet");
          await this.providers.send(h, "status", keyBytes(id), "status", body, subject);
        },
        now: () => stampMs(this.now()),
        instances: () => ({ all: this.o.db.list("enabled").map((r) => r.handle), running: [...this.loaded].filter(([, l]) => !l.kernel.gone).map(([h]) => h) }),
        holds: async (h, txid) => await (await this.hydrate(h)).kernel.hasBlock(txCid(txid)),
      });
    }
    if (o.peerKeyFor) {
      this.p2p = new P2PHost({
        host: o.libp2p ?? { listen: DEFAULT_LISTEN, bootstrap: [], dht: "off", relays: [], mdns: false },
        keyOf: o.peerKeyFor, discoveryMs: o.libp2pDiscoveryMs,
        inbound: (h, c) => this.p2pInbound(h, c),
        log: (s, l) => this.say(s, l),
      });
    }
    // Without a host's own provider keys: a router's own, fresh (a test's).
    const own = o.providerKeyFor ? undefined : new KeyDeriver(PrivateKey.fromRandom());
    const p2p = this.p2p;
    this.providers = new Providers({
      keyOf: o.providerKeyFor ?? ((n) => own!.derivePrivateKey([2, "skein provider"], n, "self")),
      append: (h, pkg) => this.appendLocal(h, pkg),
      fetch: (req, from) => this.http(req, from),
      ...(this.arc ? { broadcast: (h: string, tx: Uint8Array, beef?: Uint8Array) => { this.arc!.enqueue(h, tx, beef); } } : {}),
      cron: (h, sender, id, body) => this.cron.request(h, sender, id, body),
      // #90: the instance manager acts for the host skein alone.
      manager: {
        from: () => { const r = this.o.db.hostSkein(); return r?.identity ? { handle: r.handle, identity: r.identity } : undefined; },
        request: (box, body) => this.manage(box, body),
      },
      ...(p2p ? {
        p2p: {
          publish: (h: string, topic: string, body: Uint8Array) => p2p.publish(h, topic, body),
          dial: (h: string, peer: string, protocol: string, frames: Parameters<P2PHost["dial"]>[3]) => p2p.dial(h, peer, protocol, frames),
          send: (h: string, s: number, body: Uint8Array) => p2p.send(h, s, body),
          close: (h: string, s: number) => p2p.close(h, s),
        },
      } : {}),
      now: () => stampMs(this.now()),
      log: (s, l) => this.say(s, l),
    });
    if (o.cron !== false) this.cron.start();
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
  /** An instance's origin: where its front door is, what BRC-169 publishes as its messagebox. */
  originOf(handle: string): string {
    return (this.o.instanceOrigin ?? "http://{handle}.localhost:{port}").replace("{handle}", handle).replace("{port}", String(this.port || this.o.port || 0));
  }

  /** Hydrate every enabled row once (recovery at hydrate time: what a waiting thread awaits is handed to the providers again), then let them idle out. */
  async start(): Promise<void> {
    for (const row of this.o.db.list("enabled")) {
      try { await this.hydrate(row.handle); } catch (e) { this.say(row.handle, `not started: ${(e as Error).message}`); }
    }
  }

  /**
   * Stop everything this router started (#61), once: the providers' (the
   * waker's, the cron provider's), the idle reaper's and the ledger's timers
   * (the owed fuel written first), its
   * servers and their connections, the control socket (its file removed), the header feeds' and the broadcaster's
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

  /**
   * Listen on the control socket at `path` ($SKEIN_HOME/host.sock for
   * `skein-host run`; mode 0600, no HTTP route): `skein-host event` sends its
   * event here while this router runs, and it reaches the instance as a tick
   * due now (cronEvent). Removed by `close()`.
   */
  async listenControl(path: string): Promise<void> {
    if (this.stopped) throw new Error("the router is stopping");
    const server = await listenControl(path, {
      event: async (h, box, ev) => (await this.cronEvent(h, box, ev)).toString(),
      claim: async (h, owner, o) => {
        const [name, domain] = (o.name ?? "").replace(/^@/, "").split("@");
        const c = await this.claim(h, owner, { messagebox: o.messagebox, ...(name ? { handle: name, domain: domain || "localhost" } : {}) });
        return { entry: c.entry.toString(), claimed: c.claimed };
      },
    });
    this.control = { server, path };
    this.say("router", `control socket at ${path}`);
  }

  private async shutdown(): Promise<void> {
    this.stopped = true;
    // Clients waiting on a thread are answered 503 + Retry-After before the servers close (#66).
    this.stopNow();
    if (this.inflight.size) {
      await Promise.all([...this.inflight].map((p) => p.catch(() => {})));
      await new Promise((r) => setTimeout(r, 50)); // their 503s written before the sockets close
    }
    clearInterval(this.idleTimer);
    clearInterval(this.ledgerTimer);
    this.flushLedger();
    const closed = this.servers.map((s) => new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections(); }));
    this.servers = [];
    if (this.control) closed.push(closeControl(this.control.server, this.control.path));
    this.control = undefined;
    this.providers.stop();
    await Promise.all([this.cron.stop(), this.feeds.stop(), this.arc?.stop(), this.p2p?.stop()]);
    // A kernel still hydrating: its load finishes (or fails) first, then it is stopped with the rest.
    await Promise.all([...this.loading.values()].map((p) => p.catch(() => {})));
    await Promise.all([...this.loaded.values()].map((l) => l.kernel.stop()));
    this.loaded.clear();
    await Promise.all(closed);
  }

  /**
   * `skein-host event` (#69): a message from the cron provider into `box`, as
   * a tick due now would be — {...event, kind: event.kind ?? "cron", due:
   * now}, signed by the provider and appended as a `local` request; the
   * instance takes it by its subscription to the box (from the cron provider,
   * or from anyone). The entry's CID.
   */
  async cronEvent(handle: string, box: string, event: Record<string, unknown>): Promise<CID> {
    const row = this.o.db.get(handle);
    if (!row || row.status !== "enabled") throw new Error(`no enabled instance ${handle}`);
    const l = await this.hydrate(handle);
    return await this.providers.send(handle, "cron", keyBytes(l.identity), box, { ...event, kind: event.kind ?? "cron", due: stampMs(this.now()) }) as CID;
  }

  /**
   * A plain entry (#29, #65): a self-validating event from the host's wiring
   * (a header feed, the broadcaster's proof), put as a record and admitted
   * into the instance in `box`. The kernel routes it by its `subject` to the
   * thread awaiting that record, else to a sender-less subscription on `box`.
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
   * A signed message for an instance (#70): a provider's answer, appended as
   * received — a `local` request entry, {kind: "message", message, body}; the
   * front door checks its signature and routes it. Nobody waits on it.
   */
  async appendLocal(handle: string, pkg: Record<string, unknown>): Promise<CID> {
    return await this.serial(handle, async () => {
      const l = await this.hydrate(handle);
      const e = await appendRequest(l.kernel, "local", pkg, this.now());
      this.settle(l);
      return e;
    });
  }

  /**
   * An inbound libp2p message or stream frame (#51, #68): appended as
   * received (the message with its signature; the frame), and the verdict
   * — or the frame's answer — read off the thread the front door is stepped
   * on, once it comes to rest (#66). The front door verifies, routes, and
   * admits what an accept carries (the message's `p2p` event first); a
   * redelivered message it accepted before is `ignore`. Its thread failing,
   * or not answering within the wait, is `ignore` (no penalty).
   */
  async p2pInbound(handle: string, call: InboundCall): Promise<InboundAnswer> {
    const l = await this.hydrate(handle);
    const source = `libp2p:${call.topic ?? call.protocol ?? "?"}`;
    let from = "";
    try { from = peerIdFromMultihash(Digest.decode(call.from)).toString(); } catch { /* not a peer ID: the front door rejects it */ }
    const record = call.topic !== undefined
      ? { kind: "p2p", topic: call.topic, from: call.from, seqno: call.seqno ?? new Uint8Array(), signature: call.signature ?? new Uint8Array(), body: call.body }
      : { kind: "p2p-frame", protocol: call.protocol ?? "", from: call.from, body: call.body };
    const entry = await appendRequest(l.kernel, "libp2p", record, this.now());
    const a = await l.kernel.answer(entry, this.o.answerWaitMs ?? ANSWER_WAIT_MS);
    this.settle(l);
    if (a.state !== "finished") {
      const why = a.state === "errored" ? `the front door failed: ${a.error}` : `not answered in time (${a.state})`;
      this.say(handle, `${source} from ${from}: ${why}`);
      return { verdict: "ignore", reason: why };
    }
    const r = dagCbor.decode(a.answer) as { verdict?: string; reason?: string; body?: Uint8Array; close?: boolean };
    const verdict = r.verdict === "accept" || r.verdict === "reject" ? r.verdict : "ignore";
    if (verdict !== "accept" || process.env.SKEIN_LIBP2P_VERBOSE) this.say(handle, `${source} from ${from}: ${verdict}${r.reason ? ` (${r.reason})` : ""}`);
    return { verdict, ...(r.body instanceof Uint8Array ? { body: r.body } : {}), ...(r.close ? { close: true } : {}), ...(r.reason ? { reason: r.reason } : {}) };
  }

  /** Until nothing is queued and every loaded kernel has processed what it was given (tests, corpus). */
  async settled(): Promise<void> {
    for (let i = 0; i < 1000; i++) {
      await Promise.all([...this.queues.values()]);
      await Promise.all([...this.loaded.values()].map((l) => l.kernel.idle().catch(() => {})));
      await this.providers.idle(); // what the providers carry now (#70): its answers are entries
      await this.arc?.idle(); // the broadcaster's posts (#65): their answers are statuses to route
      await Promise.all([...this.syncing]); // the libp2p nodes following their dispatch tables (#72, #77)
      await new Promise((r) => setImmediate(r));
      if (!this.syncing.size && !this.queues.size && !this.providers.busy() && !this.arc?.busy() && [...this.loaded.values()].every((l) => l.kernel.busy === 0)) return;
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
    if (!row || (row.status !== "enabled" && !this.unpublished.has(handle))) throw new Error(`no enabled instance ${handle}`);
    const wallet = await this.o.walletFor(row);
    const identity = await rootIdentity(wallet);
    if (row.identity && row.identity !== identity) throw new Error(`its oracle is ${short(identity)}, not the recorded identity ${short(row.identity)}`);
    const kernel = new Kernel({
      db: row.store, handle: row.handle, domain: row.domain, wallet, command: this.o.kernel?.command, env: this.o.kernel?.env,
      log: (line) => this.say(handle, line),
      emit: (o) => this.providers.deliver(handle, o),
      exited: (code, signal) => {
        if (this.loaded.get(handle)?.kernel === kernel) this.loaded.delete(handle);
        if (code !== 0) this.say(handle, `kernel exited (${signal ?? `code ${code}`})`);
      },
    });
    let g: { identity?: unknown } | null;
    try {
      if (!(await kernel.store.log.tip())) {
        // No tree was loaded into this store (`skein-host add --boot/--packet` does that): the stock system, through the same loader.
        const b = await boot(kernel, { kind: "code" }, this.genesisConfig(row, identity), this.now());
        this.say(handle, `genesis ${b.entry}`);
      }
      g = await kernel.genesis() as { identity?: unknown } | null;
      if (!g) throw new Error("the store's log does not start with a genesis this kernel reads (format 3, #40): start a new store (re-genesis)");
      if (keyHex(g.identity) !== identity) throw new Error(`the oracle (${short(identity)}) is not this instance's identity (${short(keyHex(g.identity))})`);
      await kernel.start();
      await kernel.running(identity);
      void kernel.idle().catch(() => {}); // busy until what start resumed is done
      if (!row.identity) this.o.db.add(row.handle, { identity });
      if (row.kind !== "mailbox") { const w = noOwnerMessagebox(g); if (w) this.say(handle, w); }
      this.feeds.declare(handle, feedsOf(g as Record<string, unknown>));
    } catch (e) {
      await kernel.stop(1000);
      throw e;
    }
    const l: Loaded = { row, kernel, identity, wallet, genesis: g as Record<string, unknown> };
    // Its node (the genesis's libp2p and the dispatch table's libp2p rows), before anything it runs can publish or dial.
    await this.syncP2p(l, true);
    this.loaded.set(handle, l);
    this.say("router", `hydrated ${handle} (${short(identity)})`);
    return l;
  }

  /**
   * Whether a stopped instance's dispatch table routes an entry in `box` —
   * an event (no sender), or (given) a message from `sender` (hex): the
   * kernel's rule (#77, dispatch.zig forMail/forEvent). Read from its store
   * file, read-only, with no kernel.
   */
  async subscribes(handle: string, box: string, sender?: string): Promise<boolean> {
    const row = this.o.db.get(handle);
    if (!row || !existsSync(row.store)) return false;
    const s = openStoreFile(row.store, { readOnly: true });
    try {
      const rows = await currentDispatch(s);
      return !!rows?.some((r) => sender !== undefined ? takesMail(r, sender, box) : takesEvent(r, box));
    } finally { s.close(); }
  }

  /**
   * Boot a row's empty store from a system tree or a checkpoint (issue #4,
   * boot.ts) before its first hydration; the row's identity is its oracle's.
   */
  async bootRow(handle: string, src: BootSource, o: { image?: boolean; manager?: boolean } = {}): Promise<Booted> {
    const row = this.o.db.get(handle);
    if (!row) throw new Error(`no instance ${handle}`);
    if (this.loaded.has(handle)) throw new Error(`${handle} is loaded: boot only an empty store`);
    if (o.image && src.kind !== "tree") throw new Error("an image is a system tree");
    if (o.manager && !o.image) throw new Error("the instance manager is the host skein's, and the host skein is an image");
    const identity = await rootIdentity(await this.o.walletFor(row));
    const c = src.kind === "checkpoint" ? { identity, owner: this.o.owner ?? identity, handle: row.handle, domain: row.domain } : o.image ? this.imageConfig(row, identity, { manager: o.manager }) : this.genesisConfig(row, identity, src.kind === "code");
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

  /**
   * A new agent's address book seed (#70): this host's providers — the HTTP
   * proxy, the waker, the cron provider (#69), the libp2p node (when it runs
   * one), the status provider (#65, when it has an Arcade) — and the owner's
   * mailbox, when it knows it.
   */
  addressSeed(): AddressSeed[] {
    const names: ProviderName[] = ["fetch", "waker", "cron", ...(this.p2p ? ["libp2p" as const] : []), ...(this.arc ? ["status" as const] : [])];
    const out: AddressSeed[] = this.providers.entries(names);
    const mb = this.ownerMessagebox();
    if (this.o.owner && mb) out.push({ key: keyBytes(this.o.owner), transport: "mailbox", address: mb, ...(this.o.ownerHandle ?? {}) });
    return out;
  }

  /**
   * What this host brings to an image's genesis (#89): only its own facts —
   * the instance's identity, handle and domain, its providers in the address
   * book, where its domain resolves, the host's defaults. No owner, no
   * owner's mailbox, no inference peer, no names: the image is the same for
   * everyone, and the owner comes with the claim (`claim`). `manager`
   * (#90): the host skein's — the instance manager in its address book too
   * (no other instance's book names it).
   */
  imageConfig(row: Pick<InstanceRow, "handle" | "domain">, identity: string, o: { manager?: boolean } = {}): Genesis2Config {
    const seed = this.providers.entries(["fetch", "waker", "cron", ...(this.p2p ? ["libp2p" as const] : []), ...(this.arc ? ["status" as const] : []), ...(o.manager ? ["manager" as const] : [])]);
    return {
      identity, handle: row.handle, domain: row.domain, resolveOrigin: this.origin(), addressBook: seed,
      providers: Object.fromEntries(seed.map((e) => [e.role, Buffer.from(e.key).toString("hex")])),
      feeds: this.o.genesis?.feeds, defaults: this.o.genesis?.defaults, overrides: this.o.fuelPerStep ? { fuelPerStep: this.o.fuelPerStep } : undefined,
      warn: (l) => this.say(row.handle, l),
    };
  }

  /**
   * The claim (#89): the instance manager's signed message into an image's
   * claim row — box `claim`, body {owner, messagebox?, handle?, domain?} —
   * appended as a `local` request. The kernel writes the owner's admin rows
   * and removes the claim row in one step, or refuses (no row any more; an
   * instance owned already). Without a messagebox, the owner's mailbox
   * instance on this host, if it has one. What happened: the entry, and
   * whether the instance is now claimed by `owner` (its `dispatch` admin row
   * from that key).
   */
  async claim(handle: string, owner: string, o: { messagebox?: string; handle?: string; domain?: string } = {}): Promise<{ entry: CID; claimed: boolean }> {
    const row = this.o.db.get(handle);
    if (!row || row.status !== "enabled") throw new Error(`no enabled instance ${handle}`);
    const key = keyBytes(owner);
    const mb = o.messagebox ?? (() => { const m = this.o.db.mailboxOf(owner); return m ? this.originOf(m.handle) : undefined; })();
    const l = await this.hydrate(handle);
    const body = { owner: key, ...(mb ? { messagebox: mb } : {}), ...(o.handle ? { handle: o.handle, domain: o.domain ?? "localhost" } : {}) };
    const entry = await this.providers.send(handle, "manager", keyBytes(l.identity), "claim", body) as CID;
    await this.settled();
    return { entry, claimed: await this.claimedBy(l, owner) };
  }

  /** Whether `owner` holds the instance's admin rows (its `dispatch` row): claimed by that key. */
  private async claimedBy(l: Loaded, owner: string): Promise<boolean> {
    const rows = (await l.kernel.dispatch()).rows;
    return rows.some((r) => r.program === "kernel" && r.fn === "dispatch" && r.sender instanceof Uint8Array && Buffer.from(r.sender).toString("hex") === owner);
  }

  /**
   * A new instance from an image, owned by `owner` (#90: the instance
   * manager's `create`; `skein-host init` for the host skein). In this order:
   * the row, disabled (no hostname: nothing reaches it); its identity
   * derived (the oracle's, key ID = the handle) and its store booted from the
   * image (only `default`, the default image, so far); its kernel started
   * unpublished; the owner's claim delivered as a `local` request from the
   * instance manager, and processed — the owner's admin rows written, the
   * claim row removed; only then (`publish`, default true) the row enabled,
   * which publishes its hostname. No request can reach the claim row first.
   * `host`: the host skein — the instance manager in its address book, and
   * recorded as the host skein (host.db). A refusal throws (a bad or taken
   * handle, a bad key, another image, a refused claim: the row is left
   * disabled, its store kept for a look).
   */
  async createInstance(handle: string, owner: string, o: { image?: string; host?: boolean; publish?: boolean } = {}): Promise<{ handle: string; identity: string; url: string }> {
    if (!HANDLE.test(handle)) throw new Error(`handle ${JSON.stringify(handle)}: lower-case letters, digits and "-", at most 63, as a hostname label`);
    if (!KEY.test(owner)) throw new Error("owner: not an identity key (33 bytes)");
    if (o.image !== undefined && o.image !== "default") throw new Error(`image ${JSON.stringify(o.image)}: this host has only the default image`);
    if (this.o.db.get(handle)) throw new Error(`handle ${handle} is taken`);
    const store = join(this.o.home ?? ".", "instances", handle, "runtime.db");
    if (existsSync(store)) throw new Error(`handle ${handle}: a store is at ${store} already`);
    this.o.db.add(handle, { store, status: "disabled" });
    this.unpublished.add(handle);
    try {
      await this.bootRow(handle, await imageSource(), { image: true, manager: o.host });
      const l = await this.hydrate(handle);
      const entry = await this.providers.send(handle, "manager", keyBytes(l.identity), "claim", { owner: keyBytes(owner), ...this.ownerMailbox(owner) }) as CID;
      await this.queues.get(handle);
      await l.kernel.idle();
      if (!(await this.claimedBy(l, owner))) throw new Error(`the claim ${entry} was refused (its log says why); ${handle} is left disabled`);
      if (o.host) this.o.db.setSetting("host_skein", handle);
      if (o.publish !== false) this.o.db.setStatus(handle, "enabled");
      this.say("router", `created ${handle} (${short(l.identity)}) from the default image, claimed by ${short(owner)}${o.publish !== false ? `, at ${this.originOf(handle)}` : ""}${o.host ? ": the host skein" : ""}`);
      return { handle, identity: l.identity, url: this.originOf(handle) };
    } finally {
      this.unpublished.delete(handle);
    }
  }

  /** The owner's mailbox instance on this host, as a claim's `messagebox` (none: {}). */
  private ownerMailbox(owner: string): { messagebox?: string } {
    const m = this.o.db.mailboxOf(owner);
    return m ? { messagebox: this.originOf(m.handle) } : {};
  }

  /**
   * The instance manager's work (#90; providers.ts `manager`): a message from
   * the host skein in box `create`, `start` or `stop` → the answer body. A
   * refusal throws (the provider answers {error}).
   */
  private async manage(box: string, b: Record<string, unknown>): Promise<Record<string, unknown>> {
    const handle = typeof b.handle === "string" ? b.handle : "";
    if (box === "create") {
      const owner = b.owner instanceof Uint8Array ? Buffer.from(b.owner).toString("hex") : typeof b.owner === "string" ? b.owner : "";
      if (b.image != null && typeof b.image !== "string") throw new Error("image: the image's name (text)");
      const c = await this.createInstance(handle, owner, { image: (b.image as string | null | undefined) ?? undefined });
      return { handle: c.handle, identity: keyBytes(c.identity), url: c.url };
    }
    if (box !== "start" && box !== "stop") throw new Error(`the instance manager takes create, start and stop: not ${box}`);
    const row = this.o.db.get(handle);
    if (!row) throw new Error(`no instance ${handle}`);
    if (row.handle === this.o.db.hostSkein()?.handle) throw new Error(`${handle} is the host skein: it is not started or stopped by a message from itself`);
    if (box === "start") {
      this.o.db.setStatus(handle, "enabled");
      await this.hydrate(handle);
      this.say("router", `${handle}: started by the instance manager`);
      return { handle, started: true, url: this.originOf(handle) };
    }
    this.o.db.setStatus(handle, "disabled");
    const l = this.loaded.get(handle);
    if (l) { this.loaded.delete(handle); await l.kernel.stop(); }
    this.say("router", `${handle}: stopped by the instance manager`);
    return { handle, stopped: true };
  }

  /** What this host brings to a new instance's genesis (boot.ts): the owner and its messagebox, the inference peer, their names, the host's defaults. */
  genesisConfig(row: Pick<InstanceRow, "handle" | "domain"> & Partial<Pick<InstanceRow, "kind" | "owner">>, identity: string, code = true): Genesis2Config {
    if (row.kind === "mailbox") {
      if (!row.owner) throw new Error(`${row.handle}: a mailbox instance names its owner`);
      return { identity, owner: row.owner, handle: row.handle, domain: row.domain, mailbox: true };
    }
    if (!this.o.owner) throw new Error("an empty store needs the owner's identity key (SKEIN_OWNER) for its genesis");
    const genesisDefaults = this.o.genesis?.defaults;
    const hostDefaults = { ...genesisDefaults, ...(this.o.fuelPerStep ? { fuelPerStep: this.o.fuelPerStep } : {}) };
    const warn = (l: string) => this.say(row.handle, l);
    const facts = { ownerMessagebox: this.ownerMessagebox(), resolveOrigin: this.origin(), addressBook: this.addressSeed(), providers: Object.fromEntries(this.addressSeed().filter((e) => e.role && e.transport === "local").map((e) => [e.role!, Buffer.from(e.key).toString("hex")])) };
    if (!code) {
      // A system tree: its config wins; the host fills what it leaves unset. SKEIN_FUEL_PER_STEP stays an explicit (dev) override.
      return {
        identity, owner: this.o.owner, handle: row.handle, domain: row.domain, infer: this.o.infer, ownerHandle: this.o.ownerHandle, inferHandle: this.o.inferHandle,
        feeds: this.o.genesis?.feeds, defaults: genesisDefaults, overrides: this.o.fuelPerStep ? { fuelPerStep: this.o.fuelPerStep } : undefined, warn, ...facts,
      };
    }
    return {
      identity, owner: this.o.owner, handle: row.handle, domain: row.domain, infer: this.o.infer, ownerHandle: this.o.ownerHandle, inferHandle: this.o.inferHandle,
      // Code genesis takes DEFAULTS under the host's.
      defaults: Object.keys(hostDefaults).length ? { ...DEFAULTS, ...hostDefaults } : undefined,
      subscriptions: this.o.genesis?.subscriptions,
      feeds: this.o.genesis?.feeds,
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

  /**
   * The kernel counts as busy until it has processed what was just admitted
   * (its `idle` answers after the drain); then the libp2p node follows the
   * dispatch table (#72, #77).
   */
  private settle(l: Loaded): void {
    const p = l.kernel.idle().then(() => this.syncP2p(l)).catch(() => {});
    this.syncing.add(p);
    void p.finally(() => this.syncing.delete(p));
  }

  /**
   * The instance's libp2p node as its genesis and its dispatch table ask
   * (#72, #77, p2p.ts libp2pConfig): read the table (the kernel's `dispatch`
   * frame); when its chain's tip moved since the node last followed it (or
   * `first`), declare the config again — the node started, reconfigured
   * (topics subscribed and unsubscribed, protocols handled and unhandled) or
   * stopped. A failure is logged, not fatal.
   */
  private async syncP2p(l: Loaded, first = false): Promise<void> {
    if (!this.p2p || l.kernel.gone) return;
    const d = await l.kernel.dispatch().catch(() => undefined);
    if (d === undefined) return;
    const key = d.tip ? d.tip.toString() : "";
    if (!first && key === (l.dispatchTip ?? "")) return;
    l.dispatchTip = key;
    await this.p2p.declare(l.row.handle, libp2pConfig(l.genesis, d.rows as unknown as Array<Record<string, unknown>>)).catch((e) => this.say(l.row.handle, `libp2p: ${first ? "not started" : "not reconfigured"}: ${(e as Error).message}`));
  }

  /**
   * The waker answers every wake-me due by this router's clock, and the cron
   * provider sends every tick due (#69) — what their timers do in real time,
   * for a clock that is not (a script clock: tests, the corpus).
   */
  async wake(): Promise<void> {
    this.providers.wakeDue();
    await this.cron.tick();
    await this.providers.idle();
  }

  /** An instance's next wake (ms), if any (the host page): the waker's earliest, or its next tick (#69). */
  nextWake(handle: string): number | undefined {
    const xs = [this.providers.nextWake(handle), ...this.cron.of(handle).map((s) => s.next)].filter((x): x is number => x !== undefined);
    return xs.length ? Math.min(...xs) : undefined;
  }

  /** Stop kernels idle for `ms` with nothing queued. Their deadlines and sleeps stay with the waker, their schedules with the cron provider. */
  private async reap(ms: number): Promise<void> {
    for (const [handle, l] of this.loaded) {
      if (l.kernel.busy > 0 || this.queues.has(handle) || Date.now() - l.kernel.last < ms) continue;
      this.loaded.delete(handle);
      this.say("router", `${handle}: idle, stopped`);
      await l.kernel.stop();
    }
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
   * The HTTP proxy's request (#70, the `fetch` provider): this host's own URLs in
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
    if (t) {
      const p = this.forward(t.handle, t.route, url, req);
      this.inflight.add(p);
      try { return await p; } finally { this.inflight.delete(p); }
    }
    const path = url.pathname;
    if (req.method === "GET" && path === "/manifest.json") {
      const { publicKey } = await this.certifier.getPublicKey({ identityKey: true });
      return json(200, manifest(publicKey, `${this.origin()}/.well-known/metanet-handles/resolve`));
    }
    if (req.method === "GET" && path === "/.well-known/metanet-handles/resolve") {
      // BRC-169 §5.2: `handle` is the bare handle; `handle@domain` is accepted too. Without a domain, the row's.
      const q = (url.searchParams.get("handle") ?? "").replace(/^@/, "");
      const [h0, d] = q.split("@");
      const handle = h0!.split("+")[0]!.toLowerCase();
      if (!handle) return json(400, resolutionError("malformed-handle", "want ?handle=<handle>"));
      const row = this.o.db.get(handle);
      const domain = (d ?? row?.domain ?? "localhost").toLowerCase();
      const key = this.o.db.identityOf(handle, domain);
      if (!row || row.status !== "enabled" || !key) return json(404, resolutionError("handle-not-found", `no handle ${handle}@${domain} here`));
      return json(200, await resolution(this.certifier, handle, domain, key, this.originOf(handle)));
    }
    const pki = /^\/bsvalias\/id\/([^/]+)$/.exec(path);
    if (req.method === "GET" && pki) {
      const [handle, domain = "localhost"] = decodeURIComponent(pki[1]!).split("@");
      const key = this.o.db.identityOf(handle!, domain);
      return key ? json(200, { bsvalias: "1.0", handle: `${handle}@${domain}`, pubkey: key }) : json(404, { error: "not found" });
    }
    if (path === `${ARC_ROUTE}/callback`) return await this.arcRequest(req, path);
    if (req.method === "POST" && path === "/account/register") return await this.register(req.body);
    return json(404, { status: "error", code: "ERR_NOT_FOUND", description: "no instance here: an instance is at http://<handle>.localhost:<port>/ or /@<handle>/" });
  }

  /** Arcade's webhook (#58, arc.ts); 404 when the host has no Arcade. */
  private async arcRequest(req: RouterRequest, path: string): Promise<RouterResponse> {
    if (!this.arc) return json(404, { status: "error", code: "ERR_NOT_FOUND", description: "this host has no Arcade" });
    if (req.method === "POST") return await this.arc.callback(req.headers, req.body);
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

  /**
   * A request for an instance (#68, #66): appended as received, and the
   * client's connection held until the thread it launched comes to rest —
   * then its answer, signed on the session inside. Past `answerWaitMs`, or
   * when the router shuts down, 503 + Retry-After (the thread goes on). A
   * read's call fuel (the explorer's) is charged to the ledger.
   */
  private async forward(handle: string, route: string, url: URL, req: RouterRequest): Promise<RouterResponse> {
    if (this.stopped) return unavailable("the host is shutting down");
    let l: Loaded;
    try { l = await this.hydrate(handle); } catch (e) { return json(503, { status: "error", code: "ERR_UNAVAILABLE", description: (e as Error).message }); }
    const a: FrontAnswer = await frontDoor(l.kernel, { method: req.method, path: url.pathname, route, query: url.search, headers: req.headers, body: req.body }, { now: this.now(), waitMs: this.o.answerWaitMs, stop: this.stopping });
    this.settle(l);
    if (a.fuel !== undefined) this.charge(handle, req.headers["x-bsv-auth-identity-key"] ?? "", `${route} (read)`, a.fuel);
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
      // A client's idle socket is the client's to close (undici: 4 s): a server that closes first races a
      // client whose event loop was busy past the server's 5 s default — a large install message (#83:
      // a module whole) is seconds of the SDK's per-byte checks — and the client's next request is reset.
      server.keepAliveTimeout = 65_000;
      server.headersTimeout = 66_000;
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

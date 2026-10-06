// The host as a reverse proxy (#40): each instance is an HTTP server — its
// front door (programs/frontdoor) — at an origin of its own, and the router
// only picks the instance a request is for and forwards it. Routing comes
// before authentication, because a BRC-104 handshake does not name its
// recipient: the URL is the recipient. The router holds no sessions and no
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
//   The host's own origin (a host name whose first label is no instance) is the host skein's BRC-169 server
//   (#113): these requests go to the host skein, as any request goes to its instance, under the onboarding
//   app's routes (shruggr/skein-onboard: it registers, certifies through the certifier provider, records and
//   answers; DISCOVERY below):
//   GET  /manifest.json                          → /onboard/manifest.json   BRC-169 §5.1
//   GET  /.well-known/metanet-handles/resolve    → /onboard/resolve         BRC-169 §5.2
//   GET  /.well-known/metanet-handles/search     → /onboard/search          BRC-169 §5.6
//   POST /.well-known/auth                       → /.well-known/auth        the BRC-103 handshake (#135: a registration is signed)
//   POST /account/register                       → /onboard/register        a mailbox instance and its certificate (signed)
//   POST /account/profile                        → /onboard/profile         a handle holder's signed profile
//   GET  /bsvalias/id/<handle>[@<domain>]        → /onboard/bsvalias/id/…   the paymail PKI, from the same records
//   With no host skein: 404 (tests may answer them with a fixture: `discovery`).
//   GET  /.well-known/skein-host          at every host name, an instance's too (#103): {origin, domain} — this
//                                         router's origin and the handle domain (the onboarding app's
//                                         config.onboard.domain), for a page an instance serves (the management
//                                         site) to find the manifest and register
//   GET  /<app>/.live/<topic>             at an instance's origin (#138): the liveness tool's beats for that app's
//                                         liveness on the topic (liveness.ts), served by the host, no program:
//                                         JSON [{sender: <identity key, hex>, at: <ms>, body: <base64>, from: <peer
//                                         ID>}], newest first; 404 when the app keeps no liveness for the topic.
//                                         Unsigned, nothing logged; metered as a read (billing.ts)
//   POST /arc/callback                    Arcade's webhook (Bearer: the host token)
//   POST /fund/<handle>                   #130: a payment for an instance (its body an Atomic BEEF, the header
//                                         x-skein-outputs BRC-100's internalizeAction outputs, JSON), handed in
//                                         on its funding row (/wallet/fund; #135: a message, signed by the host's
//                                         billing key over a session, the outputs as x-bsv-skein-outputs) — even
//                                         asleep: the one thing the gate lets through (billing.ts)
//
// The broadcaster (#58, #65, arc.ts) takes the instances' broadcast events
// (a durable queue in host.db, retries, one Arcade session) and routes what
// Arcade says of a transaction to every instance whose state holds it (a
// `has` of its CID, cached): a proof as an unsigned event in box `chain`,
// any other status as a signed message from the status provider.
//
// A request for an instance goes to one of its two doors (#135, frontdoor.ts
// serveHttp): a read — a path the instance's reads head names — is served by
// a `call` (no entry; its fuel metered); a signed request for a message route
// (#68, #66) is appended as received — one `request` entry, verified by
// nothing here — and the client's connection held until the thread the kernel
// steps the front door on comes to rest; its answer, signed on the session
// inside, is the response. Past `answerWaitMs`, or at shutdown, 503 +
// Retry-After. An unsigned request goes through the door only at an open row
// whose filter validates the payload (#135: signed or validated; answered
// plain); otherwise for a message route it is 401, for nothing 404, answered
// without an entry.
//
// What the instances send out goes through the host's providers (#70,
// providers.ts): each kernel hands over the messages its steps emitted
// (unsigned, #126 step 4) to a `local` provider or a libp2p recipient, and the provider's
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
// its row is enabled, which publishes its hostname; image `mailbox`, #113, a
// mailbox instance for a registration); the certifier (#113) signs handle
// certificates for the host skein alone. Each genesis it writes names the providers' keys
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
// topics subscribed, an uninstall's unsubscribed, live (`syncDispatch`).
// The host's headers feed (#102, `headersFeed`, SKEIN_HEADERS_URL; feeds.ts)
// follows the table the same way: an enabled instance is subscribed while
// a row of it takes events in box `chain` (the chain app's), else not. The
// router itself listens to it too (#132, image-chain.ts): the default image
// carries the whole header chain and grows with every header the feed
// brings (filled from genesis at start from the feed's chaintracks history),
// and createInstance boots each new skein from the image as it stands.
//
// Nothing here is an instance's clock but its providers (#69): a schedule
// originates in a program's step, as a message to the cron provider; an
// idle-stopped instance is hydrated for a tick only if something in it
// subscribes the tick's box (from the cron provider, or from anyone).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Server as NetServer } from "node:net";
import { join } from "node:path";
import { AuthFetch, KeyDeriver, P2PKH, PrivateKey, ProtoWallet, Transaction, type WalletInterface } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { rootIdentity } from "../runtime/identity.ts";
import { ephemeralWallet } from "../wallet.ts";
import { DEFAULTS, short, stampMs } from "../runtime/log.ts";
import type { Stamp } from "../runtime/syscalls.ts";
import { ARC_ROUTE, Broadcaster, type ArcConfig } from "./arc.ts";
import { DEFAULT_BOX, Feeds, feedsOf, txCid, type FeedSpec } from "./feeds.ts";
import { Cron, dbSchedules } from "./cron.ts";
import { currentDispatch, takesEvent, takesMail, type DispatchRow } from "../runtime/dispatch.ts";
import { openStoreFile } from "../runtime/index-store.ts";
import { existsSync } from "node:fs";
import { now as clockNow } from "./clock.ts";
import { boot, bootStore, type BootSource, type Booted } from "./boot.ts";
import { historyOf, ImageChain } from "./image-chain.ts";
import { ANSWER_WAIT_MS, appendRequest, frontDoor, headerMap, serveHttp, unavailable, type FrontAnswer } from "./frontdoor.ts";
import { admit2, keyBytes, keyHex, type AddressSeed, type Genesis2Config, type Libp2pSpec, type PathRowSpec } from "./genesis.ts";
import { HANDLE, type HostDb, type InstanceRow } from "./instances.ts";
import { Kernel } from "./kernel.ts";
import { foldLiveness, livenessEvent, livenessOf, type Live } from "./liveness.ts";
import { beaconEvent, beaconsOf, DEFAULT_LISTEN, foldBeacons, foldSubscriptions, libp2pConfig, P2PHost, subscribedTopics, subscriptionEvent, subscriptionsOf, type Beacon, type InboundAnswer, type InboundCall, type P2PHostConfig, type Subscription } from "./p2p.ts";
import { peerIdFromMultihash } from "@libp2p/peer-id";
import { MESSAGE_KEY_ID, MESSAGE_PROTOCOL, Providers, tooLarge, type HttpRequest, type HttpResponse, type MailRecord, type ProviderName } from "./providers.ts";
import { closeControl, listenControl } from "./control.ts";
import { certify, RESOLVE_PATH, SEARCH_PATH } from "./handles.ts";
import { allocation, BILLING_HEAD, closedBy, DESCRIPTION_HEADER, FUND_PREFIX, FUND_ROUTE, mismatch, OUTPUTS_HEADER, Period, SIGNED_DESCRIPTION_HEADER, SIGNED_OUTPUTS_HEADER, periodRecord, priceHost, stateOf, termsOf, tickBody, type BillingConfig, type BillingView } from "./billing.ts";
import * as Digest from "multiformats/hashes/digest";

type Named = { handle: string; domain: string };

export interface RouterOptions {
  db: HostDb;
  /** Each row's signer: the wallet its kernel's `wallet` import is answered from. */
  walletFor(row: InstanceRow): Promise<WalletInterface> | WalletInterface;
  /** A new agent's genesis: its owner (required to write one), the inference peer, their names. */
  owner?: string;
  infer?: string;
  ownerHandle?: Named;
  inferHandle?: Named;
  fuelPerStep?: string;
  /** A new genesis's extra seed rows — boxes (a sender in hex, `$owner`, or a provider's `$<name>`: `$status`, `$cron`, …) and routes — and defaults (over DEFAULTS), e.g. the wallet's (#29). */
  genesis?: { subscriptions?: Array<{ sender?: string; box: string; handler: CID }>; defaults?: Record<string, string>; feeds?: FeedSpec[]; libp2p?: Libp2pSpec; routes?: PathRowSpec[] };
  /** The router-held feeds' limits (feeds.ts); the backoff is the broadcaster's subscription's too. */
  feeds?: { maxQueue?: number; backoff?: { min: number; max: number } };
  /** The host's headers feed (#102, SKEIN_HEADERS_URL): an SSE stream of block headers every enabled instance whose dispatch table takes events in box `chain` is subscribed to. */
  headersFeed?: string;
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
  /** An instance's libp2p peer key (signer.ts peerKey). Absent: no libp2p host; the kernels' `libp2p` is refused. */
  peerKeyFor?(handle: string): PrivateKey;
  /**
   * A provider's key (#70, signer.ts providerKey: the HTTP proxy `fetch`, the
   * `waker`, `cron`, `libp2p`, `status`), which each new genesis's address
   * book names. Absent: keys of this router's own, made fresh (a test's; a
   * restarted router would not be the providers its instances know).
   */
  providerKeyFor?(name: ProviderName): PrivateKey;
  /**
   * Tests: the host's own origin's BRC-169 requests (DISCOVERY) answered
   * when the host has no host skein — a fixture resolver over host.db
   * (testhost.ts). A host's are always the host skein's.
   */
  discovery?(req: RouterRequest, url: URL): Promise<RouterResponse | undefined>;
  /** How often the libp2p host redials bootstrap peers and runs topic rendezvous (ms); default 30 000. */
  libp2pDiscoveryMs?: number;
  /** #130: what this host bills (billing.ts; `skein-host run`: billingConfig over the environment). Absent: it bills no one. */
  billing?: BillingConfig;
}

interface Loaded {
  row: InstanceRow; kernel: Kernel; identity: string; wallet: WalletInterface;
  /** The genesis (its `libp2p`), and the dispatch table's tip as the libp2p node last followed it (#72, #77). */
  genesis: Record<string, unknown>;
  dispatchTip?: string;
  /** The dispatch table as last read (syncDispatch). */
  rows?: DispatchRow[];
  /** The apps' subscriptions (#119): folded from the log at hydrate, then followed live. */
  subs: Subscription[];
  /** The apps' beacons (#126): folded from the log at hydrate, then followed live; an uninstalled app's (no row left) dropped. */
  beacons: Beacon[];
  /** The apps' liveness (#138): folded from the log at hydrate, then followed live; an uninstalled app's (no row left) dropped. */
  live: Live[];
}

/** A request as the router takes it: the full URL (its host is the Host header's), lower-cased headers, the body. */
export interface RouterRequest { method: string; url: string; headers: Record<string, string>; body: Uint8Array; /** The instance whose `http` this is (none for a socket's). */ from?: string }
export interface RouterResponse { status: number; headers: Record<string, string>; body: Uint8Array }

const json = (status: number, v: unknown): RouterResponse => ({ status, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(v)) });
const KEY = /^0[23][0-9a-f]{64}$/;
export { HANDLE };
/** Handles no instance may take on this host (H3), besides the router origin's own first label (Router.reserved): `id` (the router's own in production) and `host` (the host skein's). */
export const RESERVED_HANDLES = new Set(["id", "host"]);
/** The registration signature (#113: the onboarding app checks it): [2, "skein register"], key ID the username, counterparty anyone, over `register <username>@<domain>`. */
export const REGISTER_PROTOCOL: [2, string] = [2, "skein register"];
/** A handle's domain as a manager's `create` takes it: a host name, lower case. */
const DOMAIN = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
/** The onboarding app (shruggr/skein-onboard, #90, #113): the host skein's app that serves BRC-169 on the host's own origin. */
export const ONBOARD_APP = "onboard";
/**
 * The host's own origin's BRC-169 requests (#113) → the host skein's routes
 * (the onboarding app's, under /onboard/): method + path → route.
 */
export const DISCOVERY: Record<string, string> = {
  "GET /manifest.json": `/${ONBOARD_APP}/manifest.json`,
  [`GET ${RESOLVE_PATH}`]: `/${ONBOARD_APP}/resolve`,
  [`GET ${SEARCH_PATH}`]: `/${ONBOARD_APP}/search`,
  "POST /account/register": `/${ONBOARD_APP}/register`,
  // #135: a registration is a signed request: the stock client's handshake at the host's own origin is the host skein's.
  "POST /.well-known/auth": "/.well-known/auth",
  "POST /account/profile": `/${ONBOARD_APP}/profile`,
};
/** The paymail PKI (`GET /bsvalias/id/<handle>[@<domain>]`) → the app's prefix row `/onboard/bsvalias/id/…`. */
export const PAYMAIL_PREFIX = "/bsvalias/id/";
/** The BRC-169 domain a host name stands for: a dev router at a loopback address answers for `localhost`. */
export const domainOf = (hostname: string): string => {
  const h = hostname.toLowerCase();
  return h === "127.0.0.1" || h === "::1" || h === "[::1]" || h === "" ? "localhost" : h;
};
/**
 * The BRC-169 domain of this host (H4): its public origin's host name
 * (SKEIN_ROUTER_ORIGIN, default the loopback: `localhost`). What a created
 * instance, a claim and a mailbox instance record when nothing names one,
 * and what /.well-known/skein-host answers.
 */
export const hostDomain = (origin: string): string => {
  try { return domainOf(new URL(origin.replace("{port}", "0")).hostname); } catch { return "localhost"; } // an origin that is no URL: the loopback's
};

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
    try { m = (JSON.parse(new TextDecoder().decode(b)) as { message?: typeof m }).message; } catch { /* neither: the line names no box; the delivery's result is logged beside it */ }
  }
  if (!m) return "";
  const to = m.recipient instanceof Uint8Array ? Buffer.from(m.recipient).toString("hex") : typeof m.recipient === "string" ? m.recipient : "";
  return `${String(m.messageBox ?? "?")}${to ? ` for ${short(to)}` : ""}`;
}

/** An error answer's description (JSON {description | error}), else its first 200 bytes. */
function errorOf(body: Uint8Array): string {
  const t = new TextDecoder().decode(body.subarray(0, 2000));
  try { const j = JSON.parse(t) as { description?: unknown; error?: unknown }; return String(j.description ?? j.error ?? t.slice(0, 200)); } catch { return t.slice(0, 200); } // not JSON: the text itself is the description
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
  /** The certifier (#100, #113): signs the BRC-169 handle certificates, for the host skein's onboarding app (the `certifier` provider). */
  readonly certifier: ProtoWallet;
  readonly loaded = new Map<string, Loaded>();
  private loading = new Map<string, Promise<Loaded>>();
  /** Rows being created (#90): hydrated before their hostname is published (disabled until claimed). */
  private unpublished = new Set<string>();
  private queues = new Map<string, Promise<unknown>>();
  /** The libp2p nodes following their dispatch tables (#72: syncDispatch after a settle). */
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

  /** The default image (#89), with its chain part (#132): what createInstance boots a new skein from. */
  readonly image: ImageChain;
  /** #130: each billed instance as last read (its host row's terms, the kernel's billing state), and what this host metered since its last tick. */
  private views = new Map<string, BillingView>();
  private periods = new Map<string, Period>();
  /** Instances a tick is on its way to; and those sent their first (billing starts with it) since this router started: the timer sends it again. */
  private ticking = new Set<string>();
  private firstTicks = new Set<string>();
  private tickTimer?: ReturnType<typeof setInterval>;
  /** The host's provider keys (its billing key among them, #130). */
  private readonly providerKey: (name: ProviderName) => PrivateKey;

  constructor(o: RouterOptions) {
    this.o = o;
    this.image = new ImageChain({ db: o.db, history: historyOf(o.headersFeed), log: (l) => this.say("router", l) });
    this.stopping = new Promise<void>((r) => { this.stopNow = r; });
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
          await this.providers.send(h, "status", keyBytes(id), "chain/status", body, subject);
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
        // #126: a beacon's beat signed by the instance's signer, as an intention request is.
        sign: (h, data) => this.signAs(h, data),
        identity: async (h) => { const id = this.o.db.get(h)?.identity; return id ? keyBytes(id) : undefined; },
      });
    }
    // Without a host's own provider keys: a router's own, fresh (a test's).
    const own = o.providerKeyFor ? undefined : new KeyDeriver(PrivateKey.fromRandom());
    const keyOf = o.providerKeyFor ?? ((n: ProviderName) => own!.derivePrivateKey([2, "skein provider"], n, "self"));
    this.providerKey = keyOf;
    // The certifier key is the certifier provider's (signer.ts certifierKey: providerKey("certifier")).
    this.certifier = new ProtoWallet(keyOf("certifier"));
    const p2p = this.p2p;
    this.providers = new Providers({
      keyOf,
      append: (h, pkg) => this.appendLocal(h, pkg),
      identity: async (h) => { const id = this.o.db.get(h)?.identity; return id ? keyBytes(id) : undefined; },
      sign: (h, data) => this.signAs(h, data),
      fetch: (req, from) => this.http(req, from),
      ...(this.arc ? { broadcast: (h: string, tx: Uint8Array, beef?: Uint8Array) => { this.arc!.enqueue(h, tx, beef); } } : {}),
      ...(p2p ? { topicEvent: (h: string, rec: Record<string, unknown>) => this.topicEvent(h, rec) } : {}),
      cron: (h, sender, id, body) => this.cron.request(h, sender, id, body),
      // #90: the instance manager acts for the host skein alone.
      manager: {
        from: () => { const r = this.o.db.hostSkein(); return r?.identity ? { handle: r.handle, identity: r.identity } : undefined; },
        request: (box, body) => this.manage(box, body),
      },
      // #113: the certifier signs for the host skein alone (the onboarding app records each issue).
      certifier: (box, body) => certify(this.certifier, box, body),
      // #130: a payment is this host's: kept and broadcast.
      ...(o.billing ? { payment: (h: string, rec: Record<string, unknown>) => this.payment(h, rec) } : {}),
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
    if (o.billing) this.tickTimer = setInterval(() => void this.tickAll(), o.billing.tickMs);
  }

  private say(source: string, line: string): void { this.o.log?.(source, line); }
  private now(): Stamp { return (this.o.now ?? clockNow)(); }
  /** The router's clock, as entries are stamped. */
  nowStamp(): Stamp { return this.now(); }

  /** This host's own origin. */
  origin(): string { return (this.o.origin ?? "http://127.0.0.1:{port}").replace("{port}", String(this.port || this.o.port || 0)); }
  /**
   * The first label of the router's own origin, when its host name is a
   * name (`id` for id.skein.nexus), else undefined: no instance may take it,
   * so a request to the router's origin never reaches an instance (H3).
   */
  ownLabel(): string | undefined {
    let h: string;
    try { h = new URL(this.origin()).hostname.toLowerCase(); } catch { return undefined; } // an origin that is no URL names no label
    if (!h.includes(".") || /^[0-9.]+$/.test(h) || h.startsWith("[")) return undefined;
    return h.split(".")[0];
  }

  /** Whether `handle` is reserved on this host: `id`, `host` (RESERVED_HANDLES), or the router origin's own first label. */
  reserved(handle: string): boolean {
    return RESERVED_HANDLES.has(handle) || handle === this.ownLabel();
  }

  /** This host's BRC-169 domain: its origin's host name (hostDomain). */
  domain(): string { return hostDomain(this.origin()); }

  /** An instance's origin: where its front door is, what BRC-169 publishes as its messagebox. */
  originOf(handle: string): string {
    return (this.o.instanceOrigin ?? "http://{handle}.localhost:{port}").replace("{handle}", handle).replace("{port}", String(this.port || this.o.port || 0));
  }

  /** Hydrate every enabled row once (recovery at hydrate time: what a waiting thread awaits is handed to the providers again), then let them idle out. */
  async start(): Promise<void> {
    // #132: the image's chain part, filled from the feed's history (from genesis once; then from near its tip), then grown by the feed.
    if (this.o.headersFeed) {
      void this.image.start();
      this.feeds.listen(this.o.headersFeed, (raws) => { void this.image.headers(raws); });
    }
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
      reclaim: (h) => this.reclaim(h),
    });
    this.control = { server, path };
    this.say("router", `control socket at ${path}`);
  }

  private async shutdown(): Promise<void> {
    this.stopped = true;
    // Clients waiting on a thread are answered 503 + Retry-After before the servers close (#66).
    this.stopNow();
    if (this.inflight.size) {
      await Promise.all([...this.inflight].map((p) => p.catch(() => {}))); // each answers its own client (a 503 now): this only waits for them
      await new Promise((r) => setTimeout(r, 50)); // their 503s written before the sockets close
    }
    clearInterval(this.idleTimer);
    clearInterval(this.ledgerTimer);
    clearInterval(this.tickTimer);
    this.flushLedger();
    const closed = this.servers.map((s) => new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections(); }));
    this.servers = [];
    if (this.control) closed.push(closeControl(this.control.server, this.control.path));
    this.control = undefined;
    this.providers.stop();
    await Promise.all([this.cron.stop(), this.feeds.stop(), this.arc?.stop(), this.p2p?.stop()]);
    // A kernel still hydrating: its load finishes (or fails) first, then it is stopped with the rest.
    await Promise.all([...this.loading.values()].map((p) => p.catch(() => {}))); // a failed load was reported to whoever asked for it
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
      const closed = this.closed(handle);
      if (closed) throw new Error(`not forwarded (#130): ${closed}`);
      const cid = await l.kernel.store.put(event as never);
      const e = await admit2(l.kernel, { box, event: cid } as never, {}, this.now());
      this.settle(l);
      return e;
    });
  }

  /**
   * A message for an instance (#70): a provider's signed answer, a forwarded
   * claim, or the loopback's own emit, appended as received — a `local`
   * request entry, {kind: "message", message, body}; the front door checks it
   * (the signature, or for the loopback the record in the store) and routes
   * it. Nobody waits on it.
   */
  async appendLocal(handle: string, pkg: Record<string, unknown>): Promise<CID> {
    return await this.serial(handle, async () => {
      const l = await this.hydrate(handle);
      // #130: the gate lets through the instance's own messages to itself (the loopback), nothing else.
      const closed = this.closed(handle);
      if (closed && !isLoopback(pkg, l.identity)) throw new Error(`not forwarded (#130): ${closed}`);
      const e = await appendRequest(l.kernel, "local", pkg, this.now());
      this.settle(l);
      return e;
    });
  }

  /** Sign `data` with `handle`'s signer: [2, "metanet handles envelope"] / `send` / anyone — an intention request's signature (providers.ts), a beacon's beat (p2p.ts beaconFrame). */
  private async signAs(handle: string, data: Uint8Array): Promise<Uint8Array> {
    const row = this.o.db.get(handle);
    if (!row) throw new Error(`no instance ${handle}`);
    const { signature } = await (await this.o.walletFor(row)).createSignature({ protocolID: MESSAGE_PROTOCOL, keyID: MESSAGE_KEY_ID, counterparty: "anyone", data: [...data] });
    return Uint8Array.from(signature);
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
    const closed = this.closed(handle);
    if (closed) return { verdict: "ignore", reason: `not forwarded (#130): ${closed}` };
    const source = `libp2p:${call.topic ?? call.protocol ?? "?"}`;
    let from = "";
    try { from = peerIdFromMultihash(Digest.decode(call.from)).toString(); } catch { /* not a peer ID: only this log line's name; the front door judges the record */ }
    const record = call.topic !== undefined
      ? { kind: "p2p", topic: call.topic, from: call.from, seqno: call.seqno ?? new Uint8Array(), signature: call.signature ?? new Uint8Array(), body: call.body }
      : { kind: "p2p-frame", protocol: call.protocol ?? "", from: call.from, body: call.body };
    const entry = await appendRequest(l.kernel, "libp2p", record, this.now());
    const a = await l.kernel.answer(entry, this.o.answerWaitMs ?? ANSWER_WAIT_MS);
    this.settle(l);
    if (a.state === "refused") {
      // #121: refused at the door. A bad signature or a bad BEEF is the sender's fault (reject: GossipSub
      // penalises the forwarder); what this instance cannot judge (no chain state, a failing middleware) is ignore.
      const verdict = (a.refused.status ?? 400) < 500 && !/no chain state/.test(a.refused.reason) ? "reject" : "ignore";
      this.say(handle, `${source} from ${from}: ${verdict} (refused at the door, ${a.refused.stage}: ${a.refused.reason})`);
      return { verdict, reason: a.refused.reason };
    }
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
      await Promise.all([...this.loaded.values()].map((l) => l.kernel.idle().catch(() => {}))); // a kernel that exited is reported by its exit (hydrate's `exited`): this only waits
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
    // f's failure goes to its caller through `next`; the queue only keeps the order.
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
    if (row.identity && row.identity !== identity) throw new Error(`its signer is ${short(identity)}, not the recorded identity ${short(row.identity)}`);
    const kernel = new Kernel({
      db: row.store, handle: row.handle, domain: row.domain, wallet, command: this.o.kernel?.command, env: this.o.kernel?.env,
      log: (line) => this.say(handle, line),
      emit: (o) => this.providers.deliver(handle, o),
      http: (req) => this.http(req, handle),
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
      if (keyHex(g.identity) !== identity) throw new Error(`the signer (${short(identity)}) is not this instance's identity (${short(keyHex(g.identity))})`);
      await kernel.start();
      await kernel.running(identity);
      void kernel.idle().catch(() => {}); // busy until what start resumed is done; a kernel that exits meanwhile is reported by its exit
      if (!row.identity) this.o.db.add(row.handle, { identity });
      if (row.kind !== "mailbox") { const w = noOwnerMessagebox(g); if (w) this.say(handle, w); }
      this.feeds.declare(handle, feedsOf(g as Record<string, unknown>));
    } catch (e) {
      await kernel.stop(1000);
      throw e;
    }
    // #119: the apps' subscriptions, read from the log (the kernel writes nothing for them).
    const subs = await this.foldSubscriptions(row.store).catch((e) => { this.say(handle, `libp2p: the subscriptions not read: ${(e as Error).message}`); return [] as Subscription[]; });
    // #126: the apps' beacons, read from the log the same way.
    const beacons = await this.foldBeacons(row.store).catch((e) => { this.say(handle, `libp2p: the beacons not read: ${(e as Error).message}`); return [] as Beacon[]; });
    // #138: the apps' liveness, read from the log the same way.
    const live = await this.readLiveness(row.store).catch((e) => { this.say(handle, `libp2p: the liveness not read: ${(e as Error).message}`); return [] as Live[]; });
    const l: Loaded = { row, kernel, identity, wallet, genesis: g as Record<string, unknown>, subs, beacons, live };
    // Its node (the genesis's libp2p and the dispatch table's libp2p rows), before anything it runs can publish or dial; the host's headers feed.
    await this.syncDispatch(l, true);
    this.loaded.set(handle, l);
    await this.syncBilling(l).catch((e) => this.say(handle, `billing: not read: ${(e as Error).message}`));
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
   * boot.ts) before its first hydration; the row's identity is its signer's.
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
   * everyone, and the owner is the claim's sender (#127). `manager`
   * (#90, #113): the host skein's — the instance manager and the certifier
   * in its address book too (no other instance's book names them).
   */
  imageConfig(row: Pick<InstanceRow, "handle" | "domain">, identity: string, o: { manager?: boolean } = {}): Genesis2Config {
    const seed = this.providers.entries(["fetch", "waker", "cron", ...(this.p2p ? ["libp2p" as const] : []), ...(this.arc ? ["status" as const] : []), ...(o.manager ? ["manager" as const, "certifier" as const] : [])]);
    return {
      identity, handle: row.handle, domain: row.domain, resolveOrigin: this.origin(), addressBook: seed,
      providers: Object.fromEntries(seed.map((e) => [e.address, Buffer.from(e.key).toString("hex")])),
      feeds: this.o.genesis?.feeds, defaults: this.o.genesis?.defaults, overrides: this.o.fuelPerStep ? { fuelPerStep: this.o.fuelPerStep } : undefined,
      warn: (l) => this.say(row.handle, l),
    };
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
   * derived (the signer's, key ID = the handle) and its store booted from the
   * image (only `default`, the default image, so far); its kernel started
   * unpublished; `claim` (#127) — the owner's own signed claim, a message in
   * box `claim` naming no recipient (it was signed before the instance
   * existed), with its body — forwarded into it as a `local` request, its
   * first entry after the genesis: the front door checks the signature, and
   * the kernel takes the owner from the signer (the owner's admin rows
   * written, the claim row removed); only then (`publish`, default true) the
   * row enabled, which publishes its hostname. No request can reach the claim
   * row first. The host signs nothing for the owner. With no `claim` (a bare
   * image: `skein-host init`), the instance keeps its claim row, from anyone:
   * the first sender of a claim owns it. `host`: the host skein — the
   * instance manager and the certifier in its address book, and recorded as
   * the host skein (host.db). `domain`: the handle's domain, recorded with
   * the row (default `localhost`). A refusal throws (a bad or taken handle, a
   * bad key, another image, a claim not `owner`'s or refused: the row is left
   * disabled, its store kept for a look).
   *
   * Image `mailbox` (#113): a mailbox instance for `owner` — the front door
   * and the messagebox, its owner in its genesis (no claim) — published at
   * once (`publish`). The same owner and handle again: the same answer (it
   * exists, enabled again if it was not, at `domain` if given); a key with
   * another mailbox here is refused. One creation path: the manager's `create` (the onboarding app's
   * registrations) and `skein-host add --mailbox` both come here.
   */
  async createInstance(handle: string, owner: string, o: { image?: string; host?: boolean; publish?: boolean; domain?: string; claim?: SignedClaim | unknown; needsClaim?: boolean } = {}): Promise<{ handle: string; identity: string; url: string }> {
    if (!HANDLE.test(handle)) throw new Error(`handle ${JSON.stringify(handle)}: lower-case letters, digits and "-", at most 63, as a hostname label`);
    if (this.reserved(handle) && !(o.host && handle === "host")) throw new Error(`handle ${handle} is reserved`);
    if (!KEY.test(owner)) throw new Error("owner: not an identity key (33 bytes)");
    if (o.image !== undefined && o.image !== "default" && o.image !== "mailbox") throw new Error(`image ${JSON.stringify(o.image)}: this host has the default image and mailbox instances`);
    if (o.domain !== undefined && !DOMAIN.test(o.domain)) throw new Error(`domain ${JSON.stringify(o.domain)}: a host name, lower case`);
    if (o.image === "mailbox") return await this.createMailbox(handle, owner, o);
    const claim = o.claim !== undefined ? claimOf(o.claim) : undefined;
    if (!claim && o.needsClaim) claimOf(undefined);
    if (claim) claimProblem(claim, owner);
    if (this.o.db.get(handle)) throw new Error(`handle ${handle} is taken`);
    const store = join(this.o.home ?? ".", "instances", handle, "runtime.db");
    if (existsSync(store)) throw new Error(`handle ${handle}: a store is at ${store} already`);
    this.o.db.add(handle, { store, status: "disabled", domain: o.domain ?? await this.handleDomain() }); // H4: never the column's `localhost` on a host with a domain
    this.unpublished.add(handle);
    try {
      await this.image.ready; // #132: born with the chain as the host holds it
      await this.bootRow(handle, await this.image.source(), { image: true, manager: o.host });
      const l = await this.hydrate(handle);
      if (claim) {
        // #127: the owner's own message, forwarded as signed; the host signs nothing for the owner.
        const entry = await this.appendLocal(handle, { kind: "message", message: claim.message, body: claim.body });
        await this.queues.get(handle);
        await l.kernel.idle();
        if (!(await this.claimedBy(l, owner))) throw new Error(`the claim ${entry} was refused (its log says why); ${handle} is left disabled`);
      }
      if (o.host) this.o.db.setSetting("host_skein", handle);
      if (o.publish !== false) { this.o.db.setStatus(handle, "enabled"); await this.refollowHeaders(handle); }
      const tip = this.image.tip();
      this.say("router", `created ${handle} (${short(l.identity)}) from the default image${tip ? ` (its chain to ${tip.height})` : ""}, ${claim ? `claimed by ${short(owner)}` : "unclaimed (its claim row from anyone)"}${o.publish !== false ? `, at ${this.originOf(handle)}` : ""}${o.host ? ": the host skein" : ""}`);
      return { handle, identity: l.identity, url: this.originOf(handle) };
    } finally {
      this.unpublished.delete(handle);
    }
  }

  /** createInstance's image `mailbox` (#113). */
  private async createMailbox(handle: string, owner: string, o: { publish?: boolean; domain?: string }): Promise<{ handle: string; identity: string; url: string }> {
    const had = this.o.db.get(handle);
    if (had) {
      if (had.kind !== "mailbox" || had.owner !== owner) throw new Error(`handle ${handle} is taken`);
      // The handle's domain is the asker's (a row registered before #113 took the request's host name).
      if (o.domain && had.domain !== o.domain) this.o.db.add(handle, { domain: o.domain });
      if (o.publish !== false && had.status !== "enabled") this.o.db.setStatus(handle, "enabled");
      const identity = had.identity ?? await rootIdentity(await this.o.walletFor(had));
      return { handle, identity, url: this.originOf(handle) };
    }
    const mine = this.o.db.list().find((r) => r.kind === "mailbox" && r.owner === owner);
    if (mine) throw new Error(`${short(owner)} has a mailbox instance here already: ${mine.handle}`);
    const store = join(this.o.home ?? ".", "instances", handle, "runtime.db");
    if (existsSync(store)) throw new Error(`handle ${handle}: a store is at ${store} already`);
    this.o.db.add(handle, { store, status: "disabled", kind: "mailbox", owner, ...(o.domain ? { domain: o.domain } : {}) });
    await this.bootRow(handle, { kind: "code" });
    const identity = this.o.db.get(handle)!.identity!;
    if (o.publish !== false) this.o.db.setStatus(handle, "enabled");
    this.say("router", `created mailbox instance ${handle}@${this.o.db.get(handle)!.domain} (${short(identity)}) for ${short(owner)}${o.publish !== false ? `, at ${this.originOf(handle)}` : ""}`);
    return { handle, identity, url: this.originOf(handle) };
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
      if (b.domain != null && typeof b.domain !== "string") throw new Error("domain: a host name (text)");
      // #127: a skein from the default image comes with its owner's signed claim (the registrant's, forwarded).
      const c = await this.createInstance(handle, owner, { image: (b.image as string | null | undefined) ?? undefined, ...(typeof b.domain === "string" ? { domain: b.domain } : {}), ...(b.claim != null ? { claim: b.claim } : {}), needsClaim: true });
      return { handle: c.handle, identity: keyBytes(c.identity), url: c.url };
    }
    if (box !== "start" && box !== "stop") throw new Error(`the instance manager takes create, start and stop: not ${box}`);
    const row = this.o.db.get(handle);
    if (!row) throw new Error(`no instance ${handle}`);
    if (row.handle === this.o.db.hostSkein()?.handle) throw new Error(`${handle} is the host skein: it is not started or stopped by a message from itself`);
    if (box === "start") {
      this.o.db.setStatus(handle, "enabled");
      await this.hydrate(handle);
      await this.refollowHeaders(handle);
      this.say("router", `${handle}: started by the instance manager`);
      return { handle, started: true, url: this.originOf(handle) };
    }
    this.o.db.setStatus(handle, "disabled");
    await this.refollowHeaders(handle);
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
    const facts = { ownerMessagebox: this.ownerMessagebox(), resolveOrigin: this.origin(), addressBook: this.addressSeed(), providers: Object.fromEntries(this.addressSeed().filter((e) => e.transport === "local").map((e) => [e.address, Buffer.from(e.key).toString("hex")])) };
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
   * The kernel counts as busy until it has processed what was just admitted
   * (its `idle` answers after the drain); then the libp2p node and the host's
   * headers feed follow the dispatch table (#72, #77, #102).
   */
  private settle(l: Loaded): void {
    const p = l.kernel.idle().then(() => this.syncDispatch(l)).then(() => this.syncBilling(l)).catch((e) => this.say(l.row.handle, `the dispatch table not followed: ${(e as Error).message}`));
    this.syncing.add(p);
    void p.finally(() => this.syncing.delete(p));
  }

  /**
   * What the host does by the instance's dispatch table (#72, #77, #102):
   * read the table (the kernel's `dispatch` frame); when its chain's tip
   * moved since it was last followed (or `first`), the host's headers feed
   * subscribes or unsubscribes it (followHeaders), and its libp2p node is
   * declared again as its genesis and the table ask (p2p.ts libp2pConfig) —
   * started, reconfigured (topics subscribed and unsubscribed, protocols
   * handled and unhandled) or stopped. A failure is logged, not fatal.
   */
  private async syncDispatch(l: Loaded, first = false): Promise<void> {
    if ((!this.p2p && !this.o.headersFeed) || l.kernel.gone) return;
    const d = await l.kernel.dispatch().catch((e) => { this.say(l.row.handle, `the dispatch table not read: ${(e as Error).message}`); return undefined; });
    if (d === undefined) return;
    const key = d.tip ? d.tip.toString() : "";
    if (!first && key === (l.dispatchTip ?? "")) return;
    l.dispatchTip = key;
    l.rows = d.rows;
    this.followHeaders(l.row.handle, d.rows);
    // #126: an uninstalled app's beacons stop — an app with no row left in the table (an uninstall
    // removes every row naming the app and leaves its heads).
    if (l.beacons.length || l.live.length) {
      const apps = new Set(d.rows.map((r) => (r as { app?: unknown }).app).filter((x): x is string => typeof x === "string"));
      l.beacons = l.beacons.filter((b) => apps.has(b.app));
      l.live = l.live.filter((x) => apps.has(x.app)); // #138: and its liveness
    }
    await this.declareP2P(l, first);
  }

  /** The instance's libp2p node declared as its genesis, its table and its apps' subscriptions (#119) ask. */
  private async declareP2P(l: Loaded, first = false): Promise<void> {
    if (!this.p2p) return;
    const rows = (l.rows ?? []) as unknown as Array<Record<string, unknown>>;
    await this.p2p.declare(l.row.handle, libp2pConfig(l.genesis, rows, subscribedTopics(l.subs), l.beacons.length > 0 || l.live.length > 0)).catch((e) => this.say(l.row.handle, `libp2p: ${first ? "not started" : "not reconfigured"}: ${(e as Error).message}`));
    this.p2p.beacons(l.row.handle, l.beacons);
    this.p2p.liveness(l.row.handle, l.live);
  }

  /** #138: the apps' liveness, folded from the instance's log (liveness.ts livenessOf), the store file read-only. */
  private async readLiveness(store: string): Promise<Live[]> {
    if (!this.p2p || !existsSync(store)) return [];
    const s = openStoreFile(store, { readOnly: true });
    try { return await livenessOf(s); } finally { s.close(); }
  }

  /** #126: the apps' beacons, folded from the instance's log (p2p.ts beaconsOf), the store file read-only. */
  private async foldBeacons(store: string): Promise<Beacon[]> {
    if (!this.p2p || !existsSync(store)) return [];
    const s = openStoreFile(store, { readOnly: true });
    try { return await beaconsOf(s); } finally { s.close(); }
  }

  /**
   * #119: the apps' subscriptions, folded from the instance's log — the
   * libp2p node's recovery at hydrate, by reading (p2p.ts subscriptionsOf;
   * the store file opened read-only beside the kernel, as `subscribes` reads it).
   */
  private async foldSubscriptions(store: string): Promise<Subscription[]> {
    if (!this.p2p || !existsSync(store)) return [];
    const s = openStoreFile(store, { readOnly: true });
    try { return await subscriptionsOf(s); } finally { s.close(); }
  }

  /**
   * A `subscribe` / `unsubscribe` event from `handle` (#119, after its step's
   * commit; the kernel checked it as it was emitted): the subscriptions
   * change and the node is declared again — the topic subscribed, or left
   * when no subscription, row or genesis topic takes it any more. Which app's
   * program runs for a message on it is the kernel's (the subscription). An
   * instance still loading reads the event from its log at hydrate; it is
   * applied after that too (the same result).
   */
  private topicEvent(handle: string, rec: Record<string, unknown>): void {
    if (rec.event === "beacon" || rec.event === "unbeacon") return this.beaconEvent(handle, rec);
    if (rec.event === "liveness" || rec.event === "unliveness") return this.livenessEvent(handle, rec);
    const e = subscriptionEvent(rec);
    if ("refused" in e) { this.say(handle, `libp2p: ${String(rec.event)}: ${e.refused}`); return; }
    const topic = e.event === "subscribe" ? e.sub.topic : e.topic;
    const app = e.event === "subscribe" ? e.sub.app : e.app;
    const apply = async () => {
      const l = this.loaded.get(handle) ?? await this.loading.get(handle)?.catch(() => undefined);
      if (!l || l.kernel.gone) return;
      foldSubscriptions([e], l.subs);
      this.say(handle, `libp2p: ${e.event} ${topic} (app ${app}${e.event === "subscribe" ? ` → ${e.sub.program}.${e.sub.fn}` : ""})`);
      await this.declareP2P(l);
    };
    const p = apply().catch((x) => this.say(handle, `libp2p: ${e.event} ${topic}: ${(x as Error).message}`));
    this.syncing.add(p);
    void p.finally(() => this.syncing.delete(p));
  }

  /**
   * A `liveness` / `unliveness` event from `handle` (#138, after its step's commit; the kernel
   * checked its shape as it was emitted): the liveness changes and the node's liveness tool follows
   * it (P2PHost.liveness) — the topic subscribed without admitting its messages, or left. An instance
   * still loading reads it from its log.
   */
  private livenessEvent(handle: string, rec: Record<string, unknown>): void {
    const e = livenessEvent(rec);
    if ("refused" in e) { this.say(handle, `libp2p: ${String(rec.event)}: ${e.refused}`); return; }
    const apply = async () => {
      const l = this.loaded.get(handle) ?? await this.loading.get(handle)?.catch(() => undefined);
      if (!l || l.kernel.gone) return;
      foldLiveness([e], l.live);
      await this.declareP2P(l);
    };
    const p = apply().catch((x) => this.say(handle, `libp2p: ${e.event}: ${(x as Error).message}`));
    this.syncing.add(p);
    void p.finally(() => this.syncing.delete(p));
  }

  /**
   * GET /<app>/.live/<topic> at an instance's origin (#138): the liveness tool's set for the app's
   * liveness on the topic, served by the host — no program, no entry, nothing logged; metered as a
   * read (bytes served). 404 when the app keeps no liveness for the topic (or the host has no libp2p).
   */
  private async liveRead(handle: string, route: string, app: string, topic: string): Promise<RouterResponse> {
    const none = () => json(404, { status: "error", code: "ERR_NOT_FOUND", description: `app ${app} keeps no liveness for ${topic}` });
    if (!this.p2p) return none();
    try { await this.hydrate(handle); } catch (e) { return json(503, { status: "error", code: "ERR_UNAVAILABLE", description: (e as Error).message }); }
    const closed = this.closed(handle);
    if (closed) return json(402, { status: "error", code: "ERR_PAYMENT_REQUIRED", description: closed });
    const beats = this.p2p.live.read(handle, app, topic);
    if (!beats) return none();
    const r = json(200, beats.map((b) => ({ sender: b.sender, at: b.at, body: Buffer.from(b.body).toString("base64"), from: b.from })));
    this.meter(handle, { at: stampMs(this.now()), op: `GET ${route}`, fuel: 0, bytes: r.body.length });
    return r;
  }

  /**
   * A `beacon` / `unbeacon` event from `handle` (#126, after its step's commit;
   * the kernel checked its shape as it was emitted): the beacons change and
   * the node beats them (P2PHost.beacons) — started if a beacon needs it; the
   * topic is not subscribed. An instance still loading reads it from its log.
   */
  private beaconEvent(handle: string, rec: Record<string, unknown>): void {
    const e = beaconEvent(rec);
    if ("refused" in e) { this.say(handle, `libp2p: ${String(rec.event)}: ${e.refused}`); return; }
    const apply = async () => {
      const l = this.loaded.get(handle) ?? await this.loading.get(handle)?.catch(() => undefined);
      if (!l || l.kernel.gone) return;
      foldBeacons([e], l.beacons);
      await this.declareP2P(l);
    };
    const p = apply().catch((x) => this.say(handle, `libp2p: ${e.event}: ${(x as Error).message}`));
    this.syncing.add(p);
    void p.finally(() => this.syncing.delete(p));
  }

  /**
   * The host's headers feed (#102) for an instance whose dispatch table is
   * `rows`: subscribed (box `chain`) while it is enabled and a row takes
   * events in box `chain` by name (the chain app's `event` row; dispatch.zig
   * forEvent) — a catch-all `*` row (a mailbox instance's) is not one —
   * else not. One line when that changes.
   */
  private followHeaders(handle: string, rows: DispatchRow[]): void {
    const url = this.o.headersFeed;
    if (!url) return;
    const want = this.o.db.get(handle)?.status === "enabled" && rows.some((r) => r.address === DEFAULT_BOX && takesEvent(r, DEFAULT_BOX));
    if (want === this.feeds.hosts(handle)) return;
    this.feeds.host(handle, want ? { kind: "headers", url, box: DEFAULT_BOX } : undefined);
    this.say("router", `${handle}: ${want ? "subscribed to" : "unsubscribed from"} the host's headers feed ${url}`);
  }

  /** Follow the host's headers feed for an instance whose status changed (#102): its table read again. */
  private async refollowHeaders(handle: string): Promise<void> {
    if (!this.o.headersFeed) return;
    const l = this.loaded.get(handle);
    const d = l && !l.kernel.gone ? await l.kernel.dispatch().catch((e) => { this.say(handle, `the dispatch table not read: ${(e as Error).message}`); return undefined; }) : undefined;
    this.followHeaders(handle, d?.rows ?? []);
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

  // ---------------------------------------------------------------- billing (#130, billing.ts)

  /** Why this host forwards nothing to `handle` but a payment (undefined: it forwards as usual). */
  closed(handle: string): string | undefined {
    return closedBy(this.views.get(handle), `${this.origin()}${FUND_PREFIX}${handle}`);
  }

  /** A billed instance as this host last read it (#130). */
  billingView(handle: string): BillingView | undefined { return this.views.get(handle); }

  /** A line of this host's log for `handle`'s period (#130): a request it served, a read call it made. */
  private meter(handle: string, line: { at: number; op: string; caller?: string; fuel: number; bytes: number }): void {
    if (!this.o.billing || !this.views.get(handle)?.terms) return;
    let p = this.periods.get(handle);
    if (!p) this.periods.set(handle, (p = new Period(line.at)));
    p.add(line);
  }

  /**
   * Read the instance's billing (#130): its host row's terms (the dispatch table) and its kernel's
   * billing state (the head `billing`), checked against what this host supports. A skein with a host
   * row this host has not ticked yet is ticked now; one whose unreported amounts would take its tally
   * to its allocation, early. When it went asleep (and woke) goes to host.db (the grace).
   */
  private async syncBilling(l: Loaded): Promise<void> {
    const cfg = this.o.billing;
    if (!cfg || l.kernel.gone) return;
    const handle = l.row.handle;
    // The table as syncDispatch just read it (it follows the table when the host has libp2p or a headers feed), else read now.
    const rows = (this.p2p || this.o.headersFeed) && l.rows ? l.rows : (await l.kernel.dispatch()).rows;
    const terms = termsOf(rows);
    if (!terms) {
      if (this.views.has(handle)) { this.views.delete(handle); this.o.db.forgetBilling(handle); this.say(handle, "billing: no host row: not billed"); }
      return;
    }
    const root = await l.kernel.call("head", BILLING_HEAD) as CID | null;
    const state = root ? stateOf(await l.kernel.store.get(root)) : undefined;
    const why = mismatch(cfg, this.providers.key("billing"), terms);
    const was = this.views.get(handle);
    const view: BillingView = { terms, ...(state ? { state } : {}), ...(why ? { mismatch: why } : {}) };
    this.views.set(handle, view);
    const mine = state && state.host === terms.host ? state : undefined;
    this.o.db.setBilling(handle, { host: terms.host, ...(mine ? { tally: mine.tally, allocation: allocation(mine) } : {}), asleep: !!mine?.asleep, ...(why ? { mismatch: why } : {}) }, stampMs(this.now()));
    const fundAt = `${this.origin()}${FUND_PREFIX}${handle}`;
    const closed = closedBy(view, fundAt);
    if (closed !== closedBy(was, fundAt)) this.say(handle, closed ? `billing: closed — ${closed}` : "billing: open");
    if (why || mine?.asleep) return;
    if (mine) this.firstTicks.delete(handle);
    else if (this.firstTicks.has(handle)) return; // sent: the timer sends it again
    else this.firstTicks.add(handle);
    const p = this.periods.get(handle);
    const owed = p ? priceHost(terms.rates, p.fuel, p.served) : 0n;
    if (!mine || (p && !p.empty && mine.tally + owed >= allocation(mine))) void this.billingTick(handle).catch((e) => this.say(handle, `billing: tick: ${(e as Error).message}`));
  }

  /** Tick every billed instance this router holds (the timer, every tickMs). */
  private async tickAll(): Promise<void> {
    for (const [handle, l] of this.loaded) {
      if (l.kernel.gone || !this.views.get(handle)?.terms) continue;
      await this.billingTick(handle).catch((e) => this.say(handle, `billing: tick: ${(e as Error).message}`));
    }
  }

  /**
   * The host's tick to `handle` (#130 decided 4): signed by its billing key, in the host row's box —
   * {kind: "tick", at, allowance, fuel, served, log} — the period since its last tick closed, its log
   * record kept (host.db billing_ticks: `log` is that record's CID). Not to an instance the gate
   * holds (asleep, other terms), nor twice at once. The tick's entry, or undefined.
   */
  async billingTick(handle: string): Promise<CID | undefined> {
    const cfg = this.o.billing;
    const v = this.views.get(handle);
    if (!cfg || !v?.terms || this.closed(handle) || this.ticking.has(handle)) return undefined;
    const l = this.loaded.get(handle);
    if (!l || l.kernel.gone) return undefined;
    this.ticking.add(handle);
    try {
      const at = stampMs(this.now());
      const p = this.periods.get(handle) ?? new Period(at);
      this.periods.set(handle, new Period(at));
      const log = periodRecord(l.identity, p, at);
      this.o.db.billingTick(handle, at, log.cid.toString(), log.bytes);
      return await this.providers.send(handle, "billing", keyBytes(l.identity), v.terms.address, tickBody(at, cfg, p, log.cid)) as CID;
    } finally {
      this.ticking.delete(handle);
    }
  }

  /**
   * A `payment` event from `handle` (#130 decided 6: its pay step's, the kernel lets no other step
   * emit one): this host is the payee. Its wiring: the payment kept (host.db billing_payments, with
   * whether its output pays the key the BRC-29 remittance derives from this host's billing key) and
   * broadcast (its Arcade, once).
   */
  private payment(handle: string, rec: Record<string, unknown>): void {
    const p = (async () => {
      const beef = rec.tx instanceof Uint8Array ? rec.tx : undefined;
      const amount = typeof rec.amount === "number" ? rec.amount : undefined;
      const vout = typeof rec.outputIndex === "number" ? rec.outputIndex : undefined;
      const rem = rec.remittance as { derivationPrefix?: string; derivationSuffix?: string; senderIdentityKey?: string } | undefined;
      if (!beef || amount === undefined || vout === undefined || !rem) { this.say(handle, "billing: a payment event without its transaction, amount or remittance: ignored"); return; }
      const tx = Transaction.fromAtomicBEEF([...beef]);
      let ours = false;
      try {
        const key = new KeyDeriver(this.providerKey("billing")).derivePrivateKey([2, "3241645161d8"], `${rem.derivationPrefix} ${rem.derivationSuffix}`, String(rem.senderIdentityKey));
        const out = tx.outputs[vout];
        ours = !!out && out.satoshis === amount && out.lockingScript.toHex() === new P2PKH().lock(key.toPublicKey().toHash()).toHex();
      } catch { /* a remittance that derives nothing: kept, not ours */ }
      const checkpoint = CID.asCID(rec.checkpoint)?.toString();
      const txid = tx.id("hex");
      const fresh = this.o.db.billingPayment({ instance: handle, txid, amount, at: stampMs(this.now()), beef, remittance: rem, ours, ...(checkpoint ? { checkpoint } : {}) });
      if (fresh && this.arc) this.arc.enqueue(handle, Uint8Array.from(tx.toBinary()), beef);
      this.say(handle, `billing: payment ${txid.slice(0, 8)}… ${amount} sats${ours ? "" : " (its output does not pay this host's derived key)"}${checkpoint ? `, checkpoint ${checkpoint.slice(-8)}` : ""}`);
    })().catch((e) => this.say(handle, `billing: payment: ${(e as Error).message}`));
    this.syncing.add(p);
    void p.finally(() => this.syncing.delete(p));
  }

  /**
   * A payment for `handle` delivered to this host (#130 decided 7: POST /fund/<handle>): handed in
   * on the instance's funding row (FUND_ROUTE: a message route, sender `session` — #135: the host
   * sends it over a BRC-104 session of its own, signed with its billing key, the outputs and the
   * description in the signed x-bsv-skein-* headers; the door's `beef` filter validates it, the
   * wallet internalizes it) — past the gate, which lets nothing else through while it is asleep —
   * and the instance's answer returned.
   */
  private async fund(handle: string, req: RouterRequest): Promise<RouterResponse> {
    const row = this.o.db.get(handle);
    if (!HANDLE.test(handle) || row?.status !== "enabled") return json(404, { status: "error", code: "ERR_NOT_FOUND", description: `no instance ${handle} here` });
    const outputs = req.headers[OUTPUTS_HEADER];
    if (!outputs) return json(400, { status: "error", code: "ERR_FUNDING", description: `${OUTPUTS_HEADER}: the payment's outputs, BRC-100 internalizeAction's (JSON), with the Atomic BEEF as the body` });
    let l: Loaded;
    try { l = await this.hydrate(handle); } catch (e) { return json(503, { status: "error", code: "ERR_UNAVAILABLE", description: (e as Error).message }); }
    const headers: Record<string, string> = { "content-type": "application/octet-stream", [SIGNED_OUTPUTS_HEADER]: outputs, ...(req.headers[DESCRIPTION_HEADER] ? { [SIGNED_DESCRIPTION_HEADER]: req.headers[DESCRIPTION_HEADER] } : {}) };
    // #135: a message — signed. A session of the host's own (its billing key) with the instance's front door, in process: each request to it straight to the door.
    const door = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const r = input instanceof Request ? input : new Request(input, init);
      const url = new URL(r.url);
      const a = await frontDoor(l.kernel, { method: r.method, path: url.pathname, route: url.pathname, query: url.search, headers: headerMap(r.headers), body: new Uint8Array(await r.arrayBuffer()) }, { now: this.now(), waitMs: this.o.answerWaitMs, stop: this.stopping });
      return new Response(a.body.length ? Buffer.from(a.body) : null, { status: a.status, headers: a.headers });
    }) as typeof fetch;
    const af = new AuthFetch(ephemeralWallet(this.providerKey("billing")), undefined, undefined, undefined, {}, door);
    let r: Response;
    try {
      r = await af.fetch(`http://${handle}.fund.invalid${FUND_ROUTE}`, { method: "POST", headers, body: Buffer.from(req.body) });
    } catch (e) {
      this.settle(l);
      this.say(handle, `billing: a payment not handed in: ${(e as Error).message}`);
      return json(502, { status: "error", code: "ERR_FUNDING", description: `the instance's answer did not verify: ${(e as Error).message}` });
    }
    this.settle(l);
    this.say(handle, `billing: a payment handed in: ${r.status}`);
    const out: Record<string, string> = {};
    r.headers.forEach((v, k) => { if (!k.startsWith("x-bsv-auth-")) out[k] = v; });
    return { status: r.status, headers: out, body: new Uint8Array(await r.arrayBuffer()) };
  }

  /**
   * Reclaim an instance (#130 decided 9; `skein-host reclaim`): its kernel stopped, its row and its
   * billing removed, its store deleted. The host's call to make, after the grace; nothing here makes
   * it on its own. Not the host skein.
   */
  async reclaim(handle: string): Promise<void> {
    const row = this.o.db.get(handle);
    if (!row) throw new Error(`no instance ${handle}`);
    if (row.handle === this.o.db.hostSkein()?.handle) throw new Error(`${handle} is the host skein`);
    this.o.db.setStatus(handle, "disabled");
    await this.refollowHeaders(handle);
    const l = this.loaded.get(handle);
    if (l) { this.loaded.delete(handle); await l.kernel.stop(); }
    await this.p2p?.declare(handle, undefined).catch(() => {});
    this.cron.forget(handle);
    this.views.delete(handle);
    this.periods.delete(handle);
    this.o.db.forgetBilling(handle);
    this.o.db.remove(handle);
    await removeStore(row.store);
    this.say("router", `${handle}: reclaimed (its store ${row.store} deleted)`);
  }

  // ---------------------------------------------------------------- HTTP

  /** Whether a URL is this host's own (answered in process: no DNS, no socket). */
  isLocal(url: string): boolean {
    let u: URL;
    try { u = new URL(url); } catch { return false; } // a URL that does not parse is not this host's (the caller's fetch reports it)
    if (!this.port) return false;
    const mine = (o: string) => { try { return new URL(o).host === u.host; } catch { return false; } }; // an origin setting that is no URL matches nothing
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
    if (label && label !== this.ownLabel() && enabled(label)) return { handle: label, route: url.pathname };
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
    if (req.method === "GET" && url.pathname === "/.well-known/skein-host") {
      // #130: the terms this host bills by — what an owner grants as the host row (`skein plan host`).
      const b = this.o.billing;
      const billing = b ? { key: this.providers.key("billing"), x: b.x, rates: b.rates, allowance: b.allowance, tickMs: b.tickMs, graceMs: b.graceMs, fund: `${this.origin()}${FUND_PREFIX}{handle}` } : undefined;
      return json(200, { origin: this.origin(), domain: await this.handleDomain(), ...(billing ? { billing } : {}) });
    }
    const t = this.target(url);
    if (t) {
      // #138: the liveness tool's read, the host's own (no program).
      const live = req.method === "GET" ? /^\/([^/]+)\/\.live\/([^/]+)$/.exec(t.route) : null;
      if (live) return await this.held(this.liveRead(t.handle, t.route, decodeURIComponent(live[1]!), decodeURIComponent(live[2]!)));
      return await this.held(this.forward(t.handle, t.route, url, req));
    }
    const path = url.pathname;
    // #113: the host's own origin's BRC-169 requests are the host skein's (its onboarding app's routes).
    const route = DISCOVERY[`${req.method} ${path}`] ?? (req.method === "GET" && path.startsWith(PAYMAIL_PREFIX) ? `/${ONBOARD_APP}${path}` : undefined);
    if (route) {
      const host = this.o.db.hostSkein();
      if (host?.status === "enabled") return await this.held(this.forward(host.handle, route, url, req));
      const f = await this.o.discovery?.(req, url);
      if (f) return f;
      return json(404, { status: "error", code: "ERR_NOT_FOUND", description: "this host has no host skein (skein-host init): no BRC-169 here" });
    }
    if (path === `${ARC_ROUTE}/callback`) return await this.arcRequest(req, path);
    if (req.method === "POST" && path.startsWith(FUND_PREFIX)) return await this.held(this.fund(decodeURIComponent(path.slice(FUND_PREFIX.length)), req));
    return json(404, { status: "error", code: "ERR_NOT_FOUND", description: "no instance here: an instance is at http://<handle>.localhost:<port>/ or /@<handle>/" });
  }

  /** A forwarded request, held among the in-flight ones (shutdown answers them 503). */
  private async held(p: Promise<RouterResponse>): Promise<RouterResponse> {
    this.inflight.add(p);
    try { return await p; } finally { this.inflight.delete(p); }
  }

  /**
   * The handle domain (#113): the host skein's onboarding app's
   * `config.onboard.domain` (the app record, a kernel read), the one setting
   * every handle here is at. With no host skein or no app: this router's
   * origin's host name as a domain.
   */
  async handleDomain(): Promise<string> {
    const fallback = this.domain();
    const host = this.o.db.hostSkein();
    if (host?.status !== "enabled") return fallback;
    try {
      const l = await this.hydrate(host.handle);
      const root = await l.kernel.call("head", `${ONBOARD_APP}/app`) as CID | null;
      if (!root) return fallback;
      const rec = await l.kernel.store.get(root) as { config?: Record<string, { domain?: unknown } | undefined> };
      const d = rec.config?.[ONBOARD_APP]?.domain;
      return typeof d === "string" && d ? d.toLowerCase() : "localhost";
    } catch (e) {
      this.say("router", `the handle domain: not read from ${host.handle}: ${(e as Error).message}`);
      return fallback;
    }
  }

  /** Arcade's webhook (#58, arc.ts); 404 when the host has no Arcade. */
  private async arcRequest(req: RouterRequest, path: string): Promise<RouterResponse> {
    if (!this.arc) return json(404, { status: "error", code: "ERR_NOT_FOUND", description: "this host has no Arcade" });
    if (req.method === "POST") return await this.arc.callback(req.headers, req.body);
    return json(404, { status: "error", code: "ERR_NOT_FOUND", description: `no ${req.method} ${path}` });
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
    // #130: asleep, or terms this host does not serve: nothing is forwarded (a payment comes in at /fund/<handle>).
    const closed = this.closed(handle);
    if (closed) return json(402, { status: "error", code: "ERR_PAYMENT_REQUIRED", description: closed });
    // #135: two doors — a read by a call, a signed request through the door (serveHttp).
    const a: FrontAnswer = await serveHttp(l.kernel, { method: req.method, path: url.pathname, route, query: url.search, headers: req.headers, body: req.body }, { now: this.now(), waitMs: this.o.answerWaitMs, stop: this.stopping });
    this.settle(l);
    // Charged to the identity the front door verified (H13), never to a header as the client sent it.
    if (a.fuel !== undefined) this.charge(handle, a.caller ?? "", `${route} (read)`, a.fuel);
    // #130: what never reaches the log — the read call's fuel, the bytes served — for its next tick.
    this.meter(handle, { at: stampMs(this.now()), op: `${req.method} ${route}`, ...(a.caller ? { caller: a.caller } : {}), fuel: a.fuel ?? 0, bytes: a.body.length });
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

/**
 * The owner's signed claim (#127): a message in box `claim`, signed by the
 * owner (BRC-169's signing, counterparty anyone) and naming no recipient — it
 * was signed before the instance it claims existed — with its body (dag-cbor
 * bytes). The host forwards it as it is (Router.createInstance).
 */
export interface SignedClaim { message: Omit<MailRecord, "recipient"> & { recipient?: undefined }; body: Uint8Array }

/** A create's `claim` ({message, body}), checked for its shape (throws; undefined: missing). */
function claimOf(v: unknown): SignedClaim {
  const c = v as { message?: unknown; body?: unknown } | null | undefined;
  if (!c || typeof c !== "object" || !c.message || typeof c.message !== "object" || !(c.body instanceof Uint8Array)) {
    throw new Error("claim: the owner's signed claim {message, body} (#127: a message in box claim, signed by the owner, naming no recipient)");
  }
  return { message: c.message as SignedClaim["message"], body: c.body };
}

/** Why a claim cannot be forwarded for `owner` (throws): not a claim, another sender, a recipient named. The signature is the front door's to check. */
function claimProblem(c: SignedClaim, owner: string): void {
  const m = c.message;
  if (m.kind !== "mail" || m.op !== "put" || m.box !== "claim") throw new Error("claim: not a message in box claim");
  if (!(m.sender instanceof Uint8Array) || Buffer.from(m.sender).toString("hex") !== owner) throw new Error("claim: its sender is not the owner");
  if (m.recipient !== undefined) throw new Error("claim: it names a recipient (a claim is signed before the instance exists: it names none)");
  if (!(m.signature instanceof Uint8Array)) throw new Error("claim: not signed");
}

/** #130: a package that is the instance's own message to itself (the loopback: unsigned, sender and recipient its identity). */
function isLoopback(pkg: Record<string, unknown>, identity: string): boolean {
  const m = pkg.message as { sender?: unknown; recipient?: unknown; signature?: unknown } | undefined;
  const hex = (k: unknown) => k instanceof Uint8Array ? Buffer.from(k).toString("hex") : "";
  return !!m && m.signature === undefined && hex(m.sender) === identity && hex(m.recipient) === identity;
}

/** #130: a reclaimed instance's store: the file, its -wal and -shm, and its directory when that empties. */
async function removeStore(store: string): Promise<void> {
  const fs = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  for (const f of [store, `${store}-wal`, `${store}-shm`]) await fs.rm(f, { force: true });
  await fs.rmdir(dirname(store)).catch(() => {}); // not empty, or not its own: left
}

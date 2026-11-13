// The host (skein next, SPEC.md sections 1, 2, 4 and 8): a reverse proxy in front of its instances,
// each at an origin of its own. The router picks the instance a request is for (its hostname, a
// leading `/@<handle>`, the root instance at a hostname that is no instance's), decides whether the
// arrival belongs there (the host's own concerns: routing, limits), and hands the instance ONE
// request record — CHECK then COMMIT on the instance's worker (door.ts). The kernel never names the
// carrier.
//
//   http://<handle>.localhost:<port>/…   an instance's origin (the Host header; SKEIN_INSTANCE_ORIGIN:
//                                         another template). The stock AuthFetch keeps one session per
//                                         origin and shakes hands at <origin>/.well-known/auth
//   http://<host>:<port>/@<handle>/…      the same instance (a dev form): the request's path is handed
//                                         over exactly as sent — the kernel strips `/@<its handle>`
//   POST /.well-known/auth                at an instance's origin: the BRC-103 handshake, answered by the
//                                         host for the instance (brc104.ts): the stock self-checking
//                                         nonce under the instance's key, the session in host memory
//                                         only (1024 per instance, the oldest evicted), nothing logged
//   a request with x-bsv-auth-* headers   the BRC-104 signature gathered into the record's `signature`
//                                         (scheme brc104); on a session the host no longer holds: 401
//                                         before the kernel is asked (the stock client shakes hands
//                                         again); the answer signed on the session by the host
//   any other request                     no `signature`: a content-proven row takes it (a check proves
//                                         it), or the kernel refuses it
//   GET  /skeins?key=<hex>                at the host's own origin: the skeins here whose head `grants`
//                                         names the key among root's holders, [{handle, identity, url}]
//   GET  /.well-known/skein               at an instance's origin: {handle, identity, origin, claimed}
//   GET  /.well-known/skein-host          at every host name: {origin, domain}
//   GET  /<app>/.live/<topic>             at an instance's origin (#138): the liveness tool's beats
//   GET  /events/<name path>              at an instance's origin (events.ts): the instance's event
//                                         index, read from the store (JSON, or an SSE stream)
//   POST /arc/callback                    Arcade's webhook (Bearer: the host token)
//
// The request is answered when its handler answers: a handler that awaits holds the client's
// connection until the kernel's `answered` notice (the connection is the only timer). A read row is
// CHECK only. The host's own requests (the install's, root's commands, the status service's
// rejection) are `signed` requests (src/client/raw.ts signRequest) through the same path
// (messageLocal); a BEEF the host fetched (sync) goes to the overlay's sync row as plain BEEF
// (submitBeef). The host's own facts (the chain pointer, a proof, a deploy BEEF) are events
// (admitEvent: CHECK then COMMIT of {event, name}).
//
// What an instance's steps hand over (the kernel's `emit` notices, providers.ts Emits): broadcasts to
// the broadcaster (arc.ts), topic membership to the libp2p node (p2p.ts: one node per key; gossip is
// the host's, nothing of it handed to the kernel), every fact to the event streams and the host's
// followers: the holder map (`chain/tx/<txid>`), the gossip `admit` (the overlay's admitted fact).
// A direct libp2p stream carries a request on ONE protocol, /skein/request/1.0.0: a frame is the
// dag-cbor request record, the answer frame the handler's answer (p2pInbound: the same CHECK/COMMIT
// path as HTTP).
//
// The host's headers (SPEC 8): ONE intake (`takeHeaders`) — the Teranode tracker and SKEIN_HEADERS_URL
// feed it — validates and updates the host chain once, then every loaded instance whose table takes
// the event `chain` gets the pointer event {kind: "chain", root, height}; an instance is sent the first
// one inside its load, before it is handed to anyone.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Server as NetServer } from "node:net";
import { join } from "node:path";
import { KeyDeriver, PrivateKey, ProtoWallet, Transaction, type WalletInterface } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { rootIdentity } from "../runtime/identity.ts";
import { short, stampMs } from "../runtime/log.ts";
import type { Stamp } from "../runtime/syscalls.ts";
import { ARC_ROUTE, Broadcaster, type ArcConfig } from "./arc.ts";
import { DEFAULT_BOX, txCid } from "./feeds.ts";
import { hashOf, TeranodeTracker } from "./teranode.ts";
import { HttpHeaders } from "./headers-source.ts";
import { rowApp, takesEvent, type DispatchRow } from "../runtime/dispatch.ts";
import { parseRocksSpec, parseSqliteSpec, storeSpec } from "../runtime/index-store.ts";
import { WasmHost } from "./wasm-kernel.ts";
import { openStoreFile, storeExists } from "./stores.ts";
import { rootOf } from "./install.ts";
import { realpathSync, statSync } from "node:fs";
import { now as clockNow } from "./clock.ts";
import { bootStore, imageSource, isOverlayImage, namedImageSource, type BootSource, type Booted } from "./boot.ts";
import { admitBody, admitOf, chainHeader, chainHolds, OverlaySync } from "./sync.ts";
import { Answers, carry, headerMap, httpOf, requestRecord, unavailable, type Outcome, type Payload } from "./door.ts";
import { DoorAnswered } from "./door-answer.ts";
import { handshake, HANDSHAKE_PATH, Sessions, sessionGone, signReply, type HttpAnswer } from "./brc104.ts";
import { keyBytes, keyHex, type GenesisConfig } from "./genesis.ts";
import { HANDLE, pathOnly, TOKEN_HANDLE, topicsOf, validHandle, type HostDb, type InstanceRow } from "./instances.ts";
import { CLAIM_PATH, MESSAGE_KEY_ID, MESSAGE_PROTOCOL, signClaim, signRequest, type RequestPayload } from "../client/raw.ts";
import { KernelHost, type Answer, type Answered, type HostChainTip, type KernelSurface, type RequestRecord } from "./kernel.ts";
import { foldLiveness, LIVENESS_MAX_MS, livenessEvent, livenessOf, type Live } from "./liveness.ts";
import { EventStreams, eventsPath, eventsQuery, sseMessage, type Delivered, type EventStore } from "./events.ts";
import { beaconEvent, beaconsOf, LOOPBACK_LISTEN, foldBeacons, foldSubscriptions, libp2pConfig, P2PHost, REQUEST_PROTOCOL, subscribedTopics, subscriptionEvent, subscriptionsOf, type Beacon, type InboundAnswer, type InboundCall, type P2PHostConfig, type Subscription } from "./p2p.ts";
import { peerIdFromMultihash } from "@libp2p/peer-id";
import { Emits, type Outgoing, type ServiceName } from "./providers.ts";
import { closeControl, listenControl } from "./control.ts";
import * as Digest from "multiformats/hashes/digest";

export interface RouterOptions {
  db: HostDb;
  /** Each row's signer: the wallet its kernel's `wallet` import is answered from. */
  walletFor(row: InstanceRow): Promise<WalletInterface> | WalletInterface;
  fuelPerStep?: string;
  /** A new genesis's defaults: what a tree's config leaves unset (genesis.ts mergeDefaults). */
  genesis?: { defaults?: Record<string, string> };
  /** The broadcaster's subscription's reconnect backoff (feeds.ts SseStream). */
  feeds?: { backoff?: { min: number; max: number } };
  /**
   * #156: the host's headers tracker over the Teranode P2P network (teranode.ts): its bootstrap
   * peers (the network's, SKEIN_TERANODE_BOOTSTRAP), its first-sync hub (the network's default,
   * SKEIN_HEADERS_HUB), its key file ($SKEIN_HOME/teranode.key): the source of the one header intake
   * (skein next, SPEC 8). Absent (SKEIN_TERANODE=off, or a network with neither): no tracker.
   */
  /**
   * SKEIN_HEADERS_URL (skein next, SPEC 8: "Headers are headers"): an SSE stream of block headers feeding the one
   * intake, with its history endpoint, when it has one, for a fill at start (headers-source.ts). Beside the
   * tracker or alone.
   */
  headersUrl?: string;
  teranode?: { bootstrap: string[]; hub?: string; peersFile?: string; page?: number; bulkPage?: number; maxCrawl?: number; discoveryMs?: number };
  /** The host's Arcade (#58, #65, arc.ts): where the broadcast events go, the status subscription, the `status` provider. Absent: no broadcaster (a broadcast event is dropped). */
  arc?: ArcConfig;
  /** Tests: how the broadcaster reaches Arcade. */
  arcFetch?: typeof fetch;
  /** The broadcaster's queue: how soon a broadcast Arcade did not take is posted again (ms, doubling; default 1 000 → 300 000). */
  arcRetry?: { min: number; max: number };
  /** Stop a kernel this long after its last call (ms); 0: never (the default: instances are not stopped until resource contention appears). */
  idleMs?: number;
  /** Where a new instance's store goes: <home>/instances/<handle>/runtime.db. */
  home?: string;
  /**
   * SKEIN_STORE_ROCKSDB (#158): the host's RocksDB database (a directory), run by one
   * `skein-kernel host` process this router starts (KernelHost): a new instance's store is its set
   * there (host.db `rocksdb:<dir>`, the set its handle).
   */
  rocksStore?: string;
  /**
   * SKEIN_STORE_SQLITE (the settled split, 2026-10-31): the host's one SQLite database (a file); a
   * new instance's store is then its set there (host.db `sqlite:<path>`, the set its handle), run by
   * the wasm kernel this process loads (wasm-kernel.ts). Over `rocksStore`.
   */
  sqliteStore?: string;
  /** An instance's origin, `{handle}` and `{port}` filled in; default http://{handle}.localhost:{port}. */
  instanceOrigin?: string;
  /** This host's own origin; default http://127.0.0.1:{port}. */
  origin?: string;
  /** The port it serves on, for origins named before it listens (a boot, `skein-host add`); listening sets it. */
  port?: number;
  /** The network the whole host runs on (SKEIN_NETWORK): every genesis it makes has it as `defaults.walletNetwork`. */
  network?: string;
  /** How often the fuel ledger is written (ms); default 5000. */
  ledgerMs?: number;
  /** Tests: the clock entries are stamped with. */
  now?: () => Stamp;
  /** Lines, by source: an instance's handle, or "router". */
  log?(source: string, line: string): void;
  /** Kernel process settings. */
  kernel?: { command?: string; env?: Record<string, string | undefined> };
  /** The libp2p host (#51, p2p.ts): its host-wide settings (default: loopback TCP + WS, no DHT, no mDNS). */
  libp2p?: P2PHostConfig;
  /** An instance's libp2p peer key (signer.ts peerKey). Absent: no libp2p host; the kernels' `libp2p` is refused. */
  peerKeyFor?(handle: string): PrivateKey;
  /**
   * #156: the host node's peer key (P2PHost.hostNode: the Teranode tracker rides it; on a one-key
   * host every instance's peer key, so they share it). Absent: a fresh key per start.
   */
  hostPeerKey?: PrivateKey;
  /**
   * A host service's key (SPEC 8: each service signs with its OWN key; none is root): signer.ts
   * providerKey — `status`, the status service, whose rejections go to the chain app's rejected row
   * under the role `chain.status` (granted in each genesis this host writes). Absent: a key of this
   * router's own, made fresh (a test's; a restarted router would hold another).
   */
  providerKeyFor?(name: ServiceName): PrivateKey;
  /** How often the libp2p host redials bootstrap peers and runs topic rendezvous (ms); default 30 000. */
  libp2pDiscoveryMs?: number;
  /**
   * #160, #162: a one-key host's shared key's wallet (signer.ts Signer.oneKey). With it, an instance the
   * host creates (createInstance, `needsClaim`) with no claim given is claimed by the host itself: the
   * claim request signed by this key (its owner), handed in as any claim is.
   */
  claimer?: WalletInterface;
  /** SKEIN_ROOT_INSTANCE: the instance served at `/` of any hostname that is no instance's (the standalone's one app at localhost:<port>/). */
  rootInstance?: string;
  /** #162, SKEIN_IMAGES_DIR (default $SKEIN_HOME/images): the images a create names by name, a directory each (the layout `skein-host add --image <dir>` takes). */
  imagesDir?: string;
  /**
   * An application host's requests (shruggr/open-exchange 0.11.0, the public read API; every method
   * since 0.3.2, so the hook checks `req.method` itself): a request for an
   * instance (its hostname, `/@<handle>/`, or the root instance's hostname; and a bare-host POST
   * /submit or /lookup routed by its topic to an instance, before it is forwarded), asked AFTER the host's own
   * reads there (the instance card, `/<app>/.live/<topic>`) and BEFORE the request is forwarded to the
   * instance's program. `route` is the path at the instance (`/amm/pools`); `undefined`: not the host's,
   * forwarded as before. An answer with `stream` is held open (RouterResponse). What the host needs
   * for its reads is the Router's public surface: `dispatch` (in-process reads of the instances),
   * `p2p.live.live(handle, topic)` (the beats kept), `events.subscribe(handle, query, send, close)` (an
   * instance's emitted events), `o.db.list("enabled")` (the instances). Absent: nothing is asked.
   */
  appRead?(handle: string, route: string, url: URL, req: RouterRequest): Promise<RouterResponse | undefined>;
}

interface Loaded {
  row: InstanceRow; kernel: KernelSurface; identity: string; wallet: WalletInterface;
  /** The genesis, and the route table's tip as the host last followed it. */
  genesis: Record<string, unknown>;
  dispatchTip?: string;
  /** The route table as last read (syncDispatch). */
  rows?: DispatchRow[];
  /** The apps' subscriptions (#119): folded from the log at hydrate, then followed live. */
  subs: Subscription[];
  /** The apps' beacons (#126): folded from the log at hydrate, then followed live; an uninstalled app's (no row left) dropped. */
  beacons: Beacon[];
  /** The apps' liveness (#138): folded from the log at hydrate, then followed live; an uninstalled app's (no row left) dropped. */
  live: Live[];
}

/** A request as the router takes it: the full URL (its host is the Host header's), lower-cased headers, the body. */
export interface RouterRequest {
  method: string; url: string; headers: Record<string, string>; body: Uint8Array;
  /**
   * 0.3.2: on a socket's request (Router.handler), aborted when the client's connection closes
   * before the answer is written; never fired after the answer. In process: none.
   */
  signal?: AbortSignal;
}
export interface RouterResponse {
  status: number; headers: Record<string, string>; body: Uint8Array;
  /**
   * A response held open (an event stream an `appRead` answers): on a socket (Router.handler) the
   * status and headers are written, then `stream` is called with `send` (writes a chunk) and `end`
   * (closes the response); the function it returns is called once when the client goes. `body` is
   * not written. In process (Router.dispatch's caller) it is not called: the caller gets `body`.
   */
  stream?(send: (chunk: string) => void, end: () => void): () => void;
}

/** Headers per `headers` frame of the one intake (a long run, the first sync's, goes in runs of this many). */
export const HEADERS_RUN = 2016;

const json = (status: number, v: unknown): RouterResponse => ({ status, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(v)) });
const KEY = /^0[23][0-9a-f]{64}$/;
/** The apps a route table names (an app with no row left is uninstalled). */
/**
 * The txid of the signed transaction a frame's answer carries (skein 0.9.0, rule 10): the answer dag-cbor, a map
 * whose `tx` is the bytes of a transaction (the amm-validator's accepted swap, `{ok, tx, txid, beef}`); else
 * undefined (a refusal carries none).
 */
export function signedTxOf(body: Uint8Array): string | undefined {
  let v: unknown;
  try { v = dagCbor.decode(body); } catch { return undefined; }
  const tx = (v && typeof v === "object" && !Array.isArray(v)) ? (v as { tx?: unknown }).tx : undefined;
  if (!(tx instanceof Uint8Array) || !tx.length) return undefined;
  try { return Transaction.fromBinary([...tx]).id("hex"); } catch { return undefined; }
}

const appsOf = (rows: DispatchRow[]): Set<string> => new Set(rows.map(rowApp).filter((x): x is string => typeof x === "string"));
export { HANDLE };
/** Handles no instance may take on this host (H3), besides the router origin's own first label (Router.reserved): `id` (the router's own in production) and `host` (the host skein's). */
export const RESERVED_HANDLES = new Set(["id", "host"]);
/** A handle's domain as a create takes it: a host name, lower case. */
const DOMAIN = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
/** The BRC-169 domain a host name stands for: a dev router at a loopback address answers for `localhost`. */
export const domainOf = (hostname: string): string => {
  const h = hostname.toLowerCase();
  return h === "127.0.0.1" || h === "::1" || h === "[::1]" || h === "" ? "localhost" : h;
};
/**
 * The BRC-169 domain of this host (H4): its public origin's host name
 * (SKEIN_ROUTER_ORIGIN, default the loopback: `localhost`). What a created
 * instance and a claim record when nothing names one,
 * and what /.well-known/skein-host answers.
 */
export const hostDomain = (origin: string): string => {
  try { return domainOf(new URL(origin.replace("{port}", "0")).hostname); } catch { return "localhost"; } // an origin that is no URL: the loopback's
};

export class Router {
  readonly o: RouterOptions;
  /** The host's broadcaster (#58, #65): present when the host has an Arcade. */
  readonly arc?: Broadcaster;
  /** The libp2p host (#51): one node per key, for the instances whose apps declare topic membership. */
  readonly p2p?: P2PHost;
  /** shruggr/skein#150: overlay sync over the libp2p node (sync.ts). */
  readonly sync?: OverlaySync;
  /** What the instances' steps hand over (the `emit` notices: broadcasts, membership, facts). */
  readonly emits: Emits;
  /** #148: the pages' subscriptions to their apps' emitted events, per instance. */
  readonly events: EventStreams;
  /** BRC-103: the sessions the host keeps for its instances (memory only, brc104.ts). */
  readonly sessions = new Sessions();
  /** The kernels' `answered` notices, by entry (door.ts): a request whose handler awaits waits here. */
  readonly answers = new Answers();
  readonly loaded = new Map<string, Loaded>();
  private loading = new Map<string, Promise<Loaded>>();
  /** #156: the host chain record each running instance was last sent (a `chain` event), by handle; cleared at each start. */
  private sentChain = new Map<string, string>();
  /** Rows being created: hydrated before their hostname is published (disabled until claimed). */
  private unpublished = new Set<string>();
  private queues = new Map<string, Promise<unknown>>();
  /** The libp2p nodes following their route tables (syncDispatch after a settle). */
  private syncing = new Set<Promise<unknown>>();
  private idleTimer?: ReturnType<typeof setInterval>;
  private ledgerTimer?: ReturnType<typeof setInterval>;
  /** The fuel of calls not yet written to the ledger: instance\0caller\0op → {calls, fuel}. */
  private owed = new Map<string, { calls: number; fuel: number }>();
  private stopped = false;
  private closing?: Promise<void>;
  /** Settles when the router starts shutting down: every client still waiting on an answer is answered 503. */
  private stopping: Promise<void>;
  private stopNow!: () => void;
  /** Requests being carried (their clients held until an answer). */
  private inflight = new Set<Promise<RouterResponse>>();
  servers: Server[] = [];
  port = 0;
  /** The control socket (control.ts), while this router listens on one. */
  private control?: { server: NetServer; path: string };

  /** SKEIN_HEADERS_URL's source (headers-source.ts), when the host has one. */
  headersSource?: HttpHeaders;
  /** #156: the headers tracker over the Teranode mesh (teranode.ts), when the host runs one. */
  tracker?: TeranodeTracker;
  /** #156: the libp2p the host node runs on: the instances' (`p2p`), else one for the tracker alone. */
  hostP2p?: P2PHost;
  private readonly p2pConfig: P2PHostConfig;
  /** The one header intake (SPEC 8), one run at a time: the host chains, then the instances' pointer events. */
  private intake: Promise<unknown> = Promise.resolve();
  /** The host's service keys (SPEC 8: each its own; none root). */
  private readonly serviceKey: (name: ServiceName) => PrivateKey;

  /** The one-process kernels this router holds (#158), by database directory. */
  private kernelHosts = new Map<string, KernelHost>();
  private wasmHosts = new Map<string, WasmHost>();

  /** The wasm kernel's host over the SQLite database at `db` (the settled split): its machines, its host chain. */
  private wasmHost(db: string): WasmHost {
    let h = this.wasmHosts.get(db);
    if (!h) {
      h = WasmHost.acquire(db, { network: this.chainNetwork() ?? "main", log: (l) => this.say("kernel", l) });
      this.wasmHosts.set(db, h);
    }
    return h;
  }

  /** The `skein-kernel host` process for the RocksDB database at `dir` (#158), started on first use. */
  private kernelHost(dir: string): KernelHost {
    let h = this.kernelHosts.get(dir);
    if (!h) {
      h = KernelHost.acquire(dir, { command: this.o.kernel?.command, env: this.kernelEnv(), log: (l) => this.say("kernel", l) });
      this.kernelHosts.set(dir, h);
    }
    return h;
  }

  constructor(o: RouterOptions) {
    this.o = o;
    if (o.rocksStore) this.kernelHost(o.rocksStore); // started with the router: the host's reads go through it (stores.ts)
    this.stopping = new Promise<void>((r) => { this.stopNow = r; });
    // Without the host's own service keys: a router's own, fresh (a test's).
    const own = o.providerKeyFor ? undefined : new KeyDeriver(PrivateKey.fromRandom());
    this.serviceKey = o.providerKeyFor ?? ((n: ServiceName) => own!.derivePrivateKey([2, "skein provider"], n, "self"));
    if (o.arc) {
      this.arc = new Broadcaster({
        arc: o.arc, db: o.db, fetch: o.arcFetch, backoff: o.feeds?.backoff, ...(o.arcRetry ? { retry: o.arcRetry } : {}), log: (s, l) => this.say(s, l),
        admit: (h, _box, ev) => this.offerProof(h, ev),
        // SPEC 6 [D]: only `rejected` rests on someone's word — a request signed by the host's STATUS service key to the chain app's rejected row.
        status: (h, body) => this.statusRequest(h, body),
        now: () => stampMs(this.now()),
        // SPEC 8: who holds a transaction is the host's holder map (followed from the `chain/tx/<txid>` facts): no kernel started to ask.
        holders: (txid) => this.holdersOf(txid),
      });
    }
    // #156: the host's libp2p (one node per key; the host node among them) — for the instances, and for the tracker on its own.
    const hostConfig = { ...(o.libp2p ?? { listen: LOOPBACK_LISTEN, bootstrap: [], dht: "off" as const, relays: [], mdns: false }), network: this.chainNetwork() ?? "main" };
    this.p2pConfig = hostConfig;
    if (o.peerKeyFor) {
      this.p2p = new P2PHost({
        host: hostConfig, ...(o.hostPeerKey ? { hostKey: o.hostPeerKey } : {}),
        keyOf: o.peerKeyFor, discoveryMs: o.libp2pDiscoveryMs,
        inbound: (h, c) => this.p2pInbound(h, c),
        log: (s, l) => this.say(s, l),
        // #126: a beacon's beat signed by the instance's signer.
        sign: (h, data) => this.signAs(h, data),
        identity: async (h) => { const id = this.o.db.get(h)?.identity; return id ? keyBytes(id) : undefined; },
        beat: (h, topic, b) => { this.sync?.beat(h, topic, b); void this.rememberPeer(h, topic, b.from); },
        beats: o.db,
      });
      const p2pHost = this.p2p;
      this.hostP2p = p2pHost;
      this.sync = new OverlaySync({
        overlayOf: (h, liveTopic) => this.loaded.get(h)?.beacons.find((b) => b.topic === liveTopic)?.app,
        local: (h, app, fn, query) => this.overlayRead(h, app, fn, query),
        ownBeat: (h, liveTopic) => this.loaded.get(h)?.beacons.find((b) => b.topic === liveTopic)?.body,
        // SPEC 8 [P]: a BEEF the host fetched from a peer goes to the overlay's sync row as plain BEEF, no signature.
        submit: (h, app, beef) => this.submitBeef(h, syncPath(app), beef),
        holdsTx: async (h, txid) => {
          const row = this.o.db.get(h);
          if (!row || !storeExists(storeSpec(row))) return false;
          const st = openStoreFile(storeSpec(row), { readOnly: true });
          try { return await chainHolds(st, txid); } finally { st.close(); }
        },
        proof: async (h, txid, path) => { await this.offerProof(h, { kind: "proof", subject: txCid(txid), txid, path }); },
        header: async (h, height) => {
          const row = this.o.db.get(h);
          if (!row || !storeExists(storeSpec(row))) return undefined;
          const st = openStoreFile(storeSpec(row), { readOnly: true });
          try { return await chainHeader(st, height); } finally { st.close(); }
        },
        // The peer's overlay's read rows, asked over the one request protocol (SPEC 7 [P]): a frame is a request record.
        request: (h, peer, body) => p2pHost.request(h, peer, REQUEST_PROTOCOL, body),
        beats: (h, liveTopic) => p2pHost.live.live(h, liveTopic),
        self: (h) => p2pHost.peerId(h),
        log: (s, l) => this.say(s, l),
      });
    }
    this.events = new EventStreams({
      open: (h) => { const row = this.o.db.get(h); return row && storeExists(storeSpec(row)) ? openStoreFile(storeSpec(row), { readOnly: true }) as EventStore : undefined; },
    });
    const p2p = this.p2p;
    this.emits = new Emits({
      ...(this.arc ? { broadcast: (h: string, tx: Uint8Array, beef?: Uint8Array) => { this.arc!.enqueue(h, tx, beef); } } : {}),
      ...(p2p ? { topicEvent: (h: string, rec: Record<string, unknown>) => this.topicEvent(h, rec) } : {}),
      // #148: every fact to the event streams; SPEC 8: the host follows `chain/tx/<txid>` (the holder map) and the overlay's admitted fact (the gossip admit).
      emitted: (h, rec, place) => { this.events.emitted(h, rec, place); this.followFact(h, rec); },
      log: (s, l) => this.say(s, l),
    });
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

  /** Whether `handle` is reserved on this host: `id`, `host` (RESERVED_HANDLES), or the router origin's own first label — unless it is the root instance's (ownLabelInstance). */
  reserved(handle: string): boolean {
    return RESERVED_HANDLES.has(handle) || (handle === this.ownLabel() && !this.ownLabelInstance(handle));
  }

  /**
   * The router's own first label as an instance (skein next: the planner's call, David to review): only the
   * instance SKEIN_ROOT_INSTANCE names (`rootInstance`, the instance the bare hostname is routed to) may take
   * it — Open Exchange's `swap` at swap.skein.nexus. Its hostname then serves the instance; the router keeps
   * /.well-known/skein-host, /skeins and /arc/callback there. Any other handle like the router's label is
   * reserved. (At v0.9.1 SKEIN_MANAGER_FOR granted this, beside the manager message form; both are gone.)
   */
  ownLabelInstance(handle: string): boolean {
    return handle === this.ownLabel() && handle === this.o.rootInstance;
  }

  /** This host's BRC-169 domain: its origin's host name (hostDomain). */
  domain(): string { return hostDomain(this.origin()); }

  /** An instance's origin: where its front door is, what BRC-169 publishes as its messagebox. */
  originOf(handle: string): string {
    // #161: a path-only handle (a token id) has no hostname: its origin is /@<handle> on the host's own.
    if (pathOnly(handle)) return `${this.origin().replace(/\/+$/, "")}/@${handle}`;
    return (this.o.instanceOrigin ?? "http://{handle}.localhost:{port}").replace("{handle}", handle).replace("{port}", String(this.port || this.o.port || 0));
  }

  /** Hydrate every enabled row once (recovery at hydrate time: what a waiting thread awaits is handed to the providers again), then let them idle out. */
  async start(): Promise<void> {
    // SPEC 8: the Teranode tracker is the one source of the header intake; its first sync (a hub's, when the network
    // has one) before any instance is hydrated, so each is told the chain as the host knows it inside its load.
    if (this.o.teranode) {
      await this.startTracker().catch((e) => this.say("router", `headers: the Teranode tracker not started: ${(e as Error).message}`));
      if (this.tracker?.o.hub) await this.tracker.ready;
    }
    // SPEC 8: an HTTP source feeds the same intake (beside the tracker or alone): its history fill awaited, then its stream.
    if (this.o.headersUrl && !this.headersSource && !this.stopped) {
      this.headersSource = new HttpHeaders({
        url: this.o.headersUrl, take: (raws, at) => this.takeHeaders(raws, at), find: (hash) => this.findHeader(hash),
        tip: async () => { const x = await this.hostTip(); return x ? { height: x.height, hash: x.hash } : undefined; },
        backoff: this.o.feeds?.backoff, log: (l) => this.say("router", l),
      });
      await this.headersSource.start();
    }
    // SPEC 8: the holder map, rebuilt from the instances' stores (their `chain/tx/` facts), no kernel started.
    await this.rebuildHolders().catch((e) => this.say("router", `holders: not rebuilt: ${(e as Error).message}`));
    // #138: the stored liveness beats older than the longest window (a day) go before any instance reloads them.
    this.o.db.pruneBeats(stampMs(this.now()) - LIVENESS_MAX_MS);
    for (const row of this.o.db.list("enabled")) {
      try { await this.hydrate(row.handle); } catch (e) { this.say(row.handle, `not started: ${(e as Error).message}`); }
    }
  }

  /**
   * Stop everything this router started (#61), once: the providers' (the
   * waker's), the idle reaper's and the ledger's timers
   * (the owed fuel written first), its
   * servers and their connections, the control socket (its file removed), the broadcaster's
   * SSE client, the headers tracker, the libp2p nodes, and every kernel process it spawned — one
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
   * Listen on the control socket at `path` ($SKEIN_HOME/host.sock for `skein-host run`; mode 0600, no
   * HTTP route): a signed request from the client on this machine (messageLocal). Removed by `close()`.
   */
  async listenControl(path: string): Promise<void> {
    if (this.stopped) throw new Error("the router is stopping");
    const server = await listenControl(path, {
      message: async (h, bytes) => { const r = await this.messageLocal(h, bytes); return { entry: r.entry.toString(), status: r.answer.status, body: r.answer.body }; },
    });
    this.control = { server, path };
    this.say("router", `control socket at ${path}`);
  }

  private async shutdown(): Promise<void> {
    this.stopped = true;
    this.sync?.stop();
    // Clients waiting on an answer are answered 503 + Retry-After before the servers close.
    this.stopNow();
    if (this.inflight.size) {
      await Promise.all([...this.inflight].map((p) => p.catch(() => {}))); // each answers its own client (a 503 now): this only waits for them
      await new Promise((r) => setTimeout(r, 50)); // their 503s written before the sockets close
    }
    clearInterval(this.idleTimer);
    clearInterval(this.ledgerTimer);
    this.flushLedger();
    const closed = this.servers.map((s) => new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections(); }));
    this.servers = [];
    if (this.control) closed.push(closeControl(this.control.server, this.control.path));
    this.control = undefined;
    this.emits.stop();
    this.events.stop();
    await Promise.all([this.arc?.stop(), this.tracker?.stop(), this.headersSource?.stop()]);
    await Promise.all([this.p2p?.stop(), this.hostP2p !== this.p2p ? this.hostP2p?.stop() : undefined]); // #156: the host node with them
    // A kernel still hydrating: its load finishes (or fails) first, then it is stopped with the rest.
    await Promise.all([...this.loading.values()].map((p) => p.catch(() => {}))); // a failed load was reported to whoever asked for it
    await Promise.all([...this.loaded.values()].map((l) => l.kernel.stop()));
    this.loaded.clear();
    // #158: the one-process kernels released (the last holder's release stops the process: its database flushed).
    await Promise.all([...this.kernelHosts.values()].map((h) => h.release()));
    this.kernelHosts.clear();
    await Promise.all([...this.wasmHosts.values()].map((h) => h.release()));
    this.wasmHosts.clear();
    await Promise.all(closed);
  }

  /** One arrival through `handle` (door.ts carry): CHECK then COMMIT on its worker, then its answer; `signal` the client's connection. */
  private async carryIn(handle: string, arrival: { request: RequestRecord } | { event: Record<string, unknown>; name: string }, signal?: AbortSignal): Promise<Outcome> {
    const l = await this.hydrate(handle);
    const o = await carry(l.kernel, arrival, { now: this.now(), answers: this.answers, signal, stop: this.stopping });
    if (o.kind === "read") this.charge(handle, o.principal ? keyHex(o.principal) : "", "read", o.fuel);
    if (o.kind === "refused") this.charge(handle, o.refusal.principal ? keyHex(o.refusal.principal) : "", "refused", o.refusal.fuel);
    if (o.kind !== "refused" && o.kind !== "read") this.settle(l);
    return o;
  }

  /**
   * An event from the host's own wiring (SPEC 4: the chain pointer, a merkle proof, a deploy BEEF):
   * `{event, name}` through CHECK (the event row's checks — the chain app's proof or BEEF check) then
   * COMMIT, in the order the host made them (serial). → the entry. Refused (nothing written):
   * DoorAnswered, thrown.
   */
  async admitEvent(handle: string, name: string, event: Record<string, unknown>): Promise<CID> {
    return await this.serial(handle, async () => {
      const o = await this.carryIn(handle, { event, name });
      if (o.kind === "refused") throw new DoorAnswered(o.refusal);
      if (o.kind === "read") throw new Error(`${name}: an event row answered as a read`);
      return o.entry;
    });
  }

  /**
   * A request signed outside the host (the client `skein` with the operator's key over the control
   * socket; an application host's own root requests — Open Exchange's install and terms), handed to
   * the instance as it is: `request` a request record, or its dag-cbor (src/client/raw.ts
   * signRequest). CHECK then COMMIT, in order (serial), then its answer. The host signs nothing.
   * → {entry, answer}. Refused (nothing written): DoorAnswered, thrown; committed with an answer of
   * status ≥ 400 (a kernel operation refused: its entry written, its refusal the answer): an Error
   * naming the status and the answer.
   */
  async messageLocal(handle: string, request: Uint8Array | RequestRecord): Promise<{ entry: CID; answer: Answer }> {
    if (!this.o.db.get(handle)) throw new Error(`no instance ${handle}`);
    let r: RequestRecord;
    if (request instanceof Uint8Array) {
      try { r = dagCbor.decode(request) as RequestRecord; } catch { throw new Error("the request is not dag-cbor"); }
    } else r = request;
    if (!r || typeof r !== "object" || r.kind !== "request" || !r.payload) throw new Error("not a request record ({kind: \"request\", payload, signature?})");
    const o = await this.serial(handle, () => this.carryIn(handle, { request: r }));
    if (o.kind === "refused") throw new DoorAnswered(o.refusal);
    if (o.kind === "read") return { entry: undefined as never, answer: o.answer };
    if (o.kind === "gone") throw new Error(`not answered before the host stopped (entry ${o.entry})`);
    const answer = o.answer ?? { status: o.state === "errored" ? 500 : 204, body: new Uint8Array() };
    if (answer.status >= 400) throw Object.assign(new Error(`${answer.status} ${answerText(answer)} (entry ${o.entry})`), { entry: o.entry, answer });
    return { entry: o.entry, answer };
  }

  /**
   * A BEEF handed to `handle`'s row at `path` as a content-proven request (SPEC 7: the body is just the
   * BEEF, no signature, no topics): the host's sync deliveries go to the overlay's sync row
   * (`/<app>/sync`); an application host hands a public submission to the submit row. → the verdict
   * for the carrier: accept (committed), reject (refused 4xx: the sender's fault), ignore (refused
   * otherwise, or the instance could not take it).
   */
  async submitBeef(handle: string, path: string, beef: Uint8Array): Promise<InboundAnswer & { entry?: CID }> {
    if (!this.o.db.get(handle)) return { verdict: "ignore", reason: `no instance ${handle} here` };
    try {
      const o = await this.carryIn(handle, { request: { kind: "request", payload: { method: "POST", path, query: "", headers: { "content-type": "application/octet-stream" }, body: beef } } });
      if (o.kind === "refused") return { verdict: o.refusal.status < 500 ? "reject" : "ignore", reason: o.refusal.reason ?? `refused (${o.refusal.status})` };
      if (o.kind === "read") return { verdict: "ignore", reason: `${path} is a read row` };
      return { verdict: "accept", entry: o.entry };
    } catch (e) {
      return { verdict: "ignore", reason: (e as Error).message };
    }
  }

  /**
   * The host's status service (SPEC 6 [D]): a REJECTED status Arcade gave for a transaction an instance
   * holds, as a request signed by the host's STATUS service key (its own, not root) to the chain app's
   * rejected row (REJECTED_PATH, role `chain.status`), body dag-cbor `body`.
   */
  async statusRequest(handle: string, body: Record<string, unknown>): Promise<CID> {
    const id = this.o.db.get(handle)?.identity;
    if (!id) throw new Error("its identity is not known yet");
    const r = await signRequest(new ProtoWallet(this.serviceKey("status")), { recipient: id, payload: { method: "POST", path: REJECTED_PATH, query: "", headers: { "content-type": "application/cbor" }, body: dagCbor.encode(body) } });
    return (await this.messageLocal(handle, r)).entry;
  }

  /** The status service's identity key (hex): the key the genesis grants `chain.status` (imageConfig). */
  statusKey(): string { return this.serviceKey("status").toPublicKey().toString(); }

  /**
   * A merkle proof for a transaction an instance holds (Arcade's, or one the sync pull cut from a
   * block): the event PROOF_EVENT through the chain app's proof check (SPEC 6: its root matches a
   * header we hold). An EARLY proof (its header not held yet: refused with EARLY_PROOF_CODE) is kept in
   * host memory and offered again after the next header the host takes (`retryProofs`); any other
   * refusal is the proof's.
   */
  async offerProof(handle: string, proof: Record<string, unknown>): Promise<CID | undefined> {
    try {
      const e = await this.admitEvent(handle, PROOF_EVENT, proof);
      this.earlyProofs.get(handle)?.delete(proofKey(proof));
      return e;
    } catch (x) {
      if (x instanceof DoorAnswered && x.answer.code === EARLY_PROOF_CODE) {
        let m = this.earlyProofs.get(handle);
        if (!m) this.earlyProofs.set(handle, (m = new Map()));
        m.set(proofKey(proof), proof);
        this.say(handle, `proof ${String(proof.txid ?? "").slice(0, 8)}: early (${x.answer.reason ?? "its header is not held yet"}): offered again after the next header`);
        return undefined;
      }
      this.earlyProofs.get(handle)?.delete(proofKey(proof));
      throw x;
    }
  }

  /** The early proofs, per instance (offerProof): offered again after each header the host takes. */
  private earlyProofs = new Map<string, Map<string, Record<string, unknown>>>();

  /** Each early proof of `handle` offered again (after a new header): taken, early still, or refused (dropped). */
  private async retryProofs(handle: string): Promise<void> {
    const m = this.earlyProofs.get(handle);
    if (!m?.size) return;
    for (const p of [...m.values()]) await this.offerProof(handle, p).catch((e) => this.say(handle, `proof ${String(p.txid ?? "").slice(0, 8)}: refused: ${(e as Error).message}`));
  }

  /** Sign `data` with `handle`'s signer, BRC-169's way ([2, "metanet handles envelope"] / `send` / anyone): a beacon's beat (p2p.ts beaconFrame). */
  private async signAs(handle: string, data: Uint8Array): Promise<Uint8Array> {
    const row = this.o.db.get(handle);
    if (!row) throw new Error(`no instance ${handle}`);
    const { signature } = await (await this.o.walletFor(row)).createSignature({ protocolID: MESSAGE_PROTOCOL, keyID: MESSAGE_KEY_ID, counterparty: "anyone", data: [...data] });
    return Uint8Array.from(signature);
  }

  /**
   * A request signed as `handle` through this host's key holder, outside any step (SPEC 2: the
   * `signed` scheme — src/client/raw.ts signRequest): for host code that speaks for an instance (Open
   * Exchange's swap relay signs its package to a validator with the token instance's key).
   * `recipient` the instance it is for (hex or 33 bytes; default `handle` itself); `nonce` 16 fresh
   * bytes when absent. Nothing is logged.
   */
  async signRequest(handle: string, r: { recipient?: Uint8Array | string; payload: RequestPayload; nonce?: Uint8Array }): Promise<RequestRecord> {
    const row = this.o.db.get(handle);
    if (!row?.identity) throw new Error(`no instance ${handle} with an identity here`);
    return await signRequest(await this.o.walletFor(row), { recipient: r.recipient ?? row.identity, payload: r.payload, ...(r.nonce ? { nonce: r.nonce } : {}) });
  }

  /**
   * An inbound libp2p topic message or stream frame (#51). A topic message is the host's (SPEC 7/8:
   * nothing of gossip is handed to the kernel): an overlay's `admit` announcement is fetched by the
   * host unless held (sync.ts), anything else ignored. A frame on REQUEST_PROTOCOL is a request record
   * (dag-cbor): the same CHECK / COMMIT path as HTTP, its answer frame the handler's answer (dag-cbor
   * {status, type?, headers?, body}); the stream stays open until it comes. skein 0.9.0: a frame's
   * answer carrying a signed transaction (`signedTxOf`) is held until this host's broadcast of it is
   * taken by Arcade; refused by Arcade as invalid, it is answered `{ok: false, reason: "rejected",
   * detail}` instead (`heldAnswer`).
   */
  async p2pInbound(handle: string, call: InboundCall): Promise<InboundAnswer> {
    let from = "";
    try { from = peerIdFromMultihash(Digest.decode(call.from)).toString(); } catch { /* not a peer ID: only this log line's name */ }
    if (call.topic !== undefined) {
      const app = this.loaded.get(handle)?.beacons.find((b) => b.topic === `${call.topic}-live`)?.app;
      const txid = app && this.sync ? admitOf(call.topic, call.body) : undefined;
      if (app && txid && from) {
        this.sync!.admit(handle, app, call.topic, txid, from);
        return { verdict: "ignore", reason: "an announcement: the host fetches it" };
      }
      return { verdict: "ignore", reason: "gossip is the host's: nothing of it goes to the instance" };
    }
    const frame = (a: Answer): InboundAnswer => ({ verdict: a.status < 400 ? "accept" : "ignore", body: dagCbor.encode({ status: a.status, ...(a.type ? { type: a.type } : {}), ...(a.headers ? { headers: a.headers } : {}), body: a.body }) });
    if (call.protocol !== REQUEST_PROTOCOL) return frame({ status: 404, type: "application/json", body: jsonBytes({ status: "error", code: "ERR_NOT_FOUND", description: `this host serves ${REQUEST_PROTOCOL}` }) });
    let r: RequestRecord;
    try { r = dagCbor.decode(call.body) as RequestRecord; } catch { return frame({ status: 400, type: "application/json", body: jsonBytes({ status: "error", code: "ERR_BAD_REQUEST", description: "a frame is a dag-cbor request record" }) }); }
    if (!r || typeof r !== "object" || r.kind !== "request" || !r.payload) return frame({ status: 400, type: "application/json", body: jsonBytes({ status: "error", code: "ERR_BAD_REQUEST", description: "a frame is a request record {kind: \"request\", payload, signature?}" }) });
    let o: Outcome;
    try { o = await this.carryIn(handle, { request: r }); } catch (e) { return frame({ status: 503, type: "application/json", body: jsonBytes({ status: "error", code: "ERR_UNAVAILABLE", description: (e as Error).message }) }); }
    const a = httpOf(o);
    if (o.kind === "refused" || process.env.SKEIN_LIBP2P_VERBOSE) this.say(handle, `libp2p: ${String(r.payload.method)} ${String(r.payload.path)} from ${from}: ${a.status}`);
    const answer: Answer = { status: a.status, ...(a.headers["content-type"] ? { type: a.headers["content-type"] } : {}), body: await this.heldAnswer(handle, a.body) };
    return frame(answer);
  }

  /**
   * skein 0.9.0 (rule 10): a stream frame's answer, as the requester gets it. One carrying a signed
   * transaction (`signedTxOf`) is held until THIS host's broadcast of it is taken by Arcade, then answered as
   * it is; refused by Arcade as invalid, it is answered `{ok: false, reason: "rejected", detail: <Arcade's
   * reason>}`. One carrying none (a refusal: nothing broadcast) goes at once.
   */
  async heldAnswer(handle: string, body: Uint8Array): Promise<Uint8Array> {
    const txid = signedTxOf(body);
    if (!txid) return body;
    const t = await this.broadcastTaken(handle, txid);
    if ("gone" in t || t.taken) return body;
    this.say(handle, `${txid.slice(0, 8)}: refused by Arcade (${t.reason}): the held answer is a refusal`);
    return dagCbor.encode({ ok: false, reason: "rejected", detail: t.reason });
  }

  /**
   * skein 0.9.0 (rule 10, David 2026-11-11: "The requester should be queued off of the actual broadcast
   * state"): until this host's broadcast of `txid` is taken by Arcade (`{taken: true}`) or refused as invalid
   * (`{taken: false, reason}`) — the hold of an answer to a requester (Broadcaster.taken: in memory, gone on a
   * restart). `signal` (the requester's connection) fired: `{gone: true}`. A host with no Arcade never
   * broadcasts: the hold is never released (David to review).
   */
  async broadcastTaken(handle: string, txid: string, signal?: AbortSignal): Promise<{ taken: true } | { taken: false; reason: string } | { gone: true }> {
    if (!this.arc) {
      this.say(handle, `${txid.slice(0, 8)}: an answer held on this host's broadcast, and this host has no Arcade: never released`);
      return await new Promise((resolve) => { signal?.addEventListener("abort", () => resolve({ gone: true }), { once: true }); });
    }
    const t = await this.arc.taken(txid, signal);
    return t ?? { gone: true };
  }

  /** Until nothing is queued and every loaded kernel has processed what it was given (tests, corpus). */
  async settled(): Promise<void> {
    for (let i = 0; i < 1000; i++) {
      await Promise.all([...this.queues.values()]);
      await Promise.all([...this.loaded.values()].map((l) => l.kernel.idle().catch(() => {}))); // a kernel that exited is reported by its exit (hydrate's `exited`): this only waits
      await this.arc?.idle(); // the broadcaster's posts (#65): their answers are statuses to route
      await Promise.all([...this.syncing]); // the libp2p nodes following their dispatch tables (#72, #77)
      await new Promise((r) => setImmediate(r));
      if (!this.syncing.size && !this.queues.size && !this.arc?.busy() && [...this.loaded.values()].every((l) => l.kernel.busy === 0)) return;
    }
  }

  /**
   * Run `f` after everything else queued for this instance: the host's own arrivals (its events, its
   * signed requests) reach the kernel in the order the host made them, each after its hydrate, and
   * `settled` waits on them. Not the log's order: the kernel assigns every entry's place, so HTTP and
   * libp2p arrivals, which do not queue here, need no queue.
   */
  serial<T>(handle: string, f: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(handle) ?? Promise.resolve();
    // f's failure goes to its caller through `next`; the queue only keeps the order.
    const next = prev.catch(() => {}).then(f);
    const tail = next.catch(() => {});
    this.queues.set(handle, tail);
    void tail.then(() => { if (this.queues.get(handle) === tail) this.queues.delete(handle); });
    return next;
  }

  // ---------------------------------------------------------------- the host chain (#156)

  /**
   * #156: the Teranode tracker started: its node on the mesh, its first sync begun (`tracker.ready`). Its
   * lookups (`tip`, `find`) read the host chain's tip and the recent index below; what it takes goes to the
   * one intake (takeHeaders).
   */
  private async startTracker(): Promise<void> {
    const t = this.o.teranode;
    if (!t || this.tracker || this.stopped) return;
    // #156: no instance libp2p (no peer keys: a test's host): the host's libp2p for the tracker alone.
    this.hostP2p ??= new P2PHost({
      host: this.p2pConfig, ...(this.o.hostPeerKey ? { hostKey: this.o.hostPeerKey } : {}), discoveryMs: this.o.libp2pDiscoveryMs,
      keyOf: () => { throw new Error("no instance libp2p on this host"); },
      inbound: async () => ({ verdict: "ignore" }),
      log: (s, l) => this.say(s, l),
    });
    this.tracker = new TeranodeTracker({
      network: this.chainNetwork() ?? "main", ...t, p2p: this.hostP2p,
      chain: {
        tip: async () => { const x = await this.hostTip(); return x ? { height: x.height, hash: x.hash } : undefined; },
        find: async (hash) => await this.findHeader(hash),
        take: (at, raws) => this.takeHeaders(raws, at),
      },
      log: (l) => this.say("router", l),
    });
    await this.tracker.start();
  }

  /**
   * The headers the tracker fed the intake in this run, by height and by hash, within RECENT_DEPTH of the
   * highest — what the tracker's `find` looks a hash up in (the image chain's `find` window did this before).
   * // until the host chain answers holds/at (SPEC 5): build K adds the kernel lookups holds(hash) and
   * at(height); then `find` asks the host chain and this index goes.
   */
  private recent = { byHeight: new Map<number, string>(), byHash: new Map<string, number>() };
  /** How far below the highest header the recent index keeps (two retarget periods, the image chain's window). */
  static readonly RECENT_DEPTH = 2 * 2016;

  /** The run `raws` at `at` into the recent index: what it replaces from `at` up dropped first (a reorg), then pruned below the window. // until the host chain answers holds/at (SPEC 5) */
  private remember(at: number, raws: Uint8Array[]): void {
    const r = this.recent;
    for (const [h, hash] of r.byHeight) if (h >= at) { r.byHeight.delete(h); if (r.byHash.get(hash) === h) r.byHash.delete(hash); }
    const top = at + raws.length - 1;
    for (let i = Math.max(0, raws.length - 1 - Router.RECENT_DEPTH); i < raws.length; i++) { const hash = hashOf(raws[i]!); r.byHeight.set(at + i, hash); r.byHash.set(hash, at + i); }
    for (const [h, hash] of r.byHeight) if (h < top - Router.RECENT_DEPTH) { r.byHeight.delete(h); if (r.byHash.get(hash) === h) r.byHash.delete(hash); }
  }

  /** The tracker's `find`: a hash's height from the recent index, else the host chain's tip when it is that hash. // until the host chain answers holds/at (SPEC 5) */
  private async findHeader(hash: string): Promise<number | undefined> {
    const h = this.recent.byHash.get(hash);
    if (h !== undefined) return h;
    const tip = await this.hostTip();
    return tip?.hash === hash ? tip.height : undefined;
  }

  /** The host chain's tip (the first host chain this host keeps: hostHolders), with its hash; undefined when empty or none is kept. */
  private async hostTip(): Promise<HostChainTip | undefined> {
    const h = this.hostHolders()[0];
    return h ? await h.tip() : undefined;
  }

  /**
   * SPEC 8: the ONE header intake — a run of headers, parents first, at height `at` (the tracker's): into
   * every host chain this host keeps (the kernel validates and keeps them: `headers` frames, runs of
   * HEADERS_RUN), once; then every loaded instance its pointer event (chainBirth). One run at a time.
   */
  takeHeaders(raws: Uint8Array[], at: number): Promise<void> {
    const p = this.intake.then(async () => {
      const holders = this.hostHolders();
      if (!holders.length) { this.say("router", `host chain: ${raws.length} header${raws.length === 1 ? "" : "s"} at ${at}: this host keeps no host chain (no SQLite or RocksDB store): not taken`); return; }
      for (const h of holders) {
        const t0 = Date.now();
        let tip: HostChainTip | undefined;
        for (let i = 0; i < raws.length; i += HEADERS_RUN) tip = await h.headers(raws.slice(i, i + HEADERS_RUN));
        if (raws.length > HEADERS_RUN) this.say("router", `host chain: ${raws.length} headers from ${at} (tip ${tip?.height}, ${Date.now() - t0} ms)`);
      }
      this.remember(at, raws);
    });
    this.intake = p.catch(() => {});
    return p.then(() => {
      for (const h of [...this.loaded.keys()]) void this.chainBirth(h).then(() => this.retryProofs(h)).catch((e) => this.say(h, `host chain: the chain event not sent: ${(e as Error).message}`));
    });
  }

  /** #156: the host chains this host keeps once per database (its SQLite one, its RocksDB one, and those its rows name). */
  private hostHolders(): Array<{ name: string; tip(): Promise<HostChainTip | undefined>; headers(raws: Uint8Array[]): Promise<HostChainTip> }> {
    const sq = new Set<string>(), rocks = new Set<string>();
    if (this.o.sqliteStore) sq.add(this.o.sqliteStore);
    if (this.o.rocksStore) rocks.add(this.o.rocksStore);
    for (const row of this.o.db.list("enabled")) {
      const spec = storeSpec(row);
      const r = parseRocksSpec(spec), q = parseSqliteSpec(spec);
      if (r) rocks.add(r.dir);
      if (q) sq.add(q.db);
    }
    return [
      ...[...sq].map((db) => { const w = this.wasmHost(db); return { name: db, tip: () => w.chainTip(), headers: (raws: Uint8Array[]) => w.chainHeaders(raws) }; }),
      ...[...rocks].map((dir) => { const k = this.kernelHost(dir); return { name: dir, tip: () => k.chainTip(), headers: (raws: Uint8Array[]) => k.chainHeaders(raws) }; }),
    ];
  }

  /** #156: each host chain this host keeps (by database) and its tip (undefined: empty). */
  async hostChainTips(): Promise<Array<{ name: string; tip: HostChainTip | undefined }>> {
    return await Promise.all(this.hostHolders().map(async (h) => ({ name: h.name, tip: await h.tip() })));
  }

  /**
   * The network the host chain is on: SKEIN_NETWORK (`network`), else the genesis defaults'
   * `walletNetwork` (a test host's), else the kernel's default (main).
   */
  chainNetwork(): string | undefined {
    const d = this.o.genesis?.defaults as { walletNetwork?: unknown } | undefined;
    return this.o.network ?? (typeof d?.walletNetwork === "string" ? d.walletNetwork : undefined);
  }

  /** The kernels' environment: the configured one, and the host chain's network (#156). */
  private kernelEnv(): Record<string, string | undefined> | undefined {
    const net = this.chainNetwork();
    return net ? { ...this.o.kernel?.env, SKEIN_NETWORK: net } : this.o.kernel?.env;
  }

  /** The chain pointer event (#156) for `handle`, unless it was sent that record already since its start. */
  private async chainEvent(handle: string, tip: HostChainTip): Promise<void> {
    const key = tip.root.toString();
    if (this.sentChain.get(handle) === key) return;
    this.sentChain.set(handle, key);
    try {
      await this.admitEvent(handle, CHAIN_EVENT, { kind: "chain", root: tip.root, height: tip.height });
    } catch (e) {
      if (this.sentChain.get(handle) === key) this.sentChain.delete(handle);
      throw e;
    }
  }

  /** The host chain's current record as the pointer event, unless sent already (a change of the host chain: the intake; an app taking the event `chain` installed: syncDispatch). */
  private async chainBirth(handle: string): Promise<void> {
    const l = this.loaded.get(handle);
    if (!l || l.kernel.gone) return;
    const rows = l.rows ?? (await l.kernel.routes()).rows as DispatchRow[];
    if (!takesEvent(rows, CHAIN_EVENT)) return;
    const tip = await l.kernel.chainTip();
    if (tip) await this.chainEvent(handle, tip);
  }

  /**
   * SPEC 8: the first chain pointer event of a load — when the instance's table takes the event `chain`
   * and the host chain holds a tip — through CHECK and COMMIT on the kernel being loaded, recorded as
   * sent. Throws: the load fails (an instance not told the chain is not up).
   */
  private async firstChainEvent(handle: string, kernel: KernelSurface): Promise<void> {
    const rows = (await kernel.routes()).rows as DispatchRow[];
    if (!takesEvent(rows, CHAIN_EVENT)) return;
    const tip = await kernel.chainTip();
    if (!tip) return;
    const o = await carry(kernel, { event: { kind: "chain", root: tip.root, height: tip.height }, name: CHAIN_EVENT }, { now: this.now() });
    if (o.kind === "refused") throw new DoorAnswered(o.refusal);
    this.sentChain.set(handle, tip.root.toString());
  }

  // ---------------------------------------------------------------- the holder map and the admit announcement (SPEC 8)

  /**
   * SPEC 8: the instances holding each UNSETTLED transaction, by txid — followed from each instance's
   * `chain/tx/<txid>` facts (skein-chain shape.zig statusEvent `{event, status, height?, reason?, by?}`):
   * `pending` or `seen` (un-mined by a reorg) → remembered; `mined` → forgotten. `rejected` changes nothing
   * (SPEC 8 names three statuses; plan-host C8 is open). Rebuilt from the stores at a start (rebuildHolders).
   */
  readonly holding = new Map<string, Set<string>>();

  /** One `chain/tx/<txid>` status for `handle` into the holder map. */
  private holdingFact(handle: string, txid: string, status: unknown): void {
    if (status === "pending" || status === "seen") {
      let s = this.holding.get(txid);
      if (!s) this.holding.set(txid, (s = new Set()));
      s.add(handle);
    } else if (status === "mined") {
      const s = this.holding.get(txid);
      if (!s) return;
      s.delete(handle);
      if (!s.size) this.holding.delete(txid);
    }
  }

  /** The enabled instances the holder map names for `txid` (a txid in display hex). */
  holdersOf(txid: string): string[] {
    const s = this.holding.get(txid.toLowerCase());
    return s ? [...s].filter((h) => this.o.db.get(h)?.status === "enabled") : [];
  }

  /**
   * SPEC 8: the holder map after a restart — each enabled instance's latest `chain/tx/` fact per txid, read from
   * its store's event index (events.ts: the store file read-only), no kernel started.
   */
  async rebuildHolders(): Promise<void> {
    this.holding.clear();
    let n = 0;
    for (const row of this.o.db.list("enabled")) {
      for (const d of await this.events.read(row.handle, { name: `${DEFAULT_BOX}/tx/`, prefix: true, latest: true })) {
        const txid = d.event.slice(`${DEFAULT_BOX}/tx/`.length);
        let status: unknown;
        try { status = (JSON.parse(d.data) as { status?: unknown }).status; } catch { continue; } // a record that is no JSON object names no status
        this.holdingFact(row.handle, txid, status);
      }
    }
    for (const s of this.holding.values()) n += s.size;
    if (n) this.say("router", `holders: ${this.holding.size} unsettled transaction${this.holding.size === 1 ? "" : "s"}, ${n} holder${n === 1 ? "" : "s"}, from the stores`);
  }

  /** The (handle, txid, topic) announcements published in this run: a fact handed over again publishes nothing. */
  private announced = new Set<string>();

  /**
   * A fact from `handle` (after its step's commit): `chain/tx/<txid>` → the holder map; the overlay's
   * `<app>/topic/tx/<txid>` with verdict `admitted` → the gossip `admit` (announceAdmitted).
   */
  private followFact(handle: string, rec: Record<string, unknown>): void {
    const name = typeof rec.event === "string" ? rec.event : "";
    const tx = /^chain\/tx\/([0-9a-f]{64})$/.exec(name);
    if (tx) return this.holdingFact(handle, tx[1]!, rec.status);
    const ov = /^([a-z0-9][a-z0-9-]*)\/topic\/tx\/([0-9a-f]{64})$/.exec(name);
    if (ov && rec.verdict === "admitted") this.announceAdmitted(handle, ov[2]!, rec.topics);
  }

  /**
   * SPEC 7/8: the host publishes the gossip `admit` when it sees the overlay's `admitted` fact — per topic the
   * fact's `topics: {<topic>: {outputsToAdmit, coinsToRetain}}` names, `{kind: "admit", txid, topics: {<topic>:
   * …}}` on `<topic>` from the instance's libp2p node (sync.ts admitBody), once per (instance, txid, topic) in
   * this run. A fact with no `topics` publishes nothing here.
   * WAITING ON build C: skein-overlay v0.28.1's fact carries no `topics`; until it does, its admission is
   * published by the overlay itself through the libp2p provider's `publish` box (providers.ts, kept beside this:
   * remove that path when the overlay stops asking for it).
   */
  private announceAdmitted(handle: string, txid: string, topics: unknown): void {
    if (!topics || typeof topics !== "object" || Array.isArray(topics) || topics instanceof Uint8Array) return;
    const p2p = this.p2p;
    if (!p2p) { this.say(handle, `gossip: ${txid.slice(0, 8)} admitted: this host runs no libp2p: not announced`); return; }
    const nums = (v: unknown): number[] | undefined => Array.isArray(v) && v.every((x) => (typeof x === "number" && Number.isInteger(x) && x >= 0) || typeof x === "bigint") ? v.map(Number) : undefined;
    for (const [topic, e] of Object.entries(topics as Record<string, unknown>)) {
      const steak = e as { outputsToAdmit?: unknown; coinsToRetain?: unknown } | null;
      const outputsToAdmit = nums(steak?.outputsToAdmit), coinsToRetain = nums(steak?.coinsToRetain);
      if (!topic || !outputsToAdmit || !coinsToRetain) { this.say(handle, `gossip: ${txid.slice(0, 8)} admitted on ${topic}: not {outputsToAdmit, coinsToRetain}: not announced`); continue; }
      const k = `${handle} ${txid} ${topic}`;
      if (this.announced.has(k)) continue;
      this.announced.add(k);
      if (this.announced.size > 100_000) this.announced.delete(this.announced.values().next().value!);
      const p = p2p.publish(handle, topic, admitBody(txid, topic, { outputsToAdmit, coinsToRetain }))
        .then((r) => this.say(handle, `gossip: ${txid.slice(0, 8)} admit published on ${topic} (${r.recipients} peer${r.recipients === 1 ? "" : "s"})`))
        .catch((x) => { this.announced.delete(k); this.say(handle, `gossip: ${txid.slice(0, 8)} admit on ${topic} not published: ${(x as Error).message}`); });
      this.syncing.add(p);
      void p.finally(() => this.syncing.delete(p));
    }
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
    const ko = {
      db: storeSpec(row), handle: row.handle, domain: row.domain, wallet, command: this.o.kernel?.command, env: this.kernelEnv(),
      log: (line: string) => this.say(handle, line),
      emit: (o: Outgoing) => this.emits.deliver(handle, o),
      answered: (a: Answered) => this.answers.notice(a),
      exited: (code: number | null, signal: string | null) => {
        if (this.loaded.get(handle)?.kernel === kernel) this.loaded.delete(handle);
        if (code !== 0) this.say(handle, `kernel exited (${signal ?? `code ${code}`})`);
      },
    };
    // #158: a RocksDB set is an instance of the host's one kernel process (opened there: hydrate).
    // The settled split (2026-10-31): a SQLite set's machine is the wasm kernel, loaded in this process on a worker.
    // (The one-process-per-instance serve mode is gone: SPEC 5.)
    const rocks = parseRocksSpec(ko.db);
    const sq = parseSqliteSpec(ko.db);
    if (!sq && !rocks) throw new Error(`its store ${ko.db} is no set of the host's SQLite or RocksDB database: the serve mode (a store file of its own) is gone (SPEC 5)`);
    const kernel: KernelSurface = sq ? await this.wasmHost(sq.db).open(ko) : await this.kernelHost(rocks!.dir).open(ko);
    let g: { identity?: unknown } | null;
    try {
      // One loader (SPEC 8): an instance starts from a tree (an image, `skein-host add --boot/--packet`); an empty store is no instance.
      if (!(await kernel.store.log.tip())) throw new Error("its store is empty: an instance starts from a tree (an image, or skein-host add --image/--boot/--packet), and none was loaded into it");
      g = await kernel.genesis() as { identity?: unknown } | null;
      if (!g) throw new Error("the store's log does not start with a genesis this kernel reads (format 3, #40): start a new store (re-genesis)");
      if (keyHex(g.identity) !== identity) throw new Error(`the signer (${short(identity)}) is not this instance's identity (${short(keyHex(g.identity))})`);
      await kernel.start();
      await kernel.running(identity);
      void kernel.idle().catch(() => {}); // busy until what start resumed is done; a kernel that exits meanwhile is reported by its exit
      if (!row.identity) this.o.db.add(row.handle, { identity });
      // SPEC 8: not up until it has been told the chain as far as the host knows it — the first pointer event,
      // straight to the kernel here, before the instance is handed to anyone (not through admitEvent/serial: that
      // would hydrate, and wait on this load). Anything admitted after the load lands after it in the log.
      this.sentChain.delete(handle);
      await this.firstChainEvent(handle, kernel);
    } catch (e) {
      await kernel.stop();
      throw e;
    }
    // #119: the apps' subscriptions, read from the log (the kernel writes nothing for them).
    const subs = await this.foldSubscriptions(storeSpec(row)).catch((e) => { this.say(handle, `libp2p: the subscriptions not read: ${(e as Error).message}`); return [] as Subscription[]; });
    // #126: the apps' beacons, read from the log the same way.
    const beacons = await this.foldBeacons(storeSpec(row)).catch((e) => { this.say(handle, `libp2p: the beacons not read: ${(e as Error).message}`); return [] as Beacon[]; });
    // #138: the apps' liveness, read from the log the same way.
    const live = await this.readLiveness(storeSpec(row)).catch((e) => { this.say(handle, `libp2p: the liveness not read: ${(e as Error).message}`); return [] as Live[]; });
    const l: Loaded = { row, kernel, identity, wallet, genesis: g as Record<string, unknown>, subs, beacons, live };
    // Its node (its apps' membership), before anything it runs can publish.
    await this.syncDispatch(l, true);
    this.loaded.set(handle, l);
    // The settled sync design: the peers each overlay topic's beats came from (host.db), asked at once.
    if (this.sync) void this.askKnownPeers(l).catch((e) => this.say(handle, `sync: the known peers not asked: ${(e as Error).message}`));
    this.say("router", `hydrated ${handle} (${short(identity)})`);
    return l;
  }

  /**
   * Boot a row's empty store from a system tree or a checkpoint (issue #4, boot.ts) before its first
   * hydration; the row's identity is its signer's. `owner` (hex): born owned — root granted to it in
   * the genesis, no claim row. `appConfig`: the apps' config at birth.
   */
  async bootRow(handle: string, src: BootSource, o: { owner?: string; appConfig?: GenesisConfig["appConfig"] } = {}): Promise<Booted> {
    const row = this.o.db.get(handle);
    if (!row) throw new Error(`no instance ${handle}`);
    if (this.loaded.has(handle)) throw new Error(`${handle} is loaded: boot only an empty store`);
    const identity = await rootIdentity(await this.o.walletFor(row));
    const c: GenesisConfig = { ...this.imageConfig(row, identity, o.owner), ...(o.appConfig ? { appConfig: o.appConfig } : {}) };
    const b = await bootStore({ db: storeSpec(row), handle: row.handle, domain: row.domain, command: this.o.kernel?.command, env: this.kernelEnv(), log: (l) => this.say(handle, l) }, src, c, this.now());
    this.o.db.add(row.handle, { identity, ...(b.tree ? { tree: b.tree.toString() } : {}) });
    return b;
  }

  /**
   * What this host brings to an image's genesis (SPEC 3: who builds the image decides what the starting
   * table holds; this host builds it from the image and its own facts): the instance's identity,
   * handle and domain, the host's defaults and network, and the grants it adds — `chain.status` for
   * its status service key (SPEC 6: the rejected row's role; the planner's call, David to review) and,
   * for an instance born owned, `root` for `owner`.
   */
  imageConfig(row: Pick<InstanceRow, "handle" | "domain">, identity: string, owner?: string): GenesisConfig {
    return {
      identity, handle: row.handle, domain: row.domain, network: this.o.network,
      grants: { [STATUS_ROLE]: [this.statusKey()], ...(owner ? { root: [owner] } : {}) },
      defaults: this.o.genesis?.defaults, overrides: this.o.fuelPerStep ? { fuelPerStep: this.o.fuelPerStep } : undefined,
      warn: (l) => this.say(row.handle, l),
    };
  }

  /**
   * #162: the image a create names, as a boot source — the built-in `default`, or a directory
   * `<imagesDir>/<name>` (SKEIN_IMAGES_DIR, default $SKEIN_HOME/images; with no etc/routes.json merged
   * over the default image, with it a complete image). Its path resolved first.
   */
  private async namedImage(name: string | undefined): Promise<BootSource> {
    if (name === undefined || name === "default") return await namedImageSource({});
    const dir = this.imageDir(name);
    if (!dir) throw new Error(`image ${JSON.stringify(name)}: this host has the default image${this.o.imagesDir ? ` and the images in ${this.o.imagesDir}` : ""}`);
    return isOverlayImage(dir) ? await namedImageSource({ overlay: dir }) : await imageSource(dir);
  }

  /** #162: an image by name: its directory under imagesDir (resolved), or undefined. */
  private imageDir(name: string): string | undefined {
    if (!this.o.imagesDir || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return undefined;
    try {
      const d = realpathSync(join(this.o.imagesDir, name));
      return statSync(d).isDirectory() ? d : undefined;
    } catch { return undefined; } // no such image here
  }

  /** Whether `owner` holds root on the instance (the head `grants`): claimed by that key. */
  private async claimedBy(l: Loaded, owner: string): Promise<boolean> {
    const root = await l.kernel.call("head", "grants") as CID | null;
    if (!root) return false;
    const g = await l.kernel.store.get(root).catch(() => undefined) as { roles?: Record<string, unknown[]> } | undefined;
    return (g?.roles?.root ?? []).some((k) => k instanceof Uint8Array && Buffer.from(k).toString("hex") === owner);
  }

  /**
   * A new instance from an image, for `owner`. In this order: the row, disabled (no hostname: nothing
   * reaches it); its identity derived (the signer's, key ID = the handle) and its store booted from the
   * image; its kernel started unpublished; then:
   *
   *   `owned`   born owned (#164): root granted to `owner` in the genesis, no claim row (the image's is
   *             dropped);
   *   `claim`   the owner's own signed claim (a request record to the image's claim row, /kernel/claim,
   *             signed by the owner to the instance's identity: src/client/raw.ts signClaim), handed
   *             in as the instance's first arrival after the genesis — the kernel grants root to its
   *             sender and removes the claim row in the same step;
   *   `needsClaim` with no claim on a one-key host (`claimer`): the host's own key signs it;
   *   none      the instance keeps its claim row: the first claim's sender owns it.
   *
   * Only then (`publish`, default true) the row enabled, which publishes its hostname. `domain`: the
   * handle's domain (default the host's). A refusal throws (a bad or taken handle, a bad key, another
   * image, a claim not `owner`'s or refused: the row is left disabled, its store kept for a look).
   */
  async createInstance(handle: string, owner: string, o: { image?: string; owned?: boolean; publish?: boolean; domain?: string; claim?: RequestRecord; needsClaim?: boolean; appConfig?: GenesisConfig["appConfig"]; topics?: string[] } = {}): Promise<{ handle: string; identity: string; url: string }> {
    if (!validHandle(handle)) throw new Error(`handle ${JSON.stringify(handle)}: lower-case letters, digits and "-", at most 63, as a hostname label; or a token id <txid>_<vout> (path-only, #161)`);
    if (this.reserved(handle)) throw new Error(`handle ${handle} is reserved`);
    if (!KEY.test(owner)) throw new Error("owner: not an identity key (33 bytes)");
    if (o.image !== undefined && o.image !== "default" && !this.imageDir(o.image)) throw new Error(`image ${JSON.stringify(o.image)}: this host has the default image${this.o.imagesDir ? ` and the images in ${this.o.imagesDir}` : ""}`);
    if (o.domain !== undefined && !DOMAIN.test(o.domain)) throw new Error(`domain ${JSON.stringify(o.domain)}: a host name, lower case`);
    if (o.owned && (o.claim !== undefined || o.needsClaim)) throw new Error("an owned instance is born owned (#164): no claim");
    if (o.claim !== undefined) claimProblem(o.claim, owner);
    if (!o.owned && !o.claim && o.needsClaim && !this.o.claimer) throw new Error("claim: the owner's signed claim (a request to /kernel/claim signed by the owner), or a one-key host's own");
    if (this.o.db.get(handle)) throw new Error(`handle ${handle} is taken`);
    const store = this.newStore(handle);
    if (storeExists(storeSpec({ store, handle }))) throw new Error(`handle ${handle}: a store is at ${storeSpec({ store, handle })} already`);
    this.o.db.add(handle, { store, status: "disabled", domain: o.domain ?? this.domain(), ...(o.topics?.length ? { topics: JSON.stringify(o.topics) } : {}) }); // #137: the names it is routed by
    this.unpublished.add(handle);
    try {
      await this.bootRow(handle, await this.namedImage(o.image), { ...(o.owned ? { owner } : {}), ...(o.appConfig ? { appConfig: o.appConfig } : {}) });
      const l = await this.hydrate(handle);
      let claim = o.claim;
      // #162: a one-key host claims what it creates itself — the claim signed by its shared key (the owner).
      if (!claim && !o.owned && o.needsClaim && this.o.claimer) {
        const me = (await this.o.claimer.getPublicKey({ identityKey: true })).publicKey;
        if (owner !== me) throw new Error(`owner: on a one-key host the claim is the host's own key's (${short(me)}): name it, or give the owner's signed claim`);
        claim = await signClaim(this.o.claimer, l.identity);
      }
      if (claim) {
        try {
          await this.messageLocal(handle, claim);
        } catch (e) {
          throw new Error(`the claim was refused (${(e as Error).message}); ${handle} is left disabled`);
        }
        if (!(await this.claimedBy(l, owner))) throw new Error(`the claim was taken but root is not ${short(owner)} (its log says why); ${handle} is left disabled`);
      }
      if (o.publish !== false) this.o.db.setStatus(handle, "enabled");
      const tip = this.sentChain.has(handle) ? await l.kernel.chainTip() : undefined;
      this.say("router", `created ${handle} (${short(l.identity)}) from the ${o.image ?? "default"} image${tip ? ` (its chain to ${tip.height})` : ""}, ${o.owned ? `owned by ${short(owner)} (born owned, #164)` : claim ? `claimed by ${short(owner)}${o.claim === undefined ? " (the host's own key, #162)" : ""}` : "unclaimed (its claim row from anyone)"}${o.publish !== false ? `, at ${this.originOf(handle)}` : ""}`);
      return { handle, identity: l.identity, url: this.originOf(handle) };
    } finally {
      this.unpublished.delete(handle);
    }
  }

  /** host.db's `store` for a new instance: its set in the host's shared store (SQLite, RocksDB). */
  private newStore(handle: string): string {
    if (this.o.sqliteStore) return `sqlite:${this.o.sqliteStore}`; // the settled split: the wasm kernel
    if (this.o.rocksStore) return `rocksdb:${this.o.rocksStore}`; // #158
    // No shared store named: a SQLite database under the host's home (the serve mode is gone, SPEC 5).
    return `sqlite:${join(this.o.home ?? ".", "instances.db")}`;
  }

  /**
   * Start an instance (skein next, SPEC 8: the host's own action): its row enabled — published under its
   * hostname — and its kernel hydrated (told the chain inside the load). `topics` (#137) replaces the overlay
   * names the row is routed by at the bare host; absent keeps them. Throws for no such row or bad topics.
   */
  async startInstance(handle: string, o: { topics?: string[] } = {}): Promise<{ handle: string; started: true; url: string }> {
    const row = this.o.db.get(handle);
    if (!row) throw new Error(`no instance ${handle}`);
    const topics = topicsArg(o.topics);
    if (topics) this.o.db.setTopics(handle, topics);
    this.o.db.setStatus(handle, "enabled");
    await this.hydrate(handle);
    this.say("router", `${handle}: started`);
    return { handle, started: true, url: this.originOf(handle) };
  }

  /**
   * Stop an instance (skein next, SPEC 8: the host's own action): its row disabled (no hostname: nothing
   * reaches it), its kernel stopped, off its libp2p node (its beacons stop beating, skein-amm#4) and its
   * event streams closed. A start's hydrate declares it again. Throws for no such row.
   */
  async stopInstance(handle: string): Promise<{ handle: string; stopped: true }> {
    if (!this.o.db.get(handle)) throw new Error(`no instance ${handle}`);
    this.o.db.setStatus(handle, "disabled");
    const l = this.loaded.get(handle);
    if (l) { this.loaded.delete(handle); await l.kernel.stop(); }
    await this.p2p?.declare(handle, undefined).catch(() => {});
    this.events.drop(handle);
    this.say("router", `${handle}: stopped`);
    return { handle, stopped: true };
  }

  /**
   * The kernel counts as busy until it has processed what was just committed (its `idle` answers after
   * the drain); then the libp2p node and the chain pointer event follow the route table.
   */
  private settle(l: Loaded): void {
    const p = l.kernel.idle().then(() => this.syncDispatch(l)).catch((e) => this.say(l.row.handle, `the route table not followed: ${(e as Error).message}`));
    this.syncing.add(p);
    void p.finally(() => this.syncing.delete(p));
  }

  /**
   * What the host does by the instance's route table: read it (the kernel's `routes` frame); when it
   * moved since it was last followed (or `first`), an uninstalled app's beacons and liveness stop, the
   * libp2p node is declared again, and (not `first`: the load sent it) an app that takes the event
   * `chain` installed into the running instance gets the chain pointer event now (chainBirth; one
   * already sent is not sent again). A failure is logged, not fatal.
   */
  private async syncDispatch(l: Loaded, first = false): Promise<void> {
    if (l.kernel.gone) return;
    const d = await l.kernel.routes().catch((e) => { this.say(l.row.handle, `the route table not read: ${(e as Error).message}`); return undefined; });
    if (d === undefined) return;
    const key = d.tip ? d.tip.toString() : "";
    if (!first && key === (l.dispatchTip ?? "")) return;
    l.dispatchTip = key;
    l.rows = d.rows as DispatchRow[];
    if (!first && takesEvent(l.rows, CHAIN_EVENT)) void this.chainBirth(l.row.handle).catch((e) => this.say(l.row.handle, `host chain: the install event not sent: ${(e as Error).message}`));
    // #126: an uninstalled app's beacons stop — an app with no row left in the table.
    if (l.beacons.length || l.live.length) {
      const apps = appsOf(l.rows);
      l.beacons = l.beacons.filter((b) => apps.has(b.app));
      l.live = l.live.filter((x) => apps.has(x.app)); // #138: and its liveness
    }
    await this.declareP2P(l, first);
  }

  /** The instance's libp2p node declared as its apps' membership asks (SPEC 7: the topics they subscribe; a beacon or liveness needs the node). */
  private async declareP2P(l: Loaded, first = false): Promise<void> {
    if (!this.p2p) return;
    await this.p2p.declare(l.row.handle, libp2pConfig(subscribedTopics(l.subs), l.beacons.length > 0 || l.live.length > 0)).catch((e) => this.say(l.row.handle, `libp2p: ${first ? "not started" : "not reconfigured"}: ${(e as Error).message}`));
    this.p2p.beacons(l.row.handle, l.beacons);
    this.p2p.liveness(l.row.handle, l.live);
  }

  /** #138: the apps' liveness, folded from the instance's log (liveness.ts livenessOf), the store file read-only. */
  private async readLiveness(store: string): Promise<Live[]> {
    if (!this.p2p || !storeExists(store)) return [];
    const s = openStoreFile(store, { readOnly: true });
    try { return await livenessOf(s); } finally { s.close(); }
  }

  /** #126: the apps' beacons, folded from the instance's log (p2p.ts beaconsOf), the store file read-only. */
  private async foldBeacons(store: string): Promise<Beacon[]> {
    if (!this.p2p || !storeExists(store)) return [];
    const s = openStoreFile(store, { readOnly: true });
    try { return await beaconsOf(s); } finally { s.close(); }
  }

  /**
   * #119: the apps' subscriptions, folded from the instance's log — the
   * libp2p node's recovery at hydrate, by reading (p2p.ts subscriptionsOf;
   * the store file opened read-only beside the kernel, as `subscribes` reads it).
   */
  private async foldSubscriptions(store: string): Promise<Subscription[]> {
    if (!this.p2p || !storeExists(store)) return [];
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
      this.say(handle, `libp2p: ${e.event} ${topic} (app ${app})`);
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
   * liveness on the topic, served by the host — no program, no entry, nothing logged. 404 when the app keeps no liveness for the topic (or the host has no libp2p).
   */
  private async liveRead(handle: string, route: string, app: string, topic: string): Promise<RouterResponse> {
    const none = () => json(404, { status: "error", code: "ERR_NOT_FOUND", description: `app ${app} keeps no liveness for ${topic}` });
    if (!this.p2p) return none();
    try { await this.hydrate(handle); } catch (e) { return json(503, { status: "error", code: "ERR_UNAVAILABLE", description: (e as Error).message }); }
    const beats = this.p2p.live.read(handle, app, topic);
    if (!beats) return none();
    const r = json(200, beats.map((b) => ({ sender: b.sender, at: b.at, body: Buffer.from(b.body).toString("base64"), from: b.from })));
    return r;
  }

  /**
   * GET /events/<name path> at an instance's origin (0.5.0, events.ts): the instance's event index,
   * read from its store by CID — no step, no fuel, no entry. Answered as JSON.
   */
  private async eventsRead(handle: string, route: string, url: URL): Promise<RouterResponse> {
    const q = eventsQuery(route, url.searchParams);
    if (!q) return json(404, { status: "error", code: "ERR_NOT_FOUND", description: `no route ${route}` });
    if ("problem" in q) return json(400, { status: "error", code: "ERR_BAD_REQUEST", description: q.problem });
    if (this.stopped) return json(503, { status: "error", code: "ERR_UNAVAILABLE", description: "the host is shutting down" });
    try { await this.hydrate(handle); } catch (e) { return json(503, { status: "error", code: "ERR_UNAVAILABLE", description: (e as Error).message }); }
    const rows = await this.events.read(handle, q);
    const body = new TextEncoder().encode(`[${rows.map((d) => `{"id":${JSON.stringify(d.id)},"event":${JSON.stringify(d.event)},"record":${d.data}}`).join(",")}]`);
    return { status: 200, headers: { "content-type": "application/json" }, body };
  }

  /**
   * GET /events/<name path> with Accept: text/event-stream (0.5.0, events.ts): the same read as a
   * Server-Sent Events stream, then each matching event as it is handed over — held open until the
   * client goes or the instance stops. The host's own (no program, no entry, nothing logged).
   */
  private async eventStream(handle: string, route: string, url: URL, req: IncomingMessage, res: ServerResponse, cors: Record<string, string>): Promise<void> {
    const answer = (r: RouterResponse) => { if (!res.headersSent) { res.writeHead(r.status, { ...cors, ...r.headers, "content-length": String(r.body.length) }); res.end(r.body); } };
    try {
      const last = req.headers["last-event-id"];
      const q = eventsQuery(route, url.searchParams, Array.isArray(last) ? last[0] : last);
      if (!q) return answer(json(404, { status: "error", code: "ERR_NOT_FOUND", description: `no route ${route}` }));
      if ("problem" in q) return answer(json(400, { status: "error", code: "ERR_BAD_REQUEST", description: q.problem }));
      if (this.stopped) return answer(json(503, { status: "error", code: "ERR_UNAVAILABLE", description: "the host is shutting down" }));
      try { await this.hydrate(handle); } catch (e) { return answer(json(503, { status: "error", code: "ERR_UNAVAILABLE", description: (e as Error).message })); }
      res.writeHead(200, { ...cors, "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.flushHeaders();
      let forget: (() => void) | undefined;
      let gone = false;
      res.on("close", () => { gone = true; forget?.(); });
      const send = (d: Delivered) => { res.write(sseMessage(d)); };
      forget = await this.events.subscribe(handle, q, send, () => res.end());
      if (gone) forget();
    } catch (e) {
      this.say(handle, `events: ${(e as Error).message}`);
      if (res.headersSent) res.end(); else answer(json(500, { status: "error", code: "ERR_INTERNAL", description: (e as Error).message }));
    }
  }

  /** How long a peer that beat on a topic is remembered without beating again (ms): 30 days (David to review). */
  static readonly PEER_KEEP_MS = 30 * 86_400_000;

  /**
   * A beat kept from `peer` on `liveTopic` at `handle` (the settled sync design): when an overlay app
   * of the instance beats on that topic, the peer and its addresses (the node's peer store) upserted
   * into host.db `topic_peers`, keyed by the overlay topic. What a restart asks first.
   */
  private async rememberPeer(handle: string, liveTopic: string, peer: string): Promise<void> {
    if (!liveTopic.endsWith("-live") || !this.p2p) return;
    if (!this.loaded.get(handle)?.beacons.some((b) => b.topic === liveTopic)) return;
    try {
      this.o.db.seenPeer(handle, liveTopic.slice(0, -"-live".length), peer, await this.p2p.peerAddrs(handle, peer), stampMs(this.now()));
    } catch (e) { this.say(handle, `sync: peer ${peer} not remembered: ${(e as Error).message}`); }
  }

  /**
   * At a start (hydrate): for each overlay topic the instance beats on, the peers host.db remembers
   * (rows older than PEER_KEEP_MS pruned first) dialled, a few at a time, failures dropped silently;
   * each that answers asked at once — the locator and the tail (sync.ts `reconnect`) — without waiting
   * for a beat.
   */
  private async askKnownPeers(l: Loaded): Promise<void> {
    const handle = l.row.handle;
    if (!this.p2p || !this.sync) return;
    this.o.db.prunePeers(stampMs(this.now()) - Router.PEER_KEEP_MS);
    const jobs: Array<{ app: string; topic: string; peer: string; addrs: string[] }> = [];
    for (const b of l.beacons) {
      if (!b.topic.endsWith("-live")) continue;
      const topic = b.topic.slice(0, -"-live".length);
      for (const r of this.o.db.topicPeers(handle, topic)) if (r.peer !== this.p2p.peerId(handle)) jobs.push({ app: b.app, topic, peer: r.peer, addrs: r.addrs });
    }
    const p2p = this.p2p, sync = this.sync;
    const one = async (j: (typeof jobs)[number]) => {
      try { await p2p.connect(handle, j.peer, j.addrs); } catch { return; } // a peer gone: dropped silently
      sync.reconnect(handle, j.app, j.topic, j.peer);
    };
    for (let i = 0; i < jobs.length; i += 4) await Promise.all(jobs.slice(i, i + 4).map(one));
  }

  /**
   * Our own overlay's read, for the sync's puller (its locator, what it lacks, whether it holds a
   * transaction): the overlay's read row `/<app>/<fn>` (SPEC 7 [P]: the reads are read rows, role
   * anyone) asked through CHECK — nothing written — with the query; its answer's JSON body, or a throw
   * on another status.
   */
  private async overlayRead(handle: string, app: string, fn: "anchors" | "admitted" | "holds", query: Record<string, string>): Promise<unknown> {
    const qs = new URLSearchParams(query).toString();
    const o = await this.carryIn(handle, { request: { kind: "request", payload: { method: "GET", path: `/${app}/${fn}`, query: qs ? `?${qs}` : "", headers: {}, body: new Uint8Array() } } });
    const a = httpOf(o);
    const text = new TextDecoder().decode(a.body);
    if (a.status !== 200) throw new Error(`${app}.${fn}: ${a.status} ${text.slice(0, 200)}`);
    return JSON.parse(text);
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

  /** Stop kernels idle for `ms` with nothing queued. */
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

  /** Which instance a URL is for: `/@<handle>` (stripped for the routes), or a `<handle>.` host name. */
  target(url: URL): { handle: string; route: string } | undefined {
    const enabled = (h: string) => this.o.db.get(h)?.status === "enabled";
    const m = /^\/@([^/]+)(\/.*)?$/.exec(url.pathname);
    if (m) { const h = decodeURIComponent(m[1]!); return enabled(h) ? { handle: h, route: m[2] ?? "/" } : undefined; }
    const name = url.hostname.toLowerCase();
    const label = name.includes(".") ? name.split(".")[0]! : "";
    if (label && HANDLE.test(label) && (label !== this.ownLabel() || this.ownLabelInstance(label)) && enabled(label)) return { handle: label, route: url.pathname }; // #161: a path-only handle never by hostname
    return undefined;
  }

  /** One request, whoever made it: a socket's, or an instance's own http. */
  async dispatch(req: RouterRequest): Promise<RouterResponse> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/.well-known/skein-host") {
      return json(200, { origin: this.origin(), domain: this.domain() });
    }
    const t = this.target(url);
    // The router's own paths at its own hostname stay the router's when the root instance takes that label (ownLabelInstance).
    if (t && !/^\/@/.test(url.pathname) && this.ownLabelInstance(t.handle)) {
      if (req.method === "GET" && url.pathname === "/skeins") return await this.skeinsHeldBy(url.searchParams.get("key") ?? "");
      if (url.pathname === `${ARC_ROUTE}/callback`) return await this.arcRequest(req, url.pathname);
    }
    // #161: an overlay request routed by its topic goes to the token instance it names, at an instance's
    // hostname too (one public name for the pages and the wallets' provider URL, 2026-10-28).
    if (req.method === "POST" && (url.pathname === "/submit" || url.pathname === "/lookup") && (!t || t.route === url.pathname)) {
      const o = this.overlayTarget(url.pathname, req);
      if ("problem" in o) return json(400, { status: "error", code: "ERR_BAD_REQUEST", description: o.problem });
      if (o.handle) {
        // An application host answers its instance's overlay door first (appRead), as at the instance's own paths.
        if (this.o.appRead) {
          const a = await this.o.appRead(o.handle, url.pathname, url, req);
          if (a) return a;
        }
        return await this.held(this.forward(o.handle, url.pathname, url, req));
      }
    }
    const serve = async (x: { handle: string; route: string }): Promise<RouterResponse> => {
      // The instance's own card, the host's read (no program): whether anyone holds root yet.
      if (req.method === "GET" && x.route === "/.well-known/skein") return await this.instanceCard(x.handle);
      // #138: the liveness tool's read, the host's own (no program).
      const live = req.method === "GET" ? /^\/([^/]+)\/\.live\/([^/]+)$/.exec(x.route) : null;
      if (live) return await this.held(this.liveRead(x.handle, x.route, decodeURIComponent(live[1]!), decodeURIComponent(live[2]!)));
      // 0.5.0: the event index, the host's own read (no program); a stream is served on a socket only (handler).
      if (req.method === "GET" && eventsPath(x.route)) {
        if (/text\/event-stream/.test(req.headers["accept"] ?? "")) return json(400, { status: "error", code: "ERR_BAD_REQUEST", description: "an event stream (text/event-stream) is served on a connection of its own, not in process" });
        return await this.held(this.eventsRead(x.handle, x.route, url));
      }
      // An application host's own requests (appRead, every method since 0.3.2): before the instance's program; undefined falls through.
      if (this.o.appRead) {
        const a = await this.o.appRead(x.handle, x.route, url, req);
        if (a) return a;
      }
      return await this.held(this.forward(x.handle, x.route, url, req));
    };
    if (t) return await serve(t);
    const path = url.pathname;
    if (req.method === "GET" && path === "/skeins") return await this.skeinsHeldBy(url.searchParams.get("key") ?? "");
    if (path === `${ARC_ROUTE}/callback`) return await this.arcRequest(req, path);
    // SKEIN_ROOT_INSTANCE: a hostname that is no instance's serves the root instance (the standalone's one app at
    // localhost:<port>/) — every path but the router's own three above (.well-known/skein-host, /skeins, the ARC
    // callback); its handshake (/.well-known/auth) is the root instance's.
    const root = this.o.rootInstance;
    if (root && this.o.db.get(root)?.status === "enabled") return await serve({ handle: root, route: path });
    return json(404, { status: "error", code: "ERR_NOT_FOUND", description: "no instance here: an instance is at http://<handle>.localhost:<port>/ or /@<handle>/" });
  }

  /**
   * #161, #137: an overlay request at the bare host — POST /submit (the topics its X-Topics names: a
   * comma list or a JSON array, as the overlay reads it) or POST /lookup (its JSON body's `service`,
   * and a `topic` beside it or in its query) — routed to the instance that serves the names:
   *
   *   - a token's name, `tm_color_<id>` / `ls_color_<id>` whose `<id>` is an enabled path-only
   *     instance here: that instance (#161, the handle naming convention; checked first);
   *   - any other name (`tm_color`, `ls_color`, …): the enabled instance whose `topics` (the
   *     names the instance manager's create or start named, host.db) contain it. Whether the instance
   *     has run yet does not matter. Two instances taking the same name: a problem (400, "N instances
   *     here take <name>").
   *
   * Every name that maps must map to the same instance (else a problem: 400); a name mapping to no
   * instance here beside one that does is a problem too. Nothing maps: no handle (the hostname's
   * instance, or the bare host, as before).
   */
  overlayTarget(path: "/submit" | "/lookup", req: RouterRequest): { handle?: string } | { problem: string } {
    const names: string[] = [];
    if (path === "/submit") {
      const h = (req.headers["x-topics"] ?? "").trim();
      if (!h) return {};
      if (h.startsWith("[")) {
        let j: unknown;
        try { j = JSON.parse(h); } catch { return {}; } // the overlay's own refusal, at no instance: the bare host's
        if (!Array.isArray(j)) return {};
        for (const t of j) if (typeof t === "string") names.push(t);
      } else names.push(...h.split(",").map((x) => x.trim()).filter(Boolean));
    } else {
      let j: Record<string, unknown> | undefined;
      try { j = JSON.parse(new TextDecoder().decode(req.body)) as Record<string, unknown>; } catch { return {}; }
      if (!j || typeof j !== "object") return {};
      const q = j.query as Record<string, unknown> | undefined;
      for (const t of [j.service, j.topic, q && typeof q === "object" ? q.topic : undefined]) if (typeof t === "string") names.push(t);
    }
    const enabled = (h: string) => this.o.db.get(h)?.status === "enabled";
    const rows = this.o.db.list("enabled");
    const mapped: Array<string | undefined> = [];
    for (const name of names) {
      const id = /^(?:tm|ls)_color_(.+)$/.exec(name)?.[1];
      if (id && TOKEN_HANDLE.test(id) && enabled(id)) { mapped.push(id); continue; }
      const by = rows.filter((r) => topicsOf(r).includes(name)).map((r) => r.handle);
      if (by.length > 1) return { problem: `${by.length} instances here take ${name} (${by.join(", ")}): send it to one of them (/@<handle>/${path.slice(1)})` };
      mapped.push(by[0]);
    }
    const hit = [...new Set(mapped.filter((x): x is string => !!x))];
    if (!hit.length) return {};
    if (hit.length > 1) return { problem: `the names map to ${hit.length} instances here (${hit.join(", ")}): one request goes to one; send one per instance` };
    const stray = names.filter((_, i) => !mapped[i]);
    if (stray.length) return { problem: `${stray.join(", ")}: no instance here takes ${stray.length > 1 ? "these" : "it"} beside ${hit[0]}: send one request per instance` };
    return { handle: hit[0]! };
  }

  /**
   * GET /skeins?key=<hex> at the host's own origin: the skeins on this host whose head `grants`
   * (#143) names `key` among root's holders — each enabled agent row's store file read read-only,
   * no kernel — as JSON [{handle, identity, url}]. A key's skeins are the host's to say (no token
   * in a wallet tracks them). Unsigned, anyone.
   */
  private async skeinsHeldBy(key: string): Promise<RouterResponse> {
    if (!/^0[23][0-9a-f]{64}$/.test(key)) return json(400, { status: "error", code: "ERR_BAD_REQUEST", description: "key: an identity key (33 bytes, hex)" });
    const out: Array<{ handle: string; identity: string; url: string }> = [];
    for (const row of this.o.db.list("enabled")) {
      if (!row.identity) continue;
      if ((await this.rootsOf(row)).includes(key)) out.push({ handle: row.handle, identity: row.identity, url: this.originOf(row.handle) });
    }
    return json(200, out);
  }

  /**
   * GET /.well-known/skein at an instance's origin (its hostname, `/@<handle>/`, or the root instance's
   * hostname): `{handle, identity, origin, claimed}` — `claimed` whether its head `grants` names a root
   * holder (an image instance nobody has claimed: false). Read from its store read-only, no kernel, as
   * /skeins does. Unsigned, anyone; 404 for no instance. "Am I root" is /skeins?key=<identity>.
   */
  private async instanceCard(handle: string): Promise<RouterResponse> {
    const row = this.o.db.get(handle);
    if (!row?.identity) return json(404, { status: "error", code: "ERR_NOT_FOUND", description: `no instance ${handle} here` });
    return json(200, { handle, identity: row.identity, origin: this.originOf(handle), claimed: (await this.rootsOf(row)).length > 0 });
  }

  /** The keys an instance's head `grants` names root (#143), its store read read-only; none when it has no store yet. */
  private async rootsOf(row: { handle: string; store: string }): Promise<string[]> {
    const spec = storeSpec(row);
    if (!storeExists(spec)) return [];
    const s = openStoreFile(spec, { readOnly: true });
    try { return await rootOf(s); } catch { return []; } finally { s.close(); }
  }

  /** A forwarded request, held among the in-flight ones (shutdown answers them 503). */
  private async held(p: Promise<RouterResponse>): Promise<RouterResponse> {
    this.inflight.add(p);
    try { return await p; } finally { this.inflight.delete(p); }
  }

  /** Arcade's webhook (#58, arc.ts); 404 when the host has no Arcade. */
  private async arcRequest(req: RouterRequest, path: string): Promise<RouterResponse> {
    if (!this.arc) return json(404, { status: "error", code: "ERR_NOT_FOUND", description: "this host has no Arcade" });
    if (req.method === "POST") return await this.arc.callback(req.headers, req.body);
    return json(404, { status: "error", code: "ERR_NOT_FOUND", description: `no ${req.method} ${path}` });
  }

  /** The paths of `handle`'s overlays' sync rows (syncPath of each app that beacons): the host's own carrier's rows, not offered over HTTP (SPEC 7 [P]). */
  private syncRows(handle: string): Set<string> {
    return new Set((this.loaded.get(handle)?.beacons ?? []).map((b) => syncPath(b.app)));
  }

  /**
   * A request for an instance (SPEC 2, 4, 8): the BRC-103 handshake answered here (POST
   * /.well-known/auth, nothing logged); any other request made ONE record — the path exactly as the
   * client sent it, the x-bsv-auth-* headers gathered into its signature — and carried through CHECK
   * and COMMIT, the client's connection held until the handler answers (the connection is the only
   * timer: a client that goes ends the wait; the host shutting down answers 503). A signed request on
   * a session the host does not hold: 401 before the kernel is asked. A signed request's answer is
   * signed on its session. A read's fuel and a refusal's go to the ledger.
   */
  private async forward(handle: string, route: string, url: URL, req: RouterRequest): Promise<RouterResponse> {
    if (this.stopped) return unavailable("the host is shutting down");
    let l: Loaded;
    try { l = await this.hydrate(handle); } catch (e) { return json(503, { status: "error", code: "ERR_UNAVAILABLE", description: (e as Error).message }); }
    if (route === HANDSHAKE_PATH) {
      if (req.method !== "POST") return json(405, { status: "error", code: "ERR_METHOD", description: `${HANDSHAKE_PATH} takes POST (the BRC-103 handshake)` });
      return await handshake(this.sessions, handle, l.wallet, req.body);
    }
    if (this.syncRows(handle).has(route)) return json(404, { status: "error", code: "ERR_NOT_FOUND", description: `${route} is the host's sync row: not offered here` });
    const p: Payload = { method: req.method, path: url.pathname, query: url.search, headers: req.headers, body: req.body };
    const rec = requestRecord(p);
    if ("problem" in rec) return json(400, { status: "error", code: "ERR_AUTH_MALFORMED", description: rec.problem });
    const session = rec.auth ? this.sessions.get(handle, rec.auth.yourNonce) : undefined;
    if (rec.auth && (!session || session.client !== rec.auth.identityKey)) return sessionGone();
    let a: HttpAnswer;
    try { a = httpOf(await this.carryIn(handle, { request: rec.record }, req.signal)); } catch (e) { return json(503, { status: "error", code: "ERR_UNAVAILABLE", description: (e as Error).message }); }
    if (rec.auth && session) a = await signReply(l.wallet, session, rec.auth.requestId, a);
    return a;
  }

  /** The HTTP handler: CORS, then dispatch. */
  handler(): (req: IncomingMessage, res: ServerResponse) => void {
    return (req, res) => {
      const cors: Record<string, string> = {
        "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*", "access-control-expose-headers": "*",
      };
      if (req.method === "OPTIONS") { res.writeHead(200, cors).end(); return; }
      // 0.5.0: an event stream is held open, not buffered.
      if (req.method === "GET" && /text\/event-stream/.test(req.headers.accept ?? "")) {
        const url = new URL(`http://${req.headers.host ?? `127.0.0.1:${this.port}`}${req.url ?? "/"}`);
        const t = this.target(url);
        if (t && eventsPath(t.route)) { void this.eventStream(t.handle, t.route, url, req, res, cors); return; }
      }
      // 0.3.2: the client's connection closing before the answer is written (the response's `close`
      // with nothing ended: the request's own `close` also fires once its body is read) aborts req.signal.
      const gone = new AbortController();
      res.on("close", () => { if (!res.writableEnded) gone.abort(new Error("the client closed the connection")); });
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const url = `http://${req.headers.host ?? `127.0.0.1:${this.port}`}${req.url ?? "/"}`;
        this.dispatch({ method: req.method ?? "GET", url, headers: headerMap(req.headers), body: new Uint8Array(Buffer.concat(chunks)), signal: gone.signal })
          .then((r) => {
            if (!r.stream) { res.writeHead(r.status, { ...cors, ...r.headers, "content-length": String(r.body.length) }); res.end(r.body); return; }
            // A response held open (an appRead's event stream): written as it comes, until either side ends it.
            if (res.destroyed) return;
            res.writeHead(r.status, { ...cors, ...r.headers });
            res.flushHeaders();
            let forget: (() => void) | undefined;
            let gone = false;
            const leave = () => { if (gone) return; gone = true; forget?.(); };
            res.on("close", leave);
            forget = r.stream((chunk) => { if (!gone) res.write(chunk); }, () => { if (!gone) res.end(); });
            if (gone) forget();
          })
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

/** A create's `claim` ({message, body}), checked for its shape (throws; undefined: missing). */
/**
 * The instance manager's `topics` (#137): the overlay names (gossip topics and lookup services alike)
 * the host routes to the instance at the bare host — plain non-empty strings, no duplicates; absent → undefined.
 */
function topicsArg(v: unknown): string[] | undefined {
  if (v == null) return undefined;
  if (!Array.isArray(v) || v.some((t) => typeof t !== "string" || !t) || new Set(v).size !== v.length) throw new Error("topics: the overlay names the host routes to it, [text, …], each non-empty, no duplicates");
  return v as string[];
}

/** Why a claim cannot be handed in for `owner` (throws): not a signed request to the claim row, another sender. The signature is the kernel's to check. */
function claimProblem(c: RequestRecord, owner: string): void {
  if (!c || c.kind !== "request" || !c.payload) throw new Error("claim: a request record (src/client/raw.ts signClaim)");
  if (c.payload.path !== CLAIM_PATH) throw new Error(`claim: a request to ${CLAIM_PATH}`);
  const sig = c.signature as { scheme?: unknown; sender?: unknown } | undefined;
  if (sig?.scheme !== "signed" || !(sig.sender instanceof Uint8Array)) throw new Error("claim: signed (the `signed` scheme)");
  if (Buffer.from(sig.sender).toString("hex") !== owner) throw new Error("claim: its sender is not the owner");
}

/** The chain pointer event's name (SPEC 4 [D]: {kind: "chain", root, height}, unsigned and unchecked): the chain app's event row. */
export const CHAIN_EVENT = DEFAULT_BOX;
/** A merkle proof event's name: the chain app's proof row (SPEC 6: `chain.proof` checks it). */
export const PROOF_EVENT = "chain/proof";
/** The code the chain app's proof check refuses an EARLY proof with (its header not held yet): offered again after the next header. */
export const EARLY_PROOF_CODE = "ERR_HEADER_UNKNOWN";
/** The chain app's rejected row (SPEC 6 [D]: `/chain/rejected`, role `chain.status`). */
export const REJECTED_PATH = "/chain/rejected";
/** The role the host's status service key is granted at birth (imageConfig). */
export const STATUS_ROLE = "chain.status";
/** An overlay app's sync row: what the host hands a BEEF it fetched from a peer (SPEC 7: `/overlay/sync`, under the app's name). */
export const syncPath = (app: string): string => `/${app}/sync`;

const proofKey = (p: Record<string, unknown>): string => `${String(p.txid ?? "")} ${p.path instanceof Uint8Array ? Buffer.from(p.path).toString("hex").slice(0, 64) : ""}`;
const jsonBytes = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v));
/** An answer's body as text for an error line: dag-cbor decoded (a kernel operation's {refused}), else UTF-8. */
function answerText(a: Answer): string {
  try { return JSON.stringify(dagCbor.decode(a.body), (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString("hex") : typeof v === "bigint" ? Number(v) : v)); } catch { return new TextDecoder().decode(a.body).slice(0, 300); }
}

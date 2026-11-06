// The router's libp2p host (#43, #51): a router component, like the HTTP
// proxy and the feeds. The runtime has no network; this is where the sockets
// are. One js-libp2p node per peer KEY (#160) for the instances that declare
// libp2p — in their config (the genesis's `libp2p`, from etc/config.json), or
// by a `libp2p` row in the kernel's dispatch table (#72, #77: a topic, or a
// `/<protocol>`) — all inside the router process: a master-key host derives a
// key per instance, so one node per instance; a one-key host's instances share
// the one peer key, so one node carries them all ("the host" below):
//
//   peer key   a secp256k1 key derived from the INSTANCE's root key with BRC-42/43
//              (#129: [2, "skein instance"], key ID `libp2p:<handle>`, self — signer.ts
//              peerKey): the key the instance's signer answers for getPublicKey with
//              those arguments, so a program computes its own peer ID; a child, not
//              the root. The peer ID is the identity
//              multihash of the key's protobuf (type secp256k1, the 33-byte
//              compressed key), so the key reads straight out of the peer ID.
//   node       GossipSub (StrictSign: every message is signed by its publisher's
//              peer key), noise + yamux, TCP and WebSocket listeners (WSS with a
//              certificate), Kademlia DHT off | auto | client | server, AutoNAT,
//              UPnP/NAT-PMP port mapping, mDNS on/off, bootstrap peers kept
//              connected, circuit relays.
//   topics     the instance's `libp2p.topics`, its dispatch table's libp2p
//              rows' topics (libp2pConfig) and the topics its apps subscribed
//              (#119: `subscribe {topic, program, fn}` / `unsubscribe {topic}`,
//              emitted by an app's installed program; the subscriptions folded
//              from the log, subscriptionsOf, then followed live): subscribed; each message is judged
//              by the async topic validator, which makes one front-door call
//              (`inbound`) and returns its verdict to GossipSub (accept: admit +
//              forward; reject: drop + penalise the delivering peer; ignore: drop).
//              A redelivered message already admitted (its `p2p` event record is
//              in the kernel's `unique` map) is refused at admit, nothing written:
//              ignore.
//              A topic only an app's liveness takes (#138, liveness.ts) is
//              subscribed too, but its messages are never admitted: each is
//              judged by the liveness tool alone (a beat whose instance
//              signature verifies is kept and accepted, a bad one rejected).
//              With the DHT on, each topic name is a rendezvous: provide the
//              CID v1 raw sha2-256 of the name and dial the providers found
//              (go-libp2p's RoutingDiscovery, as go-p2p-message-bus uses it).
//   protocols  the instance's `libp2p.protocols` and its dispatch table's
//              libp2p rows' protocols (`/…`): for each inbound stream the
//              router reads length-prefixed frames (unsigned varint), makes one
//              front-door call per frame and writes the answer's body back.
//              Every node also serves /skein/message/1.0.0 (#70): a frame there is
//              a signed message to the instance, its package {message, body}; the
//              front door checks and routes it, no route needed.
//   changes    `declare` again with the instance's config as it now stands (the
//              router does when the dispatch table changed: an install or an
//              uninstall added or removed libp2p rows, #72/#77): new topics are
//              subscribed and new protocols handled; gone ones unsubscribed and
//              unhandled; no topic or protocol left: the node stops. No restart.
//   outbound   the `libp2p` provider's work (#70, providers.ts): publish, dial,
//              send, close for the messages an instance emits to it, and each frame
//              read from a dialled stream handed back (`frames`) to become a
//              message to the instance — the next frame arrives as an entry.
//
// The host node (#156, one node): the node of the HOST key (hostKey: on a one-key host the key
// every instance's node uses, so the instances join it) runs whether or not an instance declares
// libp2p — the Teranode headers tracker rides it (teranode.ts: the block topic subscribed as a host
// topic, hostTopic, judged by the tracker, never the front door). Every node carries ONE Kademlia
// DHT, ours: `skeinDht` on `/skein/kad/<network>/1.0.0` for the overlay's topics (discover()
// provides and finds on it). There is no Teranode DHT (2026-11-02, plans/teranode-dht-off-2026-11-02.md):
// the tracker's block-topic peers come from its bootstrap list (SKEIN_TERANODE_BOOTSTRAP, the
// network's defaults unioned) and GossipSub. Teranode's DHT is the public IPFS DHT; even a kad client
// crawls it and fills a js-libp2p node's connection cap, which then refuses every newcomer.
//
// Host-wide settings (hostP2PConfig): SKEIN_LIBP2P_LISTEN, _BOOTSTRAP, _RELAYS
// (comma-separated multiaddrs), _DHT (off | auto | client | server, default auto: the skein DHT's mode), _UPNP
// (on | off, default on), _MDNS (on | off), _TLS_CERT / _TLS_KEY (PEM files: the WebSocket listener
// serves TLS, so browsers can dial /tls/ws); from the environment, else $SKEIN_HOME/host.env.
//
// The defaults are tuned for discovery (2026-11-01, plans/open-defaults-2026-11-01.md): TCP on every
// interface, IPv4 and IPv6, on ONE fixed port (DEFAULT_PORT, the same on every install, so a user who
// opens one port knows which; taken at start: one line, and an OS-chosen port on the same interfaces);
// the WebSocket listener stays on loopback (plain WS off loopback is dev only). DHT (the skein DHT) `auto` = kad-DHT's
// own switch (clientMode left unset: a client until the node has a confirmed public address, then a
// server, and back) with AutoNAT confirming addresses; `client` = only ever a client; `server` = a
// server from the start (a hosted node behind a known-open port need not wait for AutoNAT). UPnP asks
// the router to map the port where it allows it (a router that refuses or none found: a line, nothing
// else); its mapped address is confirmed by AutoNAT before it is announced, so AutoNAT runs whenever
// UPnP is on or the DHT is auto or server.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { privateKeyFromRaw } from "@libp2p/crypto/keys";
import { gossipsub, TopicValidatorResult } from "@libp2p/gossipsub";
import { identify } from "@libp2p/identify";
import type { Libp2p, PeerId, Stream } from "@libp2p/interface";
import { autoNAT } from "@libp2p/autonat";
import type { ComponentLogger, Logger } from "@libp2p/interface";
import { kadDHT, passthroughMapper, removePrivateAddressesMapper, type KadDHT } from "@libp2p/kad-dht";
import { defaultLogger } from "@libp2p/logger";
import { mdns } from "@libp2p/mdns";
import { peerIdFromPrivateKey, peerIdFromString } from "@libp2p/peer-id";
import { ping } from "@libp2p/ping";
import { tcp } from "@libp2p/tcp";
import { uPnPNAT } from "@libp2p/upnp-nat";
import { isPrivate, lpStream, type LengthPrefixedStream } from "@libp2p/utils";
import { webSockets } from "@libp2p/websockets";
import { multiaddr, type Multiaddr } from "@multiformats/multiaddr";
import { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { createLibp2p } from "libp2p";
import type { Store } from "../runtime/store.ts";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { MESSAGE_KEY_ID, MESSAGE_PROTOCOL as SIGN_PROTOCOL } from "./providers.ts";
import { verifyAnyone } from "../runtime/identity.ts";
import { Liveness, type BeatStore, type Live, type LiveBeat } from "./liveness.ts";

export type DhtMode = "off" | "auto" | "client" | "server";

/** The host-wide settings: every node gets these. */
export interface P2PHostConfig {
  listen: string[];
  bootstrap: string[];
  dht: DhtMode;
  relays: string[];
  mdns: boolean;
  /** UPnP/NAT-PMP port mapping (@libp2p/upnp-nat): SKEIN_LIBP2P_UPNP, on by default in hostP2PConfig; absent: off. */
  upnp?: boolean;
  /** PEM certificate and key for the WebSocket listener (WSS). */
  tls?: { cert: string; key: string };
  /** The network (SKEIN_NETWORK's names): the skein DHT's protocol names it (skeinDhtProtocol); default main. */
  network?: string;
}

/** SKEIN_NETWORK's names as the networks' own (the Teranode block topic's, the skein DHT's). */
export const NETWORK_NAMES: Record<string, string> = { main: "mainnet", test: "testnet", regtest: "regtest" };

/** The skein DHT's protocol for a network: the overlay's provider records, never merged with another network's. */
export const skeinDhtProtocol = (network = "main") => `/skein/kad/${NETWORK_NAMES[network] ?? network}/1.0.0`;

/** One instance's libp2p config (the genesis's `libp2p`): what the router subscribes and serves for it. */
export interface P2PInstanceConfig {
  topics: string[];
  protocols: string[];
  /** This instance's listen addresses (over the host's): a fixed port belongs to one node. */
  listen?: string[];
}

/**
 * The default TCP port (2026-11-01): one fixed port on every install, so a user who opens one port knows
 * which. 7534 is "SKEI" on a phone keypad; unassigned in the IANA registry (not IPFS's 4001, not
 * Teranode's 9905/9915).
 */
export const DEFAULT_PORT = 7534;

/** The default listeners: TCP on every interface, IPv4 and IPv6, on DEFAULT_PORT; WebSocket on loopback, its port the OS's (plain WS off loopback: dev only). */
export const DEFAULT_LISTEN = [`/ip4/0.0.0.0/tcp/${DEFAULT_PORT}`, `/ip6/::/tcp/${DEFAULT_PORT}`, "/ip4/127.0.0.1/tcp/0/ws"];

/** Loopback only, ports chosen by the OS: the router's listeners when it is given no host settings (tests, an embedded router). */
export const LOOPBACK_LISTEN = ["/ip4/127.0.0.1/tcp/0", "/ip4/127.0.0.1/tcp/0/ws"];

/** `listen` with DEFAULT_PORT made an OS-chosen port (the fallback when the default port is taken). */
export const anyPort = (listen: string[]) => listen.map((a) => a.replace(new RegExp(`/tcp/${DEFAULT_PORT}(?=/|$)`), "/tcp/0"));

/** What the front door is called with for an inbound message or stream frame (#51). */
export interface InboundCall {
  transport: "libp2p";
  topic?: string;
  protocol?: string;
  /** The publisher's peer ID (topics) or the remote peer's (streams): its multihash bytes. */
  from: Uint8Array;
  seqno?: Uint8Array;
  signature?: Uint8Array;
  body: Uint8Array;
}

/** The front door's answer: the verdict for GossipSub; for a stream frame, what to write back and whether to close. */
export interface InboundAnswer {
  verdict: "accept" | "reject" | "ignore";
  body?: Uint8Array;
  close?: boolean;
  reason?: string;
}

/** A frame read from a dialled stream, or its end. */
export type Frame = { body: Uint8Array } | { closed: true; error?: string };

/** The stream protocol a signed message travels on to an instance (#70). */
export const MESSAGE_PROTOCOL = "/skein/message/1.0.0";

/**
 * The overlay's receive row (skein-overlay etc/app.json; the settled sync design, David 2026-10-30):
 * the host's OWN entry for the BEEFs it fetched (sync.ts `deliver` → Router.p2pInbound), never served
 * to peers ("not a good door to have": a node takes BEEFs only from paths it chose). Whatever rows an
 * instance declares, no node handles it inbound.
 */
export const RECEIVE_PROTOCOL = "/skein/overlay/beef/1.0.0";

/** Whether a node handles `protocol` inbound for its handles' rows: not the receive row, not the host's own. */
const inboundRow = (protocol: string, host: Record<string, unknown>) => protocol !== MESSAGE_PROTOCOL && protocol !== RECEIVE_PROTOCOL && !(protocol in host);

export interface P2POptions {
  host: P2PHostConfig;
  /** The instance's peer key (signer.ts peerKey). */
  keyOf(handle: string): PrivateKey;
  /** One front-door call for an inbound message or frame (Router.p2pInbound). */
  inbound(handle: string, call: InboundCall): Promise<InboundAnswer>;
  log?(source: string, line: string): void;
  /**
   * Signs `data` with the instance's signer (#126 beacons), as the host signs
   * an intention request (Router's `sign`: [2, "metanet handles envelope"],
   * key ID `send`, counterparty anyone). With `identity` (the instance's
   * identity key, 33 bytes). Absent: a beacon publishes nothing.
   */
  sign?(handle: string, data: Uint8Array): Promise<Uint8Array>;
  identity?(handle: string): Promise<Uint8Array | undefined>;
  /** How often topics are re-advertised and looked up in the DHT, and bootstrap peers redialled (ms). */
  discoveryMs?: number;
  /**
   * Protocols the host itself serves on every node, beside /skein/message/1.0.0: each inbound frame
   * answered by the handler, its answer written back; nothing reaches the front door. (The router
   * names none: the overlay's sync, its one user under #150, is a row an app declares since #154.)
   */
  hostProtocols?: Record<string, (handle: string, remote: PeerId, frame: Uint8Array) => Promise<Uint8Array>>;
  /** Each beat the liveness tool newly keeps from another peer (shruggr/skein#150). */
  beat?(handle: string, topic: string, beat: LiveBeat): void;
  /** Where the liveness tool persists the beats it keeps (host.db `live_beats`), reloaded when an instance's liveness is set. Absent: memory only. */
  beats?: BeatStore;
  /**
   * The host node's peer key (#156): on a one-key host the key every instance's node uses (keyOf's
   * answer for every handle), so the instances join the host node. Absent: a fresh key (a test's).
   */
  hostKey?: PrivateKey;
}

/** A host topic's judge (hostTopic): each message's data and publisher → GossipSub's verdict. */
export type HostTopicHandler = (data: Uint8Array, from: PeerId) => "accept" | "reject" | "ignore";

// ---------------------------------------------------------------- keys and IDs

/** A bsv secp256k1 key as a libp2p private key. */
export function libp2pKey(k: PrivateKey) {
  return privateKeyFromRaw(Uint8Array.from(k.toArray("be", 32)));
}

/** The peer ID of a key: the identity multihash of its protobuf (secp256k1, compressed). */
export function peerIdOf(k: PrivateKey): PeerId {
  return peerIdFromPrivateKey(libp2pKey(k) as never);
}

/** The compressed secp256k1 key a peer ID embeds (hex), or undefined for another kind. */
export function keyOfPeerId(id: string | Uint8Array): string | undefined {
  const b = typeof id === "string" ? peerIdFromString(id).toMultihash().bytes : id;
  // identity multihash (0x00, 0x25) over protobuf {1: KeyType = 2 (secp256k1), 2: 33 bytes}
  if (b.length !== 39 || b[0] !== 0x00 || b[1] !== 0x25 || b[2] !== 0x08 || b[3] !== 0x02 || b[4] !== 0x12 || b[5] !== 0x21) return undefined;
  return Buffer.from(b.subarray(6)).toString("hex");
}

/** A topic name's rendezvous CID: v1 raw over sha2-256 of the name (go-libp2p's nsToCid). */
export async function topicCid(topic: string): Promise<CID> {
  return CID.createV1(0x55, await sha256.digest(new TextEncoder().encode(topic)));
}

// ---------------------------------------------------------------- config

const list = (s: string | undefined) => (s ?? "").split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);

/**
 * The network's overlay bootstrap peers (SKEIN_NETWORK's names): the hosted Open Exchange node per network,
 * dialled beside SKEIN_LIBP2P_BOOTSTRAP's (unioned, as TERANODE_BOOTSTRAP is with SKEIN_TERANODE_BOOTSTRAP).
 * A node whose own peer id is one of them skips it (discover()). Mainnet and regtest have none yet.
 */
export const OVERLAY_BOOTSTRAP: Record<string, string[]> = {
  test: ["/dns4/p2p.testnet.openex.dev/tcp/7534/p2p/16Uiu2HAmVN7Cc7TrFGVrbdoV1mMGBF8LQBvPZ5trzgPArfagBRSB"],
};

/** SKEIN_LIBP2P_BOOTSTRAP over the network's defaults: unset, the network's; a list, unioned with them; `off`, none at all. */
export function overlayBootstrap(network: string, named: string | undefined): string[] {
  if ((named ?? "").trim().toLowerCase() === "off") return [];
  return [...new Set([...(OVERLAY_BOOTSTRAP[network] ?? []), ...list(named)])];
}

/**
 * The bootstrap addresses a node dials now: not its own peer id (the hosted node is its network's default
 * bootstrap), not a peer already connected; an address that does not parse is reported and skipped.
 */
export function bootstrapDials(bootstrap: string[], self: string, connected: Set<string>, bad: (a: string) => void = () => {}): string[] {
  const out: string[] = [];
  for (const a of bootstrap) {
    let ma: Multiaddr;
    try { ma = multiaddr(a); } catch { bad(a); continue; }
    const id = ma.getComponents().find((c) => c.name === "p2p")?.value;
    if (id === self || (id && connected.has(id))) continue;
    out.push(a);
  }
  return out;
}

/** The host-wide settings: the environment's SKEIN_LIBP2P_* (and SKEIN_NETWORK), else $SKEIN_HOME/host.env's. */
export function hostP2PConfig(vars: Record<string, string | undefined>, home?: string): P2PHostConfig {
  const file: Record<string, string> = {};
  const envFile = home ? join(home, "host.env") : undefined;
  if (envFile && existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const m = /^\s*(?:export\s+)?(SKEIN_LIBP2P_[A-Z_]+|SKEIN_NETWORK)=(.*)$/.exec(line);
      if (m) file[m[1]!] = m[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
    }
  }
  const get = (k: string) => vars[k] ?? file[k];
  const dht = (get("SKEIN_LIBP2P_DHT") || "auto").toLowerCase(); // 2026-11-01: auto by default; 2026-11-02: the skein DHT's mode only (Teranode's is always a client; off = neither)
  if (dht !== "off" && dht !== "auto" && dht !== "client" && dht !== "server") throw new Error(`SKEIN_LIBP2P_DHT: off | auto | client | server, not ${dht}`);
  const upnp = (get("SKEIN_LIBP2P_UPNP") || "on").toLowerCase();
  if (!/^(on|off|1|0|true|false|yes|no)$/.test(upnp)) throw new Error(`SKEIN_LIBP2P_UPNP: on | off, not ${upnp}`);
  const cert = get("SKEIN_LIBP2P_TLS_CERT"), key = get("SKEIN_LIBP2P_TLS_KEY");
  const listen = list(get("SKEIN_LIBP2P_LISTEN"));
  return {
    listen: listen.length ? listen : DEFAULT_LISTEN,
    bootstrap: overlayBootstrap(get("SKEIN_NETWORK") || "main", get("SKEIN_LIBP2P_BOOTSTRAP")),
    dht,
    relays: list(get("SKEIN_LIBP2P_RELAYS")),
    mdns: /^(on|1|true|yes)$/i.test(get("SKEIN_LIBP2P_MDNS") ?? ""),
    upnp: /^(on|1|true|yes)$/.test(upnp),
    ...(cert && key ? { tls: { cert: readFileSync(cert, "utf8"), key: readFileSync(key, "utf8") } } : {}),
  };
}

/** The libp2p config a genesis carries (`libp2p: {topics?, protocols?, listen?}`), or undefined: no node. */
export function libp2pOf(g: Record<string, unknown> | null | undefined): P2PInstanceConfig | undefined {
  const c = g?.libp2p as Record<string, unknown> | undefined;
  if (!c || typeof c !== "object") return undefined;
  const strs = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
  const listen = strs(c.listen);
  return { topics: strs(c.topics), protocols: strs(c.protocols), ...(listen.length ? { listen } : {}) };
}

/**
 * An instance's libp2p config as it stands (#72, #77): the genesis's
 * (libp2pOf: a tree names what its node subscribes in `config.libp2p`),
 * plus the topics and protocols named by the dispatch table's `libp2p`
 * rows added since the genesis (an app's install; address: a topic) — a
 * genesis topic row alone subscribes nothing, as a route alone did not — and
 * every stream protocol a `libp2p` row names (`/<protocol>`), whatever
 * installed it, the genesis included (#155: an image-born instance serves its
 * sync row; the overlay's receive row stays unserved, P2PHost), plus the
 * topics the apps subscribed (#119, `subscribed`).
 * `beacons` (#126): an app's beacon (or its liveness, #138: P2PHost.liveness
 * subscribes those topics itself) needs the node, and adds no topic.
 * Undefined: no node — the genesis declares none and nothing needs one.
 */
export function libp2pConfig(g: Record<string, unknown> | null | undefined, rows: Array<Record<string, unknown>>, subscribed: string[] = [], beacons = false): P2PInstanceConfig | undefined {
  const base = libp2pOf(g);
  const seeded = new Set(((g?.dispatch as Array<Record<string, unknown>> | undefined) ?? []).filter((r) => r.transport === "libp2p").map((r) => String(r.address)));
  // #155: a stream protocol is declared whatever installed its row; a topic row from the genesis alone subscribes nothing.
  const names = rows.filter((r) => r.transport === "libp2p" && (String(r.address).startsWith("/") || !seeded.has(String(r.address)))).map((r) => r.address).filter((p): p is string => typeof p === "string" && p.length > 0);
  // #126: a beacon needs the node (to publish), not a subscription of its topic.
  if (!base && !names.length && !subscribed.length && !beacons) return undefined;
  const add = (xs: string[], ys: string[]) => [...new Set([...xs, ...ys])];
  return {
    topics: add(add(base?.topics ?? [], names.filter((n) => !n.startsWith("/"))), subscribed),
    protocols: add(base?.protocols ?? [], names.filter((n) => n.startsWith("/"))),
    ...(base?.listen ? { listen: base.listen } : {}),
  };
}

// ---------------------------------------------------------------- subscriptions (#119)
//
// An app's installed program emits `subscribe {topic, program, fn}` /
// `unsubscribe {topic}` (the kernel's open events: the record {kind: "event",
// event, app, topic, program?, fn?, filter?} on the step's update, `app` the
// kernel's, handed to the host after the commit). A subscription is the
// delivery record: the kernel delivers a message on the topic to that app's
// program and fn (kernel-zig/src/subscriptions.zig) — the host only
// subscribes the topic and hands each message to the kernel. The kernel
// checks a subscription as it is emitted (an installed app's program, a fn, a
// topic not a /protocol, an unsubscribe of the app's own), so what the log
// lists is followed as it is.
//
// The same fold as the kernel's: keyed by (app, topic) — an app's subscribe
// replaces its own, an unsubscribe removes only its own — in log order. After
// a restart the subscriptions are folded from the events every step recorded
// (subscriptionsOf); the kernel keeps nothing written for them.

export interface Subscription { app: string; topic: string; program: string; fn: string; filter?: string }
export type SubscriptionEvent = { event: "subscribe"; sub: Subscription } | { event: "unsubscribe"; app: string; topic: string };

export const isTopic = (t: unknown): t is string => typeof t === "string" && t.length > 0 && !/[\s\0]/.test(t) && !t.startsWith("/");

/** A `subscribe` / `unsubscribe` event record, read (subscriptions.zig eventOf); or why it is not one this host follows. */
export function subscriptionEvent(rec: Record<string, unknown>): SubscriptionEvent | { refused: string } {
  const event = rec.event;
  if (rec.kind !== "event" || (event !== "subscribe" && event !== "unsubscribe")) return { refused: "not a subscribe or unsubscribe event" };
  if (typeof rec.app !== "string" || !rec.app) return { refused: "it names no app (its program record is not installed): ignored" };
  if (!isTopic(rec.topic)) return { refused: `${JSON.stringify(rec.topic)} is not a topic (text, no space; a /protocol is not subscribed)` };
  if (event === "unsubscribe") return { event, app: rec.app, topic: rec.topic };
  if (typeof rec.program !== "string" || !rec.program || typeof rec.fn !== "string" || !rec.fn) return { refused: "a subscribe names its program and fn" };
  return { event, sub: { app: rec.app, topic: rec.topic, program: rec.program, fn: rec.fn, ...(typeof rec.filter === "string" ? { filter: rec.filter } : {}) } };
}

/** Fold subscription events in order (subscriptions.zig apply). */
export function foldSubscriptions(events: Iterable<SubscriptionEvent>, into: Subscription[] = []): Subscription[] {
  for (const e of events) {
    const [app, topic] = e.event === "subscribe" ? [e.sub.app, e.sub.topic] : [e.app, e.topic];
    const i = into.findIndex((s) => s.app === app && s.topic === topic);
    if (e.event === "subscribe") { if (i >= 0) into[i] = e.sub; else into.push(e.sub); } else if (i >= 0) into.splice(i, 1);
  }
  return into;
}

/** The topics the subscriptions take (each once): what the node subscribes for the apps. */
export const subscribedTopics = (subs: Subscription[]): string[] => [...new Set(subs.map((s) => s.topic))];

/**
 * The subscriptions, folded from the store's log (#119, the host's recovery
 * at hydrate; subscriptions.zig fold): the `subscribe` / `unsubscribe`
 * records each step's update lists in `emitted`, in log order — by the entry
 * the step processed (`input`'s `n`), the step's time, its thread's start,
 * the thread's CID, its place in the thread and in `emitted`. Read only.
 */
export async function subscriptionsOf(store: Pick<Store, "get" | "chains" | "edges">): Promise<Subscription[]> {
  return foldSubscriptions(await emittedEvents(store, (rec) => { const e = subscriptionEvent(rec); return "refused" in e ? undefined : e; }));
}

/**
 * The beacons standing (#126), folded from the store's log as the
 * subscriptions are: the `beacon` / `unbeacon` records the steps' updates
 * list, in log order, keyed by (app, topic). Read only.
 */
export async function beaconsOf(store: Pick<Store, "get" | "chains" | "edges">): Promise<Beacon[]> {
  return foldBeacons(await emittedEvents(store, (rec) => { const e = beaconEvent(rec); return "refused" in e ? undefined : e; }));
}

/**
 * An emitted event's place in the log (the fold order, subscriptions.zig): the entry its step
 * processed (`n`, the update's `input`), the step's time (`at`, the update's), its thread (origin),
 * its place in the thread (`seq`), the event record's place in the update's `emitted` (`i`) and
 * the record's CID.
 */
export interface EmittedAt { n: number; at: number; thread: CID; seq: number; i: number; record: CID }

/** The event records the steps' updates list in `emitted` that `read` takes, in log order (the kernel's fold order, subscriptions.zig); `read` gets each one's place too. */
export async function emittedEvents<T>(store: Pick<Store, "get" | "chains" | "edges">, read: (rec: Record<string, unknown>, place: EmittedAt) => T | undefined): Promise<T[]> {
  type Obj = Record<string, unknown>;
  const ns = new Map<string, number>();
  const nOf = async (input: unknown): Promise<number> => {
    if (!isCid(input)) return -1;
    const k = input.toString();
    let n = ns.get(k);
    if (n === undefined) { const e = await store.get(input).catch(() => undefined) as Obj | undefined; n = typeof e?.n === "number" ? e.n : -1; ns.set(k, n); }
    return n;
  };
  const found: Array<{ key: number[]; thread: Uint8Array; e: T }> = [];
  for await (const origin of store.edges.query({ kind: "thread" })) {
    const o = await store.get(origin) as Obj;
    const thread: CID = origin, threadBytes = origin.bytes;
    let seq = 0;
    for await (const c of store.chains.history(origin)) {
      if (c.equals(origin)) continue;
      seq++;
      const u = await store.get(c) as Obj;
      if (!Array.isArray(u.emitted) || !u.emitted.length) continue;
      for (const [i, x] of u.emitted.entries()) {
        if (!isCid(x)) continue;
        const rec = await store.get(x).catch(() => undefined) as Obj | undefined;
        if (rec?.kind !== "event") continue;
        const n = await nOf(u.input), at = Number(u.at ?? 0);
        const e = read(rec, { n, at, thread, seq, i, record: x });
        if (e === undefined) continue;
        found.push({ key: [n, at, Number(o.at ?? 0), seq, i], thread: threadBytes, e });
      }
    }
  }
  const cmp = (x: (typeof found)[number], y: (typeof found)[number]) => {
    for (let i = 0; i < 3; i++) if (x.key[i] !== y.key[i]) return x.key[i]! - y.key[i]!;
    const t = Buffer.compare(x.thread, y.thread);
    if (t) return t;
    for (let i = 3; i < x.key.length; i++) if (x.key[i] !== y.key[i]) return x.key[i]! - y.key[i]!;
    return 0;
  };
  found.sort(cmp);
  return found.map((f) => f.e);
}

// ---------------------------------------------------------------- beacons (#126)
//
// An app's installed program declares `beacon {topic, every, body}` once (and
// `unbeacon {topic}` to stop it); the kernel records it on the step's update
// like `subscribe` and answers nothing. The node publishes a NEW message on
// `topic` every `every` ms on its own clock (David, #126: "The instance has
// declared its intent. The beacon needs to generate a new message every
// time."): the beat's frame (beaconFrame), the body plus the beat's time,
// signed by the instance's signer — fresh and attributable to the instance,
// not only to its peer key (GossipSub signs the message too). It logs nothing
// per beat, and does not subscribe the topic for it. A beacon
// stands until its app's unbeacon or its app's uninstall (no row of the app
// left in the dispatch table: Router.syncDispatch). Folded from the log like the
// subscriptions (beaconsOf), keyed by (app, topic).

export interface Beacon { app: string; topic: string; every: number; body: Uint8Array }

/**
 * A beat as published (#126): dag-cbor {body, at, sender, signature}. `at`:
 * the beat's time (ms since the epoch, the host's clock); `sender`: the
 * instance's identity key (33 bytes); `signature`: the instance's (DER),
 * [2, "metanet handles envelope"] / `send` / counterparty anyone, over
 * sha2-256 of beaconPreimage — dag-cbor {kind: "beacon", topic, body, at,
 * sender}: the topic is signed, not carried. A receiver checks the signature
 * (beaconProblem) and `at` against its own clock.
 */
export interface BeaconBeat { body: Uint8Array; at: number; sender: Uint8Array; signature: Uint8Array }

/** What a beat's signature covers. */
export function beaconPreimage(topic: string, b: Omit<BeaconBeat, "signature">): Uint8Array {
  return dagCbor.encode({ kind: "beacon", topic, body: b.body, at: b.at, sender: b.sender });
}

/** A beat's frame for `topic`, signed by `sign` (the instance's signer). */
export async function beaconFrame(topic: string, body: Uint8Array, at: number, sender: Uint8Array, sign: (data: Uint8Array) => Promise<Uint8Array>): Promise<Uint8Array> {
  const signature = await sign(beaconPreimage(topic, { body, at, sender }));
  return dagCbor.encode({ body, at, sender, signature });
}

/** A beat read from a frame on `topic`, its signature checked against its sender; or why it is not one. */
export function beaconBeat(topic: string, frame: Uint8Array): BeaconBeat | { problem: string } {
  let v: Record<string, unknown>;
  try { v = dagCbor.decode(frame) as Record<string, unknown>; } catch { return { problem: "not dag-cbor" }; }
  if (!v || typeof v !== "object") return { problem: "not a map" };
  const { body, at, sender, signature } = v;
  if (!(body instanceof Uint8Array) || typeof at !== "number" || !(sender instanceof Uint8Array) || sender.length !== 33 || !(signature instanceof Uint8Array)) return { problem: "want {body: bytes, at: int, sender: bytes(33), signature: bytes}" };
  const b = { body, at, sender, signature };
  if (!verifyAnyone(Buffer.from(sender).toString("hex"), SIGN_PROTOCOL, MESSAGE_KEY_ID, beaconPreimage(topic, b), signature)) return { problem: "the signature is not the sender's" };
  return b;
}
export type BeaconEvent = { event: "beacon"; beacon: Beacon } | { event: "unbeacon"; app: string; topic: string };

/** A `beacon` / `unbeacon` event record, read; or why it is not one this host follows. */
export function beaconEvent(rec: Record<string, unknown>): BeaconEvent | { refused: string } {
  const event = rec.event;
  if (rec.kind !== "event" || (event !== "beacon" && event !== "unbeacon")) return { refused: "not a beacon or unbeacon event" };
  if (typeof rec.app !== "string" || !rec.app) return { refused: "it names no app (its program record is not installed): ignored" };
  if (!isTopic(rec.topic)) return { refused: `${JSON.stringify(rec.topic)} is not a topic` };
  if (event === "unbeacon") return { event, app: rec.app, topic: rec.topic };
  const every = typeof rec.every === "number" ? rec.every : typeof rec.every === "bigint" ? Number(rec.every) : NaN;
  if (!Number.isFinite(every) || every < 1000) return { refused: "a beacon beats every second or slower (`every`, ms)" };
  if (!(rec.body instanceof Uint8Array)) return { refused: "a beacon has a body (bytes)" };
  return { event, beacon: { app: rec.app, topic: rec.topic, every, body: rec.body } };
}

/** Fold beacon events in order: a beacon replaces the app's own on the topic, an unbeacon removes it. */
export function foldBeacons(events: Iterable<BeaconEvent>, into: Beacon[] = []): Beacon[] {
  for (const e of events) {
    const [app, topic] = e.event === "beacon" ? [e.beacon.app, e.beacon.topic] : [e.app, e.topic];
    const i = into.findIndex((b) => b.app === app && b.topic === topic);
    if (e.event === "beacon") { if (i >= 0) into[i] = e.beacon; else into.push(e.beacon); } else if (i >= 0) into.splice(i, 1);
  }
  return into;
}

const isCid = (x: unknown): x is CID => CID.asCID(x) !== null;

// ---------------------------------------------------------------- the host
//
// One node per KEY (#160): the nodes are keyed by peer ID, each with the
// handles whose peer key it is. A master-key host derives a key per instance,
// so each node has one handle: one node per instance, as before. A one-key
// host's handles all share the one peer key, so one node carries them all:
//
//   topics     the node subscribes the union of its handles' (their configs'
//              and their liveness tools'); a message on a topic is judged for
//              every handle that takes it — Accept if any accepts, Reject only
//              if all reject, else Ignore (a discovery instance and a token
//              instance may share a topic, #137).
//   protocols  the node handles the union of its handles' protocols (and
//              /skein/message/1.0.0, every handle's). An inbound stream's
//              first frame is read and decoded as dag-cbor: its `topic` picks
//              the handle that declares the protocol and takes that topic; a
//              frame naming none goes to the one handle that declares the
//              protocol, and with several is answered {kind: "error",
//              message: "topic required"} and the stream closed. The frame
//              is then served to that handle as every frame is (not read twice).
//   listen     the host's listen addresses, once per node; an instance's own
//              `listen` is honoured when its node has that one handle (a line
//              otherwise).
//   outbound   publish, dial, request: from the handle's node, as before.

/** A stream an instance dialled (the libp2p provider's). */
interface OpenStream { stream: Stream; lp: LengthPrefixedStream }

/** One handle on a node: its config, its dialled streams, its beacons' timers (#126, by "<app> <topic>"). */
interface Handle {
  config: P2PInstanceConfig;
  streams: Map<number, OpenStream>;
  beats: Map<string, { beacon: Beacon; timer: ReturnType<typeof setInterval> }>;
}

interface Node {
  /** The peer ID (the key's). */
  id: string;
  node: Libp2p;
  /** The handles on this node, in the order they were declared. */
  handles: Map<string, Handle>;
  /** publish's seqno, caught in msgIdFn by the data object published. */
  seqnos: Map<Uint8Array, bigint>;
  /** The topics subscribed: the handles' configs' and their liveness tools' (#138). */
  subscribed: Set<string>;
  /** The protocols handled for the handles (the host's own aside). */
  handled: Set<string>;
  timer?: ReturnType<typeof setInterval>;
  /** The host node (#156): it runs with no handles, and does not stop with its last one. */
  host?: boolean;
  /** The host's own topics on it (#156: the Teranode block topic): subscribed beside the handles', judged by their handler, never the front door, never advertised on the skein DHT. */
  hostTopics: Map<string, HostTopicHandler>;
}

/** Stream IDs unique across restarts (a thread's recorded stream never names a later stream). */
let nextStream = Date.now() * 1000;

const u64 = (n: bigint): Uint8Array => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, false); return b; };

/** The answer to a stream whose first frame names no topic where several instances declare its protocol (#160). */
export const TOPIC_REQUIRED = "topic required";

export class P2PHost {
  readonly o: P2POptions;
  /** The liveness tool's state (#138): the apps' liveness and the beats kept (persisted in `o.beats` when given). */
  readonly live: Liveness;
  /** The nodes, by peer ID (#160: one per key). */
  private nodes = new Map<string, Node>();
  /** Each handle's node. */
  private byHandle = new Map<string, Node>();
  /** Each handle's peer ID, as derived (keyOf). */
  private ids = new Map<string, string>();
  /** Each key's declares, in order (one at a time). */
  private starting = new Map<string, Promise<unknown>>();
  private stopped = false;
  /** The host node's key (hostKey, else a fresh one) and its peer ID. */
  private readonly hostKey: PrivateKey;
  readonly hostId: string;

  constructor(o: P2POptions) {
    this.o = o;
    this.live = new Liveness(Date.now, o.beats);
    this.hostKey = o.hostKey ?? PrivateKey.fromRandom();
    this.hostId = peerIdOf(this.hostKey).toString();
    if (o.beat) this.live.kept = (h, topic, b) => { if (b.from !== this.peerId(h)) o.beat!(h, topic, b); };
  }

  private say(source: string, line: string): void { this.o.log?.(source, line); }

  /** A node's name in a log line: its one handle (as before #160), else its first; the host node with none: the router. */
  private nameOf(n: Node): string { return n.handles.keys().next().value ?? (n.host ? "router" : n.id); }

  // ---------------------------------------------------------------- the host node (#156)

  /**
   * The host node: the node of the host key, started (once) with no handles when no instance has
   * started it yet; an instance on that key that starts later joins it (#160), one that started
   * earlier made it.
   */
  async hostNode(): Promise<Libp2p> {
    if (this.stopped) throw new Error("libp2p: stopped");
    const key = this.hostId;
    const prev = this.starting.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      if (this.stopped) throw new Error("libp2p: stopped");
      const n = this.nodes.get(key);
      if (n) { n.host = true; return n; }
      const made = await this.start(key, this.hostKey, undefined, undefined);
      if (!made) throw new Error("libp2p: stopped");
      return made;
    });
    this.starting.set(key, next);
    void next.catch(() => {}).finally(() => { if (this.starting.get(key) === next) this.starting.delete(key); });
    return (await next).node;
  }

  /** The host node's record, once it runs. */
  private hostOf(): Node | undefined { const n = this.nodes.get(this.hostId); return n?.host ? n : undefined; }

  /**
   * A host topic on the host node (#156: the Teranode block topic): subscribed, each message judged
   * by `take` alone (its verdict GossipSub's), never the front door, never advertised on the skein
   * DHT. Undefined `take`: the topic left.
   */
  async hostTopic(topic: string, take: HostTopicHandler | undefined): Promise<void> {
    await this.hostNode();
    const n = this.hostOf()!;
    if (take) n.hostTopics.set(topic, take); else n.hostTopics.delete(topic);
    this.resubscribe(n);
  }

  /** The peers the host node knows subscribe `topic` (GossipSub's view). */
  hostSubscribers(topic: string): string[] {
    const n = this.hostOf();
    return n ? this.pubsub(n).getSubscribers(topic).map((p) => p.toString()) : [];
  }

  /** The host node's skein DHT's mode now (client | server; undefined: off or no host node yet). */
  hostDhtMode(): "client" | "server" | undefined {
    return this.hostDht()?.getMode();
  }

  /** The host node's confirmed public addresses (AutoNAT's, or UPnP's once AutoNAT confirmed them): libp2p announces only confirmed ones; relay addresses aside. */
  hostPublicAddrs(): string[] {
    const n = this.hostOf();
    return n ? n.node.getMultiaddrs().filter((m) => !isPrivateAddr(m) && !m.toString().includes("/p2p-circuit")).map(String) : [];
  }

  /** The host node's DHT service, the skein DHT (undefined: SKEIN_LIBP2P_DHT=off, or no host node yet). */
  hostDht(): KadDHT | undefined {
    const n = this.hostOf();
    return n ? dhtOf(n.node) : undefined;
  }

  /** The node of an instance, if it has one. */
  node(handle: string): Libp2p | undefined { return this.byHandle.get(handle)?.node; }

  /** An instance's peer ID (derived: whether or not its node runs). */
  peerId(handle: string): string {
    let id = this.ids.get(handle);
    if (!id) this.ids.set(handle, (id = peerIdOf(this.o.keyOf(handle)).toString()));
    return id;
  }

  /** The handles on `handle`'s node (#160: one in a master-key host; every one sharing its key in a one-key host). */
  handlesOn(handle: string): string[] { return [...(this.byHandle.get(handle)?.handles.keys() ?? [])]; }

  /** How many nodes run (#160: one per key). */
  nodeCount(): number { return this.nodes.size; }

  /** Where an instance's node listens (with /p2p/<id>). */
  addrs(handle: string): string[] { return this.node(handle)?.getMultiaddrs().map((m) => m.toString()) ?? []; }

  /**
   * `handle`'s libp2p config is this: its key's node started (once) with its peer key, the handle's
   * topics subscribed with the validator, its protocols handled. Declared again, the handle is brought
   * to the new config. No config: the handle leaves its node; the node stops with its last handle.
   */
  async declare(handle: string, config: P2PInstanceConfig | undefined): Promise<void> {
    if (this.stopped) return;
    const key = this.byHandle.get(handle)?.id ?? this.peerId(handle);
    const prev = this.starting.get(key) ?? Promise.resolve();
    // The previous declare's failure went to its own caller (it awaited it); this one runs regardless.
    const next = prev.catch(() => {}).then(async () => {
      if (this.stopped) return;
      if (!config) return this.drop(handle);
      const n = this.byHandle.get(handle) ?? this.nodes.get(key);
      if (n) return this.reconfigure(n, handle, config);
      await this.start(key, this.o.keyOf(handle), handle, config);
    });
    this.starting.set(key, next);
    // Only clears the slot: the error reaches this call's caller through `await next` below.
    void next.catch(() => {}).finally(() => { if (this.starting.get(key) === next) this.starting.delete(key); });
    await next;
  }

  /** The topics and protocols an instance's node serves for it now. */
  served(handle: string): { topics: string[]; protocols: string[] } | undefined {
    const h = this.byHandle.get(handle)?.handles.get(handle);
    return h && { topics: [...h.config.topics], protocols: [...h.config.protocols] };
  }

  /** Bring `handle` on a running node to `config` (joining it if it is new there): subscribe and handle what is new, unsubscribe and unhandle what no handle takes any more. */
  private async reconfigure(n: Node, handle: string, config: P2PInstanceConfig): Promise<void> {
    let h = n.handles.get(handle);
    const joined = !h;
    if (!h) {
      n.handles.set(handle, (h = { config: { topics: [], protocols: [] }, streams: new Map(), beats: new Map() }));
      this.byHandle.set(handle, n);
      if (config.listen?.length) this.say(handle, `libp2p: its listen ${config.listen.join(" ")} not honoured: its key's node (${n.id}) carries ${n.handles.size} instances and listens on ${n.node.getMultiaddrs().map(String).join(" ") || "(nothing)"} (#160)`);
    }
    const was = h.config;
    const added = config.topics.filter((t) => !was.topics.includes(t));
    const removed = was.topics.filter((t) => !config.topics.includes(t));
    const addedP = config.protocols.filter((p) => !was.protocols.includes(p) && !this.hostServed(p));
    const removedP = was.protocols.filter((p) => !config.protocols.includes(p) && !this.hostServed(p));
    h.config = { ...config, listen: joined ? undefined : was.listen };
    if (!joined && !added.length && !removed.length && !addedP.length && !removedP.length) return;
    const sub = this.resubscribe(n);
    await this.rehandle(n);
    const list = (xs: string[]) => xs.join(", ") || "none";
    if (joined) this.say(handle, `libp2p: on the node of its key ${n.id} (${n.handles.size} instances); topics ${list(config.topics)}; protocols ${list(config.protocols)}`);
    else this.say(handle, `libp2p: topics ${list(config.topics)} (+${list(added)} −${list(removed)}); protocols ${list(config.protocols)} (+${list(addedP)} −${list(removedP)})`);
    if (added.length || sub.added.length) setTimeout(() => void this.discover(n).catch((e) => this.say(this.nameOf(n), `libp2p: discovery: ${(e as Error).message}`)), 200);
  }

  private subscribe(n: Node, topic: string): void {
    const ps = this.pubsub(n);
    ps.topicValidators.set(topic, (from: PeerId, msg: { type: string }) => this.validate(n, topic, from, msg as never));
    ps.subscribe(topic);
    n.subscribed.add(topic);
  }

  /** The topics `handle` takes: its config's and its apps' liveness topics (#138). */
  private takes(handle: string, h: Handle): string[] { return [...h.config.topics, ...this.live.topics(handle)]; }

  /** Subscribe what the handles' configs and liveness tools (#138) take, and the host's own topics (#156), unsubscribe the rest: the topics added and removed. */
  private resubscribe(n: Node): { added: string[]; removed: string[] } {
    const want = new Set([...[...n.handles].flatMap(([handle, h]) => this.takes(handle, h)), ...n.hostTopics.keys()]);
    const ps = this.pubsub(n);
    const removed = [...n.subscribed].filter((t) => !want.has(t));
    const added = [...want].filter((t) => !n.subscribed.has(t));
    for (const t of removed) { ps.unsubscribe(t); ps.topicValidators.delete(t); n.subscribed.delete(t); }
    for (const t of added) this.subscribe(n, t);
    return { added, removed };
  }

  /** Handle the protocols the handles declare, unhandle those none declares any more (the host's own aside). */
  private async rehandle(n: Node): Promise<void> {
    const host = this.o.hostProtocols ?? {};
    const want = new Set([...n.handles.values()].flatMap((h) => h.config.protocols).filter((p) => inboundRow(p, host)));
    for (const p of [...n.handled]) if (!want.has(p)) { n.handled.delete(p); await n.node.unhandle(p); }
    for (const p of want) if (!n.handled.has(p)) { n.handled.add(p); await this.handleProtocol(n, p); }
  }

  /** The topics `handle`'s node subscribes for it now: its config's and its apps' liveness topics (#138). */
  listening(handle: string): string[] {
    const n = this.byHandle.get(handle);
    const h = n?.handles.get(handle);
    return n && h ? [...new Set(this.takes(handle, h))].filter((t) => n.subscribed.has(t)) : [];
  }

  /**
   * The liveness `handle`'s apps keep (#138, liveness.ts): the tool keeps it, and the node subscribes
   * each topic (not admitting its messages) and leaves those no liveness nor config takes. One line
   * when a topic is taken or left. No node: kept for when it starts.
   */
  liveness(handle: string, lives: Live[]): void {
    this.live.set(handle, lives);
    const n = this.byHandle.get(handle);
    if (!n) return;
    const { added, removed } = this.resubscribe(n);
    for (const t of added) this.say(handle, `libp2p: liveness ${t} (app ${lives.filter((l) => l.topic === t).map((l) => l.app).join(", ")})`);
    for (const t of removed) this.say(handle, `libp2p: ${t} left`);
    if (added.length) setTimeout(() => void this.discover(n).catch((e) => this.say(this.nameOf(n), `libp2p: discovery: ${(e as Error).message}`)), 200);
  }

  /** Whether the host serves `protocol` on every node itself (/skein/message/1.0.0, `hostProtocols`). */
  private hostServed(protocol: string): boolean { return protocol === MESSAGE_PROTOCOL || protocol in (this.o.hostProtocols ?? {}); }

  private async handleHostProtocol(n: Node, protocol: string, f: (handle: string, remote: PeerId, frame: Uint8Array) => Promise<Uint8Array>): Promise<void> {
    await n.node.handle(protocol, (stream, connection) => {
      void (async () => {
        const lp = lpStream(stream);
        try {
          for (;;) {
            let frame: Uint8Array;
            try { frame = (await lp.read()).subarray(); } catch { break; }
            // The router names no host protocol (#154); a node's first handle answers for it.
            await lp.write(await f(this.nameOf(n), connection.remotePeer, frame));
          }
          await stream.close().catch(() => {});
        } catch (e) {
          this.say(this.nameOf(n), `libp2p: ${protocol} from ${connection.remotePeer}: ${(e as Error).message}`);
          stream.abort(e as Error);
        }
      })();
    }, { runOnLimitedConnection: true });
  }

  private async handleProtocol(n: Node, protocol: string): Promise<void> {
    await n.node.handle(protocol, (stream, connection) => { void this.serve(n, protocol, stream, connection.remotePeer); }, { runOnLimitedConnection: true });
  }

  /** A node for `key` (its private key `pk`): with `handle` and its config, or the host node with none (#156). */
  private async start(key: string, pk: PrivateKey, handle: string | undefined, config: P2PInstanceConfig | undefined): Promise<Node | undefined> {
    const h = this.o.host;
    const n: Node = {
      id: key, node: undefined as never, handles: new Map(handle && config ? [[handle, { config, streams: new Map(), beats: new Map() }]] : []),
      seqnos: new Map(), subscribed: new Set(), handled: new Set(), hostTopics: new Map(), ...(key === this.hostId ? { host: true } : {}),
    };
    const listen = [...(config?.listen ?? h.listen), ...h.relays.map((r) => `${r.replace(/\/+$/, "")}/p2p-circuit`)];
    // An address that does not parse counts as private here; start() reports it when it is dialled or listened on.
    const allPrivate = (xs: string[]) => xs.every((a) => { try { return isPrivateAddr(multiaddr(a)); } catch { return true; } });
    const privateDev = allPrivate([...h.bootstrap, ...listen]);
    const services: Record<string, unknown> = {
      identify: identify(),
      // #156: the DHT pings a new peer (before it enters its table) beside the other pings; 4 outbound streams as before.
      ping: ping({ maxOutboundStreams: 4 }),
      pubsub: gossipsub({
        globalSignaturePolicy: "StrictSign",
        allowPublishToZeroTopicPeers: true,
        emitSelf: false,
        // The default id (the publisher's key ‖ seqno), and publish's seqno caught by the data object.
        msgIdFn: async (msg) => {
          if (msg.type !== "signed") throw new Error("unsigned message");
          if (n.seqnos.has(msg.data)) n.seqnos.set(msg.data, msg.sequenceNumber);
          const key = (msg.from.publicKey ?? msg.key)!;
          const { publicKeyToProtobuf } = await import("@libp2p/crypto/keys");
          const k = publicKeyToProtobuf(key);
          const out = new Uint8Array(k.length + 8);
          out.set(k, 0);
          out.set(u64(msg.sequenceNumber), k.length);
          return out;
        },
      }),
    };
    // #156: one DHT, ours (the overlay topics'); 2026-11-02: no Teranode DHT (the public IPFS DHT: even a client fills the connection cap).
    if (h.dht !== "off") {
      services.skeinDht = kadDHT({
        protocol: skeinDhtProtocol(h.network), ...dhtClientMode(h.dht), peerInfoMapper: privateDev ? passthroughMapper : removePrivateAddressesMapper,
        logPrefix: "libp2p:dht-skein", datastorePrefix: "/dht-skein", metricsPrefix: "libp2p_dht_skein",
      });
    }
    // 2026-11-01: AutoNAT confirms the node's public addresses (DHT auto flips to server on one; UPnP's mapped address needs it).
    if (h.upnp || h.dht === "auto" || h.dht === "server") services.autoNAT = autoNAT();
    if (h.upnp) services.upnpNAT = uPnPNAT();
    const name = handle ?? "router";
    const create = (addrs: string[]) => createLibp2p({
      privateKey: libp2pKey(pk),
      addresses: { listen: addrs },
      transports: [tcp(), webSockets(h.tls ? { https: { cert: h.tls.cert, key: h.tls.key } } : {}), ...(h.relays.length ? [circuitRelayTransport()] : [])],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      peerDiscovery: h.mdns ? [mdns()] : [],
      services: services as never,
      ...(h.upnp ? { logger: upnpTold((line) => this.say(name, line)) } : {}),
      start: false,
    });
    let node = await create(listen);
    try { await node.start(); } catch (e) {
      try { await node.stop(); } catch { /* the failed start's listeners closed as far as they go */ }
      // 2026-11-01: the default port taken (another host, another node of this one): an OS-chosen port on the same interfaces.
      // An address SKEIN_LIBP2P_LISTEN (or the instance) names is honoured as named: its failure stops the node, as before.
      const defaulted = !config?.listen && h.listen.join(" ") === DEFAULT_LISTEN.join(" ");
      if (!defaulted || !/EADDRINUSE/.test((e as Error).message)) throw e;
      const fallback = anyPort(listen);
      this.say(name, `libp2p: port ${DEFAULT_PORT} is taken: listening on an OS-chosen port instead`);
      node = await create(fallback);
      await node.start();
    }
    n.node = node;
    if (this.stopped) { await node.stop(); return undefined; }
    this.nodes.set(key, n);
    if (handle) this.byHandle.set(handle, n);
    if (h.mdns) node.addEventListener("peer:discovery", (e) => { void node.dial(e.detail.id).catch((err) => this.say(this.nameOf(n), `libp2p: mDNS peer ${e.detail.id}: ${(err as Error).message}`)); });
    this.resubscribe(n);
    const host = this.o.hostProtocols ?? {};
    for (const protocol of (config?.protocols ?? []).filter((p) => inboundRow(p, host))) { n.handled.add(protocol); await this.handleProtocol(n, protocol); }
    await this.handleProtocol(n, MESSAGE_PROTOCOL);
    for (const [protocol, f] of Object.entries(host)) await this.handleHostProtocol(n, protocol, f);
    const dhts = (h.dht === "off" ? "DHT off" : `DHT ${h.dht} (${skeinDhtProtocol(h.network)})`) + `; UPnP ${h.upnp ? "on" : "off"}; bootstrap ${h.bootstrap.join(", ") || "none"}`;
    if (handle && config) this.say(handle, `libp2p: peer ${node.peerId} listening on ${node.getMultiaddrs().map(String).join(" ") || "(nothing)"}; topics ${config.topics.join(", ") || "none"}; protocols ${config.protocols.join(", ") || "none"}; ${dhts}`);
    else this.say("router", `libp2p: the host node, peer ${node.peerId} listening on ${node.getMultiaddrs().map(String).join(" ") || "(nothing)"}; ${dhts}`);
    const discover = () => void this.discover(n).catch((e) => this.say(this.nameOf(n), `libp2p: discovery: ${(e as Error).message}`));
    setTimeout(discover, 200);
    n.timer = setInterval(discover, this.o.discoveryMs ?? 30_000);
    return n;
  }

  // ---------------------------------------------------------------- discovery

  /** Keep the bootstrap peers connected; with the DHT on, advertise each topic and dial its providers. */
  private async discover(n: Node): Promise<void> {
    const node = n.node;
    const name = this.nameOf(n);
    const connected = new Set(node.getConnections().map((c) => c.remotePeer.toString()));
    for (const a of bootstrapDials(this.o.host.bootstrap, node.peerId.toString(), connected, (b) => this.say(name, `libp2p: bad bootstrap address ${b}`))) {
      await node.dial(multiaddr(a)).catch((e) => this.say(name, `libp2p: bootstrap ${a}: ${(e as Error).message}`));
    }
    // #156: the skein DHT (the node's one DHT); the host's own topics are the tracker's.
    const dht = dhtOf(node);
    if (!dht) return;
    for (const topic of [...n.subscribed].filter((t) => !n.hostTopics.has(t))) {
      const cid = await topicCid(topic);
      await drain(dht.provide(cid, { signal: AbortSignal.timeout(20_000) })).catch((e) => { if (!timedOut(e)) this.say(name, `libp2p: provide ${topic}: ${(e as Error).message}`); });
      try {
        for await (const p of providersOf(dht, cid, { signal: AbortSignal.timeout(20_000) })) {
          if (p.id.equals(node.peerId) || node.getConnections(p.id).length) continue;
          await node.dial(p.multiaddrs.length ? p.multiaddrs : p.id).catch((e) => this.say(name, `libp2p: ${topic} provider ${p.id}: ${(e as Error).message}`));
        }
      } catch (e) { if (!timedOut(e)) this.say(name, `libp2p: find providers ${topic}: ${(e as Error).message}`); } // timed out: next round
    }
  }

  // ---------------------------------------------------------------- inbound

  private pubsub(n: Node) {
    return (n.node.services as { pubsub: ReturnType<ReturnType<typeof gossipsub>> }).pubsub;
  }

  /**
   * The topic validator: for every handle on the node that takes the topic, one front-door call (or,
   * for a topic only its apps' liveness takes, #138, the liveness tool's verdict alone: nothing
   * admitted); GossipSub's verdict (async: forwarding waits on it) is Accept if any handle accepts,
   * Reject only if every one rejects, else Ignore (#160).
   */
  private async validate(n: Node, topic: string, _source: PeerId, msg: { type: string; from: PeerId; data: Uint8Array; sequenceNumber: bigint; signature: Uint8Array }): Promise<TopicValidatorResult> {
    if (msg.type !== "signed") return TopicValidatorResult.Reject;
    // #156: a host topic is judged by its handler alone (the tracker's), never the front door.
    const own = n.hostTopics.get(topic);
    if (own) {
      let v: "accept" | "reject" | "ignore";
      try { v = own(msg.data, msg.from); } catch (e) { this.say(this.nameOf(n), `libp2p: ${topic}: ${(e as Error).message}`); v = "ignore"; } // the host failing is not the message's fault
      return v === "accept" ? TopicValidatorResult.Accept : v === "reject" ? TopicValidatorResult.Reject : TopicValidatorResult.Ignore;
    }
    const takers = [...n.handles].filter(([handle, h]) => h.config.topics.includes(topic) || this.live.takes(handle, topic));
    if (!takers.length) return TopicValidatorResult.Ignore;
    const verdicts = await Promise.all(takers.map(([handle, h]) => this.validateFor(handle, h, topic, msg)));
    if (verdicts.includes(TopicValidatorResult.Accept)) return TopicValidatorResult.Accept;
    if (verdicts.every((v) => v === TopicValidatorResult.Reject)) return TopicValidatorResult.Reject;
    return TopicValidatorResult.Ignore;
  }

  /** One handle's verdict on a topic message (the validator as it was per node before #160). */
  private async validateFor(handle: string, h: Handle, topic: string, msg: { from: PeerId; data: Uint8Array; sequenceNumber: bigint; signature: Uint8Array }): Promise<TopicValidatorResult> {
    const live = this.live.takes(handle, topic) ? this.live.observe(handle, topic, msg.data, msg.from.toString()) : undefined;
    if (!h.config.topics.includes(topic)) return live === "accept" ? TopicValidatorResult.Accept : live === "reject" ? TopicValidatorResult.Reject : TopicValidatorResult.Ignore;
    try {
      const a = await this.o.inbound(handle, {
        transport: "libp2p", topic, from: msg.from.toMultihash().bytes, seqno: u64(msg.sequenceNumber), signature: msg.signature, body: msg.data,
      });
      return a.verdict === "accept" ? TopicValidatorResult.Accept : a.verdict === "reject" ? TopicValidatorResult.Reject : TopicValidatorResult.Ignore;
    } catch (e) {
      // The host failing is not the message's fault: no penalty.
      this.say(handle, `libp2p: ${topic}: validation failed: ${(e as Error).message}`);
      return TopicValidatorResult.Ignore;
    }
  }

  /**
   * Which handle an inbound stream on `protocol` is for (#160), by its first frame: the handles that
   * declare the protocol (every handle declares /skein/message/1.0.0); the frame's `topic` (dag-cbor
   * {topic, …}) picks the one among them that takes it; a frame naming none, or a topic none of them
   * takes, goes to the one handle that declares the protocol; with several, a problem.
   */
  private streamHandle(n: Node, protocol: string, first: Uint8Array): { handle: string } | { problem: string } {
    const declaring = [...n.handles].filter(([, h]) => protocol === MESSAGE_PROTOCOL || h.config.protocols.includes(protocol)).map(([handle]) => handle);
    if (declaring.length === 1) return { handle: declaring[0]! };
    if (!declaring.length) return { problem: `no instance here declares ${protocol}` };
    let topic: unknown;
    try { const v = dagCbor.decode(first) as { topic?: unknown } | null; topic = v && typeof v === "object" ? v.topic : undefined; } catch { /* not dag-cbor: it names no topic */ }
    if (typeof topic !== "string" || !topic) return { problem: TOPIC_REQUIRED };
    // A topic several declaring instances take (a discovery instance beside a token instance, #137): the first declared of them.
    const taker = declaring.find((handle) => n.handles.get(handle)!.config.topics.includes(topic as string));
    return taker ? { handle: taker } : { problem: `no instance here takes ${topic}` };
  }

  /** An inbound stream on a handled protocol: its first frame picks the handle (#160); each frame one front-door call, its answer's body written back. */
  private async serve(n: Node, protocol: string, stream: Stream, remote: PeerId): Promise<void> {
    const lp = lpStream(stream);
    let handle = this.nameOf(n);
    try {
      let first: Uint8Array | undefined;
      try { first = (await lp.read()).subarray(); } catch { /* the remote closed before a frame: nothing owed */ }
      if (first) {
        const to = this.streamHandle(n, protocol, first);
        if ("problem" in to) {
          this.say(handle, `libp2p: ${protocol} from ${remote}: ${to.problem}: answered and closed`);
          await lp.write(dagCbor.encode({ kind: "error", message: to.problem }));
          await stream.close().catch(() => {});
          return;
        }
        handle = to.handle;
        for (let frame: Uint8Array | undefined = first; ;) {
          const a = await this.o.inbound(handle, { transport: "libp2p", protocol, from: remote.toMultihash().bytes, body: frame });
          if (a.body) await lp.write(a.body);
          if (a.close || a.verdict === "reject") break;
          try { frame = (await lp.read()).subarray(); } catch { break; } // the remote closed or reset its side: the stream is over either way, and nothing here is owed an answer
        }
      }
      await stream.close().catch(() => {}); // a stream the remote already closed or reset cannot be closed again; every frame was answered
    } catch (e) {
      this.say(handle, `libp2p: ${protocol} from ${remote}: ${(e as Error).message}`);
      stream.abort(e as Error);
    }
  }

  // ---------------------------------------------------------------- outbound (the libp2p provider's, #70)

  private nodeOf(handle: string): Node {
    const n = this.byHandle.get(handle);
    if (!n) throw new Error("this instance has no libp2p node (its config names no libp2p)");
    return n;
  }

  /**
   * The beacons `handle`'s node beats (#126): each a new frame (beaconFrame:
   * the body, the beat's time, the instance's signature) published on its topic
   * every `every` ms — the topic not subscribed; nothing logged per beat (a
   * failed beat is dropped: the next one is the retry). The FIRST beacon on a
   * topic publishes at once. A beacon REPLACING one (the same app and topic, a
   * new body and/or `every`; the settled sync design, David 2026-10-30) swaps
   * what the next beat carries and leaves the timer alone — no publish now, no
   * reset — unless `every` changed, when the timer is reset to the new
   * interval (still no publish now). One line when a beacon starts or stops.
   * No node: nothing beats.
   */
  beacons(handle: string, beacons: Beacon[]): void {
    const n = this.byHandle.get(handle);
    const hs = n?.handles.get(handle);
    if (!n || !hs) return;
    const want = new Map(beacons.map((b) => [`${b.app} ${b.topic}`, b]));
    // Each beat a new frame: the entry's body as it stands then, now, signed by the instance's signer (beaconFrame).
    const beatOf = (k: string) => () => {
      const x = hs.beats.get(k);
      if (!x || this.byHandle.get(handle) !== n || n.handles.get(handle) !== hs) return;
      const b = x.beacon;
      const { sign, identity } = this.o;
      if (!sign || !identity) return;
      void (async () => {
        const sender = await identity(handle);
        if (!sender) return;
        const frame = await beaconFrame(b.topic, b.body, Date.now(), sender, (d) => sign(handle, d));
        await this.publish(handle, b.topic, frame);
        // #138: the node's own beat into its liveness set (gossip does not echo it).
        if (this.live.takes(handle, b.topic)) this.live.observe(handle, b.topic, frame, n.node.peerId.toString());
      })().catch(() => {});
    };
    for (const [k, x] of hs.beats) {
      const b = want.get(k);
      if (b) {
        if (b.every !== x.beacon.every) { clearInterval(x.timer); x.timer = setInterval(beatOf(k), b.every); }
        x.beacon = b; // the next beat carries it
        continue;
      }
      clearInterval(x.timer);
      hs.beats.delete(k);
      this.say(handle, `libp2p: beacon ${x.beacon.topic} (app ${x.beacon.app}) stopped`);
    }
    for (const [k, b] of want) {
      if (hs.beats.has(k)) continue;
      hs.beats.set(k, { beacon: b, timer: setInterval(beatOf(k), b.every) });
      beatOf(k)();
      this.say(handle, `libp2p: beacon ${b.topic} (app ${b.app}) every ${b.every} ms, ${b.body.length} bytes`);
    }
  }

  /** Publish `body` on `topic` from `handle`'s node (signed with its peer key): the message's seqno, and how many peers took it. */
  async publish(handle: string, topic: string, body: Uint8Array): Promise<{ seqno: Uint8Array; recipients: number }> {
    const n = this.nodeOf(handle);
    const data = Uint8Array.from(body); // a fresh object: the key msgIdFn catches the seqno by
    n.seqnos.set(data, -1n);
    try {
      const r = await this.pubsub(n).publish(topic, data);
      const seq = n.seqnos.get(data)!;
      if (seq < 0n) throw new Error("publish: no seqno");
      return { seqno: u64(seq), recipients: r.recipients.length };
    } finally { n.seqnos.delete(data); }
  }

  /** Open a stream from `handle`'s node to a peer (a peer ID, or a multiaddr with /p2p/<id>): its id; each frame read from it, and its end, to `frames`. */
  async dial(handle: string, peer: string, protocol: string, frames: (f: Frame) => void): Promise<number> {
    const n = this.nodeOf(handle);
    const hs = n.handles.get(handle)!;
    const target = peer.startsWith("/") ? multiaddr(peer) : peerIdFromString(peer);
    const stream = await n.node.dialProtocol(target, protocol, { signal: AbortSignal.timeout(15_000) });
    const id = ++nextStream;
    const s = { stream, lp: lpStream(stream) };
    hs.streams.set(id, s);
    void (async () => {
      for (;;) {
        try {
          frames({ body: (await s.lp.read()).subarray() });
        } catch (e) {
          const name = (e as Error).name;
          const clean = name === "UnexpectedEOFError" || name === "StreamClosedError" || name === "StreamResetError";
          if (hs.streams.get(id) === s) frames({ closed: true, ...(clean ? {} : { error: (e as Error).message }) });
          return;
        }
      }
    })();
    return id;
  }

  /**
   * One request to a peer on `protocol` (a host protocol, shruggr/skein#150): a stream opened, one
   * frame written, one frame read back, the stream closed. → the answer's bytes.
   */
  async request(handle: string, peer: string, protocol: string, body: Uint8Array, timeoutMs = 15_000): Promise<Uint8Array> {
    const n = this.nodeOf(handle);
    const signal = AbortSignal.timeout(timeoutMs);
    const stream = await n.node.dialProtocol(peerIdFromString(peer), protocol, { signal });
    try {
      const lp = lpStream(stream);
      await lp.write(body, { signal });
      const answer = (await lp.read({ signal })).subarray();
      await stream.close().catch(() => {});
      return answer;
    } catch (e) {
      stream.abort(e as Error);
      throw e;
    }
  }

  /**
   * A `call` intention's carrying (the swap relay's call, 2026-11-06): from `handle`'s node, a
   * connection to `peer` (a peer ID, or a multiaddr with /p2p/<id>), a stream on `protocol`, ONE
   * frame written, ONE frame read back, the stream closed → the answer's bytes and the peer the
   * connection proved (Noise: its peer ID's multihash). No timer of its own: the stream is live until
   * the peer answers or the connection breaks. A break throws, its message saying which: the dial
   * refused, the protocol not served, the write failed, the stream closed without a frame.
   */
  async call(handle: string, peer: string, protocol: string, body: Uint8Array): Promise<{ from: Uint8Array; body: Uint8Array }> {
    const n = this.nodeOf(handle);
    let target: Multiaddr | PeerId;
    try { target = peer.startsWith("/") ? multiaddr(peer) : peerIdFromString(peer); } catch (e) { throw new Error(`not a peer: ${peer}: ${(e as Error).message}`); }
    const conn = await n.node.dial(target).catch((e: Error) => { throw new Error(`the dial was refused: ${e.message}`); });
    const stream = await conn.newStream(protocol).catch((e: Error) => { throw new Error(`the peer does not serve ${protocol}: ${e.message}`); });
    const lp = lpStream(stream);
    try {
      await lp.write(body).catch((e: Error) => { throw new Error(`the write failed: ${e.message}`); });
      const answer = await lp.read().catch((e: Error) => { throw new Error(`the stream closed without an answer: ${e.message}`); });
      await stream.close().catch(() => {});
      return { from: conn.remotePeer.toMultihash().bytes, body: answer.subarray() };
    } catch (e) {
      stream.abort(e as Error);
      throw e;
    }
  }

  /** The protocols `handle`'s node handles inbound now (the libp2p node's own registry: its rows', the host's, /skein/message/1.0.0). */
  handledProtocols(handle: string): string[] { return this.byHandle.get(handle)?.node.getProtocols() ?? []; }

  /** The addresses `handle`'s node knows for `peer` (its peer store), as multiaddr strings. */
  async peerAddrs(handle: string, peer: string): Promise<string[]> {
    const n = this.byHandle.get(handle);
    if (!n) return [];
    try { return (await n.node.peerStore.get(peerIdFromString(peer))).addresses.map((a) => a.multiaddr.toString()); } catch { return []; }
  }

  /** Dial `peer` from `handle`'s node, at `addrs` when given (a start's persisted peers), else as the peer store knows it. */
  async connect(handle: string, peer: string, addrs: string[] = []): Promise<void> {
    const n = this.nodeOf(handle);
    const id = peerIdFromString(peer);
    if (n.node.getConnections(id).length) return;
    const mas = addrs.flatMap((a) => { try { const m = multiaddr(a); return [m.getComponents().some((c) => c.name === "p2p") ? m : m.encapsulate(`/p2p/${peer}`)]; } catch { return []; } });
    await n.node.dial(mas.length ? mas : id, { signal: AbortSignal.timeout(15_000) });
  }

  /** The peers `handle`'s node knows subscribe `topic` (GossipSub's view), as peer ID strings. */
  subscribers(handle: string, topic: string): string[] {
    const n = this.byHandle.get(handle);
    return n ? this.pubsub(n).getSubscribers(topic).map((p) => p.toString()) : [];
  }

  /** Write one length-prefixed frame on a dialled stream. */
  async send(handle: string, id: number, body: Uint8Array): Promise<void> {
    const s = this.nodeOf(handle).handles.get(handle)!.streams.get(id);
    if (!s) throw new Error(`send: no stream ${id}`);
    await s.lp.write(body);
  }

  /** Close a dialled stream (our side), and forget it. */
  async close(handle: string, id: number): Promise<void> {
    const hs = this.nodeOf(handle).handles.get(handle)!;
    const s = hs.streams.get(id);
    if (!s) throw new Error(`close: no stream ${id}`);
    hs.streams.delete(id);
    await s.stream.close().catch(() => s.stream.abort(new Error("closed")));
  }

  // ---------------------------------------------------------------- lifecycle

  /** `handle` leaves its node (its beats stopped, its liveness forgotten); the node stops with its last handle, else follows the handles left. */
  private async drop(handle: string): Promise<void> {
    const n = this.byHandle.get(handle);
    if (!n) return;
    const hs = n.handles.get(handle);
    n.handles.delete(handle);
    this.byHandle.delete(handle);
    for (const b of hs?.beats.values() ?? []) clearInterval(b.timer);
    hs?.beats.clear();
    this.live.drop(handle);
    if (n.handles.size || n.host) {
      this.resubscribe(n);
      await this.rehandle(n).catch((e) => this.say(handle, `libp2p: leaving its key's node: ${(e as Error).message}`));
      this.say(handle, `libp2p: left the node of its key ${n.id} (${n.handles.size} instances on it)`);
      return;
    }
    this.nodes.delete(n.id);
    clearInterval(n.timer);
    try { await n.node.stop(); } catch (e) { this.say(handle, `libp2p: stop: ${(e as Error).message}`); } // dropped either way
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.starting.values()].map((p) => p.catch(() => {}))); // each declare's failure went to its caller: this waits for them to settle
    // Every node stopped at once, its handles with it (nothing to follow on a node that stops).
    await Promise.all([...this.nodes.values()].map(async (n) => {
      for (const [handle, hs] of n.handles) {
        for (const b of hs.beats.values()) clearInterval(b.timer);
        this.byHandle.delete(handle);
        this.live.forget(handle); // the host stopping: its stored beats stay for the next start
      }
      n.handles.clear();
      this.nodes.delete(n.id);
      clearInterval(n.timer);
      try { await n.node.stop(); } catch (e) { this.say(n.id, `libp2p: stop: ${(e as Error).message}`); } // dropped either way
    }));
  }
}

/** A multiaddr on a loopback or private network (dev: the DHT keeps such addresses). */
export function isPrivateAddr(ma: Multiaddr): boolean {
  const c = ma.getComponents().find((x) => x.name.startsWith("dns"));
  if (c?.value) return c.value === "localhost" || c.value.endsWith(".localhost");
  try { return isPrivate(ma); } catch { return true; } // an address isPrivate cannot classify (no IP component) counts as private, as a dev address
}

/** An AbortSignal.timeout's abort: the DHT's 20-second rounds end this way, and the next round tries again. */
const timedOut = (e: unknown): boolean => e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");

/**
 * kad-DHT's clientMode for a mode of the skein DHT (2026-11-01; @libp2p/kad-dht 16.4.5 kad-dht.js): `auto` leaves it
 * unset — the DHT's own switch (a client, a server while the node has a confirmed public address);
 * `client` true — only ever a client; `server` false — a server from its start (its start sets the mode),
 * never switched back. An explicit false is NOT auto in this version: the switch listens only when unset.
 */
export function dhtClientMode(mode: Exclude<DhtMode, "off">): { clientMode?: boolean } {
  return mode === "auto" ? {} : { clientMode: mode === "client" };
}

/**
 * The libp2p logger, with the UPnP service's outcome told once per distinct line (2026-11-01): the gateway
 * search's result, the public IP found, each mapping made or refused, an error. The service reports its
 * outcome nowhere else (its log only); every other component's log is the default, untouched.
 */
export function upnpTold(tell: (line: string) => void): ComponentLogger {
  const base = defaultLogger();
  const said = new Set<string>();
  const fmt = (f: unknown, args: unknown[]) => { let i = 0; return String(f).replace(/%[sdioOjaepcbt]/g, () => { const a = args[i++]; return a instanceof Error ? a.message : String(a); }); };
  const once = (line: string) => { if (!said.has(line)) { said.add(line); tell(line); } };
  const outcome = /^(gateway search finished|discovered public IP|created mapping)/;
  const wrap = (log: Logger): Logger => Object.assign((f: unknown, ...args: unknown[]) => { log(f, ...args); if (outcome.test(String(f))) once(`libp2p: UPnP ${fmt(f, args)}`); }, {
    error: (f: unknown, ...args: unknown[]) => { log.error(f, ...args); once(`libp2p: UPnP ${fmt(f, args)}`); },
    trace: log.trace.bind(log),
    enabled: log.enabled,
    newScope: (s: string) => wrap(log.newScope(s)),
  }) as Logger;
  return { forComponent: (c: string) => c.startsWith("libp2p:upnp-nat") ? wrap(base.forComponent(c)) : base.forComponent(c) };
}

/** A node's DHT service, the skein DHT (#156), or undefined (SKEIN_LIBP2P_DHT=off). */
export function dhtOf(node: Libp2p): KadDHT | undefined {
  return (node.services as Record<string, unknown>).skeinDht as KadDHT | undefined;
}

/** The providers a DHT finds for `cid` (its PROVIDER events' peers), on that DHT alone. */
export async function* providersOf(dht: KadDHT, cid: CID, options: { signal?: AbortSignal } = {}): AsyncIterable<{ id: PeerId; multiaddrs: Multiaddr[] }> {
  for await (const e of dht.findProviders(cid, options)) if (e.name === "PROVIDER") yield* e.providers;
}

/** Run a DHT operation's events to the end. */
export async function drain(events: AsyncIterable<unknown>): Promise<void> { for await (const _ of events) { /* the events: not needed */ } }

/** A DHT's routing table size (undefined: no such DHT). */
export function tableSize(dht: KadDHT | undefined): number | undefined {
  return (dht as unknown as { routingTable?: { size: number } } | undefined)?.routingTable?.size;
}

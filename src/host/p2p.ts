// The router's libp2p host (#43, #51): a router component, like the HTTP
// proxy and the feeds. The runtime has no network; this is where the sockets
// are. One js-libp2p node per instance that declares libp2p — in its config
// (the genesis's `libp2p`, from etc/config.json), or by a `libp2p` row in the
// kernel's dispatch table (#72, #77: a topic, or a `/<protocol>`) — each
// with its own peer key, all inside the router process:
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
//              certificate), Kademlia DHT off | client | server, mDNS on/off,
//              bootstrap peers kept connected, circuit relays.
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
// Host-wide settings (hostP2PConfig): SKEIN_LIBP2P_LISTEN, _BOOTSTRAP, _RELAYS
// (comma-separated multiaddrs), _DHT (off | client | server), _MDNS (on | off),
// _TLS_CERT / _TLS_KEY (PEM files: the WebSocket listener serves TLS, so
// browsers can dial /tls/ws); from the environment, else $SKEIN_HOME/host.env.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { privateKeyFromRaw } from "@libp2p/crypto/keys";
import { gossipsub, TopicValidatorResult } from "@libp2p/gossipsub";
import { identify } from "@libp2p/identify";
import type { Libp2p, PeerId, Stream } from "@libp2p/interface";
import { kadDHT, passthroughMapper, removePrivateAddressesMapper } from "@libp2p/kad-dht";
import { mdns } from "@libp2p/mdns";
import { peerIdFromPrivateKey, peerIdFromString } from "@libp2p/peer-id";
import { ping } from "@libp2p/ping";
import { tcp } from "@libp2p/tcp";
import { isPrivate, lpStream, type LengthPrefixedStream } from "@libp2p/utils";
import { webSockets } from "@libp2p/websockets";
import { multiaddr, type Multiaddr } from "@multiformats/multiaddr";
import type { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { createLibp2p } from "libp2p";
import type { Store } from "../runtime/store.ts";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { MESSAGE_KEY_ID, MESSAGE_PROTOCOL as SIGN_PROTOCOL } from "./providers.ts";
import { verifyAnyone } from "../runtime/identity.ts";

export type DhtMode = "off" | "client" | "server";

/** The host-wide settings: every node gets these. */
export interface P2PHostConfig {
  listen: string[];
  bootstrap: string[];
  dht: DhtMode;
  relays: string[];
  mdns: boolean;
  /** PEM certificate and key for the WebSocket listener (WSS). */
  tls?: { cert: string; key: string };
}

/** One instance's libp2p config (the genesis's `libp2p`): what the router subscribes and serves for it. */
export interface P2PInstanceConfig {
  topics: string[];
  protocols: string[];
  /** This instance's listen addresses (over the host's): a fixed port belongs to one node. */
  listen?: string[];
}

/** The default listeners: loopback TCP and WebSocket, ports chosen by the OS (plain WS on loopback: dev only). */
export const DEFAULT_LISTEN = ["/ip4/127.0.0.1/tcp/0", "/ip4/127.0.0.1/tcp/0/ws"];

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
}

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

/** The host-wide settings: the environment's SKEIN_LIBP2P_*, else $SKEIN_HOME/host.env's. */
export function hostP2PConfig(vars: Record<string, string | undefined>, home?: string): P2PHostConfig {
  const file: Record<string, string> = {};
  const envFile = home ? join(home, "host.env") : undefined;
  if (envFile && existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const m = /^\s*(?:export\s+)?(SKEIN_LIBP2P_[A-Z_]+)=(.*)$/.exec(line);
      if (m) file[m[1]!] = m[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
    }
  }
  const get = (k: string) => vars[k] ?? file[k];
  const dht = (get("SKEIN_LIBP2P_DHT") || "off").toLowerCase();
  if (dht !== "off" && dht !== "client" && dht !== "server") throw new Error(`SKEIN_LIBP2P_DHT: off | client | server, not ${dht}`);
  const cert = get("SKEIN_LIBP2P_TLS_CERT"), key = get("SKEIN_LIBP2P_TLS_KEY");
  const listen = list(get("SKEIN_LIBP2P_LISTEN"));
  return {
    listen: listen.length ? listen : DEFAULT_LISTEN,
    bootstrap: list(get("SKEIN_LIBP2P_BOOTSTRAP")),
    dht,
    relays: list(get("SKEIN_LIBP2P_RELAYS")),
    mdns: /^(on|1|true|yes)$/i.test(get("SKEIN_LIBP2P_MDNS") ?? ""),
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
 * rows added since the genesis (an app's install; address: a topic, or
 * `/<protocol>`) — a genesis row alone subscribes nothing, as a route alone
 * did not — plus the topics the apps subscribed (#119, `subscribed`).
 * `beacons` (#126): an app's beacon needs the node, and adds no topic.
 * Undefined: no node — the genesis declares none and nothing needs one.
 */
export function libp2pConfig(g: Record<string, unknown> | null | undefined, rows: Array<Record<string, unknown>>, subscribed: string[] = [], beacons = false): P2PInstanceConfig | undefined {
  const base = libp2pOf(g);
  const seeded = new Set(((g?.dispatch as Array<Record<string, unknown>> | undefined) ?? []).filter((r) => r.transport === "libp2p").map((r) => String(r.address)));
  const names = rows.filter((r) => r.transport === "libp2p" && !seeded.has(String(r.address))).map((r) => r.address).filter((p): p is string => typeof p === "string" && p.length > 0);
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

const isTopic = (t: unknown): t is string => typeof t === "string" && t.length > 0 && !/[\s\0]/.test(t) && !t.startsWith("/");

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

/** The event records the steps' updates list in `emitted` that `read` takes, in log order (the kernel's fold order, subscriptions.zig). */
async function emittedEvents<T>(store: Pick<Store, "get" | "chains" | "edges">, read: (rec: Record<string, unknown>) => T | undefined): Promise<T[]> {
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
        const e = read(rec);
        if (e === undefined) continue;
        found.push({ key: [await nOf(u.input), Number(u.at ?? 0), Number(o.at ?? 0), seq, i], thread: origin.bytes, e });
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
/** A stream an instance dialled (the libp2p provider's). */
interface OpenStream { stream: Stream; lp: LengthPrefixedStream }

interface Node {
  handle: string;
  node: Libp2p;
  config: P2PInstanceConfig;
  streams: Map<number, OpenStream>;
  /** publish's seqno, caught in msgIdFn by the data object published. */
  seqnos: Map<Uint8Array, bigint>;
  /** The beacons' timers (#126), by "<app> <topic>". */
  beats: Map<string, { beacon: Beacon; timer: ReturnType<typeof setInterval> }>;
  timer?: ReturnType<typeof setInterval>;
}

/** Stream IDs unique across restarts (a thread's recorded stream never names a later stream). */
let nextStream = Date.now() * 1000;

const u64 = (n: bigint): Uint8Array => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, false); return b; };

export class P2PHost {
  readonly o: P2POptions;
  private nodes = new Map<string, Node>();
  /** Each instance's declares, in order (one at a time). */
  private starting = new Map<string, Promise<unknown>>();
  private stopped = false;

  constructor(o: P2POptions) { this.o = o; }

  private say(source: string, line: string): void { this.o.log?.(source, line); }

  /** The node of an instance, if it has one. */
  node(handle: string): Libp2p | undefined { return this.nodes.get(handle)?.node; }

  /** An instance's peer ID (derived: whether or not its node runs). */
  peerId(handle: string): string { return peerIdOf(this.o.keyOf(handle)).toString(); }

  /** Where an instance's node listens (with /p2p/<id>). */
  addrs(handle: string): string[] { return this.node(handle)?.getMultiaddrs().map((m) => m.toString()) ?? []; }

  /**
   * `handle`'s libp2p config is this: its node started (once) with its peer key,
   * its topics subscribed with the validator, its protocols handled. Declared
   * again, the running node is brought to the new config (reconfigure). No
   * config: no node (an existing one is stopped).
   */
  async declare(handle: string, config: P2PInstanceConfig | undefined): Promise<void> {
    if (this.stopped) return;
    const prev = this.starting.get(handle) ?? Promise.resolve();
    // The previous declare's failure went to its own caller (it awaited it); this one runs regardless.
    const next = prev.catch(() => {}).then(async () => {
      if (this.stopped) return;
      if (!config) return this.drop(handle);
      const n = this.nodes.get(handle);
      if (n) return this.reconfigure(n, config);
      await this.start(handle, config);
    });
    this.starting.set(handle, next);
    // Only clears the slot: the error reaches this call's caller through `await next` below.
    void next.catch(() => {}).finally(() => { if (this.starting.get(handle) === next) this.starting.delete(handle); });
    await next;
  }

  /** The topics and protocols an instance's node serves now. */
  served(handle: string): { topics: string[]; protocols: string[] } | undefined {
    const n = this.nodes.get(handle);
    return n && { topics: [...n.config.topics], protocols: [...n.config.protocols] };
  }

  /** Bring a running node to `config`: subscribe and handle what is new, unsubscribe and unhandle what is gone. */
  private async reconfigure(n: Node, config: P2PInstanceConfig): Promise<void> {
    const was = n.config;
    const ps = this.pubsub(n);
    const added = config.topics.filter((t) => !was.topics.includes(t));
    const removed = was.topics.filter((t) => !config.topics.includes(t));
    const addedP = config.protocols.filter((p) => !was.protocols.includes(p) && p !== MESSAGE_PROTOCOL);
    const removedP = was.protocols.filter((p) => !config.protocols.includes(p) && p !== MESSAGE_PROTOCOL);
    if (!added.length && !removed.length && !addedP.length && !removedP.length) { n.config = { ...config, listen: was.listen }; return; }
    for (const t of removed) { ps.unsubscribe(t); ps.topicValidators.delete(t); }
    for (const t of added) this.subscribe(n, t);
    for (const p of removedP) await n.node.unhandle(p);
    for (const p of addedP) await this.handleProtocol(n, p);
    n.config = { ...config, listen: was.listen };
    const list = (xs: string[]) => xs.join(", ") || "none";
    this.say(n.handle, `libp2p: topics ${list(config.topics)} (+${list(added)} −${list(removed)}); protocols ${list(config.protocols)} (+${list(addedP)} −${list(removedP)})`);
    if (added.length) setTimeout(() => void this.discover(n).catch((e) => this.say(n.handle, `libp2p: discovery: ${(e as Error).message}`)), 200);
  }

  private subscribe(n: Node, topic: string): void {
    const ps = this.pubsub(n);
    ps.topicValidators.set(topic, (from: PeerId, msg: { type: string }) => this.validate(n, topic, from, msg as never));
    ps.subscribe(topic);
  }

  private async handleProtocol(n: Node, protocol: string): Promise<void> {
    await n.node.handle(protocol, (stream, connection) => { void this.serve(n, protocol, stream, connection.remotePeer); }, { runOnLimitedConnection: true });
  }

  private async start(handle: string, config: P2PInstanceConfig): Promise<Node | undefined> {
    const h = this.o.host;
    const n: Node = { handle, node: undefined as never, config, streams: new Map(), seqnos: new Map(), beats: new Map() };
    const listen = [...(config.listen ?? h.listen), ...h.relays.map((r) => `${r.replace(/\/+$/, "")}/p2p-circuit`)];
    // An address that does not parse counts as private here; start() reports it when it is dialled or listened on.
    const privateDev = [...h.bootstrap, ...listen].every((a) => { try { return isPrivateAddr(multiaddr(a)); } catch { return true; } });
    const services: Record<string, unknown> = {
      identify: identify(),
      ping: ping(),
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
    if (h.dht !== "off") services.dht = kadDHT({ clientMode: h.dht === "client", peerInfoMapper: privateDev ? passthroughMapper : removePrivateAddressesMapper });
    const node = await createLibp2p({
      privateKey: libp2pKey(this.o.keyOf(handle)),
      addresses: { listen },
      transports: [tcp(), webSockets(h.tls ? { https: { cert: h.tls.cert, key: h.tls.key } } : {}), ...(h.relays.length ? [circuitRelayTransport()] : [])],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      peerDiscovery: h.mdns ? [mdns()] : [],
      services: services as never,
    });
    n.node = node;
    if (this.stopped) { await node.stop(); return undefined; }
    this.nodes.set(handle, n);
    if (h.mdns) node.addEventListener("peer:discovery", (e) => { void node.dial(e.detail.id).catch((err) => this.say(handle, `libp2p: mDNS peer ${e.detail.id}: ${(err as Error).message}`)); });
    for (const topic of config.topics) this.subscribe(n, topic);
    for (const protocol of [...config.protocols, ...(config.protocols.includes(MESSAGE_PROTOCOL) ? [] : [MESSAGE_PROTOCOL])]) await this.handleProtocol(n, protocol);
    this.say(handle, `libp2p: peer ${node.peerId} listening on ${node.getMultiaddrs().map(String).join(" ") || "(nothing)"}; topics ${config.topics.join(", ") || "none"}; protocols ${config.protocols.join(", ") || "none"}`);
    const discover = () => void this.discover(n).catch((e) => this.say(handle, `libp2p: discovery: ${(e as Error).message}`));
    setTimeout(discover, 200);
    n.timer = setInterval(discover, this.o.discoveryMs ?? 30_000);
    return n;
  }

  // ---------------------------------------------------------------- discovery

  /** Keep the bootstrap peers connected; with the DHT on, advertise each topic and dial its providers. */
  private async discover(n: Node): Promise<void> {
    const node = n.node;
    const connected = new Set(node.getConnections().map((c) => c.remotePeer.toString()));
    for (const a of this.o.host.bootstrap) {
      let ma: Multiaddr;
      try { ma = multiaddr(a); } catch { this.say(n.handle, `libp2p: bad bootstrap address ${a}`); continue; }
      const id = ma.getComponents().find((c) => c.name === "p2p")?.value;
      if (id === node.peerId.toString() || (id && connected.has(id))) continue;
      await node.dial(ma).catch((e) => this.say(n.handle, `libp2p: bootstrap ${a}: ${(e as Error).message}`));
    }
    if (this.o.host.dht === "off" || !(node.services as Record<string, unknown>).dht) return;
    for (const topic of n.config.topics) {
      const cid = await topicCid(topic);
      await node.contentRouting.provide(cid, { signal: AbortSignal.timeout(20_000) }).catch((e) => { if (!timedOut(e)) this.say(n.handle, `libp2p: provide ${topic}: ${(e as Error).message}`); });
      try {
        for await (const p of node.contentRouting.findProviders(cid, { signal: AbortSignal.timeout(20_000) })) {
          if (p.id.equals(node.peerId) || node.getConnections(p.id).length) continue;
          await node.dial(p.multiaddrs.length ? p.multiaddrs : p.id).catch((e) => this.say(n.handle, `libp2p: ${topic} provider ${p.id}: ${(e as Error).message}`));
        }
      } catch (e) { if (!timedOut(e)) this.say(n.handle, `libp2p: find providers ${topic}: ${(e as Error).message}`); } // timed out: next round
    }
  }

  // ---------------------------------------------------------------- inbound

  private pubsub(n: Node) {
    return (n.node.services as { pubsub: ReturnType<ReturnType<typeof gossipsub>> }).pubsub;
  }

  /** The topic validator: one front-door call; its verdict is GossipSub's (async: forwarding waits on it). */
  private async validate(n: Node, topic: string, _source: PeerId, msg: { type: string; from: PeerId; data: Uint8Array; sequenceNumber: bigint; signature: Uint8Array }): Promise<TopicValidatorResult> {
    if (msg.type !== "signed") return TopicValidatorResult.Reject;
    try {
      const a = await this.o.inbound(n.handle, {
        transport: "libp2p", topic, from: msg.from.toMultihash().bytes, seqno: u64(msg.sequenceNumber), signature: msg.signature, body: msg.data,
      });
      return a.verdict === "accept" ? TopicValidatorResult.Accept : a.verdict === "reject" ? TopicValidatorResult.Reject : TopicValidatorResult.Ignore;
    } catch (e) {
      // The host failing is not the message's fault: no penalty.
      this.say(n.handle, `libp2p: ${topic}: validation failed: ${(e as Error).message}`);
      return TopicValidatorResult.Ignore;
    }
  }

  /** An inbound stream on a handled protocol: each frame one front-door call, its answer's body written back. */
  private async serve(n: Node, protocol: string, stream: Stream, remote: PeerId): Promise<void> {
    const lp = lpStream(stream);
    try {
      for (;;) {
        let frame: Uint8Array;
        try { frame = (await lp.read()).subarray(); } catch { break; } // the remote closed or reset its side: the stream is over either way, and nothing here is owed an answer
        const a = await this.o.inbound(n.handle, { transport: "libp2p", protocol, from: remote.toMultihash().bytes, body: frame });
        if (a.body) await lp.write(a.body);
        if (a.close || a.verdict === "reject") break;
      }
      await stream.close().catch(() => {}); // a stream the remote already closed or reset cannot be closed again; every frame was answered
    } catch (e) {
      this.say(n.handle, `libp2p: ${protocol} from ${remote}: ${(e as Error).message}`);
      stream.abort(e as Error);
    }
  }

  // ---------------------------------------------------------------- outbound (the libp2p provider's, #70)

  private nodeOf(handle: string): Node {
    const n = this.nodes.get(handle);
    if (!n) throw new Error("this instance has no libp2p node (its config names no libp2p)");
    return n;
  }

  /**
   * The beacons `handle`'s node beats (#126): each a new frame (beaconFrame:
   * the body, the beat's time, the instance's signature) published on its topic
   * every `every` ms, from now on — the topic not subscribed; nothing logged
   * per beat (a failed beat is dropped: the next one is the retry). One line
   * when a beacon starts, changes or stops. No node: nothing beats.
   */
  beacons(handle: string, beacons: Beacon[]): void {
    const n = this.nodes.get(handle);
    if (!n) return;
    const want = new Map(beacons.map((b) => [`${b.app} ${b.topic}`, b]));
    for (const [k, x] of n.beats) {
      const b = want.get(k);
      if (b && b.every === x.beacon.every && Buffer.from(b.body).equals(Buffer.from(x.beacon.body))) continue;
      clearInterval(x.timer);
      n.beats.delete(k);
      if (!b) this.say(handle, `libp2p: beacon ${x.beacon.topic} (app ${x.beacon.app}) stopped`);
    }
    for (const [k, b] of want) {
      if (n.beats.has(k)) continue;
      // Each beat a new frame: the body, now, signed by the instance's signer (beaconFrame).
      const beat = () => {
        if (this.nodes.get(handle) !== n) return;
        const { sign, identity } = this.o;
        if (!sign || !identity) return;
        void (async () => {
          const sender = await identity(handle);
          if (!sender) return;
          await this.publish(handle, b.topic, await beaconFrame(b.topic, b.body, Date.now(), sender, (d) => sign(handle, d)));
        })().catch(() => {});
      };
      n.beats.set(k, { beacon: b, timer: setInterval(beat, b.every) });
      beat();
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
    const target = peer.startsWith("/") ? multiaddr(peer) : peerIdFromString(peer);
    const stream = await n.node.dialProtocol(target, protocol, { signal: AbortSignal.timeout(15_000) });
    const id = ++nextStream;
    const s = { stream, lp: lpStream(stream) };
    n.streams.set(id, s);
    void (async () => {
      for (;;) {
        try {
          frames({ body: (await s.lp.read()).subarray() });
        } catch (e) {
          const name = (e as Error).name;
          const clean = name === "UnexpectedEOFError" || name === "StreamClosedError" || name === "StreamResetError";
          if (n.streams.get(id) === s) frames({ closed: true, ...(clean ? {} : { error: (e as Error).message }) });
          return;
        }
      }
    })();
    return id;
  }

  /** Write one length-prefixed frame on a dialled stream. */
  async send(handle: string, id: number, body: Uint8Array): Promise<void> {
    const s = this.nodeOf(handle).streams.get(id);
    if (!s) throw new Error(`send: no stream ${id}`);
    await s.lp.write(body);
  }

  /** Close a dialled stream (our side), and forget it. */
  async close(handle: string, id: number): Promise<void> {
    const n = this.nodeOf(handle);
    const s = n.streams.get(id);
    if (!s) throw new Error(`close: no stream ${id}`);
    n.streams.delete(id);
    await s.stream.close().catch(() => s.stream.abort(new Error("closed")));
  }

  // ---------------------------------------------------------------- lifecycle

  private async drop(handle: string): Promise<void> {
    const n = this.nodes.get(handle);
    if (!n) return;
    this.nodes.delete(handle);
    clearInterval(n.timer);
    for (const b of n.beats.values()) clearInterval(b.timer);
    n.beats.clear();
    try { await n.node.stop(); } catch (e) { this.say(handle, `libp2p: stop: ${(e as Error).message}`); } // dropped either way
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.starting.values()].map((p) => p.catch(() => {}))); // each declare's failure went to its caller: this waits for them to settle
    await Promise.all([...this.nodes.keys()].map((h) => this.drop(h)));
  }
}

/** A multiaddr on a loopback or private network (dev: the DHT keeps such addresses). */
function isPrivateAddr(ma: Multiaddr): boolean {
  const c = ma.getComponents().find((x) => x.name.startsWith("dns"));
  if (c?.value) return c.value === "localhost" || c.value.endsWith(".localhost");
  try { return isPrivate(ma); } catch { return true; } // an address isPrivate cannot classify (no IP component) counts as private, as a dev address
}

/** An AbortSignal.timeout's abort: the DHT's 20-second rounds end this way, and the next round tries again. */
const timedOut = (e: unknown): boolean => e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");

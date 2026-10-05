// The router's libp2p host (#43, #51): a router component, like the HTTP
// proxy and the feeds. The runtime has no network; this is where the sockets
// are. One js-libp2p node per instance that declares libp2p — in its config
// (the genesis's `libp2p`, from etc/config.json), or by a `libp2p` row in the
// kernel's dispatch table (#72, #77: a topic, or a `/<protocol>`) — each
// with its own peer key, all inside the router process:
//
//   peer key   a secp256k1 key derived from the master secret with BRC-42/43
//              ([2, "skein instance"], key ID `libp2p:<handle>`, self — signer.ts
//              peerKey): a child, never a wallet root. The peer ID is the identity
//              multihash of the key's protobuf (type secp256k1, the 33-byte
//              compressed key), so the key reads straight out of the peer ID.
//   node       GossipSub (StrictSign: every message is signed by its publisher's
//              peer key), noise + yamux, TCP and WebSocket listeners (WSS with a
//              certificate), Kademlia DHT off | client | server, mDNS on/off,
//              bootstrap peers kept connected, circuit relays.
//   topics     the instance's `libp2p.topics` and its dispatch table's libp2p
//              rows' topics (libp2pConfig): subscribed; each message is judged
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
import { createLibp2p } from "libp2p";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

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
 * did not. Undefined: no node — the genesis declares none and no row needs
 * one.
 */
export function libp2pConfig(g: Record<string, unknown> | null | undefined, rows: Array<Record<string, unknown>>): P2PInstanceConfig | undefined {
  const base = libp2pOf(g);
  const seeded = new Set(((g?.dispatch as Array<Record<string, unknown>> | undefined) ?? []).filter((r) => r.transport === "libp2p").map((r) => String(r.address)));
  const names = rows.filter((r) => r.transport === "libp2p" && !seeded.has(String(r.address))).map((r) => r.address).filter((p): p is string => typeof p === "string" && p.length > 0);
  if (!base && !names.length) return undefined;
  const add = (xs: string[], ys: string[]) => [...new Set([...xs, ...ys])];
  return {
    topics: add(base?.topics ?? [], names.filter((n) => !n.startsWith("/"))),
    protocols: add(base?.protocols ?? [], names.filter((n) => n.startsWith("/"))),
    ...(base?.listen ? { listen: base.listen } : {}),
  };
}

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
    const next = prev.catch(() => {}).then(async () => {
      if (this.stopped) return;
      if (!config) return this.drop(handle);
      const n = this.nodes.get(handle);
      if (n) return this.reconfigure(n, config);
      await this.start(handle, config);
    });
    this.starting.set(handle, next);
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
    if (added.length) setTimeout(() => void this.discover(n).catch(() => {}), 200);
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
    const n: Node = { handle, node: undefined as never, config, streams: new Map(), seqnos: new Map() };
    const listen = [...(config.listen ?? h.listen), ...h.relays.map((r) => `${r.replace(/\/+$/, "")}/p2p-circuit`)];
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
    if (h.mdns) node.addEventListener("peer:discovery", (e) => { void node.dial(e.detail.id).catch(() => {}); });
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
      await node.contentRouting.provide(cid, { signal: AbortSignal.timeout(20_000) }).catch(() => {});
      try {
        for await (const p of node.contentRouting.findProviders(cid, { signal: AbortSignal.timeout(20_000) })) {
          if (p.id.equals(node.peerId) || node.getConnections(p.id).length) continue;
          await node.dial(p.multiaddrs.length ? p.multiaddrs : p.id).catch(() => {});
        }
      } catch { /* timed out: next round */ }
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
        try { frame = (await lp.read()).subarray(); } catch { break; } // the remote closed its side
        const a = await this.o.inbound(n.handle, { transport: "libp2p", protocol, from: remote.toMultihash().bytes, body: frame });
        if (a.body) await lp.write(a.body);
        if (a.close || a.verdict === "reject") break;
      }
      await stream.close().catch(() => {});
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
    try { await n.node.stop(); } catch { /* stopping anyway */ }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.starting.values()].map((p) => p.catch(() => {})));
    await Promise.all([...this.nodes.keys()].map((h) => this.drop(h)));
  }
}

/** A multiaddr on a loopback or private network (dev: the DHT keeps such addresses). */
function isPrivateAddr(ma: Multiaddr): boolean {
  const c = ma.getComponents().find((x) => x.name.startsWith("dns"));
  if (c?.value) return c.value === "localhost" || c.value.endsWith(".localhost");
  try { return isPrivate(ma); } catch { return true; }
}

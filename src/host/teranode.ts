// The host's headers tracker over the Teranode P2P network (shruggr/skein#156):
// a packaged host learns block headers itself, as any ChainTracks instance
// does (bsv-blockchain/go-chaintracks chainmanager p2p.go + sync.go), with no
// headers service configured.
//
// The Teranode network is libp2p (go-p2p-message-bus): TCP, noise, yamux, a
// kad-DHT, GossipSub with StrictSign. Bootstrap peers are the network's
// `/dnsaddr/<net>.bootstrap.teranode.bsvb.tech` (go-teranode-p2p-client
// config.go); the block topic is `teranode/bitcoin/1.0.0/<network>-block`
// (topics.go: main → mainnet, test → testnet, regtest → regtest). A message on
// it is the bus's envelope `{"name", "data": <base64>}` (client.go Publish)
// whose data is teranode's BlockMessage as Go marshals it (no JSON tags:
// services/p2p/message_types.go): `{PeerID, ClientName, DataHubURL, Hash,
// Height, Header (80 bytes, hex), Coinbase}`. A bare BlockMessage (no
// envelope) is taken too. Anything else on the topic is dropped.
//
// What it does with an announcement (TrackerChain: the host's image chain,
// image-chain.ts, and the router's intake behind it):
//
//   - a header the host holds near its tip: nothing;
//   - one whose parent it holds near its tip: taken at the parent's height + 1
//     (the intake replaces from there: a reorg one deep);
//   - otherwise: crawl back from the announcer's data hub (`GET
//     <hub>/headers/<hash>?n=<count>`: up to `count` 80-byte headers, child to
//     parent, the asked one first) until a header the host holds, then the run,
//     parents first, to the intake. Capped (`maxCrawl` headers), every page's
//     links checked and each header's proof of work, a timeout per request, no
//     redirect followed.
//
// First boot (`initial`): with an empty image chain, the whole chain from the
// network's default hub (gorillanode, or SKEIN_HEADERS_HUB) — `bestblockheader`
// then `headers/<hash>?n=` back to genesis — written in height order; one log
// line per page ("headers: initial sync <have>/<tip height>"). No default hub
// (regtest) and none named: it waits for the first announcement and syncs from
// ITS hub. Same crawl both ways.
//
// The node is the host's own (one per host), separate from the overlay's
// libp2p nodes (p2p.ts): another mesh, another key ($SKEIN_HOME/teranode.key,
// an Ed25519 key made at first run, mode 0600, as go-teranode-p2p-client keeps
// its p2p_key.hex).

import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from "@libp2p/crypto/keys";
import { gossipsub } from "@libp2p/gossipsub";
import { identify } from "@libp2p/identify";
import type { Libp2p, PrivateKey } from "@libp2p/interface";
import { kadDHT, passthroughMapper, removePrivateAddressesMapper } from "@libp2p/kad-dht";
import { ping } from "@libp2p/ping";
import { tcp } from "@libp2p/tcp";
import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2p } from "libp2p";
import { headerProblem } from "./image-chain.ts";
import { isPrivateAddr, topicCid } from "./p2p.ts";

/** The network's bootstrap peers (go-teranode-p2p-client config.go); regtest has none. */
export const TERANODE_BOOTSTRAP: Record<string, string[]> = {
  main: ["/dnsaddr/mainnet.bootstrap.teranode.bsvb.tech"],
  test: ["/dnsaddr/testnet.bootstrap.teranode.bsvb.tech"],
};

/** The default data hub per network (first sync; the gorillanode Teranode asset API); regtest has none. */
export const DEFAULT_HUBS: Record<string, string> = {
  main: "https://mainnet.gorillanode.io/api/v1",
  test: "https://testnet.gorillanode.io/api/v1",
};

const TOPIC_NETWORK: Record<string, string> = { main: "mainnet", test: "testnet", regtest: "regtest" };

/** The block topic of a network (SKEIN_NETWORK's names, or the topic's own). */
export function blockTopic(network: string): string {
  return `teranode/bitcoin/1.0.0/${TOPIC_NETWORK[network] ?? network}-block`;
}

const SIZE = 80;
const sha256d = (b: Uint8Array) => createHash("sha256").update(createHash("sha256").update(b).digest()).digest();
const display = (h: Uint8Array) => Buffer.from(h).reverse().toString("hex");
/** A header's hash, display hex. */
export const hashOf = (raw: Uint8Array) => display(sha256d(raw));
/** A header's parent's hash, display hex. */
export const prevOf = (raw: Uint8Array) => display(raw.subarray(4, 36));
const ZERO = "0".repeat(64);

/** One block announcement, as the tracker reads it. */
export interface Announcement { hash: string; height: number; header: Uint8Array; hub?: string; peer?: string }

/**
 * A block announcement out of a message on the block topic: the bus's envelope or a bare
 * BlockMessage. Undefined (dropped) when it is neither, its header is not 80 bytes of hex, or the
 * header's hash is not the `Hash` it names.
 */
export function parseAnnouncement(data: Uint8Array): Announcement | undefined {
  let v: unknown;
  try { v = JSON.parse(Buffer.from(data).toString("utf8")); } catch { return undefined; } // not JSON: not a block message
  let o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return undefined;
  if (typeof o.data === "string" && o.Header === undefined) {
    try { o = JSON.parse(Buffer.from(o.data, "base64").toString("utf8")) as Record<string, unknown>; } catch { return undefined; } // an envelope whose data is not a BlockMessage
    if (!o || typeof o !== "object") return undefined;
  }
  if (typeof o.Header !== "string" || !/^[0-9a-fA-F]{160}$/.test(o.Header)) return undefined;
  const header = Uint8Array.from(Buffer.from(o.Header, "hex"));
  const hash = hashOf(header);
  if (typeof o.Hash !== "string" || o.Hash.toLowerCase() !== hash) return undefined;
  const height = typeof o.Height === "number" && Number.isInteger(o.Height) && o.Height >= 0 ? o.Height : -1;
  if (height < 0) return undefined;
  const hub = typeof o.DataHubURL === "string" && /^https?:\/\//.test(o.DataHubURL) ? o.DataHubURL.replace(/\/+$/, "") : undefined;
  return { hash, height, header, ...(hub ? { hub } : {}), ...(typeof o.PeerID === "string" ? { peer: o.PeerID } : {}) };
}

// ---------------------------------------------------------------- a data hub (untrusted)

export interface HubOptions { fetch?: typeof fetch; timeoutMs?: number }

async function hubGet(url: string, o: HubOptions, max: number): Promise<Buffer> {
  const res = await (o.fetch ?? fetch)(url, { redirect: "error", signal: AbortSignal.timeout(o.timeoutMs ?? 30_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const b = Buffer.from(await res.arrayBuffer());
  if (b.length > max) throw new Error(`${url}: ${b.length} bytes, more than ${max}`);
  return b;
}

/** The hub's best header (80 bytes) and, when it says, its height (`bestblockheader/json`). */
export async function hubBest(hub: string, o: HubOptions = {}): Promise<{ header: Uint8Array; hash: string; height?: number }> {
  const b = await hubGet(`${hub}/bestblockheader`, o, SIZE);
  if (b.length !== SIZE) throw new Error(`${hub}/bestblockheader: ${b.length} bytes, not a header`);
  const why = headerProblem(b);
  if (why) throw new Error(`${hub}/bestblockheader: ${why}`);
  let height: number | undefined;
  try {
    const j = JSON.parse((await hubGet(`${hub}/bestblockheader/json`, o, 64 * 1024)).toString("utf8")) as { hash?: unknown; height?: unknown };
    if (j.hash === hashOf(b) && typeof j.height === "number") height = j.height;
  } catch { /* the height is only for the progress line */ }
  return { header: Uint8Array.from(b), hash: hashOf(b), ...(height !== undefined ? { height } : {}) };
}

/**
 * Up to `n` headers from `hash` back (child to parent, `hash` first): each one's proof of work and
 * every link checked; a page that does not start at `hash` or does not link is refused.
 */
export async function hubBack(hub: string, hash: string, n: number, o: HubOptions = {}): Promise<Uint8Array[]> {
  const url = `${hub}/headers/${hash}?n=${n}`;
  const b = await hubGet(url, o, n * SIZE);
  if (b.length === 0 || b.length % SIZE) throw new Error(`${url}: ${b.length} bytes, not whole headers`);
  const out: Uint8Array[] = [];
  for (let i = 0; i < b.length; i += SIZE) out.push(Uint8Array.from(b.subarray(i, i + SIZE)));
  if (hashOf(out[0]!) !== hash) throw new Error(`${url}: its first header is not ${hash}`);
  for (const [i, raw] of out.entries()) {
    const why = headerProblem(raw);
    if (why) throw new Error(`${url}: header ${i}: ${why}`);
    if (i > 0 && prevOf(out[i - 1]!) !== hashOf(raw)) throw new Error(`${url}: header ${i} is not header ${i - 1}'s parent`);
  }
  return out;
}

// ---------------------------------------------------------------- the tracker

/** What the tracker reads and writes: the host's image chain and the intake behind it (Router). */
export interface TrackerChain {
  /** The tip held (undefined: nothing held). */
  tip(): { height: number; hash: string } | undefined;
  /** The height of a header held near the tip, by hash (display hex). */
  find(hash: string): number | undefined;
  /** A run of headers, parents first, at `height` (its first one's): into the image chain and on to the host chain and the instances. */
  take(height: number, raws: Uint8Array[]): Promise<void>;
}

export interface TrackerOptions {
  network: string;
  /** Bootstrap multiaddrs (dnsaddr resolved by libp2p); none: no mesh (a hub-only first sync). */
  bootstrap: string[];
  /** The hub for the first sync (DEFAULT_HUBS, SKEIN_HEADERS_HUB); none: the first announcement's. */
  hub?: string;
  /** The node's key file (created if absent, 0600); none: a fresh key each start. */
  keyFile?: string;
  /**
   * Where the peers met are kept between runs (go-p2p-message-bus's peer cache): dialled at start
   * beside the bootstrap peers, so a restart does not hang on the bootstrap; none: not kept.
   */
  peersFile?: string;
  chain: TrackerChain;
  /** Listen addresses (default: none — the tracker dials out only). */
  listen?: string[];
  /** Headers per hub request: a gap's crawl (default 2 000) and the first sync's (default 10 000; a hub may answer fewer). */
  page?: number;
  bulkPage?: number;
  /** The most headers a gap's crawl walks back before it gives up (default 20 160). */
  maxCrawl?: number;
  /** Peer upkeep: bootstrap redialled, block-topic providers looked up in the DHT (ms, default 30 000). */
  discoveryMs?: number;
  /** The kad-DHT (client mode) on, the default; off for a closed test mesh. */
  dht?: boolean;
  hub_?: HubOptions;
  log?(line: string): void;
}

export class TeranodeTracker {
  readonly o: TrackerOptions;
  readonly topic: string;
  node?: Libp2p;
  /** Settles when the first sync is done (or there was nothing to do); rejects never. */
  ready: Promise<void> = Promise.resolve();
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  private syncing = false;
  /** The newest announcement seen while the first sync ran (caught up from after it). */
  private pending?: Announcement;
  private peers = -1;
  private lastBootErr = "";
  /** Counts for the logs and tests. */
  readonly stats = { announcements: 0, dropped: 0, taken: 0, crawled: 0, known: 0 };

  constructor(o: TrackerOptions) {
    this.o = o;
    this.topic = blockTopic(o.network);
  }

  private say(line: string): void { this.o.log?.(line); }

  /** Join the mesh (when there are bootstrap peers) and start the first sync when the image chain is empty. */
  async start(): Promise<void> {
    if (this.o.bootstrap.length) await this.join();
    // In turn with the announcements (one change to the chain at a time).
    const p = this.queue.then(() => this.initial()).catch((e) => this.say(`headers: initial sync failed: ${(e as Error).message}; the next announcement syncs from its hub`));
    this.queue = p;
    this.ready = p;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    try { await this.node?.stop(); } catch { /* stopping: nothing to keep */ }
  }

  private async key(): Promise<PrivateKey> {
    const f = this.o.keyFile;
    if (f && existsSync(f)) return privateKeyFromProtobuf(Uint8Array.from(Buffer.from(readFileSync(f, "utf8").trim(), "hex")));
    const k = await generateKeyPair("Ed25519");
    if (f) { writeFileSync(f, `${Buffer.from(privateKeyToProtobuf(k)).toString("hex")}\n`, { mode: 0o600 }); chmodSync(f, 0o600); }
    return k;
  }

  private async join(): Promise<void> {
    const t0 = Date.now();
    const privateDev = this.o.bootstrap.every((a) => { try { return isPrivateAddr(multiaddr(a)); } catch { return false; } });
    const services: Record<string, unknown> = {
      identify: identify(),
      ping: ping(),
      pubsub: gossipsub({ globalSignaturePolicy: "StrictSign", allowPublishToZeroTopicPeers: true, emitSelf: false }),
    };
    if (this.o.dht !== false) services.dht = kadDHT({ clientMode: true, peerInfoMapper: privateDev ? passthroughMapper : removePrivateAddressesMapper });
    const node = await createLibp2p({
      privateKey: await this.key(),
      addresses: { listen: this.o.listen ?? [] },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: services as never,
    });
    this.node = node;
    if (this.stopped) { await node.stop(); return; }
    const ps = (node.services as { pubsub: ReturnType<ReturnType<typeof gossipsub>> }).pubsub;
    ps.subscribe(this.topic);
    ps.addEventListener("message", (e) => {
      const m = e.detail as { topic: string; data: Uint8Array };
      if (m.topic !== this.topic) return;
      const a = parseAnnouncement(m.data);
      if (!a) { this.stats.dropped++; return; }
      this.announce(a);
    });
    this.say(`headers: Teranode ${this.o.network} mesh as ${node.peerId} on ${this.topic}; bootstrap ${this.o.bootstrap.join(" ")}`);
    const upkeep = () => void this.upkeep(t0).catch((e) => this.say(`headers: Teranode peers: ${(e as Error).message}`));
    upkeep();
    this.timer = setInterval(upkeep, this.o.discoveryMs ?? 30_000);
    this.timer.unref?.();
  }

  /** The bootstrap peers dialled while too few are connected; the block topic's providers looked up in the DHT. */
  private async upkeep(t0: number): Promise<void> {
    const node = this.node;
    if (!node || this.stopped) return;
    if (node.getConnections().length < 4) {
      const errs: string[] = [];
      await Promise.all([...this.o.bootstrap, ...this.cached()].map(async (a, i) => {
        try { await node.dial(multiaddr(a), { signal: AbortSignal.timeout(20_000) }); } catch (e) { if (i < this.o.bootstrap.length) errs.push(`${a}: ${(e as Error).message}`); }
      }));
      // One line when the bootstrap's answer changes (it is retried every round).
      const err = errs.join("; ");
      if (err !== this.lastBootErr) { this.lastBootErr = err; this.say(err ? `headers: Teranode bootstrap ${err}` : "headers: Teranode bootstrap reached"); }
    }
    if ((node.services as Record<string, unknown>).dht && node.getConnections().length) {
      try {
        let dialled = 0;
        for await (const p of node.contentRouting.findProviders(await topicCid(this.topic), { signal: AbortSignal.timeout(20_000) })) {
          if (p.id.equals(node.peerId) || node.getConnections(p.id).length) continue;
          if (++dialled > 8) break;
          void node.dial(p.multiaddrs.length ? p.multiaddrs : p.id, { signal: AbortSignal.timeout(15_000) }).catch(() => {}); // a provider that does not answer: the next round's
        }
      } catch { /* timed out: the next round */ }
    }
    const ps = (node.services as { pubsub: ReturnType<ReturnType<typeof gossipsub>> }).pubsub;
    const n = node.getConnections().length, onTopic = ps.getSubscribers(this.topic).length;
    this.keep(node, ps.getSubscribers(this.topic).map(String));
    if (n * 1000 + onTopic !== this.peers) {
      this.peers = n * 1000 + onTopic;
      this.say(`headers: Teranode peers ${n} (${onTopic} on the block topic) at ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    }
  }

  /** The peers kept from earlier runs (their dialable addresses). */
  private cached(): string[] {
    const f = this.o.peersFile;
    if (!f || !existsSync(f)) return [];
    try { const v = JSON.parse(readFileSync(f, "utf8")) as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 32) : []; } catch { return []; } // an unreadable cache: none
  }

  /** The peers connected now — the block topic's first — kept for the next run (at most 32). */
  private keep(node: Libp2p, onTopic: string[]): void {
    const f = this.o.peersFile;
    if (!f) return;
    const conns = node.getConnections().filter((c) => c.direction === "outbound" && !c.remoteAddr.toString().includes("/p2p-circuit"));
    conns.sort((a, b) => Number(onTopic.includes(b.remotePeer.toString())) - Number(onTopic.includes(a.remotePeer.toString())));
    const addrs = [...new Set(conns.map((c) => `${c.remoteAddr.toString().replace(/\/p2p\/[^/]+$/, "")}/p2p/${c.remotePeer}`))].slice(0, 32);
    if (!addrs.length) return;
    try { writeFileSync(f, `${JSON.stringify(addrs)}\n`); } catch (e) { this.say(`headers: the Teranode peers not kept: ${(e as Error).message}`); }
  }

  /** An announcement: in turn with the others (one change to the chain at a time). */
  announce(a: Announcement): void {
    this.stats.announcements++;
    if (this.syncing) { this.pending = a; return; }
    this.queue = this.queue.then(() => this.follow(a)).catch((e) => this.say(`headers: block ${a.height} ${a.hash}: ${(e as Error).message}`));
  }

  /** go-chaintracks processBlockMessage: known, a child of a header near the tip, or a crawl back from its hub. */
  private async follow(a: Announcement): Promise<void> {
    const c = this.o.chain;
    if (!c.tip()) {
      // The first sync failed or had no hub: this announcement's hub, from it.
      if (!a.hub) throw new Error("nothing held yet, and the announcement names no data hub: dropped");
      await this.bulk(a.hub, { hash: a.hash, height: a.height });
      return;
    }
    if (c.find(a.hash) !== undefined) { this.stats.known++; return; }
    const parent = c.find(prevOf(a.header));
    if (parent !== undefined) {
      await c.take(parent + 1, [a.header]);
      this.stats.taken++;
      this.say(`headers: block ${parent + 1} ${a.hash}${a.peer ? ` (announced by ${a.peer})` : ""}`);
      return;
    }
    if (!a.hub) throw new Error("links to no header near the tip, and names no data hub: dropped");
    const { base, run } = await this.crawl(a.hub, a.hash, this.o.page ?? 2000, this.o.maxCrawl ?? 20_160);
    await c.take(base + 1, run);
    this.stats.crawled += run.length;
    this.say(`headers: ${run.length} header${run.length === 1 ? "" : "s"} from ${a.hub} to ${a.height} (from ${base + 1})`);
  }

  /**
   * go-chaintracks SyncFromRemoteTip: back from `hash` through the hub until a header held (its
   * height `base`), or the genesis header (base -1: the run starts at 0); the run parents first.
   */
  private async crawl(hub: string, hash: string, page: number, max: number, progress?: (have: number) => void): Promise<{ base: number; run: Uint8Array[] }> {
    const c = this.o.chain;
    const pages: Uint8Array[][] = [];
    let have = 0;
    let at = hash;
    for (;;) {
      if (this.stopped) throw new Error("stopped");
      const got = await hubBack(hub, at, page, this.o.hub_);
      if (pages.length && prevOf(pages.at(-1)!.at(-1)!) !== hashOf(got[0]!)) throw new Error(`${hub}: a page that does not continue the last`);
      for (const [i, raw] of got.entries()) {
        const h = c.find(hashOf(raw));
        if (h !== undefined) {
          pages.push(got.slice(0, i));
          return { base: h, run: pages.flat().reverse() };
        }
      }
      pages.push(got);
      have += got.length;
      progress?.(have);
      const last = got.at(-1)!;
      if (prevOf(last) === ZERO) return { base: -1, run: pages.flat().reverse() }; // the genesis header: the whole chain
      if (have >= max) throw new Error(`${hub}: no header held within ${have} back from ${hash}`);
      at = prevOf(last);
    }
  }

  /** The first sync: an empty chain filled from a hub (the default, else the first announcement's). */
  private async initial(): Promise<void> {
    const hub = this.o.hub;
    if (hub) {
      // Every start: to the hub's best (go-chaintracks's bootstrap sync) — the whole chain when none is held,
      // else what was missed while the host was down (the mesh may take a while to find).
      const best = await hubBest(hub, this.o.hub_);
      if (this.o.chain.find(best.hash) !== undefined) return;
      if (!this.o.chain.tip()) return await this.bulk(hub, best);
      const { base, run } = await this.crawl(hub, best.hash, this.o.bulkPage ?? 10_000, Number.POSITIVE_INFINITY);
      await this.o.chain.take(base + 1, run);
      this.say(`headers: caught up from ${hub}: ${run.length} header${run.length === 1 ? "" : "s"} to ${this.o.chain.tip()?.height}`);
      return;
    }
    if (this.o.chain.tip()) return;
    this.say(`headers: no data hub for ${this.o.network}: waiting for the first block announcement to sync from its hub`);
    // follow() runs the sync for the first announcement (bulk from its hub).
  }

  /** The whole chain, from `best` back to genesis through `hub`, written in height order. */
  private async bulk(hub: string, best: { hash: string; height?: number }): Promise<void> {
    const c = this.o.chain;
    this.syncing = true;
    try {
      const t0 = Date.now();
      const of = best.height !== undefined ? String(best.height + 1) : "?";
      this.say(`headers: initial sync from ${hub}: ${of} headers to ${best.hash}`);
      const { base, run } = await this.crawl(hub, best.hash, this.o.bulkPage ?? 10_000, Number.POSITIVE_INFINITY, (have) => this.say(`headers: initial sync ${have}/${of}`));
      const fetched = Date.now() - t0;
      await c.take(base + 1, run);
      this.say(`headers: initial sync done: ${run.length} headers to ${c.tip()?.height} in ${((Date.now() - t0) / 1000).toFixed(1)} s (fetch ${(fetched / 1000).toFixed(1)} s)`);
    } finally {
      this.syncing = false;
    }
    // What was announced meanwhile: followed now.
    const p = this.pending;
    this.pending = undefined;
    if (p) this.announce(p);
  }
}

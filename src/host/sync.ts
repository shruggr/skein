// Overlay sync (shruggr/skein#150; the settled design, David 2026-10-30,
// shruggr/skein-overlay 0.20.0): the host half of keeping an overlay topic's
// admitted set equal across peers. The overlay engine keeps, per topic,
// BRC-136's anchors and answers the sync protocol's frames; its beacon on
// `<topic>-live` carries `{tipHeight, tipAnchor, tailDigest}`. No timer, no
// retry on a clock, no backoff anywhere here ("a non-starter").
//
//   announce, then  a peer's `admit {txid, topics}` on `<topic>` (router.ts
//   fetch           p2pInbound takes it, never delivers it to the instance):
//                   unless the instance holds the txid (the engine's `holds`
//                   read, by kernel call) or a fetch of it is under way, the
//                   host asks that peer `{kind: "tx", topic, txid}` and hands
//                   the BEEF to the overlay's receive row
//                   /skein/overlay/beef/1.0.0 as from that peer. Per (handle,
//                   txid) it keeps the SET of peers whose admit named it:
//                   fetch from one; on a failure (no answer, no `beef`, the
//                   delivery not taken) the next; the set exhausted, it stops
//                   and waits for a new admit to add a peer (then one more
//                   try, from that peer). A delivery taken (accepted, or the
//                   transaction now held) drops the entry. Nothing logged in
//                   the instance but the delivered BEEF.
//   the beat        a beat newly kept from another peer on `<topic>-live`
//                   starts a reconcile from it — at most one per (handle,
//                   topic, peer) at a time, and a new one only when that
//                   peer's LATEST beat body differs from the one that started
//                   (or, at its end, was the latest for) the last one.
//   mined history   the reconcile's first half: when its tip anchor is not
//                   ours, the locator on the direct stream
//                   /skein/overlay/sync/1.0.0 (our anchors at tip, tip-1,
//                   tip-2, tip-4 … genesis; the peer answers the highest height
//                   where it agrees, its genesis and its tip), then the
//                   peer's admitted lists above the agreed height, by ranges
//                   of `rangeHeights` spread across the peers whose last beat
//                   has the same tip anchor; each block checked against our
//                   headers (its hash, the BUMP's root for every txid) before
//                   any transaction is fetched (a height we hold no header for
//                   yet ends the range: the next changed beat resumes it); each
//                   txid we lack fetched from the peer that listed it into the
//                   receive row, block by block in height order. A peer whose
//                   list fails the check is dropped for the rest of the host's
//                   run.
//   the tail        the reconcile's second half: when the mined side is equal
//                   (its tip anchor is ours at its height, or neither has one)
//                   and its `tailDigest` is not ours (our own beacon's body),
//                   `{kind: "tail", topic}` to that peer, and each txid we do
//                   not hold fetched as an announced one (the per-txid set,
//                   that peer).
//   a start         `reconnect`: the peers a topic's beats came from (host.db,
//                   router.ts) asked at once — the locator and the tail —
//                   without waiting for a beat.
//   answering       not the host's (#154): the engine answers the stream
//                   through the front door, on the libp2p row an app declares.
//   our own reads   the locator, "what we lack" and "do we hold it" read our
//                   own overlay's state by a kernel call of its engine (fn
//                   `anchors`, `admitted`, `holds`; router.ts `overlayRead`).
//
// The wire, one dag-cbor frame each way:
//
//   {kind: "locator", topic, locator: [{height, anchor: bytes(32)}]}
//       → {kind: "locator", topic, genesisHeight?, agreedHeight?, tipHeight?}
//   {kind: "admitted", topic, fromHeight, toHeight, limit}
//       → {kind: "admitted", topic, blocks: [{height, blockHash, txids, bump}], nextHeight}   (hex, as /admitted)
//   {kind: "tx", topic, txid}
//       → {kind: "tx", txid, beef?: bytes}                                                   (absent: not held)
//   {kind: "tail", topic}
//       → {kind: "tail", topic, txids: [hex]}                        the admitted, not mined, in admission order
//   anything else → {kind: "error", message}

import * as dagCbor from "@ipld/dag-cbor";
import { MerklePath } from "@bsv/sdk";
import { peerIdFromMultihash } from "@libp2p/peer-id";
import * as Digest from "multiformats/hashes/digest";
import { RECEIVE_PROTOCOL, type InboundAnswer } from "./p2p.ts";
import type { LiveBeat } from "./liveness.ts";

export const SYNC_PROTOCOL = "/skein/overlay/sync/1.0.0";
/** The overlay's receive row (skein-overlay etc/app.json): the host's own entry, one Atomic BEEF per frame; never served to peers. */
export const BEEF_PROTOCOL = RECEIVE_PROTOCOL;
const LIVE = "-live";

export interface SyncOptions {
  /** The app that beats on `<topic>-live` for `handle` (its overlay), if any. */
  overlayOf(handle: string, liveTopic: string): string | undefined;
  /**
   * Our own overlay's read (shruggr/skein#154): the engine's function `fn` (`anchors`, `admitted`,
   * `holds`) over `handle`'s current state, with its read route's query; its JSON answer. Throws on
   * a status other than 200.
   */
  local(handle: string, app: string, fn: "anchors" | "admitted" | "holds", query: Record<string, string>): Promise<unknown>;
  /** One BEEF into the overlay's receive row, as from `peer` (its peer ID). */
  deliver(handle: string, peer: string, beef: Uint8Array): Promise<InboundAnswer>;
  /** The chain state's header at `height`: its hash and merkle root (display hex). */
  header(handle: string, height: number): Promise<{ hash: string; root: string } | undefined>;
  /** One request frame to `peer` on the sync protocol: its answer frame. */
  request(handle: string, peer: string, body: Uint8Array): Promise<Uint8Array>;
  /** The live beats on a liveness topic at `handle` (the liveness tool's: the latest per sender). */
  beats(handle: string, liveTopic: string): LiveBeat[];
  /** Our own beacon's body on a liveness topic (what our overlay declared last), if any. */
  ownBeat(handle: string, liveTopic: string): Uint8Array | undefined;
  /** `handle`'s own peer ID. */
  self(handle: string): string;
  log?(source: string, line: string): void;
  /** The heights per ranged pull; default 1 000. */
  rangeHeights?: number;
}

/** The beat body's sync fields (skein-overlay topics.zig `beatBody`). */
interface SyncBeat { tipHeight?: number; tipAnchor?: Uint8Array; tailDigest?: Uint8Array }

interface Anchors { topic: string; genesisHeight?: number; tipHeight?: number; anchors: Array<{ height: number; anchor: string }> }
interface AdmittedBlock { height: number; blockHash: string; txids: string[]; bump: string }
interface Admitted { topic: string; blocks: AdmittedBlock[]; nextHeight: number | null }

/** A transaction announced and not yet taken (per handle and txid): the peers that named it. */
interface Announced { app: string; topic: string; peers: string[]; tried: Set<string>; fetching: boolean }

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HEX64 = /^[0-9a-f]{64}$/;

/** A peer ID's string from its multihash bytes. */
export const peerOf = (mh: Uint8Array): string => peerIdFromMultihash(Digest.decode(mh)).toString();

/**
 * An `admit` announcement on `<topic>` (skein-overlay gossip.zig: dag-cbor `{kind: "admit", txid,
 * topics: {<topic>: {outputsToAdmit, coinsToRetain}}}`) → its txid, or undefined when the body is
 * not one naming `topic`.
 */
export function admitOf(topic: string, body: Uint8Array): string | undefined {
  let v: unknown;
  try { v = dagCbor.decode(body); } catch { return undefined; }
  if (!v || typeof v !== "object") return undefined;
  const m = v as { kind?: unknown; txid?: unknown; topics?: unknown };
  if (m.kind !== "admit" || typeof m.txid !== "string" || !HEX64.test(m.txid)) return undefined;
  if (!m.topics || typeof m.topics !== "object" || !(topic in (m.topics as object))) return undefined;
  return m.txid;
}

export class OverlaySync {
  private readonly o: SyncOptions;
  /** `${handle} ${txid}` → the announced transaction, while it is not taken. */
  private announced = new Map<string, Announced>();
  /** Reconciles running: `${handle} ${topic} ${peer}`. */
  private running = new Set<string>();
  /** The beat body (hex) that started, or ended, the last reconcile per `${handle} ${topic} ${peer}`. */
  private seen = new Map<string, string>();
  /** Peers caught serving a list that does not check: per handle. */
  private dropped = new Map<string, Set<string>>();
  private inflight = new Set<Promise<unknown>>();
  private stopped = false;

  constructor(o: SyncOptions) { this.o = o; }

  private say(handle: string, line: string): void { this.o.log?.(handle, `sync: ${line}`); }

  private track<T>(p: Promise<T>): void {
    const q = p.catch(() => {});
    this.inflight.add(q);
    void q.finally(() => this.inflight.delete(q));
  }

  /** Whether anything is under way (a reconcile, a fetch). */
  busy(): boolean { return this.inflight.size > 0; }

  async idle(): Promise<void> { while (this.inflight.size) await Promise.all([...this.inflight]); }

  stop(): void { this.stopped = true; this.announced.clear(); }

  /** The announced transactions not taken yet, per handle (tests). */
  pending(handle: string): Array<{ txid: string; peers: string[]; fetching: boolean }> {
    return [...this.announced].filter(([k]) => k.startsWith(`${handle} `)).map(([k, e]) => ({ txid: k.slice(handle.length + 1), peers: [...e.peers], fetching: e.fetching }));
  }

  private isDropped(handle: string, peer: string): boolean { return this.dropped.get(handle)?.has(peer) ?? false; }

  // ---------------------------------------------------------------- announce, then fetch

  /**
   * A peer's `admit` for `txid` on `topic` (its announcement), at `handle` whose overlay `app` runs
   * the topic: fetched from that peer unless the instance holds it or a fetch of it is under way;
   * the peer joins the transaction's set either way.
   */
  admit(handle: string, app: string, topic: string, txid: string, peer: string): void {
    const p = this.announce(handle, app, topic, txid, peer);
    if (p) this.track(p);
  }

  /** `admit`'s work: the fetch it started, if any (the tail awaits it). */
  private announce(handle: string, app: string, topic: string, txid: string, peer: string): Promise<void> | undefined {
    if (this.stopped || peer === this.o.self(handle)) return undefined;
    const k = `${handle} ${txid}`;
    const e = this.announced.get(k);
    if (e) {
      if (!e.peers.includes(peer)) e.peers.push(peer);
      return e.fetching ? undefined : this.pursue(handle, k, e);
    }
    const fresh: Announced = { app, topic, peers: [peer], tried: new Set(), fetching: true };
    this.announced.set(k, fresh);
    return (async () => {
      if (await this.holds(handle, app, txid)) { this.announced.delete(k); fresh.fetching = false; return; }
      await this.pursue(handle, k, fresh);
    })();
  }

  /** Whether `handle`'s overlay state reaches `txid` (its engine's `holds`). */
  private async holds(handle: string, app: string, txid: string): Promise<boolean> {
    try {
      const h = await this.o.local(handle, app, "holds", { txid }) as { txid?: string };
      return typeof h?.txid === "string";
    } catch (e) {
      this.say(handle, `holds ${txid}: ${(e as Error).message}`);
      return false;
    }
  }

  /** Fetch an announced transaction from its peers, one after another, until one delivery is taken or none is left. */
  private async pursue(handle: string, k: string, e: Announced): Promise<void> {
    e.fetching = true;
    try {
      for (;;) {
        if (this.stopped || this.announced.get(k) !== e) return;
        const peer = e.peers.find((p) => !e.tried.has(p));
        if (!peer) return; // exhausted: a new admit adds a peer
        e.tried.add(peer);
        const txid = k.slice(handle.length + 1);
        const taken = await this.fetchInto(handle, peer, e.topic, txid).catch((x) => { this.say(handle, `${e.topic}: ${txid} from ${peer}: ${(x as Error).message}`); return false; });
        if (taken || await this.holds(handle, e.app, txid)) { this.announced.delete(k); return; }
      }
    } finally { e.fetching = false; }
  }

  // ---------------------------------------------------------------- the beat and the reconcile

  /** A beat newly kept on `liveTopic` from another peer: a reconcile from it when its body changed since the last. */
  beat(handle: string, liveTopic: string, b: LiveBeat): void {
    if (this.stopped || !liveTopic.endsWith(LIVE)) return;
    const app = this.o.overlayOf(handle, liveTopic);
    if (!app || this.isDropped(handle, b.from) || b.from === this.o.self(handle)) return;
    this.start(handle, app, liveTopic.slice(0, -LIVE.length), b.from, b.body);
  }

  /**
   * A start (router.ts, the persisted peers): each peer that beat on the topic before asked at once,
   * the locator and the tail, without a beat. One reconcile per peer, as for a beat.
   */
  reconnect(handle: string, app: string, topic: string, peer: string): void {
    if (this.stopped || this.isDropped(handle, peer) || peer === this.o.self(handle)) return;
    this.start(handle, app, topic, peer, undefined);
  }

  private start(handle: string, app: string, topic: string, peer: string, body: Uint8Array | undefined): void {
    const k = `${handle} ${topic} ${peer}`;
    if (this.running.has(k)) return; // its end looks at the peer's latest beat
    if (body && this.seen.get(k) === hex(body)) return;
    if (body) this.seen.set(k, hex(body));
    this.running.add(k);
    this.track(this.reconcile(handle, app, topic, peer, body)
      .catch((e) => this.say(handle, `${topic} from ${peer}: ${(e as Error).message}`))
      .finally(() => {
        this.running.delete(k);
        // A beat that came while it ran: the latest, if it is not the one already reconciled from.
        const latest = this.o.beats(handle, `${topic}${LIVE}`).find((x) => x.from === peer);
        if (latest && !this.stopped && this.seen.get(k) !== hex(latest.body)) this.start(handle, app, topic, peer, latest.body);
      }));
  }

  private async anchors(handle: string, app: string, topic: string, heights?: number[]): Promise<Anchors> {
    return await this.o.local(handle, app, "anchors", { topic, ...(heights ? { heights: heights.join(",") } : {}) }) as Anchors;
  }

  private async ask(handle: string, peer: string, req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const a = dagCbor.decode(await this.o.request(handle, peer, dagCbor.encode(req))) as Record<string, unknown>;
    if (a.kind === "error") throw new Error(`${peer}: ${String(a.message)}`);
    if (a.kind !== req.kind) throw new Error(`${peer}: answered ${String(a.kind)} to ${String(req.kind)}`);
    return a;
  }

  /** The beat body's sync fields, or undefined when it does not decode. */
  private static fields(body: Uint8Array | undefined): SyncBeat | undefined {
    if (!body) return undefined;
    try { return dagCbor.decode(body) as SyncBeat; } catch { return undefined; }
  }

  /**
   * One reconcile with `peer` on `topic`: its mined history (the locator and the pulls) when its
   * tip anchor is not ours, then its unmined tail when the mined side is equal and its tail digest
   * is not ours. No beat (a start): both asked.
   */
  private async reconcile(handle: string, app: string, topic: string, peer: string, body: Uint8Array | undefined): Promise<void> {
    const theirs = OverlaySync.fields(body);
    if (body && !theirs) return;
    const hasTip = (b?: SyncBeat) => typeof b?.tipHeight === "number" && b.tipAnchor instanceof Uint8Array;
    if (!theirs) {
      await this.catchUp(handle, app, topic, peer);
    } else if (hasTip(theirs)) {
      const at = await this.anchors(handle, app, topic, [theirs.tipHeight!]);
      if (!at.anchors.some((x) => x.height === theirs.tipHeight && x.anchor === hex(theirs.tipAnchor!))) {
        const done = await this.catchUp(handle, app, topic, peer, { height: theirs.tipHeight!, anchor: hex(theirs.tipAnchor!) });
        if (!done) return; // a range left for a later beat: the mined side is not equal yet
      }
    }
    if (this.stopped || this.isDropped(handle, peer)) return;
    if (theirs) {
      // The mined side equal: its tip anchor ours at its height (after any pull), or neither has one.
      if (hasTip(theirs)) {
        const at = await this.anchors(handle, app, topic, [theirs.tipHeight!]);
        if (!at.anchors.some((x) => x.height === theirs.tipHeight && x.anchor === hex(theirs.tipAnchor!))) return;
      } else if (typeof (await this.anchors(handle, app, topic)).tipHeight === "number") return;
      const ours = OverlaySync.fields(this.o.ownBeat(handle, `${topic}${LIVE}`));
      const a = theirs.tailDigest instanceof Uint8Array ? hex(theirs.tailDigest) : "";
      const b = ours?.tailDigest instanceof Uint8Array ? hex(ours.tailDigest) : "";
      if (a === b) return;
    }
    await this.tail(handle, app, topic, peer);
  }

  /** The peer's unmined tail: each txid we do not hold fetched as an announced one from that peer. */
  private async tail(handle: string, app: string, topic: string, peer: string): Promise<void> {
    const t = await this.ask(handle, peer, { kind: "tail", topic });
    const txids = (Array.isArray(t.txids) ? t.txids : []).filter((x): x is string => typeof x === "string" && HEX64.test(x));
    let asked = 0;
    // One at a time, in its order (admission order: parents first): each through the per-txid set.
    for (const txid of txids) {
      if (this.stopped) return;
      const known = this.announced.has(`${handle} ${txid}`);
      if (!known && await this.holds(handle, app, txid)) continue;
      asked++;
      await this.announce(handle, app, topic, txid, peer);
    }
    if (asked) this.say(handle, `${topic}: ${peer}'s tail: ${txids.length} unmined, ${asked} asked`);
  }

  /**
   * Catch `topic` up from `peer`: the locator, then the pulls. `tip`: the tip its beat named (the
   * ranges are spread across the peers whose last beat names the same); none (a start): that peer
   * alone. → whether every range was taken (a height we hold no header for, or a list that fails,
   * leaves it unfinished).
   */
  private async catchUp(handle: string, app: string, topic: string, peer: string, tip?: { height: number; anchor: string }): Promise<boolean> {
    const mine = await this.anchors(handle, app, topic);
    const answer = await this.ask(handle, peer, {
      kind: "locator", topic,
      locator: mine.anchors.map((x) => ({ height: x.height, anchor: Uint8Array.from(Buffer.from(x.anchor, "hex")) })),
    });
    if (typeof answer.tipHeight !== "number" || typeof answer.genesisHeight !== "number") return true;
    const from = typeof answer.agreedHeight === "number" ? answer.agreedHeight + 1 : answer.genesisHeight;
    const to = answer.tipHeight;
    if (from > to) return true;
    // The peers whose last beat has the same tip anchor: the ranges are spread across them.
    const agreeing = [peer, ...(tip ? this.o.beats(handle, `${topic}${LIVE}`).filter((b) => {
      if (b.from === peer || b.from === this.o.self(handle) || this.isDropped(handle, b.from)) return false;
      const t = OverlaySync.fields(b.body);
      return t?.tipHeight === tip.height && t.tipAnchor instanceof Uint8Array && hex(t.tipAnchor) === tip.anchor;
    }).map((b) => b.from) : [])];
    this.say(handle, `${topic}: agreed with ${peer} through ${from - 1}; pulling ${from}..${to} from ${agreeing.length} peer(s)`);
    const span = this.o.rangeHeights ?? 1_000;
    const ranges: Array<{ from: number; to: number; peer: string }> = [];
    for (let h = from, i = 0; h <= to; h += span, i++) ranges.push({ from: h, to: Math.min(to, h + span - 1), peer: agreeing[i % agreeing.length]! });
    const lists = await Promise.all(ranges.map(async (r) => ({ r, blocks: await this.pullRange(handle, topic, r.peer, r.from, r.to).catch((e) => { this.say(handle, `${topic}: ${r.from}..${r.to} from ${r.peer}: ${(e as Error).message}`); return undefined; }) })));
    let whole = true;
    for (const { r, blocks } of lists) {
      if (!blocks) { whole = false; continue; }
      const ok = await this.checked(handle, topic, r.peer, blocks);
      if (!ok) { whole = false; continue; }
      const ours = new Set<string>();
      for (let h: number | null = r.from; h !== null && h <= r.to;) {
        const page = await this.o.local(handle, app, "admitted", { topic, fromHeight: String(h), toHeight: String(r.to) }) as Admitted;
        for (const b of page.blocks) for (const t of b.txids) ours.add(t);
        h = page.nextHeight;
      }
      for (const b of blocks) {
        const lacking = b.txids.filter((t) => !ours.has(t));
        for (const txid of lacking) await this.fetchInto(handle, r.peer, topic, txid);
        if (lacking.length) await this.landed(handle, app, topic, b.height, lacking);
      }
    }
    return whole;
  }

  /** The peer's admitted lists for `from..to`, every page. */
  private async pullRange(handle: string, topic: string, peer: string, from: number, to: number): Promise<AdmittedBlock[]> {
    const out: AdmittedBlock[] = [];
    for (let h: number | null = from; h !== null && h <= to;) {
      const a = await this.ask(handle, peer, { kind: "admitted", topic, fromHeight: h, toHeight: to, limit: 1_000 });
      const blocks = (a.blocks ?? []) as AdmittedBlock[];
      out.push(...blocks);
      const next = a.nextHeight;
      if (typeof next === "number" && next <= h) throw new Error("nextHeight does not advance");
      h = typeof next === "number" ? next : null;
    }
    return out;
  }

  /**
   * Each block against our headers before any transaction is fetched: its hash ours at its height,
   * the BUMP at that height and every listed txid in it with our merkle root. A failure drops the
   * peer; a height we hold no header for yet stops the range (the next changed beat resumes it).
   * → whether all checked.
   */
  private async checked(handle: string, topic: string, peer: string, blocks: AdmittedBlock[]): Promise<boolean> {
    for (const b of blocks) {
      if (!(await this.o.header(handle, b.height))) {
        this.say(handle, `${topic}: no header of ours at ${b.height} yet: ${peer}'s range left for its next changed beat`);
        return false;
      }
      const why = await this.problem(handle, b);
      if (!why) continue;
      this.say(handle, `${topic}: ${peer}'s list at ${b.height}: ${why}; peer dropped`);
      let d = this.dropped.get(handle);
      if (!d) this.dropped.set(handle, d = new Set());
      d.add(peer);
      return false;
    }
    return true;
  }

  private async problem(handle: string, b: AdmittedBlock): Promise<string | undefined> {
    const h = await this.o.header(handle, b.height);
    if (!h) return "no header of ours at that height";
    if (h.hash !== b.blockHash) return `block ${b.blockHash} is not ours (${h.hash})`;
    if (!b.txids.length) return "no txids";
    let mp: MerklePath;
    try { mp = MerklePath.fromHex(b.bump); } catch (e) { return `a BUMP that does not parse: ${(e as Error).message}`; }
    if (mp.blockHeight !== b.height) return `a BUMP at ${mp.blockHeight}`;
    for (const t of b.txids) {
      let root: string;
      try { root = mp.computeRoot(t); } catch { return `${t} is not in its BUMP`; }
      if (root !== h.root) return `${t}'s root is not our header's`;
    }
    return undefined;
  }

  /** One transaction asked of `peer` and handed to the receive row as from it. → whether it was accepted. */
  private async fetchInto(handle: string, peer: string, topic: string, txid: string): Promise<boolean> {
    const a = await this.ask(handle, peer, { kind: "tx", topic, txid });
    if (!(a.beef instanceof Uint8Array)) return false;
    const r = await this.o.deliver(handle, peer, a.beef);
    if (r.verdict !== "accept") this.say(handle, `${topic}: ${txid} from ${peer}: ${r.verdict}${r.reason ? ` (${r.reason})` : ""}`);
    return r.verdict === "accept";
  }

  /** Until the topic lists `txids` at `height` (admitted: each delivery is judged on its own thread), or 10 s. */
  private async landed(handle: string, app: string, topic: string, height: number, txids: string[]): Promise<void> {
    const end = Date.now() + 10_000;
    while (Date.now() < end && !this.stopped) {
      const page = await this.o.local(handle, app, "admitted", { topic, fromHeight: String(height), toHeight: String(height) }) as Admitted;
      const have = new Set(page.blocks.flatMap((b) => b.txids));
      if (txids.every((t) => have.has(t))) return;
      await sleep(100);
    }
  }
}

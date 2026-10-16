// Overlay sync (shruggr/skein#150; the want half of #112): the host half of
// keeping an overlay topic's admitted set equal across peers. The overlay
// engine (shruggr/skein-overlay 0.14.0) keeps, per topic, BRC-136's anchors
// and answers three reads: `/anchors` (by heights, or its locator), `/admitted`
// (the admitted lists by height range, each block's txids in block order with
// a compound BUMP) and `/holds` (whether its state reaches a transaction, with
// the chain state's Atomic BEEF of it). Its beacon on `<topic>-live` carries
// `{tipHeight, tipAnchor, tailDigest}`.
//
//   the beacon      a beat from another peer whose tip anchor is not ours (our
//                   anchor at its tip height differs, or we have none there) starts
//                   a catch-up from that peer, at most one per (instance, topic,
//                   peer) at a time and one per `cooldownMs`.
//   the locator     on the direct stream /skein/overlay/sync/1.0.0: our anchors at
//                   tip, tip-1, tip-2, tip-4 … genesis; the peer answers the
//                   highest height where it agrees, its genesis and its tip.
//   the pulls       the peer's admitted lists above the agreed height, by ranges
//                   of `rangeHeights` spread across the peers whose last beat has
//                   the same tip anchor; each block checked against our headers
//                   (its hash, the BUMP's root for every txid) before any
//                   transaction is fetched (a height we hold no header for yet stops
//                   the range: the next beat tries again); each txid we lack fetched from the peer
//                   that listed it and handed to the overlay's receive row
//                   /skein/overlay/beef/1.0.0 (filter kernel.beef → submit) as from
//                   that peer, block by block in height order. A peer whose list
//                   fails the check is dropped for the rest of the host's run.
//   the wants       the engine's `{event: "want", txid, topic, peer?}`: asked of the
//                   named peer, else of the peers on the topic (its gossip
//                   subscribers and its beaters), on the same stream; the BEEF
//                   answered goes into the receive row as from the peer that sent
//                   it. Asked again with a growing delay while it stands; `unwant`
//                   ends it. Standing wants are folded from the log at hydrate.
//   answering       a peer's request on the stream is answered from the overlay's
//                   reads: the locator from `/anchors`, a range from `/admitted`, a
//                   transaction from `/holds`.
//
// The wire, one dag-cbor frame each way:
//
//   {kind: "locator", topic, locator: [{height, anchor: bytes(32)}]}
//       → {kind: "locator", topic, genesisHeight?, agreedHeight?, tipHeight?}
//   {kind: "admitted", topic, fromHeight, toHeight, limit}
//       → {kind: "admitted", topic, blocks: [{height, blockHash, txids, bump}], nextHeight}   (hex, as /admitted)
//   {kind: "tx", topic, txid}
//       → {kind: "tx", txid, beef?: bytes}                                                   (absent: not held)
//   anything else → {kind: "error", message}
//
// Nothing here is logged in the instance: what reaches it is the BEEFs handed
// to the receive row, each an entry (replayed as any libp2p frame).

import * as dagCbor from "@ipld/dag-cbor";
import { MerklePath } from "@bsv/sdk";
import { peerIdFromMultihash } from "@libp2p/peer-id";
import * as Digest from "multiformats/hashes/digest";
import type { InboundAnswer } from "./p2p.ts";
import type { LiveBeat } from "./liveness.ts";

export const SYNC_PROTOCOL = "/skein/overlay/sync/1.0.0";
/** The overlay's receive row (skein-overlay etc/app.json): one Atomic BEEF per frame. */
export const BEEF_PROTOCOL = "/skein/overlay/beef/1.0.0";
const LIVE = "-live";

export interface SyncOptions {
  /** The app that beats on `<topic>-live` for `handle` (its overlay), if any. */
  overlayOf(handle: string, liveTopic: string): string | undefined;
  /** An app's read route (`/<app><path>`), its JSON answer; throws on a status other than 200. */
  read(handle: string, app: string, path: string, query: Record<string, string>): Promise<unknown>;
  /** One BEEF into the overlay's receive row, as from `peer` (its peer ID). */
  deliver(handle: string, peer: string, beef: Uint8Array): Promise<InboundAnswer>;
  /** The chain state's header at `height`: its hash and merkle root (display hex). */
  header(handle: string, height: number): Promise<{ hash: string; root: string } | undefined>;
  /** One request frame to `peer` on the sync protocol: its answer frame. */
  request(handle: string, peer: string, body: Uint8Array): Promise<Uint8Array>;
  /** The peers `handle`'s node sees subscribing a gossip topic. */
  subscribers(handle: string, topic: string): string[];
  /** The live beats on a liveness topic at `handle` (the liveness tool's). */
  beats(handle: string, liveTopic: string): LiveBeat[];
  /** `handle`'s own peer ID. */
  self(handle: string): string;
  log?(source: string, line: string): void;
  /** The least time between two catch-ups of one topic from one peer (ms); default 10 000. */
  cooldownMs?: number;
  /** The heights per ranged pull; default 1 000. */
  rangeHeights?: number;
  /** The first delay before a want is asked again (ms), doubling to `wantMaxMs`; default 2 000. */
  wantRetryMs?: number;
  wantMaxMs?: number;
}

/** A want the engine emitted (`want` minus `unwant`, shruggr/skein#112). */
export interface Want { app: string; txid: string; topic: string; peer?: Uint8Array }

/** The beat body's sync fields (skein-overlay topics.zig `beatBody`). */
interface TipBeat { tipHeight?: number; tipAnchor?: Uint8Array }

interface Anchors { topic: string; genesisHeight?: number; tipHeight?: number; anchors: Array<{ height: number; anchor: string }> }
interface AdmittedBlock { height: number; blockHash: string; txids: string[]; bump: string }
interface Admitted { topic: string; blocks: AdmittedBlock[]; nextHeight: number | null }

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const wantKey = (w: Want) => `${w.app} ${w.txid} ${w.topic} ${w.peer ? hex(w.peer) : ""}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A want / unwant event's fields, or why it is not one. */
export function wantEvent(rec: Record<string, unknown>): { event: "want" | "unwant"; want: Want } | { refused: string } {
  const event = rec.event;
  if (event !== "want" && event !== "unwant") return { refused: "not a want" };
  const { app, txid, topic, peer } = rec;
  if (typeof app !== "string" || typeof txid !== "string" || !/^[0-9a-f]{64}$/.test(txid) || typeof topic !== "string" || !topic) return { refused: "want: {app, txid (hex), topic, peer?}" };
  if (peer !== undefined && !(peer instanceof Uint8Array)) return { refused: "want: peer is the peer ID's multihash bytes" };
  return { event, want: { app, txid, topic, ...(peer ? { peer } : {}) } };
}

/** The standing wants after `events` (each `want` adds, each `unwant` removes; in order). */
export function foldWants(events: Array<{ event: "want" | "unwant"; want: Want }>, into: Want[] = []): Want[] {
  for (const e of events) {
    const i = into.findIndex((w) => wantKey(w) === wantKey(e.want));
    if (e.event === "want") { if (i < 0) into.push(e.want); } else if (i >= 0) into.splice(i, 1);
  }
  return into;
}

/** A peer ID's string from its multihash bytes. */
export const peerOf = (mh: Uint8Array): string => peerIdFromMultihash(Digest.decode(mh)).toString();

export class OverlaySync {
  private readonly o: SyncOptions;
  /** handle → want key → the want, while it stands. */
  private wants = new Map<string, Map<string, Want>>();
  /** Catch-ups running or done lately: `${handle} ${topic} ${peer}` → when it started. */
  private recent = new Map<string, number>();
  private running = new Set<string>();
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

  /** Whether anything is under way (a catch-up, a want being asked). */
  busy(): boolean { return this.inflight.size > 0; }

  async idle(): Promise<void> { while (this.inflight.size) await Promise.all([...this.inflight]); }

  stop(): void { this.stopped = true; this.wants.clear(); }

  // ---------------------------------------------------------------- the beacon and the catch-up

  /** A beat newly kept on `liveTopic` from another peer: a catch-up when its tip anchor is not ours. */
  beat(handle: string, liveTopic: string, b: LiveBeat): void {
    if (this.stopped || !liveTopic.endsWith(LIVE)) return;
    const app = this.o.overlayOf(handle, liveTopic);
    if (!app) return;
    if (this.dropped.get(handle)?.has(b.from)) return;
    let tip: TipBeat;
    try { tip = dagCbor.decode(b.body) as TipBeat; } catch { return; }
    if (typeof tip.tipHeight !== "number" || !(tip.tipAnchor instanceof Uint8Array)) return; // nothing of theirs is mined
    const topic = liveTopic.slice(0, -LIVE.length);
    const k = `${handle} ${topic} ${b.from}`;
    const last = this.recent.get(k);
    if (this.running.has(k) || (last !== undefined && Date.now() - last < (this.o.cooldownMs ?? 10_000))) return;
    this.recent.set(k, Date.now());
    this.running.add(k);
    this.track(this.catchUp(handle, app, topic, b.from, tip.tipHeight, hex(tip.tipAnchor))
      .catch((e) => this.say(handle, `${topic} from ${b.from}: ${(e as Error).message}`))
      .finally(() => this.running.delete(k)));
  }

  private async anchors(handle: string, app: string, topic: string, heights?: number[]): Promise<Anchors> {
    return await this.o.read(handle, app, "/anchors", { topic, ...(heights ? { heights: heights.join(",") } : {}) }) as Anchors;
  }

  private async ask(handle: string, peer: string, req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const a = dagCbor.decode(await this.o.request(handle, peer, dagCbor.encode(req))) as Record<string, unknown>;
    if (a.kind === "error") throw new Error(`${peer}: ${String(a.message)}`);
    if (a.kind !== req.kind) throw new Error(`${peer}: answered ${String(a.kind)} to ${String(req.kind)}`);
    return a;
  }

  /** Catch `topic` up from `peer`, whose beat named its tip: the locator, then the pulls. */
  private async catchUp(handle: string, app: string, topic: string, peer: string, tipHeight: number, tipAnchor: string): Promise<void> {
    const at = await this.anchors(handle, app, topic, [tipHeight]);
    if (at.anchors.some((x) => x.height === tipHeight && x.anchor === tipAnchor)) return; // its history is ours through its tip
    const mine = await this.anchors(handle, app, topic);
    const answer = await this.ask(handle, peer, {
      kind: "locator", topic,
      locator: mine.anchors.map((x) => ({ height: x.height, anchor: Uint8Array.from(Buffer.from(x.anchor, "hex")) })),
    });
    if (typeof answer.tipHeight !== "number" || typeof answer.genesisHeight !== "number") return;
    const from = typeof answer.agreedHeight === "number" ? answer.agreedHeight + 1 : answer.genesisHeight;
    const to = answer.tipHeight;
    if (from > to) return;
    // The peers whose last beat has the same tip anchor: the ranges are spread across them.
    const agreeing = [peer, ...this.o.beats(handle, `${topic}${LIVE}`).filter((b) => {
      if (b.from === peer || b.from === this.o.self(handle) || this.dropped.get(handle)?.has(b.from)) return false;
      try { const t = dagCbor.decode(b.body) as TipBeat; return t.tipHeight === tipHeight && t.tipAnchor instanceof Uint8Array && hex(t.tipAnchor) === tipAnchor; } catch { return false; }
    }).map((b) => b.from)];
    this.say(handle, `${topic}: agreed with ${peer} through ${from - 1}; pulling ${from}..${to} from ${agreeing.length} peer(s)`);
    const span = this.o.rangeHeights ?? 1_000;
    const ranges: Array<{ from: number; to: number; peer: string }> = [];
    for (let h = from, i = 0; h <= to; h += span, i++) ranges.push({ from: h, to: Math.min(to, h + span - 1), peer: agreeing[i % agreeing.length]! });
    const lists = await Promise.all(ranges.map(async (r) => ({ r, blocks: await this.pullRange(handle, topic, r.peer, r.from, r.to).catch((e) => { this.say(handle, `${topic}: ${r.from}..${r.to} from ${r.peer}: ${(e as Error).message}`); return undefined; }) })));
    for (const { r, blocks } of lists) {
      if (!blocks) continue;
      const ok = await this.checked(handle, topic, r.peer, blocks);
      if (!ok) continue;
      const ours = new Set<string>();
      for (let h: number | null = r.from; h !== null && h <= r.to;) {
        const page = await this.o.read(handle, app, "/admitted", { topic, fromHeight: String(h), toHeight: String(r.to) }) as Admitted;
        for (const b of page.blocks) for (const t of b.txids) ours.add(t);
        h = page.nextHeight;
      }
      for (const b of blocks) {
        const lacking = b.txids.filter((t) => !ours.has(t));
        for (const txid of lacking) await this.fetchInto(handle, r.peer, topic, txid);
        if (lacking.length) await this.landed(handle, app, topic, b.height, lacking);
      }
    }
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
   * peer; a height we hold no header for yet stops the range (ours to fill). → whether all checked.
   */
  private async checked(handle: string, topic: string, peer: string, blocks: AdmittedBlock[]): Promise<boolean> {
    for (const b of blocks) {
      if (!(await this.o.header(handle, b.height))) {
        this.say(handle, `${topic}: no header of ours at ${b.height} yet: ${peer}'s range left for a later beat`);
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
      const page = await this.o.read(handle, app, "/admitted", { topic, fromHeight: String(height), toHeight: String(height) }) as Admitted;
      const have = new Set(page.blocks.flatMap((b) => b.txids));
      if (txids.every((t) => have.has(t))) return;
      await sleep(100);
    }
  }

  // ---------------------------------------------------------------- wants (#112)

  /** The wants standing for `handle` (folded from its log at hydrate): each asked. */
  standing(handle: string, wants: Want[]): void {
    for (const w of wants) this.want(handle, { event: "want", want: w });
  }

  /** A `want` or `unwant` event from `handle`'s overlay. */
  want(handle: string, e: { event: "want" | "unwant"; want: Want }): void {
    if (this.stopped) return;
    let m = this.wants.get(handle);
    if (!m) this.wants.set(handle, m = new Map());
    const k = wantKey(e.want);
    if (e.event === "unwant") { m.delete(k); return; }
    if (m.has(k)) return;
    m.set(k, e.want);
    this.track(this.pursue(handle, k, e.want));
  }

  /** Ask for a want until it is answered into the receive row, or it ends. */
  private async pursue(handle: string, k: string, w: Want): Promise<void> {
    let delay = this.o.wantRetryMs ?? 2_000;
    while (!this.stopped && this.wants.get(handle)?.get(k) === w) {
      const peers = w.peer ? [peerOf(w.peer)] : this.meshOf(handle, w.topic);
      for (const p of peers) {
        if (this.wants.get(handle)?.get(k) !== w) return;
        const ok = await this.fetchInto(handle, p, w.topic, w.txid).catch((e) => { this.say(handle, `want ${w.txid} (${w.topic}) of ${p}: ${(e as Error).message}`); return false; });
        if (ok) { this.wants.get(handle)?.delete(k); return; } // the engine's unwant follows when it is taken
      }
      await sleep(delay);
      delay = Math.min(delay * 2, this.o.wantMaxMs ?? 60_000);
    }
  }

  /** The peers on a topic: its gossip subscribers and its beaters, each once, not this instance. */
  private meshOf(handle: string, topic: string): string[] {
    const self = this.o.self(handle);
    const out = new Set([...this.o.subscribers(handle, topic), ...this.o.beats(handle, `${topic}${LIVE}`).map((b) => b.from)]);
    out.delete(self);
    for (const d of this.dropped.get(handle) ?? []) out.delete(d);
    return [...out];
  }

  // ---------------------------------------------------------------- answering a peer

  /** One request frame from `remote` on the sync protocol: its answer frame. */
  async serve(handle: string, remote: string, frame: Uint8Array): Promise<Uint8Array> {
    let req: Record<string, unknown>;
    try { req = dagCbor.decode(frame) as Record<string, unknown>; } catch { return dagCbor.encode({ kind: "error", message: "not dag-cbor" }); }
    try {
      return dagCbor.encode(await this.answer(handle, req));
    } catch (e) {
      this.say(handle, `${String(req.kind)} from ${remote}: ${(e as Error).message}`);
      return dagCbor.encode({ kind: "error", message: (e as Error).message });
    }
  }

  private async answer(handle: string, req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const topic = req.topic;
    if (typeof topic !== "string" || !topic) throw new Error("no topic");
    const app = this.o.overlayOf(handle, `${topic}${LIVE}`);
    if (!app) throw new Error(`${topic} is not served here`);
    if (req.kind === "locator") {
      const loc = Array.isArray(req.locator) ? req.locator as Array<{ height?: unknown; anchor?: unknown }> : [];
      const heights = loc.filter((x) => typeof x.height === "number" && x.anchor instanceof Uint8Array);
      const ours = await this.anchors(handle, app, topic, heights.length ? heights.map((x) => x.height as number) : [0]);
      const mine = new Map(ours.anchors.map((x) => [x.height, x.anchor]));
      let agreed: number | undefined;
      for (const x of heights) if (mine.get(x.height as number) === hex(x.anchor as Uint8Array) && (agreed === undefined || (x.height as number) > agreed)) agreed = x.height as number;
      return {
        kind: "locator", topic,
        ...(ours.genesisHeight !== undefined ? { genesisHeight: ours.genesisHeight, tipHeight: ours.tipHeight } : {}),
        ...(agreed !== undefined ? { agreedHeight: agreed } : {}),
      };
    }
    if (req.kind === "admitted") {
      const q: Record<string, string> = { topic };
      for (const f of ["fromHeight", "toHeight", "limit"]) if (typeof req[f] === "number") q[f] = String(req[f]);
      const a = await this.o.read(handle, app, "/admitted", q) as Admitted;
      return { kind: "admitted", topic, blocks: a.blocks, nextHeight: a.nextHeight };
    }
    if (req.kind === "tx") {
      const txid = req.txid;
      if (typeof txid !== "string" || !/^[0-9a-f]{64}$/.test(txid)) throw new Error("tx: txid is hex");
      const h = await this.o.read(handle, app, "/holds", { txid }) as { beef?: string };
      return { kind: "tx", txid, ...(typeof h.beef === "string" ? { beef: Uint8Array.from(Buffer.from(h.beef, "hex")) } : {}) };
    }
    throw new Error(`no request ${String(req.kind)}`);
  }
}


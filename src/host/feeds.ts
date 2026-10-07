// Router-held feeds (#33 part 2, #29's revision): long-lived subscriptions the
// router keeps on behalf of instances, each of whose items is admitted into
// the subscribed instance as a plain `event` entry (Router.admitEvent) — the
// event records of docs/WALLET.md:
//
//   header {kind: "header", raw: bytes(80)}
//
// (The broadcaster's proofs travel the same way, #65: {kind: "proof",
// subject, txid, path, …} in box `chain`, arc.ts; its other statuses are
// signed messages from the status provider. `statusOf` reads Arcade's JSON
// for it: {kind: "status", subject: <tx CID>, txid, txStatus, merklePath?:
// bytes, blockHeight?, blockHash?, extraInfo?}.)
//
// An instance declares its header feeds in its config (etc/config.json,
// `feeds`), which its genesis carries:
//
//   {kind: "headers", url, box?}          an SSE stream of block headers (ChainTracks-style):
//                                         each event's data is the header's hex (160 digits), or
//                                         JSON {header | raw | hex: "<hex>"}, or chaintracks' JSON
//                                         {version, previousHash, merkleRoot, time, bits, nonce, height?, hash?}
//                                         (Arcade's /chaintracks/v2/tip/stream; the hashes in display
//                                         order: the 80 bytes serialized from the fields, and a `hash`
//                                         that is not their sha256d is logged and dropped), or an array of them
//
// The host has one headers feed of its own besides (#102, SKEIN_HEADERS_URL;
// the Router's `headersFeed`): every enabled instance whose dispatch table
// takes events in box `chain` is subscribed to it, the others not; the router
// keeps that current as dispatch tables change (`host`). A genesis's `feeds`
// are in addition. The host listens to it itself too (#132, `listen`): every
// header it brings grows the default image's chain part (image-chain.ts).
//
// `box` defaults to "chain" (the wallet's sender-less subscription). Nothing
// here judges an item: the instance's own chain tracker validates headers and
// proofs. One SSE connection per URL, fanned out to every subscriber;
// reconnects with exponential backoff (and `Last-Event-ID`); each instance's
// queue of items not yet admitted holds at most `maxQueue` (the oldest go
// first, logged).
//
// The transaction half is the host's broadcaster (#58, #65, arc.ts): one
// Arcade subscription for the whole host over the same SSE client
// (SseStream), each proof and status routed to every instance that holds the
// transaction. The
// per-instance `arc-callback` feed is gone: a genesis that still declares one
// has it ignored.

import { Hash, Utils } from "@bsv/sdk";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";

export type FeedSpec = { kind: "headers"; url: string; box?: string };

export interface FeedsOptions {
  /** Admit one event record into `handle`'s box (Router.admitEvent). */
  admit(handle: string, box: string, event: Record<string, unknown>): Promise<unknown>;
  log?(source: string, line: string): void;
  /** Items waiting for admission per instance (default 1000). */
  maxQueue?: number;
  /** Reconnect backoff, ms (default 500 → 30 000, doubling). */
  backoff?: { min: number; max: number };
  fetch?: typeof fetch;
}

export const DEFAULT_BOX = "chain";

/** A transaction's CID: bitcoin-tx (0xb1), dbl-sha2-256 (0x56) over the txid in internal byte order. */
export function txCid(txid: string): CID {
  return CID.createV1(0xb1, Digest.create(0x56, Uint8Array.from(Buffer.from(txid, "hex").reverse())));
}

/** The feeds a genesis declares (`feeds`), the malformed ones (and a pre-#58 `arc-callback`) left out. */
export function feedsOf(g: Record<string, unknown> | null | undefined): FeedSpec[] {
  const fs = g?.feeds;
  if (!Array.isArray(fs)) return [];
  const out: FeedSpec[] = [];
  for (const f of fs as Array<Record<string, unknown>>) {
    const box = typeof f?.box === "string" && f.box ? f.box : undefined;
    if (f?.kind === "headers" && typeof f.url === "string") out.push({ kind: "headers", url: f.url, ...(box ? { box } : {}) });
  }
  return out;
}

/**
 * The 80 bytes of a header given as chaintracks' JSON (Arcade's tip stream):
 * version, previousHash, merkleRoot (display order: reversed into raw),
 * time, bits, nonce — and, with `hash`, checked against their sha256d. Not
 * that form: undefined. A `hash` that does not match: an Error saying so.
 */
export function headerOfFields(o: Record<string, unknown>): Uint8Array | Error | undefined {
  const u32 = (x: unknown) => typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 0xffffffff;
  const h32 = (x: unknown) => typeof x === "string" && /^[0-9a-fA-F]{64}$/.test(x);
  if (!u32(o.version) || !h32(o.previousHash) || !h32(o.merkleRoot) || !u32(o.time) || !u32(o.bits) || !u32(o.nonce)) return undefined;
  const w = new Utils.Writer();
  w.writeUInt32LE(o.version as number);
  w.writeReverse(Utils.toArray(o.previousHash as string, "hex"));
  w.writeReverse(Utils.toArray(o.merkleRoot as string, "hex"));
  w.writeUInt32LE(o.time as number).writeUInt32LE(o.bits as number).writeUInt32LE(o.nonce as number);
  const raw = w.toArray();
  if (o.hash !== undefined) {
    const hash = Utils.toHex(Hash.hash256(raw).reverse());
    if (typeof o.hash !== "string" || o.hash.toLowerCase() !== hash) return new Error(`header ${String(o.height ?? "?")}: its hash ${String(o.hash)} is not its fields' (${hash}): dropped`);
  }
  return Uint8Array.from(raw);
}

/**
 * Header bytes out of one SSE event's data: hex, JSON with header/raw/hex,
 * chaintracks' fields (headerOfFields), or an array of those. A header whose
 * `hash` is not its fields' is left out, and `drop` told why.
 */
export function headersOf(data: string, drop?: (why: string) => void): Uint8Array[] {
  const hex = (s: unknown): Uint8Array | undefined => typeof s === "string" && /^[0-9a-fA-F]{160}$/.test(s) ? Uint8Array.from(Buffer.from(s, "hex")) : undefined;
  const t = data.trim();
  const direct = hex(t);
  if (direct) return [direct];
  let v: unknown;
  try { v = JSON.parse(t); } catch { return []; } // neither hex nor JSON: no header; the caller logs an event with none
  const one = (x: unknown): Uint8Array | undefined => {
    if (typeof x === "string") return hex(x);
    const o = x as Record<string, unknown> | null;
    if (!o || typeof o !== "object") return undefined;
    const h = hex(o.header) ?? hex(o.raw) ?? hex(o.hex);
    if (h) return h;
    const f = headerOfFields(o);
    if (f instanceof Error) { drop?.(f.message); return undefined; }
    return f;
  };
  const list = Array.isArray(v) ? v : Array.isArray((v as { headers?: unknown })?.headers) ? (v as { headers: unknown[] }).headers : [v];
  return list.map(one).filter((x): x is Uint8Array => !!x);
}

/** Arcade's (and ARC's) status JSON — an SSE event's data, a webhook's body — as a `status` event record, or why not. */
export function statusOf(v: unknown): Record<string, unknown> | string {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return "not a JSON object";
  const txid = o.txid;
  if (typeof txid !== "string" || !/^[0-9a-f]{64}$/i.test(txid)) return "no txid";
  if (typeof o.txStatus !== "string" || !o.txStatus) return "no txStatus";
  const ev: Record<string, unknown> = { kind: "status", subject: txCid(txid.toLowerCase()), txid: txid.toLowerCase(), txStatus: o.txStatus };
  if (typeof o.merklePath === "string" && o.merklePath) {
    if (!/^([0-9a-f]{2})+$/i.test(o.merklePath)) return "merklePath is not hex";
    ev.merklePath = Uint8Array.from(Buffer.from(o.merklePath, "hex"));
  }
  if (typeof o.blockHeight === "number") ev.blockHeight = o.blockHeight;
  if (typeof o.blockHash === "string" && o.blockHash) ev.blockHash = o.blockHash;
  if (typeof o.extraInfo === "string" && o.extraInfo) ev.extraInfo = o.extraInfo;
  return ev;
}

// ---------------------------------------------------------------- SSE

/** One event of a text/event-stream: its data lines joined, its `id` and `event` fields if it had them. */
export interface SseEvent { data: string; id?: string; event?: string }

export interface SseOptions {
  /** Request headers besides Accept and Last-Event-ID. */
  headers?: Record<string, string>;
  /** Resume after this event id (a remembered one: the first connection sends it as Last-Event-ID). */
  lastId?: string;
  /** Reconnect backoff, ms (default 500 → 30 000, doubling; back to the minimum once an event arrived). */
  backoff?: { min: number; max: number };
  fetch?: typeof fetch;
  log?(line: string): void;
}

/**
 * One SSE subscription held open (#33, #58): connects, parses the stream,
 * hands each event to `onEvent` — awaited before the next one is read and
 * before its id counts as seen, so a caller that remembers `lastId` after it
 * never skips an event — and reconnects with backoff, sending the last id
 * seen as `Last-Event-ID`.
 */
export class SseStream {
  readonly url: string;
  lastId?: string;
  private abort = new AbortController();
  private stopped = false;
  private readonly o: SseOptions;
  private readonly onEvent: (ev: SseEvent) => Promise<void> | void;
  private running?: Promise<void>;

  constructor(url: string, onEvent: (ev: SseEvent) => Promise<void> | void, o: SseOptions = {}) {
    this.url = url;
    this.onEvent = onEvent;
    this.o = o;
    this.lastId = o.lastId;
  }

  start(): this { this.running ??= this.connect(); return this; }
  /** Close the connection; no reconnect. Resolves once the loop has ended (an event being handled finishes first). */
  async stop(): Promise<void> { this.stopped = true; this.abort.abort(); await this.running; }

  private say(line: string): void { this.o.log?.(line); }

  private async connect(): Promise<void> {
    const { min, max } = this.o.backoff ?? { min: 500, max: 30_000 };
    let wait = min;
    while (!this.stopped) {
      try {
        const res = await (this.o.fetch ?? fetch)(this.url, {
          headers: { ...this.o.headers, accept: "text/event-stream", ...(this.lastId !== undefined ? { "last-event-id": this.lastId } : {}) },
          signal: this.abort.signal,
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        this.say(`connected${this.lastId !== undefined ? ` (after event ${this.lastId})` : ""}`);
        await this.read(res.body, () => { wait = min; });
        if (this.stopped) return;
        this.say(`closed; reconnecting in ${wait} ms`);
      } catch (e) {
        if (this.stopped) return;
        this.say(`${(e as Error).message}; reconnecting in ${wait} ms`);
      }
      await new Promise<void>((r) => { const t = setTimeout(r, wait); this.abort.signal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); });
      wait = Math.min(max, wait * 2);
    }
  }

  /** Parse the event stream (text/event-stream): `data:` lines until a blank line make one event; `id:` and `event:` go with it. */
  private async read(body: ReadableStream<Uint8Array>, onData: () => void): Promise<void> {
    const dec = new TextDecoder();
    let buf = "";
    let data: string[] = [];
    let id: string | undefined;
    let event: string | undefined;
    const reader = body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.search(/\r\n|\n|\r/)) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + (buf.startsWith("\r\n", nl) ? 2 : 1));
          if (line === "") {
            if (data.length) {
              onData();
              try { await this.onEvent({ data: data.join("\n"), ...(id !== undefined ? { id } : {}), ...(event !== undefined ? { event } : {}) }); } catch (e) { this.say(`an event not taken: ${(e as Error).message}`); }
            }
            if (this.stopped) return;
            if (id !== undefined) this.lastId = id;
            data = []; id = undefined; event = undefined;
            continue;
          }
          if (line.startsWith(":")) continue;
          const c = line.indexOf(":");
          const field = c < 0 ? line : line.slice(0, c);
          const v = c < 0 ? "" : line.slice(c + 1).replace(/^ /, "");
          if (field === "data") data.push(v);
          else if (field === "id") id = v;
          else if (field === "event") event = v;
        }
      }
    } finally { reader.releaseLock?.(); }
  }
}

// ---------------------------------------------------------------- the header feeds

interface Sse { stream: SseStream; subscribers: Map<string, string> }
interface Queue { items: Array<{ box: string; event: Record<string, unknown> }>; running: boolean; dropped: number; /** #141: a backfill is being read: items queue, none is admitted. */ held?: boolean }

/** Headers per backfill event (#141): the chain app takes a run, `{kind: "header", raws}`, parents first. */
export const BACKFILL_RUN = 2016;

export class Feeds {
  readonly o: FeedsOptions;
  private sse = new Map<string, Sse>();
  private declared = new Map<string, FeedSpec[]>();
  private hosted = new Map<string, FeedSpec>();
  private listeners = new Map<string, (raws: Uint8Array[]) => void>();
  private queues = new Map<string, Queue>();
  private stopped = false;

  constructor(o: FeedsOptions) { this.o = o; }

  private say(source: string, line: string): void { this.o.log?.(source, line); }

  /** `handle`'s feeds are these (replacing what it declared before). */
  declare(handle: string, specs: FeedSpec[]): void {
    if (this.stopped) return;
    this.declared.set(handle, specs);
    this.subscribe(handle);
  }

  /**
   * The host's own feed (#102) for `handle`: subscribed to it (`spec`), or not (undefined); a genesis's feeds are kept.
   * `backfill` (#141): on subscribing, the headers the instance lacks up to the host's tip — read after the
   * subscription is in place; until they are queued, the live items wait behind them (held), and a live header
   * the backfill carries too is dropped. Admitted first, in runs of BACKFILL_RUN, then the live stream.
   */
  host(handle: string, spec: FeedSpec | undefined, backfill?: () => Promise<Uint8Array[]>): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (spec) this.hosted.set(handle, spec); else this.hosted.delete(handle);
    if (!spec || !backfill) { this.subscribe(handle); return Promise.resolve(); }
    const q = this.queue(handle);
    q.held = true;
    this.subscribe(handle);
    return backfill().then((raws) => {
      if (!raws.length) return;
      const have = new Set(raws.map((r) => Buffer.from(r).toString("hex")));
      q.items = q.items.filter((x) => !(x.event.kind === "header" && x.event.raw instanceof Uint8Array && have.has(Buffer.from(x.event.raw).toString("hex"))));
      const runs: Queue["items"] = [];
      for (let i = 0; i < raws.length; i += BACKFILL_RUN) runs.push({ box: spec.box ?? DEFAULT_BOX, event: { kind: "header", raws: raws.slice(i, i + BACKFILL_RUN) } });
      q.items.unshift(...runs);
      this.say(handle, `feed: ${raws.length} header${raws.length === 1 ? "" : "s"} it lacks pushed first (the backfill), then the live stream`);
    }).catch((e) => this.say(handle, `feed: the backfill not read: ${(e as Error).message}`)).finally(() => {
      q.held = false;
      if (!q.running && q.items.length) void this.drain(handle, q);
    });
  }

  private queue(handle: string): Queue {
    let q = this.queues.get(handle);
    if (!q) this.queues.set(handle, (q = { items: [], running: false, dropped: 0 }));
    return q;
  }

  /**
   * The host's own listener on a headers feed (#132: the default image's
   * chain part grows by it): every header the stream brings, as well as the
   * subscribers'. The connection stays open while a listener is on it.
   */
  listen(url: string, fn: (raws: Uint8Array[]) => void): void {
    if (this.stopped) return;
    this.listeners.set(url, fn);
    this.connect(url);
  }

  /** Whether `handle` is subscribed to the host's own feed. */
  hosts(handle: string): boolean { return this.hosted.has(handle); }

  /** Subscribe `handle` to what it declared and the host's feed for it, and to nothing else. */
  private subscribe(handle: string): void {
    const h = this.hosted.get(handle);
    const specs = [...(this.declared.get(handle) ?? []), ...(h ? [h] : [])];
    for (const [url, s] of this.sse) {
      if (s.subscribers.has(handle) && !specs.some((f) => f.kind === "headers" && f.url === url)) s.subscribers.delete(handle);
      if (!s.subscribers.size && !this.listeners.has(url)) { void s.stream.stop(); this.sse.delete(url); }
    }
    for (const f of specs) {
      if (f.kind !== "headers") continue;
      this.connect(f.url).subscribers.set(handle, f.box ?? DEFAULT_BOX);
    }
  }

  /** The one connection to `url`, opened if it is not. */
  private connect(url: string): Sse {
    let s = this.sse.get(url);
    if (!s) {
      const subscribers = new Map<string, string>();
      const stream = new SseStream(url, (ev) => this.dispatch(url, subscribers, ev.data), {
        backoff: this.o.backoff, fetch: this.o.fetch, log: (l) => this.say("router", `feed ${url}: ${l}`),
      });
      s = { stream, subscribers };
      this.sse.set(url, s);
      stream.start();
    }
    return s;
  }

  /** The declared feeds of `handle`. */
  of(handle: string): FeedSpec[] { return this.declared.get(handle) ?? []; }

  /** Close every connection (no reconnect); resolves once their loops have ended. */
  async stop(): Promise<void> {
    this.stopped = true;
    const streams = [...this.sse.values()].map((s) => s.stream.stop());
    this.sse.clear();
    await Promise.all(streams);
  }

  /** Queue an event for `handle` (bounded), and drain the queue serially. */
  push(handle: string, box: string, event: Record<string, unknown>): void {
    const q = this.queue(handle);
    q.items.push({ box, event });
    const max = this.o.maxQueue ?? 1000;
    if (q.items.length > max) {
      const n = q.items.length - max;
      q.items.splice(0, n);
      q.dropped += n;
      this.say(handle, `feed: queue full (${max}): dropped the ${n} oldest (${q.dropped} so far)`);
    }
    if (!q.running && !q.held) void this.drain(handle, q);
  }

  /** How many items wait for `handle` (tests). */
  pending(handle: string): number { return this.queues.get(handle)?.items.length ?? 0; }

  private async drain(handle: string, q: Queue): Promise<void> {
    q.running = true;
    try {
      while (q.items.length && !this.stopped && !q.held) {
        const { box, event } = q.items.shift()!;
        try { await this.o.admit(handle, box, event); } catch (e) { this.say(handle, `feed: ${String(event.kind)} not admitted: ${(e as Error).message}`); }
      }
    } finally { q.running = false; }
  }

  private dispatch(url: string, subscribers: Map<string, string>, data: string): void {
    let dropped = false;
    const hs = headersOf(data, (why) => { dropped = true; this.say("router", `feed ${url}: ${why}`); });
    if (!hs.length) { if (!dropped) this.say("router", `feed ${url}: an event with no header in it: ignored`); return; }
    this.listeners.get(url)?.(hs);
    for (const [handle, box] of subscribers) for (const raw of hs) this.push(handle, box, { kind: "header", raw });
  }
}

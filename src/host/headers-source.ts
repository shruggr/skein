// An HTTP header source for the host's ONE header intake (skein next, SPEC 8: "Headers are headers. It
// doesn't matter where they come from." — David). SKEIN_HEADERS_URL: an SSE stream of block headers
// (ChainTracks-style; Arcade's `…/chaintracks/v2/tip/stream`): each event's data a header's hex (160
// digits), JSON {header | raw | hex}, chaintracks' JSON fields {version, previousHash, merkleRoot, time,
// bits, nonce, height?, hash?} (hashes in display order; a `hash` that is not their sha256d is dropped),
// or an array of those. Each header goes to Router.takeHeaders at its parent's height + 1 (the parent
// looked up as the tracker looks one up: Router.findHeader).
//
// History: when the stream's URL has a history endpoint beside it (`…/tip/stream` → `…/headers`, read as
// `?height=<h>&count=<n>`: whole 80-byte headers), the host chain is brought up to it ONCE at start —
// from a little below the host chain's tip (from 0 when it is empty) — through the same intake, before any
// instance is hydrated; and again whenever a streamed header links to no header known (a gap, a reorg
// deeper than the recent index). Without one, such a header is dropped with a line.
//
// Nothing per instance: no subscription, no queue, no backfill; the intake tells the instances. It may
// run beside the Teranode tracker: both feed the one intake. (The parsing is feeds.ts's, as at v0.9.1.)

import { Hash, Utils } from "@bsv/sdk";
import { SseStream } from "./feeds.ts";
import { hashOf, prevOf } from "./teranode.ts";

const SIZE = 80;
const ZERO = "0".repeat(64);

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


/** The history endpoint beside a chaintracks tip stream (`…/tip/stream` → `…/headers`), if the URL is one. */
export function historyOf(feed: string): string | undefined {
  let u: URL;
  try { u = new URL(feed); } catch { return undefined; }
  if (!/\/tip\/stream\/?$/.test(u.pathname)) return undefined;
  u.pathname = u.pathname.replace(/\/tip\/stream\/?$/, "/headers");
  u.search = "";
  return u.toString();
}

export interface HttpHeadersOptions {
  /** The SSE stream (SKEIN_HEADERS_URL). */
  url: string;
  /** The one intake (Router.takeHeaders): a run, parents first, at the height of its first. */
  take(raws: Uint8Array[], at: number): Promise<void>;
  /** A header's height by hash (display hex), when known (Router.findHeader). */
  find(hash: string): Promise<number | undefined>;
  /** The host chain's tip (undefined: empty). */
  tip(): Promise<{ height: number; hash: string } | undefined>;
  /** Headers per history request (default 2016 × 50). */
  page?: number;
  backoff?: { min: number; max: number };
  fetch?: typeof fetch;
  log?(line: string): void;
}

/** The HTTP header source: the history fill, then the stream. */
export class HttpHeaders {
  readonly o: HttpHeadersOptions;
  readonly history?: string;
  private stream?: SseStream;
  /** One header (or history fill) at a time, in the order they came. */
  private queue: Promise<unknown> = Promise.resolve();
  readonly stats = { taken: 0, dropped: 0, filled: 0 };

  constructor(o: HttpHeadersOptions) { this.o = o; this.history = historyOf(o.url); }

  private say(line: string): void { this.o.log?.(line); }

  /** The history fill (when the service has one), awaited; then the stream, connected (not awaited). */
  async start(): Promise<void> {
    await this.serial(() => this.fill()).catch((e) => this.say(`headers ${this.o.url}: the history fill failed: ${(e as Error).message}`));
    this.stream = new SseStream(this.o.url, (ev) => this.serial(() => this.event(ev.data)), {
      backoff: this.o.backoff, fetch: this.o.fetch, log: (l) => this.say(`headers ${this.o.url}: ${l}`),
    });
    this.stream.start();
  }

  async stop(): Promise<void> { await this.stream?.stop(); await this.queue.catch(() => {}); }

  private serial<T>(f: () => Promise<T>): Promise<T> {
    const p = this.queue.catch(() => {}).then(f);
    this.queue = p.catch(() => {});
    return p;
  }

  /** One SSE event's headers, each at its parent's height + 1; a header linking to none known: the history fill, else dropped. */
  private async event(data: string): Promise<void> {
    let dropped = false;
    const hs = headersOf(data, (why) => { dropped = true; this.say(`headers ${this.o.url}: ${why}`); });
    if (!hs.length) { if (!dropped) this.say(`headers ${this.o.url}: an event with no header in it: ignored`); return; }
    for (const raw of hs) {
      if ((await this.o.find(hashOf(raw))) !== undefined) continue; // held already
      const parent = prevOf(raw) === ZERO ? -1 : await this.o.find(prevOf(raw));
      if (parent !== undefined && (parent >= 0 || !(await this.o.tip()))) { await this.o.take([raw], parent + 1); this.stats.taken++; continue; }
      if (!this.history) { this.stats.dropped++; this.say(`headers ${this.o.url}: ${hashOf(raw)} links to no header known, and the service has no history: dropped`); continue; }
      await this.fill();
    }
  }

  /** The history from a little below the host chain's tip (from 0 when empty) to the service's end, in pages, through the intake. */
  private async fill(): Promise<void> {
    const url = this.history;
    if (!url) return;
    const page = this.o.page ?? 50 * 2016;
    const t0 = Date.now();
    const start = await this.o.tip();
    let from = start ? Math.max(0, start.height - 6) : 0;
    let n = 0;
    for (;;) {
      const res = await (this.o.fetch ?? fetch)(`${url}?height=${from}&count=${page}`);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length % SIZE) throw new Error(`${url}: ${bytes.length} bytes, not whole headers`);
      const raws: Uint8Array[] = [];
      for (let o = 0; o < bytes.length; o += SIZE) raws.push(bytes.slice(o, o + SIZE));
      if (!raws.length) break;
      await this.o.take(raws, from);
      n += raws.length;
      from += raws.length;
      if (raws.length < page) break;
    }
    this.stats.filled += n;
    const tip = await this.o.tip();
    if (tip && tip.height !== start?.height) this.say(`headers: the history of ${url} into the host chain: ${start ? `from ${start.height}` : "from genesis"} to ${tip.height} (${n} headers, ${Date.now() - t0} ms)`);
  }
}

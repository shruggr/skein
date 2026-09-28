// Router-held feeds (#33 part 2, #29's revision): long-lived subscriptions the
// router keeps on behalf of instances, each of whose items is admitted into
// the subscribed instance as a plain `event` entry (Router.admitEvent) — the
// three event records of docs/WALLET.md:
//
//   header {kind: "header", raw: bytes(80)}
//   status {kind: "status", subject: <tx CID>, txid, txStatus, merklePath?: bytes, blockHeight?, blockHash?}
//
// An instance declares its feeds in its config (etc/config.json, `feeds`),
// which its genesis carries:
//
//   {kind: "headers", url, box?}          an SSE stream of block headers (ChainTracks-style):
//                                         each event's data is the header's hex (160 digits), or
//                                         JSON {header | raw | hex: "<hex>"} (or an array of them)
//   {kind: "arc-callback", box?, token?}  ARC's status callbacks: POST /callback/<handle> with ARC's
//                                         callback JSON {txid, txStatus, merklePath?, …}; with a
//                                         token, only `Authorization: Bearer <token>` is taken
//
// `box` defaults to "chain" (the wallet's sender-less subscription). Nothing
// here judges an item: the instance's own chain tracker validates headers and
// proofs. One SSE connection per URL, fanned out to every subscriber;
// reconnects with exponential backoff (and `Last-Event-ID`); each instance's
// queue of items not yet admitted holds at most `maxQueue` (the oldest go
// first, logged).

import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";

export type FeedSpec =
  | { kind: "headers"; url: string; box?: string }
  | { kind: "arc-callback"; box?: string; token?: string };

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

/** The feeds a genesis declares (`feeds`), the malformed ones left out. */
export function feedsOf(g: Record<string, unknown> | null | undefined): FeedSpec[] {
  const fs = g?.feeds;
  if (!Array.isArray(fs)) return [];
  const out: FeedSpec[] = [];
  for (const f of fs as Array<Record<string, unknown>>) {
    const box = typeof f?.box === "string" && f.box ? f.box : undefined;
    if (f?.kind === "headers" && typeof f.url === "string") out.push({ kind: "headers", url: f.url, ...(box ? { box } : {}) });
    else if (f?.kind === "arc-callback") out.push({ kind: "arc-callback", ...(box ? { box } : {}), ...(typeof f.token === "string" ? { token: f.token } : {}) });
  }
  return out;
}

/** Header bytes out of one SSE event's data: hex, or JSON with header/raw/hex, or an array of those. */
export function headersOf(data: string): Uint8Array[] {
  const hex = (s: unknown): Uint8Array | undefined => typeof s === "string" && /^[0-9a-fA-F]{160}$/.test(s) ? Uint8Array.from(Buffer.from(s, "hex")) : undefined;
  const t = data.trim();
  const direct = hex(t);
  if (direct) return [direct];
  let v: unknown;
  try { v = JSON.parse(t); } catch { return []; }
  const one = (x: unknown): Uint8Array | undefined => {
    if (typeof x === "string") return hex(x);
    const o = x as Record<string, unknown> | null;
    return o && typeof o === "object" ? hex(o.header) ?? hex(o.raw) ?? hex(o.hex) : undefined;
  };
  const list = Array.isArray(v) ? v : Array.isArray((v as { headers?: unknown })?.headers) ? (v as { headers: unknown[] }).headers : [v];
  return list.map(one).filter((x): x is Uint8Array => !!x);
}

/** ARC's callback JSON as a `status` event record, or why not. */
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
  return ev;
}

interface Sse { url: string; subscribers: Map<string, string>; abort: AbortController; lastId?: string; stopped: boolean }
interface Queue { items: Array<{ box: string; event: Record<string, unknown> }>; running: boolean; dropped: number }

export class Feeds {
  readonly o: FeedsOptions;
  private sse = new Map<string, Sse>();
  private declared = new Map<string, FeedSpec[]>();
  private queues = new Map<string, Queue>();
  private stopped = false;

  constructor(o: FeedsOptions) { this.o = o; }

  private say(source: string, line: string): void { this.o.log?.(source, line); }

  /** `handle`'s feeds are these (replacing what it declared before). */
  declare(handle: string, specs: FeedSpec[]): void {
    if (this.stopped) return;
    this.declared.set(handle, specs);
    for (const [url, s] of this.sse) {
      if (s.subscribers.has(handle) && !specs.some((f) => f.kind === "headers" && f.url === url)) s.subscribers.delete(handle);
      if (!s.subscribers.size) { s.stopped = true; s.abort.abort(); this.sse.delete(url); }
    }
    for (const f of specs) {
      if (f.kind !== "headers") continue;
      let s = this.sse.get(f.url);
      if (!s) {
        s = { url: f.url, subscribers: new Map(), abort: new AbortController(), stopped: false };
        this.sse.set(f.url, s);
        void this.connect(s);
      }
      s.subscribers.set(handle, f.box ?? DEFAULT_BOX);
    }
  }

  /** The declared feeds of `handle`. */
  of(handle: string): FeedSpec[] { return this.declared.get(handle) ?? []; }

  stop(): void {
    this.stopped = true;
    for (const s of this.sse.values()) { s.stopped = true; s.abort.abort(); }
    this.sse.clear();
  }

  /** Queue an event for `handle` (bounded), and drain the queue serially. */
  push(handle: string, box: string, event: Record<string, unknown>): void {
    let q = this.queues.get(handle);
    if (!q) this.queues.set(handle, (q = { items: [], running: false, dropped: 0 }));
    q.items.push({ box, event });
    const max = this.o.maxQueue ?? 1000;
    if (q.items.length > max) {
      const n = q.items.length - max;
      q.items.splice(0, n);
      q.dropped += n;
      this.say(handle, `feed: queue full (${max}): dropped the ${n} oldest (${q.dropped} so far)`);
    }
    if (!q.running) void this.drain(handle, q);
  }

  /** How many items wait for `handle` (tests). */
  pending(handle: string): number { return this.queues.get(handle)?.items.length ?? 0; }

  private async drain(handle: string, q: Queue): Promise<void> {
    q.running = true;
    try {
      while (q.items.length && !this.stopped) {
        const { box, event } = q.items.shift()!;
        try { await this.o.admit(handle, box, event); } catch (e) { this.say(handle, `feed: ${String(event.kind)} not admitted: ${(e as Error).message}`); }
      }
    } finally { q.running = false; }
  }

  // ---------------------------------------------------------------- SSE

  private async connect(s: Sse): Promise<void> {
    const { min, max } = this.o.backoff ?? { min: 500, max: 30_000 };
    let wait = min;
    while (!s.stopped && !this.stopped) {
      try {
        const res = await (this.o.fetch ?? fetch)(s.url, {
          headers: { accept: "text/event-stream", ...(s.lastId !== undefined ? { "last-event-id": s.lastId } : {}) },
          signal: s.abort.signal,
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        this.say("router", `feed ${s.url}: connected`);
        let got = false;
        await this.read(s, res.body, () => { if (!got) { got = true; wait = min; } });
        if (s.stopped) return;
        this.say("router", `feed ${s.url}: closed; reconnecting in ${wait} ms`);
      } catch (e) {
        if (s.stopped || this.stopped) return;
        this.say("router", `feed ${s.url}: ${(e as Error).message}; reconnecting in ${wait} ms`);
      }
      await new Promise<void>((r) => { const t = setTimeout(r, wait); s.abort.signal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); });
      wait = Math.min(max, wait * 2);
    }
  }

  /** Parse the event stream (text/event-stream): `data:` lines until a blank line dispatch one event; `id:` is remembered. */
  private async read(s: Sse, body: ReadableStream<Uint8Array>, onData: () => void): Promise<void> {
    const dec = new TextDecoder();
    let buf = "";
    let data: string[] = [];
    let id: string | undefined;
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
            if (data.length) { onData(); this.dispatch(s, data.join("\n")); }
            if (id !== undefined) s.lastId = id;
            data = []; id = undefined;
            continue;
          }
          if (line.startsWith(":")) continue;
          const c = line.indexOf(":");
          const field = c < 0 ? line : line.slice(0, c);
          const v = c < 0 ? "" : line.slice(c + 1).replace(/^ /, "");
          if (field === "data") data.push(v);
          else if (field === "id") id = v;
        }
      }
    } finally { reader.releaseLock?.(); }
  }

  private dispatch(s: Sse, data: string): void {
    const hs = headersOf(data);
    if (!hs.length) { this.say("router", `feed ${s.url}: an event with no header in it: ignored`); return; }
    for (const [handle, box] of s.subscribers) for (const raw of hs) this.push(handle, box, { kind: "header", raw });
  }

  // ---------------------------------------------------------------- webhooks

  /** ARC's callback for `handle` (POST /callback/<handle>). */
  callback(handle: string, headers: Record<string, string | string[] | undefined>, raw: Uint8Array): { status: number; body: Record<string, unknown> } {
    const spec = this.of(handle).find((f): f is Extract<FeedSpec, { kind: "arc-callback" }> => f.kind === "arc-callback");
    if (!spec) return { status: 404, body: { status: "error", code: "ERR_NOT_FOUND", description: `no arc-callback feed for ${handle}` } };
    if (spec.token && headers.authorization !== `Bearer ${spec.token}`) return { status: 401, body: { status: "error", code: "ERR_UNAUTHORIZED" } };
    let v: unknown;
    try { v = JSON.parse(new TextDecoder().decode(raw)); } catch { return { status: 400, body: { status: "error", code: "ERR_BAD_BODY", description: "not JSON" } }; }
    const ev = statusOf(v);
    if (typeof ev === "string") return { status: 400, body: { status: "error", code: "ERR_BAD_CALLBACK", description: ev } };
    this.push(handle, spec.box ?? DEFAULT_BOX, ev);
    return { status: 200, body: { status: "success" } };
  }
}

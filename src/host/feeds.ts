// The host's SSE client and the transaction-status record (feeds.ts keeps its
// name; skein next, SPEC 8: the router-held header feeds, an instance's own
// declared `feeds`, the host's SSE headers feed and its per-instance queues
// and backfill are gone — the Teranode tracker is the one source of the
// host's one header intake, router.ts takeHeaders).
//
// What stays: the broadcaster's (#58, #65, arc.ts) one Arcade subscription
// for the whole host over SseStream, `statusOf` (Arcade's status JSON as a
// `status` record: {kind: "status", subject: <tx CID>, txid, txStatus,
// merklePath?: bytes, blockHeight?, blockHash?, extraInfo?}), `txCid`, and
// DEFAULT_BOX (`chain`: the box the chain app's event rows take — the
// pointer event {kind: "chain", root, height} and the broadcaster's proofs).

import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";

export const DEFAULT_BOX = "chain";

/** A transaction's CID: bitcoin-tx (0xb1), dbl-sha2-256 (0x56) over the txid in internal byte order. */
export function txCid(txid: string): CID {
  return CID.createV1(0xb1, Digest.create(0x56, Uint8Array.from(Buffer.from(txid, "hex").reverse())));
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
  // Arcade's ARC code on a status (its numeric `status`, 460-499: arc.ts ARC_CODES).
  if (typeof o.status === "number" && o.status >= 460 && o.status < 500) ev.code = o.status;
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

// The event index served by the host (0.5.0). Every fact a step emits —
// {kind: "event", event: <name>, app, …}, its name a slash path under its
// app's own name (log.zig indexedName) — the kernel puts in the instance's
// event index at commit (index.zig `events`: name ‖ place → record). The host
// reads that index from the store by CID, with no step and no fuel (the same
// read a program makes in its step, program.zig `events`), at the instance's
// origin, its own route (no program, no entry, nothing logged, unsigned):
//
//   GET /events/<name path>?after=<place>&limit=<n>&latest=1
//
//   The path after `/events/` is an event's name (each segment
//   URI-decoded), or with a trailing `/` a prefix of names (`/events/` alone:
//   every name). `after`: only the events strictly after that place; `limit`:
//   the first n; `latest=1`: the last event per distinct name under the
//   prefix. Newest last.
//
//   Answered as JSON [{id, event, record}] — `record` the record as DAG-JSON
//   (as the explorer renders records: a link {"/": "<cid>"}, bytes {"/":
//   {"bytes": "<base64>"}}).
//
//   With `Accept: text/event-stream`: the same read as a Server-Sent Events
//   stream, then live — each matching event as its step's commit hands it
//   over (its place in the kernel's notice: no store read), until the client
//   goes or the instance stops. Last-Event-ID (the browser's EventSource sends
//   it on reconnect) is `after`. One message per event:
//
//   id: <s>.<i>.<thread>         the event's place (0.8.0): the instance's step number of the update
//                                listing it (`s`), the record's index in that update's `emitted` (`i`)
//                                — the order, `s` then `i` — and the thread (its origin's CID), which
//                                orders nothing
//   event: <name>                the event's name
//   data: <the record>           the record as DAG-JSON, one line
//
// Nothing is kept but the open streams and the ids lately sent (a start hands
// an awaited event over again): one registry per instance, in memory.

import * as dagCbor from "@ipld/dag-cbor";
import * as dagJson from "@ipld/dag-json";
import { CID } from "multiformats/cid";
import { indexedName, type EventPlace, type EventRow, type EventsQuery } from "../runtime/index-store.ts";
import type { Store } from "../runtime/store.ts";

/** The store a read uses (a store file opened read-only), closed after: its event index read, when it has one. */
export type EventStore = Pick<Store, "bytes"> & { events?(q: EventsQuery): EventRow[]; close(): unknown };

/** One event as the read and the stream send it. */
export interface Delivered {
  /** Its place: `<s>.<i>.<thread>`. */
  id: string;
  event: string;
  /** The record as DAG-JSON. */
  data: string;
}

/** The place of id `<s>.<i>.<thread>`, or undefined (0.8.0: a four-part id of before is none). */
export function placeOf(id: string): EventPlace | undefined {
  const m = /^(\d+)\.(\d+)\.([a-z0-9]+)$/.exec(id);
  if (!m) return undefined;
  try { return { s: Number(m[1]), i: Number(m[2]), thread: CID.parse(m[3]!) }; } catch { return undefined; }
}

/** The id of the event at `p`: `<s>.<i>.<thread>`. */
export const idOf = (p: { s: number; i: number; thread: CID }): string => `${p.s}.${p.i}.${p.thread}`;

/** GET /events/<path>: the route's path → the name (or prefix) read, or undefined when the route is not one. */
export function eventsPath(route: string): { name: string; prefix: boolean } | { problem: string } | undefined {
  if (route !== "/events" && !route.startsWith("/events/")) return undefined;
  const rest = route.slice("/events/".length);
  const prefix = rest === "" || rest.endsWith("/");
  let name: string;
  try { name = rest.split("/").map(decodeURIComponent).join("/"); } catch { return { problem: `/events/${rest}: not a name (a bad %-escape)` }; }
  if (/[ \0]/.test(name)) return { problem: `${JSON.stringify(name)}: a name has no space or NUL` };
  const segs = (prefix ? name.replace(/\/$/, "") : name).split("/");
  if (name !== "" && segs.some((x) => x === "")) return { problem: `${JSON.stringify(name)}: an empty segment` };
  return { name, prefix };
}

/** A read's query: the path's name, and `after` / `limit` / `latest` (Last-Event-ID wins over `after`), or why it is not one. */
export function eventsQuery(route: string, params: URLSearchParams, lastEventId?: string): EventsQuery | { problem: string } | undefined {
  const p = eventsPath(route);
  if (!p || "problem" in p) return p;
  const q: EventsQuery = { name: p.name, prefix: p.prefix };
  const after = lastEventId?.trim() || params.get("after") || undefined;
  if (after !== undefined) {
    const at = placeOf(after);
    if (!at) return { problem: `after: ${JSON.stringify(after)} is not an event's place (<s>.<i>.<thread>)` };
    q.after = at;
  }
  const limit = params.get("limit");
  if (limit !== null) {
    if (!/^[1-9]\d*$/.test(limit)) return { problem: "limit: a whole number of events, 1 or more" };
    q.limit = Number(limit);
  }
  const latest = params.get("latest");
  if (latest !== null) {
    if (latest !== "1" && latest !== "0") return { problem: "latest: 1 (the last per name) or 0" };
    if (latest === "1") q.latest = true;
  }
  return q;
}

const dataOf = (rec: unknown): string => new TextDecoder().decode(dagJson.encode(rec));

/** The read over a store's event index (none in a store without one: nothing). */
export async function readEvents(store: EventStore, q: EventsQuery): Promise<Delivered[]> {
  if (!store.events) return [];
  const out: Delivered[] = [];
  for (const r of store.events(q)) out.push({ id: idOf(r.place), event: r.name, data: dataOf(dagCbor.decode(await store.bytes(r.record))) });
  return out;
}

/** One event as an SSE message. */
export function sseMessage(d: Delivered): string {
  return `id: ${d.id}\nevent: ${d.event}\ndata: ${d.data}\n\n`;
}

/** Whether a stream's query takes a live event of `name` (its name, or a name under its prefix). */
const takes = (q: EventsQuery, name: string) => (q.prefix ? name.startsWith(q.name) : name === q.name);

/** An open stream: what it asked for, where its messages go, how it is closed; what came live while its first read ran. */
interface Sub { q: EventsQuery; send(d: Delivered): void; close(): void; held?: Delivered[] }

export interface EventStreamsOptions {
  /** The instance's store, read-only (undefined: none). */
  open(handle: string): EventStore | undefined;
}

/** How many ids sent an instance remembers (a start hands an awaited event over again). */
const SENT_MAX = 10_000;

/** The registry of open streams, per instance. */
export class EventStreams {
  private subs = new Map<string, Set<Sub>>();
  /** Per instance: the ids handed over lately, in order: one handed over again is not sent again. */
  private sent = new Map<string, Set<string>>();
  private readonly o: EventStreamsOptions;
  constructor(o: EventStreamsOptions) { this.o = o; }

  /** Whether `handle` has an open stream. */
  open(handle: string): boolean { return (this.subs.get(handle)?.size ?? 0) > 0; }

  /** How many streams `handle` has open (tests). */
  count(handle: string): number { return this.subs.get(handle)?.size ?? 0; }

  /** The read, once (GET /events/… as JSON). */
  async read(handle: string, q: EventsQuery): Promise<Delivered[]> {
    const s = this.o.open(handle);
    if (!s) return [];
    try { return await readEvents(s, q); } finally { s.close(); }
  }

  /**
   * Open a stream for `handle`: the read sent, then each new matching event as it is handed over
   * (what came during the read, after it, once). `send` writes one event; `close` ends the stream
   * (the host's: the instance stopping). The returned function forgets it (the client went).
   */
  async subscribe(handle: string, q: EventsQuery, send: (d: Delivered) => void, close: () => void): Promise<() => void> {
    const sub: Sub = { q, send, close, held: [] };
    let set = this.subs.get(handle);
    if (!set) this.subs.set(handle, set = new Set());
    set.add(sub);
    const forget = () => this.remove(handle, sub);
    try {
      const first = await this.read(handle, q);
      const had = new Set(first.map((d) => d.id));
      const held = sub.held!;
      delete sub.held;
      if (!set.has(sub)) return forget; // gone meanwhile
      for (const d of first) sub.send(d);
      for (const d of held) if (!had.has(d.id)) sub.send(d);
    } catch (e) { forget(); throw e; }
    return forget;
  }

  /**
   * An event handed over for `handle` (after its step's commit), with its place in the log: sent
   * as it is to each open stream it matches — no store read. Only a fact the index holds (an
   * intention is not one); one handed over again (a start re-offers what a waiting thread awaits)
   * is not sent again.
   */
  emitted(handle: string, rec: Record<string, unknown>, place: { s: number; i: number; thread: CID }): void {
    const subs = this.subs.get(handle);
    if (!subs?.size) return;
    const name = indexedName(rec);
    if (name === undefined) return;
    const d: Delivered = { id: idOf(place), event: name, data: dataOf(rec) };
    let sent = this.sent.get(handle);
    if (!sent) this.sent.set(handle, sent = new Set());
    if (sent.has(d.id)) return;
    sent.add(d.id);
    if (sent.size > SENT_MAX) sent.delete(sent.values().next().value!);
    for (const s of subs) if (takes(s.q, name)) { if (s.held) s.held.push(d); else s.send(d); }
  }

  /** Close every stream of `handle` (it stops). */
  drop(handle: string): void {
    for (const s of [...this.subs.get(handle) ?? []]) this.end(handle, s);
  }

  /** Close them all (the host shuts down). */
  stop(): void { for (const h of [...this.subs.keys()]) this.drop(h); }

  private remove(handle: string, s: Sub): void {
    const set = this.subs.get(handle);
    set?.delete(s);
    if (set && !set.size) { this.subs.delete(handle); this.sent.delete(handle); }
  }

  private end(handle: string, s: Sub): void {
    this.remove(handle, s);
    try { s.close(); } catch { /* the client's socket is gone already */ }
  }
}

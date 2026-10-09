// An app's emitted events, served live to its page (#148). Any program of an
// app emits events ({kind: "event", event, app, topic, …}, log.zig
// eventRecord, #119); the kernel lists each on its step's update (`emitted`)
// and, once the step is committed, hands it to the host with its place in the
// log (providers.ts: the `emitted` hook, for every event whatever its name). This module serves
// them on the instance's origin, the host's own route (no program, no entry,
// nothing logged, unsigned — a read like /.live, #138, #143):
//
//   GET /<app>/.events?event=<name>&topic=<t1>&topic=<t2>…
//
//   `event` is required, one name; `topic` is repeated, one per topic (at
//   least one; a topic is any text, so no separator is taken out of it). Sent:
//   only the events of that app (the record's `app`, the kernel's), that name,
//   whose `topic` is one of those. Nothing about any name is the host's: a
//   price is one more event.
//
// The answer is a Server-Sent Events stream (text/event-stream), one message
// per event record, in log order:
//
//   id: <n>.<seq>.<i>.<thread>   the event's place in the log: the entry its step processed (`n`), the
//                                step's place in its thread (`seq`), the record's place in the update's
//                                `emitted` (`i`), the thread (its origin's CID). The entry alone is not a
//                                place: one entry can step several threads
//   event: <name>                the event's name
//   data: <the record>           the record as DAG-JSON (as the explorer renders records: a link
//                                {"/": "<cid>"}, bytes {"/": {"bytes": "<base64>"}}), one line
//
// On connect:
//   - with Last-Event-ID (the browser's EventSource sends it on reconnect):
//     every matching event after that place, folded from the log (p2p.ts
//     emittedEvents, the order the kernel folds by), then live. A place no
//     longer in the log (or never in it) resumes after its entry: the
//     matching events of later entries. One that is not a place: 400;
//   - without: the current value — the LAST matching event per requested
//     topic (one per topic that has one), in log order — then live.
//
// Live: the kernel's `emit` notice carries each event's place in the log
// beside the record (`place`: {n, seq, i, thread}; the record is unchanged),
// so a live event is sent as it is handed over, its id made from the notice,
// with no log read; the log is read only for a new subscription's first
// messages (Last-Event-ID, or the current value). An id handed over again (a
// start re-offers what a waiting thread awaits) is not sent again. Nothing is
// kept but the open subscriptions and the ids lately sent: one registry per
// instance, in memory. An app's subscriptions close at its uninstall (no row
// of it left in the dispatch table), all of an instance's when it stops (the
// instance manager, a reclaim) and when the host shuts down.
//
// Beats (#138) are not events: not served here (GET /<app>/.live/<topic>).

import * as dagCbor from "@ipld/dag-cbor";
import * as dagJson from "@ipld/dag-json";
import type { CID } from "multiformats/cid";
import type { Store } from "../runtime/store.ts";
import { emittedEvents } from "./p2p.ts";

/** The store a fold reads (a store file opened read-only), closed after. */
export type EventStore = Pick<Store, "get" | "chains" | "edges" | "bytes"> & { close(): unknown };

/** One emitted event as the stream sends it. */
export interface Delivered {
  /** Its place: `<n>.<seq>.<i>.<thread>`. */
  id: string;
  n: number;
  event: string;
  app: string;
  topic: string;
  /** The record as DAG-JSON. */
  data: string;
}

/** A subscription's request: the app, the event's name, the topics; and where it resumes (Last-Event-ID). */
export interface EventsQuery { app: string; event: string; topics: string[]; after?: string }

/** The query of GET /<app>/.events (`event`, `topic` repeated) and Last-Event-ID, or why it is not one. */
export function eventsQuery(app: string, params: URLSearchParams, lastEventId: string | undefined): EventsQuery | { problem: string } {
  const event = params.get("event") ?? "";
  if (!event) return { problem: "event: the event's name (required)" };
  if (params.getAll("event").length > 1) return { problem: "event: one name" };
  const topics = [...new Set(params.getAll("topic"))];
  if (!topics.length || topics.some((t) => !t)) return { problem: "topic: one or more topics (repeat topic=, one per topic)" };
  const after = lastEventId?.trim() || undefined;
  if (after !== undefined && !placeOf(after)) return { problem: `Last-Event-ID: ${JSON.stringify(after)} is not an event's place (<n>.<seq>.<i>.<thread>)` };
  return { app, event, topics, ...(after ? { after } : {}) };
}

/** An event id's parts, or undefined. */
export function placeOf(id: string): { n: number; seq: number; i: number; thread: string } | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)\.([a-z0-9]+)$/.exec(id);
  return m ? { n: Number(m[1]), seq: Number(m[2]), i: Number(m[3]), thread: m[4]! } : undefined;
}

/** One event as an SSE message. */
export function sseMessage(d: Delivered): string {
  return `id: ${d.id}\nevent: ${d.event}\ndata: ${d.data}\n\n`;
}

/** Every event record a stream serves in the log, in log order, as delivered (resume and the current value). */
export async function foldEvents(store: EventStore): Promise<Delivered[]> {
  const places = await emittedEvents(store, (rec, p) => typeof rec.event === "string" && typeof rec.app === "string" && typeof rec.topic === "string" ? p : undefined);
  const out: Delivered[] = [];
  for (const p of places) {
    const d = deliveredOf(dagCbor.decode(await store.bytes(p.record)), p);
    if (d) out.push(d);
  }
  return out;
}

/** Whether a subscription takes an event. */
const takes = (q: EventsQuery, d: Delivered) => d.app === q.app && d.event === q.event && q.topics.includes(d.topic);

/** What a subscription is sent first (folded from the log): after its Last-Event-ID, else the last per topic. */
export function backlog(all: Delivered[], q: EventsQuery): Delivered[] {
  if (q.after !== undefined) {
    const i = all.findIndex((d) => d.id === q.after);
    const n = placeOf(q.after)!.n;
    return (i >= 0 ? all.slice(i + 1) : all.filter((d) => d.n > n)).filter((d) => takes(q, d));
  }
  const last = new Map<string, Delivered>();
  for (const d of all) if (takes(q, d)) last.set(d.topic, d);
  const ids = new Set([...last.values()].map((d) => d.id));
  return all.filter((d) => ids.has(d.id));
}

/** An event's place in the log, as the kernel's `emit` notice carries it beside the record (#148). */
export interface Place { n: number; seq: number; i: number; thread: CID }

/** The id of the event at `p`: `<n>.<seq>.<i>.<thread>` — the fold's (foldEvents), free from the notice. */
export const idOf = (p: Place): string => `${p.n}.${p.seq}.${p.i}.${p.thread}`;

/** A handed-over event as delivered, or undefined when it is not one a stream serves (no app, no topic). */
export function deliveredOf(rec: Record<string, unknown>, p: Place): Delivered | undefined {
  if (rec.kind !== "event" || typeof rec.event !== "string" || typeof rec.app !== "string" || typeof rec.topic !== "string") return undefined;
  return { id: idOf(p), n: p.n, event: rec.event, app: rec.app, topic: rec.topic, data: new TextDecoder().decode(dagJson.encode(rec)) };
}

/** An open subscription: what it asked for, where its messages go, how it is closed; what came live while its backlog was read. */
interface Sub { q: EventsQuery; send(d: Delivered): void; close(): void; held?: Delivered[] }

export interface EventStreamsOptions {
  /** The instance's store, read-only (undefined: none). */
  open(handle: string): EventStore | undefined;
}

/** How many ids sent an instance remembers (a start hands an awaited event over again). */
const SENT_MAX = 10_000;

/** The registry of open subscriptions, per instance (#148). */
export class EventStreams {
  private subs = new Map<string, Set<Sub>>();
  /** Per instance: the ids handed over lately, in order: one handed over again is not sent again. */
  private sent = new Map<string, Set<string>>();
  private readonly o: EventStreamsOptions;
  constructor(o: EventStreamsOptions) { this.o = o; }

  /** Whether `handle` has an open subscription. */
  open(handle: string): boolean { return (this.subs.get(handle)?.size ?? 0) > 0; }

  /** How many subscriptions `handle` has open (tests). */
  count(handle: string): number { return this.subs.get(handle)?.size ?? 0; }

  /**
   * Open a subscription for `handle`: its backlog folded from the log and sent, then each new
   * matching event as it is handed over (what came during the fold, after it, once). `send` writes
   * one event; `close` ends the stream (the host's: an uninstall, the instance stopping). The
   * returned function forgets it (the client went).
   */
  async subscribe(handle: string, q: EventsQuery, send: (d: Delivered) => void, close: () => void): Promise<() => void> {
    const sub: Sub = { q, send, close, held: [] };
    let set = this.subs.get(handle);
    if (!set) this.subs.set(handle, set = new Set());
    set.add(sub);
    const forget = () => this.remove(handle, sub);
    try {
      const s = this.o.open(handle);
      let all: Delivered[] = [];
      if (s) try { all = await foldEvents(s); } finally { s.close(); }
      const first = backlog(all, q);
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
   * as it is to each open subscription it matches — no log read. One handed over again (a start
   * re-offers what a waiting thread awaits) is not sent again.
   */
  emitted(handle: string, rec: Record<string, unknown>, place: Place): void {
    const subs = this.subs.get(handle);
    if (!subs?.size) return;
    const d = deliveredOf(rec, place);
    if (!d) return;
    let sent = this.sent.get(handle);
    if (!sent) this.sent.set(handle, sent = new Set());
    if (sent.has(d.id)) return;
    sent.add(d.id);
    if (sent.size > SENT_MAX) sent.delete(sent.values().next().value!);
    for (const s of subs) if (takes(s.q, d)) { if (s.held) s.held.push(d); else s.send(d); }
  }

  /** The apps `handle` has installed now (rows in its dispatch table): the others' subscriptions close. */
  keep(handle: string, apps: Set<string>): void {
    for (const s of [...this.subs.get(handle) ?? []]) if (!apps.has(s.q.app)) this.end(handle, s);
  }

  /** Close every subscription of `handle` (it stops). */
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

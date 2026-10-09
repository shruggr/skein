// An app's emitted events, served live to its page (#148). Any program of an
// app emits events ({kind: "event", event, app, topic, …}, log.zig
// eventRecord, #119); the kernel lists each on its step's update (`emitted`)
// and, once the step is committed, hands it to the host (providers.ts: the
// `emitted` hook, for every event whatever its name). This module serves
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
// Live: each event the kernel hands over triggers a fold of the instance's log
// from the last one followed (updates no older than its time), coalesced, one
// per instance; what is new is sent to every open subscription it matches.
// Nothing is kept but the open subscriptions and that position: one registry
// per instance, in memory. An app's subscriptions close at its uninstall (no
// row of it left in the dispatch table), all of an instance's when it stops
// (the instance manager, a reclaim) and when the host shuts down.
//
// Beats (#138) are not events: not served here (GET /<app>/.live/<topic>).

import * as dagCbor from "@ipld/dag-cbor";
import * as dagJson from "@ipld/dag-json";
import type { Store } from "../runtime/store.ts";
import { emittedEvents } from "./p2p.ts";

/** The store a fold reads (a store file opened read-only), closed after. */
export type EventStore = Pick<Store, "get" | "chains" | "edges" | "bytes"> & { close(): unknown };

/** One emitted event as the stream sends it. */
export interface Delivered {
  /** Its place: `<n>.<seq>.<i>.<thread>`. */
  id: string;
  n: number;
  /** The step's time (ms). */
  at: number;
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

/** Every event record in the log (or, with `since`, in the updates no older than it), in log order, as delivered. */
export async function foldEvents(store: EventStore, since?: number): Promise<Delivered[]> {
  const places = await emittedEvents(store, (rec, p) => {
    if (typeof rec.event !== "string" || typeof rec.app !== "string" || typeof rec.topic !== "string") return undefined;
    return { p, event: rec.event, app: rec.app, topic: rec.topic };
  }, since);
  const out: Delivered[] = [];
  for (const { p, event, app, topic } of places) {
    const data = new TextDecoder().decode(dagJson.encode(dagCbor.decode(await store.bytes(p.record))));
    out.push({ id: `${p.n}.${p.seq}.${p.i}.${p.thread}`, n: p.n, at: p.at, event, app, topic, data });
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

/** An open subscription: what it asked for, where its messages go, how it is closed. */
interface Sub { q: EventsQuery; send(d: Delivered): void; close(): void; live: boolean }

/** Where the follow stands per instance: the newest step time folded, and the events at that time already sent. */
interface Followed { at: number; ids: Set<string> }

export interface EventStreamsOptions {
  /** The instance's store, read-only (undefined: none). */
  open(handle: string): EventStore | undefined;
  log?(handle: string, line: string): void;
}

/** The registry of open subscriptions, per instance (#148). */
export class EventStreams {
  private subs = new Map<string, Set<Sub>>();
  private followed = new Map<string, Followed>();
  /** Per instance: the folds, one after another; `again` when an event came during one. */
  private chain = new Map<string, Promise<void>>();
  private again = new Set<string>();
  private readonly o: EventStreamsOptions;
  constructor(o: EventStreamsOptions) { this.o = o; }

  /** Whether `handle` has an open subscription. */
  open(handle: string): boolean { return (this.subs.get(handle)?.size ?? 0) > 0; }

  /** How many subscriptions `handle` has open (tests). */
  count(handle: string): number { return this.subs.get(handle)?.size ?? 0; }

  /**
   * Open a subscription for `handle`: its backlog folded from the log and sent, then each new
   * matching event as it is handed over. `send` writes one event; `close` ends the stream (the
   * host's: an uninstall, the instance stopping). The returned function forgets it (the client went).
   */
  async subscribe(handle: string, q: EventsQuery, send: (d: Delivered) => void, close: () => void): Promise<() => void> {
    const sub: Sub = { q, send, close, live: false };
    let set = this.subs.get(handle);
    if (!set) this.subs.set(handle, set = new Set());
    set.add(sub);
    const forget = () => { const s = this.subs.get(handle); s?.delete(sub); if (s && !s.size) { this.subs.delete(handle); this.followed.delete(handle); } };
    try {
      await this.serial(handle, async () => {
        const events = await this.fold(handle);
        // The fold doubles as a follow: what the live ones have not had yet goes to them first.
        this.advance(handle, events);
        if (!set!.has(sub)) return; // gone meanwhile
        for (const d of backlog(events, q)) sub.send(d);
        sub.live = true;
      });
    } catch (e) { forget(); throw e; }
    return forget;
  }

  /** An event was handed over for `handle` (after its step's commit): fold from where the follow stands. */
  emitted(handle: string): void {
    if (!this.open(handle)) return;
    if (this.chain.has(handle)) { this.again.add(handle); return; }
    void this.serial(handle, () => this.follow(handle)).catch((e) => this.o.log?.(handle, `events: not followed: ${(e as Error).message}`));
  }

  /** The apps `handle` has installed now (rows in its dispatch table): the others' subscriptions close. */
  keep(handle: string, apps: Set<string>): void {
    for (const s of [...this.subs.get(handle) ?? []]) if (!apps.has(s.q.app)) this.end(handle, s);
  }

  /** Close every subscription of `handle` (it stops). */
  drop(handle: string): void {
    for (const s of [...this.subs.get(handle) ?? []]) this.end(handle, s);
    this.followed.delete(handle);
  }

  /** Close them all (the host shuts down). */
  stop(): void { for (const h of [...this.subs.keys()]) this.drop(h); }

  private end(handle: string, s: Sub): void {
    const set = this.subs.get(handle);
    set?.delete(s);
    if (set && !set.size) { this.subs.delete(handle); this.followed.delete(handle); }
    try { s.close(); } catch { /* the client's socket is gone already */ }
  }

  /** Run `f` after what `handle` is folding now; one at a time per instance. */
  private serial(handle: string, f: () => Promise<void>): Promise<void> {
    const run = (this.chain.get(handle) ?? Promise.resolve()).then(f);
    const tail: Promise<void> = run.catch(() => {}).then(() => { // a failure is the caller's to report
      if (this.chain.get(handle) === tail) this.chain.delete(handle);
      if (this.again.delete(handle)) this.emitted(handle);
    });
    this.chain.set(handle, tail);
    return run;
  }

  /** The instance's events folded (since `since`), its store opened and closed around it. */
  private async fold(handle: string, since?: number): Promise<Delivered[]> {
    const s = this.o.open(handle);
    if (!s) return [];
    try { return await foldEvents(s, since); } finally { s.close(); }
  }

  /** Follow: the events since where the follow stands, the new ones sent. */
  private async follow(handle: string): Promise<void> {
    if (!this.open(handle)) return;
    const f = this.followed.get(handle);
    this.advance(handle, await this.fold(handle, f && Number.isFinite(f.at) ? f.at : undefined));
  }

  /** Of `events` (in log order), those the follow has not had yet: sent to the live subscriptions they match; the follow moves past them. */
  private advance(handle: string, events: Delivered[]): void {
    const f = this.followed.get(handle);
    const fresh = f ? events.filter((d) => d.at > f.at || (d.at === f.at && !f.ids.has(d.id))) : [];
    const top = events.reduce((m, d) => Math.max(m, d.at), f?.at ?? -Infinity);
    const ids = new Set(f && f.at === top ? f.ids : []);
    for (const d of events) if (d.at === top) ids.add(d.id);
    if (this.open(handle)) this.followed.set(handle, { at: top, ids });
    for (const d of fresh) for (const s of this.subs.get(handle) ?? []) if (s.live && takes(s.q, d)) s.send(d);
  }
}

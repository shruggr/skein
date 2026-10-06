// The liveness tool (#138): a runtime handler keyed by event name, like the
// deadline, fetch and beacon handlers (#126). An app's installed program
// declares, once per topic,
//
//   liveness   {event: "liveness", topic, window: <ms, a second to a day>}
//   unliveness {event: "unliveness", topic}
//
// and the kernel records it on the step's update (kernel-zig/src/
// subscriptions.zig livenessProblem / livenessFold). Here, for each liveness
// topic the apps keep (folded from the log, livenessOf, then followed live):
//
//   - the instance's own libp2p node subscribes the topic WITHOUT admitting
//     its messages: no front-door call, no entry, nothing logged (P2PHost:
//     a topic only liveness takes is judged here alone);
//   - each message is a beacon beat (p2p.ts beaconFrame: {body, at, sender,
//     signature}); its instance signature is checked (beaconBeat) and a beat
//     that does not verify is dropped (and rejected to GossipSub);
//   - the beats newer than the window are kept, the latest per sender
//     (identity key), with the peer that published it (`from`); the node's
//     OWN beats on the topic are written into the same set (gossip does not
//     echo them: P2PHost.beacons);
//   - in memory only: empty after a restart until the next beats; dropped at
//     the app's unliveness or uninstall.
//
// The set is served to the app's page by the host itself, no program in
// between (Router: GET /<app>/.live/<topic> on the instance's origin).
// A runtime without this tool records the events and nothing happens.

import type { Store } from "../runtime/store.ts";
import { beaconBeat, emittedEvents, isTopic } from "./p2p.ts";

/** A window's bounds (ms): a second, a day (subscriptions.zig LIVENESS_MIN_MS / _MAX_MS). */
export const LIVENESS_MIN_MS = 1000;
export const LIVENESS_MAX_MS = 86_400_000;

/** One app's liveness for a topic: how long a beat stays live (ms). */
export interface Live { app: string; topic: string; window: number }
export type LivenessEvent = { event: "liveness"; live: Live } | { event: "unliveness"; app: string; topic: string };

/** A `liveness` / `unliveness` event record, read (subscriptions.zig livenessEventOf); or why it is not one this host follows. */
export function livenessEvent(rec: Record<string, unknown>): LivenessEvent | { refused: string } {
  const event = rec.event;
  if (rec.kind !== "event" || (event !== "liveness" && event !== "unliveness")) return { refused: "not a liveness or unliveness event" };
  if (typeof rec.app !== "string" || !rec.app) return { refused: "it names no app (its program record is not installed): ignored" };
  if (!isTopic(rec.topic)) return { refused: `${JSON.stringify(rec.topic)} is not a topic` };
  if (event === "unliveness") return { event, app: rec.app, topic: rec.topic };
  const window = typeof rec.window === "number" ? rec.window : typeof rec.window === "bigint" ? Number(rec.window) : NaN;
  if (!Number.isInteger(window) || window < LIVENESS_MIN_MS || window > LIVENESS_MAX_MS) return { refused: "a liveness window is from a second to a day (`window`, ms)" };
  return { event, live: { app: rec.app, topic: rec.topic, window } };
}

/** Fold liveness events in order: a liveness replaces the app's own on the topic, an unliveness removes it. */
export function foldLiveness(events: Iterable<LivenessEvent>, into: Live[] = []): Live[] {
  for (const e of events) {
    const [app, topic] = e.event === "liveness" ? [e.live.app, e.live.topic] : [e.app, e.topic];
    const i = into.findIndex((l) => l.app === app && l.topic === topic);
    if (e.event === "liveness") { if (i >= 0) into[i] = e.live; else into.push(e.live); } else if (i >= 0) into.splice(i, 1);
  }
  return into;
}

/** The liveness standing, folded from the store's log as the subscriptions and beacons are (p2p.ts subscriptionsOf). Read only. */
export async function livenessOf(store: Pick<Store, "get" | "chains" | "edges">): Promise<Live[]> {
  return foldLiveness(await emittedEvents(store, (rec) => { const e = livenessEvent(rec); return "refused" in e ? undefined : e; }));
}

/** A beat kept: the sender's identity key (hex), the beat's time, its body, the peer that published it (peer ID). */
export interface LiveBeat { sender: string; at: number; body: Uint8Array; from: string }

/** A message's verdict for GossipSub: a verified beat is accepted (forwarded), a bad one rejected, a stale one ignored. */
export type LiveVerdict = "accept" | "reject" | "ignore";

/** The tool's state: per instance, the apps' liveness and the beats kept per topic (in memory). */
export class Liveness {
  private lives = new Map<string, Live[]>();
  /** handle → topic → sender → the latest beat. */
  private beats = new Map<string, Map<string, Map<string, LiveBeat>>>();

  private readonly now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }

  /** `handle`'s apps keep this liveness now: the beats of topics none keeps any more are dropped. */
  set(handle: string, lives: Live[]): void {
    if (!lives.length) { this.drop(handle); return; }
    this.lives.set(handle, lives.map((l) => ({ ...l })));
    const kept = this.beats.get(handle);
    if (kept) for (const t of kept.keys()) if (!lives.some((l) => l.topic === t)) kept.delete(t);
  }

  /** The topics `handle`'s apps keep liveness for (each once). */
  topics(handle: string): string[] { return [...new Set((this.lives.get(handle) ?? []).map((l) => l.topic))]; }

  /** Whether an app of `handle` keeps liveness for `topic`. */
  takes(handle: string, topic: string): boolean { return (this.lives.get(handle) ?? []).some((l) => l.topic === topic); }

  /** The longest window on `topic` among `handle`'s apps (ms), or undefined. */
  private windowOf(handle: string, topic: string): number | undefined {
    const ws = (this.lives.get(handle) ?? []).filter((l) => l.topic === topic).map((l) => l.window);
    return ws.length ? Math.max(...ws) : undefined;
  }

  /**
   * A message on `topic` at `handle`'s node, published by peer `from`: kept when it is a beat whose
   * instance signature verifies (beaconBeat) and is newer than the longest window on the topic — the
   * sender's latest replaces an older one. Nothing logged.
   */
  observe(handle: string, topic: string, frame: Uint8Array, from: string): LiveVerdict {
    const window = this.windowOf(handle, topic);
    if (window === undefined) return "ignore";
    const b = beaconBeat(topic, frame);
    if ("problem" in b) return "reject";
    const now = this.now();
    // A beat older than the window is not live; one dated more than a window ahead of this clock is not believed.
    if (now - b.at >= window || b.at - now > window) return "ignore";
    let byTopic = this.beats.get(handle);
    if (!byTopic) this.beats.set(handle, byTopic = new Map());
    let bySender = byTopic.get(topic);
    if (!bySender) byTopic.set(topic, bySender = new Map());
    const sender = Buffer.from(b.sender).toString("hex");
    const was = bySender.get(sender);
    if (!was || b.at > was.at) bySender.set(sender, { sender, at: b.at, body: b.body, from });
    // The stale ones go as the set is touched.
    for (const [k, x] of bySender) if (now - x.at >= window) bySender.delete(k);
    return "accept";
  }

  /** The beats live for `app`'s liveness on `topic` (newer than its window), newest first; undefined: the app keeps no liveness for the topic. */
  read(handle: string, app: string, topic: string): LiveBeat[] | undefined {
    const l = (this.lives.get(handle) ?? []).find((x) => x.app === app && x.topic === topic);
    if (!l) return undefined;
    const now = this.now();
    return [...(this.beats.get(handle)?.get(topic)?.values() ?? [])].filter((b) => now - b.at < l.window).sort((x, y) => y.at - x.at);
  }

  /** Forget `handle`: its liveness and its beats. */
  drop(handle: string): void {
    this.lives.delete(handle);
    this.beats.delete(handle);
  }
}

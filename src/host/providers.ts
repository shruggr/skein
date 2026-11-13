// What an instance's steps hand the host (skein next, SPEC.md section 5): an emit is a broadcast event
// or a fact under the emitting app's name, or a membership declaration — never a message to a key
// (the kernel refuses that). Once its step is committed the kernel hands each over (the `emit`
// notice: {message: <the event record>, body, transport: "event", address: <name>, place?}; `place`
// the event's place in the log) and this module acts on it by name:
//
//   broadcast    {kind: "broadcast", tx: <cid>, beef?}, the transaction's bytes as `body` → the host's
//                broadcaster (arc.ts: a durable queue, retries, one Arcade session; none: dropped
//                with a line)
//   subscribe, unsubscribe, beacon, unbeacon, liveness, unliveness
//                the instance's topic membership → the libp2p node (p2p.ts, liveness.ts): what the
//                instance serves; the host joins and listens (SPEC 7). Nothing of gossip goes back in.
//   every event, whatever its name, to `emitted` (the event streams, events.ts; the host's own
//                followers: the holder map, the gossip admit)
//
// The host's services sign with their own keys (SPEC 8: "a little microservice"), none of them root:
// the status service's key is signer.ts providerKey("status").

import type { CID } from "multiformats/cid";

/** What the kernel hands over (the `emit` notice). */
export interface Outgoing {
  message: Record<string, unknown>; body: Uint8Array; transport: string; address: string;
  /** An event's place, beside the record: the instance's step number of its update, the index in `emitted`, the thread. */
  place?: { s: number | bigint; i: number | bigint; thread: CID };
}

/** The host's services that sign with their own key (signer.ts providerKey): the status service. */
export type ServiceName = "status";

export interface EmitsOptions {
  /** The broadcaster (the host's Arcade), when the host has one: a broadcast event's transaction and BEEF, queued. */
  broadcast?(handle: string, tx: Uint8Array, beef?: Uint8Array): void;
  /** The libp2p node's membership: a subscribe / unsubscribe / beacon / unbeacon / liveness / unliveness record from `handle`. Absent: no libp2p node. */
  topicEvent?(handle: string, record: Record<string, unknown>): void;
  /** Every event record {kind: "event", event, …} from `handle`, as it is handed over, with its place in the log. */
  emitted?(handle: string, record: Record<string, unknown>, place: { s: number; i: number; thread: CID }): void;
  log?(source: string, line: string): void;
}

/** The events the libp2p node's wiring takes (`topicEvent`). */
const TOPIC_EVENTS: readonly string[] = ["subscribe", "unsubscribe", "beacon", "unbeacon", "liveness", "unliveness"];

export class Emits {
  readonly o: EmitsOptions;
  private stopped = false;
  constructor(o: EmitsOptions) { this.o = o; }

  private say(source: string, line: string): void { this.o.log?.(source, line); }

  stop(): void { this.stopped = true; }

  /** An emit notice from `handle`'s kernel: acted on by its name. */
  deliver(handle: string, out: Outgoing): void {
    if (this.stopped) return;
    const m = out.message;
    const p = out.place;
    if (p && m.kind === "event" && typeof m.event === "string") this.o.emitted?.(handle, m, { s: Number(p.s), i: Number(p.i), thread: p.thread });
    if (out.address === "broadcast" && m.kind === "broadcast") {
      if (!this.o.broadcast) { this.say(handle, "broadcast: this host has no Arcade (SKEIN_ARC_URL): dropped"); return; }
      this.o.broadcast(handle, out.body, m.beef instanceof Uint8Array ? m.beef : undefined);
      return;
    }
    if (TOPIC_EVENTS.includes(out.address) && m.kind === "event" && m.event === out.address) {
      if (!this.o.topicEvent) { this.say(handle, `${out.address}: this host has no libp2p node: ignored`); return; }
      this.o.topicEvent(handle, m);
    }
    // Any other event (an app's facts: chain/tx, chain/output, amm/…) is the followers' (emitted): nothing more here.
  }
}

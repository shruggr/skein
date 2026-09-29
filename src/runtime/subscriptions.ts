// Subscriptions (docs/VM.md, "Subscriptions"), read from a store: the routing
// table as one chain per instance, origin
//
//   { kind: "subscriptions" }
//
// (found by encoding it, like a head by its name) and one update per change,
// { op: "add" | "remove", sender?, box, handler, thread?, input, at } (the
// store adds origin, prev, seq). The rules are the updates folded in order:
// `add` appends the rule (sender, box) → handler at the end of the list,
// `remove` deletes it; an add of a rule already listed, or a remove of one that
// is not, changes nothing. An absent sender matches every sender.
//
// The kernel writes the chain (kernel-zig/src/subscriptions.zig): the
// genesis's seed as its first updates (no `thread`), then a change whenever a
// program's step asks for one (the `subscribe` import) and ends without error.
// Here it is only read — by the explorer, and by tests.

import type { CID } from "multiformats/cid";
import { encode } from "./cid.ts";
import type { Identity, Subscription } from "./records.ts";
import { NotFound, type Store } from "./store.ts";
import type { Ms } from "./types.ts";

export type SubscriptionsOrigin = { kind: "subscriptions" };
export type Op = "add" | "remove";
/** A change to the rules. */
export type Rule = { op: Op; sender?: Identity; box: string; handler: CID };
export type SubscriptionUpdate = Rule & { origin: CID; prev: CID; seq: number; thread?: CID; input: CID; at: Ms };

const ORIGIN: SubscriptionsOrigin = { kind: "subscriptions" };

/** The chain's origin: the same CID in every store. */
export const subscriptionsOrigin = (): CID => encode(ORIGIN).cid;

const same = (s: Subscription, r: Rule) => s.match.sender === r.sender && s.match.box === r.box && s.handler.equals(r.handler);

/** The rules after `updates`, in order. */
export function fold(updates: Iterable<Rule>): Subscription[] {
  const out: Subscription[] = [];
  for (const u of updates) {
    const i = out.findIndex((s) => same(s, u));
    if (u.op === "add" && i < 0) out.push({ match: { ...(u.sender ? { sender: u.sender } : {}), box: u.box }, handler: u.handler });
    if (u.op === "remove" && i >= 0) out.splice(i, 1);
  }
  return out;
}

/** The chain's updates, oldest first; undefined if the chain was never opened (no genesis processed, or a store from before it). */
export async function subscriptionUpdates(store: Store): Promise<Array<{ cid: CID; u: SubscriptionUpdate }> | undefined> {
  const origin = subscriptionsOrigin();
  const out: Array<{ cid: CID; u: SubscriptionUpdate }> = [];
  try { await store.chains.tip(origin); } catch (e) { if (e instanceof NotFound) return undefined; throw e; }
  for await (const c of store.chains.history(origin)) if (!c.equals(origin)) out.push({ cid: c, u: await store.get(c) as unknown as SubscriptionUpdate });
  return out;
}

/** The rules now; undefined if the chain was never opened. */
export async function currentSubscriptions(store: Store): Promise<Subscription[] | undefined> {
  const ups = await subscriptionUpdates(store);
  return ups && fold(ups.map((x) => x.u));
}

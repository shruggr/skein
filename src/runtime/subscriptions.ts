// Subscriptions (docs/VM.md, "Subscriptions"): the routing table as one chain
// per instance, origin
//
//   { kind: "subscriptions" }
//
// (found by encoding it, like a head by its name) and one update per change,
// { op: "add" | "remove", sender?, box, handler, thread?, input, at } (the
// store adds origin, prev, seq). The rules are the updates folded in order:
// `add` appends the rule (sender, box) → handler at the end of the list,
// `remove` deletes it; an add of a rule already listed, or a remove of one that
// is not, writes nothing. An absent sender matches every sender.
//
// The genesis's `subscriptions` are only the seed: processing the genesis entry
// writes them as the chain's first updates (no `thread`), and nothing routes
// from the genesis afterwards. After that the chain changes only when a
// program's step says so (the `subscribe` import) and that step ends without
// error; the update names the thread and the log entry, so replay writes the
// same chain. The scheduler routes each envelope by the rules as they stand
// when its entry is processed.

import type { CID } from "multiformats/cid";
import { encode } from "./cid.ts";
import { isIdentity, type Identity, type Subscription } from "./records.ts";
import { NotFound, type Store } from "./store.ts";
import type { Ms } from "./types.ts";

export type SubscriptionsOrigin = { kind: "subscriptions" };
export type Op = "add" | "remove";
/** A change to the rules, as a program asks for it. */
export type Rule = { op: Op; sender?: Identity; box: string; handler: CID };
export type SubscriptionUpdate = Rule & { origin: CID; prev: CID; seq: number; thread?: CID; input: CID; at: Ms };

const ORIGIN: SubscriptionsOrigin = { kind: "subscriptions" };

/** The chain's origin: the same CID in every store. */
export const subscriptionsOrigin = (): CID => encode(ORIGIN).cid;

export const isBox = (x: unknown): x is string => typeof x === "string" && x !== "" && !/[\s\0]/.test(x);

/** Why a rule is malformed, or undefined. */
export function ruleProblem(r: { op?: unknown; sender?: unknown; box?: unknown; handler?: unknown }): string | undefined {
  if (r.op !== "add" && r.op !== "remove") return `op ${JSON.stringify(r.op)} is not add or remove`;
  if (r.sender !== undefined && !isIdentity(r.sender)) return `sender ${JSON.stringify(r.sender)} is not an identity key`;
  if (!isBox(r.box)) return `box ${JSON.stringify(r.box)} is not a box name`;
  if (!r.handler) return "no handler";
  return undefined;
}

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

/** Open the chain (the genesis entry does, even for an empty seed). */
export const openSubscriptions = (store: Store): Promise<CID> => store.chains.open(ORIGIN);

/**
 * Apply `rule` as the step of `thread` (absent: the genesis seed) over log
 * entry `input` at `at`. Returns the update written, or undefined when it
 * changes nothing (an add already listed, a remove not listed).
 */
export async function subscribe(store: Store, rule: Rule, by: { thread?: CID; input: CID; at: Ms }): Promise<CID | undefined> {
  const bad = ruleProblem(rule);
  if (bad) throw new TypeError(`subscribe: ${bad}`);
  const now = (await currentSubscriptions(store)) ?? [];
  const listed = now.some((s) => same(s, rule));
  if (rule.op === "add" ? listed : !listed) return undefined;
  const origin = await openSubscriptions(store);
  return store.chains.append(origin, {
    op: rule.op, ...(rule.sender ? { sender: rule.sender } : {}), box: rule.box, handler: rule.handler,
    ...(by.thread ? { thread: by.thread } : {}), input: by.input, at: by.at,
  });
}

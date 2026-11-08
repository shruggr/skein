// The route table (#77, #143; docs/MESSAGES.md "The dispatch table"), read
// from a store: one of the kernel's tables, the one that routes. Routing only
// (#143: no sender — who may run a function is the grants', kernel-zig
// grants.zig). One chain per instance, origin
//
//   { kind: "dispatch" }
//
// and one update per change, { op: "add" | "remove", row, thread?, input, at }
// (the store adds origin, prev, seq). The routes are the updates folded in
// order: a route's key is (transport, address, prefix); `add` replaces the
// route with that key in place, else appends; `remove` deletes it.
//
//   route  {transport: "mailbox" | "event" | "http" | "libp2p" | "local", address, prefix?: true (any transport, 0.5.1), dynamic?: true (0.5.1: an allowance),
//           filters?: ["kernel.brc104" | "kernel.beef" | "kernel.pay" | "<app>.<filter>"], program?: <cid> | "kernel", fn?, app?, price?,
//           …settings}
//
//   No program: a read route (http only) — its filters answer, nothing is logged. `event` (#143): events
//   are their own transport (the host's wiring into a box), never a message.
//
// The kernel writes the chain and matches by it (kernel-zig/src/dispatch.zig):
// the genesis's `dispatch` as its first updates (no `thread`), then a change
// whenever its `dispatch` operation takes an admin message. Here it is read —
// by the host (the libp2p node's topics, whether an instance takes a box, the
// install client), the explorer, and tests — and matched with the kernel's
// rules: kernel-zig/test/dispatch-cases.json holds the cases both this file
// (dispatch.test.ts) and dispatch.zig are checked against.

import { CID } from "multiformats/cid";
import { encode } from "./cid.ts";
import { NotFound, type Store } from "./store.ts";
import type { Ms } from "./types.ts";

export type DispatchOrigin = { kind: "dispatch" };
export type Op = "add" | "remove";
export type Transport = "mailbox" | "event" | "http" | "libp2p" | "local";
/** A route as the kernel holds it; `program` a program record's CID, "kernel" (an admin operation named by `fn`), or absent (a read route). */
export type DispatchRow = { transport: Transport; address: string; prefix?: boolean; dynamic?: boolean; filters?: string[]; program?: CID | "kernel"; fn?: string; app?: string; [setting: string]: unknown };
export type DispatchUpdate = { op: Op; row: DispatchRow; origin: CID; prev: CID; seq: number; thread?: CID; input: CID; at: Ms };

const ORIGIN: DispatchOrigin = { kind: "dispatch" };

/** The kernel's own filters (kernel-zig door.zig). */
export const KERNEL_FILTERS = ["kernel.brc104", "kernel.beef", "kernel.pay"] as const;

/** The chain's origin: the same CID in every store. */
export const dispatchOrigin = (): CID => encode(ORIGIN).cid;

/**
 * A route's key as text: (transport, address, prefix), space-separated with the word `prefix` for a
 * prefix route. No address has a space, so the texts of two keys are equal only when the keys are
 * (dispatch.zig `sameKey`).
 */
export const rowKey = (r: { transport: string; address: string; prefix?: boolean; dynamic?: boolean }): string => `${r.transport} ${r.address}${r.prefix === true ? " prefix" : ""}${r.dynamic === true ? " dynamic" : ""}`;

const isCid = (x: unknown): boolean => CID.asCID(x) !== null;

/** Whether `s` names a filter (dispatch.zig isFilterRef): one of the kernel's, or `<app>.<filter>`. */
export function isFilterRef(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const dot = s.lastIndexOf(".");
  if (dot <= 0) return false;
  const app = s.slice(0, dot), name = s.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(name) || /[\s\0/]/.test(app)) return false;
  return app === "kernel" ? (KERNEL_FILTERS as readonly string[]).includes(s) : true;
}

/**
 * Whether the kernel's fold keeps `r` (dispatch.zig `rowOf`): a map with a text transport and
 * address, no sender, and a program that is text, a CID, or absent. What the kernel's `problem`
 * refuses never reaches a chain; this is what the fold itself drops.
 */
export function isFoldable(r: unknown): r is DispatchRow {
  if (typeof r !== "object" || r === null || Array.isArray(r) || r instanceof Uint8Array) return false;
  const x = r as Record<string, unknown>;
  if (typeof x.transport !== "string" || typeof x.address !== "string") return false;
  if (x.sender !== undefined) return false;
  if (x.program === undefined) return true;
  return x.program === "kernel" || isCid(x.program);
}

/** Whether a route is a read route (#143): filters only, no handler. */
export const isReadRoute = (r: DispatchRow): boolean => r.program === undefined;

/** The routes after `updates`, in order (dispatch.zig `fold`: an update with no op or a route the kernel does not read is skipped). */
export function fold(updates: Iterable<{ op: Op; row: DispatchRow }>): DispatchRow[] {
  const out: DispatchRow[] = [];
  for (const u of updates) {
    if (typeof u.op !== "string" || !isFoldable(u.row)) continue;
    const i = out.findIndex((r) => rowKey(r) === rowKey(u.row));
    if (u.op === "add") { if (i < 0) out.push(u.row); else out[i] = u.row; }
    if (u.op === "remove" && i >= 0) out.splice(i, 1);
  }
  return out;
}

/** The chain's updates, oldest first; undefined if the chain was never opened (no genesis processed). */
export async function dispatchUpdates(store: Store): Promise<Array<{ cid: CID; u: DispatchUpdate }> | undefined> {
  const origin = dispatchOrigin();
  const out: Array<{ cid: CID; u: DispatchUpdate }> = [];
  try { await store.chains.tip(origin); } catch (e) { if (e instanceof NotFound) return undefined; throw e; }
  for await (const c of store.chains.history(origin)) if (!c.equals(origin)) out.push({ cid: c, u: await store.get(c) as unknown as DispatchUpdate });
  return out;
}

/** The routes now; undefined if the chain was never opened. */
export async function currentDispatch(store: Store): Promise<DispatchRow[] | undefined> {
  const ups = await dispatchUpdates(store);
  return ups && fold(ups.map((x) => x.u));
}

// ---------------------------------------------------------------- the match (dispatch.zig, the same rules)

const found = (rows: DispatchRow[], i: number): { i: number; row: DispatchRow } | undefined => i < 0 ? undefined : { i, row: rows[i]! };

/** Whether `p` is one of `address`'s path-segment prefixes (dispatch.zig `prefixes`): the whole address, or before or after a `/`. */
export const atSegment = (address: string, p: string): boolean => p.length > 0 && address.startsWith(p) && (p.length === address.length || address[p.length] === "/" || p.endsWith("/"));

/**
 * The route `transport`/`address` takes (dispatch.zig forRows, 0.5.1 — the one rule): the exact
 * address first (for a box, `mailbox` and `event`, then `*`), then the longest prefix at a path
 * segment; an allowance (`dynamic`) takes nothing.
 */
export function forRows(rows: DispatchRow[], transport: string, address: string): { i: number; row: DispatchRow } | undefined {
  const live = (r: DispatchRow) => r.transport === transport && r.dynamic !== true;
  const exact = rows.findIndex((r) => live(r) && r.prefix !== true && r.address === address);
  if (exact >= 0) return found(rows, exact);
  if (transport === "mailbox" || transport === "event") {
    const any = rows.findIndex((r) => live(r) && r.prefix !== true && r.address === "*");
    if (any >= 0) return found(rows, any);
  }
  let best = -1;
  rows.forEach((r, i) => {
    if (!live(r) || r.prefix !== true || !atSegment(address, r.address)) return;
    if (best < 0 || r.address.length > rows[best]!.address.length) best = i;
  });
  return found(rows, best);
}

/** Whether a mailbox route takes a message in `box`. */
export const takesMail = (r: DispatchRow, box: string): boolean => forRows([r], "mailbox", box) !== undefined;

/** Whether an event route takes an event in `box` (an event's name). */
export const takesEvent = (r: DispatchRow, box: string): boolean => forRows([r], "event", box) !== undefined;

export const forMail = (rows: DispatchRow[], box: string) => forRows(rows, "mailbox", box);
export const forEvent = (rows: DispatchRow[], box: string) => forRows(rows, "event", box);
export const forHttp = (rows: DispatchRow[], path: string) => forRows(rows, "http", path);
export const forLibp2p = (rows: DispatchRow[], name: string) => forRows(rows, "libp2p", name);

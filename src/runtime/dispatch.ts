// The dispatch table (#77, format 8; docs/MESSAGES.md "The dispatch table"),
// read from a store: one of the kernel's four tables, the one that routes.
// It replaced the subscriptions chain, the genesis's `routes` and the head
// `routes`: a route, a subscription and a libp2p topic or protocol differ
// only in where the address comes from. One chain per instance, origin
//
//   { kind: "dispatch" }
//
// and one update per change, { op: "add" | "remove", row, thread?, input, at }
// (the store adds origin, prev, seq). The rows are the updates folded in
// order: a row's key is (transport, address, prefix, sender); `add` replaces
// the row with that key in place, else appends; `remove` deletes it. First
// match wins, in table order.
//
//   row  {transport: "mailbox" | "http" | "libp2p" | "local", address, prefix?: true,
//         sender: "*" | "event" | "session" | bytes(33), program: <cid> | "kernel", fn?, …settings}
//
//   sender "event" (#79): the row takes events only (a feed's header, a broadcaster's proof, a route's
//   admit), never a message — the host's wiring into a box, not an open box.
//
// The kernel writes the chain (kernel-zig/src/dispatch.zig): the genesis's
// `dispatch` as its first updates (no `thread`), then a change whenever its
// `dispatch` operation takes an admin message. Here it is only read — by the
// host (the libp2p node's topics, whether an instance takes a box, the
// install client), the explorer, and tests.

import type { CID } from "multiformats/cid";
import { encode } from "./cid.ts";
import { NotFound, type Store } from "./store.ts";
import type { Ms } from "./types.ts";

export type DispatchOrigin = { kind: "dispatch" };
export type Op = "add" | "remove";
export type Transport = "mailbox" | "http" | "libp2p" | "local";
export type Sender = "*" | "event" | "session" | Uint8Array;
/** A row as the kernel holds it; `program` a program record's CID, or "kernel" (an admin operation named by `fn`). */
export type DispatchRow = { transport: Transport; address: string; prefix?: boolean; sender: Sender; program: CID | "kernel"; fn?: string; [setting: string]: unknown };
export type DispatchUpdate = { op: Op; row: DispatchRow; origin: CID; prev: CID; seq: number; thread?: CID; input: CID; at: Ms };

const ORIGIN: DispatchOrigin = { kind: "dispatch" };

/** The chain's origin: the same CID in every store. */
export const dispatchOrigin = (): CID => encode(ORIGIN).cid;

/** A sender as text: `*`, `session`, or the key in hex (the index-store reader already shows a 33-byte `sender` as hex). */
export const senderText = (s: Sender | undefined): string => s === undefined ? "*" : typeof s === "string" ? s : Buffer.from(s).toString("hex");

/** A sender as the kernel's row carries it: `*`, `session`, or the key's 33 bytes (hex text from the reader turned back). */
export const senderBytes = (s: Sender | string): Sender => typeof s === "string" && /^0[23][0-9a-f]{64}$/.test(s) ? Uint8Array.from(Buffer.from(s, "hex")) : s as Sender;

/** A row's key: (transport, address, prefix, sender). */
export const rowKey = (r: { transport: string; address: string; prefix?: boolean; sender?: Sender }): string => `${r.transport} ${r.address}${r.prefix ? "*" : ""} ${senderText(r.sender)}`;

/** The rows after `updates`, in order. */
export function fold(updates: Iterable<{ op: Op; row: DispatchRow }>): DispatchRow[] {
  const out: DispatchRow[] = [];
  for (const u of updates) {
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

/** The rows now; undefined if the chain was never opened. */
export async function currentDispatch(store: Store): Promise<DispatchRow[] | undefined> {
  const ups = await dispatchUpdates(store);
  return ups && fold(ups.map((x) => x.u));
}

/** Whether a mailbox row takes a message from `sender` (hex) in `box`: the kernel's rule (dispatch.zig forMail). */
export function takesMail(r: DispatchRow, sender: string, box: string): boolean {
  if (r.transport !== "mailbox" || (r.address !== "*" && r.address !== box)) return false;
  if (r.sender === "*") return true;
  if (r.sender === "session" || r.sender === "event") return false;
  return senderText(r.sender) === sender;
}

/** Whether a mailbox row takes an event (no sender) in `box` (dispatch.zig forEvent). */
export const takesEvent = (r: DispatchRow, box: string): boolean => r.transport === "mailbox" && (r.sender === "*" || r.sender === "event") && (r.address === "*" || r.address === box);

/** The first row a message from `sender` (hex) in `box` routes to, with its index, or undefined. */
export function forMail(rows: DispatchRow[], sender: string, box: string): { i: number; row: DispatchRow } | undefined {
  const i = rows.findIndex((r) => takesMail(r, sender, box));
  return i < 0 ? undefined : { i, row: rows[i]! };
}

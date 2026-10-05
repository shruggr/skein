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
// match wins, in table order, for every transport (#115).
//
//   row  {transport: "mailbox" | "http" | "libp2p" | "local", address, prefix?: true (http; a libp2p topic, #119),
//         sender: "*" | "event" | "session" | "owner" | bytes(33), program: <cid> | "kernel", fn?, …settings}
//
//   sender "event" (#79): the row takes events only (a feed's header, a broadcaster's proof, a route's
//   admit), never a message — the host's wiring into a box, not an open box. "owner" (#115, http):
//   the instance's owner's session (the genesis's owner, else the claim's) — #121: gone; nothing writes it, and a row a log
//   already holds with it is still read so (every sender is a key: the claim writes the owner's explorer row).
//   `filter?: "beef"` (#121): what the kernel's door runs on a package before its entry is written.
//
// The kernel writes the chain and matches by it (kernel-zig/src/dispatch.zig):
// the genesis's `dispatch` as its first updates (no `thread`), then a change
// whenever its `dispatch` operation takes an admin message. Here it is read —
// by the host (the libp2p node's topics, whether an instance takes a box, the
// install client), the explorer, and tests — and matched with the kernel's
// rules, the same walk: kernel-zig/test/dispatch-cases.json holds the cases
// both this file (dispatch.test.ts) and dispatch.zig are checked against.

import { CID } from "multiformats/cid";
import { encode } from "./cid.ts";
import { NotFound, type Store } from "./store.ts";
import type { Ms } from "./types.ts";

export type DispatchOrigin = { kind: "dispatch" };
export type Op = "add" | "remove";
export type Transport = "mailbox" | "http" | "libp2p" | "local";
export type Sender = "*" | "event" | "session" | "owner" | Uint8Array;
/** A row as the kernel holds it; `program` a program record's CID, or "kernel" (an admin operation named by `fn`). */
export type DispatchRow = { transport: Transport; address: string; prefix?: boolean; sender: Sender; program: CID | "kernel"; fn?: string; [setting: string]: unknown };
export type DispatchUpdate = { op: Op; row: DispatchRow; origin: CID; prev: CID; seq: number; thread?: CID; input: CID; at: Ms };

const ORIGIN: DispatchOrigin = { kind: "dispatch" };

/** The chain's origin: the same CID in every store. */
export const dispatchOrigin = (): CID => encode(ORIGIN).cid;

/** A sender as text: `*`, `event`, `session`, `owner`, or the key in hex (the index-store reader already shows a 33-byte `sender` as hex). */
export const senderText = (s: Sender | undefined): string => s === undefined ? "*" : typeof s === "string" ? s : Buffer.from(s).toString("hex");

/** A sender as the kernel's row carries it: `*`, `session`, or the key's 33 bytes (hex text from the reader turned back). */
export const senderBytes = (s: Sender | string): Sender => typeof s === "string" && /^0[23][0-9a-f]{64}$/.test(s) ? Uint8Array.from(Buffer.from(s, "hex")) : s as Sender;

/**
 * A row's key as text: (transport, address, prefix, sender), space-separated
 * with the word `prefix` for a prefix row. No address has a space, so the
 * texts of two keys are equal only when the keys are (dispatch.zig
 * `sameKey`; before #115 a `*` suffix made "/x*" collide with the prefix "/x").
 */
export const rowKey = (r: { transport: string; address: string; prefix?: boolean; sender?: Sender }): string => `${r.transport} ${r.address}${r.prefix === true ? " prefix" : ""} ${senderText(r.sender)}`;

const isKey = (b: unknown): b is Uint8Array => b instanceof Uint8Array && b.length === 33 && (b[0] === 2 || b[0] === 3);

/** A row's sender as the kernel reads it (dispatch.zig senderOf), or undefined: not a row. A key may be hex: the index-store reader's form. */
function senderOf(s: unknown): Sender | string | undefined {
  if (s === "*" || s === "event" || s === "session" || s === "owner") return s;
  if (typeof s === "string") return /^0[23][0-9a-f]{64}$/.test(s) ? s : undefined;
  return isKey(s) ? s : undefined;
}

const isCid = (x: unknown): boolean => CID.asCID(x) !== null;

/**
 * Whether the kernel's fold keeps `r` (dispatch.zig `rowOf`): a map with a
 * text transport and address, a sender it reads, and a program that is text
 * or a CID. What the kernel's `problem` refuses never reaches a chain; this
 * is what the fold itself drops.
 */
export function isFoldable(r: unknown): r is DispatchRow {
  if (typeof r !== "object" || r === null || Array.isArray(r) || r instanceof Uint8Array) return false;
  const x = r as Record<string, unknown>;
  if (typeof x.transport !== "string" || typeof x.address !== "string") return false;
  if (senderOf(x.sender) === undefined) return false;
  return typeof x.program === "string" || isCid(x.program);
}

/** The rows after `updates`, in order (dispatch.zig `fold`: an update with no op or a row the kernel does not read is skipped). */
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

/** The rows now; undefined if the chain was never opened. */
export async function currentDispatch(store: Store): Promise<DispatchRow[] | undefined> {
  const ups = await dispatchUpdates(store);
  return ups && fold(ups.map((x) => x.u));
}

// ---------------------------------------------------------------- the match (#115; dispatch.zig, the same walk)

/** Who a package is from (dispatch.zig `Who`): keys in hex. */
export interface Who {
  /** The sender's identity: a message's, the identity an HTTP request claims, a libp2p peer's; none: no session. */
  key?: string;
  /** An event (no sender): only a `*` or an `event` row takes it. */
  event?: boolean;
  /** The instance's owner, for an `owner` row. */
  owner?: string;
  /** The genesis's `reads` (a log before #115): a row with a `read` op takes only a sender they allow. */
  reads?: Array<{ caller?: Uint8Array; owner?: boolean; op?: string }>;
}

/** Whether `r`'s sender rule takes `w` (dispatch.zig `takes`). */
export function takes(r: DispatchRow, w: Who): boolean {
  const s = r.sender;
  if (s === "*") return true;
  const http = r.transport === "http";
  const ok = s === "event" ? w.event === true
    : w.event || w.key === undefined ? false
    : s === "session" ? http
    : s === "owner" ? http && w.owner !== undefined && w.key === w.owner
    : senderText(s) === w.key;
  if (!ok) return false;
  if (http && typeof r.read === "string") return mayRead(w, r.read);
  return true;
}

function mayRead(w: Who, op: string): boolean {
  if (!w.reads || w.key === undefined) return false;
  for (const r of w.reads) {
    if (r.op !== op && r.op !== "*") continue;
    if (r.owner === true) { if (w.owner !== undefined && w.owner === w.key) return true; continue; }
    if (!(r.caller instanceof Uint8Array)) return true;
    if (senderText(r.caller) === w.key) return true;
  }
  return false;
}

type Address = { box: string } | { exact: string } | { prefix: string; len: number };

function addressed(r: DispatchRow, at: Address): boolean {
  if ("box" in at) return r.address === "*" || r.address === at.box;
  if ("exact" in at) return r.prefix !== true && r.address === at.exact;
  return r.prefix === true && r.address.length === at.len && at.prefix.startsWith(r.address);
}

/** The walk: the first row in table order of `transport` at `at` whose sender rule takes `w`, with its index. */
function first(rows: DispatchRow[], transport: string, at: Address, w: Who): { i: number; addressed: boolean } {
  let seen = false;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.transport !== transport || !addressed(r, at)) continue;
    seen = true;
    if (takes(r, w)) return { i, addressed: true };
  }
  return { i: -1, addressed: seen };
}

const found = (rows: DispatchRow[], i: number): { i: number; row: DispatchRow } | undefined => i < 0 ? undefined : { i, row: rows[i]! };

/** Whether a mailbox row takes a message from `sender` (hex) in `box`: the kernel's rule (dispatch.zig forMail). */
export const takesMail = (r: DispatchRow, sender: string, box: string): boolean => r.transport === "mailbox" && addressed(r, { box }) && takes(r, { key: sender });

/** Whether a mailbox row takes an event (no sender) in `box` (dispatch.zig forEvent). */
export const takesEvent = (r: DispatchRow, box: string): boolean => r.transport === "mailbox" && addressed(r, { box }) && takes(r, { event: true });

/** The first row a message from `sender` (hex) in `box` routes to, with its index, or undefined (dispatch.zig forMail). */
export const forMail = (rows: DispatchRow[], sender: string, box: string) => found(rows, first(rows, "mailbox", { box }, { key: sender }).i);

/** The first row an event in `box` routes to (dispatch.zig forEvent). */
export const forEvent = (rows: DispatchRow[], box: string) => found(rows, first(rows, "mailbox", { box }, { event: true }).i);

/** Why no http row takes a request (dispatch.zig Refusal): no row at the path (404), a row needs a session and none is claimed (401), none takes the identity (403). */
export type Refusal = "path" | "session" | "sender";

/** Exact rows first, then prefix rows, longest first; within each, first in table order whose sender takes `w` (dispatch.zig exactThenPrefix). */
function exactThenPrefix(rows: DispatchRow[], transport: string, path: string, w: Who): { i: number; addressed: boolean } {
  const ex = first(rows, transport, { exact: path }, w);
  if (ex.i >= 0) return ex;
  let any = ex.addressed;
  const lens = [...new Set(rows.filter((r) => r.transport === transport && r.prefix === true && path.startsWith(r.address)).map((r) => r.address.length))].sort((x, y) => y - x);
  for (const len of lens) {
    const p = first(rows, transport, { prefix: path, len }, w);
    if (p.i >= 0) return p;
    any ||= p.addressed;
  }
  return { i: -1, addressed: any };
}

/** A request's http row (dispatch.zig forHttp): exact paths first, then prefixes, longest first; within each, first in table order whose sender takes `w`. */
export function forHttp(rows: DispatchRow[], path: string, w: Who): { i: number; row: DispatchRow } | { refused: Refusal } {
  const m = exactThenPrefix(rows, "http", path, w);
  if (m.i >= 0) return found(rows, m.i)!;
  return { refused: !m.addressed ? "path" : w.key === undefined ? "session" : "sender" };
}

/**
 * A libp2p package's row (dispatch.zig forLibp2p): a topic as an http path is
 * matched (#119: exact rows, then `prefix` rows, longest first — one `tm_` row
 * takes every `tm_<txid>`), a `/<protocol>` exactly; within each, the first
 * `libp2p` row whose sender takes the peer's key.
 */
export const forLibp2p = (rows: DispatchRow[], name: string, w: Who) =>
  found(rows, name.startsWith("/") ? first(rows, "libp2p", { exact: name }, w).i : exactThenPrefix(rows, "libp2p", name, w).i);

// The route table (skein next, SPEC.md section 3; kernel-zig/src/dispatch.zig is authoritative),
// read from a store: one of the kernel's tables, the one that routes. One chain per instance,
// origin
//
//   { kind: "dispatch" }
//
// and one update per change, { op: "add" | "remove", row, thread?, input, at } (the store adds
// origin, prev, seq). The rows are the updates folded in order: `add` replaces the row with that key
// in place, else appends; `remove` deletes it.
//
//   row  {kind: "request" | "read", path, prefix?: true, role: anyone | user | root | <app>.<role>,
//         checks?: ["<app>.<fn>"], recheck?: "<app>.<fn>", handler: "<app>.<fn>" | "kernel.<op>", …settings}
//      | {kind: "event", name, checks?, recheck?, handler: "<app>.<fn>", …settings}           (no role)
//
//   key  (path, prefix) for request and read rows together (one path, one row); `name` for events.
//
// No transport, no filters, no program CIDs, no `app` field: the app whose function handles a row
// is its handler's first name. Here the table is read — by the host (whether an instance takes the
// chain pointer event; the install client) and tests — and matched with the kernel's rules.

import { encode } from "./cid.ts";
import { NotFound, type Store } from "./store.ts";
import type { Ms } from "./types.ts";

export type DispatchOrigin = { kind: "dispatch" };
export type Op = "add" | "remove";
export type RowKind = "request" | "read" | "event";
/** A row as the kernel holds it. */
export type DispatchRow = {
  kind: RowKind;
  path?: string;
  name?: string;
  prefix?: boolean;
  role?: string;
  checks?: string[];
  recheck?: string;
  handler: string;
  [setting: string]: unknown;
};
export type DispatchUpdate = { op: Op; row: DispatchRow; origin: unknown; prev: unknown; seq: number; thread?: unknown; input: unknown; at: Ms };

const ORIGIN: DispatchOrigin = { kind: "dispatch" };

/** The kernel's operations a request row's handler may name (`kernel.<op>`, dispatch.zig kernel_ops). */
export const KERNEL_OPS = ["objects", "head", "route", "grant", "claim"] as const;
export type KernelOp = typeof KERNEL_OPS[number];

/** The chain's origin: the same CID in every store. */
export const dispatchOrigin = () => encode(ORIGIN).cid;

/** A row's key as text (dispatch.zig): `path <path>[ prefix]` for request and read rows, `event <name>` for event rows. */
export const rowKey = (r: { kind?: string; path?: unknown; name?: unknown; prefix?: unknown }): string =>
  r.kind === "event" ? `event ${String(r.name)}` : `path ${String(r.path)}${r.prefix === true ? " prefix" : ""}`;

/** The app whose function a row's handler names ("<app>.<fn>"), or undefined for a kernel row. */
export function rowApp(r: { handler?: unknown }): string | undefined {
  if (typeof r.handler !== "string") return undefined;
  const dot = r.handler.indexOf(".");
  const app = dot > 0 ? r.handler.slice(0, dot) : undefined;
  return app === "kernel" ? undefined : app;
}

const NAME = /^[a-z0-9][a-z0-9_-]*$/;
const PART = /^[A-Za-z0-9_-]+$/;
const isBox = (s: unknown): s is string => typeof s === "string" && s.length > 0 && !/[\s\0]/.test(s);

/** Whether `s` is a function reference "<app>.<fn>" or "<app>.<role>.<fn>" (dispatch.zig fnRef). */
export function isFnRef(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const parts = s.split(".");
  return parts.length >= 2 && parts.length <= 3 && NAME.test(parts[0]!) && parts.slice(1).every((p) => PART.test(p));
}

/** Whether `s` is a role a row may name: anyone, user, root, or <app>.<role>. */
export function isRowRole(s: unknown): s is string {
  if (s === "anyone" || s === "user" || s === "root") return true;
  if (typeof s !== "string") return false;
  const dot = s.indexOf(".");
  return dot > 0 && NAME.test(s.slice(0, dot)) && NAME.test(s.slice(dot + 1));
}

const GONE = ["transport", "address", "filters", "filter", "program", "fn", "sender", "app"];

/** Why `r` is not a row (dispatch.zig `problem`, the same rules), or undefined. */
export function rowProblem(r: unknown): string | undefined {
  if (!r || typeof r !== "object" || Array.isArray(r) || r instanceof Uint8Array) return "a row is a map {kind, path | name, role, checks?, recheck?, handler, …}";
  const x = r as Record<string, unknown>;
  if (x.kind !== "request" && x.kind !== "read" && x.kind !== "event") return "kind: want request, event or read";
  for (const k of GONE) if (x[k] !== undefined) return `${k}: a row has none (skein next: rows by kind, a handler "<app>.<fn>", checks)`;
  if (x.kind === "event") {
    if (!isBox(x.name)) return "name: an event row names the event it takes";
    if (x.path !== undefined || x.prefix !== undefined) return "path, prefix: an event row is matched by its name";
    if (x.role !== undefined) return "role: an event row names none (an event has no principal)";
  } else {
    if (!isBox(x.path)) return "path: a request or read row names the path it takes";
    if (x.name !== undefined) return "name: a request or read row is matched by its path";
    if (x.prefix !== undefined && typeof x.prefix !== "boolean") return "prefix: true or absent";
    if (x.role === undefined) return "role: every request and read row names its role (anyone, user, root or <app>.<role>): nothing is open by omission";
    if (!isRowRole(x.role)) return `role ${JSON.stringify(x.role)}: anyone, user, root or <app>.<role>`;
  }
  if (x.checks !== undefined && (!Array.isArray(x.checks) || !x.checks.every(isFnRef))) return "checks: a list of \"<app>.<fn>\"";
  if (x.recheck !== undefined && !isFnRef(x.recheck)) return "recheck: \"<app>.<fn>\"";
  if (typeof x.handler !== "string") return "handler: \"<app>.<fn>\" or \"kernel.<op>\"";
  if (x.handler.startsWith("kernel.")) {
    const op = x.handler.slice("kernel.".length);
    if (!(KERNEL_OPS as readonly string[]).includes(op)) return `handler ${x.handler}: the kernel's operations are ${KERNEL_OPS.join(", ")}`;
    if (x.kind !== "request") return `handler ${x.handler}: a kernel operation is a request row's`;
    if (x.checks !== undefined || x.recheck !== undefined) return `handler ${x.handler}: a kernel row has no checks`;
    if (op === "claim" ? x.role !== "user" : x.role !== "root") return `handler ${x.handler}: role ${op === "claim" ? "user" : "root"}`;
  } else if (!isFnRef(x.handler)) return `handler ${JSON.stringify(x.handler)}: "<app>.<fn>" or "kernel.<op>"`;
  if (x.kind === "read" && (x.checks !== undefined || x.recheck !== undefined)) return "a read row has no checks or recheck";
  if (x.kind === "request" && x.role === "anyone" && !(Array.isArray(x.checks) && x.checks.length)) return "a request row naming role anyone names at least one check (a content-proven row)";
  return undefined;
}

/** The rows after `updates`, in order (dispatch.zig `fold`: an update with no op or no row map is skipped). */
export function fold(updates: Iterable<{ op: Op; row: DispatchRow }>): DispatchRow[] {
  const out: DispatchRow[] = [];
  for (const u of updates) {
    if (typeof u.op !== "string" || !u.row || typeof u.row !== "object") continue;
    const i = out.findIndex((r) => rowKey(r) === rowKey(u.row));
    if (u.op === "add") { if (i < 0) out.push(u.row); else out[i] = u.row; }
    if (u.op === "remove" && i >= 0) out.splice(i, 1);
  }
  return out;
}

/** The chain's updates, oldest first; undefined if the chain was never opened (no genesis processed). */
export async function dispatchUpdates(store: Store): Promise<Array<{ cid: unknown; u: DispatchUpdate }> | undefined> {
  const origin = dispatchOrigin();
  const out: Array<{ cid: unknown; u: DispatchUpdate }> = [];
  try { await store.chains.tip(origin); } catch (e) { if (e instanceof NotFound) return undefined; throw e; }
  for await (const c of store.chains.history(origin)) if (!c.equals(origin)) out.push({ cid: c, u: await store.get(c) as unknown as DispatchUpdate });
  return out;
}

/** The rows now; undefined if the chain was never opened. */
export async function currentDispatch(store: Store): Promise<DispatchRow[] | undefined> {
  const ups = await dispatchUpdates(store);
  return ups && fold(ups.map((x) => x.u));
}

/** Whether the table has an event row taking `name` (the chain pointer event: `chain`). */
export const takesEvent = (rows: DispatchRow[], name: string): boolean => rows.some((r) => r.kind === "event" && r.name === name);

/** A request's row (dispatch.zig match): the exact path first, then the longest prefix the path starts with; request and read rows together. */
export function forPath(rows: DispatchRow[], path: string): DispatchRow | undefined {
  const exact = rows.find((r) => r.kind !== "event" && r.prefix !== true && r.path === path);
  if (exact) return exact;
  let best: DispatchRow | undefined;
  for (const r of rows) {
    if (r.kind === "event" || r.prefix !== true || typeof r.path !== "string" || !path.startsWith(r.path)) continue;
    if (!best || r.path.length > String(best.path).length) best = r;
  }
  return best;
}

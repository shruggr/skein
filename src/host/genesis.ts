// Format 2 (issue #33) on the router's side: the genesis a new instance's log
// starts with, and unsigned entries.
//
//   entry    {kind: "log", prev, n, time, genesis | envelope+box+body | wake | outcome}   — no `sig`: no host key
//   genesis  {kind: "genesis", identity: bytes(33), owner: bytes(33), handle, domain, programs,
//             subscriptions: [{match: {sender?: bytes(33), box}, handler}], peers?: {role: bytes(33)},   (last: `:mail` → messagebox)
//             defaults, names?: [{identityKey: bytes(33), handle, domain}], collect, tree?,
//             feeds?: [{kind: "headers", url, box?} | {kind: "arc-callback", box?, token?}]}
//            (`feeds`: what the router holds for the instance, feeds.ts; `:auth` → the
//            messagebox program keeps its BRC-103/104 sessions, auth.ts)
//
// The stamp is the router's clock at admission (#10): the sequence is the
// order. A genesis is written from a **system** (issue #4, docs/BOOTSTRAP.md):
// the programs, the subscriptions, the config — read from a system tree by
// the loader (boot.ts), which then also names the tree (`tree`: `main` starts
// there), or, for an instance with no tree, the stock system in code
// (codeSystem: the kernel's own pinned programs and STOCK_SUBSCRIPTIONS). The
// same `genesisRecord` writes both.

import type { CID } from "multiformats/cid";
import { parse as parseCid } from "../runtime/cid.ts";
import { DEFAULTS, nextEntry, type EntryBody } from "../runtime/log.ts";
import { Rejected } from "../runtime/store.ts";
import type { Stamp } from "../runtime/syscalls.ts";
import { now as clockNow } from "./entry.ts";
import type { Kernel } from "./kernel.ts";
import type { FeedSpec } from "./feeds.ts";

/** Session expiry (#33 part 2): the instance's own policy, judged by entry stamps (a day). */
export const SESSION_DEFAULTS: Record<string, string> = { sessionTtlMs: "86400000" };

export const keyBytes = (hex: string): Uint8Array => {
  if (!/^0[23][0-9a-f]{64}$/.test(hex)) throw new TypeError(`not an identity key: ${hex}`);
  return Uint8Array.from(Buffer.from(hex, "hex"));
};
export const keyHex = (k: unknown): string => k instanceof Uint8Array ? Buffer.from(k).toString("hex") : String(k);

type Named = { handle: string; domain: string };

/** What the host brings to a genesis: the instance's own facts and the parties it knows. */
export interface Genesis2Config {
  identity: string;
  owner: string;
  handle: string;
  domain: string;
  infer?: string;
  ownerHandle?: Named;
  inferHandle?: Named;
  /**
   * The host's defaults. Code genesis: over DEFAULTS, whole. A system tree:
   * only what the tree's config leaves unset (its behaviour comes from its tree).
   */
  defaults?: Record<string, string>;
  /** Explicit host overrides (dev: SKEIN_FUEL_PER_STEP) that win even over a tree's config; `warn` says so when they do. */
  overrides?: Record<string, string>;
  warn?(line: string): void;
  /** Anyone may open a `chat` (default true): the seed after the owner's boxes (code genesis only). */
  openChat?: boolean;
  /** More seed subscriptions, after these (e.g. the wallet's boxes, #29): a sender (hex) or none, a box, a handler program record. */
  subscriptions?: Array<{ sender?: string; box: string; handler: CID }>;
  /** The front door's routes and reads for code genesis (#40; default STOCK_ROUTES, none). */
  routes?: RouteSpec[];
  reads?: ReadSpec[];
  /** Feeds the router holds for the instance (code genesis; a tree's config names its own). */
  feeds?: FeedSpec[];
}

/**
 * A subscription as a system tree writes it (etc/subscriptions.json): the
 * sender is an identity key in hex, `$owner` / `$infer` (the host's), or
 * absent (anyone); the handler a program name (bin/<name>, or `shell`) or a
 * program record's CID.
 */
export interface SubscriptionSpec { sender?: string; box: string; handler: string }

/** The stock seed (what code genesis has always written): the owner's boxes, chat from anyone, the messagebox. */
export const STOCK_SUBSCRIPTIONS: SubscriptionSpec[] = [
  { sender: "$owner", box: "run", handler: "run-handler" },
  { sender: "$owner", box: "objects", handler: "objects-handler" },
  { sender: "$owner", box: "head", handler: "head-handler" },
  { sender: "$owner", box: "chat", handler: "loop" },
  { sender: "$owner", box: "subscribe", handler: "subscribe-handler" },
  { box: "chat", handler: "loop" },
  { box: ":mail", handler: "messagebox" },
  { box: ":auth", handler: "messagebox" },
  { box: ":sessions", handler: "frontdoor" },
];

/**
 * A front-door route as a system writes it (etc/routes.json, #40): an exact
 * `path` or a `prefix`, the handler program (a bin/ name or a CID) and its
 * function; `auth: "none"` for an open route; `read` an op the reads table
 * must allow the caller.
 */
export interface RouteSpec { path?: string; prefix?: string; program: string; fn: string; auth?: "none"; read?: string }
/** A read permission as a system writes it (etc/reads.json): a caller (hex or `$owner`; absent: anyone) may call routes marked `read: op`. */
export interface ReadSpec { caller?: string; op: string }

/** The stock routes: nothing yet (the messagebox's come with its rewrite). */
export const STOCK_ROUTES: RouteSpec[] = [];

/** A system's config (etc/config.json): every field optional; keys in hex or `$owner`/`$infer`. */
export interface ConfigSpec {
  defaults?: Record<string, string>;
  peers?: Record<string, string>;
  names?: Array<{ identityKey: string; handle: string; domain: string }>;
  collect?: string[];
  feeds?: FeedSpec[];
}

/** A system resolved for one instance: what its genesis says besides who it is. */
export interface System {
  programs: Record<string, CID>;
  subscriptions: Array<{ match: { sender?: Uint8Array; box: string }; handler: CID }>;
  peers?: Record<string, Uint8Array>;
  defaults: Record<string, string>;
  names: Array<{ identityKey: Uint8Array; handle: string; domain: string }>;
  collect: string[];
  /** The system tree (a git tree CID): `main` starts there. */
  tree?: CID;
  feeds?: FeedSpec[];
  /** The front door's routes and reads (#40). */
  routes: Array<{ path?: string; prefix?: string; program: CID; fn: string; auth?: "none"; read?: string }>;
  reads: Array<{ caller?: Uint8Array; op: string }>;
}

/** Routes and reads resolved for one instance: handler names to program CIDs (a route to a program this system lacks is dropped), `$owner` to its key. */
export function resolveRoutes(c: Pick<Genesis2Config, "owner" | "infer">, programs: Record<string, CID>, routes: RouteSpec[], reads: ReadSpec[] = []): Pick<System, "routes" | "reads"> {
  const out: System["routes"] = [];
  for (const r of routes) {
    if (!r || typeof r.fn !== "string" || typeof r.program !== "string" || (typeof r.path === "string") === (typeof r.prefix === "string")) {
      throw new Error(`etc/routes.json: bad route ${JSON.stringify(r)} (want {path | prefix, program, fn, auth?, read?})`);
    }
    let program = programs[r.program];
    if (!program) { try { program = parseCid(r.program); } catch { continue; } }
    out.push({ ...(r.path !== undefined ? { path: r.path } : { prefix: r.prefix! }), program, fn: r.fn, ...(r.auth === "none" ? { auth: "none" as const } : {}), ...(r.read ? { read: r.read } : {}) });
  }
  const rs: System["reads"] = [];
  for (const r of reads) {
    if (!r || typeof r.op !== "string") throw new Error(`etc/reads.json: bad entry ${JSON.stringify(r)} (want {caller?, op})`);
    rs.push({ ...(r.caller && r.caller !== "*" ? { caller: keyOf(r.caller, c) } : {}), op: r.op });
  }
  return { routes: out, reads: rs };
}

/** A key as a system writes it: hex, or `$owner` / `$infer` (the host's). */
export function keyOf(s: string, c: Pick<Genesis2Config, "owner" | "infer">): Uint8Array {
  if (s === "$owner") return keyBytes(c.owner);
  if (s === "$infer") {
    if (!c.infer) throw new Error("the system names $infer, and this host has no inference peer (SKEIN_INFER)");
    return keyBytes(c.infer);
  }
  return keyBytes(s);
}

/** Resolve a system's subscriptions, config and programs for one instance (both genesis paths). */
export function resolveSystem(c: Genesis2Config, programs: Record<string, CID>, subs: SubscriptionSpec[], config: ConfigSpec = {}, tree?: CID, routes: RouteSpec[] = STOCK_ROUTES, reads: ReadSpec[] = []): System {
  const handler = (h: string): CID => {
    const p = programs[h];
    if (p) return p;
    try { return parseCid(h); } catch { throw new Error(`subscription handler ${JSON.stringify(h)}: no such program (bin/${h}.wasm or bin/${h}.cid) and not a CID`); }
  };
  const subscriptions = [
    ...subs.map((s) => ({ match: { ...(s.sender ? { sender: keyOf(s.sender, c) } : {}), box: s.box }, handler: handler(s.handler) })),
    ...(c.subscriptions ?? []).map((x) => ({ match: { ...(x.sender ? { sender: keyBytes(x.sender) } : {}), box: x.box }, handler: x.handler })),
  ];
  let names = [{ identityKey: keyBytes(c.owner), ...(c.ownerHandle ?? { handle: "david", domain: "localhost" }) }];
  if (c.infer) names.push({ identityKey: keyBytes(c.infer), ...(c.inferHandle ?? { handle: "infer", domain: "localhost" }) });
  if (config.names) names = config.names.map((n) => ({ identityKey: keyOf(n.identityKey, c), handle: n.handle, domain: n.domain }));
  const peers = config.peers
    ? Object.fromEntries(Object.entries(config.peers).map(([role, k]) => [role, keyOf(k, c)]))
    : c.infer ? { infer: keyBytes(c.infer) } : undefined;
  return {
    programs, subscriptions, ...(peers ? { peers } : {}),
    defaults: mergeDefaults(c, config.defaults),
    names, collect: config.collect ?? ["completions"], ...(tree ? { tree } : {}),
    ...(feedsIn(config.feeds ?? c.feeds)),
    ...resolveRoutes(c, programs, routes, reads),
  };
}

/** A system's feeds, checked. */
function feedsIn(fs: FeedSpec[] | undefined): { feeds?: FeedSpec[] } {
  if (!fs) return {};
  if (!Array.isArray(fs)) throw new Error("etc/config.json: feeds is a list");
  for (const f of fs) {
    if (f?.kind === "headers" && typeof f.url === "string" && f.url) continue;
    if (f?.kind === "arc-callback") continue;
    throw new Error(`etc/config.json: a feed is {kind: "headers", url, box?} or {kind: "arc-callback", box?, token?}: ${JSON.stringify(f)}`);
  }
  return fs.length ? { feeds: fs } : {};
}

/** DEFAULTS < the host's fill-ins < the tree's config < explicit overrides (warned when they replace a tree value). */
function mergeDefaults(c: Genesis2Config, tree: Record<string, string> = {}): Record<string, string> {
  for (const [k, v] of Object.entries(c.overrides ?? {})) {
    if (tree[k] !== undefined && tree[k] !== v) c.warn?.(`host override: ${k} = ${v} replaces the system tree's ${k} = ${tree[k]}`);
  }
  return { ...DEFAULTS, ...SESSION_DEFAULTS, ...c.defaults, ...tree, ...c.overrides };
}

/** The stock system in code: the kernel's pinned programs (its `programs` frame) and the stock seed. */
export function codeSystem(c: Genesis2Config, programs: Record<string, CID>): System {
  const subs = STOCK_SUBSCRIPTIONS.filter((s) => (s.box !== "chat" || s.sender || c.openChat !== false) && programs[s.handler]);
  // Code genesis has always taken the host's defaults whole (DEFAULTS when none).
  return { ...resolveSystem({ ...c, defaults: undefined, overrides: undefined }, programs, subs, {}, undefined, c.routes ?? STOCK_ROUTES, c.reads ?? []), defaults: { ...SESSION_DEFAULTS, ...(c.defaults ? { ...c.defaults, ...c.overrides } : c.overrides ? { ...DEFAULTS, ...c.overrides } : DEFAULTS) } };
}

/** The genesis record: who the instance is, and its system. */
export function genesisRecord(c: Pick<Genesis2Config, "identity" | "owner" | "handle" | "domain">, s: System): Record<string, unknown> {
  return {
    kind: "genesis", identity: keyBytes(c.identity), handle: c.handle, domain: c.domain, owner: keyBytes(c.owner),
    programs: s.programs, subscriptions: s.subscriptions, ...(s.peers ? { peers: s.peers } : {}),
    defaults: s.defaults, names: s.names, collect: s.collect, ...(s.tree ? { tree: s.tree } : {}), ...(s.feeds ? { feeds: s.feeds } : {}),
    ...(s.routes.length ? { routes: s.routes } : {}), ...(s.reads.length ? { reads: s.reads } : {}),
  };
}

/** The genesis record for a new instance over the kernel's programs (name → program record CID): code genesis. */
export function genesis2(c: Genesis2Config, programs: Record<string, CID>): Record<string, unknown> {
  return genesisRecord(c, codeSystem(c, programs));
}

/** Write a genesis over `s` into an empty store through its kernel; the entry's CID. */
export async function writeSystemGenesis(k: Kernel, c: Genesis2Config, s: System, time: Stamp = clockNow()): Promise<CID> {
  const g = await k.store.put(genesisRecord(c, s) as never);
  return await k.store.log.append(await nextEntry(k.store, { genesis: g }, time) as never);
}

/** Code genesis (the stock system) into an empty store; the entry's CID. */
export async function writeGenesis(k: Kernel, c: Genesis2Config, time: Stamp = clockNow()): Promise<CID> {
  const programs = await k.call("programs") as Record<string, CID>;
  return await writeSystemGenesis(k, c, codeSystem(c, programs), time);
}

/** Admit the next entry over `body` (unsigned), retrying if the tip moved under it. */
export async function admit2(k: Kernel, body: EntryBody, records: { envelope?: object; body?: Uint8Array } = {}, time: Stamp = clockNow()): Promise<CID> {
  for (let tries = 0; ; tries++) {
    try {
      return await k.admit(await nextEntry(k.store, body, time) as never, records);
    } catch (e) {
      if (!(e instanceof Rejected && e.reason === "out-of-order") || tries >= 10) throw e;
    }
  }
}

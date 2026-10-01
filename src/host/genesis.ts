// Format 7 (issues #65, #69: broadcast out an event, no wake entries, no jobs; format 6, #70, #67: emit, the address book seeded; #68: requests appended as received; format 3, #40; format 2, #33: unsigned entries, keys as bytes) on the
// router's side: the genesis a new instance's log starts with, and entries.
//
//   entry    {kind: "log", prev, n, time, genesis | request+transport | mail | event+box}   — no `sig`: no host key
//   genesis  {kind: "genesis", identity: bytes(33), owner: bytes(33), handle, domain, programs,
//             subscriptions: [{match: {sender?: bytes(33), box?}, handler}], peers?: {role: bytes(33)},
//             defaults, names?: [{identityKey: bytes(33), handle, domain}], collect, tree?,
//             feeds?: [{kind: "headers", url, box?}]  (#58: statuses come from the host's broadcaster, arc.ts),
//             routes?: [{path | prefix, program, fn, auth?, read?}], reads?: [{caller?: bytes(33), op}],
//             libp2p?: {topics: [string], protocols: [string], listen?: [multiaddr]},
//             addressBook?: [{key: bytes(33), transport, address, role?, handle?, domain?}]}
//            (`addressBook`, #70: the address book's seed — the host's providers (role = their name: fetch,
//            waker, cron, libp2p, status) and the owner's mailbox — written into the head `peers` at the genesis)
//            (no `jobs`, #69: a schedule is a program's message to the cron provider; a genesis naming
//            them is refused)
//            (`libp2p`, #51: the router's libp2p host runs a node for the instance, subscribes
//            `topics` and serves `protocols`; each message or frame is a front-door call routed
//            by its `libp2p:<topic | protocol>` route)
//            (`feeds`: what the router holds for the instance, feeds.ts; `routes`/`reads`: the
//            front door's, #40 — its sessions are not state: never in the log; `:ack` → the
//            messagebox moves a reader's pointer; `defaults.ownerMessagebox`: the owner's
//            messagebox URL — the one peer a genesis names; `defaults.resolveOrigin`: where
//            the instance's own domain is looked up (a dev host))
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
import { now as clockNow } from "./clock.ts";
import type { Kernel } from "./kernel.ts";
import type { FeedSpec } from "./feeds.ts";

/** Session expiry (#33 part 2, #40): the instance's own policy, judged against the in-memory session's stamp (a day). */
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
  /** More seed subscriptions, after these (e.g. the wallet's boxes, #29): a sender (hex, `$owner`, or a provider's `$<name>`) or none, a box, a handler program record. */
  subscriptions?: Array<{ sender?: string; box: string; handler: CID }>;
  /** The front door's routes and reads for code genesis (#40; default STOCK_ROUTES, STOCK_READS). */
  routes?: RouteSpec[];
  reads?: ReadSpec[];
  /** Feeds the router holds for the instance (code genesis; a tree's config names its own). */
  feeds?: FeedSpec[];
  /** Code genesis (#51): libp2p for the instance (a tree's config names its own), and extra routes after the stock ones. */
  libp2p?: Libp2pSpec;
  extraRoutes?: RouteSpec[];
  /** A mailbox instance (#40): only the front door and the messagebox, keeping mail for `owner` from anyone. */
  mailbox?: boolean;
  /** The owner's messagebox URL (#40): the one peer a genesis names (`defaults.ownerMessagebox`). */
  ownerMessagebox?: string;
  /** Where the instance's own domain resolves (`defaults.resolveOrigin`): the host's origin in dev. */
  resolveOrigin?: string;
  /**
   * The address book's seed (#70): the host's providers (their keys, `local`,
   * role = name) and, when the host knows it, the owner's mailbox. Written
   * into the head `peers` when the genesis is processed.
   */
  addressBook?: AddressSeed[];
  /**
   * The host's providers by name (hex keys: fetch, waker, cron, libp2p,
   * status), for a subscription's sender written `$<name>` (#65: `$status`,
   * the status provider; #69: `$cron`). A subscription naming a provider this
   * host has not is left out (a tree may subscribe statuses on a host with no
   * Arcade).
   */
  providers?: Record<string, string>;
}

/** One address book entry a genesis seeds (#70): key → transport and address. */
export interface AddressSeed { key: Uint8Array; transport: "mailbox" | "libp2p" | "local"; address: string; role?: string; handle?: string; domain?: string }

/**
 * A subscription as a system tree writes it (etc/subscriptions.json): the
 * sender is an identity key in hex, `$owner` / `$infer` (the host's), a
 * provider's `$<name>` (`$status`, `$cron`: Genesis2Config.providers), or
 * absent (anyone); the handler a program name (bin/<name>, or `shell`) or a
 * program record's CID.
 */
export interface SubscriptionSpec { sender?: string; box?: string; handler: string }

/**
 * The stock seed: the owner's boxes, chat from anyone, the address book's box
 * (the admin's `peers`: resolve), and the reserved box the host admits into —
 * `:ack` (the messagebox moves a reader's pointer). The front door's sessions
 * are not state (in memory, never admitted). No `register` box (#40):
 * registration is application wiring — an application that wants senders to
 * enter themselves in the address book subscribes its own box (e.g.
 * `{box: "register", handler: "resolve"}`, the resolve program's claim
 * handler, or a program of its own with its own rules) in its
 * etc/subscriptions.json.
 */
export const STOCK_SUBSCRIPTIONS: SubscriptionSpec[] = [
  { sender: "$owner", box: "run", handler: "run-handler" },
  { sender: "$owner", box: "objects", handler: "objects-handler" },
  { sender: "$owner", box: "head", handler: "head-handler" },
  { sender: "$owner", box: "chat", handler: "loop" },
  { sender: "$owner", box: "subscribe", handler: "subscribe-handler" },
  { sender: "$owner", box: "peers", handler: "resolve" },
  { box: "chat", handler: "loop" },
  { box: ":ack", handler: "messagebox" },
];

/**
 * A mailbox instance's seed (#40): the
 * messagebox's acknowledgements, and every message from anyone in any box to
 * the messagebox (kept for the owner; a mailbox exists only where such a
 * subscription does).
 */
export const MAILBOX_SUBSCRIPTIONS: SubscriptionSpec[] = [
  { box: ":ack", handler: "messagebox" },
  { handler: "messagebox" },
];

/**
 * A front-door route as a system writes it (etc/routes.json, #40): an exact
 * `path` or a `prefix`, the handler program (a bin/ name or a CID) and its
 * function; `auth: "none"` for an open route; `read` an op the reads table
 * must allow the caller. `root` and `index` are the static handler's (#52:
 * the directory of the tree it serves, a directory's file), passed to the
 * handler as the route entry that matched.
 */
export interface RouteSpec { path?: string; prefix?: string; program: string; fn: string; auth?: "none"; read?: string; root?: string; index?: string }
/** A read permission as a system writes it (etc/reads.json): a caller (hex or `$owner`; absent: anyone) may call routes marked `read: op`. */
export interface ReadSpec { caller?: string; op: string }

/**
 * The stock routes (#40): the BRC-33 messagebox, at the root and under
 * /messagebox (where older clients were pointed); the explorer's read route
 * (the front door's `explore`: log, threads, heads, records as JSON) behind
 * the read op `explore`.
 */
export const STOCK_ROUTES: RouteSpec[] = [
  ...["", "/messagebox"].flatMap((p) => [
    { path: `${p}/sendMessage`, program: "messagebox", fn: "sendMessage" },
    { path: `${p}/listMessages`, program: "messagebox", fn: "listMessages" },
    { path: `${p}/acknowledgeMessage`, program: "messagebox", fn: "acknowledgeMessage" },
  ]),
  { prefix: "/explore", program: "frontdoor", fn: "explore", read: "explore" },
];

/** The stock reads (#40): the owner may explore. */
export const STOCK_READS: ReadSpec[] = [{ caller: "$owner", op: "explore" }];

/** A system's config (etc/config.json): every field optional; keys in hex or `$owner`/`$infer`. */
export interface ConfigSpec {
  defaults?: Record<string, string>;
  peers?: Record<string, string>;
  names?: Array<{ identityKey: string; handle: string; domain: string }>;
  collect?: string[];
  feeds?: FeedSpec[];
  /** The owner as a peer (#40): its messagebox URL — the one peer a genesis names. */
  owner?: { messagebox?: string };
  /** libp2p (#51): the topics the router subscribes for the instance, the protocols it serves, the node's own listen addresses. */
  libp2p?: Libp2pSpec;
}

/**
 * libp2p as a system writes it (etc/config.json `libp2p`, #51): `topics` the
 * router's node subscribes (each message a front-door call; its route
 * `libp2p:<topic>` comes from etc/routes.json), `protocols` it serves, each
 * naming its handler — a program (bin/ name or CID; fn "libp2p") or
 * {program, fn} — which becomes the route `libp2p:<protocol>` (unless
 * etc/routes.json has one), `listen` this node's addresses over the host's.
 */
export interface Libp2pSpec {
  topics?: string[];
  protocols?: Record<string, string | { program: string; fn?: string }>;
  listen?: string[];
}

/** A system resolved for one instance: what its genesis says besides who it is. */
export interface System {
  programs: Record<string, CID>;
  subscriptions: Array<{ match: { sender?: Uint8Array; box?: string }; handler: CID }>;
  peers?: Record<string, Uint8Array>;
  defaults: Record<string, string>;
  names: Array<{ identityKey: Uint8Array; handle: string; domain: string }>;
  collect: string[];
  /** The system tree (a git tree CID): `main` starts there. */
  tree?: CID;
  feeds?: FeedSpec[];
  /** The front door's routes and reads (#40). */
  routes: Array<{ path?: string; prefix?: string; program: CID; fn: string; auth?: "none"; read?: string; root?: string; index?: string }>;
  reads: Array<{ caller?: Uint8Array; op: string }>;
  /** libp2p (#51): what the router's libp2p host does for the instance. */
  libp2p?: { topics: string[]; protocols: string[]; listen?: string[] };
}

/** A system's libp2p, checked: the genesis's `libp2p` and the routes its protocols add (those routes.json lacks). */
export function libp2pIn(spec: Libp2pSpec | undefined, routes: RouteSpec[]): { libp2p?: System["libp2p"]; routes: RouteSpec[] } {
  if (spec === undefined) return { routes };
  const bad = (why: string) => new Error(`etc/config.json: libp2p ${why} (want {topics?: [string], protocols?: {protocol: program | {program, fn?}}, listen?: [multiaddr]})`);
  if (!spec || typeof spec !== "object") throw bad("is not an object");
  const strs = (v: unknown, what: string): string[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x)) throw bad(`${what} is not a list of strings`);
    return v as string[];
  };
  const topics = strs(spec.topics, "topics");
  const listen = strs(spec.listen, "listen");
  const ps = spec.protocols ?? {};
  if (typeof ps !== "object" || Array.isArray(ps)) throw bad("protocols is not an object");
  const out = [...routes];
  for (const [protocol, h] of Object.entries(ps)) {
    const program = typeof h === "string" ? h : h?.program;
    if (!protocol || typeof program !== "string" || !program) throw bad(`protocols.${protocol} names no program`);
    const path = `libp2p:${protocol}`;
    if (!out.some((r) => r.path === path)) out.push({ path, program, fn: (typeof h === "object" && h.fn) || "libp2p" });
  }
  return { libp2p: { topics, protocols: Object.keys(ps), ...(listen.length ? { listen } : {}) }, routes: out };
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
    out.push({ ...(r.path !== undefined ? { path: r.path } : { prefix: r.prefix! }), program, fn: r.fn, ...(r.auth === "none" ? { auth: "none" as const } : {}), ...(r.read ? { read: r.read } : {}), ...(typeof r.root === "string" ? { root: r.root } : {}), ...(typeof r.index === "string" ? { index: r.index } : {}) });
  }
  const rs: System["reads"] = [];
  for (const r of reads) {
    if (!r || typeof r.op !== "string") throw new Error(`etc/reads.json: bad entry ${JSON.stringify(r)} (want {caller?, op})`);
    rs.push({ ...(r.caller && r.caller !== "*" ? { caller: keyOf(r.caller, c) } : {}), op: r.op });
  }
  return { routes: out, reads: rs };
}

/** A key as a system writes it: hex, or `$owner` / `$infer` (the host's), or a provider's `$<name>` (Genesis2Config.providers). */
export function keyOf(s: string, c: Pick<Genesis2Config, "owner" | "infer" | "providers">): Uint8Array {
  if (s === "$owner") return keyBytes(c.owner);
  if (s === "$infer") {
    if (!c.infer) throw new Error("the system names $infer, and this host has no inference peer (SKEIN_INFER)");
    return keyBytes(c.infer);
  }
  if (s.startsWith("$")) {
    const k = c.providers?.[s.slice(1)];
    if (!k) throw new NoProvider(s);
    return keyBytes(k);
  }
  return keyBytes(s);
}

/** A subscription's `$<name>` that this host has no provider for: the subscription is left out. */
export class NoProvider extends Error {
  readonly provider: string;
  constructor(provider: string) { super(`no provider ${provider} on this host`); this.provider = provider; }
}

/** A subscription's sender resolved (absent: anyone), or null when it names a provider this host has not (left out, with a warning). */
function senderOf(sender: string | undefined, c: Genesis2Config): Uint8Array | undefined | null {
  if (!sender) return undefined;
  try { return keyOf(sender, c); } catch (e) {
    if (!(e instanceof NoProvider)) throw e;
    c.warn?.(`a subscription from ${sender} is left out: this host has no such provider`);
    return null;
  }
}

/** Resolve a system's subscriptions, config and programs for one instance (both genesis paths). */
export function resolveSystem(c: Genesis2Config, programs: Record<string, CID>, subs: SubscriptionSpec[], config: ConfigSpec = {}, tree?: CID, routes: RouteSpec[] = STOCK_ROUTES, reads: ReadSpec[] = STOCK_READS): System {
  const handler = (h: string): CID => {
    const p = programs[h];
    if (p) return p;
    try { return parseCid(h); } catch { throw new Error(`subscription handler ${JSON.stringify(h)}: no such program (bin/${h}.wasm or bin/${h}.cid) and not a CID`); }
  };
  if ((config as { jobs?: unknown }).jobs !== undefined) throw new Error("etc/config.json: `jobs` are gone (#69): a schedule is a program's message to the cron provider ({fn: \"tick\", every | at, box, body?, name}, docs/MESSAGES.md)");
  const subscriptions: System["subscriptions"] = [];
  for (const s of subs) {
    const sender = senderOf(s.sender, c);
    if (sender === null) continue;
    subscriptions.push({ match: { ...(sender ? { sender } : {}), ...(s.box !== undefined ? { box: s.box } : {}) }, handler: handler(s.handler) });
  }
  for (const x of c.subscriptions ?? []) {
    const sender = senderOf(x.sender, c);
    if (sender === null) continue;
    subscriptions.push({ match: { ...(sender ? { sender } : {}), box: x.box }, handler: x.handler });
  }
  let names = [{ identityKey: keyBytes(c.owner), ...(c.ownerHandle ?? { handle: "david", domain: "localhost" }) }];
  if (c.infer) names.push({ identityKey: keyBytes(c.infer), ...(c.inferHandle ?? { handle: "infer", domain: "localhost" }) });
  if (config.names) names = config.names.map((n) => ({ identityKey: keyOf(n.identityKey, c), handle: n.handle, domain: n.domain }));
  const peers = config.peers
    ? Object.fromEntries(Object.entries(config.peers).map(([role, k]) => [role, keyOf(k, c)]))
    : c.infer ? { infer: keyBytes(c.infer) } : undefined;
  const p2p = libp2pIn(config.libp2p ?? c.libp2p, [...routes, ...(c.extraRoutes ?? [])]);
  return {
    programs, subscriptions, ...(peers ? { peers } : {}),
    defaults: mergeDefaults(c, { ...(config.owner?.messagebox ? { ownerMessagebox: config.owner.messagebox } : {}), ...config.defaults }),
    names, collect: config.collect ?? ["completions"], ...(tree ? { tree } : {}),
    ...(feedsIn(config.feeds ?? c.feeds)),
    ...resolveRoutes(c, programs, p2p.routes, reads),
    ...(p2p.libp2p ? { libp2p: p2p.libp2p } : {}),
  };
}

/** A system's feeds, checked. */
function feedsIn(fs: FeedSpec[] | undefined): { feeds?: FeedSpec[] } {
  if (!fs) return {};
  if (!Array.isArray(fs)) throw new Error("etc/config.json: feeds is a list");
  for (const f of fs) {
    if (f?.kind === "headers" && typeof f.url === "string" && f.url) continue;
    if ((f as { kind?: unknown })?.kind === "arc-callback") throw new Error("etc/config.json: the arc-callback feed is gone (#58): transaction statuses come from the host's broadcaster (SKEIN_ARC_URL), routed to every instance holding the transaction");
    throw new Error(`etc/config.json: a feed is {kind: "headers", url, box?}: ${JSON.stringify(f)}`);
  }
  return fs.length ? { feeds: fs } : {};
}

/** DEFAULTS < the host's fill-ins < the tree's config < explicit overrides (warned when they replace a tree value). */
function mergeDefaults(c: Genesis2Config, tree: Record<string, string> = {}): Record<string, string> {
  for (const [k, v] of Object.entries(c.overrides ?? {})) {
    if (tree[k] !== undefined && tree[k] !== v) c.warn?.(`host override: ${k} = ${v} replaces the system tree's ${k} = ${tree[k]}`);
  }
  return { ...DEFAULTS, ...SESSION_DEFAULTS, ...hostFacts(c), ...c.defaults, ...tree, ...c.overrides };
}

/** What the host knows at genesis (#40): the owner's messagebox, where its own domain resolves. */
function hostFacts(c: Pick<Genesis2Config, "ownerMessagebox" | "resolveOrigin">): Record<string, string> {
  return { ...(c.ownerMessagebox ? { ownerMessagebox: c.ownerMessagebox } : {}), ...(c.resolveOrigin ? { resolveOrigin: c.resolveOrigin } : {}) };
}

/** The stock system in code: the kernel's pinned programs (its `programs` frame) and the stock seed. */
export function codeSystem(c: Genesis2Config, programs: Record<string, CID>): System {
  if (c.mailbox) {
    // A mailbox instance: the front door and the messagebox, nothing else.
    const mine: Record<string, CID> = { frontdoor: programs.frontdoor!, messagebox: programs.messagebox! };
    const s = resolveSystem({ ...c, defaults: undefined, overrides: undefined, infer: undefined }, mine, MAILBOX_SUBSCRIPTIONS, { peers: {}, names: [] }, undefined, STOCK_ROUTES, STOCK_READS);
    return { ...s, collect: [], defaults: { ...SESSION_DEFAULTS, ...c.defaults, ...c.overrides } };
  }
  const subs = STOCK_SUBSCRIPTIONS.filter((s) => (s.box !== "chat" || s.sender || c.openChat !== false) && programs[s.handler]);
  // Code genesis has always taken the host's defaults whole (DEFAULTS when none).
  return { ...resolveSystem({ ...c, defaults: undefined, overrides: undefined }, programs, subs, {}, undefined, c.routes ?? STOCK_ROUTES, c.reads ?? STOCK_READS), defaults: { ...SESSION_DEFAULTS, ...hostFacts(c), ...(c.defaults ? { ...c.defaults, ...c.overrides } : c.overrides ? { ...DEFAULTS, ...c.overrides } : DEFAULTS) } };
}

/** The genesis record: who the instance is, and its system. */
export function genesisRecord(c: Pick<Genesis2Config, "identity" | "owner" | "handle" | "domain" | "addressBook">, s: System): Record<string, unknown> {
  return {
    kind: "genesis", identity: keyBytes(c.identity), handle: c.handle, domain: c.domain, owner: keyBytes(c.owner),
    ...(c.addressBook?.length ? { addressBook: c.addressBook.map((e) => ({ key: e.key, transport: e.transport, address: e.address, ...(e.role ? { role: e.role } : {}), ...(e.handle ? { handle: e.handle } : {}), ...(e.domain ? { domain: e.domain } : {}) })) } : {}),
    programs: s.programs, subscriptions: s.subscriptions, ...(s.peers ? { peers: s.peers } : {}),
    defaults: s.defaults, names: s.names, collect: s.collect, ...(s.tree ? { tree: s.tree } : {}), ...(s.feeds ? { feeds: s.feeds } : {}),
    ...(s.routes.length ? { routes: s.routes } : {}), ...(s.reads.length ? { reads: s.reads } : {}),
    ...(s.libp2p ? { libp2p: s.libp2p } : {}),
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
export async function admit2(k: Kernel, body: EntryBody | Record<string, unknown>, records: { body?: Uint8Array } = {}, time: Stamp = clockNow()): Promise<CID> {
  for (let tries = 0; ; tries++) {
    try {
      return await k.admit(await nextEntry(k.store, body as EntryBody, time) as never, records);
    } catch (e) {
      if (!(e instanceof Rejected && e.reason === "out-of-order") || tries >= 10) throw e;
    }
  }
}

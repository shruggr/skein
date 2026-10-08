// Format 10 (#146: the BEEF envelope beside the pointer record; format 9, #143: routes without senders, filters, roles and grants, root instead of an owner; format 8,
// #77: the kernel's tables — one route table, admin operations in the kernel, write scope by app name;
// format 7, #65, #69; format 6, #70, #67; #68: requests appended as received; format 3, #40; format 2,
// #33: unsigned entries, keys as bytes) on the host's side: the genesis a new instance's log starts with,
// and entries.
//
//   entry    {kind: "log", prev, n, time, genesis | request+transport | mail | event+box}   — no `sig`: no host key
//   genesis  {kind: "genesis", identity: bytes(33), root?: [bytes(33)], handle, domain, programs,
//             dispatch: [<route>], roles?: {<role>: ["<program>.<fn>"]},
//             scopes?: {<program name>: [<head name | prefix/>]}, peers?: {role: bytes(33)},
//             defaults, names?: [{identityKey: bytes(33), handle, domain}], collect, tree?,
//             feeds?: [{kind: "headers", url, box?}]  (#58: statuses come from the host's broadcaster, arc.ts),
//             libp2p?: {topics: [string], protocols: [string], listen?: [multiaddr]},
//             addressBook?: [{key: bytes(33), transport, address, handle?, domain?}],
//             heads?: {<head name>: <record CID>}}  (#141: an image's installed apps, `<app>/app`)
//   route    {transport: "mailbox" | "event" | "http" | "libp2p" | "local", address, prefix?: true,
//             filters?: ["kernel.brc104" | "kernel.beef" | "<app>.<filter>"], program?: <program record CID> | "kernel",
//             fn?, …settings}
//            (`dispatch`: the seed of the kernel's route table, docs/APPS.md §2 — the admin routes (boxes
//            objects, head, dispatch, peers, grant → the kernel, gated by root), the boxes programs take,
//            the events the host's wiring brings, the HTTP paths and libp2p topics and protocols. No
//            `sender` (#143): who may run a function is the grants'. `root`: the initial root holders
//            (#143; #142: the host skein's operator key) — none: an image, its routes carry the claim
//            route and root comes with the claim. `roles`: what gates the genesis's own programs'
//            functions — STOCK_ROLES: the explorer is root's. `scopes`: the heads a genesis-wired
//            program may advance — STOCK_SCOPES, plus a tree's config `scopes`.)
//            (`addressBook`, #70: the address book's seed — the host's providers (transport `local`, address
//            their name: fetch, waker, cron, libp2p, status; #126: no role) and the root holder's mailbox —
//            written into the head `peers` at the genesis)
//            (no `jobs`, #69: a schedule is a program's message to the cron provider; a genesis naming
//            them is refused)
//            (`libp2p`, #51: the host's libp2p node runs for the instance, subscribes `topics` and serves
//            `protocols`; each message or frame is a front-door step routed by its `libp2p` route)
//            (`feeds`: what the host holds for the instance, feeds.ts; `defaults.ownerMessagebox`: the root
//            holder's messagebox URL — the one peer a genesis names; `defaults.resolveOrigin`: where the
//            instance's own domain is looked up (a dev host))
//
// The stamp is the host's clock at admission (#10): the sequence is the
// order. A genesis is written from a **system** (issue #4, docs/BOOTSTRAP.md):
// the programs, the routes, the config — read from a system tree by the
// loader (boot.ts), which then also names the tree (`tree`: `main` starts
// there), or, for an instance with no tree, the stock system in code
// (codeSystem: the kernel's own pinned programs and STOCK_DISPATCH). The same
// `genesisRecord` writes both. The forms before #77 and #115
// (etc/subscriptions.json, etc/routes.json, etc/reads.json) are gone (#143):
// they spoke of senders.

import type { CID } from "multiformats/cid";
import { parse as parseCid } from "../runtime/cid.ts";
import { isFilterRef, rowKey, type DispatchRow, type Transport } from "../runtime/dispatch.ts";
import { DEFAULTS, nextEntry, type EntryBody } from "../runtime/log.ts";
import { Rejected } from "../runtime/store.ts";
import type { Stamp } from "../runtime/syscalls.ts";
import { now as clockNow } from "./clock.ts";
import type { Kernel } from "./kernel.ts";
import type { FeedSpec } from "./feeds.ts";

/** Session expiry (#33 part 2, #40): the instance's own policy, judged against the session record's stamp (a day). */
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
  /**
   * The initial root holders (hex; #143). Absent or empty: an image (#89) — a genesis with no root
   * holder; its routes carry the claim route, and root comes with the claim. The host skein's is
   * the operator's key (#142).
   */
  root?: string[];
  handle: string;
  domain: string;
  infer?: string;
  /** The first root holder's handle, for `names` (a code genesis). */
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
  /** More box routes, after these (e.g. the wallet's boxes, #29): a box and its handler program record. */
  subscriptions?: Array<{ box: string; handler: CID }>;
  /** More routes of any transport (#77), after these: the route as a system writes it (handler names resolved against the programs). */
  dispatch?: DispatchSpec[];
  /** Feeds the host holds for the instance (code genesis; a tree's config names its own). */
  feeds?: FeedSpec[];
  /** Code genesis (#51): libp2p for the instance (a tree's config names its own). */
  libp2p?: Libp2pSpec;
  /** Write scopes of genesis-wired programs beyond STOCK_SCOPES (#77): program name → head names (a prefix ends in `/`). */
  scopes?: Record<string, string[]>;
  /** A mailbox instance (#40): only the front door and the messagebox, keeping mail for its root from anyone. */
  mailbox?: boolean;
  /** The root holder's messagebox URL (#40): the one peer a genesis names (`defaults.ownerMessagebox`). */
  ownerMessagebox?: string;
  /** Where the instance's own domain resolves (`defaults.resolveOrigin`): the host's origin in dev. */
  resolveOrigin?: string;
  /**
   * The address book's seed (#70): the host's providers (their keys, `local`,
   * address = name; #126: no role) and, when the host knows it, the root holder's mailbox. Written
   * into the head `peers` when the genesis is processed.
   */
  addressBook?: AddressSeed[];
  /**
   * The host's providers by name (hex keys: fetch, waker, cron, libp2p,
   * status), for a config key written `$<name>` (`peers`, `names`).
   */
  providers?: Record<string, string>;
  /**
   * #142: an installed app's config at birth, by app name, merged over its manifest's `config` as an
   * install's `--config` is (the host skein's onboard: domain, origin, name, note from host.env).
   */
  appConfig?: Record<string, Record<string, unknown>>;
}

/** One address book entry a genesis seeds (#70): key → transport and address. */
export interface AddressSeed { key: Uint8Array; transport: "mailbox" | "libp2p" | "local"; address: string; handle?: string; domain?: string }

/**
 * A route as a system writes it (etc/dispatch.json, #77, #143): `transport`
 * defaults to `mailbox`; `address` a box (`*`: any box), an event's box, an
 * HTTP path (with `prefix: true` for a prefix), a libp2p topic or
 * `/<protocol>`; `filters` what runs before anything is recorded
 * ("kernel.brc104", "kernel.beef", "<app>.<filter>"); `program` a program name
 * (bin/<name>), a program record's CID, or `kernel` (an admin route: `fn` the
 * operation — objects, head, dispatch, peers, grant, claim, tick), absent for a
 * read route (http: its filters answer); `fn` a handler's function; anything
 * else a handler's own setting (a file handler's `root`, `index`). No `sender`
 * (#143).
 */
export interface DispatchSpec { transport?: Transport; address: string; prefix?: boolean; filters?: string[]; program?: string; fn?: string; [setting: string]: unknown }

/**
 * The kernel's admin operations (#77, #143: and `grant`), one per table, each gated by root. Every
 * genesis carries their routes — `{address: <op>, program: kernel, fn: <op>}` — ahead of its own
 * (#31: a bare genesis is the tables and the admin routes; a bundle adds what its apps ask for).
 * Delegating is a grant (root, or an app's role), never another route.
 */
export const ADMIN_OPS = ["objects", "head", "dispatch", "peers", "grant"] as const;
export const ADMIN_ROWS: DispatchSpec[] = ADMIN_OPS.map((op): DispatchSpec => ({ address: op, program: "kernel", fn: op }));
/** What a kernel route may name: the admin operations, the claim (#89), and the host's tick (#130: the host row, billing.ts). */
export const KERNEL_OPS = [...ADMIN_OPS, "claim", "tick"] as const;

/**
 * The claim route (#89, #143): an image's route to the kernel. A message in box `claim`, from anyone:
 * root is granted to its sender (#127) and this route removed (a second claim finds no route). The
 * claimant's own message (`skein claim`), or a claim signed before the instance existed, which the
 * host's instance manager forwards as its first entry before the hostname is published
 * (Router.createInstance).
 */
export const CLAIM_ROW: DispatchSpec = { address: "claim", program: "kernel", fn: "claim" };

/** The BRC-103 handshake's route (#143): the front door's, no filters (it makes the session). */
export const HANDSHAKE_ROW: DispatchSpec = { transport: "http", address: "/.well-known/auth", program: "frontdoor", fn: "handshake" };

/**
 * The stock HTTP routes (#40, #143): the BRC-33 messagebox, at the root and under /messagebox (where
 * older clients were pointed), behind kernel.brc104 (a session: the caller is its key); the
 * explorer's route (the front door's `explore`: log, threads, heads, records as JSON), behind
 * kernel.brc104 and gated by root (STOCK_ROLES); the handshake.
 */
export const STOCK_HTTP: DispatchSpec[] = [
  HANDSHAKE_ROW,
  ...["", "/messagebox"].flatMap((p) => ["sendMessage", "listMessages", "acknowledgeMessage"].map((fn): DispatchSpec => (
    { transport: "http", address: `${p}/${fn}`, filters: ["kernel.brc104"], program: "messagebox", fn }))),
  { transport: "http", address: "/explore", prefix: true, filters: ["kernel.brc104"], program: "frontdoor", fn: "explore" },
];

/** What gates the genesis's own programs' functions (#143): the explorer is root's. */
export const STOCK_ROLES: Record<string, string[]> = { root: ["frontdoor.explore"] };

/**
 * The stock seed (#77), after the admin routes: the reserved box the host admits events into, `:ack`
 * (the messagebox moves a reader's pointer: an event, #143); and the stock HTTP routes. No `run`, no
 * `chat` (#83): the shell and the chat loop are apps. No `register` box (#40): registration is
 * application wiring.
 */
export const STOCK_DISPATCH: DispatchSpec[] = [
  { transport: "event", address: ":ack", program: "messagebox" },
  ...STOCK_HTTP,
];

/**
 * A mailbox instance's seed (#40): the messagebox's acknowledgements, and every message in any box to
 * the messagebox (kept for its root; a mailbox exists only where such a route does).
 */
export const MAILBOX_DISPATCH: DispatchSpec[] = [
  { transport: "event", address: ":ack", program: "messagebox" },
  { address: "*", program: "messagebox" },
  ...STOCK_HTTP,
];

/**
 * The write scopes of the stock genesis-wired programs (#77): the heads each
 * may advance, by program name. The front door's sessions; the messagebox's
 * lists (#126: its outbound sessions are the kernel's, authfetch); the wallet's records (#79: `wallet/…`, its
 * coins, actions, drafts and outputs — the chain is the chain app's). The
 * resolve program's records (#87: `resolve/peers`, what a BRC-169 lookup
 * found — never the address book, which only root's `peers` messages
 * change; the messagebox's delivery reads them for a key the address book
 * does not name).
 */
export const STOCK_SCOPES: Record<string, string[]> = {
  frontdoor: ["frontdoor/"],
  messagebox: ["mailbox"],
  resolve: ["resolve/"],
  wallet: ["wallet/"],
  // #78: the chain module (shruggr/skein-chain) wired at boot by a system tree as `bin/chain.wasm`:
  // its heads are `chain/…`, as an installed chain app's are by the name rule.
  chain: ["chain/"],
};

/** A system's config (etc/config.json): every field optional; keys in hex, `$self`, `$infer` or a provider's `$<name>`. */
export interface ConfigSpec {
  defaults?: Record<string, string>;
  peers?: Record<string, string>;
  names?: Array<{ identityKey: string; handle: string; domain: string }>;
  collect?: string[];
  feeds?: FeedSpec[];
  /** The root holder as a peer (#40): its messagebox URL — the one peer a genesis names. */
  owner?: { messagebox?: string };
  /** libp2p (#51): the topics the host subscribes for the instance, the protocols it serves, the node's own listen addresses. */
  libp2p?: Libp2pSpec;
  /** Write scopes of the tree's genesis-wired programs (#77), over STOCK_SCOPES: program name → head names (a prefix ends in `/`). */
  scopes?: Record<string, string[]>;
  /** What gates the tree's genesis-wired programs' functions (#143), over STOCK_ROLES: {<role>: ["<program>.<fn>"]}. */
  roles?: Record<string, string[]>;
}

/**
 * libp2p as a system writes it (etc/config.json `libp2p`, #51): `topics` the
 * host's node subscribes (each message a front-door step; its `libp2p` route
 * comes from etc/dispatch.json), `protocols` it serves, each naming its
 * handler — a program (bin/ name or CID; fn "libp2p") or {program, fn} —
 * which becomes its route (unless the tree has one), `listen` this node's
 * addresses over the host's.
 */
export interface Libp2pSpec {
  topics?: string[];
  protocols?: Record<string, string | { program: string; fn?: string }>;
  listen?: string[];
}

/** A system resolved for one instance: what its genesis says besides who it is. */
export interface System {
  programs: Record<string, CID>;
  /** The route table's seed (#77), programs resolved. */
  dispatch: DispatchRow[];
  /** What gates the genesis's own programs' functions (#143). */
  roles: Record<string, string[]>;
  scopes: Record<string, string[]>;
  peers?: Record<string, Uint8Array>;
  defaults: Record<string, string>;
  names: Array<{ identityKey: Uint8Array; handle: string; domain: string }>;
  collect: string[];
  /** The system tree (a git tree CID): `main` starts there. */
  tree?: CID;
  feeds?: FeedSpec[];
  /** libp2p (#51): what the host's libp2p node does for the instance. */
  libp2p?: { topics: string[]; protocols: string[]; listen?: string[] };
  /** #141: heads the genesis sets (an image's installed apps: `<app>/app`), name → record CID. */
  heads?: Record<string, CID>;
}

/** A system's libp2p, checked: the genesis's `libp2p` and the routes its protocols add (those the tree lacks). */
export function libp2pIn(spec: Libp2pSpec | undefined, specs: DispatchSpec[]): { libp2p?: System["libp2p"]; specs: DispatchSpec[] } {
  if (spec === undefined) return { specs };
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
  const out = [...specs];
  for (const [protocol, h] of Object.entries(ps)) {
    const program = typeof h === "string" ? h : h?.program;
    if (!protocol || typeof program !== "string" || !program) throw bad(`protocols.${protocol} names no program`);
    if (!out.some((r) => r.transport === "libp2p" && r.address === protocol)) out.push({ transport: "libp2p", address: protocol, program, fn: (typeof h === "object" && h.fn) || "libp2p" });
  }
  return { libp2p: { topics, protocols: Object.keys(ps), ...(listen.length ? { listen } : {}) }, specs: out };
}

/** A key as a system writes it: hex, or `$self` / `$infer` (the host's), or a provider's `$<name>` (Genesis2Config.providers). */
export function keyOf(s: string, c: Pick<Genesis2Config, "infer" | "providers"> & { identity?: string }): Uint8Array {
  if (s === "$owner") throw new Error("$owner: gone (#143: there is no owner; root holders are the genesis's `root`, granted by a claim or a grant)");
  if (s === "$self") {
    if (!c.identity) throw new Error("$self: no instance identity here");
    return keyBytes(c.identity);
  }
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

/** A `$<name>` that this host has no provider for. */
export class NoProvider extends Error {
  readonly provider: string;
  constructor(provider: string) { super(`no provider ${provider} on this host`); this.provider = provider; }
}

/** The program a spec names: by name in `programs`, else a CID; `kernel` for an admin route. */
function programOf(h: string, programs: Record<string, CID>): CID | "kernel" | undefined {
  if (h === "kernel") return "kernel";
  const p = programs[h];
  if (p) return p;
  try { return parseCid(h); } catch { return undefined; } // neither a program's name nor a CID: the caller refuses the route and says so
}

const isBox = (b: unknown): b is string => typeof b === "string" && b.length > 0 && !/[\s\0]/.test(b);
const TRANSPORTS = ["mailbox", "event", "http", "libp2p", "local"];

/** The routes of a system's specs (etc/dispatch.json, #77, #143), programs resolved; a route to a program the system lacks is dropped. */
export function rowsOf(specs: DispatchSpec[], programs: Record<string, CID>): DispatchRow[] {
  const out: DispatchRow[] = [];
  for (const s of specs) {
    if (!s || typeof s !== "object" || !isBox(s.address) || (s.program !== undefined && typeof s.program !== "string")) throw new Error(`etc/dispatch.json: bad route ${JSON.stringify(s)} (want {transport?, address, prefix?, filters?, program?, fn?, …})`);
    if (s.sender !== undefined) throw new Error(`etc/dispatch.json: route ${s.address}: \`sender\` is gone (#143: a route has none — filters say who it is from, roles gate functions)`);
    const transport = s.transport ?? "mailbox";
    if (!TRANSPORTS.includes(transport)) throw new Error(`etc/dispatch.json: route ${s.address}: transport ${JSON.stringify(transport)} is not mailbox, event, http, libp2p or local`);
    if (s.filters !== undefined && (!Array.isArray(s.filters) || !s.filters.every(isFilterRef))) throw new Error(`etc/dispatch.json: route ${s.address}: filters is a list of "kernel.brc104", "kernel.beef" or "<app>.<filter>"`);
    if (s.program === undefined) {
      if (transport !== "http" || !s.filters?.length) throw new Error(`etc/dispatch.json: route ${s.address}: no program — only an http read route (its filters answer) has none`);
      const { transport: _t, ...rest } = s;
      void _t;
      out.push({ ...rest, transport } as DispatchRow);
      continue;
    }
    const program = programOf(s.program, programs);
    if (!program) continue;
    if (program === "kernel" && (typeof s.fn !== "string" || !(KERNEL_OPS as readonly string[]).includes(s.fn))) throw new Error(`etc/dispatch.json: route ${s.address}: a kernel route's fn is one of ${KERNEL_OPS.join(", ")}`);
    const { transport: _t, address, prefix, filters, program: _p, fn, ...settings } = s;
    void _t; void _p;
    out.push({ transport, address, ...(prefix ? { prefix: true } : {}), ...(filters?.length ? { filters } : {}), program, ...(fn ? { fn } : {}), ...settings });
  }
  return out;
}

/**
 * Resolve a system's routes, config and programs for one instance (both genesis paths). `specs` is
 * its etc/dispatch.json. The order: the admin routes (every genesis), the dispatch specs, the
 * host's extra box routes and routes, then the protocols' routes. A route with an admin route's key
 * is left out (the kernel's operation keeps the box), with a warning.
 */
export function resolveSystem(c: Genesis2Config, programs: Record<string, CID>, config: ConfigSpec = {}, tree?: CID, specs: DispatchSpec[] = []): System {
  if ((config as { jobs?: unknown }).jobs !== undefined) throw new Error("etc/config.json: `jobs` are gone (#69): a schedule is a program's message to the cron provider ({fn: \"tick\", every | at, box, body?, name}, docs/MESSAGES.md)");
  if (config.scopes !== undefined && (typeof config.scopes !== "object" || Array.isArray(config.scopes) || Object.values(config.scopes).some((v) => !Array.isArray(v) || v.some((h) => typeof h !== "string" || !h)))) throw new Error("etc/config.json: scopes is {<program name>: [<head name | prefix/>]}");
  if (config.roles !== undefined && (typeof config.roles !== "object" || Array.isArray(config.roles) || Object.values(config.roles).some((v) => !Array.isArray(v) || v.some((f) => typeof f !== "string" || !f.includes("."))))) throw new Error("etc/config.json: roles is {<role>: [\"<program>.<fn>\"]}");
  const p2p = libp2pIn(config.libp2p ?? c.libp2p, [...specs, ...(c.subscriptions ?? []).map((x): DispatchSpec => ({ address: x.box, program: x.handler.toString() })), ...(c.dispatch ?? [])]);
  const admin = rowsOf(ADMIN_ROWS, programs);
  const dispatch: DispatchRow[] = [...admin];
  for (const r of rowsOf(p2p.specs, programs)) {
    if (dispatch.some((a) => rowKey(a) === rowKey(r))) { if (admin.some((a) => rowKey(a) === rowKey(r)) && r.program !== "kernel") c.warn?.(`a route for the admin box ${r.address} is left out: the kernel's ${r.address} operation keeps it`); continue; }
    dispatch.push(r);
  }
  const root = c.root ?? [];
  // A tree booted with root and no root holder's handle (#142: the host skein from its image) names no one.
  let names: System["names"] = root.length && (c.ownerHandle || !tree) ? [{ identityKey: keyBytes(root[0]!), ...(c.ownerHandle ?? { handle: "david", domain: "localhost" }) }] : [];
  if (c.infer) names.push({ identityKey: keyBytes(c.infer), ...(c.inferHandle ?? { handle: "infer", domain: "localhost" }) });
  if (config.names) names = config.names.map((n) => ({ identityKey: keyOf(n.identityKey, c), handle: n.handle, domain: n.domain }));
  const peers = config.peers
    ? Object.fromEntries(Object.entries(config.peers).map(([role, k]) => [role, keyOf(k, c)]))
    : c.infer ? { infer: keyBytes(c.infer) } : undefined;
  return {
    programs, dispatch, roles: mergeRoles(STOCK_ROLES, config.roles ?? {}), scopes: { ...STOCK_SCOPES, ...c.scopes, ...config.scopes }, ...(peers ? { peers } : {}),
    defaults: mergeDefaults(c, { ...(config.owner?.messagebox ? { ownerMessagebox: config.owner.messagebox } : {}), ...config.defaults }),
    names, collect: config.collect ?? ["completions"], ...(tree ? { tree } : {}),
    ...(feedsIn(config.feeds ?? c.feeds)),
    ...(p2p.libp2p ? { libp2p: p2p.libp2p } : {}),
  };
}

/** Two role maps joined (#143): each role's functions, both lists' (a tree's roles add to the stock ones, never replace them). */
function mergeRoles(a: Record<string, string[]>, b: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [r, fs] of [...Object.entries(a), ...Object.entries(b)]) out[r] = [...new Set([...(out[r] ?? []), ...fs])];
  return out;
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

/** What the host knows at genesis (#40): the root holder's messagebox, where its own domain resolves. */
function hostFacts(c: Pick<Genesis2Config, "ownerMessagebox" | "resolveOrigin">): Record<string, string> {
  return { ...(c.ownerMessagebox ? { ownerMessagebox: c.ownerMessagebox } : {}), ...(c.resolveOrigin ? { resolveOrigin: c.resolveOrigin } : {}) };
}

/** The stock system in code: the kernel's pinned programs (its `programs` frame) and the stock seed. */
export function codeSystem(c: Genesis2Config, programs: Record<string, CID>): System {
  const known = (s: DispatchSpec) => s.program === undefined || s.program === "kernel" || !!programs[s.program];
  if (c.mailbox) {
    // A mailbox instance: the front door and the messagebox, nothing else.
    const mine: Record<string, CID> = { frontdoor: programs.frontdoor!, messagebox: programs.messagebox! };
    const s = resolveSystem({ ...c, defaults: undefined, overrides: undefined, infer: undefined, subscriptions: undefined, dispatch: undefined }, mine, { peers: {}, names: [] }, undefined, MAILBOX_DISPATCH);
    return { ...s, collect: [], defaults: { ...SESSION_DEFAULTS, ...c.defaults, ...c.overrides } };
  }
  // Code genesis has always taken the host's defaults whole (DEFAULTS when none).
  return { ...resolveSystem({ ...c, defaults: undefined, overrides: undefined }, programs, {}, undefined, STOCK_DISPATCH.filter(known)), defaults: { ...SESSION_DEFAULTS, ...hostFacts(c), ...(c.defaults ? { ...c.defaults, ...c.overrides } : c.overrides ? { ...DEFAULTS, ...c.overrides } : DEFAULTS) } };
}

/** The genesis record: who the instance is, and its system. */
export function genesisRecord(c: Pick<Genesis2Config, "identity" | "root" | "handle" | "domain" | "addressBook">, s: System): Record<string, unknown> {
  return {
    kind: "genesis", identity: keyBytes(c.identity), handle: c.handle, domain: c.domain, ...(c.root?.length ? { root: c.root.map(keyBytes) } : {}),
    ...(Object.keys(s.roles).length ? { roles: s.roles } : {}),
    ...(c.addressBook?.length ? { addressBook: c.addressBook.map((e) => ({ key: e.key, transport: e.transport, address: e.address, ...(e.handle ? { handle: e.handle } : {}), ...(e.domain ? { domain: e.domain } : {}) })) } : {}),
    programs: s.programs, dispatch: s.dispatch, ...(Object.keys(s.scopes).length ? { scopes: s.scopes } : {}), ...(s.peers ? { peers: s.peers } : {}),
    defaults: s.defaults, names: s.names, collect: s.collect, ...(s.tree ? { tree: s.tree } : {}), ...(s.feeds ? { feeds: s.feeds } : {}),
    ...(s.libp2p ? { libp2p: s.libp2p } : {}), ...(s.heads && Object.keys(s.heads).length ? { heads: s.heads } : {}),
  };
}

/** The genesis record for a new instance over the kernel's programs (name → program record CID): code genesis. */
export function genesis2(c: Genesis2Config, programs: Record<string, CID>): Record<string, unknown> {
  return genesisRecord(c, codeSystem(c, programs));
}

/** Write a genesis over `s` into an empty store through its kernel; the entry's CID. */
export async function writeSystemGenesis(k: Kernel, c: Genesis2Config, s: System, time: Stamp = clockNow()): Promise<CID> {
  const g = await k.store.put(genesisRecord(c, s) as never);
  return await k.store.log.append(await nextEntry(k.store, { genesis: g }, time) as never); // the kernel's log takes a format-10 entry; Store's type is format 1
}

/** Code genesis (the stock system) into an empty store; the entry's CID. */
export async function writeGenesis(k: Kernel, c: Genesis2Config, time: Stamp = clockNow()): Promise<CID> {
  const programs = await k.call("programs") as Record<string, CID>;
  return await writeSystemGenesis(k, c, codeSystem(c, programs), time);
}

/** Admit the next entry over `body` (unsigned), retrying if the tip moved under it. */
export async function admit2(k: Kernel, body: EntryBody | Record<string, unknown>, records: { body?: Uint8Array; request?: Record<string, unknown> } = {}, time: Stamp = clockNow()): Promise<CID> {
  for (let tries = 0; ; tries++) {
    try {
      return await k.admit(await nextEntry(k.store, body as EntryBody, time), records);
    } catch (e) {
      if (!(e instanceof Rejected && e.reason === "out-of-order") || tries >= 10) throw e;
    }
  }
}

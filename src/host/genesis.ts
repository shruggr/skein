// Format 8 (#77: the kernel's four tables — one dispatch table, admin operations in the kernel, write
// scope by app name; format 7, #65, #69; format 6, #70, #67; #68: requests appended as received; format 3,
// #40; format 2, #33: unsigned entries, keys as bytes) on the host's side: the genesis a new instance's
// log starts with, and entries.
//
//   entry    {kind: "log", prev, n, time, genesis | request+transport | mail | event+box}   — no `sig`: no host key
//   genesis  {kind: "genesis", identity: bytes(33), owner: bytes(33), handle, domain, programs,
//             dispatch: [<row>], scopes?: {<program name>: [<head name | prefix/>]}, peers?: {role: bytes(33)},
//             defaults, names?: [{identityKey: bytes(33), handle, domain}], collect, tree?,
//             feeds?: [{kind: "headers", url, box?}]  (#58: statuses come from the host's broadcaster, arc.ts),
//             libp2p?: {topics: [string], protocols: [string], listen?: [multiaddr]},
//             addressBook?: [{key: bytes(33), transport, address, handle?, domain?}]}
//   row      {transport: "mailbox" | "http" | "libp2p" | "local", address, prefix?: true,
//             sender: "*" | "event" | "session" | bytes(33), program: <program record CID> | "kernel", fn?, filter?: "beef", …settings}
//            (`dispatch`, #77: the seed of the kernel's dispatch table, docs/MESSAGES.md "The dispatch
//            table" — the admin rows (boxes objects, head, dispatch, peers → the kernel, from the owner),
//            the boxes programs take (a subscription of old), the HTTP paths and libp2p topics and
//            protocols the front door routes (a route of old). `scopes`: the heads a genesis-wired program
//            may advance — STOCK_SCOPES, plus a tree's config `scopes`. No `subscriptions`, no `routes`.)
//            (`addressBook`, #70: the address book's seed — the host's providers (transport `local`, address
//            their name: fetch, waker, cron, libp2p, status; #126: no role) and the owner's mailbox — written
//            into the head `peers` at the genesis)
//            (no `jobs`, #69: a schedule is a program's message to the cron provider; a genesis naming
//            them is refused)
//            (`libp2p`, #51: the host's libp2p node runs for the instance, subscribes `topics` and serves
//            `protocols`; each message or frame is a front-door step routed by its `libp2p` row)
//            (`feeds`: what the host holds for the instance, feeds.ts; no `reads` since #115: a read
//            permission is the row's sender — the reads a system names are folded into its rows, foldReads;
//            `defaults.ownerMessagebox`: the owner's messagebox URL — the one peer a genesis names;
//            `defaults.resolveOrigin`: where the instance's own domain is looked up (a dev host))
//
// The stamp is the host's clock at admission (#10): the sequence is the
// order. A genesis is written from a **system** (issue #4, docs/BOOTSTRAP.md):
// the programs, the dispatch rows, the config — read from a system tree by
// the loader (boot.ts), which then also names the tree (`tree`: `main` starts
// there), or, for an instance with no tree, the stock system in code
// (codeSystem: the kernel's own pinned programs and STOCK_DISPATCH). The
// same `genesisRecord` writes both. A tree may still write
// etc/subscriptions.json and etc/routes.json (the forms before #77): each
// entry becomes a row (rowsOfBoxSpecs, rowsOfPathSpecs); and etc/reads.json
// (the form before #115): folded into the rows that name a `read` op.

import type { CID } from "multiformats/cid";
import { parse as parseCid } from "../runtime/cid.ts";
import { rowKey, type DispatchRow, type Sender, type Transport } from "../runtime/dispatch.ts";
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
   * The owner (hex). Absent: an image (#89) — a genesis with no owner, no
   * admin rows and no `$owner` anywhere; its dispatch rows carry the claim
   * row, and the owner comes with the claim.
   */
  owner?: string;
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
  /** More seed rows for boxes, after these (e.g. the wallet's boxes, #29): a sender (hex, `$owner`, or a provider's `$<name>`) or none (anyone), a box, a handler program record. */
  subscriptions?: Array<{ sender?: string; box: string; handler: CID }>;
  /** More seed rows of any transport (#77), after these: the row as a system writes it (handler names resolved against the programs). */
  dispatch?: DispatchSpec[];
  /** The front door's routes (http and libp2p rows) and reads for code genesis (#40; default STOCK_HTTP, STOCK_READS; the reads folded into the rows, #115). */
  routes?: PathRowSpec[];
  reads?: ReadSpec[];
  /** Feeds the host holds for the instance (code genesis; a tree's config names its own). */
  feeds?: FeedSpec[];
  /** Code genesis (#51): libp2p for the instance (a tree's config names its own), and extra routes after the stock ones. */
  libp2p?: Libp2pSpec;
  extraRoutes?: PathRowSpec[];
  /** Write scopes of genesis-wired programs beyond STOCK_SCOPES (#77): program name → head names (a prefix ends in `/`). */
  scopes?: Record<string, string[]>;
  /** A mailbox instance (#40): only the front door and the messagebox, keeping mail for `owner` from anyone. */
  mailbox?: boolean;
  /** The owner's messagebox URL (#40): the one peer a genesis names (`defaults.ownerMessagebox`). */
  ownerMessagebox?: string;
  /** Where the instance's own domain resolves (`defaults.resolveOrigin`): the host's origin in dev. */
  resolveOrigin?: string;
  /**
   * The address book's seed (#70): the host's providers (their keys, `local`,
   * address = name; #126: no role) and, when the host knows it, the owner's mailbox. Written
   * into the head `peers` when the genesis is processed.
   */
  addressBook?: AddressSeed[];
  /**
   * The host's providers by name (hex keys: fetch, waker, cron, libp2p,
   * status), for a row's sender written `$<name>` (#65: `$status`, the
   * status provider; #69: `$cron`). A row naming a provider this host has
   * not is left out (a tree may take statuses on a host with no Arcade).
   */
  providers?: Record<string, string>;
}

/** One address book entry a genesis seeds (#70): key → transport and address. */
export interface AddressSeed { key: Uint8Array; transport: "mailbox" | "libp2p" | "local"; address: string; handle?: string; domain?: string }

/**
 * A box's row (a `mailbox` dispatch row) as a system tree wrote it before #77 (etc/subscriptions.json, the file keeping its old name),
 * still read: the sender is an identity key in hex, `$owner` / `$infer` (the
 * host's), a provider's `$<name>` (`$status`, `$cron`: Genesis2Config.providers),
 * or absent (anyone); the handler a program name (bin/<name>) or a
 * program record's CID. It becomes a `mailbox` row.
 */
export interface BoxRowSpec { sender?: string; box?: string; handler: string }

/**
 * A dispatch row as a system writes it (etc/dispatch.json, #77): `transport`
 * defaults to `mailbox`; `address` a box (`*`: any box), an HTTP path (with
 * `prefix: true` for a prefix), a libp2p topic or `/<protocol>`; `sender`
 * `*` (default), `event` (#79: events only — the host's wiring, never a
 * message), `session` (an HTTP row needing a BRC-103/104 session), a key
 * in hex, `$owner`, `$self` (#79: the instance's own identity — another of
 * its programs, by the host's loopback), `$infer` or a provider's `$<name>`; `program` a program
 * name (bin/<name>), a program record's CID, or `kernel` (an admin
 * row: `fn` the operation — objects, head, dispatch, peers); `fn` a handler's
 * function; anything else a handler's own setting (a file handler's `root`, `index`;
 * a route's `read` op).
 */
export interface DispatchSpec { transport?: Transport; address: string; prefix?: boolean; sender?: string; program: string; fn?: string; [setting: string]: unknown }

/**
 * The kernel's admin operations (#77), one per table. Every genesis carries
 * the owner's admin rows — `{address: <op>, sender: $owner, program: kernel,
 * fn: <op>}` — ahead of its own (#31: a bare genesis is the four tables and
 * the owner's admin rows; a bundle adds what its apps ask for). Delegating
 * is another row with the same operation and another sender, sent to the
 * `dispatch` box.
 */
export const ADMIN_OPS = ["objects", "head", "dispatch", "peers"] as const;
export const ADMIN_ROWS: DispatchSpec[] = ADMIN_OPS.map((op): DispatchSpec => ({ address: op, sender: "$owner", program: "kernel", fn: op }));
/** What a kernel row may name: the admin operations, the claim (#89), and billing (#130: the host row, which the host's wake comes in on, billing.ts). */
export const KERNEL_OPS = [...ADMIN_OPS, "claim", "billing"] as const;

/**
 * The claim row (#89): an image's one wildcard row to the kernel. A message
 * in box `claim`, from anyone: its sender is the owner (#127) — in one step
 * the kernel writes the sender's four admin rows and removes this row (a
 * second claim finds no row). The owner's own message (`skein plan claim`),
 * or a claim the owner signed before the instance existed, which the host's
 * instance manager forwards as its first entry before the hostname is
 * published (Router.createInstance).
 */
export const CLAIM_ROW: DispatchSpec = { address: "claim", sender: "*", program: "kernel", fn: "claim" };

/**
 * The stock seed (#77), after the admin rows: the reserved box the host
 * admits into, `:ack` (the messagebox moves a reader's pointer); and the
 * stock HTTP rows (STOCK_HTTP). No `run`, no `chat` (#83): the shell and the
 * chat loop are apps (shruggr/skein-shell, shruggr/skein-chat), installed
 * like any other; a genesis has no shell. No `register` box (#40):
 * registration is application wiring — an application that wants senders to
 * enter themselves in the address book writes its own row (e.g. `{address:
 * "register", program: "resolve"}`, the resolve program's claim handler, or a
 * program of its own with its own rules) in its etc/dispatch.json.
 */
export const STOCK_DISPATCH: DispatchSpec[] = [
  { address: ":ack", program: "messagebox" },
];

/**
 * A mailbox instance's seed (#40): the messagebox's acknowledgements, and
 * every message from anyone in any box to the messagebox (kept for the owner;
 * a mailbox exists only where such a row does).
 */
export const MAILBOX_DISPATCH: DispatchSpec[] = [
  { address: ":ack", program: "messagebox" },
  { address: "*", program: "messagebox" },
];

/**
 * The write scopes of the stock genesis-wired programs (#77): the heads each
 * may advance, by program name. The front door's sessions; the messagebox's
 * lists (#126: its outbound sessions are the kernel's, authfetch); the wallet's records (#79: `wallet/…`, its
 * coins, actions, drafts and outputs — the chain is the chain app's). The
 * resolve program's records (#87: `resolve/peers`, what a BRC-169 lookup
 * found — never the address book, which only the owner's `peers` messages
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

/**
 * A path's row (an `http` or `libp2p` dispatch row) as a system wrote it before #77 (etc/routes.json, #40, the file keeping its old name),
 * still read: an exact `path` or a `prefix`, the handler program (a bin/ name
 * or a CID) and its function; `auth: "none"` for an open route (sender `*`,
 * else `session`); `read` an op the reads must allow the caller (folded
 * into the row's sender at genesis, #115: foldReads).
 * `root` and `index` are a file handler's (#52, #125: skein-sdk `files`), carried on the row. A
 * `libp2p:<topic>` or `libp2p:/<protocol>` path is a `libp2p` row.
 */
export interface PathRowSpec { path?: string; prefix?: string; program: string; fn: string; auth?: "none"; read?: string; root?: string; index?: string }
/**
 * A read permission as a system writes it (etc/reads.json, the form before
 * #115, still read): a caller (hex or `$owner`; absent: anyone with a
 * session) may call routes marked `read: op`. `owner: true` (#92) is the
 * instance's owner as the kernel sees it at the request (the genesis's, else
 * the claim's): how an image, which names no owner, gives its owner the
 * explorer. Folded into the rows at genesis (foldReads): the row's sender
 * becomes the caller (`owner: true` the owner's key; #121: nothing in an image — the claim writes the explorer row with the owner's key); the genesis carries
 * no `reads`.
 */
export interface ReadSpec { caller?: string; owner?: true; op: string }

/**
 * The stock HTTP rows (#40): the BRC-33 messagebox, at the root and under
 * /messagebox (where older clients were pointed), on a session; the
 * explorer's read route (the front door's `explore`: log, threads, heads,
 * records as JSON) behind the read op `explore`.
 */
export const STOCK_HTTP: PathRowSpec[] = [
  ...["", "/messagebox"].flatMap((p) => [
    { path: `${p}/sendMessage`, program: "messagebox", fn: "sendMessage" },
    { path: `${p}/listMessages`, program: "messagebox", fn: "listMessages" },
    { path: `${p}/acknowledgeMessage`, program: "messagebox", fn: "acknowledgeMessage" },
  ]),
  { prefix: "/explore", program: "frontdoor", fn: "explore", read: "explore" },
];

/** The stock reads (#40): the owner may explore (folded into the explorer's row: sender the owner's key). */
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
  /** libp2p (#51): the topics the host subscribes for the instance, the protocols it serves, the node's own listen addresses. */
  libp2p?: Libp2pSpec;
  /** Write scopes of the tree's genesis-wired programs (#77), over STOCK_SCOPES: program name → head names (a prefix ends in `/`). */
  scopes?: Record<string, string[]>;
}

/**
 * libp2p as a system writes it (etc/config.json `libp2p`, #51): `topics` the
 * host's node subscribes (each message a front-door step; its `libp2p` row
 * comes from etc/dispatch.json or etc/routes.json), `protocols` it serves,
 * each naming its handler — a program (bin/ name or CID; fn "libp2p") or
 * {program, fn} — which becomes its row (unless the tree has one), `listen`
 * this node's addresses over the host's.
 */
export interface Libp2pSpec {
  topics?: string[];
  protocols?: Record<string, string | { program: string; fn?: string }>;
  listen?: string[];
}

/** A system resolved for one instance: what its genesis says besides who it is. */
export interface System {
  programs: Record<string, CID>;
  /** The dispatch table's seed (#77), senders and programs resolved. */
  dispatch: DispatchRow[];
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
}

/** A system's libp2p, checked: the genesis's `libp2p` and the routes its protocols add (those the tree lacks). */
export function libp2pIn(spec: Libp2pSpec | undefined, routes: PathRowSpec[]): { libp2p?: System["libp2p"]; routes: PathRowSpec[] } {
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

/** A key as a system writes it: hex, or `$owner` / `$self` / `$infer` (the host's), or a provider's `$<name>` (Genesis2Config.providers). */
export function keyOf(s: string, c: Pick<Genesis2Config, "owner" | "infer" | "providers"> & { identity?: string }): Uint8Array {
  if (s === "$owner") {
    if (!c.owner) throw new Error("$owner: an image names no owner (#89: the owner comes with the claim)");
    return keyBytes(c.owner);
  }
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

/** A row's `$<name>` that this host has no provider for: the row is left out. */
export class NoProvider extends Error {
  readonly provider: string;
  constructor(provider: string) { super(`no provider ${provider} on this host`); this.provider = provider; }
}

/**
 * A row's sender resolved (`*` anyone, `event`, `session`, a key), or null
 * when it names a provider this host has not, or (#121) `owner` in an image:
 * left out, with a warning. Every sender is a key: `owner` (#115's symbol)
 * is the owner's key when the genesis names one; an image's owner comes with
 * the claim, which writes the owner's explorer row itself.
 */
function senderOf(sender: string | undefined, c: Genesis2Config): Sender | null {
  if (!sender || sender === "*") return "*";
  if (sender === "session") return "session";
  if (sender === "owner") {
    if (c.owner) return keyBytes(c.owner);
    c.warn?.("a dispatch row from \"owner\" is left out: an image names no owner (#121: the claim writes the owner's explorer row with the owner's key)");
    return null;
  }
  if (sender === "event") return "event";
  try { return keyOf(sender, c); } catch (e) {
    if (!(e instanceof NoProvider)) throw e;
    c.warn?.(`a dispatch row from ${sender} is left out: this host has no such provider`);
    return null;
  }
}

/** The program a spec names: by name in `programs`, else a CID; `kernel` for an admin row. */
function programOf(h: string, programs: Record<string, CID>, what: string): CID | "kernel" | undefined {
  if (h === "kernel") return "kernel";
  const p = programs[h];
  if (p) return p;
  try { return parseCid(h); } catch { return undefined; } // neither a program's name nor a CID: the caller refuses the row and says so
}

const isBox = (b: unknown): b is string => typeof b === "string" && b.length > 0 && !/[\s\0]/.test(b);

/** The rows of a tree's subscriptions (etc/subscriptions.json, the form before #77): each a `mailbox` row. */
export function rowsOfBoxSpecs(subs: BoxRowSpec[], c: Genesis2Config, programs: Record<string, CID>): DispatchRow[] {
  const out: DispatchRow[] = [];
  for (const s of subs) {
    if (!s || typeof s.handler !== "string" || (s.box !== undefined && !isBox(s.box)) || (s.sender !== undefined && typeof s.sender !== "string")) {
      throw new Error(`etc/subscriptions.json: bad entry ${JSON.stringify(s)} (want {sender?, box?, handler})`);
    }
    const program = programOf(s.handler, programs, "handler");
    if (!program) throw new Error(`subscription handler ${JSON.stringify(s.handler)}: no such program (bin/${s.handler}.wasm or bin/${s.handler}.cid) and not a CID`);
    const sender = senderOf(s.sender, c);
    if (sender === null) continue;
    out.push({ transport: "mailbox", address: s.box ?? "*", sender, program });
  }
  return out;
}

/** The rows of a tree's routes (etc/routes.json, the form before #77): `http` rows, or `libp2p` rows for `libp2p:` paths. A route to a program the system lacks is dropped. */
export function rowsOfPathSpecs(routes: PathRowSpec[], programs: Record<string, CID>): DispatchRow[] {
  const out: DispatchRow[] = [];
  for (const r of routes) {
    if (!r || typeof r.fn !== "string" || typeof r.program !== "string" || (typeof r.path === "string") === (typeof r.prefix === "string")) {
      throw new Error(`etc/routes.json: bad route ${JSON.stringify(r)} (want {path | prefix, program, fn, auth?, read?})`);
    }
    const program = programOf(r.program, programs, "route");
    if (!program || program === "kernel") continue;
    const at = (r.path ?? r.prefix)!;
    const settings = { ...(r.read ? { read: r.read } : {}), ...(typeof r.root === "string" ? { root: r.root } : {}), ...(typeof r.index === "string" ? { index: r.index } : {}) };
    if (at.startsWith("libp2p:")) out.push({ transport: "libp2p", address: at.slice("libp2p:".length), sender: "*", program, fn: r.fn, ...settings });
    else out.push({ transport: "http", address: at, ...(r.prefix !== undefined ? { prefix: true } : {}), sender: r.auth === "none" ? "*" : "session", program, fn: r.fn, ...settings });
  }
  return out;
}

/** The rows of a system's dispatch specs (etc/dispatch.json, #77), senders and programs resolved; a row to a program the system lacks is dropped. */
export function rowsOf(specs: DispatchSpec[], c: Genesis2Config, programs: Record<string, CID>): DispatchRow[] {
  const out: DispatchRow[] = [];
  for (const s of specs) {
    if (!s || typeof s !== "object" || !isBox(s.address) || typeof s.program !== "string") throw new Error(`etc/dispatch.json: bad row ${JSON.stringify(s)} (want {transport?, address, prefix?, sender?, program, fn?, …})`);
    const transport = s.transport ?? "mailbox";
    if (!["mailbox", "http", "libp2p", "local"].includes(transport)) throw new Error(`etc/dispatch.json: row ${s.address}: transport ${JSON.stringify(transport)} is not mailbox, http, libp2p or local`);
    const program = programOf(s.program, programs, "row");
    if (!program) continue;
    if (program === "kernel" && (typeof s.fn !== "string" || !(KERNEL_OPS as readonly string[]).includes(s.fn))) throw new Error(`etc/dispatch.json: row ${s.address}: a kernel row's fn is one of ${KERNEL_OPS.join(", ")}`);
    const sender = senderOf(s.sender, c);
    if (sender === null) continue;
    const { transport: _t, address, prefix, sender: _s, program: _p, fn, ...settings } = s;
    void _t; void _s; void _p;
    out.push({ transport, address, ...(prefix ? { prefix: true } : {}), sender, program, ...(fn ? { fn } : {}), ...settings });
  }
  return out;
}

/** A read permission resolved for one instance (`$owner` to its key). */
export type Read = { caller?: Uint8Array; owner?: true; op: string };

/** Reads resolved for one instance (`$owner` to its key). */
export function resolveReads(c: Pick<Genesis2Config, "owner" | "infer">, reads: ReadSpec[] = []): Read[] {
  const rs: Read[] = [];
  for (const r of reads) {
    if (!r || typeof r.op !== "string") throw new Error(`etc/reads.json: bad entry ${JSON.stringify(r)} (want {caller?, op} or {owner: true, op})`);
    if (r.owner !== undefined && (r.owner !== true || r.caller !== undefined)) throw new Error(`etc/reads.json: bad entry ${JSON.stringify(r)} (owner: true names no caller)`);
    rs.push({ ...(r.owner ? { owner: true as const } : r.caller && r.caller !== "*" ? { caller: keyOf(r.caller, c) } : {}), op: r.op });
  }
  return rs;
}

/**
 * The reads folded into the rows (#115): an http row naming a `read` op (and
 * a sender other than `*`, which no read ever limited) becomes one row per
 * read that allows the op — its sender the read's caller, the owner's key for
 * `owner: true` (#121: an image, no owner, leaves the row out — the claim writes the owner's explorer row), the row's own for a read with no caller — without the
 * `read`. A row whose sender is a key keeps it only for a read with no
 * caller, that caller, or `owner: true` when the key is the owner's. A row no
 * read allows is left out (nobody could call it). The rest are unchanged.
 */
export function foldReads(rows: DispatchRow[], reads: Read[], owner?: string): DispatchRow[] {
  const out: DispatchRow[] = [];
  const push = (r: DispatchRow) => { if (!out.some((x) => rowKey(x) === rowKey(r))) out.push(r); };
  for (const r of rows) {
    if (r.transport !== "http" || typeof r.read !== "string" || r.sender === "*") { out.push(r); continue; }
    const { read: op, ...row } = r;
    for (const x of reads) {
      if (x.op !== op && x.op !== "*") continue;
      // #121: every sender is a key — `owner: true` is the owner's key; an image (no owner) leaves the row out (the claim writes the owner's explorer row).
      if (x.owner && !owner) continue;
      const sender = x.owner ? keyBytes(owner!) : x.caller ?? row.sender;
      if (row.sender instanceof Uint8Array) {
        const k = keyHex(row.sender);
        if (x.owner ? k === owner : x.caller === undefined || keyHex(x.caller) === k) push(row as DispatchRow);
      } else push({ ...row, sender } as DispatchRow);
    }
  }
  return out;
}

/**
 * Resolve a system's rows, config and programs for one instance (both genesis
 * paths). `subs` and `routes` are the forms before #77 (a tree's
 * etc/subscriptions.json and etc/routes.json); `specs` its etc/dispatch.json.
 * The order: the owner's admin rows (every genesis), the dispatch specs, the
 * subscriptions, the host's extra rows, then the routes (and the protocols'
 * rows): first match wins in the kernel. A row with an admin row's key is
 * left out (the kernel's operation keeps the box), with a warning.
 */
export function resolveSystem(c: Genesis2Config, programs: Record<string, CID>, subs: BoxRowSpec[], config: ConfigSpec = {}, tree?: CID, routes: PathRowSpec[] = STOCK_HTTP, reads: ReadSpec[] = STOCK_READS, specs: DispatchSpec[] = []): System {
  if ((config as { jobs?: unknown }).jobs !== undefined) throw new Error("etc/config.json: `jobs` are gone (#69): a schedule is a program's message to the cron provider ({fn: \"tick\", every | at, box, body?, name}, docs/MESSAGES.md)");
  if (config.scopes !== undefined && (typeof config.scopes !== "object" || Array.isArray(config.scopes) || Object.values(config.scopes).some((v) => !Array.isArray(v) || v.some((h) => typeof h !== "string" || !h)))) throw new Error("etc/config.json: scopes is {<program name>: [<head name | prefix/>]}");
  const p2p = libp2pIn(config.libp2p ?? c.libp2p, [...routes, ...(c.extraRoutes ?? [])]);
  // An image (#89: no owner) has no admin rows: its claim row brings them.
  const admin = c.owner ? rowsOf(ADMIN_ROWS, c, programs) : [];
  const dispatch: DispatchRow[] = [...admin];
  for (const r of [
    ...rowsOf(specs, c, programs),
    ...rowsOfBoxSpecs(subs, c, programs),
    ...rowsOfBoxSpecs((c.subscriptions ?? []).map((x) => ({ ...(x.sender ? { sender: x.sender } : {}), box: x.box, handler: x.handler.toString() })), c, programs),
    ...rowsOf(c.dispatch ?? [], c, programs),
    ...rowsOfPathSpecs(p2p.routes, programs),
  ]) {
    if (admin.some((a) => rowKey(a) === rowKey(r))) { if (r.program !== "kernel") c.warn?.(`a dispatch row for the admin box ${r.address} is left out: the kernel's ${r.address} operation keeps it`); continue; }
    dispatch.push(r);
  }
  // The reads are resolved only for rows that name a read op (an image's tree has none, and no `$owner`).
  const rows = dispatch.some((r) => typeof r.read === "string") ? foldReads(dispatch, resolveReads(c, reads), c.owner) : dispatch;
  let names: System["names"] = c.owner ? [{ identityKey: keyBytes(c.owner), ...(c.ownerHandle ?? { handle: "david", domain: "localhost" }) }] : [];
  if (c.infer) names.push({ identityKey: keyBytes(c.infer), ...(c.inferHandle ?? { handle: "infer", domain: "localhost" }) });
  if (config.names) names = config.names.map((n) => ({ identityKey: keyOf(n.identityKey, c), handle: n.handle, domain: n.domain }));
  const peers = config.peers
    ? Object.fromEntries(Object.entries(config.peers).map(([role, k]) => [role, keyOf(k, c)]))
    : c.infer ? { infer: keyBytes(c.infer) } : undefined;
  return {
    programs, dispatch: rows, scopes: { ...STOCK_SCOPES, ...c.scopes, ...config.scopes }, ...(peers ? { peers } : {}),
    defaults: mergeDefaults(c, { ...(config.owner?.messagebox ? { ownerMessagebox: config.owner.messagebox } : {}), ...config.defaults }),
    names, collect: config.collect ?? ["completions"], ...(tree ? { tree } : {}),
    ...(feedsIn(config.feeds ?? c.feeds)),
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
    const s = resolveSystem({ ...c, defaults: undefined, overrides: undefined, infer: undefined, subscriptions: undefined, dispatch: undefined }, mine, [], { peers: {}, names: [] }, undefined, STOCK_HTTP, STOCK_READS, MAILBOX_DISPATCH);
    return { ...s, collect: [], defaults: { ...SESSION_DEFAULTS, ...c.defaults, ...c.overrides } };
  }
  const specs = STOCK_DISPATCH.filter((s) => programs[s.program]);
  // Code genesis has always taken the host's defaults whole (DEFAULTS when none).
  return { ...resolveSystem({ ...c, defaults: undefined, overrides: undefined }, programs, [], {}, undefined, c.routes ?? STOCK_HTTP, c.reads ?? STOCK_READS, specs), defaults: { ...SESSION_DEFAULTS, ...hostFacts(c), ...(c.defaults ? { ...c.defaults, ...c.overrides } : c.overrides ? { ...DEFAULTS, ...c.overrides } : DEFAULTS) } };
}

/** The genesis record: who the instance is, and its system. */
export function genesisRecord(c: Pick<Genesis2Config, "identity" | "owner" | "handle" | "domain" | "addressBook">, s: System): Record<string, unknown> {
  return {
    kind: "genesis", identity: keyBytes(c.identity), handle: c.handle, domain: c.domain, ...(c.owner ? { owner: keyBytes(c.owner) } : {}),
    ...(c.addressBook?.length ? { addressBook: c.addressBook.map((e) => ({ key: e.key, transport: e.transport, address: e.address, ...(e.handle ? { handle: e.handle } : {}), ...(e.domain ? { domain: e.domain } : {}) })) } : {}),
    programs: s.programs, dispatch: s.dispatch, ...(Object.keys(s.scopes).length ? { scopes: s.scopes } : {}), ...(s.peers ? { peers: s.peers } : {}),
    defaults: s.defaults, names: s.names, collect: s.collect, ...(s.tree ? { tree: s.tree } : {}), ...(s.feeds ? { feeds: s.feeds } : {}),
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
  return await k.store.log.append(await nextEntry(k.store, { genesis: g }, time) as never); // the kernel's log takes a format-8 entry; Store's type is format 1
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

// The app manifest (#72, #76, #77, #79; docs/APPS.md §2): `etc/app.json` in an
// app's tree, checked and normalised here for the install client (install.ts,
// `skein plan install`, #124). Pure: the tree is asked only whether a path exists.
//
// What the checks enforce (each failure is one line of ManifestError):
//
//   kind        "app"
//   name        lower-case [a-z0-9][a-z0-9._-]*: the app's box, and the prefix of every head it
//               writes (`<name>/app` its root); not a stock box, head or program name (objects,
//               head, dispatch, peers, main, wallet, kernel, frontdoor, messagebox, resolve; nor
//               the pre-#77 subscribe, routes, sessions)
//   version     semver
//   programs    role → "bin/<x>.wasm" | "bin/<x>.cid" (a file in the tree), a bare name: a
//               program the instance already has by name in its genesis, or (#83) a shell
//               program: {code: "shell", modules: {<command>: "bin/<x>.wasm"} (brush and
//               coreutils among them), support?: {<command>: {mount: <absolute path>, files:
//               {<path under mount>: <a file in the tree>}, env?: {<name>: <text>}}},
//               description?} — the record the kernel's shell runs (docs/APPS.md, "A shell
//               program"), its modules and support files this tree's
//   dispatch[]  the rows the app asks for (#77; the kernel's dispatch table, docs/MESSAGES.md):
//               {transport?: "mailbox" (default) | "http" | "libp2p", address, prefix?: true,
//                sender: "*" | "event" | "session" | "$owner" | "$self" | "$<provider>" | <key hex>, program: <role>,
//                fn?, …settings}. A mailbox row's address is a box relative to the app (#128):
//               "" or the app's name is the app's own box `<name>`, "x" the box `<name>/x` (an
//               empty, "." or ".." segment, whitespace or a control character is refused: no box
//               outside the app's); an http row's a path relative to /<name>/ (a leading "/" too:
//               "/submit" → "/<name>/submit", "/" → "/<name>/"; a ".." or "." segment, an
//               encoded dot or slash (%2e, %2f), a backslash, a NUL or a URL is refused: no row
//               reaches outside the app's prefix), with `prefix: true` for a prefix and `fn`
//               the handler's function; a libp2p row's a topic or "/<protocol>" (global, not
//               namespaced; sender "*"; fn required; exact — no prefix, #119: a topic the app
//               takes at run time is its subscription, emitted, not a row). "session" is for http rows only; "event"
//               (#79) for mailbox rows only: the box takes events (the host's wiring, a route's
//               admit), never a message; "$self" is the instance's own identity (another of its
//               apps, by the host's loopback: an overlay's own watch, the chain app's callers). `app` is
//               set by the install. The same key (transport, address, prefix, sender) twice is
//               refused. `optional: true` (a row from a `$<provider>` only, #78): left out by the
//               install when the instance's address book has no such provider (a note in the
//               prompt), as a genesis leaves out a row from a provider its host has not.
//   provides[]  {interface: "<name>/<major>", functions: {<fn>: {writes: bool, args?, answer?}}}
//               — `writes` required; `args`/`answer` shapes: a type name (string, int,
//               ms, bytes, cid, bool, map, any), [shape], or {key[?]: shape}
//   requires[]  "<name>/<major>"
//   start, stop {body: {…}}; `start` needs a row admitting the owner (or anyone) to the app's box
//   config      a map (the programs read it from the head's root record)
//   config.overlay   an overlay app (APPS.md §6): {topics?: {<topic>: <role>}, lookups?: {<service>:
//               <role> | {program: <role>, topics?: [<topic>]}}, gossip?: {<topic>: bool}}; the engine
//               is the role `overlay`. Its wiring is derived (overlayWiring) and added to the rows the
//               manifest names itself — an explicit row with the same key wins. `topics` may be absent
//               or empty: a dynamic overlay (Mandala, an AMM) registers its topics by a call at runtime
//               and the engine adds and drops their rows itself; a manifest may still pre-configure
//               topics (OpNS: one global topic). No prefix declarations (#120): any other field is refused.
//
//   The form before #77 (`handler`, `boxes`, `routes`, `heads`) is refused (#79): an app names
//   dispatch rows, and writes only heads under its own name.

export interface RowIn { transport?: "mailbox" | "http" | "libp2p"; address: string; prefix?: boolean; sender: string; program: string; fn?: string; optional?: true; [setting: string]: unknown }
export interface FunctionDecl { writes: boolean; args?: unknown; answer?: unknown }
export interface Provide { interface: string; functions: Record<string, FunctionDecl> }

export interface Manifest {
  kind: "app";
  name: string;
  version: string;
  programs: Record<string, string | Record<string, unknown>>;
  config?: Record<string, unknown>;
  provides?: Provide[];
  requires?: string[];
  dispatch?: RowIn[];
  start?: { body: Record<string, unknown> };
  stop?: { body: Record<string, unknown> };
  description?: string;
}

/** A shell program's support for one command (#25, #83): files mounted read-only at `mount` for that command only, env defaults. */
export interface ShellSupport { mount: string; files: Record<string, string>; env: Record<string, string> }
/** A shell program as the manifest names it (#83): its modules and support files, paths in the tree. */
export interface ShellSource { kind: "shell"; modules: Record<string, string>; support: Record<string, ShellSupport>; description?: string }

/** Where a role's program comes from. */
export type ProgramSource = { kind: "wasm" | "cid"; path: string; name: string } | { kind: "instance"; name: string } | ShellSource;

/** A row normalised: transport set, the address as written (relative for http), the sender as written, the program a role. */
export type Row = RowIn & { transport: "mailbox" | "http" | "libp2p" };

/** A manifest checked: the fields as installed. */
export interface Checked {
  manifest: Omit<Manifest, "dispatch"> & { dispatch: Row[]; provides: Provide[]; requires: string[] };
  sources: Record<string, ProgramSource>;
  /** What `config.overlay` added (APPS.md §6): row keys (rowKey). */
  derived: Derived;
}

export class ManifestError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) { super(`etc/app.json:\n  ${problems.join("\n  ")}`); this.problems = problems; }
}

export const RESERVED_NAMES = ["objects", "head", "dispatch", "peers", "claim", "subscribe", "routes", "main", "sessions", "wallet", "kernel", "frontdoor", "messagebox", "resolve", "billing", "tick"];
/** The fields of the form before #77, refused (#79). */
const LEGACY_FIELDS = ["handler", "boxes", "routes", "heads"];
const NAME = /^[a-z0-9][a-z0-9._-]*$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const INTERFACE = /^[a-z0-9][a-z0-9._-]*\/\d+$/;
const KEY = /^0[23][0-9a-f]{64}$/;
const TYPES = ["string", "int", "ms", "bytes", "cid", "bool", "map", "any"];

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isSender = (s: unknown): s is string => typeof s === "string" && (s === "*" || s === "event" || s === "session" || /^\$[a-z][a-z0-9_-]*$/.test(s) || KEY.test(s));

/** Why `shape` is not a shape (APPS.md §2), or undefined. */
export function shapeProblem(shape: unknown, at: string): string | undefined {
  if (typeof shape === "string") return TYPES.includes(shape) ? undefined : `${at}: unknown type ${JSON.stringify(shape)} (${TYPES.join(", ")}, [shape], {key: shape})`;
  if (Array.isArray(shape)) return shape.length === 1 ? shapeProblem(shape[0], `${at}[]`) : `${at}: an array shape names one element shape`;
  if (isMap(shape)) {
    for (const [k, v] of Object.entries(shape)) { const p = shapeProblem(v, `${at}.${k}`); if (p) return p; }
    return undefined;
  }
  return `${at}: a shape is a type name, [shape] or {key: shape}`;
}

/**
 * An http row's path as served: relative to /<app>/ (a leading "/" too). Throws
 * on anything that could name a path outside that prefix.
 */
export function appPath(app: string, p: string): string {
  if (typeof p !== "string") throw new Error("not text");
  if (/^[a-z][a-z0-9+.-]*:/i.test(p)) throw new Error(`${JSON.stringify(p)} is a URL or a scheme, not a path under /${app}/`);
  if (/[\\\0?#]/.test(p) || /%(2e|2f|5c|00)/i.test(p)) throw new Error(`${JSON.stringify(p)}: a backslash, NUL, query, fragment or an encoded dot or slash`);
  const segs = p.split("/");
  if (segs.some((s) => s === ".." || s === ".")) throw new Error(`${JSON.stringify(p)}: a "." or ".." segment`);
  const rest = p.replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  return `/${app}/${rest}`;
}

/**
 * A mailbox row's box as the kernel's table holds it (#128): relative to the app, as an http
 * path is — "" or the app's own name is the app's box `<app>`; "x" is `<app>/x`. Throws on a
 * box that is not one: an empty, "." or ".." segment (a leading, trailing or doubled "/"),
 * whitespace or a control character, or more than 128 bytes resolved (the messagebox
 * server's limit).
 */
export function appBox(app: string, b: string): string {
  if (typeof b !== "string") throw new Error("not text");
  if (b === "" || b === app) return app;
  if (/[\s\0-\x1f\x7f]/.test(b)) throw new Error(`box ${JSON.stringify(b)}: whitespace or a control character`);
  if (b.split("/").some((s) => s === "" || s === "." || s === "..")) throw new Error(`box ${JSON.stringify(b)}: an empty, "." or ".." segment (no box outside ${app}/)`);
  const box = `${app}/${b}`;
  if (new TextEncoder().encode(box).length > 128) throw new Error(`box ${JSON.stringify(box)}: more than 128 bytes`);
  return box;
}

/** A row's address as served: an http path under /<app>/ (appPath); a box under the app's (appBox); a libp2p name as written. */
export function rowAddress(app: string, r: { transport: string; address: string }): string {
  return r.transport === "http" ? appPath(app, r.address) : r.transport === "mailbox" ? appBox(app, r.address) : r.address;
}

/** A row's key as the kernel's table knows it: `<transport> <address as served>[*] <sender>`. */
export function rowKey(app: string, r: { transport: string; address: string; prefix?: boolean; sender: string }): string {
  return `${r.transport} ${rowAddress(app, r)}${r.prefix ? "*" : ""} ${r.sender}`;
}

/** Why a row is not one (checked against the roles and the app's name), or undefined. */
function rowProblem(app: string, r: unknown, isRole: (role: unknown) => role is string): string | undefined {
  if (!isMap(r)) return "not a map";
  const t = r.transport ?? "mailbox";
  if (t !== "mailbox" && t !== "http" && t !== "libp2p") return `transport ${JSON.stringify(t)} is not mailbox, http or libp2p`;
  if (typeof r.address !== "string" || (!r.address && t !== "mailbox")) return "address is not text";
  if (t === "mailbox") {
    try { appBox(app, r.address); } catch (e) { return (e as Error).message; }
    if (r.prefix !== undefined) return "a mailbox row has no prefix";
  } else if (t === "http") {
    try { appPath(app, r.address); } catch (e) { return (e as Error).message; }
    if (r.prefix !== undefined && r.prefix !== true) return "prefix is true or absent";
    if (typeof r.fn !== "string" || !r.fn) return "fn is not text (an http row names its handler's function)";
  } else {
    if (/[\s\0]/.test(r.address)) return `address ${JSON.stringify(r.address)} is not a topic or /protocol`;
    if (r.prefix !== undefined) return "a libp2p row has no prefix";
    if (typeof r.fn !== "string" || !r.fn) return "fn is not text (a libp2p row names its handler's function)";
    if (r.sender !== undefined && r.sender !== "*") return "a libp2p row's sender is \"*\" (GossipSub messages are signed; streams are Noise)";
  }
  if (!isSender(r.sender)) return `sender ${JSON.stringify(r.sender)} is not "*", "event", "session", "$owner", "$self", "$<provider>" or an identity key (hex)`;
  if (r.sender === "session" && t !== "http") return "sender \"session\" is for http rows";
  if (r.sender === "event" && t !== "mailbox") return "sender \"event\" is for mailbox rows (a box events are admitted into)";
  if (!isRole(r.program)) return `program ${JSON.stringify(r.program)} is not a role in programs`;
  if (r.fn !== undefined && (typeof r.fn !== "string" || !r.fn)) return "fn is not text";
  if (r.app !== undefined) return "app is set by the install";
  if (r.optional !== undefined && r.optional !== true) return "optional is true or absent";
  if (r.optional === true && !(typeof r.sender === "string" && r.sender.startsWith("$") && r.sender !== "$owner" && r.sender !== "$self")) return "optional is for a row from a $<provider> (left out when the address book has none)";
  return undefined;
}

/** Check and normalise a manifest. `has(path)`: whether the tree has a file at the path. */
export function checkManifest(json: unknown, has: (path: string) => boolean): Checked {
  const bad: string[] = [];
  if (!isMap(json)) throw new ManifestError(["not a JSON object"]);
  const m = json as Partial<Manifest> & Record<string, unknown>;
  if (m.kind !== "app") bad.push(`kind: want "app"`);
  const name = typeof m.name === "string" ? m.name : "";
  if (!NAME.test(name)) bad.push(`name: ${JSON.stringify(m.name)} is not a name ([a-z0-9][a-z0-9._-]*)`);
  else if (RESERVED_NAMES.includes(name)) bad.push(`name: ${name} is a stock box, head or program of the instance`);
  const app = name || "app";
  if (typeof m.version !== "string" || !SEMVER.test(m.version)) bad.push(`version: ${JSON.stringify(m.version)} is not semver`);
  if (m.description !== undefined && typeof m.description !== "string") bad.push("description: not text");
  if (m.config !== undefined && !isMap(m.config)) bad.push("config: not a map");

  // programs
  const sources: Record<string, ProgramSource> = {};
  if (!isMap(m.programs)) bad.push("programs: want {role: \"bin/<x>.wasm\" | \"bin/<x>.cid\" | <an instance program's name> | {code: \"shell\", modules, support?}}");
  else for (const [role, p] of Object.entries(m.programs)) {
    if (isMap(p)) {
      const sh = shellSource(p, has, `programs.${role}`);
      if (Array.isArray(sh)) bad.push(...sh);
      else sources[role] = sh;
      continue;
    }
    const file = typeof p === "string" ? /^bin\/([A-Za-z0-9._-]+)\.(wasm|cid)$/.exec(p) : null;
    if (file) {
      if (!has(p as string)) bad.push(`programs.${role}: ${p} is not in the tree`);
      sources[role] = { kind: file[2] as "wasm" | "cid", path: p as string, name: file[1]! };
    } else if (typeof p === "string" && /^[a-z0-9][a-z0-9_-]*$/.test(p)) sources[role] = { kind: "instance", name: p };
    else bad.push(`programs.${role}: ${JSON.stringify(p)} is not bin/<x>.wasm, bin/<x>.cid, a program name or a shell program`);
  }
  const isRole = (r: unknown): r is string => typeof r === "string" && r in sources;

  for (const f of LEGACY_FIELDS) if (m[f] !== undefined) bad.push(`${f}: the form before #77 is gone (#79): name dispatch rows, and write only heads under the app's name`);
  const rows: Row[] = [];
  const addRow = (r: Row, at: string) => {
    const k = rowKey(app, r);
    if (rows.some((x) => rowKey(app, x) === k)) { bad.push(`${at}: ${k} twice`); return; }
    rows.push(r);
  };

  // dispatch (#77)
  if (m.dispatch !== undefined && !Array.isArray(m.dispatch)) bad.push("dispatch: not a list");
  for (const [i, r] of (Array.isArray(m.dispatch) ? m.dispatch : []).entries()) {
    const why = rowProblem(app, r, isRole);
    if (why) { bad.push(`dispatch[${i}]: ${why}`); continue; }
    const row = r as RowIn;
    addRow({ ...row, transport: row.transport ?? "mailbox" }, `dispatch[${i}]`);
  }

  // provides, requires
  const provides: Provide[] = [];
  if (m.provides !== undefined && !Array.isArray(m.provides)) bad.push("provides: not a list");
  for (const [i, p] of (Array.isArray(m.provides) ? m.provides : []).entries()) {
    if (!isMap(p) || typeof p.interface !== "string" || !INTERFACE.test(p.interface)) { bad.push(`provides[${i}]: interface is not <name>/<major>`); continue; }
    if (!isMap(p.functions) || !Object.keys(p.functions).length) { bad.push(`provides[${i}] (${p.interface}): functions is a non-empty map`); continue; }
    for (const [f, d] of Object.entries(p.functions)) {
      const at = `provides[${i}].${p.interface}.${f}`;
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(f)) bad.push(`${at}: not a function name`);
      if (!isMap(d) || typeof d.writes !== "boolean") { bad.push(`${at}: writes (true | false) is required`); continue; }
      for (const k of ["args", "answer"] as const) if (d[k] !== undefined) { const why = shapeProblem(d[k], `${at}.${k}`); if (why) bad.push(why); }
    }
    provides.push(p as unknown as Provide);
  }
  const requires: string[] = [];
  if (m.requires !== undefined && !Array.isArray(m.requires)) bad.push("requires: not a list");
  for (const r of Array.isArray(m.requires) ? m.requires : []) {
    if (typeof r !== "string" || !INTERFACE.test(r)) bad.push(`requires: ${JSON.stringify(r)} is not <name>/<major>`);
    else requires.push(r);
  }

  // config.overlay: the overlay app's wiring, derived (APPS.md §6), under what the manifest names itself.
  const derived: Derived = { rows: [] };
  const ov = isMap(m.config) ? m.config.overlay : undefined;
  if (ov !== undefined) {
    const w = overlayWiring(app, ov, (r) => isRole(r));
    if (Array.isArray(w)) bad.push(...w.map((p) => `config.overlay: ${p}`));
    else {
      const have = new Set(rows.map((r) => rowKey(app, r)));
      for (const r of w.rows) if (!have.has(rowKey(app, r))) { rows.push(r); derived.rows.push(rowKey(app, r)); }
    }
  }

  // start, stop
  for (const k of ["start", "stop"] as const) {
    if (m[k] === undefined) continue;
    if (!isMap(m[k]) || !isMap((m[k] as { body?: unknown }).body)) bad.push(`${k}: want {body: {…}}`);
  }
  if (m.start !== undefined || m.stop !== undefined) {
    const own = rows.filter((r) => r.transport === "mailbox" && rowAddress(app, r) === name);
    if (!own.length) bad.push(`start/stop go into the app's box: dispatch must have a mailbox row for ${name}`);
    else if (!own.some((r) => r.sender === "*" || r.sender === "$owner")) bad.push(`start/stop are the owner's: a row for box ${name} must admit "$owner" or "*"`);
  }

  if (bad.length) throw new ManifestError(bad);
  const { dispatch: _d, ...rest } = m as Manifest;
  void _d;
  const out = { ...rest, dispatch: rows, provides, requires };
  return { manifest: out, sources, derived };
}

// ---------------------------------------------------------------- a shell program (#83; APPS.md "A shell program")

const COMMAND = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
/** A path in the tree: relative, no "." or ".." segment, no backslash or NUL. */
const isTreePath = (p: unknown): p is string => typeof p === "string" && p.length > 0 && !p.startsWith("/") && !/[\\\0]/.test(p) && p.split("/").every((x) => x !== "" && x !== "." && x !== "..");

/**
 * A shell program as the manifest names it (#83), checked: `code: "shell"`;
 * `modules` command → bin/<x>.wasm in the tree, brush and coreutils among
 * them (every other name a command the shell runs; two names may share a
 * module: `node` is qjs); `support` per command of `modules`: an absolute
 * `mount`, `files` (path under the mount → a file in the tree), `env` text →
 * text. The install turns it into the record the kernel's shell runs.
 */
export function shellSource(p: Record<string, unknown>, has: (path: string) => boolean, at: string): ShellSource | string[] {
  const bad: string[] = [];
  if (p.code !== "shell") return [`${at}: a program given as a map is a shell program: {code: "shell", modules, support?}`];
  for (const k of Object.keys(p)) if (!["code", "modules", "support", "description"].includes(k)) bad.push(`${at}.${k}: not a field of a shell program (code, modules, support, description)`);
  if (p.description !== undefined && typeof p.description !== "string") bad.push(`${at}.description: not text`);
  const modules: Record<string, string> = {};
  if (!isMap(p.modules)) bad.push(`${at}.modules: want {<command>: "bin/<x>.wasm"}`);
  else {
    for (const [cmd, path] of Object.entries(p.modules)) {
      if (!COMMAND.test(cmd)) bad.push(`${at}.modules: ${JSON.stringify(cmd)} is not a command name`);
      else if (typeof path !== "string" || !/^bin\/[A-Za-z0-9._-]+\.wasm$/.test(path)) bad.push(`${at}.modules.${cmd}: ${JSON.stringify(path)} is not bin/<x>.wasm`);
      else if (!has(path)) bad.push(`${at}.modules.${cmd}: ${path} is not in the tree`);
      else modules[cmd] = path;
    }
    for (const need of ["brush", "coreutils"]) if (!(need in p.modules)) bad.push(`${at}.modules: no ${need} (the shell is brush over coreutils)`);
  }
  const support: Record<string, ShellSupport> = {};
  if (p.support !== undefined && !isMap(p.support)) bad.push(`${at}.support: want {<command>: {mount, files, env?}}`);
  for (const [cmd, x] of Object.entries(isMap(p.support) ? p.support : {})) {
    const where = `${at}.support.${cmd}`;
    if (!isMap(p.modules) || !(cmd in p.modules)) { bad.push(`${where}: ${cmd} is not a command in modules`); continue; }
    if (!isMap(x)) { bad.push(`${where}: want {mount, files, env?}`); continue; }
    if (typeof x.mount !== "string" || !x.mount.startsWith("/") || x.mount.split("/").some((s) => s === "." || s === "..")) bad.push(`${where}.mount: not an absolute path`);
    const files: Record<string, string> = {};
    if (!isMap(x.files)) bad.push(`${where}.files: want {<path under the mount>: <a file in the tree>}`);
    else for (const [under, path] of Object.entries(x.files)) {
      if (!isTreePath(under)) bad.push(`${where}.files: ${JSON.stringify(under)} is not a relative path`);
      else if (!isTreePath(path) || !has(path)) bad.push(`${where}.files.${under}: ${JSON.stringify(path)} is not a file in the tree`);
      else files[under] = path;
    }
    const env: Record<string, string> = {};
    if (x.env !== undefined && !isMap(x.env)) bad.push(`${where}.env: want {<name>: <text>}`);
    for (const [k, v] of Object.entries(isMap(x.env) ? x.env : {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== "string") bad.push(`${where}.env.${k}: want a name and text`);
      else env[k] = v;
    }
    support[cmd] = { mount: String(x.mount), files, env };
  }
  if (bad.length) return bad;
  return { kind: "shell", modules, support, ...(typeof p.description === "string" ? { description: p.description } : {}) };
}

// ---------------------------------------------------------------- an overlay app's wiring (APPS.md §6)

/** The role of an overlay app's engine (its `config.overlay` is the engine's). */
export const OVERLAY_ROLE = "overlay";

/** What the install derived from `config.overlay` (row keys), for the prompt. */
export interface Derived { rows: string[] }

/** An overlay app's wiring. */
export interface OverlayWiring { rows: Row[]; topics: string[] }

const TOPIC = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
/** The fields of `config.overlay` (`status` is refused with its own reason). */
const OVERLAY_FIELDS = ["topics", "lookups", "gossip"];

/**
 * The wiring `config.overlay` asks for (APPS.md §6, #79), or its problems. For
 * each topic: the libp2p rows `<topic>` → submit, `<topic>-admit` →
 * peerAdmit, `<topic>-proof` → peerProof; the open http rows `/submit`,
 * `/lookup`; and the app's own box `<app>` twice: from `event` (what its
 * libp2p routes admit — a gossiped submission, a peer's admit) and from
 * `$self` (its own watch of a submission the chain app has accepted, sent by
 * the host's loopback). All to the role `overlay`, the engine. No `chain` or
 * `status` box (the chain app's), no grants: the engine writes `<app>/…`
 * only. No topics is accepted: the box rows, `/submit` and `/lookup` and no
 * per-topic rows — the topics registered at runtime get theirs from the
 * engine (#120). A field other than topics, lookups, gossip is refused (no
 * prefix declarations, #120). `isRole` tells which roles the manifest has.
 */
export function overlayWiring(app: string, ov: unknown, isRole: (role: string) => boolean): OverlayWiring | string[] {
  const bad: string[] = [];
  if (!isMap(ov)) return ["want {topics?, lookups?, gossip?}"];
  if (!isRole(OVERLAY_ROLE)) bad.push(`the engine is the role "${OVERLAY_ROLE}": programs has none`);
  const topics: string[] = [];
  if (ov.topics !== undefined && !isMap(ov.topics)) bad.push("topics: want {<topic>: <role>}");
  else for (const [t, role] of Object.entries(isMap(ov.topics) ? ov.topics : {})) {
    if (!TOPIC.test(t)) bad.push(`topics: ${JSON.stringify(t)} is not a topic name`);
    else if (typeof role !== "string" || !isRole(role)) bad.push(`topics.${t}: ${JSON.stringify(role)} is not a role in programs`);
    else topics.push(t);
  }
  const unknown = Object.keys(ov).filter((k) => !OVERLAY_FIELDS.includes(k) && k !== "status");
  if (unknown.length) bad.push(`${unknown.join(", ")}: not a field (want ${OVERLAY_FIELDS.join(", ")}; no prefix declarations, #120)`);
  if (ov.lookups !== undefined && !isMap(ov.lookups)) bad.push("lookups: want {<service>: <role> | {program: <role>, topics?: [<topic>]}}");
  for (const [service, l] of Object.entries(isMap(ov.lookups) ? ov.lookups : {})) {
    if (!TOPIC.test(service)) { bad.push(`lookups: ${JSON.stringify(service)} is not a service name`); continue; }
    const role = typeof l === "string" ? l : isMap(l) ? l.program : undefined;
    if (typeof role !== "string" || !isRole(role)) bad.push(`lookups.${service}: program ${JSON.stringify(role)} is not a role in programs`);
    if (isMap(l) && l.topics !== undefined && (!Array.isArray(l.topics) || l.topics.some((t) => typeof t !== "string" || !isMap(ov.topics) || !(t in ov.topics)))) bad.push(`lookups.${service}.topics: want a list of the topics the overlay serves`);
    const extra = isMap(l) ? Object.keys(l).filter((k) => k !== "program" && k !== "topics") : [];
    if (extra.length) bad.push(`lookups.${service}: ${extra.join(", ")}: not a field (want program, topics)`);
  }
  if (ov.status !== undefined) bad.push("status: gone (#79): statuses are the chain app's (its `status` row); the overlay admits on the chain app's answer");
  if (ov.gossip !== undefined && (!isMap(ov.gossip) || Object.entries(ov.gossip).some(([t, on]) => typeof on !== "boolean" || !topics.includes(t)))) bad.push("gossip: want {<topic the overlay serves>: true | false}");
  if (bad.length) return bad;
  const http = (address: string, fn: string): Row => ({ transport: "http", address, sender: "*", program: OVERLAY_ROLE, fn });
  const p2p = (address: string, fn: string): Row => ({ transport: "libp2p", address, sender: "*", program: OVERLAY_ROLE, fn });
  const box = (sender: string): Row => ({ transport: "mailbox", address: app, sender, program: OVERLAY_ROLE });
  // #121: a submission's BEEF is decoded at the kernel's door (the row's `filter`): the handler gets its pointer record.
  const beef = (r: Row): Row => ({ ...r, filter: "beef" });
  return {
    topics,
    rows: [
      box("event"), box("$self"),
      beef(http("/submit", "submit")), http("/lookup", "lookup"),
      ...topics.flatMap((t) => [beef(p2p(t, "submit")), p2p(`${t}-admit`, "peerAdmit"), p2p(`${t}-proof`, "peerProof")]),
    ],
  };
}

/** The interfaces `requires` names that no installed app provides. */
export function missingInterfaces(requires: string[], installed: Array<{ provides?: Provide[] }>): string[] {
  const have = new Set(installed.flatMap((a) => (a.provides ?? []).map((p) => p.interface)));
  return requires.filter((r) => !have.has(r));
}

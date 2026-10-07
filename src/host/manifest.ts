// The app manifest (#72, #76, #77, #79, #143; docs/APPS.md §2): `etc/app.json`
// in an app's tree, checked and normalised here for the install client
// (install.ts, `skein install`, #124). Pure: the tree is asked only whether a
// path exists.
//
// What the checks enforce (each failure is one line of ManifestError):
//
//   kind        "app"
//   name        lower-case [a-z0-9][a-z0-9._-]*: the app's box, and the prefix of every head it
//               writes (`<name>/app` its root); not a stock box, head or program name (objects,
//               head, dispatch, peers, grant, grants, main, wallet, kernel, frontdoor, messagebox,
//               resolve, …)
//   version     semver
//   programs    role → "bin/<x>.wasm" | "bin/<x>.cid" (a file in the tree), a bare name: a
//               program the instance already has by name in its genesis, or (#83) a shell
//               program: {code: "shell", modules: {<command>: "bin/<x>.wasm"} (brush and
//               coreutils among them), support?: {<command>: {mount: <absolute path>, files:
//               {<path under mount>: <a file in the tree>}, env?: {<name>: <text>}}},
//               description?} — the record the kernel's shell runs (docs/APPS.md, "A shell
//               program"), its modules and support files this tree's
//   routes[]    the routes the app asks for (#143; the kernel's route table, docs/APPS.md §2):
//               {transport?: "mailbox" (default) | "event" | "http" | "libp2p", address, prefix?: true,
//                filters?: [<filter>], handler?: <handler>, …settings}. A mailbox or event route's
//               address is a box relative to the app (#128): "" or the app's name is the app's own
//               box `<name>`, "x" the box `<name>/x` (an empty, "." or ".." segment, whitespace or a
//               control character is refused: no box outside the app's); an http route's a path
//               relative to /<name>/ (a leading "/" too: "/submit" → "/<name>/submit", "/" →
//               "/<name>/"; a ".." or "." segment, an encoded dot or slash (%2e, %2f), a backslash, a
//               NUL or a URL is refused), `prefix: true` for a prefix; a libp2p route's a topic or
//               "/<protocol>" (global, not namespaced; exact). `filters`, in order: "kernel.brc104",
//               "kernel.beef", one of this app's own (a name its `filters` declares) or another
//               app's ("<app>.<filter>"); none on an event route. `handler`: "<role>.<fn>" — a
//               function of one of `programs` — or, for an app with one program, "<fn>"; a mailbox
//               or event route may name only "<role>" (the program stepped, no function named). An
//               http route with no handler is a READ route: its filters answer (the last one), and
//               nothing is logged. The same key (transport, address as served, prefix) twice is
//               refused. No `sender` (#143): who may run a function is `roles`'.
//   filters     {<filter>: <handler>}: the app's functions any route may list as a filter
//               (#143: `<app>.<filter>`), each "<role>.<fn>", "<fn>" (one program) or "<role>" (its
//               function named as the filter). A filter runs before anything is recorded, in the
//               deterministic profile, and answers {reject} | {answer} | {pass} (docs/APPS.md §2).
//   roles       {<role>: [<fn>…]}: the functions each of the app's roles gates (#143), granted as
//               `<app>.<role>` by root; "user" (any principal) and "root" are the standard roles,
//               usable by name. A function no role lists is open to whatever its route's filters
//               let through.
//   provides[]  {interface: "<name>/<major>", functions: {<fn>: {writes: bool, args?, answer?}}}
//               — `writes` required; `args`/`answer` shapes: a type name (string, int,
//               ms, bytes, cid, bool, map, any), [shape], or {key[?]: shape}
//   requires[]  "<name>/<major>"
//   start, stop {body: {…}}; into the app's box: a mailbox route at it
//   config      a map (the programs read it from the head's root record)
//   config.overlay   an overlay app (APPS.md §6): {topics?: {<topic>: <role>}, lookups?: {<service>:
//               <role> | {program: <role>, topics?: [<topic>]}}, gossip?: {<topic>: bool}}; the engine
//               is the role `overlay`. Its wiring is derived (overlayWiring) and added to the routes
//               the manifest names itself — an explicit route with the same key wins. `topics` may be absent
//               or empty: a dynamic overlay (Mandala, an AMM) registers its topics by a call at runtime
//               and the engine adds and drops their routes itself; a manifest may still pre-configure
//               topics (OpNS: one global topic). No prefix declarations (#120): any other field is refused.
//
//   Gone (#143): `dispatch` (now `routes`), `reads` (a read is a route with filters and no handler),
//   `sender`, `$owner` and every `$<name>`; the form before #77 (`handler`, `boxes`, `heads`).

export type RouteTransport = "mailbox" | "event" | "http" | "libp2p";
/** A route as the manifest writes it (#143). */
export interface RouteIn { transport?: RouteTransport; address: string; prefix?: true; filters?: string[]; handler?: string; [setting: string]: unknown }
export interface FunctionDecl { writes: boolean; args?: unknown; answer?: unknown }
export interface Provide { interface: string; functions: Record<string, FunctionDecl> }

export interface Manifest {
  kind: "app";
  name: string;
  version: string;
  programs: Record<string, string | Record<string, unknown>>;
  routes?: RouteIn[];
  filters?: Record<string, string>;
  roles?: Record<string, string[]>;
  config?: Record<string, unknown>;
  provides?: Provide[];
  requires?: string[];
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

/** A route normalised: transport set; the address, filters and handler as written. */
export type Route = RouteIn & { transport: RouteTransport };

/** A manifest checked: the fields as installed. */
export interface Checked {
  manifest: Omit<Manifest, "routes"> & { routes: Route[]; provides: Provide[]; requires: string[] };
  sources: Record<string, ProgramSource>;
  /** What `config.overlay` added (APPS.md §6): route keys (routeKey). */
  derived: Derived;
}

export class ManifestError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) { super(`etc/app.json:\n  ${problems.join("\n  ")}`); this.problems = problems; }
}

export const RESERVED_NAMES = ["objects", "head", "dispatch", "peers", "grant", "grants", "claim", "subscribe", "routes", "main", "sessions", "wallet", "kernel", "frontdoor", "messagebox", "resolve", "billing", "tick", "reads", "root", "user"];
/** The fields gone, refused: the form before #77 (#79), and #143's. */
const GONE_FIELDS: Record<string, string> = {
  handler: "the form before #77 is gone (#79): name routes, and write only heads under the app's name",
  boxes: "the form before #77 is gone (#79): name routes",
  heads: "the form before #77 is gone (#79): an app writes only heads under its own name",
  dispatch: "gone (#143): name `routes` ({transport?, address, prefix?, filters?, handler?, …}, no sender)",
  reads: "gone (#143): a read is a route with filters and no handler (the last filter answers)",
};
const NAME = /^[a-z0-9][a-z0-9._-]*$/;
const ROLE = /^[a-z0-9][a-z0-9_-]*$/;
const FN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const FILTER = /^[A-Za-z0-9_-]+$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const INTERFACE = /^[a-z0-9][a-z0-9._-]*\/\d+$/;
const TYPES = ["string", "int", "ms", "bytes", "cid", "bool", "map", "any"];
const KERNEL_FILTERS = ["kernel.brc104", "kernel.beef"];

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

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
 * An http route's path as served: relative to /<app>/ (a leading "/" too). Throws
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
 * A box as the kernel's table holds it (#128): relative to the app, as an http
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

/** A route's address as served: an http path under /<app>/ (appPath); a box under the app's (appBox); a libp2p name as written. */
export function rowAddress(app: string, r: { transport: string; address: string }): string {
  return r.transport === "http" ? appPath(app, r.address) : r.transport === "mailbox" || r.transport === "event" ? appBox(app, r.address) : r.address;
}

/** A route's key as the kernel's table knows it (dispatch.ts rowKey): `<transport> <address as served>[ prefix]`. */
export function routeKey(app: string, r: { transport: string; address: string; prefix?: boolean }): string {
  return `${r.transport} ${rowAddress(app, r)}${r.prefix ? " prefix" : ""}`;
}

/**
 * A handler (or a declared filter's function) resolved against the app's programs (#143):
 * "<role>.<fn>"; a bare name that is a role — the program, no function named; any other bare name
 * — a function of the app's one program. Undefined: none of these.
 */
export function handlerOf(h: unknown, roles: string[]): { role: string; fn?: string } | undefined {
  if (typeof h !== "string" || !h) return undefined;
  const dot = h.indexOf(".");
  if (dot > 0) {
    const role = h.slice(0, dot), fn = h.slice(dot + 1);
    return roles.includes(role) && FN.test(fn) ? { role, fn } : undefined;
  }
  if (roles.includes(h)) return { role: h };
  return roles.length === 1 && FN.test(h) ? { role: roles[0]!, fn: h } : undefined;
}

/** A route's filter as the kernel's table names it (#143): the kernel's; an own filter's name → `<app>.<name>`; another app's as written. */
export const filterRef = (app: string, f: string): string => f.includes(".") ? f : `${app}.${f}`;

/** The fields a route does not have (#143). */
const NOT_ROUTE_FIELDS: Record<string, string> = {
  sender: "gone (#143): a route has no sender — its filters say who a request is from, and `roles` gate functions",
  program: "name the handler: \"<role>.<fn>\" (#143)",
  fn: "name the handler: \"<role>.<fn>\" (#143)",
  filter: "gone (#143): name `filters`, a list (\"kernel.beef\")",
  optional: "gone (#143): a route from a provider is a route like any other",
  app: "app is set by the install",
};

/** Why a route is not one (checked against the roles, the declared filters and the app's name), or undefined. */
function routeProblem(app: string, r: unknown, roles: string[], declared: (f: string) => boolean): string | undefined {
  if (!isMap(r)) return "not a map";
  for (const [k, why] of Object.entries(NOT_ROUTE_FIELDS)) if (r[k] !== undefined) return `${k}: ${why}`;
  const t = r.transport ?? "mailbox";
  if (t !== "mailbox" && t !== "event" && t !== "http" && t !== "libp2p") return `transport ${JSON.stringify(t)} is not mailbox, event, http or libp2p`;
  if (typeof r.address !== "string" || (!r.address && (t === "http" || t === "libp2p"))) return "address is not text";
  if (t === "mailbox" || t === "event") {
    try { appBox(app, r.address); } catch (e) { return (e as Error).message; }
    if (r.prefix !== undefined) return `a ${t} route has no prefix`;
  } else if (t === "http") {
    try { appPath(app, r.address); } catch (e) { return (e as Error).message; }
    if (r.prefix !== undefined && r.prefix !== true) return "prefix is true or absent";
  } else {
    if (/[\s\0]/.test(r.address)) return `address ${JSON.stringify(r.address)} is not a topic or /protocol`;
    if (r.prefix !== undefined) return "a libp2p route has no prefix";
  }
  const filters = r.filters ?? [];
  if (!Array.isArray(filters) || filters.some((f) => typeof f !== "string")) return "filters is a list of filter names";
  if (filters.length && t === "event") return "an event route has no filters (an event is the host's wiring)";
  for (const f of filters as string[]) {
    if (f.startsWith("kernel.")) { if (!KERNEL_FILTERS.includes(f)) return `filter ${f}: the kernel's are ${KERNEL_FILTERS.join(", ")}`; continue; }
    const dot = f.lastIndexOf(".");
    if (dot < 0) { if (!declared(f)) return `filter ${f}: not one of this app's (its \`filters\` declare none by that name)`; continue; }
    if (!NAME.test(f.slice(0, dot)) || !FILTER.test(f.slice(dot + 1))) return `filter ${JSON.stringify(f)}: not <app>.<filter>`;
  }
  if (r.handler === undefined) {
    if (t !== "http") return "handler: a mailbox, event or libp2p route names its handler (\"<role>.<fn>\")";
    if (!filters.length) return "a read route (no handler) names its filters: the last one answers";
    return undefined;
  }
  const h = handlerOf(r.handler, roles);
  if (!h) return `handler ${JSON.stringify(r.handler)} is not "<role>.<fn>" of a role in programs${roles.length === 1 ? ", or a function of the app's one program" : ""}`;
  if (!h.fn && (t === "http" || t === "libp2p")) return `handler ${JSON.stringify(r.handler)}: an ${t} route names a function ("<role>.<fn>")`;
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
  else if (RESERVED_NAMES.includes(name)) bad.push(`name: ${name} is a stock box, head, program or role of the instance`);
  const app = name || "app";
  if (typeof m.version !== "string" || !SEMVER.test(m.version)) bad.push(`version: ${JSON.stringify(m.version)} is not semver`);
  if (m.description !== undefined && typeof m.description !== "string") bad.push("description: not text");
  if (m.config !== undefined && !isMap(m.config)) bad.push("config: not a map");
  for (const [f, why] of Object.entries(GONE_FIELDS)) if (m[f] !== undefined) bad.push(`${f}: ${why}`);

  // programs
  const sources: Record<string, ProgramSource> = {};
  if (!isMap(m.programs)) bad.push("programs: want {role: \"bin/<x>.wasm\" | \"bin/<x>.cid\" | <an instance program's name> | {code: \"shell\", modules, support?}}");
  else for (const [role, p] of Object.entries(m.programs)) {
    if (!ROLE.test(role)) { bad.push(`programs: ${JSON.stringify(role)} is not a role name ([a-z0-9][a-z0-9_-]*)`); continue; }
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
  const roleNames = Object.keys(sources);

  // filters (#143): the app's functions any route may list
  const filters: Record<string, string> = {};
  if (m.filters !== undefined && !isMap(m.filters)) bad.push("filters: want {<filter>: \"<role>.<fn>\" | \"<fn>\" | \"<role>\"}");
  for (const [f, h] of Object.entries(isMap(m.filters) ? m.filters : {})) {
    if (!FILTER.test(f)) { bad.push(`filters: ${JSON.stringify(f)} is not a filter name ([A-Za-z0-9_-]+)`); continue; }
    if (!handlerOf(h, roleNames)) { bad.push(`filters.${f}: ${JSON.stringify(h)} is not "<role>.<fn>" of a role in programs, a role, or a function of the app's one program`); continue; }
    filters[f] = h as string;
  }

  // roles (#143): the functions each role gates
  if (m.roles !== undefined && !isMap(m.roles)) bad.push("roles: want {<role>: [<fn>…]}");
  for (const [r, fns] of Object.entries(isMap(m.roles) ? m.roles : {})) {
    if (!ROLE.test(r)) bad.push(`roles: ${JSON.stringify(r)} is not a role name ([a-z0-9][a-z0-9_-]*; "root" and "user" are the standard roles)`);
    else if (!Array.isArray(fns) || fns.some((f) => typeof f !== "string" || !FN.test(f))) bad.push(`roles.${r}: want a list of the functions it gates`);
  }

  // routes (#143)
  const routes: Route[] = [];
  const addRoute = (r: Route, at: string) => {
    const k = routeKey(app, r);
    if (routes.some((x) => routeKey(app, x) === k)) { bad.push(`${at}: ${k} twice`); return; }
    routes.push(r);
  };
  if (m.routes !== undefined && !Array.isArray(m.routes)) bad.push("routes: not a list");
  for (const [i, r] of (Array.isArray(m.routes) ? m.routes : []).entries()) {
    const why = routeProblem(app, r, roleNames, (f) => f in filters);
    if (why) { bad.push(`routes[${i}]: ${why}`); continue; }
    const route = r as RouteIn;
    addRoute({ ...route, transport: route.transport ?? "mailbox" }, `routes[${i}]`);
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
  const derived: Derived = { routes: [] };
  const ov = isMap(m.config) ? m.config.overlay : undefined;
  if (ov !== undefined) {
    const w = overlayWiring(app, ov, (r) => r in sources);
    if (Array.isArray(w)) bad.push(...w.map((p) => `config.overlay: ${p}`));
    else {
      const have = new Set(routes.map((r) => routeKey(app, r)));
      for (const r of w.routes) if (!have.has(routeKey(app, r))) { routes.push(r); derived.routes.push(routeKey(app, r)); }
      // The derived /lookup's filter: the engine's `lookup` (a manifest may name its own).
      if (!("lookup" in filters)) filters.lookup = `${OVERLAY_ROLE}.lookup`;
    }
  }

  // start, stop
  for (const k of ["start", "stop"] as const) {
    if (m[k] === undefined) continue;
    if (!isMap(m[k]) || !isMap((m[k] as { body?: unknown }).body)) bad.push(`${k}: want {body: {…}}`);
  }
  if ((m.start !== undefined || m.stop !== undefined) && !routes.some((r) => r.transport === "mailbox" && rowAddress(app, r) === name)) bad.push(`start/stop go into the app's box: routes must have a mailbox route for ${name}`);

  if (bad.length) throw new ManifestError(bad);
  const { routes: _r, filters: _f, ...rest } = m as Manifest;
  void _r; void _f;
  const out = { ...rest, routes, ...(Object.keys(filters).length ? { filters } : {}), provides, requires };
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

/** What the install derived from `config.overlay` (route keys), for the prompt. */
export interface Derived { routes: string[] }

/** An overlay app's wiring. */
export interface OverlayWiring { routes: Route[]; topics: string[] }

const TOPIC = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
/** The fields of `config.overlay` (`status` is refused with its own reason). */
const OVERLAY_FIELDS = ["topics", "lookups", "gossip", "market", "validator"];

/**
 * The wiring `config.overlay` asks for (APPS.md §6, #79, #143), or its problems. For each topic:
 * the libp2p routes `<topic>` → submit (kernel.beef), `<topic>-admit` → peerAdmit, `<topic>-proof`
 * → peerProof; the http route `/submit` (kernel.beef: a submission validates itself — #135, signed
 * or validated) and `/lookup` (BRC-24's POST: answered by the engine's `lookup`, a filter — a read
 * route, nothing logged); and the app's own box twice: an `event` route (what its libp2p routes
 * admit — a gossiped submission, a peer's admit) and a `mailbox` route (its own watch of a
 * submission the chain app has accepted, sent by the host's loopback). All to the role `overlay`,
 * the engine, which the manifest must declare `lookup` a filter of. No `chain` or `status` box (the
 * chain app's): the engine writes `<app>/…` only. No topics is accepted: the box routes, `/submit`
 * and `/lookup` and no per-topic routes — the topics registered at runtime get theirs from the
 * engine (#120). `market` ({window: <ms>}) and `validator` ({every: <ms>}) are the engine's own
 * settings, read from the app record: checked, no routes derived. A field other than these is
 * refused (no prefix declarations, #120). `isRole` tells which roles the manifest has.
 */
export function overlayWiring(app: string, ov: unknown, isRole: (role: string) => boolean): OverlayWiring | string[] {
  const bad: string[] = [];
  if (!isMap(ov)) return ["want {topics?, lookups?, gossip?, market?, validator?}"];
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
  if (ov.status !== undefined) bad.push("status: gone (#79): statuses are the chain app's (its `status` route); the overlay admits on the chain app's answer");
  if (ov.gossip !== undefined && (!isMap(ov.gossip) || Object.entries(ov.gossip).some(([t, on]) => typeof on !== "boolean" || !topics.includes(t)))) bad.push("gossip: want {<topic the overlay serves>: true | false}");
  const ms = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v > 0;
  if (ov.market !== undefined && (!isMap(ov.market) || !ms(ov.market.window) || Object.keys(ov.market).some((k) => k !== "window"))) bad.push("market: want {window: <ms>}");
  if (ov.validator !== undefined && (!isMap(ov.validator) || !ms(ov.validator.every) || Object.keys(ov.validator).some((k) => k !== "every"))) bad.push("validator: want {every: <ms>}");
  if (bad.length) return bad;
  const engine = (fn: string) => `${OVERLAY_ROLE}.${fn}`;
  // #121, #143: a submission's BEEF is decoded at the kernel's door (kernel.beef): the handler gets its pointer record.
  const beef = ["kernel.beef"];
  return {
    topics,
    routes: [
      { transport: "event", address: app, handler: OVERLAY_ROLE },
      { transport: "mailbox", address: app, handler: OVERLAY_ROLE },
      { transport: "http", address: "/submit", filters: beef, handler: engine("submit") },
      { transport: "http", address: "/lookup", filters: [`${app}.lookup`] },
      ...topics.flatMap((t): Route[] => [
        { transport: "libp2p", address: t, filters: beef, handler: engine("submit") },
        { transport: "libp2p", address: `${t}-admit`, handler: engine("peerAdmit") },
        { transport: "libp2p", address: `${t}-proof`, handler: engine("peerProof") },
      ]),
    ],
  };
}

/** The interfaces `requires` names that no installed app provides. */
export function missingInterfaces(requires: string[], installed: Array<{ provides?: Provide[] }>): string[] {
  const have = new Set(installed.flatMap((a) => (a.provides ?? []).map((p) => p.interface)));
  return requires.filter((r) => !have.has(r));
}

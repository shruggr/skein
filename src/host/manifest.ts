// The app manifest (skein next, SPEC.md section 3; docs/APPS.md §2): `etc/app.json` in an app's
// tree, checked and normalised here for the install (plan.ts; `skein install`, an image's apps at
// birth). Pure: the tree is asked only whether a path exists.
//
//   kind        "app"
//   name        lower-case [a-z0-9][a-z0-9_-]*: the prefix of every head it writes (`<name>/app` its
//               root), of every path its rows take (/<name>/…) and every event name (<name>, <name>/…);
//               not a kernel name (kernel, grants, main, root, user, anyone, …)
//   version     semver
//   programs    role → "bin/<x>.wasm" | "bin/<x>.cid" (a file in the tree)
//   roles       {<role>: "<what it may do>"}: DECLARES the app's role names (granted as
//               `<app>.<role>`); the rows name who may send (SPEC 3: roles live on the row)
//   routes[]    the rows the app asks for, each as the kernel takes it (SPEC 3) but relative to the
//               app:
//                 {kind: "request" | "read", path, prefix?: true, role, checks?, recheck?, handler, …settings}
//                 {kind: "event", name, checks?, recheck?, handler, …settings}
//               `path` relative to /<name>/ (a leading "/" too: "/submit" → "/<name>/submit", "/" →
//               "/<name>/"; a "." or ".." segment, an encoded dot or slash, a backslash, a NUL or a
//               URL is refused); `name` relative to the app ("" or the app's name → `<name>`, "x" →
//               `<name>/x`); `role` (request and read rows, required: nothing is open by omission)
//               "anyone" (no proven sender: a request row naming it names at least one check),
//               "user" (any proven sender), "root", one of this app's declared roles (→
//               `<name>.<role>`) or another app's `<app>.<role>`; `checks` / `recheck` function
//               references as the kernel names them, "<app>.<fn>" (an app with one program) or
//               "<app>.<role>.<fn>" — this app's or an installed app's (chain.beef, chain.unspent);
//               `handler` "<role>.<fn>" of one of `programs`, or "<fn>" for an app with one program
//               (→ "<name>.<role>.<fn>"); a read row has no checks; anything else a handler setting
//               (the row is handed to the handler as `row`). The same key (a path and prefix, or an
//               event name) twice is refused.
//   provides[]  {interface: "<name>/<major>", functions: {<fn>: {writes: bool, args?, answer?}}}
//   requires[]  "<name>/<major>"
//   calls       {<callee>: [<name> …] | "*"} (call permissions): each a grant at install
//   services    ["signer"]: the kernel services this app asks for; each a grant at install
//   config      a map (the programs read it from the head's root record)
//
//   Gone: `filters` (a check is a function named on a row), `transport`/`address`/`program`/`fn` on
//   a row, `start`/`stop` (no message goes into an app's box), shell programs and an instance's
//   genesis programs (an image's programs come in its apps), the derived overlay wiring
//   (`config.overlay` routes: the overlay's rows are named in its manifest).

import { isFnRef, rowKey, rowProblem, type DispatchRow } from "../runtime/dispatch.ts";

/** A row as the manifest writes it (relative to the app). */
export interface RouteIn { kind: "request" | "read" | "event"; path?: string; name?: string; prefix?: true; role?: string; checks?: string[]; recheck?: string; handler: string; [setting: string]: unknown }
export interface FunctionDecl { writes: boolean; args?: unknown; answer?: unknown }
export interface Provide { interface: string; functions: Record<string, FunctionDecl> }

export interface Manifest {
  kind: "app";
  name: string;
  version: string;
  programs: Record<string, string>;
  roles?: Record<string, string>;
  routes?: RouteIn[];
  config?: Record<string, unknown>;
  provides?: Provide[];
  requires?: string[];
  /** Call permissions: per callee, the names this app may call it under ("*": any). */
  calls?: Record<string, string[] | "*">;
  /** Kernel services this app asks for (defined: "signer"). */
  services?: string[];
  description?: string;
}

/** Where a role's program comes from. */
export type ProgramSource = { kind: "wasm" | "cid"; path: string; name: string };

/** A manifest checked: the fields as installed. */
export interface Checked {
  manifest: Omit<Manifest, "routes"> & { routes: RouteIn[]; provides: Provide[]; requires: string[] };
  sources: Record<string, ProgramSource>;
}

export class ManifestError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) { super(`etc/app.json:\n  ${problems.join("\n  ")}`); this.problems = problems; }
}

/** Names no app may take: the kernel's heads, roles and operation prefix. */
export const RESERVED_NAMES = ["kernel", "grants", "main", "root", "user", "anyone", "routes", "dispatch"];
/** The fields gone, refused, with why. */
const GONE_FIELDS: Record<string, string> = {
  handler: "the form before #77 is gone: name routes",
  boxes: "the form before #77 is gone: name routes",
  heads: "the form before #77 is gone: an app writes only heads under its own name",
  dispatch: "gone: name `routes` (skein next rows: {kind, path | name, role, checks?, recheck?, handler})",
  reads: "gone: a read is a row of kind read",
  filters: "gone (skein next): a check is a function a row names in `checks` (\"<app>.<fn>\")",
  start: "gone (skein next): nothing is sent into an app's box at install",
  stop: "gone (skein next): nothing is sent into an app's box at uninstall",
};
const NAME = /^[a-z0-9][a-z0-9_-]*$/;
const ROLE = /^[a-z0-9][a-z0-9_-]*$/;
const FN = /^[A-Za-z0-9_-]+$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const INTERFACE = /^[a-z0-9][a-z0-9._-]*\/\d+$/;
const TYPES = ["string", "int", "ms", "bytes", "cid", "bool", "map", "any"];
/** A caller or callee: an app's name. */
export const PARTY = /^[a-z0-9][a-z0-9._-]*$/;
export const SERVICES = ["signer"];
export const MAX_CALL_NAME = 256;
export const isCallName = (n: unknown): n is string => typeof n === "string" && n.length > 0 && new TextEncoder().encode(n).length <= MAX_CALL_NAME && !n.includes("\0");

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

/** A row's path as served: relative to /<app>/ (a leading "/" too). Throws on anything that could name a path outside that prefix. */
export function appPath(app: string, p: string): string {
  if (typeof p !== "string") throw new Error("not text");
  if (/^[a-z][a-z0-9+.-]*:/i.test(p)) throw new Error(`${JSON.stringify(p)} is a URL or a scheme, not a path under /${app}/`);
  if (/[\\\0?#\s]/.test(p) || /%(2e|2f|5c|00)/i.test(p)) throw new Error(`${JSON.stringify(p)}: a backslash, NUL, space, query, fragment or an encoded dot or slash`);
  if (p.split("/").some((s) => s === ".." || s === ".")) throw new Error(`${JSON.stringify(p)}: a "." or ".." segment`);
  const rest = p.replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  return `/${app}/${rest}`;
}

/** An event row's name as served: relative to the app — "" or the app's name is `<app>`, "x" is `<app>/x`. Throws on a name that is not one. */
export function appName(app: string, n: string): string {
  if (typeof n !== "string") throw new Error("not text");
  if (n === "" || n === app) return app;
  if (/[\s\0-\x1f\x7f]/.test(n)) throw new Error(`name ${JSON.stringify(n)}: whitespace or a control character`);
  if (n.split("/").some((s) => s === "" || s === "." || s === "..")) throw new Error(`name ${JSON.stringify(n)}: an empty, "." or ".." segment (no name outside ${app}/)`);
  return `${app}/${n}`;
}

/** A handler resolved against the app's program roles: "<role>.<fn>", or "<fn>" for an app with one program. Undefined: neither. */
export function handlerOf(h: unknown, roles: string[]): { role: string; fn: string } | undefined {
  if (typeof h !== "string" || !h) return undefined;
  const dot = h.indexOf(".");
  if (dot > 0) {
    const role = h.slice(0, dot), fn = h.slice(dot + 1);
    return roles.includes(role) && FN.test(fn) ? { role, fn } : undefined;
  }
  return roles.length === 1 && FN.test(h) ? { role: roles[0]!, fn: h } : undefined;
}

/** A row's role as the kernel's table names it: the standard ones as written; one of this app's declared roles → `<app>.<role>`; another app's as written. Undefined: none of these. */
export function roleOf(app: string, role: unknown, declared: string[]): string | undefined {
  if (role === "anyone" || role === "user" || role === "root") return role;
  if (typeof role !== "string") return undefined;
  if (declared.includes(role)) return `${app}.${role}`;
  const dot = role.indexOf(".");
  if (dot > 0 && NAME.test(role.slice(0, dot)) && ROLE.test(role.slice(dot + 1)) && role.indexOf(".", dot + 1) < 0) return role.slice(0, dot) === app ? (declared.includes(role.slice(dot + 1)) ? role : undefined) : role;
  return undefined;
}

/** The fields a manifest row may not have (the old row form, and what the install sets). */
const NOT_ROW_FIELDS: Record<string, string> = {
  transport: "gone (skein next): a row has a kind (request, read, event), not a transport",
  address: "gone (skein next): name `path` (request, read) or `name` (event)",
  filters: "gone (skein next): name `checks` (\"<app>.<fn>\")",
  filter: "gone: name `checks`",
  program: "name the handler: \"<role>.<fn>\"",
  fn: "name the handler: \"<role>.<fn>\"",
  sender: "gone: a row names its `role`",
  app: "the app is its handler's: set by the install",
};

/**
 * A manifest row as the kernel takes it (the install's): the path under /<app>/ or the name under
 * the app's, the role resolved, the handler "<app>.<role>.<fn>", checks and settings as written.
 */
export function rowOf(app: string, r: RouteIn, roles: string[], declared: string[]): DispatchRow {
  const { kind, path, name, prefix, role, checks, recheck, handler, ...settings } = r;
  const h = handlerOf(handler, roles)!;
  const row: DispatchRow = kind === "event"
    ? { kind, name: appName(app, name ?? ""), ...(checks?.length ? { checks } : {}), ...(recheck ? { recheck } : {}), handler: `${app}.${h.role}.${h.fn}`, ...settings }
    : { kind, path: appPath(app, path ?? "/"), ...(prefix ? { prefix: true } : {}), role: roleOf(app, role, declared)!, ...(checks?.length ? { checks } : {}), ...(recheck ? { recheck } : {}), handler: `${app}.${h.role}.${h.fn}`, ...settings };
  return row;
}

/** Why a manifest row is not one (checked against the programs' roles, the declared roles and the app's name), or undefined. */
function routeProblem(app: string, r: unknown, roles: string[], declared: string[]): string | undefined {
  if (!isMap(r)) return "not a map";
  for (const [k, why] of Object.entries(NOT_ROW_FIELDS)) if (r[k] !== undefined) return `${k}: ${why}`;
  if (r.kind !== "request" && r.kind !== "read" && r.kind !== "event") return `kind ${JSON.stringify(r.kind)}: want request, read or event`;
  if (r.kind === "event") {
    if (r.path !== undefined || r.prefix !== undefined || r.role !== undefined) return "an event row names its `name` only: no path, prefix or role (an event has no principal)";
    try { appName(app, typeof r.name === "string" ? r.name : ""); } catch (e) { return (e as Error).message; }
  } else {
    if (r.name !== undefined) return `a ${r.kind} row names its \`path\`, not a name`;
    if (typeof r.path !== "string") return `a ${r.kind} row names its path (relative to /${app}/)`;
    try { appPath(app, r.path); } catch (e) { return (e as Error).message; }
    if (r.prefix !== undefined && r.prefix !== true) return "prefix is true or absent";
    if (r.role === undefined) return "role: every request and read row names its role (anyone, user, root, or a role the app declares): nothing is open by omission";
    if (!roleOf(app, r.role, declared)) return `role ${JSON.stringify(r.role)}: anyone, user, root, one of this app's declared roles (${declared.join(", ") || "none"}) or <app>.<role>`;
  }
  if (r.checks !== undefined && (!Array.isArray(r.checks) || !r.checks.every(isFnRef))) return "checks: a list of \"<app>.<fn>\" or \"<app>.<role>.<fn>\"";
  if (r.recheck !== undefined && !isFnRef(r.recheck)) return "recheck: \"<app>.<fn>\" or \"<app>.<role>.<fn>\"";
  for (const c of [...((r.checks as string[] | undefined) ?? []), ...(r.recheck ? [r.recheck as string] : [])]) {
    const parts = c.split(".");
    if (parts[0] !== app) continue;
    if (parts.length === 3 ? !roles.includes(parts[1]!) : roles.length !== 1) return `${c}: not a function of this app's programs (${parts.length === 3 ? `no role ${parts[1]}` : "an app with several programs names <app>.<role>.<fn>"})`;
  }
  if (!handlerOf(r.handler, roles)) return `handler ${JSON.stringify(r.handler)} is not "<role>.<fn>" of a role in programs${roles.length === 1 ? ", or a function of the app's one program" : ""}`;
  const why = rowProblem(rowOf(app, r as RouteIn, roles, declared));
  return why;
}

/** Check and normalise a manifest. `has(path)`: whether the tree has a file at the path. */
export function checkManifest(json: unknown, has: (path: string) => boolean): Checked {
  const bad: string[] = [];
  if (!isMap(json)) throw new ManifestError(["not a JSON object"]);
  const m = json as Partial<Manifest> & Record<string, unknown>;
  if (m.kind !== "app") bad.push(`kind: want "app"`);
  const name = typeof m.name === "string" ? m.name : "";
  if (!NAME.test(name)) bad.push(`name: ${JSON.stringify(m.name)} is not a name ([a-z0-9][a-z0-9_-]*)`);
  else if (RESERVED_NAMES.includes(name)) bad.push(`name: ${name} is the kernel's`);
  const app = name || "app";
  if (typeof m.version !== "string" || !SEMVER.test(m.version)) bad.push(`version: ${JSON.stringify(m.version)} is not semver`);
  if (m.description !== undefined && typeof m.description !== "string") bad.push("description: not text");
  if (m.config !== undefined && !isMap(m.config)) bad.push("config: not a map");
  for (const [f, why] of Object.entries(GONE_FIELDS)) if (m[f] !== undefined) bad.push(`${f}: ${why}`);

  // programs
  const sources: Record<string, ProgramSource> = {};
  if (!isMap(m.programs)) bad.push("programs: want {role: \"bin/<x>.wasm\" | \"bin/<x>.cid\"}");
  else for (const [role, p] of Object.entries(m.programs)) {
    if (!ROLE.test(role)) { bad.push(`programs: ${JSON.stringify(role)} is not a role name ([a-z0-9][a-z0-9_-]*)`); continue; }
    const file = typeof p === "string" ? /^bin\/([A-Za-z0-9._-]+)\.(wasm|cid)$/.exec(p) : null;
    if (!file) { bad.push(`programs.${role}: ${JSON.stringify(p)} is not bin/<x>.wasm or bin/<x>.cid (skein next: no shell programs, no genesis programs)`); continue; }
    if (!has(p as string)) bad.push(`programs.${role}: ${p} is not in the tree`);
    sources[role] = { kind: file[2] as "wasm" | "cid", path: p as string, name: file[1]! };
  }
  const roleNames = Object.keys(sources);

  // roles: the names the app declares
  const declared: string[] = [];
  if (m.roles !== undefined && !isMap(m.roles)) bad.push("roles: want {<role>: \"<what it may do>\"} (skein next: the app declares its role names; its rows name who may send)");
  for (const [r, d] of Object.entries(isMap(m.roles) ? m.roles : {})) {
    if (!ROLE.test(r) || r === "root" || r === "user" || r === "anyone") bad.push(`roles: ${JSON.stringify(r)} is not a role name of the app's ([a-z0-9][a-z0-9_-]*; not root, user or anyone)`);
    else if (typeof d !== "string") bad.push(`roles.${r}: want text (what the role may do; skein next: the rows name who may send, not the functions a role gates)`);
    else declared.push(r);
  }

  // routes
  const routes: RouteIn[] = [];
  const keys = new Set<string>();
  if (m.routes !== undefined && !Array.isArray(m.routes)) bad.push("routes: not a list");
  for (const [i, r] of (Array.isArray(m.routes) ? m.routes : []).entries()) {
    const why = routeProblem(app, r, roleNames, declared);
    if (why) { bad.push(`routes[${i}]: ${why}`); continue; }
    const k = rowKey(rowOf(app, r as RouteIn, roleNames, declared));
    if (keys.has(k)) { bad.push(`routes[${i}]: ${k} twice`); continue; }
    keys.add(k);
    routes.push(r as RouteIn);
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

  // calls, services (call permissions): what root approves at install, as grants.
  if (m.calls !== undefined) {
    if (!isMap(m.calls)) bad.push("calls: want {<callee>: [<name> …] | \"*\"}");
    else for (const [callee, names] of Object.entries(m.calls)) {
      if (!PARTY.test(callee)) bad.push(`calls: ${JSON.stringify(callee)} is not an app's name`);
      if (names === "*") continue;
      if (!Array.isArray(names) || !names.length || names.some((n) => !isCallName(n))) bad.push(`calls.${callee}: want "*" or a list of names (1 to ${MAX_CALL_NAME} bytes, no NUL)`);
    }
  }
  if (m.services !== undefined && (!Array.isArray(m.services) || m.services.some((x) => !SERVICES.includes(x as string)))) bad.push(`services: a list of kernel services (${SERVICES.join(", ")})`);

  if (bad.length) throw new ManifestError(bad);
  const { routes: _r, ...rest } = m as Manifest;
  void _r;
  const out = { ...rest, routes, provides, requires };
  return { manifest: out, sources };
}

/** The interfaces `requires` names that no installed app provides. */
export function missingInterfaces(requires: string[], installed: Array<{ provides?: Provide[] }>): string[] {
  const have = new Set(installed.flatMap((a) => (a.provides ?? []).map((p) => p.interface)));
  return requires.filter((r) => !have.has(r));
}

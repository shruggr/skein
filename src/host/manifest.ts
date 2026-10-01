// The app manifest (#72, #76; docs/APPS.md §2): `etc/app.json` in an app's
// tree, checked and normalised here for the install client (install.ts,
// `skein-host install`). Pure: the tree is asked only whether a path exists.
//
// What the checks enforce (each failure is one line of ManifestError):
//
//   kind        "app"
//   name        lower-case [a-z0-9][a-z0-9._-]*: the app's head and its box; not a
//               stock admin box or head (objects, head, subscribe, peers, routes,
//               main, sessions, run, chat, wallet)
//   version     semver
//   programs    role → "bin/<x>.wasm" | "bin/<x>.cid" (a file in the tree), or a bare
//               name: a program the instance already has by name (the workbench's
//               "shell")
//   handler     a role, or {<box>: <role>}; every requested box has one; required
//               when `boxes` is not empty
//   boxes[]     a name, or {box, senders: ["*" | "$<provider>" | "$owner" | <key hex>]};
//               normalised to {box, senders}, a bare name → ["$owner"] (the owner only)
//   routes[]    {path | prefix, program: <role>, fn, auth?: "none", read?, …settings};
//               the path is relative to /<app>/ (a leading "/" too): "/submit" →
//               "/<app>/submit", "/" → "/<app>/". A ".." or "." segment, an encoded
//               dot or slash (%2e, %2f), a backslash, a NUL or a URL is refused: no
//               route reaches outside the app's prefix. libp2p routes are refused for
//               now (the host's node subscribes only its genesis's topics)
//   heads[]     names or patterns (`ls:*`); the app's own name is always included;
//               `peers`, `sessions` and `routes` are refused
//   provides[]  {interface: "<name>/<major>", functions: {<fn>: {writes: bool, args?, answer?}}}
//               — `writes` required; `args`/`answer` shapes: a type name (string, int,
//               ms, bytes, cid, bool, map, any), [shape], or {key[?]: shape}
//   requires[]  "<name>/<major>"
//   start, stop {body: {…}}; `start` needs the owner admitted to the app's box
//   config      a map (the programs read it from the head's root record)

export interface RouteIn { path?: string; prefix?: string; program: string; fn: string; auth?: "none"; read?: string; [setting: string]: unknown }
export interface BoxIn { box: string; senders?: string[] }
export interface FunctionDecl { writes: boolean; args?: unknown; answer?: unknown }
export interface Provide { interface: string; functions: Record<string, FunctionDecl> }

export interface Manifest {
  kind: "app";
  name: string;
  version: string;
  programs: Record<string, string>;
  handler?: string | Record<string, string>;
  config?: Record<string, unknown>;
  provides?: Provide[];
  requires?: string[];
  boxes?: Array<string | BoxIn>;
  start?: { body: Record<string, unknown> };
  stop?: { body: Record<string, unknown> };
  routes?: RouteIn[];
  heads?: string[];
  description?: string;
}

/** Where a role's program comes from. */
export type ProgramSource = { kind: "wasm" | "cid"; path: string; name: string } | { kind: "instance"; name: string };

/** A manifest checked: the fields as installed, boxes normalised, the app's head among `heads`, the program sources. */
export interface Checked {
  manifest: Manifest & { boxes: Array<{ box: string; senders: string[] }>; heads: string[]; provides: Provide[]; requires: string[]; routes: RouteIn[] };
  sources: Record<string, ProgramSource>;
  /** box → the role that handles it. */
  handlers: Record<string, string>;
}

export class ManifestError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) { super(`etc/app.json:\n  ${problems.join("\n  ")}`); this.problems = problems; }
}

export const RESERVED_NAMES = ["objects", "head", "subscribe", "peers", "routes", "main", "sessions", "run", "chat", "wallet"];
export const RESERVED_HEADS = ["peers", "sessions", "routes"];
const NAME = /^[a-z0-9][a-z0-9._-]*$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const INTERFACE = /^[a-z0-9][a-z0-9._-]*\/\d+$/;
const KEY = /^0[23][0-9a-f]{64}$/;
const TYPES = ["string", "int", "ms", "bytes", "cid", "bool", "map", "any"];

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isBox = (b: unknown): b is string => typeof b === "string" && b.length > 0 && !b.startsWith(":") && !/[\s\0]/.test(b);

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
 * A route's path as served: relative to /<app>/ (a leading "/" too). Throws
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

/** Check and normalise a manifest. `has(path)`: whether the tree has a file at the path. */
export function checkManifest(json: unknown, has: (path: string) => boolean): Checked {
  const bad: string[] = [];
  if (!isMap(json)) throw new ManifestError(["not a JSON object"]);
  const m = json as Partial<Manifest> & Record<string, unknown>;
  if (m.kind !== "app") bad.push(`kind: want "app"`);
  const name = typeof m.name === "string" ? m.name : "";
  if (!NAME.test(name)) bad.push(`name: ${JSON.stringify(m.name)} is not a name ([a-z0-9][a-z0-9._-]*)`);
  else if (RESERVED_NAMES.includes(name)) bad.push(`name: ${name} is a stock box or head of the instance`);
  if (typeof m.version !== "string" || !SEMVER.test(m.version)) bad.push(`version: ${JSON.stringify(m.version)} is not semver`);
  if (m.description !== undefined && typeof m.description !== "string") bad.push("description: not text");
  if (m.config !== undefined && !isMap(m.config)) bad.push("config: not a map");

  // programs
  const sources: Record<string, ProgramSource> = {};
  if (!isMap(m.programs)) bad.push("programs: want {role: \"bin/<x>.wasm\" | \"bin/<x>.cid\" | <an instance program's name>}");
  else for (const [role, p] of Object.entries(m.programs)) {
    const file = typeof p === "string" ? /^bin\/([A-Za-z0-9._-]+)\.(wasm|cid)$/.exec(p) : null;
    if (file) {
      if (!has(p as string)) bad.push(`programs.${role}: ${p} is not in the tree`);
      sources[role] = { kind: file[2] as "wasm" | "cid", path: p as string, name: file[1]! };
    } else if (typeof p === "string" && /^[a-z0-9][a-z0-9_-]*$/.test(p)) sources[role] = { kind: "instance", name: p };
    else bad.push(`programs.${role}: ${JSON.stringify(p)} is not bin/<x>.wasm, bin/<x>.cid or a program name`);
  }
  const isRole = (r: unknown): r is string => typeof r === "string" && r in sources;

  // boxes
  const boxes: Array<{ box: string; senders: string[] }> = [];
  if (m.boxes !== undefined && !Array.isArray(m.boxes)) bad.push("boxes: not a list");
  for (const [i, b] of (Array.isArray(m.boxes) ? m.boxes : []).entries()) {
    const box = typeof b === "string" ? b : isMap(b) ? (b as BoxIn).box : undefined;
    if (!isBox(box)) { bad.push(`boxes[${i}]: want a box name or {box, senders}`); continue; }
    const senders = typeof b === "string" || (b as BoxIn).senders === undefined ? ["$owner"] : (b as BoxIn).senders;
    if (!Array.isArray(senders) || !senders.length) { bad.push(`boxes[${i}] (${box}): senders is a non-empty list`); continue; }
    for (const s of senders) if (typeof s !== "string" || !(s === "*" || /^\$[a-z][a-z0-9_-]*$/.test(s) || KEY.test(s))) bad.push(`boxes[${i}] (${box}): sender ${JSON.stringify(s)} is not "*", "$<provider>" or an identity key (hex)`);
    if (boxes.some((x) => x.box === box)) bad.push(`boxes[${i}]: ${box} twice`);
    boxes.push({ box, senders: [...new Set(senders as string[])] });
  }

  // handler
  const handlers: Record<string, string> = {};
  if (typeof m.handler === "string") {
    if (!isRole(m.handler)) bad.push(`handler: ${m.handler} is not a role in programs`);
    else for (const b of boxes) handlers[b.box] = m.handler;
  } else if (isMap(m.handler)) {
    for (const [box, role] of Object.entries(m.handler)) {
      if (!isRole(role)) bad.push(`handler.${box}: ${JSON.stringify(role)} is not a role in programs`);
      else if (!boxes.some((b) => b.box === box)) bad.push(`handler.${box}: not a box the app asks for`);
      else handlers[box] = role;
    }
  } else if (m.handler !== undefined) bad.push("handler: a role, or {box: role}");
  if (boxes.length && m.handler === undefined) bad.push("handler: required (the app asks for boxes)");
  else if (isMap(m.handler)) for (const b of boxes) if (!(b.box in m.handler)) bad.push(`handler: no role for box ${b.box}`);

  // routes
  const routes: RouteIn[] = [];
  if (m.routes !== undefined && !Array.isArray(m.routes)) bad.push("routes: not a list");
  for (const [i, r] of (Array.isArray(m.routes) ? m.routes : []).entries()) {
    if (!isMap(r)) { bad.push(`routes[${i}]: not a map`); continue; }
    const at = r.path ?? r.prefix;
    if ((r.path === undefined) === (r.prefix === undefined) || typeof at !== "string") { bad.push(`routes[${i}]: want a path or a prefix (one)`); continue; }
    if (at.startsWith("libp2p:")) { bad.push(`routes[${i}]: ${at}: libp2p routes cannot be installed yet (the host's node subscribes only the genesis's topics and protocols)`); continue; }
    try { appPath(name || "app", at); } catch (e) { bad.push(`routes[${i}]: ${(e as Error).message}`); continue; }
    if (!isRole(r.program)) bad.push(`routes[${i}]: program ${JSON.stringify(r.program)} is not a role in programs`);
    if (typeof r.fn !== "string" || !r.fn) bad.push(`routes[${i}]: fn is not text`);
    if (r.auth !== undefined && r.auth !== "none") bad.push(`routes[${i}]: auth is "none" or absent (BRC-104)`);
    if (r.read !== undefined && typeof r.read !== "string") bad.push(`routes[${i}]: read is not text`);
    if (r.app !== undefined) bad.push(`routes[${i}]: app is set by the install`);
    routes.push(r as RouteIn);
  }
  const keys = routes.map((r) => `${r.path !== undefined ? "path" : "prefix"} ${appPath(name || "app", (r.path ?? r.prefix)!)}`);
  for (const [i, k] of keys.entries()) if (keys.indexOf(k) !== i) bad.push(`routes[${i}]: ${k} twice`);

  // heads
  const heads: string[] = [];
  if (m.heads !== undefined && !Array.isArray(m.heads)) bad.push("heads: not a list");
  for (const h of Array.isArray(m.heads) ? m.heads : []) {
    if (typeof h !== "string" || !h || /[\s\0]/.test(h)) bad.push(`heads: ${JSON.stringify(h)} is not a head name`);
    else if (RESERVED_HEADS.includes(h)) bad.push(`heads: ${h} is the instance's own`);
    else if (!heads.includes(h)) heads.push(h);
  }
  if (name && !heads.includes(name)) heads.unshift(name);

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

  // start, stop
  for (const k of ["start", "stop"] as const) {
    if (m[k] === undefined) continue;
    if (!isMap(m[k]) || !isMap((m[k] as { body?: unknown }).body)) bad.push(`${k}: want {body: {…}}`);
  }
  if (m.start !== undefined || m.stop !== undefined) {
    const own = boxes.find((b) => b.box === name);
    if (!own) bad.push(`start/stop go into the app's box: boxes must include ${name}`);
    else if (!own.senders.includes("*") && !own.senders.includes("$owner")) bad.push(`start/stop are the owner's: box ${name} must admit "$owner" or "*"`);
  }

  if (bad.length) throw new ManifestError(bad);
  const out = { ...(m as Manifest), boxes, heads, provides, requires, routes };
  return { manifest: out, sources, handlers };
}

/** The interfaces `requires` names that no installed app provides. */
export function missingInterfaces(requires: string[], installed: Array<{ provides?: Provide[] }>): string[] {
  const have = new Set(installed.flatMap((a) => (a.provides ?? []).map((p) => p.interface)));
  return requires.filter((r) => !have.has(r));
}

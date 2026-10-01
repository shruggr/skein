// Installing an app (#72, #76; docs/APPS.md §3): the owner's client. An app
// is a tree (a directory or a git repository) with etc/app.json; installing
// it into an instance is owner-signed messages to the instance's stock boxes,
// nothing else:
//
//   1. objects    the tree's git objects, the modules its bin/*.wasm carry,
//                 a program record per program, and the **app record** (below)
//                 — ≤ 1 MiB bundles; no bundle names a root (an app never
//                 becomes `main`)
//   2. head       {name: <app>, tree: <the app record>}
//   3. subscribe  one per (box, sender) the manifest asks for: {op: "add",
//                 sender?, box, handler: <the role's program record>} — "*" is
//                 no sender (anyone), "$owner" the owner, "$<provider>" the key
//                 the instance's address book gives that role, a hex key itself.
//                 (First, if the instance has no owner's `routes` box and the app
//                 asks for routes: {sender: owner, box: "routes", handler: <frontdoor>}.)
//      routes     one per route, to the box `routes` (the front door, #72):
//                 {op: "add", route: {path | prefix: "/<app>/…", program: <record>, fn, …, app}}
//   4. start      the manifest's `start.body`, into the app's box
//
// The **app record** is the head's root: the manifest as installed, so "what
// does this head provide" is one read (`head(<app>)`, `get`):
//
//   {kind: "app", name, version, programs: {<role>: <program record CID>},
//    handler?, config?, provides, requires, boxes: [{box, senders}], start?, stop?,
//    routes (as the manifest wrote them, relative), heads (the app's own first),
//    description?, tree: <the app's git tree>, state?: <the app's own state>}
//
// `state` is the app's: its handler advances the head to the record with
// `state` replaced (the SDK's app.Call.setState). An install over an earlier
// version carries `state` over, removes the subscriptions and routes the
// earlier record had and the new one does not, and sends `start` again (the
// restart). Uninstall: `stop`, then every subscription and route removed;
// the head is left.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { chunk, type Rec } from "../client/bundle.ts";
import { hashDir } from "../client/client.ts";
import { defaultIgnore } from "../dev/scan.ts";
import { encode, parse as parseCid } from "../runtime/cid.ts";
import { headTree } from "../runtime/heads.ts";
import type { IndexStore } from "../runtime/index-store.ts";
import type { Store } from "../runtime/store.ts";
import { currentSubscriptions } from "../runtime/subscriptions.ts";
import { programRecord, RAW, rawCid, wasmKind, type Objects } from "./boot.ts";
import { addressBook, type AddressEntry } from "./deploy.ts";
import { checkManifest, missingInterfaces, routePath, type Checked, type Derived, type Provide, type RouteIn } from "./manifest.ts";

const textOf = (b: Uint8Array) => new TextDecoder().decode(b);

/** What a tree carries that is not the app: build output, dependencies, VCS. */
export function appIgnore(rel: string): boolean {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  return defaultIgnore(rel) || base === "zig-out" || base === ".zig-cache" || base === "zig-pkg";
}

/** An app's tree: its directory, its git objects, its manifest checked. */
export interface AppTree { dir: string; root: CID; records: Rec[]; checked: Checked }

/** Read and check the app in `dir`. */
export async function readApp(dir: string): Promise<AppTree> {
  const p = join(dir, "etc/app.json");
  if (!existsSync(p)) throw new Error(`${dir}: no etc/app.json (an app is a tree with a manifest: docs/APPS.md §2)`);
  let json: unknown;
  try { json = JSON.parse(readFileSync(p, "utf8")); } catch (e) { throw new Error(`etc/app.json: ${(e as Error).message}`); }
  const checked = checkManifest(json, (rel) => existsSync(join(dir, rel)) && statSync(join(dir, rel)).isFile());
  const { root, records } = await hashDir(dir, { ignore: appIgnore });
  return { dir, root, records, checked };
}

/**
 * Where the app is: a directory, or a git repository URL (`<url>` or
 * `<url>#<rev>`) cloned into a temporary directory.
 */
export function fetchApp(spec: string): string {
  if (existsSync(spec) && statSync(spec).isDirectory()) return resolve(spec);
  if (!/^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/.test(spec)) throw new Error(`${spec}: not a directory or a git URL`);
  const [url, rev] = spec.split("#");
  const dir = join(mkdtempSync(join(tmpdir(), "skein-app-")), "app");
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim() || `exit ${r.status}`}`);
  };
  git("clone", "-q", ...(rev ? [] : ["--depth", "1"]), url!, dir);
  if (rev) git("-C", dir, "checkout", "-q", rev);
  return dir;
}

// ---------------------------------------------------------------- the instance as the client sees it

/** What the install reads of the instance (its store, read only). */
export interface InstanceView {
  store: Store;
  /** The genesis owner (hex) and programs (name → program record). */
  owner: string;
  programs: Record<string, CID>;
  addressBook: AddressEntry[];
  /** Every head and its root (the store's index). */
  heads: Array<{ name: string; root: CID }>;
  /** The subscriptions now (sender hex or none). */
  subscriptions: Array<{ sender?: string; box: string; handler: CID }>;
  /** The routes the genesis names, and the installed ones (the head `routes`). */
  genesisRoutes: Array<Record<string, unknown>>;
  installedRoutes: Array<Record<string, unknown>>;
}

export async function instanceView(store: Store): Promise<InstanceView> {
  let g: Record<string, unknown> | undefined;
  for await (const { entry } of store.log.entries(0)) {
    const c = (entry as { genesis?: CID }).genesis;
    if (c) g = await store.get(c) as Record<string, unknown>;
    break;
  }
  if (!g) throw new Error("the instance's store has no genesis yet");
  const heads = typeof (store as Partial<IndexStore>).heads === "function" ? (store as IndexStore).heads() : [];
  const routesRoot = await headTree(store, "routes");
  const installed = routesRoot ? ((await store.get(routesRoot) as { routes?: Array<Record<string, unknown>> }).routes ?? []) : [];
  return {
    store,
    owner: String(g.owner),
    programs: (g.programs ?? {}) as Record<string, CID>,
    addressBook: await addressBook(store),
    heads,
    subscriptions: ((await currentSubscriptions(store)) ?? []).map((s) => ({ ...(s.match.sender ? { sender: String(s.match.sender) } : {}), box: s.match.box!, handler: s.handler })),
    genesisRoutes: (g.routes ?? []) as Array<Record<string, unknown>>,
    installedRoutes: installed,
  };
}

/** The app record a head's root is, if it is one. */
export async function appRecordOf(store: Store, name: string): Promise<{ cid: CID; record: AppRecord } | undefined> {
  const root = await headTree(store, name);
  if (!root) return undefined;
  const r = await store.get(root).catch(() => undefined) as AppRecord | undefined;
  return r && r.kind === "app" ? { cid: root, record: r } : undefined;
}

/** The app record (a head's root): the manifest as installed. */
export type AppRecord = Omit<Checked["manifest"], "programs"> & { programs: Record<string, CID>; tree: CID; state?: CID };

// ---------------------------------------------------------------- the plan

export interface Sub { op: "add" | "remove"; box: string; sender?: string; label: string; handler: CID; role?: string }
export interface Route { op: "add" | "remove"; route: Record<string, unknown> & { app?: string } }

/** What an install sends, in order, and what it shows. */
export interface Plan {
  app: string;
  version: string;
  record: AppRecord;
  recordCid: CID;
  /** The records to send (the store does not have them), in order: objects, modules, program records, the app record. */
  records: Rec[];
  /** The owner's `routes` box, when the instance lacks it and the app has routes. */
  routesBox?: Sub;
  subscriptions: Sub[];
  routes: Route[];
  start?: Record<string, unknown>;
  /** An install over an earlier version. */
  upgrade?: string;
  /** For the prompt only. */
  requires: string[];
  heads: string[];
  publishes: string[];
  /** What `config.overlay` added to the boxes, routes and heads (APPS.md §6). */
  derived: Derived;
  notes: string[];
}

/** A sender as the manifest writes it → the key it is (hex) and how to show it; undefined key: anyone. */
function senderOf(s: string, view: InstanceView): { key?: string; label: string } {
  if (s === "*") return { label: "anyone" };
  if (s === "$owner") return { key: view.owner, label: `the owner (${view.owner.slice(0, 10)}…)` };
  if (s.startsWith("$")) {
    const e = view.addressBook.find((x) => x.role === s.slice(1));
    if (!e) throw new Error(`sender ${s}: the instance's address book has no ${s.slice(1)} provider (an entry with role "${s.slice(1)}")`);
    return { key: e.key, label: `${s} (${e.key.slice(0, 10)}…)` };
  }
  return { key: s, label: `${s.slice(0, 10)}…` };
}

/** The subscriptions and routes an app record asks for, resolved against the instance. */
export function wiring(record: AppRecord, view: InstanceView): { subscriptions: Sub[]; routes: Route[] } {
  const handlerOf = (box: string): { role: string; cid: CID } => {
    const role = typeof record.handler === "string" ? record.handler : record.handler?.[box];
    if (!role || !record.programs[role]) throw new Error(`box ${box}: no handler program`);
    return { role, cid: record.programs[role]! };
  };
  const subscriptions: Sub[] = [];
  for (const b of record.boxes) {
    const h = handlerOf(b.box);
    for (const s of b.senders) {
      const who = senderOf(s, view);
      subscriptions.push({ op: "add", box: b.box, ...(who.key ? { sender: who.key } : {}), label: who.label, handler: h.cid, role: h.role });
    }
  }
  const routes: Route[] = record.routes.map((r: RouteIn) => {
    const { path, prefix, program, ...rest } = r;
    const at = routePath(record.name, (path ?? prefix)!);
    return { op: "add", route: { ...rest, ...(path !== undefined ? { path: at } : { prefix: at }), program: record.programs[program]!, app: record.name } };
  });
  return { subscriptions, routes };
}

const subKey = (s: { sender?: string; box: string; handler: CID }) => `${s.sender ?? "*"} ${s.box} ${s.handler}`;
const routeKeyOf = (r: Record<string, unknown>) => (r.path !== undefined ? `path ${r.path}` : `prefix ${r.prefix}`);

/** The program records of the tree's programs, the modules to send, and the role → record map. */
async function programsOf(t: AppTree, view: InstanceView, extra: Objects): Promise<{ programs: Record<string, CID>; records: Rec[] }> {
  const programs: Record<string, CID> = {};
  const records: Rec[] = [];
  for (const [role, src] of Object.entries(t.checked.sources)) {
    if (src.kind === "instance") {
      const p = view.programs[src.name];
      if (!p) throw new Error(`programs.${role}: the instance has no program ${src.name} (its genesis names ${Object.keys(view.programs).join(", ")})`);
      programs[role] = p;
      continue;
    }
    let module: CID;
    if (src.kind === "wasm") {
      const bytes = new Uint8Array(readFileSync(join(t.dir, src.path)));
      if (!wasmKind(bytes)) throw new Error(`${src.path}: not a wasm module or component`);
      module = rawCid(bytes);
      records.push({ cid: module, bytes });
    } else {
      const text = readFileSync(join(t.dir, src.path), "utf8").trim();
      try { module = parseCid(text); } catch { throw new Error(`${src.path}: not a CID: ${JSON.stringify(text)}`); }
      if (module.code !== RAW) throw new Error(`${src.path}: ${module} is not a raw module CID`);
      if (!(await view.store.has(module))) {
        const bytes = await extra.get(module);
        if (!bytes) throw new Error(`${src.path}: names ${module}, which neither the instance nor this host holds`);
        records.push({ cid: module, bytes });
      }
    }
    const metaPath = join(t.dir, "bin", `${src.name}.json`);
    const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) as { inputs?: unknown; services?: string[]; description?: string } : {};
    // `app`: the program knows its app (its head) from its own record (APPS.md §2).
    const b = encode({ ...programRecord(src.name, module, meta), app: t.checked.manifest.name });
    programs[role] = b.cid;
    records.push({ cid: b.cid, bytes: b.bytes });
  }
  return { programs, records };
}

/** Plan the install of `t` into the instance `view` reads: every check (APPS.md §3 step 0), then what to send. */
export async function planInstall(t: AppTree, view: InstanceView, o: { modules: Objects }): Promise<Plan> {
  const m = t.checked.manifest;
  const notes: string[] = [];
  // requires: every interface is provided by some installed app (each head's root record).
  const installed: Array<{ name: string; provides?: Provide[]; heads?: string[] }> = [];
  for (const h of view.heads) {
    if (h.name === m.name) continue;
    const r = await view.store.get(h.root).catch(() => undefined) as AppRecord | undefined;
    if (r?.kind === "app") installed.push({ name: h.name, provides: r.provides, heads: r.heads });
  }
  const missing = missingInterfaces(m.requires, installed);
  if (missing.length) throw new Error(`requires ${missing.join(", ")}: no installed app provides ${missing.length > 1 ? "them" : "it"}`);
  // heads: the app's own is an app record or nothing; another app's heads are not asked for.
  const before = await appRecordOf(view.store, m.name);
  if (!before && view.heads.some((h) => h.name === m.name)) throw new Error(`head ${m.name} exists and its root is not an app record: another use of the name`);
  for (const h of m.heads) {
    const owner = installed.find((a) => a.name === h || (a.heads ?? []).includes(h));
    if (owner) throw new Error(`head ${h}: app ${owner.name} owns it`);
    if (h === "main") notes.push("head main is the shell's file system: the app asks to write it");
  }
  const { programs, records: progRecords } = await programsOf(t, view, o.modules);
  const { programs: _paths, ...rest } = m;
  void _paths;
  const record: AppRecord = JSON.parse(JSON.stringify({ ...rest, programs: {}, tree: null })) as AppRecord;
  record.programs = programs;
  record.tree = t.root;
  if (before?.record.state) record.state = before.record.state;
  const app = encode(record as never);

  const want = wiring(record, view);
  // Routes: none may take a path the genesis or another app has.
  const taken = new Map<string, string>();
  for (const r of view.genesisRoutes) taken.set(routeKeyOf(r), "the genesis");
  for (const r of view.installedRoutes) if (r.app !== m.name) taken.set(routeKeyOf(r), `app ${String(r.app ?? "?")}`);
  for (const r of want.routes) {
    const who = taken.get(routeKeyOf(r.route));
    if (who) throw new Error(`route ${routeKeyOf(r.route)}: ${who} has it`);
  }
  // An earlier version: what it had and this one has not is removed.
  const subscriptions = [...want.subscriptions];
  const routes = [...want.routes];
  if (before) {
    let old: ReturnType<typeof wiring> | undefined;
    try { old = wiring(before.record, view); } catch (e) { notes.push(`the installed version's wiring cannot be read (${(e as Error).message}): nothing of it removed`); }
    const keep = new Set(want.subscriptions.map(subKey));
    for (const s of old?.subscriptions ?? []) if (!keep.has(subKey(s))) subscriptions.push({ ...s, op: "remove" });
    const keepR = new Set(want.routes.map((r) => routeKeyOf(r.route)));
    for (const r of old?.routes ?? []) if (!keepR.has(routeKeyOf(r.route))) routes.push({ op: "remove", route: r.route });
  }
  // Only what changes: a subscription the instance has, a route installed as asked, are not sent again.
  const have = new Set(view.subscriptions.map(subKey));
  const sendSubs = subscriptions.filter((s) => (s.op === "add") !== have.has(subKey(s)));
  const installedNow = new Map(view.installedRoutes.map((r) => [routeKeyOf(r), r]));
  const sendRoutes = routes.filter((r) => {
    const cur = installedNow.get(routeKeyOf(r.route));
    if (r.op === "remove") return !!cur;
    return !cur || !sameRoute(cur, r.route);
  });
  let routesBox: Sub | undefined;
  if (sendRoutes.length && !view.subscriptions.some((s) => s.box === "routes" && s.sender === view.owner)) {
    const fd = view.programs.frontdoor;
    if (!fd) throw new Error("the app asks for routes, and the instance's genesis names no front door to keep them");
    routesBox = { op: "add", box: "routes", sender: view.owner, label: "the owner", handler: fd, role: "frontdoor" };
  }
  // Records the store has are not sent again.
  const all: Rec[] = [];
  const seen = new Set<string>();
  const trees = t.records.filter((r) => textOf(r.bytes.subarray(0, 5)) === "tree ");
  const blobs = t.records.filter((r) => textOf(r.bytes.subarray(0, 5)) !== "tree ");
  // blobs, then trees (children before parents: the root last), modules and program records, the app record.
  const ordered = [...blobs, ...trees.filter((r) => !r.cid.equals(t.root)), ...t.records.filter((r) => r.cid.equals(t.root)), ...progRecords, { cid: app.cid, bytes: app.bytes }];
  for (const r of ordered) {
    const k = r.cid.toString();
    if (seen.has(k)) continue;
    seen.add(k);
    if (!(await view.store.has(r.cid))) all.push(r);
  }
  const publishes = gossipOf(m.config);
  return {
    app: m.name, version: m.version, record, recordCid: app.cid, records: all, ...(routesBox ? { routesBox } : {}),
    subscriptions: sendSubs, routes: sendRoutes, ...(m.start ? { start: m.start.body } : {}),
    ...(before ? { upgrade: before.record.version } : {}), requires: m.requires, heads: m.heads, publishes, derived: t.checked.derived, notes,
  };
}

const sameRoute = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => encode(a as never).cid.equals(encode(b as never).cid);

/** What an overlay app publishes (APPS.md §6), for information: `<topic>`, `-admit`, `-proof` per topic not turned off. */
function gossipOf(config: Record<string, unknown> | undefined): string[] {
  const ov = config?.overlay as { topics?: Record<string, unknown>; gossip?: Record<string, boolean> } | undefined;
  if (!ov?.topics) return [];
  return Object.keys(ov.topics).filter((t) => ov.gossip?.[t] !== false).flatMap((t) => [t, `${t}-admit`, `${t}-proof`]);
}

/** The permission prompt: what the app asks for (APPS.md §3). */
export function describe(p: Plan, record = p.record): string[] {
  const out: string[] = [];
  out.push(`${p.upgrade ? "upgrade" : "install"} ${p.app} ${p.version}${p.upgrade ? ` (installed: ${p.upgrade})` : ""}${record.description ? ` — ${record.description}` : ""}`);
  const d = p.derived ?? { boxes: [], routes: [], heads: [] };
  const from = (yes: boolean) => (yes ? " (derived: config.overlay)" : "");
  out.push(`  head      ${p.heads.join(", ")} → the app record ${p.recordCid} (tree ${record.tree})`);
  if (d.heads.length) out.push(`  heads     ${d.heads.join(", ")}${from(true)}`);
  for (const b of record.boxes) {
    const role = typeof record.handler === "string" ? record.handler : record.handler?.[b.box];
    out.push(`  box       ${b.box} → ${role}, from ${b.senders.join(", ")}${from(d.boxes.includes(b.box))}`);
  }
  for (const r of record.routes) {
    const at = routePath(record.name, (r.path ?? r.prefix)!);
    out.push(`  route     ${r.path !== undefined ? at : `${at}*`} → ${r.program}.${r.fn}${r.auth === "none" ? " (open: no session)" : ""}${r.read ? ` (read ${r.read})` : ""}${from(r.path !== undefined && d.routes.includes(r.path))}`);
  }
  if (record.start) out.push(`  start     ${JSON.stringify(record.start.body)} into ${p.app}`);
  if (record.stop) out.push(`  stop      ${JSON.stringify(record.stop.body)} (at uninstall)`);
  if (p.requires.length) out.push(`  requires  ${p.requires.join(", ")}`);
  for (const pr of record.provides) out.push(`  provides  ${pr.interface}: ${Object.entries(pr.functions).map(([f, d]) => `${f}${d.writes ? "" : " (read)"}`).join(", ")}`);
  if (p.publishes.length) out.push(`  publishes ${p.publishes.join(", ")} (for information: emitting needs no grant)`);
  for (const n of p.notes) out.push(`  note      ${n}`);
  out.push(`  messages  objects ×${Math.max(1, [...chunk(p.records)].length)} (${p.records.length} records) · head · ${p.routesBox ? "subscribe routes → frontdoor · " : ""}subscribe ×${p.subscriptions.length} · routes ×${p.routes.length}${p.start ? " · start" : ""}`);
  for (const s of p.subscriptions) out.push(`    subscribe ${s.op} ${s.box} from ${s.label} → ${s.role ?? s.handler}`);
  for (const r of p.routes) out.push(`    routes    ${r.op} ${routeKeyOf(r.route)}`);
  return out;
}

/** Send a plan as the owner: `send(box, body)` is the owner's message to the instance. */
export async function sendInstall(p: Plan, send: (box: string, body: Uint8Array) => Promise<unknown>): Promise<{ messages: number }> {
  let n = 0;
  const go = async (box: string, body: Uint8Array) => { await send(box, body); n++; };
  for (const b of chunk(p.records)) await go("objects", b);
  await go("head", dagCbor.encode({ name: p.app, tree: p.recordCid }));
  if (p.routesBox) await go("subscribe", dagCbor.encode(subscribeBody(p.routesBox)));
  // Removes first: an upgrade frees what it no longer asks for.
  for (const s of [...p.subscriptions].sort((a, b) => (a.op === b.op ? 0 : a.op === "remove" ? -1 : 1))) await go("subscribe", dagCbor.encode(subscribeBody(s)));
  for (const r of [...p.routes].sort((a, b) => (a.op === b.op ? 0 : a.op === "remove" ? -1 : 1))) await go("routes", dagCbor.encode(routeBody(r)));
  if (p.start) await go(p.app, dagCbor.encode(p.start));
  return { messages: n };
}

const keyBytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const subscribeBody = (s: Sub) => ({ op: s.op, ...(s.sender ? { sender: keyBytes(s.sender) } : {}), box: s.box, handler: s.handler });
const routeBody = (r: Route) => r.op === "add" ? { op: "add", route: r.route } : { op: "remove", route: r.route.path !== undefined ? { path: r.route.path } : { prefix: r.route.prefix } };

// ---------------------------------------------------------------- uninstall

export interface UninstallPlan { app: string; record: AppRecord; stop?: Record<string, unknown>; subscriptions: Sub[]; routes: Route[] }

/** What uninstalling `name` sends: `stop`, then its subscriptions and routes removed. The head is left. */
export async function planUninstall(name: string, view: InstanceView): Promise<UninstallPlan> {
  const a = await appRecordOf(view.store, name);
  if (!a) throw new Error(`${name}: no app installed under that head`);
  const w = wiring(a.record, view);
  const have = new Set(view.subscriptions.map(subKey));
  const routes = new Set(view.installedRoutes.filter((r) => r.app === name).map(routeKeyOf));
  return {
    app: name, record: a.record, ...(a.record.stop ? { stop: a.record.stop.body } : {}),
    subscriptions: w.subscriptions.filter((s) => have.has(subKey(s))).map((s) => ({ ...s, op: "remove" as const })),
    routes: view.installedRoutes.filter((r) => r.app === name && routes.has(routeKeyOf(r))).map((r) => ({ op: "remove" as const, route: r })),
  };
}

export async function sendUninstall(p: UninstallPlan, send: (box: string, body: Uint8Array) => Promise<unknown>): Promise<{ messages: number }> {
  let n = 0;
  const go = async (box: string, body: Uint8Array) => { await send(box, body); n++; };
  if (p.stop) await go(p.app, dagCbor.encode(p.stop));
  for (const s of p.subscriptions) await go("subscribe", dagCbor.encode(subscribeBody(s)));
  for (const r of p.routes) await go("routes", dagCbor.encode(routeBody(r)));
  return { messages: n };
}

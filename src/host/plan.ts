// The install's plan (#72, #77, #91, #143; docs/APPS.md §3): what installing or
// uninstalling an app sends, as root, to the kernel's admin boxes — objects,
// the head, the routes; no key (#143: "the person who's doing the deploying is
// root and doesn't need to grant themselves anything") — read from a view of
// the instance: its heads, route table, address book, genesis programs, and
// its store by CID. No node APIs: the node client
// (install.ts and src/client/admin.ts: `skein install`, #124, a store file's or the explorer's view) and the management
// site (shruggr/skein-site, #92: a view over the instance's explorer reads, in
// a browser) plan with the same code. install.ts's header has the steps.

import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { chunk, type Rec } from "../client/bundle.ts";
import { encode, parse as parseCid } from "../runtime/cid.ts";
import { rowKey as kernelRowKey, type DispatchRow } from "../runtime/dispatch.ts";
import { programRecord, RAW, rawCid, wasmKind } from "../runtime/programs.ts";
import { readBlob, readTree } from "../runtime/tree.ts";
import type { Store } from "../runtime/store.ts";
// Types only (erased): boot.ts and deploy.ts are node code.
import type { Objects } from "./boot.ts";
import type { AddressEntry } from "./deploy.ts";
import { checkManifest, filterRef, handlerOf, missingInterfaces, rowAddress, routeKey, type Checked, type Derived, type Provide, type Route, type ShellSource } from "./manifest.ts";

const textOf = (b: Uint8Array) => new TextDecoder().decode(b);

/** What the plan reads of the instance's store: blocks by CID. */
export type ViewStore = Pick<Store, "get" | "has" | "bytes" | "putBlock">;

/** A file of an app's tree by its path ("bin/x.wasm"), or undefined: the install reads nothing else. */
export type ReadFile = (rel: string) => Uint8Array | undefined;

/**
 * An app's tree: its root, the git objects to send (none for a tree the
 * instance holds), its manifest checked, and its files as the install reads
 * them.
 */
export interface AppTree { root: CID; records: Rec[]; checked: Checked; read: ReadFile }

export function parseManifest(text: string): unknown {
  try { return JSON.parse(text); } catch (e) { throw new Error(`etc/app.json: ${(e as Error).message}`); }
}

/**
 * Read and check the app whose tree the instance's store holds (#91: the
 * git app's clone; reads are open by CID). Only the files the install reads
 * are fetched out of the store: the manifest, and what its programs name.
 */
export async function readStoredApp(store: Pick<Store, "bytes" | "has" | "putBlock">, tree: CID): Promise<AppTree> {
  const files = new Map<string, CID>();
  const walk = async (t: CID, at: string): Promise<void> => {
    for (const e of await readTree(store, t)) {
      const path = at ? `${at}/${e.name}` : e.name;
      if (e.mode === "40000") await walk(e.cid, path);
      else if (e.mode === "100644" || e.mode === "100755") files.set(path, e.cid);
    }
  };
  await walk(tree, "");
  const m = files.get("etc/app.json");
  if (!m) throw new Error(`${tree}: no etc/app.json (an app is a tree with a manifest: docs/APPS.md §2)`);
  const checked = checkManifest(parseManifest(new TextDecoder().decode(await readBlob(store, m))), (rel) => files.has(rel));
  const wanted = new Set<string>();
  for (const src of Object.values(checked.sources)) {
    if (src.kind === "wasm" || src.kind === "cid") { wanted.add(src.path); wanted.add(`bin/${src.name}.json`); }
    if (src.kind === "shell") {
      for (const p of Object.values(src.modules)) wanted.add(p);
      for (const x of Object.values(src.support)) for (const p of Object.values(x.files)) wanted.add(p);
    }
  }
  const bytes = new Map<string, Uint8Array>();
  for (const p of wanted) { const c = files.get(p); if (c) bytes.set(p, await readBlob(store, c)); }
  return { root: tree, records: [], checked, read: (rel) => bytes.get(rel) };
}

/** What the install reads of the instance (its store, read only). */
export interface InstanceView {
  store: ViewStore;
  /** The instance's identity (hex), and programs (name → program record). */
  identity: string;
  programs: Record<string, CID>;
  addressBook: AddressEntry[];
  /** Every head and its root (the store's index). */
  heads: Array<{ name: string; root: CID }>;
  /** The route table now (#77): a route with `app` was installed by that app; without, it is the genesis's or root's own. */
  dispatch: DispatchRow[];
}

/** The app's root head (#77): `<name>/app`. */
export const appHead = (name: string) => `${name}/app`;

/** The app record the view's head `<name>/app` names, if it is one. */
export async function appRecordIn(view: Pick<InstanceView, "store" | "heads">, name: string): Promise<{ cid: CID; record: AppRecord } | undefined> {
  const root = view.heads.find((h) => h.name === appHead(name))?.root;
  if (!root) return undefined;
  const r = await view.store.get(root).catch(() => undefined) as AppRecord | undefined;
  return r && r.kind === "app" ? { cid: root, record: r } : undefined;
}

/** The app record (a head's root): the manifest as installed. */
export type AppRecord = Omit<Checked["manifest"], "programs"> & { programs: Record<string, CID>; tree: CID; state?: CID };

// ---------------------------------------------------------------- the plan

/** A manifest's `config` with `over` merged in: per program, its keys over the manifest's. */
export function mergeConfig(base: Record<string, unknown> | undefined, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, x] of Object.entries(over)) {
    const b = out[k];
    out[k] = x && typeof x === "object" && !Array.isArray(x) && b && typeof b === "object" && !Array.isArray(b) ? { ...b as Record<string, unknown>, ...x as Record<string, unknown> } : x;
  }
  return out;
}


/** A route change the install sends: the route as the kernel takes it (filters named in full, program a CID, address as served, `app`), and the role it runs. */
export interface RowOp { op: "add" | "remove"; row: DispatchRow & { app?: string }; role?: string }
export interface HeadOp { name: string; tree: CID }

/** What an install sends, in order, and what it shows. */
export interface Plan {
  app: string;
  version: string;
  record: AppRecord;
  recordCid: CID;
  /** The records to send (the store does not have them), in order: objects, modules, program records, the app record. */
  records: Rec[];
  heads: HeadOp[];
  rows: RowOp[];
  start?: Record<string, unknown>;
  /** An install over an earlier version. */
  upgrade?: string;
  /** For the prompt only. */
  requires: string[];
  publishes: string[];
  /** What `config.overlay` added (APPS.md §6). */
  derived: Derived;
  notes: string[];
}

/**
 * The routes an app record asks for, resolved against the instance (#143): each as the kernel
 * takes it — the address as served, the filters named in full (an own filter `<app>.<name>`, the
 * kernel's and another app's as written), the handler's role's program record and its `fn`, and
 * `app`; a read route (no handler) has no program. Another app's filter must be one that app's
 * installed record declares.
 */
export async function wiring(record: AppRecord, view: InstanceView): Promise<RowOp[]> {
  const out: RowOp[] = [];
  const roles = Object.keys(record.programs);
  for (const r of record.routes as Route[]) {
    const { transport, address, prefix, filters, handler, ...settings } = r;
    const full = (filters ?? []).map((f) => filterRef(record.name, f));
    for (const f of full) {
      const dot = f.lastIndexOf(".");
      const app = f.slice(0, dot), name = f.slice(dot + 1);
      if (app === "kernel" || app === record.name) continue;
      const other = await appRecordIn(view, app);
      if (!other) throw new Error(`route ${routeKey(record.name, r)}: filter ${f}: no app ${app} is installed`);
      if (!other.record.filters || !(name in other.record.filters)) throw new Error(`route ${routeKey(record.name, r)}: filter ${f}: app ${app} declares no filter ${name}`);
    }
    const base = { ...settings, transport, address: rowAddress(record.name, r), ...(prefix ? { prefix: true } : {}), ...(full.length ? { filters: full } : {}) };
    if (handler === undefined) { out.push({ op: "add", row: { ...base, app: record.name } as DispatchRow & { app: string } }); continue; }
    const h = handlerOf(handler, roles);
    const cid = h && record.programs[h.role];
    if (!h || !cid) throw new Error(`route ${routeKey(record.name, r)}: handler ${handler}: no program for it`);
    out.push({ op: "add", row: { ...base, program: cid, ...(h.fn ? { fn: h.fn } : {}), app: record.name } as DispatchRow & { app: string }, role: h.role });
  }
  return out;
}

/** A route's key as the kernel's table knows it (the resolved route). */
const keyOf = (r: DispatchRow) => kernelRowKey(r);
/** The fields of a route that are not its settings (its key, filters, program, `fn`; `app` the install's). */
const ROW_CORE = new Set(["transport", "address", "prefix", "filters", "program", "fn", "handler", "app"]);
/** A route's settings as the prompt shows them (` (root www)`), or "". */
const showSettings = (r: object): string => {
  const s = Object.entries(r).filter(([k, v]) => !ROW_CORE.has(k) && v !== undefined).map(([k, v]) => `${k} ${typeof v === "string" ? v : JSON.stringify(v)}`);
  return s.length ? ` (${s.join(", ")})` : "";
};
/** A route's filters as the prompt shows them: ` [kernel.brc104, amm.quote]`, or "". */
const showFilters = (fs: unknown): string => Array.isArray(fs) && fs.length ? ` [${fs.join(", ")}]` : "";
/** A route as one line of the prompt: `<transport> <address>[ prefix] [<filters>] → <role>[.<fn>] | (a read: its filters answer)[ (<settings>)]`. */
const showRow = (r: RowOp) => `${r.row.transport} ${r.row.address}${r.row.prefix ? " prefix" : ""}${showFilters(r.row.filters)} → ${r.row.program === undefined ? "(a read: its filters answer)" : `${r.role ?? String(r.row.program)}${r.row.fn ? `.${r.row.fn}` : ""}`}${showSettings(r.row)}`;

/** The program records of the tree's programs, the modules to send, and the role → record map. */
async function programsOf(t: AppTree, view: InstanceView, extra: Objects): Promise<{ programs: Record<string, CID>; records: Rec[] }> {
  const programs: Record<string, CID> = {};
  const records: Rec[] = [];
  for (const [role, src] of Object.entries(t.checked.sources)) {
    if (src.kind === "shell") {
      const { record, blocks } = shellProgram(t.read, role, src, t.checked.manifest.name);
      records.push(...blocks);
      const b = encode(record as never);
      programs[role] = b.cid;
      records.push({ cid: b.cid, bytes: b.bytes });
      continue;
    }
    if (src.kind === "instance") {
      const p = view.programs[src.name];
      if (!p) throw new Error(`programs.${role}: the instance has no program ${src.name} (its genesis names ${Object.keys(view.programs).join(", ")})`);
      programs[role] = p;
      continue;
    }
    let module: CID;
    const file = (path: string) => { const b = t.read(path); if (!b) throw new Error(`${path}: not in the tree`); return b; };
    if (src.kind === "wasm") {
      const bytes = file(src.path);
      if (!wasmKind(bytes)) throw new Error(`${src.path}: not a wasm module or component`);
      module = rawCid(bytes);
      records.push({ cid: module, bytes });
    } else {
      const text = new TextDecoder().decode(file(src.path)).trim();
      try { module = parseCid(text); } catch { throw new Error(`${src.path}: not a CID: ${JSON.stringify(text)}`); }
      if (module.code !== RAW) throw new Error(`${src.path}: ${module} is not a raw module CID`);
      if (!(await view.store.has(module))) {
        const bytes = await extra.get(module);
        if (!bytes) throw new Error(`${src.path}: names ${module}, which neither the instance nor this host holds`);
        records.push({ cid: module, bytes });
      }
    }
    const metaFile = t.read(`bin/${src.name}.json`);
    const meta = metaFile ? JSON.parse(new TextDecoder().decode(metaFile)) as { inputs?: unknown; services?: string[]; description?: string } : {};
    // `app`: the program knows its app (its heads under `<app>/`) from its own record (APPS.md §2).
    const b = encode({ ...programRecord(src.name, module, meta), app: t.checked.manifest.name });
    programs[role] = b.cid;
    records.push({ cid: b.cid, bytes: b.bytes });
  }
  return { programs, records };
}

/** The inputs of a shell program record (the kernel's shell thread takes {cmd, tree, cwd?, env?}). */
export const SHELL_INPUTS = { cmd: "string", tree: "cid", cwd: "string?", env: "map?" } as const;
const SHELL_DESCRIPTION = "Run a bash command in the wasm shell over a tree; result {exitCode, stdout, stderr, tree}.";

/**
 * A shell program's record (#83; docs/APPS.md "A shell program") from the
 * manifest's form, and the raw blocks it names: `{kind: "program", name:
 * <role>, code: {ts: "shell"}, modules: {<command>: <raw module CID>},
 * support: {<command>: {mount, files: {<path>: <raw CID>}, env}}, inputs,
 * services: [], description, app}` — the shape the kernel's shell runs
 * (kernel-zig/src/shell.zig loadModules), each module and support file a raw
 * block of the tree's file.
 */
export function shellProgram(read: ReadFile, role: string, src: ShellSource, app: string): { record: Record<string, unknown>; blocks: Rec[] } {
  const blocks = new Map<string, Rec>();
  const raw = (path: string, module: boolean): CID => {
    const bytes = read(path);
    if (!bytes) throw new Error(`${path}: not in the tree`);
    if (module && wasmKind(bytes) !== "module") throw new Error(`${path}: not a wasm module (a shell program runs WASI preview1 modules)`);
    const cid = rawCid(bytes);
    blocks.set(cid.toString(), { cid, bytes });
    return cid;
  };
  const modules = Object.fromEntries(Object.entries(src.modules).map(([cmd, path]) => [cmd, raw(path, true)]));
  const support = Object.fromEntries(Object.entries(src.support).map(([cmd, s]) => [cmd, {
    mount: s.mount, files: Object.fromEntries(Object.entries(s.files).map(([under, path]) => [under, raw(path, false)])), env: s.env,
  }]));
  return {
    record: { kind: "program", name: role, code: { ts: "shell" }, modules, support, inputs: SHELL_INPUTS, services: [], description: src.description ?? SHELL_DESCRIPTION, app },
    blocks: [...blocks.values()],
  };
}

/**
 * Plan the install of `t` into the instance `view` reads: every check (APPS.md §3 step 0), then what to send.
 * An image's install at birth (#141, boot.ts) is the same plan: its routes go into the genesis.
 */
export async function planInstall(t: AppTree, view: InstanceView, o: { modules: Objects }): Promise<Plan> {
  const m = t.checked.manifest;
  const notes: string[] = [];
  // requires: every interface is provided by some installed app (each app head's root record).
  const installed: Array<{ name: string; provides?: Provide[] }> = [];
  for (const h of view.heads) {
    if (!h.name.endsWith("/app") || h.name === appHead(m.name)) continue;
    const r = await view.store.get(h.root).catch(() => undefined) as AppRecord | undefined;
    if (r?.kind === "app") installed.push({ name: h.name.slice(0, -"/app".length), provides: r.provides });
  }
  const missing = missingInterfaces(m.requires, installed);
  if (missing.length) throw new Error(`requires ${missing.join(", ")}: no installed app provides ${missing.length > 1 ? "them" : "it"}`);
  // The name is identity (#77): its root head is an app record or nothing.
  const before = await appRecordIn(view, m.name);
  if (!before && view.heads.some((h) => h.name === appHead(m.name))) throw new Error(`head ${appHead(m.name)} exists and its root is not an app record: another use of the name`);
  const { programs, records: progRecords } = await programsOf(t, view, o.modules);
  const { programs: _paths, ...rest } = m;
  void _paths;
  const record: AppRecord = JSON.parse(JSON.stringify({ ...rest, programs: {}, tree: null })) as AppRecord;
  record.programs = programs;
  record.tree = t.root;
  if (before?.record.state) record.state = before.record.state;
  const app = encode(record as never);

  const want = await wiring(record, view);
  // No route may take a key the genesis, root or another app has.
  const taken = new Map<string, string>();
  for (const r of view.dispatch) if (r.app !== m.name) taken.set(keyOf(r), r.app ? `app ${r.app}` : "the genesis (or root's own)");
  for (const r of want) {
    const who = taken.get(keyOf(r.row));
    if (who) throw new Error(`route ${keyOf(r.row)}: ${who} has it`);
  }
  // An earlier version: what it had and this one has not is removed.
  const rows = [...want];
  if (before) {
    const keep = new Set(want.map((r) => keyOf(r.row)));
    for (const r of view.dispatch) if (r.app === m.name && !keep.has(keyOf(r))) rows.push({ op: "remove", row: r });
  }
  // Only what changes: a row the instance has as asked is not sent again.
  const have = new Map(view.dispatch.map((r) => [keyOf(r), r]));
  const sendRows = rows.filter((r) => {
    const cur = have.get(keyOf(r.row));
    if (r.op === "remove") return !!cur;
    return !cur || !sameRow(cur, r.row);
  });
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
  const heads: HeadOp[] = [{ name: appHead(m.name), tree: app.cid }];
  const publishes = gossipOf(m.config);
  return {
    app: m.name, version: m.version, record, recordCid: app.cid, records: all, heads,
    rows: sendRows, ...(m.start ? { start: m.start.body } : {}),
    ...(before ? { upgrade: before.record.version } : {}), requires: m.requires, publishes, derived: t.checked.derived, notes,
  };
}

const sameRow = (a: DispatchRow, b: DispatchRow): boolean => encode(a as never).cid.equals(encode(b as never).cid);

/** What an overlay app publishes (APPS.md §6), for information: `<topic>`, `-admit`, `-proof` per topic not turned off. */
function gossipOf(config: Record<string, unknown> | undefined): string[] {
  const ov = config?.overlay as { topics?: Record<string, unknown>; gossip?: Record<string, boolean> } | undefined;
  if (!ov?.topics) return [];
  return Object.keys(ov.topics).filter((t) => ov.gossip?.[t] !== false).flatMap((t) => [t, `${t}-admit`, `${t}-proof`]);
}

/** The permission prompt: what the app asks for (APPS.md §3) — its routes, filters and roles read aloud. */
export function describe(p: Plan, record = p.record): string[] {
  const out: string[] = [];
  out.push(`${p.upgrade ? "upgrade" : "install"} ${p.app} ${p.version}${p.upgrade ? ` (installed: ${p.upgrade})` : ""}${record.description ? ` — ${record.description}` : ""}`);
  const d = p.derived ?? { routes: [] };
  const from = (yes: boolean) => (yes ? " (derived: config.overlay)" : "");
  for (const h of p.heads) out.push(`  head      ${h.name} → the app record ${p.recordCid} (tree ${record.tree})`);
  for (const r of record.routes) {
    const k = routeKey(record.name, r);
    out.push(`  route     ${r.transport} ${rowAddress(record.name, r)}${r.prefix ? " prefix" : ""}${showFilters((r.filters ?? []).map((f) => filterRef(record.name, f)))} → ${r.handler ?? "(a read: its filters answer, nothing logged)"}${showSettings(r)}${from(d.routes.includes(k))}`);
  }
  for (const [f, h] of Object.entries(record.filters ?? {})) out.push(`  filter    ${record.name}.${f} → ${h} (any route may list it; runs before anything is recorded)`);
  for (const [role, fns] of Object.entries(record.roles ?? {})) out.push(`  role      ${role === "root" || role === "user" ? role : `${record.name}.${role}`} gates ${fns.join(", ")}`);
  if (record.start) out.push(`  start     ${JSON.stringify(record.start.body)} into ${p.app}`);
  if (record.stop) out.push(`  stop      ${JSON.stringify(record.stop.body)} (at uninstall)`);
  if (p.requires.length) out.push(`  requires  ${p.requires.join(", ")}`);
  for (const pr of record.provides) out.push(`  provides  ${pr.interface}: ${Object.entries(pr.functions).map(([f, x]) => `${f}${x.writes ? "" : " (read)"}`).join(", ")}`);
  if (p.publishes.length) out.push(`  publishes ${p.publishes.join(", ")} (for information: emitting needs no grant)`);
  for (const n of p.notes) out.push(`  note      ${n}`);
  out.push(`  messages  objects ×${Math.max(1, [...chunk(p.records)].length)} (${p.records.length} records) · head ×${p.heads.length} · dispatch ×${p.rows.length}${p.start ? " · start" : ""}`);
  for (const r of p.rows) out.push(`    dispatch ${r.op} ${showRow(r)}`);
  return out;
}

/** Send a plan as root: `send(box, body)` is root's message to the instance. */
export async function sendInstall(p: Plan, send: (box: string, body: Uint8Array) => Promise<unknown>): Promise<{ messages: number }> {
  let n = 0;
  const go = async (box: string, body: Uint8Array) => { await send(box, body); n++; };
  for (const b of chunk(p.records)) await go("objects", b);
  for (const h of p.heads) await go("head", dagCbor.encode({ name: h.name, tree: h.tree }));
  // Removes first: an upgrade frees what it no longer asks for.
  for (const r of [...p.rows].sort((a, b) => (a.op === b.op ? 0 : a.op === "remove" ? -1 : 1))) await go("dispatch", dagCbor.encode(rowBody(r)));
  if (p.start) await go(p.app, dagCbor.encode(p.start));
  return { messages: n };
}

/** The kernel's `dispatch` operation's body: an add carries the whole row; a remove its key fields suffice (the row is sent as held). */
const rowBody = (r: RowOp) => ({ op: r.op, row: r.row });

// ---------------------------------------------------------------- uninstall

export interface UninstallPlan { app: string; record: AppRecord; stop?: Record<string, unknown>; rows: RowOp[] }

/** What uninstalling `name` sends: `stop`, then its routes removed (every route the table holds with `app: name`). The app's heads are left. */
export async function planUninstall(name: string, view: InstanceView): Promise<UninstallPlan> {
  const a = await appRecordIn(view, name);
  if (!a) throw new Error(`${name}: no app installed under that head`);
  return {
    app: name, record: a.record, ...(a.record.stop ? { stop: a.record.stop.body } : {}),
    rows: view.dispatch.filter((r) => r.app === name).map((r) => ({ op: "remove" as const, row: r })),
  };
}

export async function sendUninstall(p: UninstallPlan, send: (box: string, body: Uint8Array) => Promise<unknown>): Promise<{ messages: number }> {
  let n = 0;
  const go = async (box: string, body: Uint8Array) => { await send(box, body); n++; };
  if (p.stop) await go(p.app, dagCbor.encode(p.stop));
  for (const r of p.rows) await go("dispatch", dagCbor.encode(rowBody(r)));
  return { messages: n };
}

// ---------------------------------------------------------------- root's own routes (#143)

/**
 * Root's own route (#143; `skein routes`): one `dispatch` add or remove of a route with no `app`
 * — an app's upgrade or uninstall leaves it. The site at the instance's root is one: a read route
 * {transport: "http", address: "/", prefix: true, filters: ["site.get"], root: "www"} (the site's
 * filter answering every path no longer route takes). Refused at a key another route has; a filter
 * of an app must be one its installed record declares.
 */
export async function planRootRoute(view: InstanceView, op: "add" | "remove", row: DispatchRow): Promise<{ prompt: string[]; rows: RowOp[] }> {
  const k = keyOf(row);
  const held = view.dispatch.find((r) => keyOf(r) === k);
  if (op === "add") {
    if (held && held.app) throw new Error(`route ${k}: app ${held.app} has it`);
    for (const f of row.filters ?? []) {
      const dot = f.lastIndexOf(".");
      const app = f.slice(0, dot), name = f.slice(dot + 1);
      if (app === "kernel") continue;
      const rec = await appRecordIn(view, app);
      if (!rec?.record.filters || !(name in rec.record.filters)) throw new Error(`route ${k}: filter ${f}: no installed app ${app} declares it`);
    }
  } else if (!held || held.app) throw new Error(`route ${k}: root has no route there`);
  const { app: _app, ...own } = row;
  void _app;
  // A remove sends the route as held (the kernel checks it whole).
  const r: RowOp = { op, row: op === "remove" ? held! : own as DispatchRow };
  return { prompt: [`dispatch ${op} ${showRow(r)} (root's own: no app)`], rows: [r] };
}

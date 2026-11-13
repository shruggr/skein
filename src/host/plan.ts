// The install's plan (skein next, SPEC.md section 3; docs/APPS.md §3): what installing or
// uninstalling an app hands the instance as root — requests to the kernel's operation rows
// (`kernel.objects`, `kernel.head`, `kernel.route`, `kernel.grant`: images/default etc/routes.json,
// role root) — read from a view of the instance: its heads, its route table and its store by CID.
// No node APIs: the node client (install.ts, src/client/admin.ts) and an image's install at birth
// (boot.ts) plan with the same code. Each request returns data: done, or refused with the reason.

import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { chunk, type Rec } from "../client/bundle.ts";
import { encode, parse as parseCid } from "../runtime/cid.ts";
import { rowApp, rowKey, rowProblem, type DispatchRow } from "../runtime/dispatch.ts";
import { programRecord, RAW, rawCid, wasmKind } from "../runtime/programs.ts";
import { readBlob, readTree } from "../runtime/tree.ts";
import type { Store } from "../runtime/store.ts";
// Types only (erased): boot.ts is node code.
import type { Objects } from "./boot.ts";
import { checkManifest, missingInterfaces, rowOf, type Checked, type Provide, type RouteIn } from "./manifest.ts";

const textOf = (b: Uint8Array) => new TextDecoder().decode(b);

/** The kernel's operation rows' paths (images/default etc/routes.json; the claim's: role user, the rest role root). */
export const KERNEL_PATHS = { objects: "/kernel/objects", head: "/kernel/head", route: "/kernel/route", grant: "/kernel/grant", claim: "/kernel/claim" } as const;

/** What the plan reads of the instance's store: blocks by CID. */
export type ViewStore = Pick<Store, "get" | "has" | "bytes" | "putBlock">;

/** A file of an app's tree by its path ("bin/x.wasm"), or undefined: the install reads nothing else. */
export type ReadFile = (rel: string) => Uint8Array | undefined;

/** An app's tree: its root, the git objects to send (none for a tree the instance holds), its manifest checked, and its files as the install reads them. */
export interface AppTree { root: CID; records: Rec[]; checked: Checked; read: ReadFile }

export function parseManifest(text: string): unknown {
  try { return JSON.parse(text); } catch (e) { throw new Error(`etc/app.json: ${(e as Error).message}`); }
}

/** Read and check the app whose tree the store holds. Only the files the install reads are fetched: the manifest, and what its programs name. */
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
  for (const src of Object.values(checked.sources)) { wanted.add(src.path); wanted.add(`bin/${src.name}.json`); }
  const bytes = new Map<string, Uint8Array>();
  for (const p of wanted) { const c = files.get(p); if (c) bytes.set(p, await readBlob(store, c)); }
  return { root: tree, records: [], checked, read: (rel) => bytes.get(rel) };
}

/** What the install reads of the instance (its store, read only). */
export interface InstanceView {
  store: ViewStore;
  /** The instance's identity (hex). */
  identity: string;
  /** Every head and its root (the store's index). */
  heads: Array<{ name: string; root: CID }>;
  /** The route table now: a row whose handler is an app's belongs to that app (rowApp); a kernel row, or root's own, to none. */
  dispatch: DispatchRow[];
}

/** The app's root head: `<name>/app`. */
export const appHead = (name: string) => `${name}/app`;

/** The app record the view's head `<name>/app` names, if it is one. */
export async function appRecordIn(view: Pick<InstanceView, "store" | "heads">, name: string): Promise<{ cid: CID; record: AppRecord } | undefined> {
  const root = view.heads.find((h) => h.name === appHead(name))?.root;
  if (!root) return undefined;
  const r = await view.store.get(root).catch(() => undefined) as AppRecord | undefined;
  return r && r.kind === "app" ? { cid: root, record: r } : undefined;
}

/** The app record (a head's root): the manifest as installed (`programs` role → program record; the kernel resolves "<app>.<role>.<fn>" through it). */
export type AppRecord = Omit<Checked["manifest"], "programs"> & { programs: Record<string, CID>; tree: CID; state?: CID };

/** A manifest's `config` with `over` merged in: per program, its keys over the manifest's. */
export function mergeConfig(base: Record<string, unknown> | undefined, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, x] of Object.entries(over)) {
    const b = out[k];
    out[k] = x && typeof x === "object" && !Array.isArray(x) && b && typeof b === "object" && !Array.isArray(b) ? { ...b as Record<string, unknown>, ...x as Record<string, unknown> } : x;
  }
  return out;
}

/** A row change the install hands the kernel's route operation: {op, row}. */
export interface RowOp { op: "add" | "remove"; row: DispatchRow }
export interface HeadOp { name: string; tree: CID }
/** A grant the install hands the kernel's grant operation (call permissions). */
export type GrantOp =
  | { op: "add" | "remove"; calls: { caller: string; callee: string; name: string } }
  | { op: "add" | "remove"; service: { caller: string; service: string } };

/** The grants a manifest asks for (its `calls` and `services`), as adds for `caller`. */
export function grantsOf(caller: string, asked: { calls?: Record<string, string[] | "*">; services?: string[] }): GrantOp[] {
  const out: GrantOp[] = [];
  for (const [callee, names] of Object.entries(asked.calls ?? {})) for (const name of names === "*" ? ["*"] : names) out.push({ op: "add", calls: { caller, callee, name } });
  for (const service of asked.services ?? []) out.push({ op: "add", service: { caller, service } });
  return out;
}

/** What the grants head holds for `caller` (its `calls` and `services`), as adds: what an upgrade or an uninstall takes back from. */
export async function grantsHeld(view: InstanceView, caller: string): Promise<GrantOp[]> {
  const root = view.heads.find((h) => h.name === "grants")?.root;
  const g = root ? await view.store.get(root).catch(() => undefined) as { calls?: Record<string, Record<string, string[]>>; services?: Record<string, string[]> } | undefined : undefined;
  const out: GrantOp[] = [];
  for (const [callee, names] of Object.entries(g?.calls?.[caller] ?? {})) for (const name of names) out.push({ op: "add", calls: { caller, callee, name } });
  for (const service of g?.services?.[caller] ?? []) out.push({ op: "add", service: { caller, service } });
  return out;
}

const grantKey = (g: GrantOp): string => ("calls" in g ? `calls ${g.calls.caller} ${g.calls.callee} ${g.calls.name}` : `service ${g.service.caller} ${g.service.service}`);

/** A grant as one line of the prompt. */
export function showGrant(g: GrantOp): string {
  if ("calls" in g) return `${g.op === "remove" ? "no longer " : ""}calls ${g.calls.callee} as ${g.calls.name === "*" ? "ANY NAME (admin)" : JSON.stringify(g.calls.name)}`;
  return `${g.op === "remove" ? "no longer holds" : "holds"} service ${g.service.service}${g.service.service === "signer" ? " (the raw signer import: any derivation)" : ""}`;
}

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
  /** Call permissions: adds for what the record asks, removes for what an earlier version asked and this one does not. */
  grants: GrantOp[];
  /** An install over an earlier version. */
  upgrade?: string;
  requires: string[];
  notes: string[];
}

/**
 * Whether a function reference "<app>.<fn>" | "<app>.<role>.<fn>" names a program of an app this
 * install knows: the app being installed (its programs), or an app the view has installed.
 */
async function fnProblem(ref: string, self: AppRecord, view: InstanceView): Promise<string | undefined> {
  const parts = ref.split(".");
  const app = parts[0]!;
  const programs = app === self.name ? self.programs : (await appRecordIn(view, app))?.record.programs;
  if (!programs) return `${ref}: no app ${app} is installed`;
  if (parts.length === 3 ? !(parts[1]! in programs) : Object.keys(programs).length !== 1) return `${ref}: app ${app} has ${parts.length === 3 ? `no program ${parts[1]}` : "several programs: name <app>.<role>.<fn>"}`;
  return undefined;
}

/** The rows an app record asks for, as the kernel takes them (manifest.ts rowOf); each check must name an installed app's program. */
export async function wiring(record: AppRecord, view: InstanceView): Promise<RowOp[]> {
  const out: RowOp[] = [];
  const roles = Object.keys(record.programs);
  const declared = Object.keys(record.roles ?? {});
  for (const r of record.routes as RouteIn[]) {
    const row = rowOf(record.name, r, roles, declared);
    for (const c of [...(row.checks ?? []), ...(row.recheck ? [row.recheck] : [])]) {
      const why = await fnProblem(c, record, view);
      if (why) throw new Error(`row ${rowKey(row)}: ${why}`);
    }
    out.push({ op: "add", row });
  }
  return out;
}

const sameRow = (a: DispatchRow, b: DispatchRow): boolean => encode(a as never).cid.equals(encode(b as never).cid);

/** The program records of the tree's programs, the modules to send, and the role → record map. */
async function programsOf(t: AppTree, view: InstanceView, extra: Objects): Promise<{ programs: Record<string, CID>; records: Rec[] }> {
  const programs: Record<string, CID> = {};
  const records: Rec[] = [];
  for (const [role, src] of Object.entries(t.checked.sources)) {
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

/** Plan the install of `t` into the instance `view` reads: every check (APPS.md §3 step 0), then what to send. An image's install at birth (boot.ts) is the same plan. */
export async function planInstall(t: AppTree, view: InstanceView, o: { modules: Objects }): Promise<Plan> {
  const m = t.checked.manifest;
  const notes: string[] = [];
  const installed: Array<{ name: string; provides?: Provide[] }> = [];
  for (const h of view.heads) {
    if (!h.name.endsWith("/app") || h.name === appHead(m.name)) continue;
    const r = await view.store.get(h.root).catch(() => undefined) as AppRecord | undefined;
    if (r?.kind === "app") installed.push({ name: h.name.slice(0, -"/app".length), provides: r.provides });
  }
  const missing = missingInterfaces(m.requires, installed);
  if (missing.length) throw new Error(`requires ${missing.join(", ")}: no installed app provides ${missing.length > 1 ? "them" : "it"}`);
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
  for (const r of want) { const why = rowProblem(r.row); if (why) throw new Error(`row ${rowKey(r.row)}: ${why}`); }
  // No row may take a key a kernel row, root's own or another app's has.
  const taken = new Map<string, string>();
  for (const r of view.dispatch) { const owner = rowApp(r); if (owner !== m.name) taken.set(rowKey(r), owner ? `app ${owner}` : "the kernel or root's own"); }
  for (const r of want) {
    const who = taken.get(rowKey(r.row));
    if (who) throw new Error(`row ${rowKey(r.row)}: ${who} has it`);
  }
  // An earlier version: its rows this one does not ask for are removed.
  const rows = [...want];
  if (before) {
    const keep = new Set(want.map((r) => rowKey(r.row)));
    for (const r of view.dispatch) if (rowApp(r) === m.name && !keep.has(rowKey(r))) rows.push({ op: "remove", row: r });
  }
  // Only what changes: a row the instance has as asked is not sent again.
  const have = new Map(view.dispatch.map((r) => [rowKey(r), r]));
  const sendRows = rows.filter((r) => {
    const cur = have.get(rowKey(r.row));
    if (r.op === "remove") return !!cur;
    return !cur || !sameRow(cur, r.row);
  });
  // Records the store has are not sent again: blobs, then trees (the root last), modules and program records, the app record.
  const all: Rec[] = [];
  const seen = new Set<string>();
  const trees = t.records.filter((r) => textOf(r.bytes.subarray(0, 5)) === "tree ");
  const blobs = t.records.filter((r) => textOf(r.bytes.subarray(0, 5)) !== "tree ");
  const ordered = [...blobs, ...trees.filter((r) => !r.cid.equals(t.root)), ...t.records.filter((r) => r.cid.equals(t.root)), ...progRecords, { cid: app.cid, bytes: app.bytes }];
  for (const r of ordered) {
    const k = r.cid.toString();
    if (seen.has(k)) continue;
    seen.add(k);
    if (!(await view.store.has(r.cid))) all.push(r);
  }
  const heads: HeadOp[] = [{ name: appHead(m.name), tree: app.cid }];
  const asked = grantsOf(m.name, m);
  const askedKeys = new Set(asked.map(grantKey));
  const grants: GrantOp[] = [...asked, ...(before ? (await grantsHeld(view, m.name)).filter((g) => !askedKeys.has(grantKey(g))).map((g) => ({ ...g, op: "remove" as const })) : [])];
  return {
    app: m.name, version: m.version, record, recordCid: app.cid, records: all, heads,
    rows: sendRows, grants, ...(before ? { upgrade: before.record.version } : {}), requires: m.requires, notes,
  };
}

/** A row as one line of the prompt: `<kind> <path | name>[ prefix] (role) [checks] recheck → handler`. */
export const showRow = (r: RowOp) => `${r.op} ${r.row.kind} ${r.row.kind === "event" ? r.row.name : r.row.path}${r.row.prefix ? " prefix" : ""}${r.row.role ? ` (${r.row.role})` : ""}${r.row.checks?.length ? ` [${r.row.checks.join(", ")}]` : ""}${r.row.recheck ? ` recheck ${r.row.recheck}` : ""} → ${r.row.handler}`;

/** The permission prompt: what the app asks for (APPS.md §3) — its rows and roles read aloud. */
export function describe(p: Plan, record = p.record): string[] {
  const out: string[] = [];
  out.push(`${p.upgrade ? "upgrade" : "install"} ${p.app} ${p.version}${p.upgrade ? ` (installed: ${p.upgrade})` : ""}${record.description ? ` — ${record.description}` : ""}`);
  for (const h of p.heads) out.push(`  head      ${h.name} → the app record ${p.recordCid} (tree ${record.tree})`);
  for (const [role, what] of Object.entries(record.roles ?? {})) out.push(`  role      ${record.name}.${role}: ${what}`);
  if (p.requires.length) out.push(`  requires  ${p.requires.join(", ")}`);
  for (const pr of record.provides) out.push(`  provides  ${pr.interface}: ${Object.entries(pr.functions).map(([f, x]) => `${f}${x.writes ? "" : " (read)"}`).join(", ")}`);
  for (const g of p.grants) out.push(`  grant     ${showGrant(g)}`);
  for (const n of p.notes) out.push(`  note      ${n}`);
  out.push(`  requests  objects ×${Math.max(1, [...chunk(p.records)].length)} (${p.records.length} records) · head ×${p.heads.length} · route ×${p.rows.length}${p.grants.length ? ` · grant ×${p.grants.length}` : ""}`);
  for (const r of p.rows) out.push(`    route ${showRow(r)}`);
  return out;
}

/** One of root's requests an install hands the instance: the kernel operation row's path and the body (dag-cbor). */
export interface RootRequest { path: string; body: Uint8Array }

/** A plan as root's requests, in order: objects, the head, the rows (removes first), the grants. */
export function installRequests(p: Plan): RootRequest[] {
  const out: RootRequest[] = [];
  for (const b of chunk(p.records)) out.push({ path: KERNEL_PATHS.objects, body: b });
  for (const h of p.heads) out.push({ path: KERNEL_PATHS.head, body: dagCbor.encode({ name: h.name, tree: h.tree }) });
  for (const r of [...p.rows].sort((a, b) => (a.op === b.op ? 0 : a.op === "remove" ? -1 : 1))) out.push({ path: KERNEL_PATHS.route, body: dagCbor.encode({ op: r.op, row: r.row }) });
  for (const g of p.grants) out.push({ path: KERNEL_PATHS.grant, body: dagCbor.encode(g) });
  return out;
}

/** Send a plan as root: `send(path, body)` is root's request to the instance. */
export async function sendInstall(p: Plan, send: (path: string, body: Uint8Array) => Promise<unknown>): Promise<{ requests: number }> {
  const rs = installRequests(p);
  for (const r of rs) await send(r.path, r.body);
  return { requests: rs.length };
}

// ---------------------------------------------------------------- uninstall

export interface UninstallPlan { app: string; record: AppRecord; rows: RowOp[]; grants: GrantOp[] }

/** What uninstalling `name` sends: every row the table holds whose handler is the app's, removed; its grants taken back. The app's heads are left. */
export async function planUninstall(name: string, view: InstanceView): Promise<UninstallPlan> {
  const a = await appRecordIn(view, name);
  if (!a) throw new Error(`${name}: no app installed under that head`);
  return {
    app: name, record: a.record,
    rows: view.dispatch.filter((r) => rowApp(r) === name).map((r) => ({ op: "remove" as const, row: r })),
    grants: (await grantsHeld(view, name)).map((g) => ({ ...g, op: "remove" as const })),
  };
}

export function uninstallRequests(p: UninstallPlan): RootRequest[] {
  return [
    ...p.rows.map((r) => ({ path: KERNEL_PATHS.route, body: dagCbor.encode({ op: r.op, row: r.row }) })),
    ...p.grants.map((g) => ({ path: KERNEL_PATHS.grant, body: dagCbor.encode(g) })),
  ];
}

// ---------------------------------------------------------------- root's own rows

/**
 * Root's own row (`skein routes`; an image's etc/apps.json `routes`): one `route` add or remove of a
 * row as the kernel takes it (an absolute path; a handler of an installed app's). Refused at a key
 * an app's row has; each check and the handler must name an installed app's program.
 */
export async function planRootRoute(view: InstanceView, op: "add" | "remove", row: DispatchRow): Promise<{ prompt: string[]; rows: RowOp[] }> {
  const why = rowProblem(row);
  if (why) throw new Error(`row ${rowKey(row)}: ${why}`);
  const k = rowKey(row);
  const held = view.dispatch.find((r) => rowKey(r) === k);
  if (op === "add") {
    for (const f of [...(row.checks ?? []), ...(row.recheck ? [row.recheck] : []), ...(row.handler.startsWith("kernel.") ? [] : [row.handler])]) {
      const app = f.split(".")[0]!;
      const rec = await appRecordIn(view, app);
      if (!rec) throw new Error(`row ${k}: ${f}: no app ${app} is installed`);
      const parts = f.split(".");
      if (parts.length === 3 ? !(parts[1]! in rec.record.programs) : Object.keys(rec.record.programs).length !== 1) throw new Error(`row ${k}: ${f}: app ${app} has no such program`);
    }
  } else if (!held) throw new Error(`row ${k}: no row there`);
  const r: RowOp = { op, row: op === "remove" ? held! : row };
  return { prompt: [`route ${showRow(r)} (root's own)`], rows: [r] };
}

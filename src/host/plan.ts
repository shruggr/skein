// The install's plan (#72, #77, #91; docs/APPS.md §3): what installing or
// uninstalling an app sends, as the owner, to the kernel's admin boxes, read
// from a view of the instance — its heads, dispatch table, address book,
// genesis programs, and its store by CID. No node APIs: the node client
// (install.ts and src/client/admin.ts: `skein plan install`, #124, a store file's or the explorer's view) and the management
// site (shruggr/skein-site, #92: a view over the instance's explorer reads, in
// a browser) plan with the same code. install.ts's header has the steps.

import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { chunk, type Rec } from "../client/bundle.ts";
import { encode, parse as parseCid } from "../runtime/cid.ts";
import { rowKey as kernelRowKey, senderText, type DispatchRow } from "../runtime/dispatch.ts";
import { programRecord, RAW, rawCid, wasmKind } from "../runtime/programs.ts";
import { readBlob, readTree } from "../runtime/tree.ts";
import type { Store } from "../runtime/store.ts";
// Types only (erased): boot.ts and deploy.ts are node code.
import type { Objects } from "./boot.ts";
import type { AddressEntry } from "./deploy.ts";
import { appPath, checkManifest, missingInterfaces, pathKey, rowAddress, rowKey, type Checked, type Derived, type Provide, type ReadIn, type Row, type ShellSource } from "./manifest.ts";

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
  /** The genesis owner and the instance's identity (hex), and programs (name → program record). */
  owner: string;
  identity: string;
  programs: Record<string, CID>;
  addressBook: AddressEntry[];
  /** Every head and its root (the store's index). */
  heads: Array<{ name: string; root: CID }>;
  /** The dispatch table now (#77): a row with `app` was installed by that app; without, it is the genesis's. */
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

// ---------------------------------------------------------------- the reads (#135: the second door)

/**
 * The head the instance's reads are under (#135): its root a record {kind: "reads", reads:
 * [<read>]}, each read {address: <the path as served>, prefix?: true, program: <program record
 * CID>, fn, app?: <the app that asked for it; absent: the owner's own>, …settings}. Written by the
 * owner (the kernel's `objects` and `head` operations, as an install writes `<app>/app`): an install
 * puts its app's reads in (an upgrade replaces them, an uninstall takes them out); `skein plan reads`
 * adds or removes the owner's own (the site at `/`). The host reads it to serve reads by `call`
 * (frontdoor.ts serveHttp). State, so replay-derived as the dispatch table is.
 */
export const READS_HEAD = "reads";

/** One read as the reads head holds it (resolved: the path as served, the program a CID). */
export interface ReadEntry { address: string; prefix?: true; program: CID; fn: string; app?: string; [setting: string]: unknown }
export interface ReadsRecord { kind: "reads"; reads: ReadEntry[] }

/** A read's key: its path as served, `*` for a prefix (an http row with the same address and prefix shares it). */
export const readEntryKey = (r: { address: string; prefix?: boolean }): string => pathKey(r.address, r.prefix);

/** The reads the view's head `reads` holds ([] when none). */
export async function readsIn(view: Pick<InstanceView, "store" | "heads">): Promise<ReadEntry[]> {
  const root = view.heads.find((h) => h.name === READS_HEAD)?.root;
  if (!root) return [];
  const r = await view.store.get(root).catch(() => undefined) as Partial<ReadsRecord> | undefined;
  return r?.kind === "reads" && Array.isArray(r.reads) ? r.reads : [];
}

/** The reads an app record asks for, resolved (the path as served under /<app>/, the role's program record, `app`). */
export function readsOf(record: AppRecord): ReadEntry[] {
  return (record.reads ?? []).map((r: ReadIn) => {
    const { address, prefix, program, fn, ...settings } = r;
    const cid = record.programs[program];
    if (!cid) throw new Error(`read ${appPath(record.name, address)}: no program for role ${program}`);
    return { ...settings, address: appPath(record.name, address), ...(prefix ? { prefix: true as const } : {}), program: cid, fn, app: record.name };
  });
}

/** The reads record for `reads`, encoded. */
export function readsRecord(reads: ReadEntry[]): { cid: CID; bytes: Uint8Array } {
  const b = encode({ kind: "reads", reads } as never);
  return { cid: b.cid, bytes: b.bytes };
}

/**
 * Why `reads` cannot stand beside the dispatch table `rows` (#135: a read and an http row never share a
 * path) and the other reads `others`: the first clash, as a line, or undefined.
 */
export function readClash(reads: ReadEntry[], rows: DispatchRow[], others: ReadEntry[]): string | undefined {
  for (const r of reads) {
    const k = readEntryKey(r);
    const o = others.find((x) => readEntryKey(x) === k);
    if (o) return `read ${k}: ${o.app ? `app ${o.app}` : "the owner"} has it`;
    const row = rows.find((x) => x.transport === "http" && pathKey(x.address, x.prefix) === k);
    if (row) return `read ${k}: an http row is at that path (${(row as { app?: string }).app ? `app ${String((row as { app?: string }).app)}` : "the genesis or the owner"}'s): a path is a read or a message route, not both`;
  }
  return undefined;
}

/** A read as one line of the prompt: `<address>[*] → <role or program>.<fn>[ (<settings>)]`. */
const showRead = (r: { address: string; prefix?: boolean; fn: string; program: unknown }, role?: string) => `${r.address}${r.prefix ? "*" : ""} → ${role ?? String(r.program)}.${r.fn}${showSettings(r)}`;

/** The app record (a head's root): the manifest as installed. */
export type AppRecord = Omit<Checked["manifest"], "programs"> & { programs: Record<string, CID>; tree: CID; state?: CID };

// ---------------------------------------------------------------- the plan

/** A dispatch change the install sends: the row as the kernel takes it (sender resolved, program a CID, address as served, `app`), and how to show it. */
export interface RowOp { op: "add" | "remove"; row: DispatchRow & { app: string }; label: string; role?: string }
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
  /** #135: the app's reads as the reads head will hold them. */
  reads: ReadEntry[];
  notes: string[];
}

/** The address book's entry for the host service `name` (`local`, <name>), if any. */
const serviceOf = (view: InstanceView, name: string) => view.addressBook.find((x) => x.transport === "local" && x.address === name);

/** A sender as the manifest writes it → what the kernel's row carries, and how to show it. */
function senderOf(s: string, view: InstanceView): { sender: DispatchRow["sender"]; label: string } {
  if (s === "*") return { sender: "*", label: "anyone" };
  if (s === "session") return { sender: "session", label: "a session" };
  if (s === "event") return { sender: "event", label: "events" };
  if (s === "$owner") {
    if (!view.owner) throw new Error("sender $owner: the instance has no owner yet (an image not claimed, #89, #127: the owner's own claim, skein plan claim)");
    return { sender: keyBytes(view.owner), label: `the owner (${view.owner.slice(0, 10)}…)` };
  }
  if (s === "$self") return { sender: keyBytes(view.identity), label: `the instance itself (${view.identity.slice(0, 10)}…)` };
  if (s.startsWith("$")) {
    // Tooling (#126): `$<name>` names the key the instance's address book reaches on its host at `local` <name> (a host service: `$cron`, `$status`).
    const e = serviceOf(view, s.slice(1));
    if (!e) throw new Error(`sender ${s}: the instance's address book has no ${s.slice(1)} service on its host (an entry \`local\` ${s.slice(1)})`);
    return { sender: keyBytes(e.key), label: `${s} (${e.key.slice(0, 10)}…)` };
  }
  return { sender: keyBytes(s), label: `${s.slice(0, 10)}…` };
}

/**
 * The rows an app record asks for, resolved against the instance (as the kernel takes them). A row
 * marked `optional: true` whose sender is a `$<provider>` the instance's address book lacks is left
 * out (#78: the chain app's `status` row on a host with no status provider), as a genesis leaves out
 * a row from a provider its host has not; `skipped` says which. `optional` never reaches the kernel.
 */
export function wiring(record: AppRecord, view: InstanceView, skipped: string[] = []): RowOp[] {
  const out: RowOp[] = [];
  for (const r of record.dispatch as Row[]) {
    const { transport, address, prefix, sender, program, fn, optional, ...settings } = r;
    const cid = record.programs[program];
    if (!cid) throw new Error(`row ${rowKey(record.name, r)}: no program for role ${program}`);
    if (optional === true && sender.startsWith("$") && sender !== "$owner" && sender !== "$self" && !serviceOf(view, sender.slice(1))) {
      skipped.push(`${transport} ${rowAddress(record.name, r)} from ${sender}: no ${sender.slice(1)} provider in the address book (optional; left out)`);
      continue;
    }
    const who = senderOf(sender, view);
    const row: DispatchRow & { app: string } = { ...settings, transport, address: rowAddress(record.name, r), ...(prefix ? { prefix: true } : {}), sender: who.sender, program: cid, ...(fn ? { fn } : {}), app: record.name };
    out.push({ op: "add", row, label: who.label, role: program });
  }
  return out;
}

/** A row's key as the kernel's table knows it (the resolved row). */
const keyOf = (r: DispatchRow) => kernelRowKey(r);
/** The fields of a row that are not its settings (its key, its program, `fn`; `optional` and `app` the install's). */
const ROW_CORE = new Set(["transport", "address", "prefix", "sender", "program", "fn", "optional", "app"]);
/** A row's settings as the prompt shows them (` (filter beef, read …)`), or "": every field the row carries to the kernel beyond its key, program and fn. */
const showSettings = (r: object): string => {
  const s = Object.entries(r).filter(([k, v]) => !ROW_CORE.has(k) && v !== undefined).map(([k, v]) => `${k} ${typeof v === "string" ? v : JSON.stringify(v)}`);
  return s.length ? ` (${s.join(", ")})` : "";
};
/** A row as one line of the prompt: `<transport> <address>[*] from <who> → <role>[.<fn>][ (<settings>)]`. */
const showRow = (r: RowOp) => `${r.row.transport} ${r.row.address}${r.row.prefix ? "*" : ""} from ${r.label} → ${r.role ?? String(r.row.program)}${r.row.fn ? `.${r.row.fn}` : ""}${showSettings(r.row)}`;

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

/** Plan the install of `t` into the instance `view` reads: every check (APPS.md §3 step 0), then what to send. */
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

  const skipped: string[] = [];
  const want = wiring(record, view, skipped);
  for (const s of skipped) notes.push(`row ${s}`);
  // No row may take a key the genesis or another app has.
  const taken = new Map<string, string>();
  for (const r of view.dispatch) if ((r as { app?: string }).app !== m.name) taken.set(keyOf(r), (r as { app?: string }).app ? `app ${String((r as { app?: string }).app)}` : "the genesis");
  for (const r of want) {
    const who = taken.get(keyOf(r.row));
    if (who) throw new Error(`row ${keyOf(r.row)}: ${who} has it`);
  }
  // An earlier version: what it had and this one has not is removed.
  const rows = [...want];
  if (before) {
    const keep = new Set(want.map((r) => keyOf(r.row)));
    for (const r of view.dispatch) if ((r as { app?: string }).app === m.name && !keep.has(keyOf(r))) rows.push({ op: "remove", row: r as DispatchRow & { app: string }, label: senderText(r.sender) });
  }
  // #135: the app's reads, in the reads head beside the others' — never at an http row's path.
  const reads = readsOf(record);
  const current = await readsIn(view);
  const others = current.filter((r) => r.app !== m.name);
  const tableAfter = [...view.dispatch.filter((r) => (r as { app?: string }).app !== m.name), ...want.map((r) => r.row)];
  const clash = readClash(reads, tableAfter, others);
  if (clash) throw new Error(clash);
  for (const r of want) {
    const o = r.row.transport === "http" ? others.find((x) => readEntryKey(x) === pathKey(r.row.address, r.row.prefix)) : undefined;
    if (o) throw new Error(`row http ${pathKey(r.row.address, r.row.prefix)}: ${o.app ? `app ${o.app}` : "the owner"} has a read at that path: a path is a read or a message route, not both`);
  }
  const nextReads = [...others, ...reads];
  const readsRec = readsRecord(nextReads);
  const readsRoot = view.heads.find((h) => h.name === READS_HEAD)?.root;
  const readsMove = readsRoot ? !readsRoot.equals(readsRec.cid) : reads.length > 0;
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
  const ordered = [...blobs, ...trees.filter((r) => !r.cid.equals(t.root)), ...t.records.filter((r) => r.cid.equals(t.root)), ...progRecords, { cid: app.cid, bytes: app.bytes }, ...(readsMove ? [readsRec] : [])];
  for (const r of ordered) {
    const k = r.cid.toString();
    if (seen.has(k)) continue;
    seen.add(k);
    if (!(await view.store.has(r.cid))) all.push(r);
  }
  const heads: HeadOp[] = [{ name: appHead(m.name), tree: app.cid }, ...(readsMove ? [{ name: READS_HEAD, tree: readsRec.cid }] : [])];
  const publishes = gossipOf(m.config);
  return {
    app: m.name, version: m.version, record, recordCid: app.cid, records: all, heads,
    rows: sendRows, ...(m.start ? { start: m.start.body } : {}),
    ...(before ? { upgrade: before.record.version } : {}), requires: m.requires, publishes, derived: t.checked.derived, reads, notes,
  };
}

const sameRow = (a: DispatchRow, b: DispatchRow): boolean => encode(a as never).cid.equals(encode(b as never).cid);

/** What an overlay app publishes (APPS.md §6), for information: `<topic>`, `-admit`, `-proof` per topic not turned off. */
function gossipOf(config: Record<string, unknown> | undefined): string[] {
  const ov = config?.overlay as { topics?: Record<string, unknown>; gossip?: Record<string, boolean> } | undefined;
  if (!ov?.topics) return [];
  return Object.keys(ov.topics).filter((t) => ov.gossip?.[t] !== false).flatMap((t) => [t, `${t}-admit`, `${t}-proof`]);
}

/** The permission prompt: what the app asks for (APPS.md §3) — its rows read aloud. */
export function describe(p: Plan, record = p.record): string[] {
  const out: string[] = [];
  out.push(`${p.upgrade ? "upgrade" : "install"} ${p.app} ${p.version}${p.upgrade ? ` (installed: ${p.upgrade})` : ""}${record.description ? ` — ${record.description}` : ""}`);
  const d = p.derived ?? { rows: [] };
  const from = (yes: boolean) => (yes ? " (derived: config.overlay)" : "");
  for (const h of p.heads) out.push(h.name === READS_HEAD ? `  head      ${h.name} → the instance's reads with this app's (${h.tree})` : `  head      ${h.name} → the app record ${p.recordCid} (tree ${record.tree})`);
  const keyed = (r: Row) => rowKey(record.name, r);
  for (const r of record.dispatch) {
    const who = r.sender === "*" ? "anyone" : r.sender;
    out.push(`  row       ${r.transport} ${rowAddress(record.name, r)}${r.prefix ? "*" : ""} from ${who} → ${r.program}${r.fn ? `.${r.fn}` : ""}${showSettings(r)}${from(d.rows.includes(keyed(r)))}`);
  }
  for (const r of record.reads ?? []) out.push(`  read      ${showRead({ ...r, address: appPath(record.name, r.address) }, r.program)} (anyone, by a call: nothing logged)${from(!!d.reads?.includes(`${appPath(record.name, r.address)}${r.prefix ? "*" : ""}`))}`);
  if (record.start) out.push(`  start     ${JSON.stringify(record.start.body)} into ${p.app}`);
  if (record.stop) out.push(`  stop      ${JSON.stringify(record.stop.body)} (at uninstall)`);
  if (p.requires.length) out.push(`  requires  ${p.requires.join(", ")}`);
  for (const pr of record.provides) out.push(`  provides  ${pr.interface}: ${Object.entries(pr.functions).map(([f, d]) => `${f}${d.writes ? "" : " (read)"}`).join(", ")}`);
  if (p.publishes.length) out.push(`  publishes ${p.publishes.join(", ")} (for information: emitting needs no grant)`);
  for (const n of p.notes) out.push(`  note      ${n}`);
  out.push(`  messages  objects ×${Math.max(1, [...chunk(p.records)].length)} (${p.records.length} records) · head ×${p.heads.length} · dispatch ×${p.rows.length}${p.start ? " · start" : ""}`);
  for (const r of p.rows) out.push(`    dispatch ${r.op} ${showRow(r)}`);
  return out;
}

/** Send a plan as the owner: `send(box, body)` is the owner's message to the instance. */
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

const keyBytes = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
/** The kernel's `dispatch` operation's body: an add carries the whole row; a remove its key fields suffice (the row is sent as held). */
const rowBody = (r: RowOp) => ({ op: r.op, row: r.row });

// ---------------------------------------------------------------- uninstall

export interface UninstallPlan { app: string; record: AppRecord; stop?: Record<string, unknown>; rows: RowOp[]; /** #135: the reads head without the app's, when it had any. */ reads?: { cid: CID; bytes: Uint8Array; removed: ReadEntry[] } }

/** What uninstalling `name` sends: `stop`, then its rows removed (every row the table holds with `app: name`), then its reads (#135). The app's heads are left. */
export async function planUninstall(name: string, view: InstanceView): Promise<UninstallPlan> {
  const a = await appRecordIn(view, name);
  if (!a) throw new Error(`${name}: no app installed under that head`);
  const current = await readsIn(view);
  const removed = current.filter((r) => r.app === name);
  return {
    app: name, record: a.record, ...(a.record.stop ? { stop: a.record.stop.body } : {}),
    rows: view.dispatch.filter((r) => (r as { app?: string }).app === name).map((r) => ({ op: "remove" as const, row: r as DispatchRow & { app: string }, label: senderText(r.sender) })),
    ...(removed.length ? { reads: { ...readsRecord(current.filter((r) => r.app !== name)), removed } } : {}),
  };
}

export async function sendUninstall(p: UninstallPlan, send: (box: string, body: Uint8Array) => Promise<unknown>): Promise<{ messages: number }> {
  let n = 0;
  const go = async (box: string, body: Uint8Array) => { await send(box, body); n++; };
  if (p.stop) await go(p.app, dagCbor.encode(p.stop));
  for (const r of p.rows) await go("dispatch", dagCbor.encode(rowBody(r)));
  if (p.reads) {
    for (const b of chunk([{ cid: p.reads.cid, bytes: p.reads.bytes }])) await go("objects", b);
    await go("head", dagCbor.encode({ name: READS_HEAD, tree: p.reads.cid }));
  }
  return { messages: n };
}

// ---------------------------------------------------------------- the owner's own reads (#135)

/**
 * The owner's own read (#135; `skein plan reads`): added to (or removed from) the reads head —
 * `objects` (the new reads record) and `head reads`. No `app`: an app's upgrade or uninstall leaves
 * it. The site at the instance's root is one: {address: "/", prefix: true, program: <the site's
 * program>, fn: "get", root: "www"}. Refused at an http row's path or another read's.
 */
export async function planOwnerRead(view: InstanceView, op: "add" | "remove", read: ReadEntry): Promise<{ prompt: string[]; records: Rec[]; head: HeadOp }> {
  const current = await readsIn(view);
  const k = readEntryKey(read);
  const mine = (r: ReadEntry) => !r.app && readEntryKey(r) === k;
  let next: ReadEntry[];
  if (op === "add") {
    const clash = readClash([read], view.dispatch, current.filter((r) => !mine(r)));
    if (clash) throw new Error(clash);
    const { app: _app, ...own } = read;
    void _app;
    next = [...current.filter((r) => !mine(r)), own as ReadEntry];
  } else {
    if (!current.some(mine)) throw new Error(`read ${k}: the owner has no read there`);
    next = current.filter((r) => !mine(r));
  }
  const rec = readsRecord(next);
  return { prompt: [`reads ${op} ${showRead(read)} (the owner's: anyone, by a call — nothing logged)`, `  messages  objects ×1 · head ${READS_HEAD}`], records: [rec], head: { name: READS_HEAD, tree: rec.cid } };
}

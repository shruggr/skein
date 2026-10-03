// Installing an app (#72, #76, #77, #79; docs/APPS.md §3): the owner's client. An
// app is a tree (a directory or a git repository) with etc/app.json;
// installing it into an instance is owner-signed messages to the kernel's
// admin boxes — the kernel's own operations on its four tables — nothing else:
//
//   1. objects    the tree's git objects, the modules its bin/*.wasm carry (a
//                 shell program's modules and support files too, #83), a program
//                 record per program, and the **app record** (below)
//                 — ≤ 1 MiB bundles; no bundle names a root (an app never
//                 becomes `main`)
//   2. head       {name: "<app>/app", tree: <the app record>}: the app's root head, under its
//                 own name (owner = the app).
//   3. dispatch   one per row the manifest asks for (#77): {op: "add", row: {transport, address,
//                 prefix?, sender, program: <the role's program record>, fn?, …settings, app}} —
//                 the sender "*" (anyone), "event" (events only), "session", "$owner" → the
//                 owner's key, "$self" → the instance's own (#79: its other apps), "$<provider>"
//                 → the key the instance's address book gives that role, a hex key itself; an
//                 http address under /<app>/, a libp2p topic or protocol as written.
//   4. start      the manifest's `start.body`, into the app's box
//
// The **app record** is the head's root: the manifest as installed, so "what
// does this head provide" is one read (`head("<app>/app")`, `get`):
//
//   {kind: "app", name, version, programs: {<role>: <program record CID>},
//    config?, provides, requires, dispatch: [<row as the manifest wrote it: relative addresses, roles>],
//    start?, stop?, description?, tree: <the app's git tree>, state?: <the app's own state>}
//
// `state` is the app's: its handler advances the head to the record with
// `state` replaced (the SDK's app.Call.setState). An install over an earlier
// version carries `state` over, removes the rows the earlier record had and
// the new one does not, and sends `start` again (the restart). Uninstall:
// `stop`, then every row removed; the heads are left.
//
// **Write scope** (#77, #79): an app's programs write only heads under
// `<app>/` (the kernel's rule, by the program record's `app`). There are no
// grants, no alias head, no form before #77.

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
import { currentDispatch, rowKey as kernelRowKey, senderBytes, senderText, type DispatchRow } from "../runtime/dispatch.ts";
import { headTree } from "../runtime/heads.ts";
import type { IndexStore } from "../runtime/index-store.ts";
import type { Store } from "../runtime/store.ts";
import { programRecord, RAW, rawCid, wasmKind, type Objects } from "./boot.ts";
import { addressBook, type AddressEntry } from "./deploy.ts";
import { checkManifest, missingInterfaces, rowAddress, rowKey, type Checked, type Derived, type Provide, type Row, type ShellSource } from "./manifest.ts";

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

export async function instanceView(store: Store): Promise<InstanceView> {
  let g: Record<string, unknown> | undefined;
  for await (const { entry } of store.log.entries(0)) {
    const c = (entry as { genesis?: CID }).genesis;
    if (c) g = await store.get(c) as Record<string, unknown>;
    break;
  }
  if (!g) throw new Error("the instance's store has no genesis yet");
  const heads = typeof (store as Partial<IndexStore>).heads === "function" ? (store as IndexStore).heads() : [];
  return {
    store,
    owner: await ownerOf(store, g),
    identity: g.identity instanceof Uint8Array ? Buffer.from(g.identity).toString("hex") : String(g.identity),
    programs: (g.programs ?? {}) as Record<string, CID>,
    addressBook: await addressBook(store),
    heads,
    // The reader shows a 33-byte sender as hex; the kernel's rows carry bytes (a remove sends the row back).
    dispatch: ((await currentDispatch(store)) ?? []).map((r) => ({ ...r, sender: senderBytes(r.sender) })),
  };
}

/**
 * The instance's owner (hex): its genesis's, else — an image (#89) — the key
 * its claim named (the head `claim` → the claim's body), else "" (an image
 * not claimed yet: nobody may install into it).
 */
export async function ownerOf(store: Store, genesis: Record<string, unknown>): Promise<string> {
  const hex = (k: unknown) => k instanceof Uint8Array ? Buffer.from(k).toString("hex") : typeof k === "string" ? k : "";
  if (genesis.owner !== undefined) return hex(genesis.owner);
  const root = await headTree(store, "claim");
  if (!root) return "";
  const b = await store.get(root).catch(() => undefined) as { owner?: unknown } | undefined;
  return hex(b?.owner);
}

/** The app's root head (#77): `<name>/app`. */
export const appHead = (name: string) => `${name}/app`;

/** The app record a head's root is, if it is one. */
export async function appRecordOf(store: Store, name: string): Promise<{ cid: CID; record: AppRecord } | undefined> {
  const root = await headTree(store, appHead(name));
  if (!root) return undefined;
  const r = await store.get(root).catch(() => undefined) as AppRecord | undefined;
  return r && r.kind === "app" ? { cid: root, record: r } : undefined;
}

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
  notes: string[];
}

/** A sender as the manifest writes it → what the kernel's row carries, and how to show it. */
function senderOf(s: string, view: InstanceView): { sender: DispatchRow["sender"]; label: string } {
  if (s === "*") return { sender: "*", label: "anyone" };
  if (s === "session") return { sender: "session", label: "a session" };
  if (s === "event") return { sender: "event", label: "events" };
  if (s === "$owner") {
    if (!view.owner) throw new Error("sender $owner: the instance has no owner yet (an image not claimed, #89: skein-host claim)");
    return { sender: keyBytes(view.owner), label: `the owner (${view.owner.slice(0, 10)}…)` };
  }
  if (s === "$self") return { sender: keyBytes(view.identity), label: `the instance itself (${view.identity.slice(0, 10)}…)` };
  if (s.startsWith("$")) {
    const e = view.addressBook.find((x) => x.role === s.slice(1));
    if (!e) throw new Error(`sender ${s}: the instance's address book has no ${s.slice(1)} provider (an entry with role "${s.slice(1)}")`);
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
    if (optional === true && sender.startsWith("$") && sender !== "$owner" && sender !== "$self" && !view.addressBook.some((x) => x.role === sender.slice(1))) {
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
/** A row as one line of the prompt: `<transport> <address>[*] from <who> → <role>[.<fn>]`. */
const showRow = (r: RowOp) => `${r.row.transport} ${r.row.address}${r.row.prefix ? "*" : ""} from ${r.label} → ${r.role ?? String(r.row.program)}${r.row.fn ? `.${r.row.fn}` : ""}`;

/** The program records of the tree's programs, the modules to send, and the role → record map. */
async function programsOf(t: AppTree, view: InstanceView, extra: Objects): Promise<{ programs: Record<string, CID>; records: Rec[] }> {
  const programs: Record<string, CID> = {};
  const records: Rec[] = [];
  for (const [role, src] of Object.entries(t.checked.sources)) {
    if (src.kind === "shell") {
      const { record, blocks } = shellProgram(t.dir, role, src, t.checked.manifest.name);
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
export function shellProgram(dir: string, role: string, src: ShellSource, app: string): { record: Record<string, unknown>; blocks: Rec[] } {
  const blocks = new Map<string, Rec>();
  const raw = (path: string, module: boolean): CID => {
    const bytes = new Uint8Array(readFileSync(join(dir, path)));
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
  const before = await appRecordOf(view.store, m.name);
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

/** The permission prompt: what the app asks for (APPS.md §3) — its rows read aloud. */
export function describe(p: Plan, record = p.record): string[] {
  const out: string[] = [];
  out.push(`${p.upgrade ? "upgrade" : "install"} ${p.app} ${p.version}${p.upgrade ? ` (installed: ${p.upgrade})` : ""}${record.description ? ` — ${record.description}` : ""}`);
  const d = p.derived ?? { rows: [] };
  const from = (yes: boolean) => (yes ? " (derived: config.overlay)" : "");
  for (const h of p.heads) out.push(`  head      ${h.name} → the app record ${p.recordCid} (tree ${record.tree})`);
  const keyed = (r: Row) => rowKey(record.name, r);
  for (const r of record.dispatch) {
    const who = r.sender === "*" ? "anyone" : r.sender;
    out.push(`  row       ${r.transport} ${rowAddress(record.name, r)}${r.prefix ? "*" : ""} from ${who} → ${r.program}${r.fn ? `.${r.fn}` : ""}${r.read ? ` (read ${String(r.read)})` : ""}${from(d.rows.includes(keyed(r)))}`);
  }
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

const keyBytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
/** The kernel's `dispatch` operation's body: an add carries the whole row; a remove its key fields suffice (the row is sent as held). */
const rowBody = (r: RowOp) => ({ op: r.op, row: r.row });

// ---------------------------------------------------------------- uninstall

export interface UninstallPlan { app: string; record: AppRecord; stop?: Record<string, unknown>; rows: RowOp[] }

/** What uninstalling `name` sends: `stop`, then its rows removed (every row the table holds with `app: name`). The heads are left. */
export async function planUninstall(name: string, view: InstanceView): Promise<UninstallPlan> {
  const a = await appRecordOf(view.store, name);
  if (!a) throw new Error(`${name}: no app installed under that head`);
  return {
    app: name, record: a.record, ...(a.record.stop ? { stop: a.record.stop.body } : {}),
    rows: view.dispatch.filter((r) => (r as { app?: string }).app === name).map((r) => ({ op: "remove" as const, row: r as DispatchRow & { app: string }, label: senderText(r.sender) })),
  };
}

export async function sendUninstall(p: UninstallPlan, send: (box: string, body: Uint8Array) => Promise<unknown>): Promise<{ messages: number }> {
  let n = 0;
  const go = async (box: string, body: Uint8Array) => { await send(box, body); n++; };
  if (p.stop) await go(p.app, dagCbor.encode(p.stop));
  for (const r of p.rows) await go("dispatch", dagCbor.encode(rowBody(r)));
  return { messages: n };
}

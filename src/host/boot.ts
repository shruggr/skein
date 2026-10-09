// The bootstrap loader (issue #4): one loader, two sources, no genesis by code
// alone. An instance boots from a **system tree** (docs/BOOTSTRAP.md):
//
//   bin/<name>.wasm   a handler program's module (WASI), or
//   bin/<name>.cid    the CID (raw, bafkrei…) of a module the source or the kernel holds
//   bin/<name>.json   optional: the program record's {inputs, services, description}
//   etc/config.json   optional: {defaults, peers, names, collect, feeds, roles} (keys hex, $self, $infer or a provider's $<name>; feeds: feeds.ts)
//   etc/dispatch.json [{transport?, address, prefix?, filters?, program?, fn?, …}] (#77, #143: the routes; genesis.ts DispatchSpec)
//   etc/apps.json     optional (#141): {install: [<app tree>], routes?: [<root's own route>]}
//   … anything else: the instance's files (SOUL.md, skills/ …)
//   (etc/subscriptions.json, etc/routes.json, etc/reads.json — the forms before #77 and #115 — are refused, #143)
//
// The loader **pre-fills the store** with the tree's objects (git-raw blobs
// and trees, each hash-checked by the kernel's `putblock`; modules as raw
// blocks), puts a program record per bin/ module, and writes the genesis from
// the tree's config and routes, naming the tree — the kernel sets
// `main` to it when it processes the genesis. That is the state an authorised
// `objects` + `head` pair would have produced, written directly, and a
// function of the log (a replay copies the tree and gets the same state).
//
// The sources only differ in where the objects come from (`Objects`): a
// directory scanned into memory (A), a store file (`--boot <cid> --from`),
// or a verified chain packet (B, packet.ts). An instance with no tree takes
// the stock system in code (genesis.ts codeSystem) through the same writer; a
// packet with a checkpoint (#30's state record) is restored instead: its
// blocks put, the state pointer moved, nothing rebuilt. The router's
// hydration of an empty store and `skein-host add --boot/--packet` both call
// `boot` here.

import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CID } from "multiformats/cid";
import { encode, parse as parseCid } from "../runtime/cid.ts";
import { programRecord, RAW, rawCid, wasmKind } from "../runtime/programs.ts";
import type { Stamp } from "../runtime/syscalls.ts";
import { GIT_RAW, hashBlob, hashTree, parseTree, type Entry, type TreeBlocks } from "../runtime/tree.ts";
import { scan, type ScanOptions } from "../dev/scan.ts";
import { now as clockNow } from "./clock.ts";
import * as dagCbor from "@ipld/dag-cbor";
import type { DispatchRow } from "../runtime/dispatch.ts";
import { appRecordIn, mergeConfig, planInstall, planRootRoute, readStoredApp, type InstanceView, type ViewStore } from "./plan.ts";
import { CLAIM_ROW, codeSystem, HANDSHAKE_ROW, rowsOf, resolveSystem, STOCK_HTTP, writeSystemGenesis, type ConfigSpec, type DispatchSpec, type Genesis2Config, type System } from "./genesis.ts";
import type { Kernel } from "./kernel.ts";

export const DAG_CBOR = 0x71;
// The module and program-record helpers live in ../runtime/programs.ts (no node APIs: the plan uses them in a browser too, #92).
export { programRecord, RAW, rawCid, wasmKind };

export const BIN = "bin";
export const CONFIG = "etc/config.json";
export const DISPATCH = "etc/dispatch.json";
/** The forms before #77 and #115, refused (#143: they spoke of senders). */
export const GONE = ["etc/subscriptions.json", "etc/routes.json", "etc/reads.json"];
/** #141: the apps an image installs at birth, and root's own routes (ImageApps). */
export const APPS = "etc/apps.json";

/** Blocks by CID, from wherever a source keeps them. */
export interface Objects {
  get(cid: CID): Promise<Uint8Array | undefined>;
}

/** Blocks in memory: what a scanned directory or a verified packet becomes. */
export class MemBlocks implements Objects, TreeBlocks {
  readonly map = new Map<string, { cid: CID; bytes: Uint8Array }>();
  async get(cid: CID) { return this.map.get(cid.toString())?.bytes; }
  async bytes(cid: CID) { const b = this.map.get(cid.toString()); if (!b) throw new Error(`not found: ${cid}`); return b.bytes; }
  async has(cid: CID) { return this.map.has(cid.toString()); }
  async putBlock(cid: CID, bytes: Uint8Array) { this.map.set(cid.toString(), { cid, bytes }); }
}

/** A git object's body if it is a `<type>` object. */
export function gitBody(object: Uint8Array, type: "blob" | "tree"): Uint8Array | undefined {
  const nul = object.indexOf(0);
  if (nul < 0) return undefined;
  const head = Buffer.from(object.subarray(0, nul)).toString("latin1");
  return head === `${type} ${object.length - nul - 1}` ? object.subarray(nul + 1) : undefined;
}

// ---------------------------------------------------------------- sources

/** Source A: a directory on disk, hashed into git objects in memory (scan.ts). */
export async function dirSource(dir: string, o: ScanOptions = {}): Promise<{ root: CID; objects: MemBlocks }> {
  const objects = new MemBlocks();
  const root = await scan(objects, dir, o);
  return { root, objects };
}

// ---------------------------------------------------------------- reading a system tree

export interface ProgramSpec { name: string; module: CID; record: Record<string, unknown> }

export interface SystemTree {
  root: CID;
  /** Every git object under the root, in walk order. */
  objects: Array<{ cid: CID; bytes: Uint8Array }>;
  programs: ProgramSpec[];
  /** Modules named by bin/<name>.wasm (with their bytes) or bin/<name>.cid (bytes if the source has them). */
  modules: Array<{ cid: CID; bytes?: Uint8Array; name: string }>;
  config: ConfigSpec;
  /** etc/dispatch.json (#77, #143): the routes. Required. */
  dispatch: DispatchSpec[];
  /** etc/apps.json (#141): the apps installed at birth, and each one's tree (path → tree CID). */
  apps?: ImageApps;
  appTrees?: Record<string, CID>;
}

/**
 * etc/apps.json (#141, #143): what an image installs at birth — `install`, the apps' trees in the
 * image (`apps/<name>`), in order; `routes`, root's own routes (no app: an app's upgrade or
 * uninstall leaves them), as the kernel takes them — the site at `/`: the read route
 * {transport: "http", address: "/", prefix: true, filters: ["site.get"], root: "www"}. The genesis
 * carries what installing them as messages would have written: the records (pre-filled), the
 * routes (with `app`) and the heads `<app>/app` (plan.ts planInstall, planRootRoute).
 */
export interface ImageApps { install: string[]; routes?: DispatchSpec[] }

const need = async (objects: Objects, cid: CID, what: string): Promise<Uint8Array> => {
  const b = await objects.get(cid);
  if (!b) throw new Error(`incomplete: ${what} (${cid}) is not in the source`);
  return b;
};

/** Every git object reachable from `root` (trees, blobs, gitlinked records), each checked against its id. */
export async function treeObjects(objects: Objects, root: CID): Promise<Array<{ cid: CID; bytes: Uint8Array; entries?: Entry[] }>> {
  const out: Array<{ cid: CID; bytes: Uint8Array; entries?: Entry[] }> = [];
  const seen = new Set<string>();
  const visit = async (cid: CID, what: string, tree: boolean) => {
    if (seen.has(cid.toString())) return;
    seen.add(cid.toString());
    if (cid.code !== GIT_RAW) throw new Error(`${what}: ${cid} is not a git object`);
    const bytes = await need(objects, cid, what);
    if (!Buffer.from(createHash("sha1").update(bytes).digest()).equals(Buffer.from(cid.multihash.digest))) throw new Error(`hash mismatch: ${what} (${cid})`);
    if (!tree) { out.push({ cid, bytes }); return; }
    const entries = parseTree(bytes, cid);
    out.push({ cid, bytes, entries });
    for (const e of entries) await visit(e.cid, `${what}/${e.name}`, e.mode === "40000");
  };
  await visit(root, "", true);
  return out;
}

/** Read a system tree out of `objects` (docs/BOOTSTRAP.md): its objects, programs, modules, config and subscriptions. */
export async function readSystemTree(objects: Objects, root: CID): Promise<SystemTree> {
  const all = await treeObjects(objects, root);
  const byCid = new Map(all.map((x) => [x.cid.toString(), x]));
  const entriesOf = (cid: CID | undefined) => cid ? byCid.get(cid.toString())?.entries : undefined;
  const at = (path: string): Entry | undefined => {
    let dir: CID | undefined = root, found: Entry | undefined;
    for (const seg of path.split("/")) {
      found = entriesOf(dir)?.find((e) => e.name === seg);
      if (!found) return undefined;
      dir = found.mode === "40000" ? found.cid : undefined;
    }
    return found;
  };
  const text = (e: Entry, path: string): string => {
    const b = gitBody(byCid.get(e.cid.toString())!.bytes, "blob");
    if (!b) throw new Error(`${path}: not a file`);
    return Buffer.from(b).toString("utf8");
  };
  const json = <T>(path: string): T | undefined => {
    const e = at(path);
    if (!e) return undefined;
    try { return JSON.parse(text(e, path)) as T; } catch (x) { throw new Error(`${path}: ${(x as Error).message}`); }
  };

  const bin = at(BIN);
  const programs: ProgramSpec[] = [];
  const modules: SystemTree["modules"] = [];
  const binEntries = bin?.mode === "40000" ? entriesOf(bin.cid) ?? [] : [];
  const names = [...new Set(binEntries.map((e) => /^(.+)\.(wasm|cid)$/.exec(e.name)?.[1]).filter((n): n is string => !!n))].sort();
  for (const name of names) {
    const wasm = binEntries.find((e) => e.name === `${name}.wasm`), cidFile = binEntries.find((e) => e.name === `${name}.cid`);
    if (wasm && cidFile) throw new Error(`bin/${name}: both a .wasm and a .cid`);
    let module: CID;
    if (wasm) {
      const bytes = gitBody(byCid.get(wasm.cid.toString())!.bytes, "blob")!;
      // A preview1 core module (version 1) or a WASI 0.2 component (#34: version 0x0d, layer 1): stored as a raw
      // block either way; the kernel's runner tells them apart by this preamble when it runs one.
      if (wasmKind(bytes) === undefined) throw new Error(`bin/${name}.wasm: not a wasm module or component`);
      module = rawCid(bytes);
      modules.push({ cid: module, bytes: new Uint8Array(bytes), name });
    } else {
      const t = text(cidFile!, `bin/${name}.cid`).trim();
      try { module = parseCid(t); } catch { throw new Error(`bin/${name}.cid: not a CID: ${JSON.stringify(t)}`); }
      if (module.code !== RAW) throw new Error(`bin/${name}.cid: ${module} is not a raw module CID`);
      modules.push({ cid: module, bytes: await objects.get(module), name });
    }
    const meta = json<{ inputs?: unknown; services?: string[]; description?: string }>(`${BIN}/${name}.json`) ?? {};
    programs.push({ name, module, record: programRecord(name, module, meta) });
  }
  for (const g of GONE) if (at(g)) throw new Error(`${g}: the form before #77/#115 is gone (#143: it spoke of senders) — name routes in ${DISPATCH}`);
  const dispatch = json<DispatchSpec[]>(DISPATCH);
  if (dispatch === undefined) throw new Error(`${DISPATCH}: missing (a system tree names its routes)`);
  if (!Array.isArray(dispatch)) throw new Error(`${DISPATCH}: not a list`);
  const config = json<ConfigSpec>(CONFIG) ?? {};
  if (config.defaults && Object.values(config.defaults).some((v) => typeof v !== "string")) throw new Error(`${CONFIG}: every default is a string`);
  const apps = json<ImageApps>(APPS);
  if (apps !== undefined && (!apps || !Array.isArray(apps.install) || apps.install.some((x) => typeof x !== "string") || (apps.routes !== undefined && !Array.isArray(apps.routes)))) throw new Error(`${APPS}: want {install: [<path of an app's tree>], routes?: [<root's own route>]}`);
  if ((apps as { reads?: unknown } | undefined)?.reads !== undefined) throw new Error(`${APPS}: reads: gone (#143) — root's own read is a route in \`routes\` (filters only)`);
  const appTrees: Record<string, CID> = {};
  for (const path of apps?.install ?? []) {
    const e = at(path);
    if (!e || e.mode !== "40000") throw new Error(`${APPS}: ${path} is not a directory of the tree`);
    appTrees[path] = e.cid;
  }
  return { ...(apps ? { apps, appTrees } : {}), root, objects: all.map(({ cid, bytes }) => ({ cid, bytes })), programs, modules, config, dispatch };
}

// ---------------------------------------------------------------- the loader

export type BootSource =
  /** No tree: the stock system in code (the live agents). */
  | { kind: "code" }
  /** A system tree whose objects are in `objects` (a scanned directory, a store, a verified packet). */
  | { kind: "tree"; root: CID; objects: Objects }
  /** A checkpoint (#30): the state record and every block it reaches, verified; restored, not replayed. */
  | { kind: "checkpoint"; state: CID; blocks: Array<{ cid: CID; bytes: Uint8Array }> };

export interface Booted { entry?: CID; tree?: CID; state?: CID; objects: number; programs: string[]; /** #141: the apps the image installed at birth. */ apps?: Array<{ name: string; version: string; notes: string[] }> }

/**
 * Boot an empty store through its kernel: pre-fill and write the genesis (a
 * tree, or the stock system), or restore a checkpoint. The kernel processes
 * the genesis when it starts (the dispatch rows; `main` → the tree).
 */
export async function boot(k: Kernel, src: BootSource, c: Genesis2Config, time: Stamp = clockNow()): Promise<Booted> {
  if (await k.store.log.tip()) throw new Error("the store already has a log: boot only into an empty store");
  if (src.kind === "checkpoint") {
    for (const b of src.blocks) await k.putBlock(b.cid, b.bytes);
    await k.restore(src.state);
    return { state: src.state, objects: src.blocks.length, programs: [] };
  }
  // A tree takes from the kernel only the front door, unless its bin/ has one (#70: the middleware every provider's answer comes in through, as `local`); the other pinned records would sit in the store unreferenced (a replay would not reproduce them). No shell (#83): the shell is an app.
  if (src.kind === "code") {
    const kernelPrograms = await k.call("programs", c.mailbox ? ["frontdoor", "messagebox"] : undefined) as Record<string, CID>;
    const entry = await writeSystemGenesis(k, c, codeSystem(c, kernelPrograms), time);
    return { entry, objects: 0, programs: Object.keys(kernelPrograms) };
  }
  const t = await readSystemTree(src.objects, src.root);
  const kernelPrograms = t.programs.some((p) => p.name === "frontdoor") ? {} : await k.call("programs", ["frontdoor"]) as Record<string, CID>;
  let n = 0;
  for (const o of t.objects) if (!(await k.hasBlock(o.cid))) { await k.putBlock(o.cid, o.bytes); n++; }
  for (const m of t.modules) {
    if (m.bytes) { if (!(await k.hasBlock(m.cid))) { await k.putBlock(m.cid, m.bytes); n++; } }
    else if (!(await k.hasBlock(m.cid))) throw new Error(`incomplete: bin/${m.name}.cid names ${m.cid}, which neither the source nor the kernel holds`);
  }
  // The front door is the kernel's when the tree brings none; every handler comes from bin/
  const programs: Record<string, CID> = { ...(kernelPrograms.frontdoor ? { frontdoor: kernelPrograms.frontdoor } : {}) };
  for (const p of t.programs) programs[p.name] = await k.store.put(p.record as never);
  // A tree that names no http route takes the stock ones (the handshake, the messagebox's, the explorer), as a tree
  // with no etc/routes.json did before #143; each is dropped when the tree lacks its program.
  // The handshake route is the transport's own: a tree that names http routes of its own gets it too.
  const specs = t.dispatch.some((r) => r.transport === "http")
    ? [...t.dispatch, ...(t.dispatch.some((r) => r.transport === "http" && r.address === HANDSHAKE_ROW.address) ? [] : [HANDSHAKE_ROW])]
    : [...t.dispatch, ...STOCK_HTTP];
  let s: System = resolveSystem(c, programs, t.config, t.root, specs);
  const isClaim = (r: DispatchRow) => r.program === "kernel" && r.fn === "claim";
  // An image (#89, #143): no root, so it must be claimable — its routes carry the claim route.
  if (!c.root?.length && !s.dispatch.some(isClaim)) throw new Error(`an image (a genesis with no root) needs a claim route in ${DISPATCH}: ${JSON.stringify(CLAIM_ROW)}`);
  // An image booted with root named (#142: the host skein): born as a claim would leave it — no claim route.
  if (c.root?.length && s.dispatch.some(isClaim)) s = { ...s, dispatch: s.dispatch.filter((r) => !isClaim(r)) };
  let apps: Booted["apps"];
  if (t.apps) {
    const born = await installAtBirth(k, src.objects, t, s, c);
    s = { ...s, dispatch: [...s.dispatch, ...born.rows], heads: born.heads };
    n += born.put;
    apps = born.apps;
  }
  const entry = await writeSystemGenesis(k, c, s, time);
  return { entry, tree: t.root, objects: n, programs: Object.keys(programs), ...(apps ? { apps } : {}) };
}

/**
 * #141: the apps an image installs at birth (etc/apps.json), planned as an install by messages
 * would be (plan.ts: readStoredApp over the app's tree in the image, planInstall) against the
 * instance as its genesis will stand — the same records, routes and heads — and root's own routes
 * (planRootRoute). An app's config given at creation (`appConfig`) is merged over its manifest's,
 * as an install's `--config` is. Their records are put into the store; the routes and heads go
 * into the genesis.
 */
export async function installAtBirth(k: Pick<Kernel, "hasBlock" | "putBlock">, objects: Objects, t: SystemTree, s: System, c: Genesis2Config): Promise<{ rows: DispatchRow[]; heads: Record<string, CID>; put: number; apps: Array<{ name: string; version: string; notes: string[] }> }> {
  const local = new MemBlocks();
  const bytes = async (cid: CID): Promise<Uint8Array> => {
    const b = local.map.get(cid.toString())?.bytes ?? await objects.get(cid);
    if (!b) throw new Error(`not found: ${cid}`);
    return b;
  };
  const store: ViewStore = {
    bytes,
    has: async (cid: CID) => local.map.has(cid.toString()) || await k.hasBlock(cid),
    get: async (cid: CID) => dagCbor.decode(await bytes(cid)),
    putBlock: async (cid: CID, b: Uint8Array) => { local.map.set(cid.toString(), { cid, bytes: b }); },
  } as unknown as ViewStore;
  const view: InstanceView = {
    store, identity: c.identity, programs: s.programs,
    addressBook: (c.addressBook ?? []).map((e) => ({ key: Buffer.from(e.key).toString("hex"), transport: e.transport, address: e.address, ...(e.handle ? { handle: e.handle } : {}), ...(e.domain ? { domain: e.domain } : {}) })),
    heads: [], dispatch: [...s.dispatch],
  };
  const rows: DispatchRow[] = [];
  const heads = new Map<string, CID>();
  let put = 0;
  const put1 = async (r: { cid: CID; bytes: Uint8Array }) => { if (!(await k.hasBlock(r.cid))) { await k.putBlock(r.cid, r.bytes); put++; } };
  const apps: Array<{ name: string; version: string; notes: string[] }> = [];
  for (const path of t.apps!.install) {
    const app = await readStoredApp(store, t.appTrees![path]!);
    // #142: an app's config at birth (the host skein's onboard: its domain, origin, name and note from host.env), merged as `--config` is.
    const config = c.appConfig?.[app.checked.manifest.name];
    if (config) app.checked.manifest.config = mergeConfig(app.checked.manifest.config, config);
    const p = await planInstall(app, view, { modules: objects });
    for (const r of p.records) { local.map.set(r.cid.toString(), r); await put1(r); }
    for (const h of p.heads) {
      heads.set(h.name, h.tree);
      view.heads = [...view.heads.filter((x) => x.name !== h.name), { name: h.name, root: h.tree }];
    }
    for (const r of p.rows) { rows.push(r.row); view.dispatch.push(r.row); }
    apps.push({ name: p.app, version: p.version, notes: p.notes });
  }
  // #147: a root route's handler may be `<app>.<role>` — an app installed above, its program record (as `skein routes add`).
  const named: Record<string, CID> = { ...s.programs };
  for (const r of t.apps!.routes ?? []) {
    const role = typeof r.program === "string" ? /^([a-z0-9][a-z0-9-]*)\.([A-Za-z0-9_-]+)$/.exec(r.program) : null;
    if (!role || named[r.program!]) continue;
    const app = await appRecordIn(view, role[1]!);
    if (!app) throw new Error(`${APPS}: route ${r.address}: handler ${r.program}: no app ${role[1]} installed at birth`);
    const cid = app.record.programs[role[2]!];
    if (!cid) throw new Error(`${APPS}: route ${r.address}: handler ${r.program}: app ${role[1]} has no program ${role[2]} (${Object.keys(app.record.programs).join(", ")})`);
    named[r.program!] = cid;
  }
  for (const r of rowsOf(t.apps!.routes ?? [], named)) {
    const p = await planRootRoute(view, "add", r);
    for (const x of p.rows) { rows.push(x.row); view.dispatch.push(x.row); }
  }
  return { rows, heads: Object.fromEntries(heads), put, apps };
}

/** The program records' CIDs a tree's bin/ yields (as `boot` puts them), without a kernel. */
export function programCid(record: Record<string, unknown>): CID { return encode(record).cid; }

/** The stock system as files (`skein-host system <dir>`): bin/*.cid + bin/*.json from the kernel's records, etc/. */
export async function stockSystemFiles(k: Kernel): Promise<Record<string, string>> {
  const programs = await k.call("programs") as Record<string, CID>;
  const files: Record<string, string> = {};
  for (const [name, cid] of Object.entries(programs)) {
    const r = await k.store.get(cid) as unknown as { code: { wasm: CID }; inputs: unknown; services: string[]; description: string };
    files[`${BIN}/${name}.cid`] = `${r.code.wasm.toString()}\n`;
    files[`${BIN}/${name}.json`] = `${JSON.stringify({ inputs: r.inputs, services: r.services, description: r.description }, null, 2)}\n`;
  }
  const { DEFAULTS } = await import("../runtime/log.ts");
  const { STOCK_DISPATCH, STOCK_ROLES, STOCK_SCOPES } = await import("./genesis.ts");
  files[CONFIG] = `${JSON.stringify({ defaults: DEFAULTS, collect: ["completions"], scopes: STOCK_SCOPES, roles: STOCK_ROLES }, null, 2)}\n`;
  // The stock routes (#77, #143): the boxes, the events and the HTTP routes (the admin routes are every genesis's).
  files[DISPATCH] = `${JSON.stringify(STOCK_DISPATCH, null, 2)}\n`;
  return files;
}


/**
 * Boot a store file that no router holds yet (`skein-host add --boot/--packet`,
 * tests): start its kernel, `boot`, stop it. The router then hydrates it as
 * any other store; the kernel processes the genesis at that first start.
 */
export async function bootStore(o: { db: string; handle: string; domain: string; command?: string; env?: Record<string, string | undefined>; log?(line: string): void }, src: BootSource, c: Genesis2Config, time?: Stamp): Promise<Booted> {
  const { Kernel } = await import("./kernel.ts");
  const { mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(o.db), { recursive: true });
  const k = new Kernel({ db: o.db, handle: o.handle, domain: o.domain, command: o.command, env: o.env, log: o.log });
  try {
    return await boot(k, src, c, time);
  } finally {
    await k.stop(5000);
  }
}

// ---------------------------------------------------------------- more sources

/** Blocks out of a store (a store file opened read-only, or anything with `bytes`). */
export function storeObjects(s: { bytes(cid: CID): Promise<Uint8Array> }): Objects {
  // A block the store does not have (or cannot read) is absent: the loader refuses what names it, with the CID.
  return { get: async (cid) => { try { return await s.bytes(cid); } catch { return undefined; } } };
}

/** The first source that has the block. */
export function anyOf(...sources: Objects[]): Objects {
  return { get: async (cid) => { for (const s of sources) { const b = await s.get(cid); if (b) return b; } return undefined; } };
}

/** The modules in a wasm directory (the repo's wasm/: the pinned builds), by their raw CIDs; hashed on first use. */
export function wasmDirObjects(dir: string): Objects {
  let byCid: Map<string, string> | undefined;
  return {
    get: async (cid) => {
      if (cid.code !== RAW) return undefined;
      const { readdirSync, readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      if (!byCid) {
        byCid = new Map();
        for (const f of readdirSync(dir)) if (f.endsWith(".wasm") || f.endsWith(".zip")) byCid.set(rawCid(readFileSync(join(dir, f))).toString(), join(dir, f));
      }
      const p = byCid.get(cid.toString());
      return p ? new Uint8Array(readFileSync(p)) : undefined;
    },
  };
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
/** The repo's pinned modules (wasm/): what a system tree's `bin/*.cid` names. */
export const WASM_DIR = join(ROOT, "wasm");
/** The default image (#89): a user skein's — no root in it, a claim route. */
export const DEFAULT_IMAGE = join(ROOT, "images/default");
/** The host image's own part (#142): merged over the default image (mergeImages), the host skein's image. */
export const HOST_IMAGE = join(ROOT, "images/host");
/** The Open Exchange image's own part (#147): merged over the default image (mergeImages) — the overlay engine and the amm app, root routes /submit, /lookup and / (the amm landing). */
export const OPEN_EXCHANGE_IMAGE = join(ROOT, "images/open-exchange");

/**
 * Two image trees merged (#142: images are starting trees that merge): every path of `over` added to
 * `base`. A directory in both is merged; a file in both must be the same blob — except `etc/apps.json`,
 * whose `install` and `routes` lists are joined (an app in both is refused; a root route of `over` at the
 * same transport, address and prefix as one of `base`'s replaces it, #147). Any other path in both is a
 * collision, refused with its path. The installer's own checks (boxes, heads, paths) run when the merged
 * image's apps are installed at birth (installAtBirth). The new trees and the merged apps.json go into
 * `out`; every other object stays where it was.
 */
export async function mergeImages(objects: Objects, base: CID, over: CID, out: MemBlocks): Promise<CID> {
  const tree = async (cid: CID) => parseTree(await need(objects, cid, "an image tree"), cid);
  const blob = async (cid: CID, path: string) => {
    const b = gitBody(await need(objects, cid, path), "blob");
    if (!b) throw new Error(`${path}: not a file`);
    return Buffer.from(b).toString("utf8");
  };
  const merge = async (a: CID, b: CID, at: string): Promise<CID> => {
    const entries = new Map((await tree(a)).map((e) => [e.name, e]));
    for (const e of await tree(b)) {
      const path = at ? `${at}/${e.name}` : e.name;
      const had = entries.get(e.name);
      if (!had || had.cid.equals(e.cid)) { entries.set(e.name, e); continue; }
      if (had.mode === "40000" && e.mode === "40000") { entries.set(e.name, { ...e, cid: await merge(had.cid, e.cid, path) }); continue; }
      if (path === APPS && had.mode !== "40000" && e.mode !== "40000") {
        const x = JSON.parse(await blob(had.cid, path)) as ImageApps, y = JSON.parse(await blob(e.cid, path)) as ImageApps;
        const both = (x.install ?? []).filter((p) => (y.install ?? []).includes(p));
        if (both.length) throw new Error(`${APPS}: ${both.join(", ")} installed by both images`);
        // #147: a root route of `over` at a route of `base`'s (same transport, address, prefix) replaces it (Open Exchange's `/`).
        const key = (r: DispatchSpec) => `${r.transport ?? "mailbox"} ${r.address}${r.prefix ? " prefix" : ""}`;
        const mine = new Set((y.routes ?? []).map(key));
        const routes = [...(x.routes ?? []).filter((r) => !mine.has(key(r))), ...(y.routes ?? [])];
        const h = hashBlob(new TextEncoder().encode(`${JSON.stringify({ install: [...(x.install ?? []), ...(y.install ?? [])], ...(routes.length ? { routes } : {}) }, null, 2)}\n`));
        await out.putBlock(h.cid, h.object);
        entries.set(e.name, { ...e, cid: h.cid });
        continue;
      }
      throw new Error(`images: ${path} is in both images (a merge adds paths; it does not replace one)`);
    }
    const t = hashTree([...entries.values()]);
    await out.putBlock(t.cid, t.object);
    return t.cid;
  };
  return await merge(base, over, "");
}

/**
 * An image as a boot source (#89, #90): a directory (default: the default
 * image), its objects with the repo's pinned modules beside them.
 */
export async function imageSource(dir: string = DEFAULT_IMAGE): Promise<BootSource> {
  const d = await dirSource(dir);
  return { kind: "tree", root: d.root, objects: anyOf(d.objects, wasmDirObjects(WASM_DIR)) };
}

/** Source B: a packet file, verified (packet.ts) — a system tree to boot, or a checkpoint to restore. */
export async function packetSource(bytes: Uint8Array, o: import("./packet.ts").ReadOptions = {}): Promise<BootSource> {
  const { readPacket } = await import("./packet.ts");
  const v = await readPacket(bytes, o);
  return v.kind === "tree" ? { kind: "tree", root: v.scope, objects: v.blocks } : { kind: "checkpoint", state: v.scope, blocks: v.list };
}

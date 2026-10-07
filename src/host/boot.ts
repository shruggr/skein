// The bootstrap loader (issue #4): one loader, two sources, no genesis by code
// alone. An instance boots from a **system tree** (docs/BOOTSTRAP.md):
//
//   bin/<name>.wasm   a handler program's module (WASI), or
//   bin/<name>.cid    the CID (raw, bafkrei…) of a module the source or the kernel holds
//   bin/<name>.json   optional: the program record's {inputs, services, description}
//   etc/config.json   optional: {defaults, peers, names, collect, feeds} (keys hex or $owner/$infer; feeds: feeds.ts)
//   etc/dispatch.json        [{transport?, address, prefix?, sender?, program, fn?, …}] (#77: the dispatch rows; genesis.ts DispatchSpec)
//   etc/subscriptions.json   [{sender?, box, handler}] (the form before #77, still read: a mailbox row each)
//   … anything else: the instance's files (SOUL.md, skills/ …)
//
// The loader **pre-fills the store** with the tree's objects (git-raw blobs
// and trees, each hash-checked by the kernel's `putblock`; modules as raw
// blocks), puts a program record per bin/ module, and writes the genesis from
// the tree's config and subscriptions, naming the tree — the kernel sets
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
import { GIT_RAW, parseTree, type Entry, type TreeBlocks } from "../runtime/tree.ts";
import { scan, type ScanOptions } from "../dev/scan.ts";
import { now as clockNow } from "./clock.ts";
import * as dagCbor from "@ipld/dag-cbor";
import type { DispatchRow } from "../runtime/dispatch.ts";
import { appRecordIn, planInstall, planOwnerRead, READS_HEAD, readStoredApp, type InstanceView, type ReadEntry, type ViewStore } from "./plan.ts";
import { CLAIM_ROW, codeSystem, resolveSystem, writeSystemGenesis, type ConfigSpec, type DispatchSpec, type Genesis2Config, type ReadSpec, type PathRowSpec, type BoxRowSpec, type System } from "./genesis.ts";
import type { Kernel } from "./kernel.ts";

export const DAG_CBOR = 0x71;
// The module and program-record helpers live in ../runtime/programs.ts (no node APIs: the plan uses them in a browser too, #92).
export { programRecord, RAW, rawCid, wasmKind };

export const BIN = "bin";
export const CONFIG = "etc/config.json";
export const DISPATCH = "etc/dispatch.json";
export const SUBSCRIPTIONS = "etc/subscriptions.json";
export const ROUTES = "etc/routes.json";
export const READS = "etc/reads.json";
/** #141: the apps an image installs at birth, and the owner's reads (ImageApps). */
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
  /** etc/dispatch.json (#77): the dispatch rows; etc/subscriptions.json, the form before it (mailbox rows). One of them is required. */
  dispatch?: DispatchSpec[];
  subscriptions?: BoxRowSpec[];
  /** etc/routes.json (#40, the form before #77: http and libp2p rows), else the stock http rows; etc/reads.json, else the stock reads. */
  routes?: PathRowSpec[];
  reads?: ReadSpec[];
  /** etc/apps.json (#141): the apps installed at birth, and each one's tree (path → tree CID). */
  apps?: ImageApps;
  appTrees?: Record<string, CID>;
}

/**
 * etc/apps.json (#141): what an image installs at birth — `install`, the apps' trees in the image
 * (`apps/<name>`), in order; `reads`, the owner's own reads (#135), each `program` a role of an installed
 * app as `<app>.<role>` (the site at `/`: {address: "/", prefix: true, program: "site.site", fn: "get",
 * root: "www"}). The genesis carries what installing them as messages would have written: the
 * records (pre-filled), the rows (with `app`) and the heads `<app>/app` and `reads` (plan.ts
 * planInstall, planOwnerRead) — but no row from `$owner` in an image: it has no owner, and the owner
 * adds those after the claim.
 */
export interface ImageApps { install: string[]; reads?: Array<{ address: string; prefix?: boolean; program: string; fn: string; [setting: string]: unknown }> }

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
  const dispatch = json<DispatchSpec[]>(DISPATCH);
  if (dispatch !== undefined && !Array.isArray(dispatch)) throw new Error(`${DISPATCH}: not a list`);
  const subscriptions = json<BoxRowSpec[]>(SUBSCRIPTIONS);
  if (subscriptions !== undefined && !Array.isArray(subscriptions)) throw new Error(`${SUBSCRIPTIONS}: not a list`);
  if (dispatch === undefined && subscriptions === undefined) throw new Error(`${DISPATCH}: missing (a system tree names its dispatch rows; ${SUBSCRIPTIONS} is the form before #77)`);
  for (const s of subscriptions ?? []) {
    if (!s || typeof s.box !== "string" || !s.box || typeof s.handler !== "string" || (s.sender !== undefined && typeof s.sender !== "string")) {
      throw new Error(`${SUBSCRIPTIONS}: bad entry ${JSON.stringify(s)} (want {sender?, box, handler})`);
    }
  }
  const config = json<ConfigSpec>(CONFIG) ?? {};
  if (config.defaults && Object.values(config.defaults).some((v) => typeof v !== "string")) throw new Error(`${CONFIG}: every default is a string`);
  const routes = json<PathRowSpec[]>(ROUTES);
  if (routes !== undefined && !Array.isArray(routes)) throw new Error(`${ROUTES}: not a list`);
  const reads = json<ReadSpec[]>(READS);
  if (reads !== undefined && !Array.isArray(reads)) throw new Error(`${READS}: not a list`);
  const apps = json<ImageApps>(APPS);
  if (apps !== undefined && (!apps || !Array.isArray(apps.install) || apps.install.some((x) => typeof x !== "string") || (apps.reads !== undefined && !Array.isArray(apps.reads)))) throw new Error(`${APPS}: want {install: [<path of an app's tree>], reads?: [{address, prefix?, program: <app>.<role>, fn, …settings}]}`);
  const appTrees: Record<string, CID> = {};
  for (const path of apps?.install ?? []) {
    const e = at(path);
    if (!e || e.mode !== "40000") throw new Error(`${APPS}: ${path} is not a directory of the tree`);
    appTrees[path] = e.cid;
  }
  return { ...(apps ? { apps, appTrees } : {}), root, objects: all.map(({ cid, bytes }) => ({ cid, bytes })), programs, modules, config, ...(dispatch ? { dispatch } : {}), ...(subscriptions ? { subscriptions } : {}), ...(routes ? { routes } : {}), ...(reads ? { reads } : {}) };
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
  let s: System = resolveSystem(c, programs, t.subscriptions ?? [], t.config, t.root, t.routes, t.reads, t.dispatch);
  // An image (#89): no owner, so it must be claimable — its rows carry the claim row.
  if (!c.owner && !s.dispatch.some((r) => r.program === "kernel" && r.fn === "claim")) throw new Error(`an image (a genesis with no owner) needs a claim row in ${DISPATCH}: ${JSON.stringify(CLAIM_ROW)}`);
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
 * would be (plan.ts: readStoredApp over the app's tree in the image, planInstall, planOwnerRead)
 * against the instance as its genesis will stand — the same records, rows and heads, the rows from
 * `$owner` left out when the genesis names no owner. Their records are put into the store; the
 * rows and heads go into the genesis.
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
    store, owner: c.owner ?? "", identity: c.identity, programs: s.programs,
    addressBook: (c.addressBook ?? []).map((e) => ({ key: Buffer.from(e.key).toString("hex"), transport: e.transport, address: e.address, ...(e.handle ? { handle: e.handle } : {}), ...(e.domain ? { domain: e.domain } : {}) })),
    heads: [], dispatch: [...s.dispatch],
  };
  const rows: DispatchRow[] = [];
  const heads = new Map<string, CID>();
  let put = 0;
  const put1 = async (r: { cid: CID; bytes: Uint8Array }) => { if (!(await k.hasBlock(r.cid))) { await k.putBlock(r.cid, r.bytes); put++; } };
  const take = async (records: Array<{ cid: CID; bytes: Uint8Array }>, hs: Array<{ name: string; tree: CID }>) => {
    // A `reads` record each step replaces is put once, the last (a block nothing names would not replay).
    const reads = hs.find((h) => h.name === READS_HEAD)?.tree;
    for (const r of records) {
      local.map.set(r.cid.toString(), r);
      if (!reads?.equals(r.cid)) await put1(r);
    }
    for (const h of hs) {
      heads.set(h.name, h.tree);
      view.heads = [...view.heads.filter((x) => x.name !== h.name), { name: h.name, root: h.tree }];
    }
  };
  const apps: Array<{ name: string; version: string; notes: string[] }> = [];
  for (const path of t.apps!.install) {
    const app = await readStoredApp(store, t.appTrees![path]!);
    const p = await planInstall(app, view, { modules: objects, image: !c.owner });
    await take(p.records, p.heads);
    for (const r of p.rows) { rows.push(r.row); view.dispatch.push(r.row); }
    apps.push({ name: p.app, version: p.version, notes: p.notes });
  }
  for (const r of t.apps!.reads ?? []) {
    const [name, role] = r.program.split(".");
    const rec = name && role ? await appRecordIn(view, name) : undefined;
    const program = rec?.record.programs[role!];
    if (!program) throw new Error(`${APPS}: read ${r.address}: ${r.program} is not <app>.<role> of an app installed here`);
    const { prefix, ...rest } = r;
    const p = await planOwnerRead(view, "add", { ...rest, ...(prefix ? { prefix: true as const } : {}), program } as ReadEntry);
    await take(p.records, [p.head]);
  }
  const reads = heads.get(READS_HEAD);
  if (reads) await put1(local.map.get(reads.toString())!);
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
  const { STOCK_DISPATCH, STOCK_HTTP, STOCK_READS, STOCK_SCOPES } = await import("./genesis.ts");
  files[CONFIG] = `${JSON.stringify({ defaults: DEFAULTS, collect: ["completions"], scopes: STOCK_SCOPES }, null, 2)}\n`;
  // The stock rows (#77): the admin rows and the boxes, then the HTTP rows as dispatch specs.
  const http = STOCK_HTTP.map(({ path, prefix, program, fn, auth, read, root, index }) => ({ transport: "http", address: path ?? prefix, ...(prefix !== undefined ? { prefix: true } : {}), sender: auth === "none" ? "*" : "session", program, fn, ...(read ? { read } : {}), ...(root ? { root } : {}), ...(index ? { index } : {}) }));
  files[DISPATCH] = `${JSON.stringify([...STOCK_DISPATCH, ...http], null, 2)}\n`;
  files[READS] = `${JSON.stringify(STOCK_READS, null, 2)}\n`;
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
/** The default image (#89): one genesis for everyone, no owner in it, a claim row. */
export const DEFAULT_IMAGE = join(ROOT, "images/default");

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

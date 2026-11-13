// The bootstrap loader (issue #4): one loader, no genesis by code (skein next, SPEC 8: everything
// about the starting point comes from the tree). An instance boots from a **system tree**
// (docs/BOOTSTRAP.md):
//
//   etc/routes.json   [<row>] the starting rows as the kernel takes them (SPEC 3; genesis.ts rowsOf):
//                     the kernel's operation rows, an image's claim row (`handler: "kernel.claim"`,
//                     `role: "user"`), root's own rows. Required: a tree with it is a complete image
//   etc/config.json   optional: {defaults?, grants?: {<role>: [<hex key>]}}
//   etc/apps.json     optional: {install: [<directory> | {url, hash}], routes?: [<root's own row>]}
//   … anything else: the instance's files
//   (bin/ is gone: an image's programs come in its apps; etc/dispatch.json, the old row form, is refused)
//
// The loader **pre-fills the store** with the tree's objects (git-raw blobs and trees, each
// hash-checked by the kernel's `putblock`), installs the apps etc/apps.json names at birth (their
// objects, modules and records put; their rows, heads and call permissions into the genesis), and
// writes the genesis from the tree's rows and config, naming the tree — the kernel sets `main` to it
// when it processes the genesis. A function of the log (a replay copies the tree and gets the same
// state). The sources only differ in where the objects come from (`Objects`): a directory scanned
// into memory, a store file, or a verified chain packet (packet.ts); a packet with a checkpoint (#30's
// state record) is restored instead. An empty store is no instance (the router refuses to start it).

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { CID } from "multiformats/cid";
import { encode, parse as parseCid } from "../runtime/cid.ts";
import { RAW, rawCid } from "../runtime/programs.ts";
import type { Stamp } from "../runtime/syscalls.ts";
import { GIT_RAW, hashBlob, hashTree, parseTree, sha1Cid, type Entry, type TreeBlocks } from "../runtime/tree.ts";
import { scan, type ScanOptions } from "../dev/scan.ts";
import { now as clockNow } from "./clock.ts";
import * as dagCbor from "@ipld/dag-cbor";
import { rowKey, type DispatchRow } from "../runtime/dispatch.ts";
import { mergeConfig, planInstall, planRootRoute, readStoredApp, type GrantOp, type InstanceView, type ViewStore } from "./plan.ts";
import { checkConfig, isClaimRow, rowsOf, resolveSystem, writeSystemGenesis, type ConfigSpec, type GenesisConfig, type System } from "./genesis.ts";
import { appIgnore } from "./install.ts";
import type { KernelSurface as Kernel } from "./kernel.ts";

export const DAG_CBOR = 0x71;
export { RAW, rawCid };

export const BIN = "bin";
export const CONFIG = "etc/config.json";
/** The starting rows (skein next, SPEC 3). */
export const ROUTES = "etc/routes.json";
/** The forms gone, refused: the old row form (etc/dispatch.json) and the forms before #77. */
export const GONE = ["etc/dispatch.json", "etc/subscriptions.json", "etc/reads.json"];
/** #141, #152: the apps an image installs at birth, and root's own rows (ImageApps). */
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

export interface SystemTree {
  root: CID;
  /** Every git object under the root, in walk order. */
  objects: Array<{ cid: CID; bytes: Uint8Array }>;
  config: ConfigSpec;
  /** etc/routes.json: the starting rows. Required. */
  routes: DispatchRow[];
  /** etc/apps.json (#141): the apps installed at birth, and the trees of those inside the image (appKey → tree CID). */
  apps?: ImageApps;
  appTrees?: Record<string, CID>;
}

/**
 * etc/apps.json (#141, #143, #152): what an image installs at birth — `install`, in order, each app
 * a directory (a path relative to the image: a directory of its tree, or one beside it, `..`, read
 * when the image is read from its directory) or a release tarball `{url, hash}` (`hash`: the git id
 * of the app's tree, 40 hex — the tag's tree, `git rev-parse <tag>^{tree}`), which the host fetches
 * and checks; `routes`, root's own routes (no app: an app's upgrade or uninstall leaves them), as
 * the kernel takes them. The genesis carries what installing them as messages would have written:
 * the app's objects and records (pre-filled), the routes (with `app`) and the heads `<app>/app`
 * (plan.ts planInstall, planRootRoute).
 */
export interface ImageApps { install: ImageApp[]; routes?: DispatchRow[] }
export type ImageApp = string | { url: string; hash: string };
/** An entry's key: its path, or its tarball's tree id. */
export const appKey = (a: ImageApp): string => typeof a === "string" ? posix.normalize(a).replace(/\/$/, "") : a.hash;
const isImageApp = (a: unknown): a is ImageApp =>
  typeof a === "string" ? a.length > 0 : !!a && typeof a === "object" && typeof (a as { url?: unknown }).url === "string" && typeof (a as { hash?: unknown }).hash === "string" && /^[0-9a-f]{40}$/.test((a as { hash: string }).hash) && Object.keys(a).length === 2;

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

/** Read a system tree out of `objects` (docs/BOOTSTRAP.md): its objects, rows, config and apps. */
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

  if (at(BIN)) throw new Error(`${BIN}/: gone (skein next): an image's programs come in its apps (${APPS})`);
  for (const g of GONE) if (at(g)) throw new Error(`${g}: the old form is gone (skein next) — name the rows in ${ROUTES} ({kind, path | name, role, checks?, recheck?, handler})`);
  const routes = json<unknown>(ROUTES);
  if (routes === undefined) throw new Error(`${ROUTES}: missing (a system tree names its rows)`);
  const config = checkConfig(json<unknown>(CONFIG));
  const apps = json<ImageApps>(APPS);
  checkImageApps(apps);
  const appTrees: Record<string, CID> = {};
  for (const a of apps?.install ?? []) {
    if (typeof a !== "string") continue;
    const e = at(appKey(a));
    if (e?.mode === "40000") appTrees[appKey(a)] = e.cid;
  }
  return { ...(apps ? { apps, appTrees } : {}), root, objects: all.map(({ cid, bytes }) => ({ cid, bytes })), config, routes: rowsOf(routes) };
}

/** etc/apps.json's shape (#141, #152), refused with what it wants. */
export function checkImageApps(apps: ImageApps | undefined): void {
  if (apps === undefined) return;
  if (!apps || !Array.isArray(apps.install) || !apps.install.every(isImageApp) || (apps.routes !== undefined && !Array.isArray(apps.routes))) throw new Error(`${APPS}: want {install: [<directory, relative to the image> | {url: <tarball>, hash: <its tree's git id, 40 hex>}], routes?: [<root's own route>]}`);
  if ((apps as { reads?: unknown }).reads !== undefined) throw new Error(`${APPS}: reads: gone — root's own read is a row in \`routes\` (kind read)`);
  const keys = apps.install.map(appKey);
  const twice = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (twice.length) throw new Error(`${APPS}: ${twice.join(", ")} listed twice`);
}

// ---------------------------------------------------------------- the loader

export type BootSource =
  /**
   * A system tree whose objects are in `objects` (a scanned directory, a store, a verified packet). `apps` (#152):
   * the trees of the apps its etc/apps.json names by a directory outside the image, by appKey, read with the image
   * from its directory (their objects in `objects`).
   */
  | { kind: "tree"; root: CID; objects: Objects; apps?: Record<string, CID> }
  /** A checkpoint (#30): the state record and every block it reaches, verified; restored, not replayed. */
  | { kind: "checkpoint"; state: CID; blocks: Array<{ cid: CID; bytes: Uint8Array }> };

export interface Booted { entry?: CID; tree?: CID; state?: CID; objects: number; programs: string[]; /** #141: the apps the image installed at birth. */ apps?: Array<{ name: string; version: string; notes: string[] }> }

/**
 * Boot an empty store through its kernel: pre-fill and write the genesis from
 * a tree, or restore a checkpoint. The kernel processes
 * the genesis when it starts (the dispatch rows; `main` → the tree).
 */
export async function boot(k: Kernel, src: BootSource, c: GenesisConfig, time: Stamp = clockNow()): Promise<Booted> {
  if (await k.store.log.tip()) throw new Error("the store already has a log: boot only into an empty store");
  if (src.kind === "checkpoint") {
    for (const b of src.blocks) await k.putBlock(b.cid, b.bytes);
    await k.restore(src.state);
    return { state: src.state, objects: src.blocks.length, programs: [] };
  }
  const t = await readSystemTree(src.objects, src.root);
  let n = 0;
  for (const o of t.objects) if (!(await k.hasBlock(o.cid))) { await k.putBlock(o.cid, o.bytes); n++; }
  let s: System = resolveSystem(c, t.config, t.routes, t.root);
  const owned = (s.grants.root ?? []).length > 0;
  // An image no one owns at birth (#89): it must be claimable — its rows carry the claim row (SPEC 3: kernel.claim, role user).
  if (!owned && !s.routes.some(isClaimRow)) throw new Error(`an image with no root at birth needs a claim row in ${ROUTES}: {"kind": "request", "path": "/kernel/claim", "role": "user", "handler": "kernel.claim"}`);
  // Born owned (root granted at birth): as a claim would leave it — no claim row.
  if (owned) s = { ...s, routes: s.routes.filter((r) => !isClaimRow(r)) };
  let apps: Booted["apps"];
  if (t.apps) {
    const born = await installAtBirth(k, src.objects, t, s, c, src.apps);
    s = { ...s, routes: [...s.routes, ...born.rows], heads: born.heads, ...withGrants(s, born.grants) };
    n += born.put;
    apps = born.apps;
  }
  const entry = await writeSystemGenesis(k, c, s, time);
  return { entry, tree: t.root, objects: n, programs: [], ...(apps ? { apps } : {}) };
}

/**
 * #141, #152: the apps an image installs at birth (etc/apps.json), each a directory install — the
 * app's tree (in the image; a directory beside it, `resolved` by the source; a tarball fetched and
 * checked, appTarball), its objects put — planned as an install by messages would be (plan.ts:
 * readStoredApp over the app's tree, planInstall) against the instance as its genesis will stand —
 * the same records, routes and heads — and root's own routes (planRootRoute). An app's config given
 * at creation (`appConfig`) is merged over its manifest's, as an install's `--config` is. Their
 * objects and records are put into the store; the routes and heads go into the genesis.
 */
export async function installAtBirth(k: Pick<Kernel, "hasBlock" | "putBlock">, imageObjects: Objects, t: SystemTree, s: System, c: GenesisConfig, resolved: Record<string, CID> = {}): Promise<{ rows: DispatchRow[]; heads: Record<string, CID>; grants: GrantOp[]; put: number; apps: Array<{ name: string; version: string; notes: string[] }> }> {
  const fetched = new MemBlocks();
  const objects = anyOf(imageObjects, fetched);
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
  const view: InstanceView = { store, identity: c.identity, heads: [], dispatch: [...s.routes] };
  const rows: DispatchRow[] = [];
  const heads = new Map<string, CID>();
  // Call permissions: what each app's manifest asks (calls, services), written into the genesis: at birth the image is the approver.
  const grants: GrantOp[] = [];
  let put = 0;
  const put1 = async (r: { cid: CID; bytes: Uint8Array }) => { if (!(await k.hasBlock(r.cid))) { await k.putBlock(r.cid, r.bytes); put++; } };
  const apps: Array<{ name: string; version: string; notes: string[] }> = [];
  for (const entry of t.apps!.install) {
    const key = appKey(entry);
    let tree = t.appTrees?.[key] ?? resolved[key];
    if (!tree && typeof entry === "string") throw new Error(`${APPS}: ${entry} is not a directory of the image (a directory beside it is read when the image is booted from its directory)`);
    if (!tree) tree = await appTarball(entry as { url: string; hash: string }, imageObjects, fetched);
    if (!t.appTrees?.[key]) for (const o of await treeObjects(objects, tree)) await put1(o);
    const app = await readStoredApp(store, tree);
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
    grants.push(...p.grants.filter((g) => g.op === "add"));
    apps.push({ name: p.app, version: p.version, notes: p.notes });
  }
  // Root's own rows (etc/apps.json `routes`), as the kernel takes them: a handler of an app installed above.
  const own = rowsOf(t.apps!.routes ?? []);
  for (const r of own) {
    if (view.dispatch.some((x) => rowKey(x) === rowKey(r))) throw new Error(`${APPS}: routes: ${rowKey(r)}: another row has it`);
    const p = await planRootRoute(view, "add", r);
    for (const x of p.rows) { rows.push(x.row); view.dispatch.push(x.row); }
  }
  return { rows, heads: Object.fromEntries(heads), grants, put, apps };
}

/** A system with `grants` (adds) folded into its genesis's `calls` and `services` (call permissions). */
export function withGrants(s: Pick<System, "calls" | "services">, grants: GrantOp[]): Pick<System, "calls" | "services"> {
  const calls: Record<string, Record<string, string[]>> = JSON.parse(JSON.stringify(s.calls ?? {}));
  const services: Record<string, string[]> = JSON.parse(JSON.stringify(s.services ?? {}));
  for (const g of grants) {
    if ("calls" in g) {
      const by = (calls[g.calls.caller] ??= {});
      by[g.calls.callee] = [...new Set([...(by[g.calls.callee] ?? []), g.calls.name])].sort();
    } else services[g.service.caller] = [...new Set([...(services[g.service.caller] ?? []), g.service.service])].sort();
  }
  return { calls, services };
}

/** The program records' CIDs a tree's bin/ yields (as `boot` puts them), without a kernel. */
export function programCid(record: Record<string, unknown>): CID { return encode(record).cid; }

/**
 * Boot a store file that no router holds yet (`skein-host add --boot/--packet`,
 * tests): start its kernel, `boot`, stop it. The router then hydrates it as
 * any other store; the kernel processes the genesis at that first start.
 */
export async function bootStore(o: { db: string; handle: string; domain: string; command?: string; env?: Record<string, string | undefined>; log?(line: string): void }, src: BootSource, c: GenesisConfig, time?: Stamp): Promise<Booted> {
  const { KernelHost } = await import("./kernel.ts");
  const { mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const { parseRocksSpec, refuseLmdb } = await import("../runtime/index-store.ts");
  // #158: a RocksDB set boots in the host's one kernel process (this node process's, shared with its router, or one of its own).
  const rocks = parseRocksSpec(o.db);
  // The settled split: a SQLite set boots on the wasm kernel (this node process's machine for it).
  const { parseSqliteSpec } = await import("../runtime/index-store.ts");
  const sq = parseSqliteSpec(o.db);
  if (sq) {
    const { WasmHost } = await import("./wasm-kernel.ts");
    const net = o.env?.SKEIN_NETWORK ?? process.env.SKEIN_NETWORK;
    const host = WasmHost.acquire(sq.db, { network: net ?? "main", log: o.log });
    try {
      const k = await host.open({ db: o.db, handle: o.handle, domain: o.domain, log: o.log });
      try { return await boot(k, src, c, time); } finally { await k.stop(); }
    } finally { await host.release(); }
  }
  if (rocks) {
    const host = KernelHost.acquire(rocks.dir, { command: o.command, env: o.env, log: o.log });
    try {
      const k = await host.open({ db: o.db, handle: o.handle, domain: o.domain, log: o.log });
      try { return await boot(k, src, c, time); } finally { await k.stop(); }
    } finally { await host.release(); }
  }
  refuseLmdb(o.db);
  void mkdirSync; void dirname;
  throw new Error(`${o.db}: an instance's store is a set of the host's SQLite or RocksDB database (sqlite:<db>#<handle>, rocksdb:<dir>#<handle>): the one-process-per-instance serve mode is gone (SPEC 5)`);
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

/**
 * Two image trees merged (#142: images are starting trees that merge): every path of `over` added to
 * `base`. A directory in both is merged; a file in both must be the same blob — except `etc/apps.json`,
 * whose `install` and `routes` lists are joined (an app in both, by appKey, is refused; a root route of
 * `over` at the same transport, address and prefix as one of `base`'s replaces it, #147). Any other path in both is a
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
        const theirs = new Set((y.install ?? []).map(appKey));
        const both = (x.install ?? []).map(appKey).filter((p) => theirs.has(p));
        if (both.length) throw new Error(`${APPS}: ${both.join(", ")} installed by both images`);
        // #147: a root route of `over` at a route of `base`'s (same transport, address, prefix) replaces it.
        const key = (r: DispatchRow) => rowKey(r);
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
 * #152: an image directory with no etc/routes.json is an overlay — it carries what it adds (an app
 * repository's `image/`: `etc/apps.json` alone) and is merged over the default image before boot; one
 * with etc/routes.json is a complete image of its own.
 */
export function isOverlayImage(dir: string): boolean {
  return !existsSync(join(dir, ROUTES));
}

/** An image's static part: its tree, its objects, the apps it names beside it (imageDir). */
export interface ImageStatic { root: CID; objects: Objects; apps: Record<string, CID> }

/**
 * #142, #152: an overlay image directory (`dir`: images/host, an app repository's `image/`) merged over
 * `base` (mergeImages: an app in both refused, a root route at the same place replaced, any other path in
 * both refused unless it is the same blob). The apps each names beside it are kept, by appKey.
 */
export async function overlayImage(base: ImageStatic, dir: string): Promise<ImageStatic> {
  const own = await imageDir(dir);
  const merged = new MemBlocks();
  const objects = anyOf(merged, base.objects, own.objects);
  const root = await mergeImages(objects, base.root, own.root, merged);
  return { root, objects, apps: { ...base.apps, ...own.apps } };
}

/**
 * An image as a boot source (#89, #90): a directory (default: the default
 * image), its objects with the repo's pinned modules beside them, and the
 * apps it names by a directory outside it (imageDir).
 */
export async function imageSource(dir: string = DEFAULT_IMAGE): Promise<BootSource & { kind: "tree" }> {
  const d = await imageDir(dir);
  return { kind: "tree", root: d.root, objects: anyOf(d.objects, wasmDirObjects(WASM_DIR)), apps: d.apps };
}

/**
 * An image by the names a create or `skein-host add --image` gives: `default` (images/default), or
 * `overlay` a directory with no etc/routes.json merged over it (#152). With the repo's pinned modules
 * beside its objects (imageSource).
 */
export async function namedImageSource(o: { image?: string; overlay?: string } = {}): Promise<BootSource & { kind: "tree" }> {
  if (o.image !== undefined && o.image !== "default") throw new Error(`image ${JSON.stringify(o.image)}: this host has default`);
  if (o.overlay === undefined) return await imageSource(DEFAULT_IMAGE);
  const s = await overlayImage(await imageDir(DEFAULT_IMAGE), o.overlay);
  return { kind: "tree", root: s.root, objects: anyOf(s.objects, wasmDirObjects(WASM_DIR)), apps: s.apps };
}

/**
 * #152: an image directory scanned, and each app its etc/apps.json names by a directory outside it
 * (`..`, `../<dir>`, an absolute path) scanned from there as `skein install <dir>` reads it
 * (install.ts appIgnore): the trees by appKey (BootSource `apps`), their objects with the image's.
 */
export async function imageDir(dir: string): Promise<{ root: CID; objects: MemBlocks; apps: Record<string, CID> }> {
  const d = await dirSource(dir);
  const apps: Record<string, CID> = {};
  const file = join(dir, APPS);
  if (!existsSync(file)) return { ...d, apps };
  let list: ImageApps;
  try { list = JSON.parse(readFileSync(file, "utf8")) as ImageApps; } catch (x) { throw new Error(`${APPS}: ${(x as Error).message}`); }
  checkImageApps(list);
  for (const a of list.install) {
    if (typeof a !== "string") continue;
    const key = appKey(a);
    if (posix.isAbsolute(key) || key === ".." || key.startsWith("../")) apps[key] = await scan(d.objects, resolve(dir, a), { ignore: appIgnore });
  }
  return { ...d, apps };
}

/**
 * #152: an app by release tarball, `hash` its tree's git id: the tree the image's objects hold
 * already, else fetched from `url` (gzip or plain tar), unpacked (a tarball holding one directory,
 * as a tag's archive does, is that directory), scanned into `into` as `skein install <dir>` reads
 * a directory (install.ts appIgnore), and refused unless its tree is `hash`.
 */
export async function appTarball(a: { url: string; hash: string }, have: Objects, into: MemBlocks, get: typeof fetch = fetch): Promise<CID> {
  const want = sha1Cid(Buffer.from(a.hash, "hex"));
  if (await have.get(want)) return want;
  const r = await get(a.url);
  if (!r.ok) throw new Error(`${APPS}: ${a.url}: ${r.status} ${r.statusText}`);
  let bytes: Uint8Array = new Uint8Array(await r.arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
  const dir = mkdtempSync(join(tmpdir(), "skein-app-"));
  try {
    const x = spawnSync("tar", ["-x", "-f", "-", "-C", dir], { input: bytes });
    if (x.status !== 0) throw new Error(`${APPS}: ${a.url}: not a tarball (${x.stderr.toString().trim() || `tar exit ${x.status}`})`);
    const top = readdirSync(dir, { withFileTypes: true });
    const root = await scan(into, top.length === 1 && top[0]!.isDirectory() ? join(dir, top[0]!.name) : dir, { ignore: appIgnore });
    if (!root.equals(want)) throw new Error(`${APPS}: ${a.url}: its tree is ${Buffer.from(root.multihash.digest).toString("hex")}, not ${a.hash}`);
    return root;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Source B: a packet file, verified (packet.ts) — a system tree to boot, or a checkpoint to restore. */
export async function packetSource(bytes: Uint8Array, o: import("./packet.ts").ReadOptions = {}): Promise<BootSource> {
  const { readPacket } = await import("./packet.ts");
  const v = await readPacket(bytes, o);
  return v.kind === "tree" ? { kind: "tree", root: v.scope, objects: v.blocks } : { kind: "checkpoint", state: v.scope, blocks: v.list };
}

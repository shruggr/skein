// The bootstrap loader (issue #4): one loader, two sources, no genesis by code
// alone. An instance boots from a **system tree** (docs/BOOTSTRAP.md):
//
//   bin/<name>.wasm   a handler program's module (WASI), or
//   bin/<name>.cid    the CID (raw, bafkrei…) of a module the source or the kernel holds
//   bin/<name>.json   optional: the program record's {inputs, services, description}
//   etc/config.json   optional: {defaults, peers, names, collect, feeds} (keys hex or $owner/$infer; feeds: feeds.ts)
//   etc/subscriptions.json   [{sender?, box, handler}] (sender hex/$owner/$infer, handler a bin/ name or a CID)
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
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import { encode, parse as parseCid } from "../runtime/cid.ts";
import type { Stamp } from "../runtime/syscalls.ts";
import { GIT_RAW, parseTree, type Entry, type TreeBlocks } from "../runtime/tree.ts";
import { scan, type ScanOptions } from "../dev/scan.ts";
import { now as clockNow } from "./clock.ts";
import { codeSystem, resolveSystem, writeSystemGenesis, type ConfigSpec, type Genesis2Config, type ReadSpec, type RouteSpec, type SubscriptionSpec, type System } from "./genesis.ts";
import type { Kernel } from "./kernel.ts";

export const RAW = 0x55;
export const DAG_CBOR = 0x71;
const SHA2_256 = 0x12;

export const BIN = "bin";
export const CONFIG = "etc/config.json";
export const SUBSCRIPTIONS = "etc/subscriptions.json";
export const ROUTES = "etc/routes.json";
export const READS = "etc/reads.json";

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

export const rawCid = (bytes: Uint8Array): CID => CID.createV1(RAW, Digest.create(SHA2_256, createHash("sha256").update(bytes).digest()));

/** A git object's body if it is a `<type>` object. */
export function gitBody(object: Uint8Array, type: "blob" | "tree"): Uint8Array | undefined {
  const nul = object.indexOf(0);
  if (nul < 0) return undefined;
  const head = Buffer.from(object.subarray(0, nul)).toString("latin1");
  return head === `${type} ${object.length - nul - 1}` ? object.subarray(nul + 1) : undefined;
}

/** A wasm binary's kind by its preamble: a core module, a component (#34), or neither. */
export function wasmKind(b: Uint8Array): "module" | "component" | undefined {
  if (b.length < 8 || b[0] !== 0 || b[1] !== 0x61 || b[2] !== 0x73 || b[3] !== 0x6d) return undefined;
  if (b[4] === 1 && b[5] === 0 && b[6] === 0 && b[7] === 0) return "module";
  if (b[4] === 0x0d && b[5] === 0 && b[6] === 1 && b[7] === 0) return "component";
  return undefined;
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
  subscriptions: SubscriptionSpec[];
  /** etc/routes.json (#40), else the stock routes; etc/reads.json, else the stock reads. */
  routes?: RouteSpec[];
  reads?: ReadSpec[];
}

/** A handler program's record inputs when bin/<name>.json gives none (the kernel's handler inputs). */
const HANDLER_INPUTS = { message: "cid", body: "cid", box: "string", sender: "identity" };

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
    programs.push({
      name, module,
      record: {
        kind: "program", name, code: { wasm: module },
        inputs: meta.inputs ?? HANDLER_INPUTS, services: meta.services ?? [], description: meta.description ?? `${name} (from the system tree)`,
      },
    });
  }
  const subscriptions = json<SubscriptionSpec[]>(SUBSCRIPTIONS);
  if (!Array.isArray(subscriptions)) throw new Error(`${SUBSCRIPTIONS}: missing, or not a list (a system tree names its subscriptions)`);
  for (const s of subscriptions) {
    if (!s || typeof s.box !== "string" || !s.box || typeof s.handler !== "string" || (s.sender !== undefined && typeof s.sender !== "string")) {
      throw new Error(`${SUBSCRIPTIONS}: bad entry ${JSON.stringify(s)} (want {sender?, box, handler})`);
    }
  }
  const config = json<ConfigSpec>(CONFIG) ?? {};
  if (config.defaults && Object.values(config.defaults).some((v) => typeof v !== "string")) throw new Error(`${CONFIG}: every default is a string`);
  const routes = json<RouteSpec[]>(ROUTES);
  if (routes !== undefined && !Array.isArray(routes)) throw new Error(`${ROUTES}: not a list`);
  const reads = json<ReadSpec[]>(READS);
  if (reads !== undefined && !Array.isArray(reads)) throw new Error(`${READS}: not a list`);
  return { root, objects: all.map(({ cid, bytes }) => ({ cid, bytes })), programs, modules, config, subscriptions, ...(routes ? { routes } : {}), ...(reads ? { reads } : {}) };
}

// ---------------------------------------------------------------- the loader

export type BootSource =
  /** No tree: the stock system in code (the live agents). */
  | { kind: "code" }
  /** A system tree whose objects are in `objects` (a scanned directory, a store, a verified packet). */
  | { kind: "tree"; root: CID; objects: Objects }
  /** A checkpoint (#30): the state record and every block it reaches, verified; restored, not replayed. */
  | { kind: "checkpoint"; state: CID; blocks: Array<{ cid: CID; bytes: Uint8Array }> };

export interface Booted { entry?: CID; tree?: CID; state?: CID; objects: number; programs: string[] }

/**
 * Boot an empty store through its kernel: pre-fill and write the genesis (a
 * tree, or the stock system), or restore a checkpoint. The kernel processes
 * the genesis when it starts (subscriptions; `main` → the tree).
 */
export async function boot(k: Kernel, src: BootSource, c: Genesis2Config, time: Stamp = clockNow()): Promise<Booted> {
  if (await k.store.log.tip()) throw new Error("the store already has a log: boot only into an empty store");
  if (src.kind === "checkpoint") {
    for (const b of src.blocks) await k.putBlock(b.cid, b.bytes);
    await k.restore(src.state);
    return { state: src.state, objects: src.blocks.length, programs: [] };
  }
  // A tree takes only the shell from the kernel: the other pinned records would sit in the store unreferenced (a replay would not reproduce them).
  const kernelPrograms = await k.call("programs", src.kind === "code" ? (c.mailbox ? ["frontdoor", "messagebox"] : undefined) : ["shell"]) as Record<string, CID>;
  if (src.kind === "code") {
    const entry = await writeSystemGenesis(k, c, codeSystem(c, kernelPrograms), time);
    return { entry, objects: 0, programs: Object.keys(kernelPrograms) };
  }
  const t = await readSystemTree(src.objects, src.root);
  let n = 0;
  for (const o of t.objects) if (!(await k.hasBlock(o.cid))) { await k.putBlock(o.cid, o.bytes); n++; }
  for (const m of t.modules) {
    if (m.bytes) { if (!(await k.hasBlock(m.cid))) { await k.putBlock(m.cid, m.bytes); n++; } }
    else if (!(await k.hasBlock(m.cid))) throw new Error(`incomplete: bin/${m.name}.cid names ${m.cid}, which neither the source nor the kernel holds`);
  }
  // The shell is the VM's own program (its modules are the kernel's); every handler comes from bin/.
  const programs: Record<string, CID> = { ...(kernelPrograms.shell ? { shell: kernelPrograms.shell } : {}) };
  for (const p of t.programs) programs[p.name] = await k.store.put(p.record as never);
  const s: System = resolveSystem(c, programs, t.subscriptions, t.config, t.root, t.routes, t.reads);
  const entry = await writeSystemGenesis(k, c, s, time);
  return { entry, tree: t.root, objects: n, programs: Object.keys(programs) };
}

/** The program records' CIDs a tree's bin/ yields (as `boot` puts them), without a kernel. */
export function programCid(record: Record<string, unknown>): CID { return encode(record).cid; }

/** The stock system as files (`skein-host system <dir>`): bin/*.cid + bin/*.json from the kernel's records, etc/. */
export async function stockSystemFiles(k: Kernel): Promise<Record<string, string>> {
  const programs = await k.call("programs") as Record<string, CID>;
  const files: Record<string, string> = {};
  for (const [name, cid] of Object.entries(programs)) {
    if (name === "shell") continue;
    const r = await k.store.get(cid) as unknown as { code: { wasm: CID }; inputs: unknown; services: string[]; description: string };
    files[`${BIN}/${name}.cid`] = `${r.code.wasm.toString()}\n`;
    files[`${BIN}/${name}.json`] = `${JSON.stringify({ inputs: r.inputs, services: r.services, description: r.description }, null, 2)}\n`;
  }
  const { DEFAULTS } = await import("../runtime/log.ts");
  const { STOCK_SUBSCRIPTIONS } = await import("./genesis.ts");
  files[CONFIG] = `${JSON.stringify({ defaults: DEFAULTS, collect: ["completions"] }, null, 2)}\n`;
  files[SUBSCRIPTIONS] = `${JSON.stringify(STOCK_SUBSCRIPTIONS, null, 2)}\n`;
  const { STOCK_ROUTES, STOCK_READS } = await import("./genesis.ts");
  files[ROUTES] = `${JSON.stringify(STOCK_ROUTES, null, 2)}\n`;
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

/** Source B: a packet file, verified (packet.ts) — a system tree to boot, or a checkpoint to restore. */
export async function packetSource(bytes: Uint8Array, o: import("./packet.ts").ReadOptions = {}): Promise<BootSource> {
  const { readPacket } = await import("./packet.ts");
  const v = await readPacket(bytes, o);
  return v.kind === "tree" ? { kind: "tree", root: v.scope, objects: v.blocks } : { kind: "checkpoint", state: v.scope, blocks: v.list };
}

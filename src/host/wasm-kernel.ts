// The host loads the machine (the settled split, 2026-10-31): the kernel as ONE
// wasm module (kernel-zig/zig-out/web/skein-kernel.wasm — the same zig source
// as the native binary), loaded in the host's own process: one machine per
// ACTIVE instance on a node worker thread (wasm-worker.ts), one step at a time
// on it, instances in parallel; an idle instance has no machine (the router's
// idle stop ends its worker: it is its set on disk). Storage is the host's:
// every instance a set of the host's one SQLite database (store-sqlite.ts);
// `instances.store` = `sqlite:<db path>` (the set: the handle).
//
// `WasmHost` is one per database per node process (acquired and released as
// `KernelHost` is): the compiled module, shared by every worker, and the host
// chain's holder — one more worker over the `host/chain` set, with no
// instance (#156: the header chain kept once; every instance reads it through
// the chain exception). `WasmKernel` is an instance's machine with the
// router's `KernelSurface`. The kernel's one blocking request, the signer
// (`wallet`), is answered here on the main thread through the instance's
// WalletWireProcessor (the wallet is asynchronous; the worker waits on a
// SharedArrayBuffer). There is no `http`: #157.

import { readFileSync } from "node:fs";
import { dirname, extname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { WalletWireProcessor } from "@bsv/sdk";
import type { CID } from "multiformats/cid";
import { decode, encode } from "../runtime/cid.ts";
import { CHAIN_SET, parseSqliteSpec } from "../runtime/index-store.ts";
import { Rejected } from "../runtime/store.ts";
import { hashTree } from "../runtime/tree.ts";
import { KernelSurface, type HostChainTip, type KernelOptions } from "./kernel.ts";
import { openHostDb, SqliteSetStore } from "./store-sqlite.ts";
import type { Outgoing } from "./providers.ts";

/** The set an image's chain part is put in for a host chain's import (#156), emptied after it. */
export const IMAGE_SET = "host/image";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolvePath(HERE, "../..");
/** The wasm kernel: $SKEIN_KERNEL_WASM, else kernel-zig's `zig build web` output (the package ships it there). */
export const KERNEL_WASM = process.env.SKEIN_KERNEL_WASM || join(ROOT, "kernel-zig/zig-out/web/skein-kernel.wasm");
/** The pinned modules (the boundary programs): $SKEIN_WASM_DIR, else the repo's (the package's) wasm/. */
export const WASM_DIR = process.env.SKEIN_WASM_DIR || join(ROOT, "wasm");
const WORKER = new URL(`./wasm-worker${extname(fileURLToPath(import.meta.url))}`, import.meta.url);

type Pending = { resolve(v: unknown): void; reject(e: Error): void };

/** One worker holding one machine: frames in, replies and the kernel's notices and requests out. */
class Machine {
  readonly worker: Worker;
  private nextId = 1;
  private waiting = new Map<number, Pending>();
  readonly ready: Promise<void>;
  readonly done: Promise<number>;
  gone = false;
  private control = new SharedArrayBuffer(12);
  private ctrl = new Int32Array(this.control);
  private data = new SharedArrayBuffer(1 << 16, { maxByteLength: 1 << 30 });

  constructor(module: WebAssembly.Module, w: { db: string; set: string; mode: "instance" | "chain"; network?: string }, o: { onNotify(op: string, v: Uint8Array): void; onRequest(op: string, v: Uint8Array): Promise<Uint8Array>; log?(line: string): void }) {
    this.worker = new Worker(WORKER, { workerData: { module, ...w, wasmDir: WASM_DIR, control: this.control, data: this.data } });
    let ready!: () => void, fail!: (e: Error) => void;
    this.ready = new Promise<void>((res, rej) => { ready = res; fail = rej; });
    this.ready.catch(() => {});
    this.worker.on("message", (m: { ready?: true; re?: number; frame?: Uint8Array; notify?: string; v?: Uint8Array; request?: string }) => {
      if (m.ready) return ready();
      if (m.re !== undefined) {
        const p = this.waiting.get(m.re);
        if (!p) return;
        this.waiting.delete(m.re);
        settle(p, decode<Record<string, unknown>>(m.frame!));
        return;
      }
      if (m.notify !== undefined) { try { o.onNotify(m.notify, m.v as Uint8Array); } catch (e) { o.log?.(`router: ${m.notify}: ${(e as Error).message}`); } return; }
      if (m.request !== undefined) {
        void (async () => {
          let status = 0, bytes: Uint8Array;
          try { bytes = await o.onRequest(m.request!, m.v!); } catch (e) { status = 1; bytes = new TextEncoder().encode((e as Error)?.message ?? String(e)); }
          if (bytes.length > this.data.byteLength) this.data.grow(bytes.length);
          new Uint8Array(this.data, 0, bytes.length).set(bytes);
          this.ctrl[1] = status;
          this.ctrl[2] = bytes.length;
          Atomics.store(this.ctrl, 0, 1);
          Atomics.notify(this.ctrl, 0);
        })();
      }
    });
    this.worker.on("error", (e: Error) => { o.log?.(`kernel worker: ${e.message}`); fail(e); });
    this.done = new Promise<number>((res) => this.worker.once("exit", (code) => {
      this.gone = true;
      for (const p of this.waiting.values()) p.reject(new Error(`the kernel's worker exited (${code})`));
      this.waiting.clear();
      fail(new Error(`the kernel's worker exited (${code}) before it was ready`));
      res(code);
    }));
  }

  call(op: string, v?: unknown): Promise<unknown> {
    if (this.gone) return Promise.reject(new Error("the kernel's worker is gone"));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ id, frame: encode({ op, v: v ?? null }).bytes });
    });
  }
}

function settle(p: Pending, f: Record<string, unknown>): void {
  if (typeof f.rejected === "string") p.reject(new Rejected(f.rejected as Rejected["reason"], String(f.error)));
  else if (typeof f.error === "string") p.reject(new Error(f.error));
  else p.resolve(f.ok);
}

export interface WasmHostOptions {
  /** The host's network for the header chain (SKEIN_NETWORK: main, test, regtest; default main). */
  network?: string;
  log?(line: string): void;
}

/** The host's machines over one SQLite database (one per database per node process: acquire/release). */
export class WasmHost {
  private static all = new Map<string, WasmHost>();
  private static compiled?: Promise<WebAssembly.Module>;

  /** The wasm kernel, compiled once per node process. */
  static module(): Promise<WebAssembly.Module> {
    WasmHost.compiled ??= WebAssembly.compile(readFileSync(KERNEL_WASM));
    return WasmHost.compiled;
  }

  static acquire(db: string, o: WasmHostOptions = {}): WasmHost {
    const key = resolvePath(db);
    let h = WasmHost.all.get(key);
    if (!h) { h = new WasmHost(key, o); WasmHost.all.set(key, h); }
    h.holders++;
    return h;
  }

  readonly db: string;
  readonly o: WasmHostOptions;
  private holders = 0;
  private views = new Map<string, WasmKernel>();
  private chain?: Promise<Machine>;
  private recent = new Map<string, Promise<HostChainTip>>();

  private constructor(db: string, o: WasmHostOptions) { this.db = db; this.o = o; }

  /** Hydrate an instance: its machine on a worker of its own (the store's pinned modules installed). */
  async open(o: KernelOptions): Promise<WasmKernel> {
    const p = parseSqliteSpec(o.db);
    if (!p) throw new Error(`kernel ${o.handle}: ${o.db} is not a SQLite set`);
    if (p.set !== o.handle) throw new Error(`kernel ${o.handle}: its SQLite set is its handle, not ${p.set}`);
    if (resolvePath(p.db) !== this.db) throw new Error(`kernel ${o.handle}: its database is ${p.db}, this host's ${this.db}`);
    // A machine being stopped (an idle stop, a restart): its next open waits for its worker to end (KernelHost's `closing`).
    const had = this.views.get(o.handle);
    if (had && !had.gone) {
      if (!had.stopping) throw new Error(`kernel ${o.handle}: open already`);
      await had.machine.done;
    }
    const k = new WasmKernel(this, o, await WasmHost.module());
    this.views.set(o.handle, k);
    try { await k.machine.ready; } catch (e) { this.views.delete(o.handle); throw e; }
    void k.machine.done.then(() => { if (this.views.get(o.handle) === k) this.views.delete(o.handle); });
    return k;
  }

  /** The host chain's holder (#156): a machine over the `host/chain` set, no instance. */
  private holder(): Promise<Machine> {
    this.chain ??= (async () => {
      const m = new Machine(await WasmHost.module(), { db: this.db, set: CHAIN_SET, mode: "chain", network: this.o.network ?? "main" }, {
        onNotify: (op, v) => { if (op === "say" || op === "panic") this.o.log?.(`host chain: ${String(v)}`); },
        onRequest: async (op) => { throw new Error(`the host chain asks no ${op}`); },
        log: this.o.log,
      });
      await m.ready;
      void m.done.then(() => { this.chain = undefined; });
      return m;
    })();
    return this.chain;
  }

  /**
   * #156: a run of headers into the host chain. The same run asked for again while it is in flight or
   * just answered (every instance on one feed asks for the same event) is one call: its answer shared.
   */
  chainHeaders(raws: Uint8Array[]): Promise<HostChainTip> {
    const key = raws.map((r) => Buffer.from(r).toString("hex")).join("");
    const had = this.recent.get(key);
    if (had) return had;
    const p = this.holder().then((m) => m.call("headers", { raws })).then(tipOf);
    this.recent.set(key, p);
    p.catch(() => this.recent.delete(key));
    while (this.recent.size > 64) this.recent.delete(this.recent.keys().next().value!);
    return p;
  }
  /** #156: an image's chain/headers (the tree `root`, whose blocks the set `set` holds) into the empty host chain. */
  async chainImport(set: string, root: CID): Promise<HostChainTip> { return tipOf(await (await this.holder()).call("chain-import", { set, root })); }
  /**
   * #156: an image's chain part (the `chain` tree and every object under it) into the EMPTY host
   * chain, as an instance born with it would bring it (`chain-import`): its objects put in a set of
   * their own (IMAGE_SET), a tree naming them `chain` as the root, the import, then that set's
   * members and the blocks no other set holds removed.
   */
  async importChain(chain: CID, objects: Array<[CID, Uint8Array]>): Promise<HostChainTip> {
    const db = openHostDb(this.db);
    try {
      const s = new SqliteSetStore(db, IMAGE_SET);
      const root = hashTree([{ mode: "40000", name: "chain", cid: chain }]);
      s.begin();
      for (const [cid, bytes] of objects) s.putBlock(cid.bytes, bytes);
      s.putBlock(root.cid.bytes, root.object);
      s.commit();
      try {
        return await this.chainImport(IMAGE_SET, root.cid);
      } finally {
        db.exec("BEGIN IMMEDIATE");
        try {
          // members has no index by cid: each object looked up in every other set by its key.
          const sets = (db.prepare(`SELECT DISTINCT "set" FROM members`).all() as Array<{ set: string }>).map((r) => r.set).filter((x) => x !== IMAGE_SET);
          const held = db.prepare(`SELECT 1 FROM members WHERE "set" = ? AND cid = ?`);
          const drop = db.prepare("DELETE FROM blocks WHERE cid = ?");
          for (const cid of [...objects.map(([c]) => c), root.cid]) if (!sets.some((x) => held.get(x, cid.bytes))) drop.run(cid.bytes);
          db.prepare(`DELETE FROM members WHERE "set" = ?`).run(IMAGE_SET);
          db.exec("COMMIT");
        } catch (e) { db.exec("ROLLBACK"); throw e; }
      }
    } finally { db.close(); }
  }
  /** #156: the host chain as it stands, or undefined (empty). */
  async chainTip(): Promise<HostChainTip | undefined> { const v = await (await this.holder()).call("chain"); return v == null ? undefined : tipOf(v); }

  /** One holder less; the last stops every machine. */
  async release(): Promise<void> {
    if (--this.holders > 0) return;
    WasmHost.all.delete(this.db);
    for (const k of [...this.views.values()]) await k.stop();
    const c = await this.chain?.catch(() => undefined);
    if (c && !c.gone) { await c.call("stop").catch(() => {}); await c.done; }
  }
}

function tipOf(v: unknown): HostChainTip {
  const o = v as { root: CID; height: number | bigint; hash: string; added?: number | bigint; replaced?: number | bigint };
  return { root: o.root, height: Number(o.height), hash: o.hash, ...(o.added !== undefined ? { added: Number(o.added) } : {}), ...(o.replaced !== undefined ? { replaced: Number(o.replaced) } : {}) };
}

/** One instance's machine, as the router holds it. */
export class WasmKernel extends KernelSurface {
  readonly o: KernelOptions;
  readonly host: WasmHost;
  readonly machine: Machine;
  private wire?: WalletWireProcessor;
  /** Its stop has begun (the next open of the handle waits for the worker to end). */
  stopping = false;

  constructor(host: WasmHost, o: KernelOptions, module: WebAssembly.Module) {
    super();
    this.host = host;
    this.o = o;
    if (o.wallet) this.wire = new WalletWireProcessor(o.wallet);
    const set = parseSqliteSpec(o.db)!;
    this.machine = new Machine(module, { db: set.db, set: set.set, mode: "instance" }, {
      onNotify: (op, v) => this.onNotify(op, v),
      onRequest: async (op, v) => {
        if (op !== "wallet") throw new Error(`this host answers no ${op}`);
        if (!this.wire) throw new Error("no wallet");
        this.busy++;
        // The request and its answer cross as dag-cbor (web.zig `request`: a byte string each way).
        try { return encode(Uint8Array.from(await this.wire.transmitToWallet([...decode<Uint8Array>(v)]))).bytes; } finally { this.busy--; this.last = Date.now(); }
      },
      log: o.log,
    });
    void this.machine.done.then((code) => { this.gone = true; o.exited?.(code, null); });
  }

  private onNotify(op: string, v: Uint8Array): void {
    if (op === "emit") { this.o.emit?.(decode<Outgoing>(v)); return; }
    if (op === "say" || op === "panic") this.o.log?.(String(v));
  }

  get pid(): number | undefined { return process.pid; }

  call(op: string, v?: unknown): Promise<unknown> {
    this.busy++;
    this.last = Date.now();
    return this.machine.call(op, v).finally(() => { this.busy--; this.last = Date.now(); });
  }

  async running(identity: string): Promise<void> {
    this.o.log?.(`skein runtime ${identity} (${this.o.handle}@${this.o.domain}) · wasm kernel, worker ${this.machine.worker.threadId} · db ${this.o.db}`);
  }

  /** #156: the host chain is the host's: its holder's. */
  override chainHeaders(raws: Uint8Array[]): Promise<HostChainTip> { return this.host.chainHeaders(raws); }
  override chainImport(root: CID): Promise<HostChainTip> { return this.host.chainImport(this.o.handle, root); }
  override chainTip(): Promise<HostChainTip | undefined> { return this.host.chainTip(); }

  /** Stop the machine: what its worker runs finishes, its store is closed, the worker ends. */
  async stop(): Promise<void> {
    if (this.gone || this.machine.gone) return;
    this.stopping = true;
    try { await this.machine.call("stop"); } catch { /* it exited */ }
    await this.machine.done;
  }

  exited(): Promise<void> { return this.machine.done.then(() => {}); }
}

// One instance's kernel as the router holds it (#33): a `skein-kernel serve`
// process spoken to over its stdin/stdout — length-prefixed dag-cbor frames
// (kernel-zig/src/ipc.zig). This is the kernel's whole surface:
//
//   the router asks      tip · get · put · has · putblock · restore · append · genesis · boxes · byEnvelope ·
//                        admit (the one call in that writes: a request as received, #68, a feed's or a
//                        proof's event) · answer (#66: wait on the thread a request entry launched; its answer once it
//                        comes to rest, or its state at the wait's bound) · call (#40: a program's function
//                        over the state, no entry, no writes: host-side reads only) · idle · start · running
//   the kernel asks      wallet (a BRC-100 wire frame → its answer: the signer, #67) · http (#126: one
//                        HTTP exchange for the kernel's authfetch — the kernel signs and verifies, this
//                        side moves the bytes: {method, url, headers, body, timeoutMs?} → {status,
//                        headers, body} | {error})
//   the kernel tells     emit (#70: a signed message for the host to carry out — {message, body,
//                        transport, address}, a `local` provider's or the libp2p node's, the answer
//                        coming back as an entry; #65: a broadcast event, transport `event`) · stop
//
// Nothing here keeps an instance's time (#69, #126): a step's deadline and a
// shell's sleep are `deadline` events the host's waker keeps.
//
// `Kernel` offers `store` (get/put/log), `admit`, `answer`, `invoke` (the call),
// `boxes`, `idle`. Log lines (stderr) go to `log`.
//
// Two ways to run kernels (#158): `Kernel` is one `skein-kernel serve`
// process per instance (a SQLite file or an LMDB set); `KernelHost` is the one
// `skein-kernel host` process of a host whose instances are sets of a RocksDB
// database (SKEIN_STORE_ROCKSDB), every frame tagged with the instance's
// handle `h`, and `HostedKernel` its per-instance view with the same surface
// (`KernelSurface`): hydrate = `open`, stop = `close`. The router holds either.

import type { DispatchRow } from "../runtime/dispatch.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { WalletWireProcessor, type WalletInterface } from "@bsv/sdk";
import type { CID } from "multiformats/cid";
import { decode, encode } from "../runtime/cid.ts";
import { parseLmdbSpec, parseRocksSpec } from "../runtime/index-store.ts";
import type { Entry } from "../runtime/log.ts";
import { NotFound, Rejected, type Store } from "../runtime/store.ts";
import type { Ms } from "../runtime/types.ts";
import type { HttpRequest, HttpResponse, Outgoing } from "./providers.ts";

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");
/** The kernel binary: $SKEIN_KERNEL_BIN, else kernel-zig's release build. */
export const KERNEL_BIN = process.env.SKEIN_KERNEL_BIN || join(ROOT, "kernel-zig/zig-out/bin/skein-kernel");

type Frame = Record<string, unknown>;
/** A request thread's answer (#66, the `answer` frame): at rest (finished | errored), or not yet at the wait's bound. */
export type RequestAnswer = { thread?: CID; state: "finished"; answer: Uint8Array } | { thread?: CID; state: "errored"; error: string } | { thread?: CID; state: "waiting" | "running" | "new" | "pending" };

export { DoorAnswered, doorAnswer, type DoorAnswer } from "./door-answer.ts";
import { DoorAnswered, doorAnswer } from "./door-answer.ts";
/** A kernel call's answer (#40): the program's stdout, or its error; the fuel it used either way. */
export type CallAnswer = { ok: true; result: Uint8Array; fuel: number } | { ok: false; error: string; fuel: number };

export interface KernelOptions {
  /** The store file, or a set of the host's LMDB environment, `lmdb:<env dir>#<handle>` (#96: the kernel gets SKEIN_STORE). */
  db: string;
  handle: string;
  domain: string;
  /** Answers the kernel's `wallet` frames: the instance's signer. Absent: every wallet call fails. */
  wallet?: WalletInterface;
  /** One HTTP exchange for the kernel's authfetch (#126): bytes only. Absent: the kernel's authfetch gets {error}. */
  http?(req: HttpRequest): Promise<HttpResponse>;
  /** A message (#70) or an event (#65) the kernel hands over to carry out (the `emit` notice): a `local` provider's, the libp2p node's, the broadcaster's (providers.ts). Absent: dropped. */
  emit?(o: Outgoing): void;
  /** Log lines (the kernel's stderr and this side's notes). */
  log?(line: string): void;
  /** The process exited (code or signal). */
  exited?(code: number | null, signal: string | null): void;
  /** Environment for the process, added to this one's. */
  env?: Record<string, string | undefined>;
  command?: string;
}

/**
 * What the router holds of an instance's kernel, whichever process runs it (#158): the frames
 * above, as calls. `call` is the transport's; the rest is built on it.
 */
export abstract class KernelSurface {
  abstract readonly o: KernelOptions;
  /** Pending calls in both directions: the router stops a kernel only when this is 0. */
  busy = 0;
  last = Date.now();
  gone = false;
  /** The kernel process's pid (a hosted instance's: the host process's). */
  abstract get pid(): number | undefined;
  abstract call(op: string, v?: unknown): Promise<unknown>;
  /** Print the ready line (`skein runtime <identity> (<handle>@<domain>) · pid …`). */
  abstract running(identity: string): Promise<void>;
  abstract stop(killAfterMs?: number): Promise<void>;
  abstract exited(): Promise<void>;

  readonly store = {
    get: async (cid: CID) => { const v = await this.call("get", cid); if (v === null || v === undefined) throw new NotFound(cid.toString()); return v; },
    put: async (value: unknown) => await this.call("put", value) as CID,
    has: async (cid: CID) => (await this.call("get", cid)) != null,
    log: {
      tip: async () => (await this.call("tip") as CID | null) ?? undefined,
      byEnvelope: async (envelope: CID) => (await this.call("byEnvelope", envelope) as CID | null) ?? undefined,
      append: async (entry: Entry) => await this.call("append", entry) as CID,
    },
  } as unknown as Store;

  /** Any block, whatever its codec. */
  async hasBlock(cid: CID): Promise<boolean> { return await this.call("has", cid) === true; }
  /** A block minted elsewhere (git-raw, raw, dag-cbor, bitcoin-*), hash-checked by the kernel (#4: the loader's pre-fill). */
  async putBlock(cid: CID, bytes: Uint8Array): Promise<void> { await this.call("putblock", { cid, bytes }); }
  /** Adopt a checkpoint's state record (its blocks put first) as this empty store's state (#4). */
  async restore(state: CID): Promise<void> { await this.call("restore", state); }
  async boxes(): Promise<string[]> { return await this.call("boxes") as string[]; }
  /** The dispatch table as it stands (#77): its chain's tip (the change key; null before the genesis is processed) and its rows. */
  async dispatch(): Promise<{ tip: CID | null; rows: DispatchRow[] }> { return await this.call("dispatch") as { tip: CID | null; rows: DispatchRow[] }; }
  async genesis(): Promise<Record<string, unknown>> { return await this.call("genesis") as Record<string, unknown>; }
  /**
   * Admit an entry; a request entry's record beside it (#121: the kernel puts it, after the door), else
   * put first. A request the door turns away or answers writes no entry (#143): DoorAnswered.
   */
  async admit(entry: Entry | Record<string, unknown>, records: { body?: Uint8Array; request?: Record<string, unknown> } = {}): Promise<CID> {
    const r = await this.call("admit", { entry, ...(records.body ? { body: records.body } : {}), ...(records.request ? { request: records.request } : {}) });
    const answered = (r as { answered?: Record<string, unknown> } | null)?.answered;
    if (answered && typeof answered === "object" && !(r instanceof Uint8Array)) throw new DoorAnswered(doorAnswer(answered));
    return r as CID;
  }
  /**
   * The kernel's `call` (#40): a program's function (by CID, or a genesis
   * program's name) over the current state — no entry, no writes, the signer
   * and http answered but not recorded; fuel-limited (`callFuelLimit`). The
   * result is what the program wrote to stdout; `fuel` is reported either way
   * (the router's ledger). On a hosted kernel (#158) it reads the state as
   * committed, beside a step that may be running.
   */
  async invoke(program: CID | string, fn: string, arg: Uint8Array, o: { caller?: Uint8Array; now?: number } = {}): Promise<CallAnswer> {
    return await this.call("call", { program, fn, arg, ...(o.caller ? { caller: o.caller } : {}), now: o.now ?? Date.now() }) as CallAnswer;
  }
  /**
   * A synchronous client's wait (#66): the answer of the thread a request
   * entry launched (the middleware stepped on it), once that thread has come
   * to rest for good — finished (`answer`: the middleware's dag-cbor answer)
   * or errored — or, `waitMs` on, its state as it stands (`waiting`; or
   * `pending`: the entry not processed yet). The kernel keeps the bound, so
   * this always settles.
   */
  async answer(entry: CID, waitMs: number): Promise<RequestAnswer> {
    return await this.call("answer", { entry, wait: Math.max(0, Math.floor(waitMs)) }) as RequestAnswer;
  }
  async idle(): Promise<void> { await this.call("idle"); }
  async start(): Promise<void> { await this.call("start"); }
  async tip(): Promise<CID | undefined> { return this.store.log.tip(); }
}

/**
 * The kernel's own request (`wallet`, `http`) or notice (`emit`, `stop`), answered for instance `o`
 * through `answer`/`fail` — the same for a serve process and a hosted instance.
 */
async function kernelRequest(k: KernelSurface, wire: WalletWireProcessor | undefined, f: Frame, answer: (ok: unknown) => void, fail: (e: unknown) => void): Promise<void> {
  const o = k.o;
  k.busy++;
  k.last = Date.now();
  try {
    switch (f.op) {
      case "wallet":
        if (!wire) throw new Error("no wallet");
        return answer(Uint8Array.from(await wire.transmitToWallet([...(f.v as Uint8Array)])));
      case "http": {
        // #126: authfetch's exchange; a failure to get any answer is the kernel's to record.
        const q = f.v as { method: string; url: string; headers?: Record<string, string>; body?: Uint8Array; timeoutMs?: number | bigint };
        if (!o.http) return answer({ error: "this host carries no HTTP for the kernel" });
        try {
          const r = await o.http({ method: q.method, url: q.url, headers: q.headers ?? {}, ...(q.body?.length ? { body: q.body } : {}), ...(q.timeoutMs !== undefined ? { timeoutMs: Number(q.timeoutMs) } : {}) });
          return answer({ status: r.status, headers: r.headers, body: r.body });
        } catch (e) {
          return answer({ error: (e as Error).message ?? String(e) });
        }
      }
      case "emit":
        // A signed message (#70) or an event (#65) to carry out, its step committed: nothing goes back.
        o.emit?.(f.v as Outgoing);
        return;
      case "stop": return;
    }
  } catch (e) {
    if (f.id !== undefined) fail(e);
    else o.log?.(`router: ${String(f.op)}: ${(e as Error).message}`);
  } finally {
    k.busy--;
    k.last = Date.now();
  }
}

/** Length-prefixed dag-cbor frames out of a byte stream (ipc.zig). */
class FrameReader {
  private buf = Buffer.alloc(0);
  private onFrame: (f: Frame) => void;
  constructor(onFrame: (f: Frame) => void) { this.onFrame = onFrame; }
  push(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 4) {
      const n = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + n) break;
      const f = decode<Frame>(this.buf.subarray(4, 4 + n));
      this.buf = this.buf.subarray(4 + n);
      this.onFrame(f);
    }
  }
}

function frameBytes(v: Frame): Buffer {
  const body = encode(v).bytes;
  const h = Buffer.alloc(4);
  h.writeUInt32BE(body.length);
  return Buffer.concat([h, body]);
}

/** Lines of a child's stderr, whole. */
function lines(stream: NodeJS.ReadableStream, each: (line: string) => void): void {
  let partial = "";
  stream.on("data", (d: Buffer) => {
    const s = partial + d.toString();
    const ls = s.split("\n");
    partial = ls.pop()!;
    for (const l of ls) each(l);
  });
}

export class Kernel extends KernelSurface {
  readonly o: KernelOptions;
  readonly proc: ChildProcess;
  private nextId = 1;
  private waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private reader: FrameReader;
  private wire?: WalletWireProcessor;
  private done: Promise<void>;

  constructor(o: KernelOptions) {
    super();
    this.o = o;
    if (o.wallet) this.wire = new WalletWireProcessor(o.wallet);
    if (parseRocksSpec(o.db)) throw new Error(`kernel ${o.handle}: a RocksDB set (${o.db}) runs in the host's one kernel process (KernelHost), not in serve`);
    // #96: an LMDB set's kernel gets SKEIN_STORE (its set is its handle); a file's gets SKEIN_DB and never a SKEIN_STORE.
    const env: Record<string, string | undefined> = { ...process.env, ...o.env, SKEIN_HANDLE: `${o.handle}@${o.domain}` };
    const lmdb = parseLmdbSpec(o.db);
    if (lmdb && lmdb.set !== o.handle) throw new Error(`kernel ${o.handle}: its LMDB set is its handle, not ${lmdb.set}`);
    if (lmdb) { env.SKEIN_STORE = lmdb.dir; delete env.SKEIN_DB; } else { env.SKEIN_DB = o.db; delete env.SKEIN_STORE; }
    this.proc = spawn(o.command ?? KERNEL_BIN, ["serve"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    lines(this.proc.stderr!, (l) => o.log?.(l));
    this.reader = new FrameReader((f) => void this.onFrame(f));
    this.proc.stdout!.on("data", (d: Buffer) => this.reader.push(d));
    this.proc.stdin!.on("error", () => {}); // EPIPE once it is gone
    this.done = new Promise((resolve) => this.proc.once("close", (code, signal) => {
      this.gone = true;
      for (const w of this.waiting.values()) w.reject(new Error(`kernel ${o.handle}: exited (${signal ?? code})`));
      this.waiting.clear();
      o.exited?.(code, signal);
      resolve();
    }));
    this.proc.on("error", (e) => o.log?.(`kernel: ${e.message}`));
  }

  get pid(): number | undefined { return this.proc.pid; }

  // ---------------------------------------------------------------- frames

  private write(v: Frame): void {
    if (this.gone) throw new Error(`kernel ${this.o.handle}: not running`);
    this.proc.stdin!.write(frameBytes(v));
  }

  call(op: string, v?: unknown): Promise<unknown> {
    const id = this.nextId++;
    this.busy++;
    this.last = Date.now();
    return new Promise<unknown>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      try { this.write({ id, op, v }); } catch (e) { this.waiting.delete(id); reject(e as Error); }
    }).finally(() => { this.busy--; this.last = Date.now(); });
  }

  private async onFrame(f: Frame): Promise<void> {
    if (typeof f.re === "number") {
      const w = this.waiting.get(f.re);
      if (!w) return;
      this.waiting.delete(f.re);
      settle(w, f);
      return;
    }
    // A process that is gone is reported by its exit; any other write failure (a frame that does not encode) is logged.
    const unwritten = (x: unknown) => { if (!this.gone) this.o.log?.(`the answer to the kernel's ${String(f.op)} frame not written: ${(x as Error).message ?? String(x)}`); };
    await kernelRequest(this, this.wire, f,
      (ok) => { try { this.write({ re: f.id, ok }); } catch (x) { unwritten(x); } },
      (e) => { try { this.write({ re: f.id, error: (e as Error).message ?? String(e) }); } catch (x) { unwritten(x); } });
  }

  /** Print the ready line (`skein runtime <identity> (<handle>@<domain>) · pid …`). */
  async running(identity: string): Promise<void> { this.write({ op: "running", v: identity }); }

  /** Close the channel; the kernel stops at EOF. SIGTERM after `killAfterMs`, SIGKILL after twice that. */
  async stop(killAfterMs = 10_000): Promise<void> {
    if (this.gone) return;
    this.proc.stdin!.end();
    const t = setTimeout(() => this.proc.kill("SIGTERM"), killAfterMs);
    const k = setTimeout(() => this.proc.kill("SIGKILL"), 2 * killAfterMs);
    await this.done;
    clearTimeout(t);
    clearTimeout(k);
  }

  exited(): Promise<void> { return this.done; }
}

function settle(w: { resolve(v: unknown): void; reject(e: Error): void }, f: Frame): void {
  if (typeof f.rejected === "string") w.reject(new Rejected(f.rejected as Rejected["reason"], String(f.error)));
  else if (typeof f.error === "string") w.reject(new Error(f.error));
  else w.resolve(f.ok);
}

// ---------------------------------------------------------------- the one-process kernel (#158)

export interface KernelHostOptions {
  command?: string;
  /** Environment for the process, added to this one's (SKEIN_WORKERS, SKEIN_HOME…). */
  env?: Record<string, string | undefined>;
  /** The process's own lines (not an instance's). */
  log?(line: string): void;
}

/**
 * The host's one `skein-kernel host` process over the RocksDB database at `dir` (#158): every
 * instance of the host in it, each a `HostedKernel`. One per database per node process
 * (`KernelHost.acquire`, counted: the routers and one-shot boots of a process share it; the last
 * `release` stops it). The process is started at acquire; if it dies, every instance's view is
 * gone (their `exited` called) and the next `open` starts it again (the router hydrates on demand,
 * replay at hydrate as for serve).
 */
export class KernelHost {
  private static all = new Map<string, KernelHost>();

  /** The process for the database at `dir`, started if this node process has none. */
  static acquire(dir: string, o: KernelHostOptions = {}): KernelHost {
    let h = KernelHost.all.get(dir);
    if (!h) { h = new KernelHost(dir, o); KernelHost.all.set(dir, h); }
    h.holders++;
    h.ensure();
    return h;
  }

  /** Whether this node process runs the kernel process for `dir` (stores.ts waits for its socket then). */
  static running(dir: string): boolean { const h = KernelHost.all.get(dir); return !!h?.proc && !h.dead; }

  readonly dir: string;
  readonly o: KernelHostOptions;
  proc?: ChildProcess;
  private holders = 0;
  private nextId = 1;
  private waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private views = new Map<string, HostedKernel>();
  /** A handle's close in flight: its next open waits for it. */
  private closing = new Map<string, Promise<unknown>>();
  private done?: Promise<void>;
  private dead = false;

  private constructor(dir: string, o: KernelHostOptions) { this.dir = dir; this.o = o; }

  private ensure(): void {
    if (this.proc && !this.dead) return;
    mkdirSync(this.dir, { recursive: true });
    const proc = spawn(this.o.command ?? KERNEL_BIN, ["host"], {
      env: { ...process.env, ...this.o.env, SKEIN_STORE_ROCKSDB: this.dir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    this.dead = false;
    lines(proc.stderr!, (l) => {
      // An instance's line: `@<handle> <line>` (host.zig sayFor) → that instance's log.
      const m = /^@(\S+) (.*)$/s.exec(l);
      const v = m ? this.views.get(m[1]!) : undefined;
      if (v) v.o.log?.(m![2]!);
      else this.o.log?.(l);
    });
    const reader = new FrameReader((f) => void this.onFrame(f));
    proc.stdout!.on("data", (d: Buffer) => reader.push(d));
    proc.stdin!.on("error", () => {});
    this.done = new Promise((resolve) => proc.once("close", (code, signal) => {
      this.dead = true;
      if (this.proc === proc) this.proc = undefined;
      if (code !== 0) this.o.log?.(`skein-kernel host exited (${signal ?? `code ${code}`})`);
      for (const w of this.waiting.values()) w.reject(new Error(`skein-kernel host: exited (${signal ?? code})`));
      this.waiting.clear();
      const views = [...this.views.values()];
      this.views.clear();
      this.closing.clear();
      for (const v of views) v.lost(code, signal);
      resolve();
    }));
    proc.on("error", (e) => this.o.log?.(`skein-kernel host: ${e.message}`));
  }

  private write(v: Frame): void {
    if (!this.proc || this.dead) throw new Error("skein-kernel host: not running");
    this.proc.stdin!.write(frameBytes(v));
  }

  /** A frame to the process (`h`: an instance's, else a host-level op) and its answer. */
  request(h: string | undefined, op: string, v?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      try { this.write({ id, op, ...(h !== undefined ? { h } : {}), v }); } catch (e) { this.waiting.delete(id); reject(e as Error); }
    });
  }

  /** A frame that wants no answer. */
  tell(h: string, op: string, v?: unknown): void { this.write({ op, h, v }); }

  private async onFrame(f: Frame): Promise<void> {
    if (typeof f.re === "number") {
      const w = this.waiting.get(f.re);
      if (!w) return;
      this.waiting.delete(f.re);
      settle(w, f);
      return;
    }
    const v = typeof f.h === "string" ? this.views.get(f.h) : undefined;
    const unwritten = (x: unknown) => { if (!this.dead) this.o.log?.(`the answer to the kernel's ${String(f.op)} frame not written: ${(x as Error).message ?? String(x)}`); };
    const answer = (ok: unknown) => { try { this.write({ re: f.id, ...(typeof f.h === "string" ? { h: f.h } : {}), ok }); } catch (x) { unwritten(x); } };
    const fail = (e: unknown) => { try { this.write({ re: f.id, ...(typeof f.h === "string" ? { h: f.h } : {}), error: (e as Error).message ?? String(e) }); } catch (x) { unwritten(x); } };
    if (!v) {
      if (f.op === "stop") return;
      if (f.id !== undefined) fail(new Error(`no instance ${String(f.h)} open here`));
      return;
    }
    await v.onKernelFrame(f, answer, fail);
  }

  /** Hydrate an instance (#158 `open`): its set opened in the process, its runtime built (replay at hydrate). */
  async open(o: KernelOptions): Promise<HostedKernel> {
    const p = parseRocksSpec(o.db);
    if (!p) throw new Error(`kernel ${o.handle}: ${o.db} is not a RocksDB set`);
    if (p.set !== o.handle) throw new Error(`kernel ${o.handle}: its RocksDB set is its handle, not ${p.set}`);
    if (p.dir !== this.dir) throw new Error(`kernel ${o.handle}: its database is ${p.dir}, this process's ${this.dir}`);
    await this.closing.get(o.handle)?.catch(() => {});
    if (this.views.has(o.handle)) throw new Error(`kernel ${o.handle}: open already`);
    this.ensure();
    const v = new HostedKernel(this, o);
    this.views.set(o.handle, v);
    try {
      await this.request(o.handle, "open", { domain: o.domain, db: o.db });
    } catch (e) {
      if (this.views.get(o.handle) === v) this.views.delete(o.handle);
      v.lost(null, null, true);
      throw e;
    }
    return v;
  }

  /** Dehydrate (#158 `close`): after its inbox drains, its runtime freed. */
  async close(v: HostedKernel): Promise<void> {
    if (this.views.get(v.o.handle) !== v) return;
    const p = this.request(v.o.handle, "close");
    this.closing.set(v.o.handle, p);
    try { await p; } finally {
      if (this.closing.get(v.o.handle) === p) this.closing.delete(v.o.handle);
      if (this.views.get(v.o.handle) === v) this.views.delete(v.o.handle);
    }
  }

  /** The instances open in the process (#158 `instances`). */
  async instances(): Promise<string[]> { return await this.request(undefined, "instances") as string[]; }
  /** The host reads (#158): a block by CID — through `set`'s gate if named, else whichever set holds it; a set's committed state pointer. */
  async get(cid: CID, set?: string): Promise<Uint8Array | undefined> { return (await this.hostRead("get", cid, set) as Uint8Array | null) ?? undefined; }
  async has(cid: CID, set?: string): Promise<boolean> { return await this.hostRead("has", cid, set) === true; }
  /** A host read, through `set`'s gate when one is named. */
  private hostRead(op: string, cid: CID, set?: string): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      try { this.write({ id, op, ...(set !== undefined ? { set } : {}), v: cid }); } catch (e) { this.waiting.delete(id); reject(e as Error); }
    });
  }
  async state(set: string): Promise<CID | undefined> { return (await this.request(set, "state") as CID | null) ?? undefined; }

  /** One holder less; the last one's release stops the process (every instance closed, the database flushed). */
  async release(): Promise<void> {
    if (--this.holders > 0) return;
    KernelHost.all.delete(this.dir);
    await this.shutdown();
  }

  /** `stop`: the process finishes what runs, closes every instance and the database, exits. */
  async shutdown(killAfterMs = 30_000): Promise<void> {
    const proc = this.proc;
    if (!proc || this.dead) return;
    const t = setTimeout(() => proc.kill("SIGTERM"), killAfterMs);
    const k = setTimeout(() => proc.kill("SIGKILL"), 2 * killAfterMs);
    try { await this.request(undefined, "stop"); } catch { /* it exited */ }
    proc.stdin!.end();
    await this.done;
    clearTimeout(t);
    clearTimeout(k);
  }

  /** Until the process has exited. */
  exited(): Promise<void> { return this.done ?? Promise.resolve(); }
}

/** One instance of the host's one kernel process (#158): the `Kernel` surface over frames tagged `h`. */
export class HostedKernel extends KernelSurface {
  readonly o: KernelOptions;
  readonly host: KernelHost;
  private wire?: WalletWireProcessor;
  private resolveDone!: () => void;
  private done = new Promise<void>((r) => { this.resolveDone = r; });

  constructor(host: KernelHost, o: KernelOptions) {
    super();
    this.host = host;
    this.o = o;
    if (o.wallet) this.wire = new WalletWireProcessor(o.wallet);
  }

  get pid(): number | undefined { return this.host.proc?.pid; }

  call(op: string, v?: unknown): Promise<unknown> {
    if (this.gone) return Promise.reject(new Error(`kernel ${this.o.handle}: not running`));
    this.busy++;
    this.last = Date.now();
    return this.host.request(this.o.handle, op, v).finally(() => { this.busy--; this.last = Date.now(); });
  }

  async onKernelFrame(f: Frame, answer: (ok: unknown) => void, fail: (e: unknown) => void): Promise<void> {
    await kernelRequest(this, this.wire, f, answer, fail);
  }

  async running(identity: string): Promise<void> { this.host.tell(this.o.handle, "running", identity); }

  /** Close the instance in the process (its inbox drained first); the process keeps running. */
  async stop(): Promise<void> {
    if (this.gone) return;
    try { await this.host.close(this); } catch (e) { this.o.log?.(`kernel: close: ${(e as Error).message}`); }
    this.lost(0, null);
  }

  /** Gone: closed, or the process exited (code/signal), or its open failed (`quiet`: no exited). */
  lost(code: number | null, signal: string | null, quiet = false): void {
    if (this.gone) return;
    this.gone = true;
    if (!quiet) this.o.exited?.(code, signal);
    this.resolveDone();
  }

  exited(): Promise<void> { return this.done; }
}

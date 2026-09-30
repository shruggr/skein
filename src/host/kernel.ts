// One instance's kernel as the router holds it (#33): a `skein-kernel serve`
// process spoken to over its stdin/stdout — length-prefixed dag-cbor frames
// (kernel-zig/src/ipc.zig). This is the kernel's whole surface:
//
//   the router asks      tip · get · put · has · putblock · restore · append · genesis · boxes · byEnvelope ·
//                        admit (the one call in that writes) · call (#40: a program's function over the
//                        state, no entry, no writes: the front door's) · idle · start · running
//   the kernel asks      wallet (a BRC-100 wire frame → its answer: the oracle) ·
//                        http (a program's request: the messagebox's delivery, a resolve, a wallet's ARC) ·
//                        libp2p (#51: {request, thread}: publish/dial/send/receive/close, the libp2p host's)
//                        — both answered {answer, attest} when the host attests (#62): its signature
//                        over the exchange, which the kernel records with the answer
//   the kernel tells     sleepers (its sleeping threads and their deadlines) · onSleep · stop
//
// `Kernel` offers `store` (get/put/log), `admit`, `invoke` (the call),
// `boxes`, `sleepersDue`/`onSleep`, `idle`. Log lines (stderr) go to `log`.

import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { WalletWireProcessor, type WalletInterface } from "@bsv/sdk";
import type { CID } from "multiformats/cid";
import { decode, encode } from "../runtime/cid.ts";
import type { LogEntry } from "../runtime/log.ts";
import { NotFound, Rejected, type Store } from "../runtime/store.ts";
import type { Ms } from "../runtime/types.ts";
import type { Attestation } from "../runtime/attest.ts";
import type { P2PRequest, P2PResult } from "./p2p.ts";

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");
/** The kernel binary: $SKEIN_KERNEL_BIN, else kernel-zig's release build. */
export const KERNEL_BIN = process.env.SKEIN_KERNEL_BIN || join(ROOT, "kernel-zig/zig-out/bin/skein-kernel");

type Frame = Record<string, unknown>;
/**
 * A program's HTTP request: the recorded-call shape of the preview1 `http` import and of wasi:http (#15, kernel-zig/src/http.zig).
 * `options` (wasi:http request-options, nanoseconds) is recorded with the request and applied by the host.
 */
export type HttpRequest = { method: string; url: string; headers?: Record<string, string>; body?: Uint8Array; options?: { connectTimeout?: number; firstByteTimeout?: number; betweenBytesTimeout?: number } };
export type HttpResponse = { status: number; headers: Record<string, string>; body: Uint8Array };
export interface Sleeper { thread: CID; until: Ms }
/** A kernel call's answer (#40): the program's stdout, or its error; the fuel it used either way. */
export type CallAnswer = { ok: true; result: Uint8Array; fuel: number } | { ok: false; error: string; fuel: number };

export interface KernelOptions {
  /** The store file. */
  db: string;
  handle: string;
  domain: string;
  /** Answers the kernel's `wallet` frames: the instance's oracle. Absent: every wallet call fails. */
  wallet?: WalletInterface;
  /** Answers programs' HTTP (the preview1 `http` import, #29, and wasi:http, #15 — one shape): a request {method, url, headers?, body?, options?} → {status, headers, body}. Absent: refused. */
  http?(req: HttpRequest): Promise<HttpResponse>;
  /** Answers programs' `libp2p` import (#51): a request {op, …} → its result ({error} on failure), recorded by the kernel. Absent: refused. */
  libp2p?(req: P2PRequest, thread?: CID): Promise<P2PResult>;
  /**
   * The host's attestation of an `http` or `libp2p` exchange (#62): the
   * request and response bytes as the kernel records them. Absent: answers go
   * unattested (a genesis that names an attest key then refuses them).
   */
  attest?(x: { op: "http" | "libp2p"; request: Uint8Array; response: Uint8Array }): Attestation;
  /** The kernel's sleepers changed (earliest first). */
  sleepers?(s: Sleeper[]): void;
  /** Log lines (the kernel's stderr and this side's notes). */
  log?(line: string): void;
  /** The process exited (code or signal). */
  exited?(code: number | null, signal: string | null): void;
  /** Environment for the process, added to this one's. */
  env?: Record<string, string | undefined>;
  command?: string;
}

export class Kernel {
  readonly o: KernelOptions;
  readonly proc: ChildProcess;
  private nextId = 1;
  private waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private buf = Buffer.alloc(0);
  private wire?: WalletWireProcessor;
  private done: Promise<void>;
  /** Pending calls in both directions: the router stops a kernel only when this is 0. */
  busy = 0;
  last = Date.now();
  gone = false;
  sleepers: Sleeper[] = [];
  onSleep?: (thread: CID, until: Ms) => void;
  /**
   * The front door's scratch table (#40, "sessions are not state"): the
   * instance's BRC-104 sessions, in memory for as long as this process runs
   * and never in the log. Opaque here (key → bytes, only the front door reads
   * them); a new process starts with an empty table, and a client whose
   * session is gone gets a 401 and shakes hands again.
   */
  readonly scratch = new Map<string, Uint8Array>();

  constructor(o: KernelOptions) {
    this.o = o;
    if (o.wallet) this.wire = new WalletWireProcessor(o.wallet);
    this.proc = spawn(o.command ?? KERNEL_BIN, ["serve"], {
      env: { ...process.env, ...o.env, SKEIN_DB: o.db, SKEIN_HANDLE: `${o.handle}@${o.domain}` },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let partial = "";
    this.proc.stderr!.on("data", (d: Buffer) => {
      const s = partial + d.toString();
      const ls = s.split("\n");
      partial = ls.pop()!;
      for (const l of ls) o.log?.(l);
    });
    this.proc.stdout!.on("data", (d: Buffer) => this.onData(d));
    this.proc.stdin!.on("error", () => {}); // EPIPE once it is gone
    this.done = new Promise((resolve) => this.proc.once("close", (code, signal) => {
      this.gone = true;
      this.scratch.clear();
      for (const w of this.waiting.values()) w.reject(new Error(`kernel ${o.handle}: exited (${signal ?? code})`));
      this.waiting.clear();
      o.exited?.(code, signal);
      resolve();
    }));
    this.proc.on("error", (e) => o.log?.(`kernel: ${e.message}`));
  }

  // ---------------------------------------------------------------- frames

  private write(v: Frame): void {
    if (this.gone) throw new Error(`kernel ${this.o.handle}: not running`);
    const body = encode(v).bytes;
    const h = Buffer.alloc(4);
    h.writeUInt32BE(body.length);
    this.proc.stdin!.write(Buffer.concat([h, body]));
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

  private onData(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 4) {
      const n = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + n) break;
      const f = decode<Frame>(this.buf.subarray(4, 4 + n));
      this.buf = this.buf.subarray(4 + n);
      void this.onFrame(f);
    }
  }

  private async onFrame(f: Frame): Promise<void> {
    if (typeof f.re === "number") {
      const w = this.waiting.get(f.re);
      if (!w) return;
      this.waiting.delete(f.re);
      if (typeof f.rejected === "string") w.reject(new Rejected(f.rejected as Rejected["reason"], String(f.error)));
      else if (typeof f.error === "string") w.reject(new Error(f.error));
      else w.resolve(f.ok);
      return;
    }
    const answer = (ok: unknown) => { try { this.write({ re: f.id, ok }); } catch { /* gone */ } };
    const fail = (e: unknown) => { try { this.write({ re: f.id, error: (e as Error).message ?? String(e) }); } catch { /* gone */ } };
    this.busy++;
    this.last = Date.now();
    try {
      switch (f.op) {
        case "wallet":
          if (!this.wire) throw new Error("no wallet");
          return answer(Uint8Array.from(await this.wire.transmitToWallet([...(f.v as Uint8Array)])));
        case "http": {
          // A program's http request (#29, pre-#15), recorded by the kernel with its answer.
          if (!this.o.http) throw new Error("this host answers no http");
          const res = await this.o.http(decode<HttpRequest>(f.v as Uint8Array));
          return answer(this.attested("http", f.v as Uint8Array, encode(res).bytes));
        }
        case "libp2p": {
          // A program's libp2p request (#51) and the thread making it (not recorded; the router needs it to wake a `receive`).
          if (!this.o.libp2p) throw new Error("this host answers no libp2p");
          const v = f.v as { request: Uint8Array; thread?: CID | null };
          const res = await this.o.libp2p(decode<P2PRequest>(v.request), v.thread ?? undefined);
          return answer(this.attested("libp2p", v.request, encode(res).bytes));
        }
        case "sleepers":
          this.sleepers = f.v as Sleeper[];
          this.o.sleepers?.(this.sleepers);
          return;
        case "onSleep": this.onSleep?.(undefined as never, 0); return;
        case "stop": return;
      }
    } catch (e) {
      if (f.id !== undefined) fail(e);
      else this.o.log?.(`router: ${String(f.op)}: ${(e as Error).message}`);
    } finally {
      this.busy--;
      this.last = Date.now();
    }
  }

  /** An answer as the kernel takes it: the bytes, with the host's attestation when it attests (#62). */
  private attested(op: "http" | "libp2p", request: Uint8Array, response: Uint8Array): Uint8Array | { answer: Uint8Array; attest: Attestation } {
    return this.o.attest ? { answer: response, attest: this.o.attest({ op, request, response }) } : response;
  }

  // ---------------------------------------------------------------- the runtime surface

  readonly store = {
    get: async (cid: CID) => { const v = await this.call("get", cid); if (v === null || v === undefined) throw new NotFound(cid.toString()); return v; },
    put: async (value: unknown) => await this.call("put", value) as CID,
    has: async (cid: CID) => (await this.call("get", cid)) != null,
    log: {
      tip: async () => (await this.call("tip") as CID | null) ?? undefined,
      byEnvelope: async (envelope: CID) => (await this.call("byEnvelope", envelope) as CID | null) ?? undefined,
      append: async (entry: LogEntry) => await this.call("append", entry) as CID,
    },
  } as unknown as Store;

  /** Any block, whatever its codec. */
  async hasBlock(cid: CID): Promise<boolean> { return await this.call("has", cid) === true; }
  /** A block minted elsewhere (git-raw, raw, dag-cbor, bitcoin-*), hash-checked by the kernel (#4: the loader's pre-fill). */
  async putBlock(cid: CID, bytes: Uint8Array): Promise<void> { await this.call("putblock", { cid, bytes }); }
  /** Adopt a checkpoint's state record (its blocks put first) as this empty store's state (#4). */
  async restore(state: CID): Promise<void> { await this.call("restore", state); }
  sleepersDue(): Sleeper[] { return this.sleepers; }
  async boxes(): Promise<string[]> { return await this.call("boxes") as string[]; }
  async genesis(): Promise<Record<string, unknown>> { return await this.call("genesis") as Record<string, unknown>; }
  /** Admit an entry (a message's record put first; its body's bytes beside it). */
  async admit(entry: LogEntry | Record<string, unknown>, records: { body?: Uint8Array } = {}): Promise<CID> {
    return await this.call("admit", { entry, ...(records.body ? { body: records.body } : {}) }) as CID;
  }
  /**
   * The kernel's `call` (#40): a program's function (by CID, or a genesis
   * program's name) over the current state — no entry, no writes, the oracle
   * and http answered but not recorded; fuel-limited (`callFuelLimit`). The
   * result is what the program wrote to stdout; `fuel` is reported either way
   * (the router's ledger).
   */
  async invoke(program: CID | string, fn: string, arg: Uint8Array, o: { caller?: Uint8Array; now?: number } = {}): Promise<CallAnswer> {
    return await this.call("call", { program, fn, arg, ...(o.caller ? { caller: o.caller } : {}), now: o.now ?? Date.now() }) as CallAnswer;
  }
  async idle(): Promise<void> { await this.call("idle"); }
  async start(): Promise<void> { await this.call("start"); }
  async tip(): Promise<CID | undefined> { return this.store.log.tip(); }
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

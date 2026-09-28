// One instance's kernel as the router holds it (#33): a `skein-kernel serve`
// process spoken to over its stdin/stdout — length-prefixed dag-cbor frames
// (kernel-zig/src/ipc.zig). This is the kernel's whole surface:
//
//   the router asks      tip · get · put · append · genesis · boxes · byEnvelope ·
//                        admit (the one call in) · idle · start · running
//   the kernel asks      wallet (a BRC-100 wire frame → its answer: the oracle) ·
//                        resolve (handle, domain → a Resolution)
//   the kernel tells     send (an emit, once its step is recorded) · sleepers (its
//                        sleeping threads and their deadlines) · onSleep · stop
//
// `Kernel` offers the part of the TS Runtime the host's providers use
// (entry.ts, tick.ts, messagebox.ts): `store` (get/put/log), `admit`,
// `boxes`, `sleepersDue`/`onSleep`, `idle`, `outbox`. Log lines (stderr)
// go to `log`.

import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { WalletWireProcessor, type WalletInterface } from "@bsv/sdk";
import type { CID } from "multiformats/cid";
import { decode, encode } from "../runtime/cid.ts";
import type { LogEntry } from "../runtime/log.ts";
import type { Outbound } from "../runtime/scheduler.ts";
import { NotFound, Rejected, type Store } from "../runtime/store.ts";
import type { Ms } from "../runtime/types.ts";

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");
/** The kernel binary: $SKEIN_KERNEL_BIN, else kernel-zig's release build. */
export const KERNEL_BIN = process.env.SKEIN_KERNEL_BIN || join(ROOT, "kernel-zig/zig-out/bin/skein-kernel");

type Frame = Record<string, unknown>;
export interface Sleeper { thread: CID; until: Ms }

export interface KernelOptions {
  /** The store file. */
  db: string;
  handle: string;
  domain: string;
  /** Answers the kernel's `wallet` frames: the instance's oracle. Absent: every wallet call fails. */
  wallet?: WalletInterface;
  /** Answers `resolve`: the whole Resolution, `identityKey: ""` (plus `error`) when unknown. */
  resolve?(handle: string, domain: string): Promise<Record<string, unknown>>;
  /** An emit to carry (after its step is recorded). */
  send?(o: Outbound): void | Promise<void>;
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
  outbox?: { send(o: Outbound): void | Promise<void> };

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
        case "resolve": {
          const { handle, domain } = f.v as { handle: string; domain: string };
          let r: Record<string, unknown>;
          try {
            r = this.o.resolve ? await this.o.resolve(handle, domain) : { identityKey: "", error: "no resolver" };
          } catch (e) { r = { identityKey: "", error: (e as Error).message }; }
          return answer(decode(encode(r).bytes)); // dag-cbor as recorded (undefined dropped)
        }
        case "send": {
          const o = f.v as Outbound;
          if (this.outbox) await this.outbox.send(o);
          else await this.o.send?.(o);
          return;
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

  sleepersDue(): Sleeper[] { return this.sleepers; }
  async boxes(): Promise<string[]> { return await this.call("boxes") as string[]; }
  async genesis(): Promise<Record<string, unknown>> { return await this.call("genesis") as Record<string, unknown>; }
  async admit(entry: LogEntry | Record<string, unknown>, records: { envelope?: object; body?: Uint8Array } = {}): Promise<CID> {
    return await this.call("admit", { entry, envelope: records.envelope, body: records.body }) as CID;
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

// One instance's kernel as the router holds it (#33): a `skein-kernel serve`
// process spoken to over its stdin/stdout — length-prefixed dag-cbor frames
// (kernel-zig/src/ipc.zig). This is the kernel's whole surface:
//
//   the router asks      tip · get · put · has · putblock · restore · append · genesis · boxes · byEnvelope ·
//                        admit (the one call in that writes: a request as received, #68, a feed's or a
//                        proof's event; answered with the entry and, #130, the fuel of the door's
//                        `verify` call, the host's to attest) · answer (#66: wait on the thread a request entry launched; its answer once it
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

import type { DispatchRow } from "../runtime/dispatch.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { WalletWireProcessor, type WalletInterface } from "@bsv/sdk";
import type { CID } from "multiformats/cid";
import { decode, encode } from "../runtime/cid.ts";
import type { Entry } from "../runtime/log.ts";
import { NotFound, Rejected, type Store } from "../runtime/store.ts";
import type { Ms } from "../runtime/types.ts";
import type { HttpRequest, HttpResponse, Outgoing } from "./providers.ts";

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");
/** The kernel binary: $SKEIN_KERNEL_BIN, else kernel-zig's release build. */
export const KERNEL_BIN = process.env.SKEIN_KERNEL_BIN || join(ROOT, "kernel-zig/zig-out/bin/skein-kernel");

type Frame = Record<string, unknown>;
/** A request thread's answer (#66, the `answer` frame): at rest (finished | errored), or not yet at the wait's bound. */
export type RequestAnswer = { thread?: CID; state: "finished"; answer: Uint8Array } | { thread?: CID; state: "errored"; error: string } | { thread?: CID; state: "waiting" | "running" | "new" | "pending" }
  /** #121: refused at the door — the entry is a refusal ({stage, reason, status, code?}) and nothing ran. */
  | { thread?: undefined; state: "refused"; refused: Refusal };
/** A refusal entry's `refused` (#121): the door's stage, why, and the status the transport answers with. */
export interface Refusal { stage: "middleware" | "filter"; reason: string; status?: number; code?: string }
/** A kernel call's answer (#40): the program's stdout, or its error; the fuel it used either way. */
export type CallAnswer = { ok: true; result: Uint8Array; fuel: number } | { ok: false; error: string; fuel: number };

export interface KernelOptions {
  /** The store file. */
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
  /**
   * #130: what rides on the next admission — the host's attestation of its external cost
   * (billing.ts), when it has some — and, once the kernel answered, whether the entry went in
   * (`done(true)`: the period is reported; `done(false)`: it is owed again).
   */
  attest?(): Promise<{ value: Record<string, unknown>; done(ok: boolean): void } | undefined>;
  /** #130: an entry admitted, and the fuel of the door's `verify` call on it (the host's external cost). */
  admitted?(entry: CID, doorFuel: number): void;
  /** Environment for the process, added to this one's. */
  env?: Record<string, string | undefined>;
  command?: string;
}

export class Kernel {
  readonly o: KernelOptions;
  readonly proc: ChildProcess;
  private nextId = 1;
  private waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; whole?: boolean }>();
  private buf = Buffer.alloc(0);
  private wire?: WalletWireProcessor;
  private done: Promise<void>;
  /** Pending calls in both directions: the router stops a kernel only when this is 0. */
  busy = 0;
  last = Date.now();
  gone = false;

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

  call(op: string, v?: unknown, whole = false): Promise<unknown> {
    const id = this.nextId++;
    this.busy++;
    this.last = Date.now();
    return new Promise<unknown>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject, whole });
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
      else w.resolve(w.whole ? f : f.ok);
      return;
    }
    // A process that is gone is reported by its exit; any other write failure (a frame that does not encode) is logged.
    const unwritten = (x: unknown) => { if (!this.gone) this.o.log?.(`the answer to the kernel's ${String(f.op)} frame not written: ${(x as Error).message ?? String(x)}`); };
    const answer = (ok: unknown) => { try { this.write({ re: f.id, ok }); } catch (x) { unwritten(x); } };
    const fail = (e: unknown) => { try { this.write({ re: f.id, error: (e as Error).message ?? String(e) }); } catch (x) { unwritten(x); } };
    this.busy++;
    this.last = Date.now();
    try {
      switch (f.op) {
        case "wallet":
          if (!this.wire) throw new Error("no wallet");
          return answer(Uint8Array.from(await this.wire.transmitToWallet([...(f.v as Uint8Array)])));
        case "http": {
          // #126: authfetch's exchange; a failure to get any answer is the kernel's to record.
          const q = f.v as { method: string; url: string; headers?: Record<string, string>; body?: Uint8Array; timeoutMs?: number | bigint };
          if (!this.o.http) return answer({ error: "this host carries no HTTP for the kernel" });
          try {
            const r = await this.o.http({ method: q.method, url: q.url, headers: q.headers ?? {}, ...(q.body?.length ? { body: q.body } : {}), ...(q.timeoutMs !== undefined ? { timeoutMs: Number(q.timeoutMs) } : {}) });
            return answer({ status: r.status, headers: r.headers, body: r.body });
          } catch (e) {
            return answer({ error: (e as Error).message ?? String(e) });
          }
        }
        case "emit":
          // A signed message (#70) or an event (#65) to carry out, its step committed: nothing goes back.
          this.o.emit?.(f.v as Outgoing);
          return;
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
   * put first. #130: the host's attestation rides on it when it has one (`attest`), and the door's
   * `verify` fuel the kernel answers with goes to `admitted`.
   */
  async admit(entry: Entry | Record<string, unknown>, records: { body?: Uint8Array; request?: Record<string, unknown> } = {}): Promise<CID> {
    const a = await this.o.attest?.();
    let f: { ok: CID; fuel?: number | bigint };
    try {
      f = await this.call("admit", { entry: a ? { ...entry, attest: a.value } : entry, ...(records.body ? { body: records.body } : {}), ...(records.request ? { request: records.request } : {}) }, true) as typeof f;
    } catch (e) {
      a?.done(false);
      throw e;
    }
    a?.done(true);
    this.o.admitted?.(f.ok, Number(f.fuel ?? 0));
    return f.ok;
  }
  /**
   * The kernel's `call` (#40): a program's function (by CID, or a genesis
   * program's name) over the current state — no entry, no writes, the signer
   * and http answered but not recorded; fuel-limited (`callFuelLimit`). The
   * result is what the program wrote to stdout; `fuel` is reported either way
   * (the router's ledger).
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

// `skein-host run` as a supervisor (#23, "a process per instance"): each
// instance is its own OS process — `bin/skein-runtime` (main.ts, the same
// kernel configuration a single instance runs), one per enabled host.db row,
// with the row in its environment. Nothing is shared in-process between
// instances; host.db (which each child reads, read-only, for its resolver),
// the host wallet and the messagebox are the only common things, and each is
// reached over its own interface.
//
// The supervisor starts every child, prefixes each line it writes with
// `[handle]`, restarts a child that exits (after a backoff: base, doubling to
// max; a child that ran at least `stableMs` starts again at base), and stops
// them all with SIGTERM (SIGKILL after `killAfterMs`). A child is `ready` once
// it prints `skein runtime <identity> …`: the supervisor records that
// identity in the row if the row has none, and starts the row's explorer
// (`bin/skein-explore <port>` over the row's store, read-only), supervised
// the same way. Children talk to it over an IPC channel only so that they
// stop when it is gone (main.ts: `disconnect`).

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

export interface ChildSpec {
  /** The line prefix, e.g. `martha` or `martha explore`. */
  name: string;
  command: string;
  args?: string[];
  /** Added to the supervisor's own environment. */
  env?: Record<string, string | undefined>;
}

export interface Backoff { baseMs: number; maxMs: number; stableMs: number }
export const DEFAULT_BACKOFF: Backoff = { baseMs: 1000, maxMs: 60_000, stableMs: 30_000 };

export interface SupervisorOptions {
  out(line: string): void;
  err?(line: string): void;
  backoff?: Partial<Backoff>;
  /** SIGKILL a child still running this long after SIGTERM. Default 10 s. */
  killAfterMs?: number;
}

type Settings = Required<Pick<SupervisorOptions, "out" | "err">> & { backoff: Backoff; killAfterMs: number };

/** One supervised process: restarted when it exits, until stopped. */
export class Supervised {
  readonly spec: ChildSpec;
  proc?: ChildProcess;
  /** Times it was started again after exiting. */
  restarts = 0;
  /** Its `skein runtime <identity>` line was seen since it last started. */
  ready = false;
  identity?: string;
  lastExit?: { code: number | null; signal: string | null };
  private startedAt = 0;
  private delay: number;
  private timer?: ReturnType<typeof setTimeout>;
  private stopping = false;
  private exited?: Promise<void>;
  private readonly o: Settings;
  private readonly onLine?: (line: string, s: Supervised) => void;

  constructor(spec: ChildSpec, o: Settings, onLine?: (line: string, s: Supervised) => void) {
    this.spec = spec;
    this.o = o;
    this.onLine = onLine;
    this.delay = o.backoff.baseMs;
  }

  get pid(): number | undefined { return this.proc?.exitCode === null && this.proc.signalCode === null ? this.proc.pid : undefined; }
  get running(): boolean { return this.pid !== undefined; }

  start(): void {
    if (this.stopping) return;
    const p = spawn(this.spec.command, this.spec.args ?? [], {
      env: { ...process.env, ...this.spec.env },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.proc = p;
    this.ready = false;
    this.startedAt = Date.now();
    const tag = `[${this.spec.name}]`;
    createInterface({ input: p.stdout! }).on("line", (l) => { this.o.out(`${tag} ${l}`); this.line(l); });
    createInterface({ input: p.stderr! }).on("line", (l) => this.o.err(`${tag} ${l}`));
    p.on("error", (e) => this.o.err(`${tag} ${e.message}`)); // could not spawn: "close" follows
    this.exited = new Promise((resolve) => p.once("close", (code, signal) => {
      this.ready = false;
      this.lastExit = { code, signal };
      resolve();
      if (this.stopping) return;
      const ran = Date.now() - this.startedAt;
      if (ran >= this.o.backoff.stableMs) this.delay = this.o.backoff.baseMs;
      this.o.err(`${tag} exited (${signal ?? `code ${code}`}) after ${ran} ms; again in ${this.delay} ms`);
      this.timer = setTimeout(() => { this.restarts++; this.start(); }, this.delay);
      this.delay = Math.min(this.o.backoff.maxMs, this.delay * 2);
    }));
  }

  private line(l: string): void {
    const m = /^skein runtime (0[23][0-9a-f]{64}) /.exec(l);
    if (m) { this.ready = true; this.identity = m[1]; }
    this.onLine?.(l, this);
  }

  /** No more restarts; SIGTERM, then SIGKILL if it lingers. Resolves once it has exited. */
  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    const p = this.proc;
    if (!p || p.exitCode !== null || p.signalCode !== null) return;
    p.kill("SIGTERM");
    const kill = setTimeout(() => p.kill("SIGKILL"), this.o.killAfterMs);
    await this.exited;
    clearTimeout(kill);
  }
}

export class Supervisor {
  readonly children: Supervised[] = [];
  private readonly o: Settings;

  constructor(o: SupervisorOptions) {
    this.o = { out: o.out, err: o.err ?? o.out, backoff: { ...DEFAULT_BACKOFF, ...o.backoff }, killAfterMs: o.killAfterMs ?? 10_000 };
  }

  /** Start a child and keep it running. `onLine` sees each stdout line (unprefixed). */
  add(spec: ChildSpec, onLine?: (line: string, s: Supervised) => void): Supervised {
    const s = new Supervised(spec, this.o, onLine);
    this.children.push(s);
    s.start();
    return s;
  }

  /** Stop every child, all at once. */
  async stop(): Promise<void> {
    await Promise.all(this.children.map((c) => c.stop()));
  }
}

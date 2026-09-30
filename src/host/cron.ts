// Jobs (#60): the router is the clock. "Cron is a time attestation that a
// subscription routes to whatever waits for it" (docs/VM.md): an instance's
// genesis declares its jobs (etc/config.json `jobs`, carried like `feeds`),
//
//   {box, body?: <map>, every: <ms> | at: <ms since the epoch>, name?}
//
// and when one is due the router admits a **plain event** into its box —
// the same admission as a feed's header or a broadcaster's status
// (Router.admitEvent): a sender-less `event` entry, stamped by the router at
// admission (that stamp is the attestation). The event record is
//
//   {...body, kind: body.kind ?? "cron", name?, due: <ms>}
//
// `due` is when the firing was scheduled; the entry's stamp is when it was
// admitted. An `every` job fires once when the router first declares it (its
// boot: `skein-host run` hydrates every enabled instance at start), then every
// `every` ms on that grid; a firing the router was too late for is not made
// up (one firing, then the next grid point after now): after a host restart a
// job fires once, never a burst. An `at` job fires once — at `at`, or at the
// next boot if the host was down then — and host.db remembers it fired
// (`cron_fired`), so a restart does not fire it again.
//
// A job of a running instance is admitted as it is. An idle-stopped instance
// is hydrated for a job only if its subscriptions route a sender-less event
// in the job's box somewhere (a job is a reason to wake an instance, like
// mail); otherwise nothing is admitted — there is nothing to wake for. A
// program takes the event as its start signal and carries on with `deadline`
// wakes; the next `every` firing is its retry if its thread died.

import { createHash } from "node:crypto";
import * as dagCbor from "@ipld/dag-cbor";

/** A job as a system writes it (etc/config.json `jobs`) and a genesis carries it. */
export interface JobSpec { box: string; body?: Record<string, unknown>; every?: number; at?: number; name?: string }

const SHAPE = "want {box, body?: {…}, every: <ms> | at: <ms since the epoch>, name?}";

/** A system's jobs, checked (genesis.ts resolveSystem): a malformed one is an error in etc/config.json. */
export function jobsIn(js: unknown): { jobs?: JobSpec[] } {
  if (js === undefined) return {};
  if (!Array.isArray(js)) throw new Error("etc/config.json: jobs is a list");
  const out: JobSpec[] = [];
  for (const j of js as unknown[]) {
    const why = badJob(j);
    if (why) throw new Error(`etc/config.json: a job ${why} (${SHAPE}): ${JSON.stringify(j)}`);
    out.push(clean(j as JobSpec));
  }
  return out.length ? { jobs: out } : {};
}

/** The jobs a genesis carries; malformed ones left out. */
export function jobsOf(g: Record<string, unknown> | null | undefined): JobSpec[] {
  const js = g?.jobs;
  if (!Array.isArray(js)) return [];
  return (js as unknown[]).filter((j) => !badJob(j)).map((j) => clean(j as JobSpec));
}

function badJob(j: unknown): string | undefined {
  const o = j as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || Array.isArray(o)) return "is not an object";
  if (typeof o.box !== "string" || !o.box) return "names no box";
  if ((o.every === undefined) === (o.at === undefined)) return "has neither or both of every and at";
  if (o.every !== undefined && !(Number.isSafeInteger(o.every) && (o.every as number) > 0)) return "has an every that is not a positive whole number of ms";
  if (o.at !== undefined && !(Number.isSafeInteger(o.at) && (o.at as number) >= 0)) return "has an at that is not a whole number of ms since the epoch";
  if (o.name !== undefined && typeof o.name !== "string") return "has a name that is not a string";
  if (o.body !== undefined && (!o.body || typeof o.body !== "object" || Array.isArray(o.body) || o.body instanceof Uint8Array)) return "has a body that is not a map";
  return undefined;
}

const clean = (j: JobSpec): JobSpec => ({
  box: j.box, ...(j.body !== undefined ? { body: j.body } : {}), ...(j.every !== undefined ? { every: j.every } : { at: j.at }), ...(j.name !== undefined ? { name: j.name } : {}),
});

/** A job's identity: the same spec is the same job across declarations and restarts (a changed one is another). */
export function jobKey(j: JobSpec): string {
  return createHash("sha256").update(dagCbor.encode(clean(j))).digest("hex");
}

/** The event record a firing admits. */
export function cronEvent(j: JobSpec, due: number): Record<string, unknown> {
  const body = j.body ?? {};
  return { ...body, kind: body.kind ?? "cron", ...(j.name !== undefined ? { name: j.name } : {}), due };
}

/** How a job is described in log lines. */
const label = (j: JobSpec) => j.name ?? `${j.box} ${j.every !== undefined ? `every ${j.every} ms` : `at ${new Date(j.at!).toISOString()}`}`;

export interface CronOptions {
  /** The clock (ms): the router's. */
  now(): number;
  /** Admit a plain event into `handle`'s box (Router.admitEvent: it hydrates); the entry's CID. */
  admit(handle: string, box: string, event: Record<string, unknown>): Promise<unknown>;
  /** Whether `handle`'s kernel is running, stopped (an enabled row, idle), or gone (no enabled row: its jobs are dropped). */
  state(handle: string): "running" | "stopped" | "gone";
  /** Whether a stopped instance's subscriptions route a sender-less event in `box` to a handler. */
  subscribed(handle: string, box: string): Promise<boolean>;
  /** `at` jobs that already fired (host.db `cron_fired`). */
  fired: { has(handle: string, key: string): boolean; mark(handle: string, key: string, due: number): void };
  log?(source: string, line: string): void;
  /** An `at` job whose admission failed is tried again this much later (ms; default 60 000). */
  retryMs?: number;
}

interface Scheduled { job: JobSpec; key: string; next: number }

/** setTimeout's longest delay; a job further off is looked at again then. */
const MAX_DELAY = 2 ** 31 - 1;

export class Cron {
  readonly o: CronOptions;
  private jobs = new Map<string, Map<string, Scheduled>>();
  private timer?: ReturnType<typeof setTimeout>;
  private ticking: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(o: CronOptions) { this.o = o; }

  private say(source: string, line: string): void { this.o.log?.(source, line); }

  /**
   * `handle`'s jobs are these (its genesis's, at hydration). A job it already
   * had keeps its schedule (a re-hydration after an idle stop is not a boot);
   * a new `every` job is due now; an `at` job at `at`, unless it fired.
   */
  declare(handle: string, specs: JobSpec[]): void {
    if (this.stopped) return;
    const had = this.jobs.get(handle);
    const now = this.o.now();
    const m = new Map<string, Scheduled>();
    for (const job of specs) {
      const key = jobKey(job);
      if (m.has(key)) continue;
      const old = had?.get(key);
      if (old) m.set(key, old);
      else if (job.at !== undefined) { if (!this.o.fired.has(handle, key)) m.set(key, { job, key, next: job.at }); }
      else m.set(key, { job, key, next: now });
    }
    if (m.size) this.jobs.set(handle, m);
    else this.jobs.delete(handle);
    this.schedule();
  }

  /** `handle`'s jobs and when each fires next (the host page, tests). */
  of(handle: string): Array<{ job: JobSpec; next: number }> {
    return [...this.jobs.get(handle)?.values() ?? []].map(({ job, next }) => ({ job, next }));
  }

  /** Fire every job that is due (one pass at a time); then wait for the next. */
  tick(): Promise<void> {
    this.ticking = this.ticking.then(() => this.fire()).catch((e) => this.say("router", `cron: ${(e as Error).message}`));
    return this.ticking;
  }

  /** No more firings; resolves once a pass under way has finished. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.ticking;
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopped) return;
    let next = Infinity;
    for (const m of this.jobs.values()) for (const s of m.values()) next = Math.min(next, s.next);
    if (next === Infinity) return;
    this.timer = setTimeout(() => void this.tick(), Math.min(MAX_DELAY, Math.max(0, next - this.o.now()) + 1));
  }

  private async fire(): Promise<void> {
    if (this.stopped) return;
    for (const [handle, m] of [...this.jobs]) {
      for (const s of [...m.values()]) {
        if (this.stopped) return;
        const now = this.o.now();
        if (s.next > now) continue;
        const state = this.o.state(handle);
        if (state === "gone") { this.jobs.delete(handle); break; }
        const due = s.next;
        const { job } = s;
        // The next firing first: the grid point after now (one firing however late this one is).
        if (job.every !== undefined) s.next = due + (Math.floor((now - due) / job.every) + 1) * job.every;
        else m.delete(s.key);
        if (state === "stopped" && !(await this.o.subscribed(handle, job.box).catch(() => false))) {
          if (job.at !== undefined) this.o.fired.mark(handle, s.key, due);
          this.say(handle, `cron: ${label(job)} due: stopped, and nothing in it subscribes ${job.box}: not woken`);
          continue;
        }
        try {
          const e = await this.o.admit(handle, job.box, cronEvent(job, due));
          if (job.at !== undefined) this.o.fired.mark(handle, s.key, due);
          this.say(handle, `cron: ${label(job)} → ${job.box} as ${String(e).slice(-8)}${state === "stopped" ? " (woken for it)" : ""}`);
        } catch (e) {
          this.say(handle, `cron: ${label(job)}: not admitted: ${(e as Error).message}`);
          if (job.at !== undefined && !this.stopped) m.set(s.key, { ...s, next: now + (this.o.retryMs ?? 60_000) });
        }
      }
      if (!m.size && this.jobs.get(handle) === m) this.jobs.delete(handle);
    }
    this.schedule();
  }
}

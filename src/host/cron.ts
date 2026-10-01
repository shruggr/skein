// The cron provider (#69): scheduling is a message to a provider. A program
// that wants to be ticked emits, to the cron provider's key (the address
// book's entry with role `cron`), box `cron`:
//
//   {fn: "tick", every: <ms> | at: <ms since the epoch>, box, body?: {…}, name}
//   {fn: "stop", name}
//
// and the provider answers it ({replyTo, name, next: <ms>} | {replyTo, name,
// stopped: true | false} | {replyTo, error}), then sends each tick as a signed
// message from its own identity into the named box of the instance that
// asked:
//
//   {...body, kind: body.kind ?? "cron", name, due: <ms>}
//
// routed there by the instance's subscription to that box (sender the cron
// provider, or anyone). `due` is when the tick was scheduled; the message's
// entry stamp is when it arrived. A tick request replaces the instance's
// schedule of the same name; `stop` ends it. An `every` schedule ticks at
// once, then every `every` ms on that grid; a tick the provider was too
// late for is not made up (one tick, then the next grid point after now). An
// `at` schedule ticks once — at `at`, or at once if that is past — and is
// then gone. The schedules are the provider's state, kept across restarts
// (the reference host: host.db `cron_schedule`); at a host start every
// `every` schedule ticks once (a restart is a late tick), each `at` one at
// its time.
//
// This module is the schedule itself (`Cron`): the provider on the reference
// host (providers.ts, its ticks appended as `local` requests) and a remote
// cron service (src/peers/cron.ts, its ticks delivered to the instance's
// messagebox over BRC-103/104) both run it. Which one an instance talks to
// is its address book's business: the same key, `local` or `mailbox`.

import * as dagCbor from "@ipld/dag-cbor";

/** A tick request's schedule: every `every` ms, or once at `at`, into `box`. */
export interface TickSpec { every?: number; at?: number; box: string; body?: Record<string, unknown> }

/** One schedule: whose (the instance the ticks go to, its key), its name and spec, the request that made it, the next tick. */
export interface Schedule extends TickSpec { instance: string; recipient: string; name: string; request: string; next: number }

/** A request the cron provider takes (box `cron`), checked; an error's text otherwise. */
export type CronRequest = { fn: "tick"; name: string; spec: TickSpec } | { fn: "stop"; name: string };

export const CRON_SHAPE = "the cron provider takes {fn: \"tick\", every: <ms> | at: <ms since the epoch>, box, body?: {…}, name} or {fn: \"stop\", name} in box \"cron\"";

/** A body as the cron provider reads it. */
export function cronRequestOf(b: unknown): CronRequest | string {
  const o = b as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || Array.isArray(o) || o instanceof Uint8Array) return CRON_SHAPE;
  if (typeof o.name !== "string" || !o.name) return `${CRON_SHAPE}: a request names its schedule (name)`;
  if (o.fn === "stop") return { fn: "stop", name: o.name };
  if (o.fn !== "tick") return CRON_SHAPE;
  if (typeof o.box !== "string" || !o.box || o.box.startsWith(":")) return `${CRON_SHAPE}: box is a box name (not empty, not reserved)`;
  if ((o.every === undefined) === (o.at === undefined)) return `${CRON_SHAPE}: one of every and at`;
  if (o.every !== undefined && !(Number.isSafeInteger(o.every) && (o.every as number) > 0)) return `${CRON_SHAPE}: every is a positive whole number of ms`;
  if (o.at !== undefined && !(Number.isSafeInteger(o.at) && (o.at as number) >= 0)) return `${CRON_SHAPE}: at is a whole number of ms since the epoch`;
  if (o.body !== undefined && (!o.body || typeof o.body !== "object" || Array.isArray(o.body) || o.body instanceof Uint8Array)) return `${CRON_SHAPE}: body is a map`;
  return { fn: "tick", name: o.name, spec: { box: o.box, ...(o.every !== undefined ? { every: o.every as number } : { at: o.at as number }), ...(o.body !== undefined ? { body: o.body as Record<string, unknown> } : {}) } };
}

/** A tick's body. */
export function tickBody(s: Pick<Schedule, "name" | "body">, due: number): Record<string, unknown> {
  const body = s.body ?? {};
  return { ...body, kind: body.kind ?? "cron", name: s.name, due };
}

/** How a schedule is described in log lines. */
const label = (s: Pick<Schedule, "name" | "box" | "every" | "at">) => `${s.name} (${s.box} ${s.every !== undefined ? `every ${s.every} ms` : `at ${new Date(s.at!).toISOString()}`})`;

/** Where schedules are kept (the reference host: host.db; a test or a remote service: memory). */
export interface ScheduleStore {
  all(): Schedule[];
  save(s: Schedule): void;
  drop(instance: string, name: string): void;
}

/** A store in memory. */
export function memorySchedules(): ScheduleStore {
  const m = new Map<string, Schedule>();
  return {
    all: () => [...m.values()],
    save: (s) => { m.set(`${s.instance}\0${s.name}`, { ...s }); },
    drop: (i, n) => { m.delete(`${i}\0${n}`); },
  };
}

/** host.db's `cron_schedule` as a ScheduleStore (the spec as dag-cbor). */
export function dbSchedules(db: {
  saveSchedule(s: { instance: string; name: string; recipient: string; spec: Uint8Array; request: string; next: number }): void;
  dropSchedule(instance: string, name: string): boolean;
  schedules(): Array<{ instance: string; name: string; recipient: string; spec: Uint8Array; request: string; next: number }>;
}): ScheduleStore {
  return {
    all: () => db.schedules().map((r) => ({ instance: r.instance, name: r.name, recipient: r.recipient, request: r.request, next: r.next, ...(dagCbor.decode(r.spec) as TickSpec) })),
    save: (s) => db.saveSchedule({ instance: s.instance, name: s.name, recipient: s.recipient, request: s.request, next: s.next, spec: dagCbor.encode({ box: s.box, ...(s.every !== undefined ? { every: s.every } : { at: s.at }), ...(s.body !== undefined ? { body: s.body } : {}) }) }),
    drop: (i, n) => { db.dropSchedule(i, n); },
  };
}

export interface CronOptions {
  /** The clock (ms). */
  now(): number;
  /** Send one tick: a signed message from the provider to `s.recipient` in `s.box`. Throws if it could not go (an `at` tick is tried again). */
  tick(s: Schedule, body: Record<string, unknown>): Promise<void>;
  /** Whether the instance should be woken for a tick (the reference host: running, or something in it subscribes the box); default yes. */
  wake?(s: Schedule): Promise<boolean>;
  /** Where the schedules are kept (default memory). */
  store?: ScheduleStore;
  log?(source: string, line: string): void;
  /** An `at` tick that could not go is tried again this much later (ms; default 60 000). */
  retryMs?: number;
}

/** setTimeout's longest delay; a tick further off is looked at again then. */
const MAX_DELAY = 2 ** 31 - 1;

export class Cron {
  readonly o: CronOptions;
  private readonly store: ScheduleStore;
  private timer?: ReturnType<typeof setTimeout>;
  private ticking: Promise<void> = Promise.resolve();
  private stopped = false;
  /** Whether this one sends ticks (start): a schedule asked of one that does not is kept for one that does. */
  private started = false;

  constructor(o: CronOptions) {
    this.o = o;
    this.store = o.store ?? memorySchedules();
  }

  private say(source: string, line: string): void { this.o.log?.(source, line); }

  /** Take up the kept schedules (a host start): each `every` one ticks once now (late), each `at` one at its time. */
  start(): void {
    this.started = true;
    const now = this.o.now();
    for (const s of this.store.all()) if (s.every !== undefined && s.next > now) this.store.save({ ...s, next: now });
    this.schedule();
  }

  /**
   * A request from `instance` (whose key is `recipient`), the message
   * `request`: → the answer body (beside `replyTo`). A tick request replaces
   * the schedule of its name; stop ends it.
   */
  request(instance: string, recipient: string, request: string, body: unknown): Record<string, unknown> {
    if (this.stopped) return { error: "the cron provider is stopping" };
    const r = cronRequestOf(body);
    if (typeof r === "string") return { error: r };
    if (r.fn === "stop") {
      const had = this.store.all().some((s) => s.instance === instance && s.name === r.name);
      this.store.drop(instance, r.name);
      this.say(instance, `cron: ${r.name} stopped${had ? "" : " (it was not scheduled)"}`);
      this.schedule();
      return { name: r.name, stopped: had };
    }
    const next = r.spec.at !== undefined ? r.spec.at : this.o.now();
    const s: Schedule = { instance, recipient, name: r.name, request, next, ...r.spec };
    this.store.save(s);
    this.say(instance, `cron: ${label(s)} scheduled, next ${new Date(next).toISOString()}`);
    this.schedule();
    return { name: r.name, next };
  }

  /** `instance`'s schedules and when each ticks next (the host page, tests). */
  of(instance: string): Schedule[] {
    return this.store.all().filter((s) => s.instance === instance);
  }

  /** Drop every schedule of an instance that is gone. */
  forget(instance: string): void {
    for (const s of this.of(instance)) this.store.drop(instance, s.name);
    this.schedule();
  }

  /** Send every tick that is due (one pass at a time); then wait for the next. */
  tick(): Promise<void> {
    this.ticking = this.ticking.then(() => this.fire()).catch((e) => this.say("router", `cron: ${(e as Error).message}`));
    return this.ticking;
  }

  /** No more ticks; resolves once a pass under way has finished. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.ticking;
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopped || !this.started) return;
    let next = Infinity;
    for (const s of this.store.all()) next = Math.min(next, s.next);
    if (next === Infinity) return;
    this.timer = setTimeout(() => void this.tick(), Math.min(MAX_DELAY, Math.max(0, next - this.o.now()) + 1));
  }

  private async fire(): Promise<void> {
    if (this.stopped) return;
    for (const s of this.store.all()) {
      if (this.stopped) return;
      const now = this.o.now();
      if (s.next > now) continue;
      const due = s.next;
      // The next tick first: the grid point after now (one tick however late this one is); an `at` one is done.
      if (s.every !== undefined) this.store.save({ ...s, next: due + (Math.floor((now - due) / s.every) + 1) * s.every });
      else this.store.drop(s.instance, s.name);
      if (this.o.wake && !(await this.o.wake(s).catch(() => false))) {
        this.say(s.instance, `cron: ${label(s)} due: stopped, and nothing in it subscribes ${s.box}: not woken`);
        continue;
      }
      try {
        await this.o.tick(s, tickBody(s, due));
        this.say(s.instance, `cron: ${label(s)} → ${s.box}`);
      } catch (e) {
        this.say(s.instance, `cron: ${label(s)}: not sent: ${(e as Error).message}`);
        if (s.at !== undefined && !this.stopped) this.store.save({ ...s, next: now + (this.o.retryMs ?? 60_000) });
      }
    }
    this.schedule();
  }
}

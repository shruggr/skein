// One scheduler, two triggers: wake(thread) events and a timer. Each pass
// offers every unfinished thread to its runner and applies the answer as a
// thread update. No queue: a refused start leaves the tip untouched and the
// thread is offered again next pass. See docs/MODEL.md "Scheduler and runners".

import type { CID } from "multiformats/cid";
import type { Store } from "./store.ts";
import type { ThreadOrigin, ThreadUpdate } from "./types.ts";
import type { Runner, RunnerContext, Status } from "./runners/types.ts";
import { compact, emit, isSettled, nonce, rest, short, stamp, statusOf, tipOf } from "./runners/util.ts";

export interface SchedulerOptions {
  tickMs?: number;
  log?: (line: string) => void;
}

export class Scheduler {
  readonly store: Store;
  readonly ctx: RunnerContext;
  private readonly runners = new Map<string, Runner>();
  private readonly tickMs: number;
  private readonly log: (line: string) => void;
  private timer?: ReturnType<typeof setInterval>;
  private started = false;
  private ticking?: Promise<void>;
  private again = false;
  private soon = false;
  private readonly pending = new Map<string, CID>();
  private push?: (thread: CID) => void; // set during a pass: wakes join the current pass

  constructor(store: Store, runners: Runner[], opts: SchedulerOptions = {}) {
    this.store = store;
    for (const r of runners) this.runners.set(r.kind, r);
    this.tickMs = opts.tickMs ?? 1000;
    this.log = opts.log ?? ((l) => console.log(l));
    this.ctx = {
      store,
      now: stamp,
      launch: async ({ runner, spec, tag }, launchedBy) => {
        const thread = await store.chains.open(compact({ kind: "thread", runner, spec, launchedBy, at: stamp(), nonce: nonce() }) as ThreadOrigin);
        if (launchedBy) await emit(store, launchedBy, compact({ type: "launched", thread, ...tag }));
        this.say(`${short(thread)} ${runner} launched${launchedBy ? ` by ${short(launchedBy)}` : ""}`);
        this.wake(thread);
        return thread;
      },
      emit: (node, e) => emit(store, node, e),
      rest: (node, r) => rest(store, node, r),
      update: (thread, status) => this.apply(thread, status),
      wake: (thread) => this.wake(thread),
      log: (line) => this.say(line),
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    void this.tick();
  }

  async stop(): Promise<void> {
    this.started = false;
    clearInterval(this.timer);
    await this.ticking;
  }

  wake(thread: CID): void {
    if (this.push) return this.push(thread);
    this.pending.set(thread.toString(), thread);
    if (this.ticking) this.again = true;
    else if (this.started && !this.soon) {
      this.soon = true;
      setImmediate(() => { this.soon = false; void this.tick(); });
    }
  }

  /** One pass (more if woken mid-pass). Concurrent calls share the in-flight pass. */
  tick(): Promise<void> {
    if (this.ticking) { this.again = true; return this.ticking; }
    this.ticking = (async () => {
      try {
        do { this.again = false; await this.pass(); } while (this.again);
      } catch (e) {
        this.say(`scheduler pass failed: ${(e as Error).stack ?? e}`);
      } finally {
        this.ticking = undefined;
      }
    })();
    return this.ticking;
  }

  private async pass(): Promise<void> {
    const queue: CID[] = [];
    const queued = new Set<string>();
    const push = (t: CID) => {
      const k = t.toString();
      if (!queued.has(k)) { queued.add(k); queue.push(t); }
    };
    for (const t of this.pending.values()) push(t);
    this.pending.clear();
    for await (const t of this.store.live.resting()) push(t);
    this.push = push;
    try {
      // A thread may be revisited in one pass if something it waits on settles after its visit.
      for (let budget = 10_000; queue.length && budget > 0; budget--) {
        const t = queue.shift()!;
        queued.delete(t.toString());
        await this.visit(t);
      }
    } finally {
      this.push = undefined;
    }
  }

  private async visit(thread: CID): Promise<void> {
    let origin: ThreadOrigin;
    try { origin = await this.store.get<ThreadOrigin>(thread); } catch { return; }
    if (origin.kind !== "thread") return;
    const tip = await tipOf(this.store, thread);
    if (tip && isSettled(tip.state)) return this.wakeWaiters(thread); // e.g. resolved from outside (resolveDavid)
    const runner = this.runners.get(origin.runner);
    if (!runner) return;
    try {
      if (!tip) await runner.start(thread, this.ctx);
      else if (tip.state === "running") await this.apply(thread, await runner.check(thread, this.ctx));
      else if (tip.state === "waiting" && (await this.ready(tip))) await runner.start(thread, this.ctx);
    } catch (e) {
      // A runner bug must not wedge the pass; the thread records it and its waiters move on.
      await this.apply(thread, { state: "errored", error: { kind: "blew-up", message: `runner ${origin.runner} threw: ${(e as Error).message}` } });
    }
  }

  private async ready(tip: ThreadUpdate): Promise<boolean> {
    if (tip.until !== undefined && tip.until <= Date.now()) return true;
    if (!tip.waitingOn?.length) return false;
    for (const w of tip.waitingOn) if (!isSettled((await tipOf(this.store, w))?.state)) return false;
    return true;
  }

  private async apply(thread: CID, status: Status): Promise<void> {
    const before = await tipOf(this.store, thread);
    if (before && same(statusOf(before), status)) return;
    await this.store.chains.append(thread, compact({ ...status }) as Record<string, unknown>);
    const origin = await this.store.get<ThreadOrigin>(thread);
    const detail = [
      status.waitingOn?.length ? `on ${status.waitingOn.map(short).join(",")}` : "",
      status.until !== undefined ? `until ${new Date(status.until).toISOString()}` : "",
      status.error ? `${status.error.kind}: ${status.error.message}` : "",
      status.note ?? "",
    ].filter(Boolean).join(" · ");
    this.say(`${short(thread)} ${origin.runner} ${before?.state ?? "new"} → ${status.state}${detail ? ` (${detail})` : ""}`);
    if (isSettled(status.state)) await this.wakeWaiters(thread);
  }

  private async wakeWaiters(thread: CID): Promise<void> {
    for await (const w of this.store.live.waitersOn(thread)) this.wake(w);
  }

  private say(line: string): void {
    this.log(`${new Date().toISOString().slice(11, 23)} ${line}`);
  }
}

function same(a: Status, b: Status): boolean {
  const ids = (x?: CID[]) => (x ?? []).map(String).join(",");
  return a.state === b.state && ids(a.waitingOn) === ids(b.waitingOn) && a.until === b.until
    && String(a.resolution) === String(b.resolution) && a.error?.message === b.error?.message
    && a.error?.kind === b.error?.kind && (b.note === undefined || a.note === b.note);
}

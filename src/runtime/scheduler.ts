// The scheduler: the log consumer (docs/ARCH.md, "The kernel"). One loop:
//
//   for each log entry after the cursor, in order:
//     wake the sleeping threads whose deadline the entry's stamp has reached;
//     apply admin configuration (subscriptions) it carries;
//     route its message by the subscriptions as of this point in the log —
//       a program CID launches a thread {program, args, launchedBy, input};
//       no match: recorded, nothing runs;
//     step each thread it touches until it rests or ends;
//     emit the outbound messages they produced (via the outbox);
//   then advance the cursor.
//
// Time and randomness are pure (syscalls.ts): a thread's clock is the stamp of
// the entry currently driving it plus 1 ns per read, and its random stream is
// keyed by that entry and the thread. A sleep past "now" rests the thread
// (`waiting`, `until`) with its wasm instance parked (JSPI); the promise is the
// thread's only handle. Nothing about the handle is durable: on start, every
// thread that is running or waiting is re-executed from its origin. Its records
// already exist, so re-execution *verifies* rather than appends — each update
// it would write is recomputed and must equal the one in its chain (same CID;
// otherwise the run diverged and the thread stops) — and a wake the chain
// records is replayed on the spot. A sleeper whose wake was not yet recorded
// rests again and is woken by the loop, exactly as without a restart.
//
// Determinism: every record the runtime writes carries `input` (the entry
// whose processing wrote it) and `at` = that entry's message time. Nothing
// here reads a clock or a random source. A fresh runtime fed the same log
// (messages and stamps) with the same wallet reproduces every chain.

import type { CID } from "multiformats/cid";
import { encode, isCID } from "./cid.ts";
import { identityOf, rootIdentity, signerFor, type KeyWallet, type Signer } from "./identity.ts";
import { admit, isLogEntry, NAMES, now as clockNow, short, type LogEntry } from "./log.ts";
import { isShellArgs, loadShellModules, SHELL_CID } from "./programs.ts";
import { isGenesis, matches, signMessage, subscriptionIn, type Message, type Subscription } from "./records.ts";
import { runShell } from "./shell.ts";
import { Rejected, type Store } from "./store.ts";
import { entropy, stampNs, ThreadClock, type Stamp } from "./syscalls.ts";
import type { Ms, Ref, ThreadOrigin, ThreadState, ThreadUpdate } from "./types.ts";

/** Where outbound messages go. The transport; tests may capture. */
export interface Outbox { send(m: Message): void }

export interface RuntimeOptions {
  store: Store;
  wallet: KeyWallet;
  outbox?: Outbox;
  /** One line per transition. Default: nowhere. */
  log?: (line: string) => void;
  /** The clock admission stamps entries with. Default: log.ts's wall clock. Tests pass a script. */
  now?: () => Stamp;
}

/** A recomputed record differs from the one already stored: replay is not reproducing the run. */
export class Diverged extends Error {}
class Stopped extends Error {}

interface Ctx { input: CID; at: Ms }

interface Deferred { promise: Promise<void>; resolve(): void }
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/** A thread with a live instance: its handle. Transient by design. */
class Live {
  readonly origin: CID;
  readonly o: ThreadOrigin;
  readonly history: CID[];   // the chain's updates as stored; re-execution verifies against these
  pos = 0;                   // index into history of the next update
  ctx!: Ctx;
  state: ThreadState | "new" = "new";
  step: Deferred = deferred();
  readonly clock = new ThreadClock();
  random!: (len: number) => Uint8Array;
  wake?: () => void;
  deadline?: bigint;         // ns, while sleeping
  constructor(origin: CID, o: ThreadOrigin, history: CID[]) {
    this.origin = origin;
    this.o = o;
    this.history = history;
  }
  /** Now driven by `entry`: its stamp is the clock's floor, its CID keys the random stream. */
  drive(entry: CID, e: LogEntry, at: Ms): void {
    this.ctx = { input: entry, at };
    this.clock.drive(stampNs(e.time));
    this.random = entropy(entry, this.origin);
  }
}

export class Runtime {
  readonly store: Store;
  readonly wallet: KeyWallet;
  outbox?: Outbox;
  private readonly say: (line: string) => void;
  private readonly now: () => Stamp;

  identity = "";              // the runtime's own: signs results
  admin = "";
  private signer!: Signer;
  private readonly subs: Subscription[] = [];
  private readonly names = new Map<string, string>();
  private readonly live = new Map<string, Live>();         // thread origin → handle
  private readonly sleepers = new Map<string, Live>();     // thread origin → a live thread resting on a deadline
  private seq = 0;
  private cursor = 0;
  private started = false;
  private stopped = false;
  private draining?: Promise<void>;
  private again = false;

  constructor(o: RuntimeOptions) {
    this.store = o.store;
    this.wallet = o.wallet;
    this.outbox = o.outbox;
    this.say = o.log ?? (() => {});
    this.now = o.now ?? clockNow;
  }

  /** The instance's current state hash: the log's tip entry. */
  tip(): Promise<CID | undefined> { return this.store.log.tip(); }

  /** Entries processed so far. */
  get processed(): number { return this.cursor; }

  /** Threads resting on a deadline: while there are any, main.ts admits ticks so they see time pass. */
  get sleeping(): number { return this.sleepers.size; }

  // ------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    const w = this.wallet;
    this.signer = await signerFor(w, NAMES.runtime);
    this.identity = this.signer.identity;
    this.admin = await identityOf(w, NAMES.admin);
    for (const n of Object.values(NAMES)) this.names.set(await identityOf(w, n), n);
    this.names.set(await rootIdentity(w), "root");

    this.seq = await this.nextSeq(this.identity);
    this.cursor = await this.store.live.cursor.get();
    for await (const { entry } of this.store.log.entries()) {
      if (entry.n >= this.cursor) break;
      this.configure(await this.store.get<Message>(entry.message));
    }
    this.say(`runtime ${short(this.identity)} · log ${this.cursor} processed · seq ${this.seq}`);

    // Re-execute threads whose handles died with the last process.
    const resume: CID[] = [];
    for await (const t of this.store.live.resting()) {
      const tip = await this.tipOf(t);
      if (!tip || tip.state === "running" || tip.state === "waiting") resume.push(t);
    }
    this.started = true;
    for (const t of resume) {
      this.say(`${short(t)} re-executing from its origin`);
      await this.run(t);
    }
    this.kick();
  }

  /** Stop consuming and drop every live handle. The store is left as is; a new Runtime re-executes. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.draining?.catch(() => {});
    for (const t of this.live.values()) t.step.resolve();
    this.live.clear();
    this.sleepers.clear();
  }

  /** Settles once every admitted entry has been processed. */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  /** Verify, store, stamp and log an inbound message, and schedule processing. Returns its log entry. */
  async admit(m: Message): Promise<CID> {
    const entry = await admit(this.store, m, this.now());
    this.kick();
    return entry;
  }

  /** The next seq the store will accept from `identity` (for a peer's welcome, or a tick). */
  async nextSeq(identity: string): Promise<number> {
    let max = -1;
    for await (const c of this.store.edges.query({ kind: "message", from: identity })) max = Math.max(max, (await this.store.get<Message>(c)).seq);
    return max + 1;
  }

  nameOf(identity: string): string { return this.names.get(identity) ?? identity.slice(0, 10); }

  // ------------------------------------------------------------ the loop

  private kick(): void {
    if (!this.started || this.stopped) return;
    if (this.draining) { this.again = true; return; }
    this.draining = this.drain()
      .catch((e) => this.say(`runtime: ${(e as Error).stack ?? e}`))
      .finally(() => {
        this.draining = undefined;
        if (this.again) { this.again = false; this.kick(); }
      });
  }

  private async drain(): Promise<void> {
    for (;;) {
      let any = false;
      for await (const { cid, entry } of this.store.log.entries(this.cursor)) {
        if (this.stopped) return;
        any = true;
        await this.process(cid, entry);
        this.cursor = entry.n + 1;
        await this.store.live.cursor.set(this.cursor);
      }
      if (!any || this.stopped) return;
    }
  }

  private configure(m: Message): void {
    const sub = subscriptionIn(m, this.admin);
    if (sub) this.subs.push(sub);
  }

  private async process(entry: CID, e: LogEntry): Promise<void> {
    const m = await this.store.get<Message>(e.message);
    const what = `#${e.n} ${kindOf(m)} from ${this.nameOf(m.from)}`;

    // Time passes: wake sleepers whose deadline this entry's stamp has reached, earliest first.
    const ns = stampNs(e.time);
    const due = [...this.sleepers.values()].filter((t) => t.deadline! <= ns)
      .sort((a, b) => (a.deadline! < b.deadline! ? -1 : a.deadline! > b.deadline! ? 1 : a.origin.toString() < b.origin.toString() ? -1 : 1));
    for (const t of due) {
      this.say(`${what} → wakes ${short(t.origin)} (slept until ${t.deadline})`);
      await this.resume(t, entry, e, m.at);
    }

    this.configure(m);
    if (isGenesis(m.body) || subscriptionIn(m, this.admin)) { this.say(`${what}: configuration`); return; }
    for (const s of this.subs) {
      if (!matches(s, m) || s.handler === "resolve-waiter") continue; // no program waits on a peer yet
      if (!s.handler.equals(SHELL_CID)) { this.say(`${what}: handler ${short(s.handler)} is not a program this runtime has`); continue; }
      const { kind: _, ...args } = (m.body ?? {}) as Record<string, unknown>;
      const origin: ThreadOrigin = { kind: "thread", program: s.handler, args, launchedBy: e.message, input: entry, at: m.at };
      const t = await this.store.chains.open(origin);
      this.say(`${what} → shell ${short(t)}`);
      await this.run(t);
      return;
    }
    if (!due.length) this.say(`${what}: recorded, nothing runs`);
  }

  // ------------------------------------------------------------ threads

  /** Start (or re-execute) a thread and step it until it rests or ends. */
  private async run(origin: CID): Promise<void> {
    if (this.live.has(origin.toString())) return;
    const o = await this.store.get<ThreadOrigin>(origin);
    const history: CID[] = [];
    for await (const c of this.store.chains.history(origin)) if (!c.equals(origin)) history.push(c);
    const launch = await this.store.get<LogEntry>(o.input!);
    if (!isLogEntry(launch)) throw new Error(`thread ${short(origin)}: input is not a log entry`);
    const t = new Live(origin, o, history);
    t.drive(o.input!, launch, o.at);
    this.live.set(origin.toString(), t);
    void this.body(t);
    await t.step.promise;
  }

  /** Wake a sleeper: drive it by `entry` and step it until it rests or ends. */
  private async resume(t: Live, entry: CID, e: LogEntry, at: Ms): Promise<void> {
    this.sleepers.delete(t.origin.toString());
    t.deadline = undefined;
    t.drive(entry, e, at);
    t.step = deferred();
    const wake = t.wake!;
    t.wake = undefined;
    wake();
    await t.step.promise;
  }

  /** The shell program: the only one for now. */
  private async body(t: Live): Promise<void> {
    try {
      await this.append(t, { state: "running" });
      const args = t.o.args;
      if (!t.o.program.equals(SHELL_CID) || !isShellArgs(args)) {
        await this.end(t, { state: "errored", error: { kind: "cant-do", message: "shell wants {cmd, tree, cwd?, env?}" } });
        return;
      }
      const modules = await loadShellModules(this.store);
      const r = await runShell(this.store, {
        tree: args.tree, cmd: args.cmd, cwd: args.cwd, env: args.env, modules,
        clock: () => t.clock.read(),
        random: (len) => t.random(len),
        sleep: (clocks) => this.sleep(t, clocks),
      });
      await this.end(t, { state: "finished", result: { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, tree: r.tree } });
    } catch (e) {
      if (e instanceof Stopped) return;
      if (e instanceof Diverged) { this.say(`${short(t.origin)} DIVERGED: ${e.message}`); return; }
      await this.end(t, { state: "errored", error: { kind: "blew-up", message: (e as Error).message } }).catch((e2) => {
        if (!(e2 instanceof Stopped)) this.say(`${short(t.origin)}: ${(e2 as Error).message}`);
      });
    } finally {
      this.live.delete(t.origin.toString());
      t.step.resolve();
    }
  }

  /**
   * A sleep: if the earliest deadline is not after the thread's "now", return
   * at once. Otherwise rest `waiting` until it, and resume when an entry
   * stamped at or after it is processed (or, re-executing, when the chain says
   * that already happened).
   */
  private async sleep(t: Live, clocks: Array<{ timeout: bigint; absolute: boolean }>): Promise<void> {
    const now = t.clock.peek();
    let deadline: bigint | undefined;
    for (const c of clocks) {
      const d = c.absolute ? c.timeout : now + c.timeout;
      if (deadline === undefined || d < deadline) deadline = d;
    }
    if (deadline === undefined || deadline <= now) return;
    await this.append(t, { state: "waiting", until: Number((deadline + 999_999n) / 1_000_000n) });

    // Re-executing: the chain may already record the wake. Replay it from its entry.
    const recorded = t.history[t.pos];
    if (recorded) {
      const u = await this.store.get<ThreadUpdate>(recorded);
      const e = await this.store.get<LogEntry>(u.input!);
      const m = await this.store.get<Message>(e.message);
      t.drive(u.input!, e, m.at);
      await this.append(t, { state: "running" });
      return;
    }
    t.deadline = deadline;
    this.sleepers.set(t.origin.toString(), t);
    await new Promise<void>((resolve) => {
      t.wake = resolve;
      t.step.resolve(); // resting: this step is over
    });
    await this.append(t, { state: "running" });
  }

  /** Final update, plus the result message to whoever launched the thread (named in the update). */
  private async end(t: Live, body: { state: ThreadState; result?: unknown; error?: ThreadUpdate["error"] }): Promise<void> {
    const launcher = await this.store.get<Message>(t.o.launchedBy!).catch(() => undefined);
    let msg: Message | undefined;
    if (launcher?.kind === "message" && launcher.from !== this.identity) {
      const out = body.result !== undefined ? { kind: "result", ...(body.result as object) } : { kind: "result", error: body.error };
      msg = await this.sign(t, { to: launcher.from, body: out, refs: [{ to: t.o.launchedBy!, rel: "replies-to" }, { to: t.origin, rel: "from-thread" }] }, "result");
    }
    const mcid = msg ? await this.putOwn(msg) : undefined;
    await this.append(t, { ...body, refs: mcid ? [{ to: mcid, rel: "result" }] : undefined });
    if (msg) this.outbox?.send(msg);
  }

  // ------------------------------------------------------------ records

  /**
   * Sign a message from the runtime identity at log time. Its seq is the one the
   * chain already recorded for this position (re-execution), else the next.
   */
  private async sign(t: Live, m: { to: string; body: unknown; refs: Ref[] }, rel: string): Promise<Message> {
    let seq: number | undefined;
    const existing = t.history[t.pos];
    if (existing) {
      const u = await this.store.get<ThreadUpdate>(existing);
      const ref = u.refs?.find((r) => r.rel === rel)?.to;
      if (isCID(ref)) seq = (await this.store.get<Message>(ref)).seq;
    }
    return signMessage(this.signer, { ...m, seq: seq ?? this.seq++, at: t.ctx.at });
  }

  private async putOwn(m: Message): Promise<CID> {
    try {
      return await this.store.putMessage(m);
    } catch (e) {
      if (e instanceof Rejected && e.reason === "duplicate-seq") throw new Diverged(`recomputed message at seq ${m.seq} differs from the stored one`);
      throw e;
    }
  }

  /** Append the thread's next update, or verify it against the chain when re-executing. */
  private async append(t: Live, body: Record<string, unknown>): Promise<CID> {
    if (this.stopped) throw new Stopped();
    const full = compact({ ...body, input: t.ctx.input, at: t.ctx.at });
    const existing = t.history[t.pos];
    const from = t.state;
    t.state = full.state as ThreadState;
    if (existing) {
      const prev = t.pos === 0 ? t.origin : t.history[t.pos - 1];
      const want = encode({ ...full, origin: t.origin, prev, seq: t.pos + 1 }).cid;
      if (!want.equals(existing)) throw new Diverged(`update ${t.pos + 1} of ${short(t.origin)} recomputes to ${short(want)}, chain has ${short(existing)}`);
      t.pos++;
      return existing;
    }
    const cid = await this.store.chains.append(t.origin, full);
    t.history.push(cid);
    t.pos++;
    this.transition(t, from, full);
    return cid;
  }

  private transition(t: Live, from: string, u: Record<string, unknown>): void {
    const bits: string[] = [];
    if (typeof u.until === "number") bits.push(`until ${u.until}`);
    const res = u.result as { exitCode?: number } | undefined;
    if (res) bits.push(`exit ${res.exitCode}`);
    const err = u.error as ThreadUpdate["error"];
    if (err) bits.push(`${err.kind}: ${err.message}`);
    this.say(`${short(t.origin)} shell ${from} → ${String(u.state)}${bits.length ? ` (${bits.join(", ")})` : ""} · input #${short(u.input as CID)}`);
  }

  private async tipOf(thread: CID): Promise<ThreadUpdate | undefined> {
    const tip = await this.store.chains.tip(thread);
    return tip.equals(thread) ? undefined : this.store.get<ThreadUpdate>(tip);
  }
}

function kindOf(m: Message): string {
  const k = (m.body as { kind?: unknown } | null)?.kind;
  return typeof k === "string" ? k : "message";
}

/** Drop undefined fields (dag-cbor has no undefined). */
function compact(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}

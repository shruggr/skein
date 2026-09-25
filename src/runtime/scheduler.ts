// The scheduler: the log consumer (docs/ARCH.md, "The kernel"). One loop:
//
//   for each log entry after the cursor, in order:
//     apply admin configuration (subscriptions, binds) it carries;
//     route its message by the subscriptions as of this point in the log —
//       a program CID launches a thread {program, args, launchedBy, input};
//       "resolve-waiter" wakes the thread whose attested request it answers;
//       no match: recorded, nothing runs;
//     step that thread until it suspends on an attested syscall or ends;
//     emit the outbound messages it produced (via the transport);
//   then advance the cursor.
//
// A thread's execution is a live wasm instance; while it waits on an attested
// reply it is suspended (JSPI) and the pending promise is its only handle.
// Nothing about the handle is durable: on start, every thread that is not at
// rest for good (running/waiting) is re-executed from its origin. Its records
// already exist, so re-execution *verifies* rather than appends: each update
// it would write is recomputed and must equal the one in its chain (same CID;
// otherwise the run diverged and the thread stops). Attested requests are
// recomputed byte-identically (deterministic signatures, the seq recorded in
// the chain), and replies the log already holds before the cursor are consumed
// on the spot; the reply the thread was waiting for, if it arrived after the
// cursor, is delivered when the loop reaches it — exactly as without a crash.
//
// Determinism: every record the runtime writes carries `input` (the entry
// whose processing wrote it) and `at` = that entry's message time. There is no
// clock or randomness here: time and seeds are replies in the log. A fresh
// runtime fed the same log with the same wallet reproduces every chain.

import type { CID } from "multiformats/cid";
import { encode, isCID } from "./cid.ts";
import { identityOf, rootIdentity, signerFor, type KeyWallet, type Signer } from "./identity.ts";
import { isLogEntry, NAMES, short, type LogEntry } from "./log.ts";
import { isShellArgs, loadShellModules, SHELL_CID } from "./programs.ts";
import { isGenesis, matches, signMessage, subscriptionIn, type Identity, type Message, type Subscription } from "./records.ts";
import { runShell } from "./shell.ts";
import { Rejected, type Store } from "./store.ts";
import { answers, Bindings, CLOCK, isBind, seedStream, type Request, type Syscall } from "./syscalls.ts";
import type { Ms, Ref, ThreadOrigin, ThreadState, ThreadUpdate } from "./types.ts";

/** Where outbound messages go. The transport; tests may capture. */
export interface Outbox { send(m: Message): void }

export interface RuntimeOptions {
  store: Store;
  wallet: KeyWallet;
  outbox?: Outbox;
  /** One line per transition. Default: nowhere. */
  log?: (line: string) => void;
}

/** A recomputed record differs from the one already stored: replay is not reproducing the run. */
export class Diverged extends Error {}
class Stopped extends Error {}

interface Reply { n: number; entry: CID; cid: CID; message: Message }
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
  readonly launchN: number;  // log position of the launching entry: bindings are as of here
  pos = 0;                   // index into history of the next update
  ctx: Ctx;
  state: ThreadState | "new" = "new";
  step: Deferred = deferred();
  wake?: (m: Message) => void;
  requestBody?: Message;     // the request it is suspended on, for validating replies
  stream?: Promise<(len: number) => Uint8Array>;
  mono = 0n;
  constructor(origin: CID, o: ThreadOrigin, history: CID[], launchN: number) {
    this.origin = origin;
    this.o = o;
    this.history = history;
    this.launchN = launchN;
    this.ctx = { input: o.input!, at: o.at };
  }
}

export class Runtime {
  readonly store: Store;
  readonly wallet: KeyWallet;
  outbox?: Outbox;
  private readonly say: (line: string) => void;

  identity = "";              // the runtime's own: signs requests and results
  admin = "";
  private signer!: Signer;
  private bindings!: Bindings;
  private readonly subs: Subscription[] = [];
  private readonly names = new Map<string, string>();
  private readonly replies = new Map<string, Reply[]>();   // request cid → replies in log order
  private readonly live = new Map<string, Live>();         // thread origin → handle
  private readonly pending = new Map<string, Live>();      // request cid → the thread suspended on it
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
  }

  /** The instance's current state hash: the log's tip entry. */
  tip(): Promise<CID | undefined> { return this.store.log.tip(); }

  /** Entries processed so far. */
  get processed(): number { return this.cursor; }

  // ------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    const w = this.wallet;
    this.signer = await signerFor(w, NAMES.runtime);
    this.identity = this.signer.identity;
    this.admin = await identityOf(w, NAMES.admin);
    const peers: Record<string, Identity> = {};
    for (const n of Object.values(NAMES)) {
      peers[n] = await identityOf(w, n);
      this.names.set(peers[n], n);
    }
    this.names.set(await rootIdentity(w), "root");
    this.bindings = new Bindings(peers);

    let max = -1;
    for await (const c of this.store.edges.query({ kind: "message", from: this.identity })) max = Math.max(max, (await this.store.get<Message>(c)).seq);
    this.seq = max + 1;
    this.cursor = await this.store.live.cursor.get();

    // Configuration up to the cursor, and every reply in the log.
    for await (const { cid, entry } of this.store.log.entries()) {
      const m = await this.store.get<Message>(entry.message);
      this.indexReply(entry.n, cid, entry.message, m);
      if (entry.n < this.cursor) this.configure(entry.n, m);
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
    this.pending.clear();
  }

  /** Settles once every admitted entry has been processed. */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  /** Verify, store and log an inbound message, and schedule processing. Returns its log entry. */
  async admit(m: Message): Promise<CID> {
    const cid = await this.store.putMessage(m);
    const entry = await this.store.log.append(cid);
    const e = await this.store.get<LogEntry>(entry);
    this.indexReply(e.n, entry, cid, m);
    this.kick();
    return entry;
  }

  /** The next seq the store will accept from `identity` (for a peer's welcome). */
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

  private configure(n: number, m: Message): void {
    if (m.from !== this.admin) return;
    const sub = subscriptionIn(m, this.admin);
    if (sub) this.subs.push(sub);
    if (isBind(m.body)) this.bindings.apply(n, m.body);
  }

  private indexReply(n: number, entry: CID, cid: CID, m: Message): void {
    for (const r of m.refs) {
      if (r.rel !== "replies-to" || !isCID(r.to)) continue;
      const k = r.to.toString();
      const list = this.replies.get(k) ?? [];
      if (!list.some((x) => x.cid.equals(cid))) list.push({ n, entry, cid, message: m });
      list.sort((a, b) => a.n - b.n);
      this.replies.set(k, list);
    }
  }

  private async process(entry: CID, e: LogEntry): Promise<void> {
    const m = await this.store.get<Message>(e.message);
    this.configure(e.n, m);
    const what = `#${e.n} ${kindOf(m)} from ${this.nameOf(m.from)}`;
    if (isGenesis(m.body) || isBind(m.body) || subscriptionIn(m, this.admin)) { this.say(`${what}: configuration`); return; }
    for (const s of this.subs) {
      if (!matches(s, m)) continue;
      if (s.handler === "resolve-waiter") {
        const w = this.waiterFor(e.n, m);
        if (!w) continue;
        this.say(`${what} → wakes ${short(w.t.origin)}`);
        await this.resume(w.t, w.request, { n: e.n, entry, cid: e.message, message: m });
        return;
      }
      if (!s.handler.equals(SHELL_CID)) { this.say(`${what}: handler ${short(s.handler)} is not a program this runtime has`); continue; }
      const { kind: _, ...args } = (m.body ?? {}) as Record<string, unknown>;
      const origin: ThreadOrigin = { kind: "thread", program: s.handler, args, launchedBy: e.message, input: entry, at: m.at };
      const t = await this.store.chains.open(origin);
      this.say(`${what} → shell ${short(t)}`);
      await this.run(t);
      return;
    }
    this.say(`${what}: recorded, nothing runs`);
  }

  /** The thread a reply wakes: one suspended on the request it replies to, which it validly answers. */
  private waiterFor(n: number, m: Message): { t: Live; request: CID } | undefined {
    for (const r of m.refs) {
      if (r.rel !== "replies-to" || !isCID(r.to)) continue;
      const t = this.pending.get(r.to.toString());
      if (!t) continue;
      // Only the first valid reply in the log counts; a later one (a peer answering twice) is recorded and ignored.
      if (this.firstReply(r.to, t.requestBody!)?.n !== n) continue;
      return { t, request: r.to };
    }
    return undefined;
  }

  private firstReply(request: CID, req: Message): Reply | undefined {
    return this.replies.get(request.toString())?.find((r) => answers(req, r.message));
  }

  // ------------------------------------------------------------ threads

  /** Start (or re-execute) a thread and step it until it suspends or ends. */
  private async run(origin: CID): Promise<void> {
    if (this.live.has(origin.toString())) return;
    const o = await this.store.get<ThreadOrigin>(origin);
    const history: CID[] = [];
    for await (const c of this.store.chains.history(origin)) if (!c.equals(origin)) history.push(c);
    const launch = await this.store.get<LogEntry>(o.input!);
    if (!isLogEntry(launch)) throw new Error(`thread ${short(origin)}: input is not a log entry`);
    const t = new Live(origin, o, history, launch.n);
    this.live.set(origin.toString(), t);
    void this.body(t);
    await t.step.promise;
  }

  private async resume(t: Live, request: CID, r: Reply): Promise<void> {
    this.pending.delete(request.toString());
    t.ctx = { input: r.entry, at: r.message.at };
    t.step = deferred();
    const wake = t.wake!;
    t.wake = undefined;
    wake(r.message);
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
        clock: (id) => this.clock(t, id),
        random: (len) => this.random(t, len),
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

  private async clock(t: Live, id: number): Promise<bigint> {
    if (id !== CLOCK.REALTIME) return this.pure(t, "clock_time_get:monotonic");
    const reply = await this.attest(t, "clock_time_get", { kind: "time", state: t.ctx.input });
    return BigInt((reply.body as { time: number }).time) * 1_000_000n;
  }

  private pure(t: Live, s: Syscall): bigint {
    const b = this.bindings.at(t.launchN, s);
    if (b.kind !== "pure") throw new Error(`${s} bound to ${b.kind}: only "pure" is implemented for it`);
    t.mono += 1_000_000n;
    return t.mono;
  }

  private async random(t: Live, len: number): Promise<Uint8Array> {
    t.stream ??= (async () => {
      const b = this.bindings.at(t.launchN, "random_get");
      if (b.kind === "pure") return seedStream(new Uint8Array(32));
      const reply = await this.attest(t, "random_get", { kind: "random", state: t.ctx.input });
      return seedStream((reply.body as { seed: Uint8Array }).seed);
    })();
    return (await t.stream)(len);
  }

  /**
   * One attested syscall: sign the request (deterministically), record the
   * wait, and either consume a reply the log already holds (re-execution) or
   * send the request and suspend until the loop delivers the reply.
   */
  private async attest(t: Live, syscall: Syscall, body: Request): Promise<Message> {
    const b = this.bindings.at(t.launchN, syscall);
    if (b.kind !== "peer") throw new Error(`${syscall} is bound to ${b.kind}${b.kind === "bundle" ? " (not implemented yet)" : ""}`);
    const req = await this.sign(t, { to: b.to, body, refs: [{ to: t.origin, rel: "from-thread" }] }, "awaits");
    const rcid = await this.putOwn(req);
    await this.append(t, { state: "waiting", waitingFrom: b.to, refs: [{ to: rcid, rel: "awaits" }] });

    const have = this.firstReply(rcid, req);
    if (have && have.n < this.cursor) {
      // Already answered, and processed, before this process started: consume it now.
      t.ctx = { input: have.entry, at: have.message.at };
      await this.append(t, { state: "running" });
      return have.message;
    }
    if (!have) this.outbox?.send(req); // (re)send; a reply already in the log (after the cursor) is on its way through the loop
    t.requestBody = req;
    this.pending.set(rcid.toString(), t);
    const reply = await new Promise<Message>((resolve) => {
      t.wake = resolve;
      t.step.resolve(); // suspended: this step is over
    });
    await this.append(t, { state: "running" });
    return reply;
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
    if (typeof u.waitingFrom === "string") bits.push(`on ${this.nameOf(u.waitingFrom)}`);
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

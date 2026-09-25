// The runtime (docs/VM.md): consumes the message log in order and steps
// programs. Replaces v1's scheduler and runners.
//
// Input is the store's log. `ingest` puts a message and drains; `poll` drains
// what other processes put. Draining processes each message after the cursor,
// strictly in log order, one at a time:
//
//   1. dispatch — a message addressed to a registered service is handed to it
//      (asynchronously; its reply comes back through `ingest`);
//   2. route    — (inbound only: a program's own emits, which carry a
//      `from-thread` ref, are effects and never routed) the subscriptions as of this point in the log (admin-signed
//      messages, in log order) are tried in order; the first that matches and
//      takes the message wins. `resolve-waiter` takes it if a thread is waiting
//      on a message from its sender (see findWaiter); a program CID takes it by
//      opening a thread {program, args: body, launchedBy: message} and stepping
//      it. Nothing takes it → it is recorded and nothing runs.
//
// Stepping a thread calls its program (program.ts) and applies the output:
// appends in order (resolving $ref/$msg), then the signed emits. Threads the
// step opened are stepped next; a thread that settles wakes its waiters with
// `resolved`. All of that finishes before the next log message is looked at.
//
// Determinism. Every record the runtime writes for a program is stamped with
// the log time — the `at` of the message being processed — and emitted
// messages are signed (RFC 6979, deterministic) at seqs allocated in log
// order, so replaying the same log against an empty store with the same
// wallet reproduces every chain byte for byte (replay.ts). A message already
// in the store is not put again: the log is authoritative, and one the
// runtime would have produced is recognised by its CID.
//
// Crash safety: the cursor (last processed log position) is saved after each
// message; a message interrupted mid-processing is processed again on
// restart. Programs are written to be idempotent against their own chains, but
// a step whose appends landed and whose emits didn't will wait for a reply
// that never comes (docs/OPEN.md).

import type { CID } from "multiformats/cid";
import type { WalletInterface } from "@bsv/sdk";
import { encode, isCID } from "./cid.ts";
import { isSettled, short } from "./graph.ts";
import { loadProgram, type Append, type Emit, type ProgramContext, type ProgramWallet, type StepInput } from "./program.ts";
import { PROGRAM_RECORDS } from "./programs/records.ts";
import { compact } from "./programs/sdk.ts";
import { isProgram, matches, signMessage, subscriptionIn, type Message, type Program, type Subscription } from "./records.ts";
import { Rejected, type Store } from "./store.ts";
import type { Block, Ms, NodeOrigin, Ref, ThreadOrigin, ThreadUpdate } from "./types.ts";
import { identityOf, signerFor, type Signer } from "./wallet.ts";
import type { HostCtx, Request, Service, ServiceCtx } from "./services/types.ts";
import { failed } from "./services/types.ts";

/** Service names whose identities are reserved: a program may send to one only if it declares it. */
export const KNOWN_SERVICES = ["inference", "execution", "clock", "wallet", "messages", "chain"];

export interface RuntimeOptions {
  wallet: WalletInterface;
  /** Host services to dispatch to. None (replay) = every message is only recorded. */
  services?: Service[];
  admin?: string;           // keyID of the admin identity (default "admin")
  names?: string[];         // more keyIDs to name in the log (e.g. the owner)
  log?: (line: string) => void;
}

// The cursor lives in live.handles, which is keyed by CID; this one is a constant.
const CURSOR = encode({ kind: "cursor", of: "log" }).cid;

interface Job { thread: CID; message?: Message; resolved?: CID[] }

export class Runtime {
  readonly store: Store;
  readonly wallet: WalletInterface;
  private readonly services: Service[];
  private readonly adminName: string;
  private readonly extraNames: string[];
  private readonly logLine: (line: string) => void;

  private ready?: Promise<void>;
  admin = "";
  private readonly serviceIds = new Map<string, string>();   // name → identity
  private readonly byIdentity = new Map<string, Service>();  // registered services
  private readonly names = new Map<string, string>();        // identity → name, for the log
  private readonly signers = new Map<string, Promise<Signer>>();
  private readonly seqs = new Map<string, Promise<number>>();
  private subs: Subscription[] = [];
  private cursor = 0;

  private work: Promise<unknown> = Promise.resolve();
  private readonly inflight = new Set<Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;
  private ticking?: Promise<void>;
  private readonly programWallet: ProgramWallet;

  constructor(store: Store, opts: RuntimeOptions) {
    this.store = store;
    this.wallet = opts.wallet;
    this.services = opts.services ?? [];
    this.adminName = opts.admin ?? "admin";
    this.extraNames = opts.names ?? [];
    this.logLine = opts.log ?? ((l) => console.log(l));
    const w = opts.wallet;
    this.programWallet = {
      createSignature: (a) => w.createSignature(a),
      verifySignature: (a) => w.verifySignature(a),
      encrypt: (a) => w.encrypt(a),
      decrypt: (a) => w.decrypt(a),
      getPublicKey: (a) => w.getPublicKey(a),
    };
  }

  /** Identities, the cursor, and the subscriptions up to it. Idempotent. */
  init(): Promise<void> {
    return (this.ready ??= (async () => {
      this.admin = await identityOf(this.wallet, this.adminName);
      this.names.set(this.admin, this.adminName);
      for (const n of new Set([...KNOWN_SERVICES, ...this.services.map((s) => s.name)])) {
        const id = await identityOf(this.wallet, n);
        this.serviceIds.set(n, id);
        this.names.set(id, n);
      }
      for (const s of this.services) this.byIdentity.set(this.serviceIds.get(s.name)!, s);
      for (const n of [...PROGRAM_RECORDS.map((p) => p.name), ...this.extraNames]) this.names.set(await identityOf(this.wallet, n), n);
      const h = await this.store.live.handles.get(CURSOR);
      this.cursor = typeof h?.n === "number" ? h.n : 0;
      for await (const { n, cid } of this.store.log()) {
        if (n > this.cursor) break;
        const m = await this.store.get<Message>(cid);
        const sub = subscriptionIn(m, this.admin);
        if (sub) this.subs.push(sub);
      }
    })());
  }

  /** The identity a service (known or registered) signs as. */
  serviceIdentity(name: string): string | undefined {
    return this.serviceIds.get(name);
  }

  /** Put a message (if new) and process the log through it. Resolves with its CID once processed. */
  ingest(m: Message): Promise<CID> {
    return this.serial(async () => {
      const cid = encode(m).cid;
      if (!(await this.store.has(cid))) await this.store.putMessage(m);
      await this.drain();
      return cid;
    });
  }

  /** Process whatever is in the log past the cursor (e.g. put by the CLI in another process). */
  poll(): Promise<void> {
    return this.serial(() => this.drain());
  }

  /** Settles when no log work is queued and no service is mid-request (timers don't count). */
  async idle(): Promise<void> {
    for (;;) {
      await this.work;
      if (!this.inflight.size) {
        await this.work;
        if (!this.inflight.size) return;
      }
      await Promise.allSettled([...this.inflight]);
    }
  }

  /** Poll the log and let services check timers and lost work. */
  tick(): Promise<void> {
    return (this.ticking ??= (async () => {
      try {
        await this.poll();
        for (const s of this.services) if (s.tick) await s.tick(this.hostCtx(s)).catch((e) => this.say(`${s.name} tick failed: ${(e as Error).message}`));
      } finally {
        this.ticking = undefined;
      }
    })());
  }

  /** Recover services' unanswered requests, then tick every `tickMs`. */
  async start(tickMs = 1000): Promise<void> {
    await this.poll();
    for (const s of this.services) if (s.recover) await s.recover(this.hostCtx(s)).catch((e) => this.say(`${s.name} recover failed: ${(e as Error).message}`));
    this.timer = setInterval(() => void this.tick(), tickMs);
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.ticking;
    await this.work;
  }

  // ------------------------------------------------------------ the log

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.work.then(() => this.init()).then(fn);
    this.work = p.catch((e) => this.say(`runtime: ${(e as Error).stack ?? e}`));
    return p;
  }

  private async drain(): Promise<void> {
    for (;;) {
      const batch: Array<{ n: number; cid: CID }> = [];
      for await (const e of this.store.log(this.cursor)) batch.push(e);
      if (!batch.length) return;
      for (const { n, cid } of batch) {
        await this.process(cid, await this.store.get<Message>(cid));
        this.cursor = n;
        await this.store.live.handles.set(CURSOR, { n });
      }
    }
  }

  private async process(cid: CID, m: Message): Promise<void> {
    const sub = subscriptionIn(m, this.admin);
    if (sub) this.subs.push(sub);
    // A message from an identity we sign for, that we didn't just sign (another process, a replayed log): skip its seq.
    const seq = this.seqs.get(m.from);
    if (seq) this.seqs.set(m.from, seq.then((s) => Math.max(s, m.seq + 1)));

    const svc = m.to !== undefined ? this.byIdentity.get(m.to) : undefined;
    if (svc) this.dispatch(svc, { cid, msg: m });

    // Outbound (a program's emit, naming the thread it came from) is an effect, not input:
    // routing it would let a program wake itself, or a subscription fork-bomb on its own output.
    const from = m.refs.find((r) => r.rel === "from-thread")?.to;
    if (isCID(from) && (await this.store.get<{ kind?: unknown } & Block>(from).catch(() => undefined))?.kind === "thread") return;

    for (const s of this.subs) {
      if (!matches(s, m)) continue;
      if (s.handler === "resolve-waiter") {
        const t = await this.findWaiter(m);
        if (!t) continue;
        this.say(`${short(cid)} ${this.kindOf(m)} from ${this.name(m.from)} → ${short(t)}`);
        return this.run({ thread: t, message: m }, m.at);
      }
      const program = await this.store.get(s.handler).catch(() => undefined);
      if (!isProgram(program)) { this.say(`subscription handler ${short(s.handler)} is not a program record`); continue; }
      const t = await this.store.chains.open({ kind: "thread", program: s.handler, args: m.body, launchedBy: cid, at: m.at } as ThreadOrigin);
      this.say(`${short(cid)} ${this.kindOf(m)} from ${this.name(m.from)} → new ${program.name} ${short(t)}`);
      return this.run({ thread: t, message: m }, m.at);
    }
  }

  /**
   * The thread a message resolves. With a `replies-to` ref: the thread that
   * emitted the request it names (the request must have been addressed to this
   * sender), or the thread it names directly. Without: of the threads waiting
   * on this sender, the one that came to rest most recently. Either way the
   * thread's tip must be `waiting` with `waitingFrom` = the sender.
   */
  private async findWaiter(m: Message): Promise<CID | undefined> {
    const re = m.refs.find((r) => r.rel === "replies-to")?.to;
    let candidates: CID[] = [];
    if (isCID(re)) {
      const b = await this.store.get<{ kind?: unknown } & Block>(re).catch(() => undefined);
      if (b?.kind === "message") {
        const req = b as unknown as Message;
        const ft = req.refs.find((r) => r.rel === "from-thread")?.to;
        if (req.to === m.from && isCID(ft)) candidates = [ft];
      } else if (b?.kind === "thread") {
        candidates = [re];
      }
    } else {
      const ws: Array<{ t: CID; at: Ms }> = [];
      for await (const t of this.store.live.waitingFrom(m.from)) ws.push({ t, at: (await this.tipOf(t))?.at ?? 0 });
      candidates = ws.sort((a, b) => b.at - a.at).map((w) => w.t);
    }
    for (const t of candidates) {
      const tip = await this.tipOf(t).catch(() => undefined); // a ref to a thread this store never had
      if (tip?.state === "waiting" && tip.waitingFrom === m.from) return t;
    }
    return undefined;
  }

  // ------------------------------------------------------------ stepping

  private async run(first: Job, now: Ms): Promise<void> {
    const queue = [first];
    for (let budget = 10_000; queue.length && budget > 0; budget--) queue.push(...(await this.step(queue.shift()!, now)));
  }

  /** Step one thread; returns the jobs it caused (threads it opened, waiters it woke). */
  private async step(job: Job, now: Ms): Promise<Job[]> {
    const { thread } = job;
    const origin = await this.store.get<ThreadOrigin>(thread);
    if (origin.kind !== "thread" || !origin.program) return [];
    const tipCid = await this.store.chains.tip(thread);
    const tip = tipCid.equals(thread) ? origin : await this.store.get<ThreadUpdate>(tipCid);
    if ("state" in tip && isSettled(tip.state)) return [];

    let record: Program;
    try {
      const r = await this.store.get(origin.program);
      if (!isProgram(r)) throw new Error(`${short(origin.program)} is not a program record`);
      record = r;
    } catch (e) {
      return this.fail(thread, "?", "cant-do", (e as Error).message, now);
    }
    const input: StepInput = { thread, tip, ...(job.message ? { message: job.message } : {}), ...(job.resolved ? { resolved: job.resolved } : {}) };
    const ctx: ProgramContext = { get: (c) => this.store.get(c), wallet: this.programWallet };
    let out;
    try {
      out = await loadProgram(record).step(input, ctx);
    } catch (e) {
      return this.fail(thread, record.name, "blew-up", `program ${record.name} threw: ${(e as Error).message}`, now);
    }
    // Capabilities are declared on the program, never acquired mid-thread.
    for (const e of out.emit) {
      const svc = [...this.serviceIds].find(([, id]) => id === e.to)?.[0];
      if (svc && !record.services.includes(svc)) {
        return this.fail(thread, record.name, "cant-do", `program ${record.name} may not call ${svc} (declares ${record.services.join(", ") || "none"})`, now);
      }
    }
    try {
      return await this.apply(thread, record, tip, out.append, out.emit, now);
    } catch (e) {
      return this.fail(thread, record.name, "cant-do", `program ${record.name}: ${(e as Error).message}`, now);
    }
  }

  private async apply(thread: CID, record: Program, tip: ThreadOrigin | ThreadUpdate, appends: Append[], emits: Emit[], now: Ms): Promise<Job[]> {
    const results: CID[] = [];
    const opened = new Set<string>();
    const signer = await this.signer(record.name);
    const base = emits.length ? await this.nextSeq(signer.identity, emits.length) : 0;
    const signed = new Map<number, Message>();

    const sign = async (j: number, limit: number): Promise<Message> => {
      let m = signed.get(j);
      if (m) return m;
      const e = emits[j];
      if (!e) throw new Error(`$msg ${j}: no such emit`);
      const refs = [...((await resolve(e.refs ?? [], limit)) as Ref[]), { to: thread, rel: "from-thread" }];
      m = await signMessage(signer, { to: e.to, seq: base + j, at: now, body: await resolve(e.body, limit), refs });
      signed.set(j, m);
      return m;
    };
    const resolve = async (v: unknown, limit: number): Promise<unknown> => {
      if (Array.isArray(v)) return Promise.all(v.map((x) => resolve(x, limit)));
      if (!v || typeof v !== "object" || isCID(v) || v instanceof Uint8Array) return v;
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o);
      if (keys.length === 1 && typeof o.$ref === "number") {
        if (o.$ref >= limit) throw new Error(`$ref ${o.$ref} is not an earlier append`);
        return results[o.$ref];
      }
      if (keys.length === 1 && typeof o.$msg === "number") return encode(await sign(o.$msg, limit)).cid;
      const r: Record<string, unknown> = {};
      for (const k of keys) if (o[k] !== undefined) r[k] = await resolve(o[k], limit);
      return r;
    };

    let last: Record<string, unknown> | undefined; // the thread's final update this step
    for (let i = 0; i < appends.length; i++) {
      const a = appends[i];
      if ("open" in a) {
        const block = (await resolve(a.open, i)) as Record<string, unknown>;
        const cid = await this.store.chains.open(compact({ ...block, at: block.at ?? now }) as Block);
        results.push(cid);
        opened.add(cid.toString());
      } else {
        const origin = (await resolve(a.origin, i)) as CID;
        if (!isCID(origin)) throw new Error(`append ${i}: origin is not a CID`);
        if (!origin.equals(thread) && !opened.has(origin.toString())) {
          const b = await this.store.get<NodeOrigin>(origin);
          if (b.kind !== "node" || !b.thread.equals(thread)) throw new Error(`append ${i}: ${short(origin)} is not this thread's`);
        }
        const body = compact({ ...((await resolve(a.body, i)) as Record<string, unknown>), at: now });
        results.push(await this.store.chains.append(origin, body));
        if (origin.equals(thread)) last = body;
      }
    }
    for (let j = 0; j < emits.length; j++) await this.store.putMessage(await sign(j, appends.length));

    const jobs: Job[] = [];
    for (const c of results) {
      if (!opened.has(c.toString())) continue;
      const b = await this.store.get<ThreadOrigin>(c);
      if (b.kind === "thread") {
        jobs.push({ thread: c });
        this.say(`${short(c)} ${await this.programName(b)} launched by ${short(thread)}`);
      }
    }
    if (last) {
      this.transition(thread, record.name, "state" in tip ? tip.state : "new", last);
      if (isSettled(last.state as ThreadUpdate["state"])) jobs.push(...(await this.waitersOf(thread)));
    }
    return jobs;
  }

  private async fail(thread: CID, name: string, kind: "cant-do" | "blew-up", message: string, now: Ms): Promise<Job[]> {
    const before = await this.tipOf(thread);
    const body = { state: "errored", error: { kind, message }, at: now };
    await this.store.chains.append(thread, body);
    this.transition(thread, name, before?.state ?? "new", body);
    return this.waitersOf(thread);
  }

  private async waitersOf(thread: CID): Promise<Job[]> {
    const tip = await this.store.chains.tip(thread);
    const jobs: Job[] = [];
    for await (const w of this.store.live.waitersOn(thread)) jobs.push({ thread: w, resolved: [tip] });
    return jobs;
  }

  // ------------------------------------------------------------ services

  private dispatch(svc: Service, req: Request): void {
    const ctx = this.serviceCtx(svc, req);
    const p = svc.handle(req, ctx)
      .catch(async (e) => {
        this.say(`${svc.name} failed on ${short(req.cid)}: ${(e as Error).message}`);
        await ctx.reply(failed("blew-up", `${svc.name}: ${(e as Error).message}`)).catch(() => {});
      })
      .finally(() => this.inflight.delete(p));
    this.inflight.add(p);
  }

  private hostCtx(svc: Service): HostCtx {
    const me = this.serviceIds.get(svc.name)!;
    return {
      store: this.store,
      log: (l) => this.say(`${svc.name}: ${l}`),
      replyTo: async (req, body, refs = []) => {
        const signer = await this.signer(svc.name);
        const m = await signMessage(signer, {
          to: req.msg.from, seq: await this.nextSeq(signer.identity), body,
          refs: [{ to: req.cid, rel: "replies-to" }, ...refs],
        });
        return this.ingest(m);
      },
      pending: () => this.pending(me),
      redeliver: (req) => this.dispatch(svc, req),
    };
  }

  private serviceCtx(svc: Service, req: Request): ServiceCtx {
    const h = this.hostCtx(svc);
    return { ...h, reply: (body, refs) => h.replyTo(req, body, refs) };
  }

  private async *pending(me: string): AsyncIterable<Request> {
    for await (const { cid } of this.store.log()) {
      const msg = await this.store.get<Message>(cid);
      if (msg.to !== me) continue;
      const replies = await this.store.edges.refsTo(cid);
      let answered = false;
      for (const r of replies) {
        if (r.rel !== "replies-to") continue;
        const b = await this.store.get<Message>(r.from).catch(() => undefined);
        if (b?.kind === "message" && b.from === me) { answered = true; break; }
      }
      if (!answered) yield { cid, msg };
    }
  }

  // ------------------------------------------------------------ helpers

  private signer(name: string): Promise<Signer> {
    let s = this.signers.get(name);
    if (!s) this.signers.set(name, (s = signerFor(this.wallet, name)));
    return s;
  }

  /** Reserve `n` consecutive seqs for `identity`; the first is returned. */
  private nextSeq(identity: string, n = 1): Promise<number> {
    const start = this.seqs.get(identity) ?? (async () => {
      let max = -1;
      for await (const c of this.store.edges.query({ kind: "message", from: identity })) max = Math.max(max, (await this.store.get<Message>(c)).seq);
      return max + 1;
    })();
    this.seqs.set(identity, start.then((s) => s + n));
    return start;
  }

  private async tipOf(thread: CID): Promise<ThreadUpdate | undefined> {
    const tip = await this.store.chains.tip(thread);
    return tip.equals(thread) ? undefined : this.store.get<ThreadUpdate>(tip);
  }

  private async programName(o: ThreadOrigin): Promise<string> {
    if (!o.program) return o.runner ?? "?";
    const p = await this.store.get(o.program).catch(() => undefined);
    return isProgram(p) ? p.name : short(o.program);
  }

  private name(identity: string): string {
    return this.names.get(identity) ?? identity.slice(0, 10);
  }

  private kindOf(m: Message): string {
    const k = (m.body as { kind?: unknown } | null)?.kind;
    return typeof k === "string" ? k : "message";
  }

  private transition(thread: CID, name: string, from: string, u: Record<string, unknown>): void {
    const err = u.error as ThreadUpdate["error"];
    const detail = [
      Array.isArray(u.waitingOn) && u.waitingOn.length ? `on ${u.waitingOn.map((c) => short(c as CID)).join(",")}` : "",
      typeof u.waitingFrom === "string" ? `from ${this.name(u.waitingFrom)}` : "",
      err ? `${err.kind}: ${err.message}` : "",
      typeof u.note === "string" ? u.note : "",
    ].filter(Boolean).join(" · ");
    this.say(`${short(thread)} ${name} ${from} → ${String(u.state)}${detail ? ` (${detail})` : ""}`);
  }

  private say(line: string): void {
    this.logLine(`${new Date().toISOString().slice(11, 23)} ${line}`);
  }
}

export { Rejected };

// The scheduler: the log consumer (docs/ARCH.md, "The kernel"; docs/MESSAGES.md).
//
//   for each log entry after the cursor, in order:
//     check its signature against the instance identity;
//     genesis  → the starting state: programs and subscriptions;
//     envelope → a reply first: if its plaintext body (a record the entry
//                names) has `replyTo`, it goes to the thread whose tip
//                `awaits` that envelope, provided the sender is the identity the
//                awaited envelope was sealed to — as that thread's next step
//                input — or, if none, nowhere (recorded, nothing runs). Never
//                also by subscription. Otherwise route by subscription on
//                (sender, box), first match wins: launch the handler program's
//                thread {program, args: {envelope, body, box, sender},
//                launchedBy: <envelope>, input: <entry>} and step it;
//     wake     → resume the sleeping thread it names, if its deadline is reached;
//     step every thread that touches until each rests or ends, and hand the
//     envelopes they emitted to the outbox;
//   then advance the cursor.
//
// Two kinds of thread body:
//
// - The shell (program code {ts: "shell"}): the wasm shell run from TypeScript
//   in one go. A sleep rests the thread (`waiting`, `until`) with its instance
//   parked (JSPI); main.ts writes a wake entry at the deadline. Nothing about
//   the handle is durable: on start it is re-executed from its origin, and
//   re-execution *verifies* — each update it would write must equal the one in
//   its chain (same CID), else the run diverged and the thread stops.
//
// - Handler programs (code {wasm: <module>}): WASI modules stepped with the
//   `skein` imports (program.ts). A step runs to completion over its input and
//   ends in one update: `finished`, `errored`, or `waiting` — on the threads it
//   launched (`waitingOn`), which start after it, or on replies to envelopes it
//   emitted (`awaits`). When the launched threads are all at rest the program
//   runs again with their resolution as input; when a reply is admitted it runs
//   again with that envelope as input (`reply`). A step's attested calls
//   (wallet wire frames, signed outbound envelopes) are records listed in its
//   update (`calls`); a Witness serves them on replay, so replay needs no
//   wallet. A step may keep records in its thread's state (`keep`: the loop's
//   turns), listed in its update (`kept`), and move named heads (`advance`,
//   heads.ts): the moves are written when it ends without error, and listed
//   in its update.
//
// Determinism: every record the runtime writes carries `input` (the entry
// whose processing wrote it) and `at` (that entry's stamp, in ms). Nothing
// here reads a clock or a random source.

import { createHash } from "node:crypto";
import { WalletWireProcessor, type WalletInterface } from "@bsv/sdk";
import type { CID } from "multiformats/cid";
import { decode, encode, isCID } from "./cid.ts";
import { appendEntry, genesisOf, isLogEntry, now as clockNow, short, stampMs, verifyEntry, type EntryBody, type LogEntry } from "./log.ts";
import { advanceHead, headTree, isHeadName } from "./heads.ts";
import { runProgram } from "./program.ts";
import { isShellArgs, loadModule, loadShellModules } from "./programs.ts";
import { isAttested, isEmit, isGenesis, isProgram, matches, type Attested, type Emit, type Genesis, type Program } from "./records.ts";
import { runShell } from "./shell.ts";
import { Rejected, type Store } from "./store.ts";
import { entropy, stampNs, ThreadClock, type Stamp } from "./syscalls.ts";
import type { Ms, ThreadOrigin, ThreadState, ThreadUpdate } from "./types.ts";

/** Wallet wire calls a program may make (BRC-100 call codes): key derivation and crypto only — no actions, no certificates. */
export const WALLET_CALLS: ReadonlyMap<number, string> = new Map([
  [8, "getPublicKey"], [11, "encrypt"], [12, "decrypt"], [13, "createHmac"], [14, "verifyHmac"], [15, "createSignature"], [16, "verifySignature"],
]);

/** An emitted envelope, signed during the step that emitted it, for the edge to encrypt and send. */
export interface Outbound extends Emit {
  emit: CID;         // the emit record
  bytes: Uint8Array; // the body record's dag-cbor: the envelope's plaintext content
  thread: CID;
  envelope: object;  // the signed part of the BRC-169 envelope (JSON object, no `content`)
  cid: CID;          // its record CID: what a reply's `replyTo` names
}

/**
 * Where emitted envelopes go: the edge (inbox.ts). `seal` signs the envelope's
 * signed part inside the step that emits (an attested call: its answer is
 * recorded), `created` being the step's `at`; `send` encrypts and delivers it
 * after the step is recorded. Tests may capture; replay needs no `seal` (the
 * witness answers).
 */
export interface Outbox {
  seal?(e: Emit, bytes: Uint8Array, at: Ms): Promise<object>;
  send(o: Outbound): void | Promise<void>;
}

/** A reply delivered to the thread awaiting it: the handler-args shape, plus what it answers. */
interface Reply { envelope: CID; body: CID; box: string; sender: string; replyTo: CID }

/** Answers to attested calls, by position: what replay serves instead of a wallet. */
export interface Witness { find(thread: CID, step: number, i: number): Promise<Attested | undefined> }

export interface RuntimeOptions {
  store: Store;
  /** The instance wallet. Absent on replay: attested answers come from `witness`, and nothing can be admitted. */
  wallet?: WalletInterface;
  witness?: Witness;
  outbox?: Outbox;
  /** One line per transition. Default: nowhere. */
  log?: (line: string) => void;
  /** The clock admission stamps entries with. Default: log.ts's wall clock. Tests pass a script. */
  now?: () => Stamp;
  /** Called when a thread starts sleeping: main.ts writes a wake entry at `until`. */
  onSleep?: (thread: CID, until: Ms) => void;
}

/** A recomputed record differs from the one already stored: replay is not reproducing the run. */
export class Diverged extends Error {}
/** An attested call with no wallet to make it and no witness that recorded it. */
export class NoWitness extends Error {}
class Stopped extends Error {}

interface Ctx { input: CID; at: Ms }

interface Deferred { promise: Promise<void>; resolve(): void }
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/** A shell thread with a live instance: its handle. Transient by design. */
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
  drive(entry: CID, e: LogEntry): void {
    this.ctx = { input: entry, at: stampMs(e.time) };
    this.clock.drive(stampNs(e.time));
    this.random = entropy(entry, this.origin);
  }
}

/** A launched thread at rest, as the next step's input names it. */
interface Resolved { thread: CID; state: ThreadState; result?: unknown; error?: unknown }

export class Runtime {
  readonly store: Store;
  readonly wallet?: WalletInterface;
  outbox?: Outbox;
  private readonly witness?: Witness;
  private readonly say: (line: string) => void;
  private readonly now: () => Stamp;
  private readonly onSleep?: (thread: CID, until: Ms) => void;
  private readonly wire?: WalletWireProcessor;

  genesis?: Genesis;
  private readonly live = new Map<string, Live>();         // shell thread origin → handle
  private readonly sleepers = new Map<string, Live>();     // thread origin → a live thread resting on a deadline
  private readonly stepping = new Set<string>();           // program threads mid-step
  private cursor = 0;
  private started = false;
  private stopped = false;
  private draining?: Promise<void>;
  private again = false;
  private appending: Promise<unknown> = Promise.resolve();

  constructor(o: RuntimeOptions) {
    this.store = o.store;
    this.wallet = o.wallet;
    this.witness = o.witness;
    this.outbox = o.outbox;
    this.say = o.log ?? (() => {});
    this.now = o.now ?? clockNow;
    this.onSleep = o.onSleep;
    if (o.wallet) this.wire = new WalletWireProcessor(o.wallet);
  }

  /** The instance identity (the genesis's), once there is a log. */
  get identity(): string { return this.genesis?.identity ?? ""; }

  /** The instance's current state hash: the log's tip entry. */
  tip(): Promise<CID | undefined> { return this.store.log.tip(); }

  /** Entries processed so far. */
  get processed(): number { return this.cursor; }

  /** Threads resting on a deadline. */
  get sleeping(): number { return this.sleepers.size; }

  /** Every sleeper and its deadline (ms, rounded up), earliest first. */
  sleepersDue(): Array<{ thread: CID; until: Ms }> {
    return [...this.sleepers.values()].sort((a, b) => (a.deadline! < b.deadline! ? -1 : a.deadline! > b.deadline! ? 1 : 0))
      .map((t) => ({ thread: t.origin, until: Number((t.deadline! + 999_999n) / 1_000_000n) }));
  }

  /** The boxes the subscriptions route (what the edge collects). Reads the genesis if not yet started. */
  async boxes(): Promise<string[]> {
    if (!this.genesis && (await this.store.log.tip())) this.genesis = await genesisOf(this.store);
    const subscribed = (this.genesis?.subscriptions ?? []).map((s) => s.match.box).filter((b): b is string => !!b);
    return [...new Set([...subscribed, ...(this.genesis?.collect ?? [])])];
  }

  // ------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    if (await this.store.log.tip()) this.genesis = await genesisOf(this.store);
    this.cursor = await this.store.live.cursor.get();
    this.say(`runtime ${short(this.identity)} · log ${this.cursor} processed${this.wallet ? "" : " · no wallet (replay)"}`);
    this.started = true;

    // Threads whose handles died with the last process.
    const resting: CID[] = [];
    for await (const t of this.store.live.resting()) resting.push(t);
    for (const t of resting) await this.resume(t);
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

  // ------------------------------------------------------------ admission

  /**
   * Admit a BRC-169 envelope that arrived in `box`, as its signed part (the
   * JSON object without `content`) and its plaintext body (canonical dag-cbor,
   * decrypted by the edge): store both, write a signed log entry naming them,
   * and schedule processing. The edge has verified the sender's signature and
   * screened it (inbox.ts); here the body must hash to the signed
   * `contentHash`. An envelope already in the log is Rejected "duplicate-envelope".
   */
  async admitEnvelope(signed: object, box: string, body: Uint8Array): Promise<{ entry: CID; envelope: CID; body: CID }> {
    const { cid: bodyCid, bytes } = encode(decode(body));
    if (!Buffer.from(bytes).equals(body)) throw new TypeError("admit: the body is not canonical dag-cbor");
    if ((signed as { contentHash?: unknown }).contentHash !== Buffer.from(bodyCid.multihash.digest).toString("hex")) throw new TypeError("admit: the body does not match the envelope's contentHash");
    if ("content" in signed) throw new TypeError("admit: keep the signed part only, not the wire `content`");
    const env = await this.store.put(signed as never);
    if (await this.store.log.byEnvelope(env)) throw new Rejected("duplicate-envelope", `envelope ${env} is already admitted`);
    await this.store.putBlock(bodyCid, body);
    return { entry: await this.append({ envelope: env, box, body: bodyCid }), envelope: env, body: bodyCid };
  }

  /** Write a wake entry for a sleeper whose deadline has come (main.ts's timer). No-op if it is not sleeping. */
  async wake(thread: CID): Promise<CID | undefined> {
    if (!this.sleepers.has(thread.toString())) return undefined;
    return this.append({ wake: thread });
  }

  /** Appends are serialised: each entry extends the tip the previous one made. */
  private append(body: EntryBody): Promise<CID> {
    const wallet = this.wallet;
    if (!wallet) return Promise.reject(new Error("runtime: no wallet, cannot sign a log entry"));
    const p = this.appending.then(() => appendEntry(this.store, wallet, body, this.now()));
    this.appending = p.catch(() => {});
    return p.then(({ cid }) => { this.kick(); return cid; });
  }

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

  private async process(entry: CID, e: LogEntry): Promise<void> {
    if (e.genesis) {
      const g = await this.store.get(e.genesis);
      if (!isGenesis(g)) throw new Error(`#${e.n}: genesis record is malformed`);
      this.genesis = g;
    }
    const g = this.genesis;
    if (!g) throw new Error(`#${e.n}: no genesis`);
    if (!isLogEntry(e) || !verifyEntry(e, g.identity)) throw new Error(`#${e.n} ${short(entry)}: bad log entry signature; stopping`);

    if (e.genesis) { this.say(`#${e.n} genesis: ${g.handle}@${g.domain}, owner ${short(g.owner)}, ${g.subscriptions.length} subscriptions`); return; }

    if (e.wake) {
      const t = this.sleepers.get(e.wake.toString());
      if (!t || t.deadline! > stampNs(e.time)) { this.say(`#${e.n} wake ${short(e.wake)}: not sleeping or not due; nothing runs`); return; }
      this.say(`#${e.n} wake → ${short(t.origin)}`);
      await this.wakeSleeper(t, entry, e);
      return;
    }

    if (e.envelope) {
      const box = e.box ?? "";
      const env = await this.store.get(e.envelope).catch(() => undefined);
      const sender = senderOf(env);
      const what = `#${e.n} envelope ${short(e.envelope)} in ${box} from ${sender ? short(sender) : "?"}`;
      const replyTo = await this.replyToOf(e.body);
      if (replyTo !== undefined) {
        if (replyTo === null || !sender) { this.say(`${what}: replyTo is not a CID; recorded, nothing runs`); return; }
        const t = await this.awaiter(replyTo, sender);
        if (!t) { this.say(`${what}: reply to ${short(replyTo)}, which no thread awaits from this sender; recorded, nothing runs`); return; }
        this.say(`${what}: reply to ${short(replyTo)} → ${short(t)}`);
        await this.step(t, entry, e, undefined, { envelope: e.envelope, body: e.body!, box, sender, replyTo });
        return;
      }
      const sub = sender ? g.subscriptions.find((s) => matches(s, sender, box)) : undefined;
      if (!sub || !sender) { this.say(`${what}: no subscription; recorded, nothing runs`); return; }
      const origin: ThreadOrigin = {
        kind: "thread", program: sub.handler, args: { envelope: e.envelope, body: e.body, box, sender },
        launchedBy: e.envelope, input: entry, at: stampMs(e.time),
      };
      const t = await this.store.chains.open(origin);
      this.say(`${what} → ${await this.programName(sub.handler)} ${short(t)}`);
      await this.run(t);
    }
  }

  /**
   * The `replyTo` of an admitted envelope's plaintext body: a CID, null if
   * present but not a CID, or undefined if the body has none (or cannot be
   * read: then it is not a reply).
   */
  private async replyToOf(body: CID | undefined): Promise<CID | null | undefined> {
    if (!body) return undefined;
    try {
      const b = decode<Record<string, unknown>>(await this.store.bytes(body));
      if (!b || typeof b !== "object" || !("replyTo" in b)) return undefined;
      return isCID(b.replyTo) ? b.replyTo : null;
    } catch {
      return undefined;
    }
  }

  /**
   * The thread whose tip awaits `envelope`, which was sealed to `sender`: the
   * tip's seal call for it names the emit record, and that names the recipient.
   */
  private async awaiter(envelope: CID, sender: string): Promise<CID | undefined> {
    for await (const t of this.store.live.awaiting(envelope)) {
      const tip = await this.tipOf(t) as (ThreadUpdate & { calls?: CID[] }) | undefined;
      if (tip?.state !== "waiting" || !tip.awaits?.some((a) => a.equals(envelope))) continue;
      for (const c of tip.calls ?? []) {
        const a = await this.store.get(c).catch(() => undefined);
        if (!isAttested(a) || a.op !== "seal" || !encode(decode(a.result)).cid.equals(envelope)) continue;
        const e = await this.store.get(a.request as CID).catch(() => undefined);
        if (isEmit(e) && e.to === sender) return t;
      }
    }
    return undefined;
  }

  // ------------------------------------------------------------ threads

  private async programOf(o: ThreadOrigin): Promise<Program> {
    const p = await this.store.get(o.program).catch(() => undefined);
    if (!isProgram(p)) throw new Error(`program ${short(o.program)} is not a program record in this store`);
    return p;
  }

  private async programName(c: CID): Promise<string> {
    const p = await this.store.get(c).catch(() => undefined);
    return isProgram(p) ? p.name : short(c);
  }

  /** Start a thread that has no updates yet, by its program's kind. */
  private async run(origin: CID): Promise<void> {
    const o = await this.store.get<ThreadOrigin>(origin);
    const p = await this.programOf(o).catch(() => undefined);
    if (p && "wasm" in p.code) await this.step(origin, o.input!, await this.store.get<LogEntry>(o.input!), undefined);
    else await this.runShell(origin);
  }

  /** After a restart: carry on with a thread that is not at rest. */
  private async resume(origin: CID): Promise<void> {
    const o = await this.store.get<ThreadOrigin>(origin);
    const tip = await this.tipOf(origin);
    if (tip && tip.state !== "running" && tip.state !== "waiting") return;
    const p = await this.programOf(o).catch(() => undefined);
    if (p && "wasm" in p.code) {
      if (!tip) { this.say(`${short(origin)} ${p.name}: stepping (interrupted before its first step ended)`); await this.run(origin); }
      else await this.maybeStep(origin, tip);
      return;
    }
    if (this.live.has(origin.toString())) return;
    this.say(`${short(origin)} re-executing from its origin`);
    await this.runShell(origin);
  }

  /**
   * A program thread waiting on launched threads: when all are at rest, step it
   * with their resolution. The step is driven by the entry that brought the
   * last of them to rest (the latest `input` among their final updates).
   */
  private async maybeStep(origin: CID, tip: ThreadUpdate): Promise<void> {
    if (tip.state !== "waiting" || !tip.waitingOn?.length) return;
    const resolved: Resolved[] = [];
    let driver: { cid: CID; e: LogEntry } | undefined;
    for (const w of tip.waitingOn) {
      const u = await this.tipOf(w);
      if (!u || (u.state !== "finished" && u.state !== "errored")) return;
      resolved.push(compact({ thread: w, state: u.state, result: u.result, error: u.error }) as unknown as Resolved);
      const e = await this.store.get<LogEntry>(u.input!);
      if (!driver || e.n > driver.e.n) driver = { cid: u.input!, e };
    }
    await this.step(origin, driver!.cid, driver!.e, resolved);
  }

  /** A thread came to rest for good: step the program that launched it, if it now can. */
  private async rested(child: CID): Promise<void> {
    const o = await this.store.get<ThreadOrigin>(child);
    const parent = o.launchedBy;
    if (!parent) return;
    const p = await this.store.get(parent).catch(() => undefined) as { kind?: string } | undefined;
    if (p?.kind !== "thread") return;
    const tip = await this.tipOf(parent);
    if (tip?.state === "waiting" && tip.waitingOn?.some((w) => w.equals(child))) await this.maybeStep(parent, tip);
  }

  // ------------------------------------------------------------ program steps

  /** One step of a handler program over `entry`: run it, record its update, send what it emitted, start what it launched. */
  private async step(origin: CID, entry: CID, e: LogEntry, resolved: Resolved[] | undefined, reply?: Reply): Promise<void> {
    const key = origin.toString();
    if (this.stepping.has(key) || this.stopped) return;
    this.stepping.add(key);
    let after: { emits: Array<{ emit: CID; envelope: CID }>; launched: CID[]; rested: boolean };
    try {
      const o = await this.store.get<ThreadOrigin>(origin);
      const prog = await this.programOf(o);
      if (!("wasm" in prog.code)) throw new Error("not a wasm program");
      let n = 1;
      for await (const c of this.store.chains.history(origin)) if (!c.equals(origin)) n++;
      const tipCid = await this.store.chains.tip(origin);
      const at = stampMs(e.time);
      const clock = new ThreadClock();
      clock.drive(stampNs(e.time));
      const random = entropy(entry, origin);

      const calls: CID[] = [], launched: CID[] = [], kept: CID[] = [], emits: CID[] = [], sealed: CID[] = [], awaits: CID[] = [], heads: CID[] = [];
      const moves: Array<{ name: string; tree: CID }> = [];
      const children: ThreadOrigin[] = [];
      const g = this.genesis!;
      const input = encode(compact({
        kind: "step", thread: origin, step: n, entry, args: o.args, programs: g.programs, resolved,
        tip: tipCid.equals(origin) ? undefined : tipCid, reply: reply && compact({ ...reply }), peers: g.peers, defaults: g.defaults,
      })).bytes;

      const attest = async (op: Attested["op"], request: Uint8Array | CID, perform: () => Promise<Uint8Array>): Promise<Uint8Array> => {
        const i = calls.length;
        const w = await this.witness?.find(origin, n, i);
        let result: Uint8Array;
        if (w) {
          if (w.op !== op || !Buffer.from(encode(w.request).bytes).equals(encode(request).bytes)) {
            throw new Diverged(`${short(origin)} step ${n} call ${i}: the request differs from the recorded one`);
          }
          result = w.result;
        } else if (this.wallet) {
          result = await perform();
        } else {
          throw new NoWitness(`${short(origin)} step ${n} call ${i} (${op}): no wallet and no recorded answer`);
        }
        const rec: Attested = { kind: "attested", thread: origin, step: n, i, op, request, result };
        calls.push(await this.store.put(rec));
        return result;
      };

      const out = await runProgram(await loadModule(this.store, prog.code.wasm), {
        input: () => input,
        get: (c) => this.store.bytes(c),
        put: async (bytes) => this.store.put(decode(bytes)),
        putBlock: async (c, bytes) => {
          if (!hashMatches(c, bytes)) throw new Error(`putblock: bytes do not hash to ${c}`);
          await this.store.putBlock(c, bytes);
        },
        keep: async (c) => {
          if (!(await this.store.has(c))) throw new Error(`keep: ${c} is not in the store`);
          kept.push(c);
        },
        launch: async (program, args) => {
          if (awaits.length) throw new Error("launch: this step already awaits a reply; a step waits on threads or on replies, not both");
          if (!isProgram(await this.store.get(program).catch(() => undefined))) throw new Error(`launch: ${program} is not a program`);
          const child: ThreadOrigin = { kind: "thread", program, args: await this.store.get(args), launchedBy: origin, input: entry, at, nonce: `${n}.${launched.length}` };
          const c = encode(child).cid;
          children.push(child);
          launched.push(c);
          return c;
        },
        emit: async (c) => {
          const rec = await this.store.get(c);
          if (!isEmit(rec)) throw new Error("emit: want {kind: \"emit\", to, handle?, domain?, box, body}");
          const bytes = await this.store.bytes(rec.body);
          const env = await attest("seal", c, async () => {
            if (!this.outbox?.seal) throw new Error("emit: no edge to seal the envelope");
            return encode(await this.outbox.seal(rec, bytes, at)).bytes;
          });
          const cid = await this.store.put(decode(env));
          emits.push(c);
          sealed.push(cid);
          return cid;
        },
        awaitReply: async (c) => {
          if (!sealed.some((s) => s.equals(c))) throw new Error("await: not an envelope this step emitted");
          if (launched.length) throw new Error("await: this step launched threads; a step waits on threads or on replies, not both");
          if (!awaits.some((a) => a.equals(c))) awaits.push(c);
        },
        head: (name) => headTree(this.store, name),
        advance: async (name, tree) => {
          if (!isHeadName(name)) throw new Error(`advance: bad head name ${JSON.stringify(name)}`);
          if (!(await this.store.has(tree))) throw new Error(`advance: tree ${tree} is not in the store`);
          moves.push({ name, tree });
        },
        wallet: async (frame) => {
          if (!WALLET_CALLS.has(frame[0])) throw new Error(`wallet: call ${frame[0]} is not allowed to programs`);
          return attest("wallet", frame, async () => Uint8Array.from(await this.wire!.transmitToWallet([...frame])));
        },
        fatal: (err) => err instanceof Stopped || err instanceof Diverged || err instanceof NoWitness,
      }, { name: prog.name, clock: () => clock.read(), random });

      if (this.stopped) return;
      const state: ThreadState = out.exitCode !== 0 ? "errored" : launched.length || awaits.length ? "waiting" : "finished";
      for (const c of children) await this.store.chains.open(c);
      if (state !== "errored") for (const m of moves) heads.push(await advanceHead(this.store, m.name, m.tree, { thread: origin, input: entry, at }));
      const text = (b: Uint8Array) => Buffer.from(b).toString("utf8").trim();
      await this.store.chains.append(origin, compact({
        state, step: n, input: entry, at,
        waitingOn: state === "waiting" && launched.length ? launched : undefined,
        awaits: state === "waiting" && awaits.length ? awaits : undefined,
        calls: calls.length ? calls : undefined,
        launched: launched.length ? launched : undefined,
        kept: kept.length ? kept : undefined,
        emits: emits.length ? emits : undefined,
        heads: heads.length ? heads : undefined,
        result: { exitCode: out.exitCode, stdout: out.stdout, stderr: out.stderr },
        error: state === "errored" ? { kind: "blew-up", message: text(out.stderr).split("\n").at(-1) || `exit ${out.exitCode}` } : undefined,
      }));
      this.say(`${short(origin)} ${prog.name} step ${n} → ${state}${calls.length ? ` · ${calls.length} attested` : ""}${kept.length ? ` · ${kept.length} kept` : ""}${launched.length ? ` · launched ${launched.map(short).join(",")}` : ""}${emits.length ? ` · ${emits.length} emitted` : ""}${heads.length ? ` · moved ${moves.map((m) => `${m.name}→${short(m.tree)}`).join(",")}` : ""}${awaits.length ? ` · awaits ${awaits.map(short).join(",")}` : ""}${state === "errored" ? ` · ${text(out.stderr)}` : ""}`);
      after = { emits: emits.map((emit, i) => ({ emit, envelope: sealed[i] })), launched, rested: state !== "waiting" };
    } catch (err) {
      if (err instanceof Stopped || this.stopped) return;
      this.say(`${short(origin)} step ${err instanceof Diverged ? "DIVERGED" : err instanceof NoWitness ? "cannot run" : "failed"}: ${(err as Error).message}`);
      if (err instanceof Diverged || err instanceof NoWitness) return;
      await this.store.chains.append(origin, { state: "errored", input: entry, at: stampMs(e.time), error: { kind: "blew-up", message: (err as Error).message } }).catch(() => {});
      after = { emits: [], launched: [], rested: true };
    } finally {
      this.stepping.delete(key);
    }
    // The step is recorded: now its effects. Launched threads may come to rest
    // within this call and step this thread again (it is no longer mid-step).
    for (const x of after.emits) await this.send(origin, x.emit, x.envelope);
    for (const c of after.launched) await this.run(c);
    if (after.rested) await this.rested(origin);
  }

  private async send(thread: CID, emit: CID, envelope: CID): Promise<void> {
    if (!this.outbox) return;
    const rec = await this.store.get<Emit>(emit);
    try {
      await this.outbox.send({ ...rec, emit, thread, bytes: await this.store.bytes(rec.body), envelope: await this.store.get(envelope), cid: envelope });
    } catch (e) {
      this.say(`${short(thread)} emit ${short(emit)}: ${(e as Error).message}`);
    }
  }

  // ------------------------------------------------------------ the shell

  /** Start (or re-execute) a shell thread and step it until it rests or ends. */
  private async runShell(origin: CID): Promise<void> {
    if (this.live.has(origin.toString())) return;
    const o = await this.store.get<ThreadOrigin>(origin);
    const history: CID[] = [];
    for await (const c of this.store.chains.history(origin)) if (!c.equals(origin)) history.push(c);
    const launch = await this.store.get<LogEntry>(o.input!);
    if (!isLogEntry(launch)) throw new Error(`thread ${short(origin)}: input is not a log entry`);
    const t = new Live(origin, o, history);
    t.drive(o.input!, launch);
    this.live.set(origin.toString(), t);
    void this.shellBody(t);
    await t.step.promise;
  }

  /** Wake a sleeper: drive it by `entry` and step it until it rests or ends. */
  private async wakeSleeper(t: Live, entry: CID, e: LogEntry): Promise<void> {
    this.sleepers.delete(t.origin.toString());
    t.deadline = undefined;
    t.drive(entry, e);
    t.step = deferred();
    const wake = t.wake!;
    t.wake = undefined;
    wake();
    await t.step.promise;
  }

  private async shellBody(t: Live): Promise<void> {
    let ended = false;
    try {
      await this.appendShell(t, { state: "running" });
      const args = t.o.args;
      if (!isShellArgs(args)) {
        await this.appendShell(t, { state: "errored", error: { kind: "cant-do", message: "shell wants {cmd, tree, cwd?, env?}" } });
        ended = true;
        return;
      }
      const modules = await loadShellModules(this.store);
      const r = await runShell(this.store, {
        tree: args.tree, cmd: args.cmd, cwd: args.cwd, env: args.env, modules,
        clock: () => t.clock.read(),
        random: (len) => t.random(len),
        sleep: (clocks) => this.sleep(t, clocks),
      });
      await this.appendShell(t, { state: "finished", result: { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, tree: r.tree } });
      ended = true;
    } catch (e) {
      if (e instanceof Stopped) return;
      if (e instanceof Diverged) { this.say(`${short(t.origin)} DIVERGED: ${e.message}`); return; }
      await this.appendShell(t, { state: "errored", error: { kind: "blew-up", message: (e as Error).message } }).then(() => { ended = true; }, (e2) => {
        if (!(e2 instanceof Stopped)) this.say(`${short(t.origin)}: ${(e2 as Error).message}`);
      });
    } finally {
      this.live.delete(t.origin.toString());
      if (ended && !this.stopped) await this.rested(t.origin).catch((e) => this.say(`${short(t.origin)}: ${(e as Error).message}`));
      t.step.resolve();
    }
  }

  /**
   * A sleep: if the earliest deadline is not after the thread's "now", return
   * at once. Otherwise rest `waiting` until it, and resume when a wake entry
   * for it is processed (or, re-executing, when the chain says that already happened).
   */
  private async sleep(t: Live, clocks: Array<{ timeout: bigint; absolute: boolean }>): Promise<void> {
    const now = t.clock.peek();
    let deadline: bigint | undefined;
    for (const c of clocks) {
      const d = c.absolute ? c.timeout : now + c.timeout;
      if (deadline === undefined || d < deadline) deadline = d;
    }
    if (deadline === undefined || deadline <= now) return;
    const until = Number((deadline + 999_999n) / 1_000_000n);
    await this.appendShell(t, { state: "waiting", until });

    // Re-executing: the chain may already record the wake. Replay it from its entry.
    const recorded = t.history[t.pos];
    if (recorded) {
      const u = await this.store.get<ThreadUpdate>(recorded);
      t.drive(u.input!, await this.store.get<LogEntry>(u.input!));
      await this.appendShell(t, { state: "running" });
      return;
    }
    t.deadline = deadline;
    this.sleepers.set(t.origin.toString(), t);
    this.onSleep?.(t.origin, until);
    await new Promise<void>((resolve) => {
      t.wake = resolve;
      t.step.resolve(); // resting: this step is over
    });
    await this.appendShell(t, { state: "running" });
  }

  /** Append the thread's next update, or verify it against the chain when re-executing. */
  private async appendShell(t: Live, body: Record<string, unknown>): Promise<CID> {
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
    const bits: string[] = [];
    if (typeof full.until === "number") bits.push(`until ${full.until}`);
    const res = full.result as { exitCode?: number } | undefined;
    if (res) bits.push(`exit ${res.exitCode}`);
    const err = full.error as ThreadUpdate["error"];
    if (err) bits.push(`${err.kind}: ${err.message}`);
    this.say(`${short(t.origin)} shell ${from} → ${String(full.state)}${bits.length ? ` (${bits.join(", ")})` : ""}`);
    return cid;
  }

  private async tipOf(thread: CID): Promise<ThreadUpdate | undefined> {
    const tip = await this.store.chains.tip(thread);
    return tip.equals(thread) ? undefined : this.store.get<ThreadUpdate>(tip);
  }
}

// ---------------------------------------------------------------- replay

/**
 * A Witness over a store's recorded steps: every attested record its thread
 * chains list, by (thread, step, i). Feed it to a fresh Runtime with no wallet
 * to replay a log.
 */
export async function witnessFrom(store: Store): Promise<Witness> {
  const byKey = new Map<string, Attested>();
  for await (const t of store.edges.query({ kind: "thread" })) {
    for await (const u of store.chains.history(t)) {
      if (u.equals(t)) continue;
      const calls = (await store.get(u) as { calls?: unknown }).calls;
      if (!Array.isArray(calls)) continue;
      for (const c of calls) {
        if (!isCID(c)) continue;
        const a = await store.get(c);
        if (isAttested(a)) byKey.set(`${a.thread} ${a.step} ${a.i}`, a);
      }
    }
  }
  return { find: async (thread, step, i) => byKey.get(`${thread} ${step} ${i}`) };
}

// ---------------------------------------------------------------- helpers

/** The sender identity key of an envelope record, or undefined. */
function senderOf(env: unknown): string | undefined {
  const k = (env as { sender?: { identityKey?: unknown } } | undefined)?.sender?.identityKey;
  return typeof k === "string" && /^0[23][0-9a-f]{64}$/.test(k) ? k : undefined;
}

const GIT_RAW = 0x78, RAW = 0x55, DAG_CBOR = 0x71, SHA1 = 0x11, SHA2_256 = 0x12;

/** Does `bytes` hash to `cid`? git-raw/sha1, raw/sha2-256 and dag-cbor/sha2-256 only. */
function hashMatches(cid: CID, bytes: Uint8Array): boolean {
  const alg = cid.multihash.code === SHA1 ? "sha1" : cid.multihash.code === SHA2_256 ? "sha256" : undefined;
  if (!alg || ![GIT_RAW, RAW, DAG_CBOR].includes(cid.code)) return false;
  return Buffer.from(createHash(alg).update(bytes).digest()).equals(cid.multihash.digest);
}

/** Drop undefined fields (dag-cbor has no undefined). */
function compact(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}

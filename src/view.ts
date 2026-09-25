// Read models over the graph, shared by the CLI, the web browser and its JSON
// API. Everything is read back from blocks on each call; nothing is cached
// across calls except by Watcher, which only remembers what it has shown.

import type { CID } from "multiformats/cid";
import { fmt, isCID, parse } from "./cid.ts";
import { NotFound, type Store } from "./store.ts";
import type { Block, Emission, NodeOrigin, NodeUpdate, ThreadOrigin, ThreadState, ThreadUpdate } from "./types.ts";
import { isProgram } from "./records.ts";
import { isSettled, nodesOf, nodeView, short, tipOf } from "./graph.ts";

export { short };

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Block values as plain JSON: CIDs as strings, bytes as "<n bytes>". */
export function jsonify(v: unknown): Json {
  if (v === null || v === undefined) return null;
  if (isCID(v)) return fmt(v);
  if (v instanceof Uint8Array) return `<${v.length} bytes>`;
  if (Array.isArray(v)) return v.map(jsonify);
  if (typeof v === "object") {
    const o: Record<string, Json> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = jsonify(x);
    return o;
  }
  return v as Json;
}

export function oneLine(s: unknown, max = 100): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// ---------------------------------------------------------------- CID lookup

export class Ambiguous extends Error {
  readonly candidates: string[];
  constructor(prefix: string, candidates: string[]) {
    super(`"${prefix}" matches ${candidates.length} origins:\n${candidates.map((c) => `  ${c}`).join("\n")}`);
    this.candidates = candidates;
  }
}

type PrefixStore = Store & { findByPrefix?(prefix: string): Promise<CID[]> };

/** A full CID (any block), or a prefix of a thread/node origin — with or without the "bafy". */
export async function resolveCid(store: PrefixStore, input: string): Promise<CID> {
  const s = input.trim().replace(/^skein:(\/\/)?/, "");
  let full: CID | undefined;
  try { full = parse(s); } catch { /* not a whole CID; try it as a prefix */ }
  if (full) {
    if (await store.has(full)) return full;
    throw new NotFound(s);
  }
  if (!/^[a-z2-7]+$/.test(s)) throw new Error(`not a CID or CID prefix: ${input}`);
  const prefixes = s.startsWith("bafy") ? [s] : [`bafy${s}`, s];
  const hits = new Map<string, CID>();
  for (const p of prefixes) for (const c of await findByPrefix(store, p)) hits.set(fmt(c), c);
  if (hits.size === 1) return [...hits.values()][0];
  if (hits.size === 0) throw new NotFound(input);
  throw new Ambiguous(input, [...hits.keys()].sort());
}

async function findByPrefix(store: PrefixStore, prefix: string): Promise<CID[]> {
  if (store.findByPrefix) return store.findByPrefix(prefix);
  const out: CID[] = [];
  for await (const c of store.edges.query({})) if (fmt(c).startsWith(prefix)) out.push(c);
  return out;
}

// ---------------------------------------------------------------- labels

/** The program's name for a v2 thread (runner for a v1 one). */
export async function programName(store: Store, o: ThreadOrigin): Promise<string> {
  if (!o.program) return o.runner ?? "?";
  const p = await store.get(o.program).catch(() => undefined);
  return isProgram(p) ? p.name : short(o.program);
}

export function labelOf(o: ThreadOrigin, name: string): string {
  const a = (o.args ?? o.spec ?? {}) as Record<string, unknown>;
  switch (name) {
    case "loop": return oneLine(a.prompt ?? a.text, 200);
    case "bash": case "shell": return `$ ${oneLine(a.cmd, 200)}`;
    case "david": return oneLine(a.say ?? String(a.page ?? "").split("\n").find((l) => l.trim()) ?? a.prompt, 200);
    default: return oneLine(JSON.stringify(jsonify(a)), 200);
  }
}

// ---------------------------------------------------------------- the person

/** The sender of the message that launched `o`, if a message did (a session's person). */
export async function launcherOf(store: Store, o: ThreadOrigin): Promise<string | undefined> {
  if (!o.launchedBy) return undefined;
  const b = await store.get<{ kind?: unknown; from?: unknown } & Block>(o.launchedBy).catch(() => undefined);
  return b?.kind === "message" && typeof b.from === "string" ? b.from : undefined;
}

/** Whether `thread` is waiting for a message from the person who launched it (their turn). */
export async function waitingOnPerson(store: Store, thread: CID): Promise<boolean> {
  const o = await store.get<ThreadOrigin>(thread);
  if (o.kind !== "thread") return false;
  const tip = await tipOf(store, thread);
  if (tip?.state !== "waiting" || !tip.waitingFrom) return false;
  return tip.waitingFrom === (await launcherOf(store, o));
}

/** Stop condition for watchers: the thread settled, or its turn ended in front of its person. */
export async function atRest(store: Store, cid: CID): Promise<boolean> {
  return isSettled((await tipOf(store, cid))?.state) || (await waitingOnPerson(store, cid));
}

/** A node's thread, or the thread itself. */
export async function threadOf(store: Store, cid: CID): Promise<CID | undefined> {
  const b = await store.get<ThreadOrigin | NodeOrigin>(cid);
  if (b.kind === "thread") return cid;
  if (b.kind === "node" && isCID(b.thread)) return b.thread;
  return undefined;
}

// ---------------------------------------------------------------- lists

export interface ThreadRow {
  cid: string;
  runner: string;        // the program's name
  state: ThreadState | "new";
  at: number;
  tipAt: number;
  label: string;
  launchedBy?: string;
  davidWaiting?: string; // set (to this thread) when it waits on the person who launched it
}

export interface ListOptions { all?: boolean; state?: ThreadState[]; runner?: string; limit?: number }

/** Most recent activity first. Default: top-level threads (launched by a message, or v1 parent-less). */
export async function listThreads(store: Store, o: ListOptions = {}): Promise<ThreadRow[]> {
  const rows: ThreadRow[] = [];
  const limit = o.limit ?? 50;
  for await (const cid of store.edges.query({ kind: "thread", state: o.state, orderBy: "tipAt" })) {
    const origin = await store.get<ThreadOrigin>(cid);
    if (!o.all && origin.launchedBy && (await store.get<{ kind?: unknown } & Block>(origin.launchedBy).catch(() => undefined))?.kind !== "message") continue;
    const row = await threadRow(store, cid);
    if (o.runner && row.runner !== o.runner) continue;
    rows.push(row);
    if (rows.length >= limit) break;
  }
  return rows;
}

export async function threadRow(store: Store, cid: CID): Promise<ThreadRow> {
  const origin = await store.get<ThreadOrigin>(cid);
  const tip = await tipOf(store, cid);
  const runner = await programName(store, origin);
  const row: ThreadRow = { cid: fmt(cid), runner, state: tip?.state ?? "new", at: origin.at, tipAt: tip?.at ?? origin.at, label: labelOf(origin, runner) };
  if (origin.launchedBy) row.launchedBy = fmt(origin.launchedBy);
  if (await waitingOnPerson(store, cid)) row.davidWaiting = row.cid;
  return row;
}

// ---------------------------------------------------------------- one thread

export interface HistoryRow {
  cid: string; seq: number; at: number; state: ThreadState;
  waitingOn?: string[]; waitingFrom?: string; until?: number; resolution?: string; note?: string; error?: string;
}

export interface LaunchView {
  cid: string; runner: string; label: string; state: ThreadState | "new";
  note?: string; error?: string;
  thinking?: string; // v1 model threads only; v2 thinking is an emission on the step
  reply?: string;    // v1 david threads only
}

export type EmitView = { type: string; [k: string]: Json | LaunchView | undefined } & { run?: LaunchView };

export interface NodeViewRow {
  cid: string; at: number; prev: string[];
  asked?: string; // one line for what started the node, when the emissions don't already say it
  emits: EmitView[];
  rest?: { state: ThreadState; waitingOn?: string[] };
}

export interface ThreadView extends ThreadRow {
  spec: Json;      // the program's args
  program?: string;
  parent?: string; // the thread whose step launched this one
  history: HistoryRow[];
  nodes: NodeViewRow[];
  settled: boolean;
  version: number; // grows whenever anything shown here changes (sum of chain lengths)
}

export async function threadView(store: Store, cid: CID): Promise<ThreadView> {
  const origin = await store.get<ThreadOrigin>(cid);
  if (origin.kind !== "thread") throw new Error(`not a thread: ${fmt(cid)}`);
  const row = await threadRow(store, cid);
  const history: HistoryRow[] = [];
  for await (const c of store.chains.history(cid)) {
    if (c.equals(cid)) continue;
    const u = await store.get<ThreadUpdate>(c);
    history.push(stripUndef({
      cid: fmt(c), seq: u.seq, at: u.at, state: u.state,
      waitingOn: u.waitingOn?.map(fmt), waitingFrom: u.waitingFrom, until: u.until, resolution: u.resolution && fmt(u.resolution), note: u.note,
      error: u.error && `${u.error.kind}: ${u.error.message}`,
    }));
  }
  let version = history.length;
  const nodes: NodeViewRow[] = [];
  for (const n of await nodesOf(store, cid)) {
    const v = await nodeView(store, n);
    version += v.emits.length + (v.rest ? 1 : 0);
    const emits: EmitView[] = [];
    for (const e of v.emits) {
      const ev = jsonify(e) as EmitView;
      if (e.type === "launched" && isCID(e.thread)) {
        const run = await launchView(store, e.thread);
        version += run.version;
        ev.run = run.view;
      }
      emits.push(ev);
    }
    nodes.push(stripUndef({
      cid: fmt(n), at: v.origin.at, prev: v.origin.prev.map(fmt), asked: await asked(store, row.runner, v.origin), emits,
      rest: v.rest && stripUndef({ state: v.rest.state, waitingOn: v.rest.waitingOn?.map(fmt) }),
    }));
  }
  const view: ThreadView = { ...row, spec: jsonify(origin.args ?? origin.spec), history, nodes, settled: isSettled(row.state as ThreadState), version };
  if (origin.program) view.program = fmt(origin.program);
  if (origin.launchedBy) {
    const by = await store.get<NodeOrigin>(origin.launchedBy).catch(() => undefined);
    if (by?.kind === "node" && isCID(by.thread)) view.parent = fmt(by.thread);
  }
  return view;
}

async function launchView(store: Store, t: CID): Promise<{ view: LaunchView; version: number }> {
  const o = await store.get<ThreadOrigin>(t);
  const tip = await tipOf(store, t);
  const runner = await programName(store, o);
  const view: LaunchView = stripUndef({
    cid: fmt(t), runner, label: labelOf(o, runner), state: tip?.state ?? "new",
    note: tip?.note, error: tip?.error && `${tip.error.kind}: ${tip.error.message}`,
  });
  return { view, version: tip?.seq ?? 0 };
}

async function asked(store: Store, runner: string, n: NodeOrigin): Promise<string | undefined> {
  const r = n.request as Record<string, unknown> | string | undefined;
  if (typeof r === "string") return r;
  if (!r || typeof r !== "object") return undefined;
  if (runner === "loop" && Array.isArray(r.messages)) {
    const last = r.messages.at(-1) as { role?: string; content?: string } | undefined;
    if (last?.role !== "user") return undefined; // tool results: the tool_result emissions say it
    return `${n.prev.length ? "David" : "Prompt"}: ${last.content ?? ""}`;
  }
  if (typeof r.cmd === "string") return `$ ${r.cmd}`;
  return undefined;
}

function stripUndef<T extends object>(o: T): T {
  for (const k of Object.keys(o) as Array<keyof T>) if (o[k] === undefined) delete o[k];
  return o;
}

// ---------------------------------------------------------------- watching

export interface WatchEvent {
  at: number;
  depth: number;             // 0 = the watched thread, 1 = launched by it, …
  thread: CID;
  runner: string;            // the program's name
  node?: CID;                // set for emissions and rests
  update?: ThreadUpdate;     // a thread state change
  emit?: Emission;
  rest?: NodeUpdate["rest"];
  label?: string;            // for launched emissions: the launched thread's label
}

/** Reports each update in a thread's tree (its nodes, the threads they launched, theirs…) once. */
export class Watcher {
  private readonly store: Store;
  private readonly root: CID;
  private readonly seen = new Set<string>();
  private readonly tips = new Map<string, string>();
  private readonly launched = new Map<string, CID[]>(); // node → threads it launched

  constructor(store: Store, root: CID) { this.store = store; this.root = root; }

  /** New events since the last poll, oldest first. */
  async poll(): Promise<WatchEvent[]> {
    const out: WatchEvent[] = [];
    await this.visitThread(this.root, 0, out);
    return out.sort((a, b) => a.at - b.at);
  }

  private async fresh(chain: CID): Promise<CID[]> {
    const tip = fmt(await this.store.chains.tip(chain));
    if (this.tips.get(fmt(chain)) === tip) return [];
    this.tips.set(fmt(chain), tip);
    const out: CID[] = [];
    for await (const c of this.store.chains.history(chain)) {
      if (c.equals(chain) || this.seen.has(fmt(c))) continue;
      this.seen.add(fmt(c));
      out.push(c);
    }
    return out;
  }

  private async visitThread(t: CID, depth: number, out: WatchEvent[]) {
    const origin = await this.store.get<ThreadOrigin>(t);
    const runner = await programName(this.store, origin);
    for (const c of await this.fresh(t)) {
      const u = await this.store.get<ThreadUpdate>(c);
      out.push({ at: u.at, depth, thread: t, runner, update: u });
    }
    for (const n of await nodesOf(this.store, t)) {
      const k = fmt(n);
      for (const c of await this.fresh(n)) {
        const u = await this.store.get<NodeUpdate>(c);
        const ev: WatchEvent = { at: u.at, depth, thread: t, runner, node: n };
        if (u.emit) {
          ev.emit = u.emit;
          if (u.emit.type === "launched" && isCID(u.emit.thread)) {
            this.launched.set(k, [...(this.launched.get(k) ?? []), u.emit.thread]);
            const lo = await this.store.get<ThreadOrigin>(u.emit.thread);
            ev.label = labelOf(lo, await programName(this.store, lo));
          }
        }
        if (u.rest) ev.rest = u.rest;
        out.push(ev);
      }
      for (const l of this.launched.get(k) ?? []) await this.visitThread(l, depth + 1, out);
    }
  }
}

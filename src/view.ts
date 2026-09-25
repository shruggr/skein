// Read models over the graph, shared by the CLI, the web browser and its JSON
// API. Everything is read back from blocks on each call; nothing is cached
// across calls except by Watcher, which only remembers what it has shown.

import type { CID } from "multiformats/cid";
import { fmt, isCID, parse } from "./cid.ts";
import { NotFound, type Store } from "./store.ts";
import type { Emission, NodeOrigin, NodeUpdate, ThreadOrigin, ThreadState, ThreadUpdate } from "./types.ts";
import { emitsOf, headNode, isSettled, nodesOf, nodeView, short, tipOf } from "./runners/util.ts";

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

export function labelOf(o: ThreadOrigin): string {
  const spec = (o.spec ?? {}) as Record<string, unknown>;
  switch (o.runner) {
    case "loop": return oneLine(spec.prompt, 200);
    case "shell": return `$ ${oneLine(spec.cmd, 200)}`;
    case "david": return oneLine(spec.say ?? String(spec.page ?? "").split("\n").find((l) => l.trim()) ?? spec.prompt, 200);
    case "model": return `${spec.model ?? "model"} · ${Array.isArray(spec.messages) ? spec.messages.length : 0} messages`;
    default: return oneLine(JSON.stringify(jsonify(spec)), 200);
  }
}

// ---------------------------------------------------------------- David

/** The unsettled david thread a reply to `cid` should resolve: itself, or the one its loop waits on. */
export async function findWaitingDavid(store: Store, cid: CID): Promise<CID | undefined> {
  const origin = await store.get<ThreadOrigin | NodeOrigin>(cid);
  if (origin.kind !== "thread") return undefined;
  if (origin.runner === "david") return isSettled((await tipOf(store, cid))?.state) ? undefined : cid;
  const tip = await tipOf(store, cid);
  const candidates = [...(tip?.waitingOn ?? [])];
  const head = await headNode(store, cid);
  if (head) for (const l of emitsOf((await nodeView(store, head)).emits, "launched")) if (l.label === "david") candidates.push(l.thread);
  for (const c of candidates) {
    const o = await store.get<ThreadOrigin>(c);
    // Only a waiting one: a david thread not yet started hasn't been put in front of him.
    if (o.runner === "david" && (await tipOf(store, c))?.state === "waiting") return c;
  }
  return undefined;
}

/** Stop condition for watchers: the thread settled, or its turn ended in front of David. */
export async function atRest(store: Store, cid: CID): Promise<boolean> {
  return isSettled((await tipOf(store, cid))?.state) || (await findWaitingDavid(store, cid)) !== undefined;
}

// ---------------------------------------------------------------- lists

export interface ThreadRow {
  cid: string;
  runner: string;
  state: ThreadState | "new";
  at: number;
  tipAt: number;
  label: string;
  launchedBy?: string;
  davidWaiting?: string; // a david thread this one waits on, if David owes it a reply
}

export interface ListOptions { all?: boolean; state?: ThreadState[]; runner?: string; limit?: number }

export async function listThreads(store: Store, o: ListOptions = {}): Promise<ThreadRow[]> {
  const rows: ThreadRow[] = [];
  const it = store.edges.query({ kind: "thread", parentless: o.all ? undefined : true, state: o.state, runner: o.runner, limit: o.limit ?? 50, orderBy: "tipAt" });
  for await (const cid of it) rows.push(await threadRow(store, cid));
  return rows;
}

export async function threadRow(store: Store, cid: CID): Promise<ThreadRow> {
  const origin = await store.get<ThreadOrigin>(cid);
  const tip = await tipOf(store, cid);
  const row: ThreadRow = { cid: fmt(cid), runner: origin.runner, state: tip?.state ?? "new", at: origin.at, tipAt: tip?.at ?? origin.at, label: labelOf(origin) };
  if (origin.launchedBy) row.launchedBy = fmt(origin.launchedBy);
  if (tip?.state === "waiting" && origin.runner !== "david") {
    const d = await findWaitingDavid(store, cid);
    if (d) row.davidWaiting = fmt(d);
  }
  return row;
}

// ---------------------------------------------------------------- one thread

export interface HistoryRow {
  cid: string; seq: number; at: number; state: ThreadState;
  waitingOn?: string[]; until?: number; resolution?: string; note?: string; error?: string;
}

export interface LaunchView {
  cid: string; runner: string; label: string; state: ThreadState | "new";
  note?: string; error?: string;
  thinking?: string; // model threads: the reasoning, which only lives in the model's own node
  reply?: string;    // david threads: what David answered
}

export type EmitView = { type: string; [k: string]: Json | LaunchView | undefined } & { run?: LaunchView };

export interface NodeViewRow {
  cid: string; at: number; prev: string[];
  asked?: string; // one line for what started the node, when the emissions don't already say it
  emits: EmitView[];
  rest?: { state: ThreadState; waitingOn?: string[] };
}

export interface ThreadView extends ThreadRow {
  spec: Json;
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
      waitingOn: u.waitingOn?.map(fmt), until: u.until, resolution: u.resolution && fmt(u.resolution), note: u.note,
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
      cid: fmt(n), at: v.origin.at, prev: v.origin.prev.map(fmt), asked: asked(origin, v.origin), emits,
      rest: v.rest && stripUndef({ state: v.rest.state, waitingOn: v.rest.waitingOn?.map(fmt) }),
    }));
  }
  const view: ThreadView = { ...row, spec: jsonify(origin.spec), history, nodes, settled: isSettled(row.state as ThreadState), version };
  if (origin.launchedBy) {
    const by = await store.get<NodeOrigin>(origin.launchedBy).catch(() => undefined);
    if (by?.kind === "node" && isCID(by.thread)) view.parent = fmt(by.thread);
  }
  if (origin.runner === "david" && !view.settled && row.state === "waiting") view.davidWaiting = row.cid;
  return view;
}

async function launchView(store: Store, t: CID): Promise<{ view: LaunchView; version: number }> {
  const o = await store.get<ThreadOrigin>(t);
  const tip = await tipOf(store, t);
  const view: LaunchView = stripUndef({
    cid: fmt(t), runner: o.runner, label: labelOf(o), state: tip?.state ?? "new",
    note: tip?.note, error: tip?.error && `${tip.error.kind}: ${tip.error.message}`,
  });
  let version = tip?.seq ?? 0;
  if (o.runner === "model") {
    // Streaming thinking counts toward version so a watching page sees it arrive.
    for (const n of await nodesOf(store, t)) {
      const v = await nodeView(store, n);
      version += v.emits.length;
      const thinking = emitsOf(v.emits, "thinking").map((e) => e.text).join("");
      if (thinking) view.thinking = (view.thinking ?? "") + thinking;
    }
  }
  if (o.runner === "david" && tip?.state === "finished" && tip.resolution) {
    const text = emitsOf((await nodeView(store, tip.resolution)).emits, "conclusion").at(-1)?.text;
    if (text !== undefined) view.reply = text;
  }
  return { view, version };
}

function asked(thread: ThreadOrigin, n: NodeOrigin): string | undefined {
  const r = n.request as Record<string, unknown> | string | undefined;
  if (typeof r === "string") return r;
  if (!r || typeof r !== "object") return undefined;
  if (thread.runner === "loop" && Array.isArray(r.messages)) {
    const last = r.messages.at(-1) as { role?: string; content?: string } | undefined;
    if (last?.role !== "user") return undefined; // tool results: the tool_result emissions say it
    return `${n.prev.length ? "David" : "Prompt"}: ${last.content ?? ""}`;
  }
  if (typeof r.reply === "string") return undefined; // david's reply node: its conclusion says it
  if (typeof r.cmd === "string") return `$ ${r.cmd}`;
  if (typeof r.model === "string") return `model ${r.model}`;
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
  runner: string;
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
    for (const c of await this.fresh(t)) {
      const u = await this.store.get<ThreadUpdate>(c);
      out.push({ at: u.at, depth, thread: t, runner: origin.runner, update: u });
    }
    for (const n of await nodesOf(this.store, t)) {
      const k = fmt(n);
      for (const c of await this.fresh(n)) {
        const u = await this.store.get<NodeUpdate>(c);
        const ev: WatchEvent = { at: u.at, depth, thread: t, runner: origin.runner, node: n };
        if (u.emit) {
          ev.emit = u.emit;
          if (u.emit.type === "launched" && isCID(u.emit.thread)) {
            this.launched.set(k, [...(this.launched.get(k) ?? []), u.emit.thread]);
            ev.label = labelOf(await this.store.get<ThreadOrigin>(u.emit.thread));
          }
        }
        if (u.rest) ev.rest = u.rest;
        out.push(ev);
      }
      for (const l of this.launched.get(k) ?? []) await this.visitThread(l, depth + 1, out);
    }
  }
}

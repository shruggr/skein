// Chain-reading helpers over a Store: the host-side view of threads and nodes
// (CLI, web, runtime, tests). Programs can't use these — they see only `get`;
// see program.ts for their equivalents. All state is read back from blocks.

import type { CID } from "multiformats/cid";
import type { Store } from "./store.ts";
import type { Emission, NodeOrigin, NodeUpdate, Ref, Rest, ThreadState, ThreadUpdate } from "./types.ts";

/** dag-cbor rejects `undefined`; optional fields must be absent, not undefined. */
export function compact<T>(v: T): T {
  if (Array.isArray(v)) return v.map(compact) as T;
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = compact(x);
    return o as T;
  }
  return v;
}

let last = 0;
/** Random tag for origins that could otherwise collide (same content, same ms, another process). */
export const nonce = () => Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("base64url");

/** Strictly increasing ms, so two identical origins written in one ms still differ. */
export function stamp(): number {
  last = Math.max(Date.now(), last + 1);
  return last;
}

/** Terminal states: something waiting on this thread may proceed. `waiting` is at rest but not settled. */
export function isSettled(state: ThreadState | undefined): boolean {
  return state === "finished" || state === "errored" || state === "out-of-context" || state === "dropped";
}

/** The latest thread update, or undefined if the thread has never been started. */
export async function tipOf(store: Store, thread: CID): Promise<ThreadUpdate | undefined> {
  const tip = await store.chains.tip(thread);
  return tip.equals(thread) ? undefined : store.get<ThreadUpdate>(tip);
}

export async function openNode(store: Store, n: { thread: CID; prev: CID[]; request: unknown; refs?: Ref[]; nonce?: string }): Promise<CID> {
  return store.chains.open(compact({ kind: "node", thread: n.thread, prev: n.prev, request: n.request, refs: n.refs ?? [], at: stamp(), nonce: n.nonce }) as NodeOrigin);
}

export const emit = (store: Store, node: CID, e: Emission) => store.chains.append(node, { emit: compact(e) });
export const rest = (store: Store, node: CID, r: Rest) => store.chains.append(node, { rest: compact(r) });

export interface NodeView { cid: CID; origin: NodeOrigin; emits: Emission[]; rest?: Rest }

export async function nodeView(store: Store, node: CID): Promise<NodeView> {
  const origin = await store.get<NodeOrigin>(node);
  const v: NodeView = { cid: node, origin, emits: [] };
  for await (const c of store.chains.history(node)) {
    if (c.equals(node)) continue;
    const u = await store.get<NodeUpdate>(c);
    if (u.emit) v.emits.push(u.emit);
    if (u.rest) v.rest = u.rest;
  }
  return v;
}

/** A thread's nodes, oldest first. */
export async function nodesOf(store: Store, thread: CID): Promise<CID[]> {
  const all: CID[] = [];
  for await (const c of store.edges.query({ kind: "node", thread })) all.push(c);
  return all.reverse();
}

/** The thread's latest node: one no other node names as prev (not index order, which ties within a ms). */
export async function headNode(store: Store, thread: CID): Promise<CID | undefined> {
  const nodes = await nodesOf(store, thread);
  const prevs = new Set<string>();
  for (const n of nodes) for (const p of (await store.get<NodeOrigin>(n)).prev) prevs.add(p.toString());
  return nodes.filter((n) => !prevs.has(n.toString())).at(-1);
}

type Known = "thinking" | "text" | "say" | "page" | "launched" | "tool_result" | "conclusion";
/** Emissions of one declared type, typed as that variant (a plain `type ===` check can't narrow past the open member). */
export function emitsOf<K extends Known>(emits: Emission[], type: K): Array<Extract<Emission, { type: K }>> {
  return emits.filter((e) => e.type === type) as Array<Extract<Emission, { type: K }>>;
}

/** Read a field of an emission regardless of its declared variant (emissions are open maps). */
export const field = (e: Emission | undefined, k: string): unknown => (e as Record<string, unknown> | undefined)?.[k];

export function conclusion(v: NodeView): string | undefined {
  return emitsOf(v.emits, "conclusion").at(-1)?.text;
}

/** The 12 chars after "bafy": what the CLI shows, and a prefix it accepts back. */
export const short = (cid: CID | string) => String(cid).slice(4, 16);

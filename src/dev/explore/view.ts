// The explorer's read model: one pass over the store per request — the
// genesis, the log, every thread with its updates — and the links between
// them that no index keeps (which threads an entry launched or stepped).
// Read-only: nothing here writes. Outside the machine (src/dev).

import type { CID } from "multiformats/cid";
import { decode, isCID } from "../../runtime/cid.ts";
import { headOrigin, MAIN, type HeadUpdate } from "../../runtime/heads.ts";
import { genesisOf, readLog, type LogEntry } from "../../runtime/log.ts";
import { isProgram, matches, type Genesis, type Subscription } from "../../runtime/records.ts";
import { NotFound, type Store } from "../../runtime/store.ts";
import { fold, subscriptionUpdates, type SubscriptionUpdate } from "../../runtime/subscriptions.ts";
import type { ThreadOrigin, ThreadUpdate } from "../../runtime/types.ts";

export type Update = ThreadUpdate & {
  step?: number; calls?: CID[]; launched?: CID[]; kept?: CID[]; emits?: CID[]; heads?: CID[]; subscriptions?: CID[];
};

export interface Thread {
  cid: CID;
  o: ThreadOrigin;
  program: string;                           // the program record's name
  updates: Array<{ cid: CID; u: Update }>;
  state: string;                             // the tip's, or "new"
  tipAt: number;
}

export interface Touch { thread: Thread; seq: number } // seq 0: the entry launched it

export interface World {
  store: Store;
  genesis?: Genesis;
  log: Array<{ cid: CID; entry: LogEntry }>;
  entries: Map<string, { cid: CID; entry: LogEntry }>;
  threads: Thread[];                         // newest first
  byThread: Map<string, Thread>;
  touched: Map<string, Touch[]>;             // entry CID → the threads it launched or stepped
  envelopes: Map<string, EnvelopeRecord>;    // admitted envelopes, by CID
  outcomes: Map<string, { cid: CID; entry: LogEntry }>; // outcome entries, by the emit they report on
  subscriptions?: Array<{ cid: CID; u: SubscriptionUpdate }>; // the subscriptions chain, oldest first; absent: never opened
  cursor: number;
}

export async function load(store: Store): Promise<World> {
  const genesis = await genesisOf(store).catch(() => undefined);
  const log = await readLog(store);
  const names = new Map<string, string>(Object.entries(genesis?.programs ?? {}).map(([n, c]) => [c.toString(), n]));
  const threads: Thread[] = [];
  for await (const cid of store.edges.query({ kind: "thread" })) {
    const o = await store.get<ThreadOrigin>(cid);
    const updates: Thread["updates"] = [];
    for await (const u of store.chains.history(cid)) if (!u.equals(cid)) updates.push({ cid: u, u: await store.get<Update>(u) });
    const tip = updates.at(-1)?.u;
    threads.push({ cid, o, program: names.get(o.program.toString()) ?? (await programName(store, o.program)), updates, state: tip?.state ?? "new", tipAt: tip?.at ?? o.at });
  }
  const touched = new Map<string, Touch[]>();
  const touch = (e: CID | undefined, t: Touch) => { if (e) touched.set(e.toString(), [...(touched.get(e.toString()) ?? []), t]); };
  for (const t of [...threads].reverse()) {
    touch(t.o.input, { thread: t, seq: 0 });
    for (const { u } of t.updates) touch(u.input, { thread: t, seq: u.seq });
  }
  const envelopes = new Map<string, EnvelopeRecord>();
  for (const { entry } of log) {
    const env = await maybe<EnvelopeRecord>(store, entry.envelope);
    if (env) envelopes.set(entry.envelope!.toString(), env);
  }
  return {
    store, genesis, log, threads, touched, envelopes, subscriptions: await subscriptionUpdates(store),
    outcomes: new Map(log.filter((x) => x.entry.outcome).map((x) => [x.entry.outcome!.emit.toString(), x])),
    entries: new Map(log.map((x) => [x.cid.toString(), x])),
    byThread: new Map(threads.map((t) => [t.cid.toString(), t])),
    cursor: await store.live.cursor.get(),
  };
}

async function programName(store: Store, cid: CID): Promise<string> {
  const p = await store.get(cid).catch(() => undefined);
  return isProgram(p) ? p.name : cid.toString().slice(-8);
}

/** What a log entry is. */
export const kindOf = (e: LogEntry) => e.genesis ? "genesis" : e.envelope ? "envelope" : e.outcome ? "outcome" : "wake";

/** The thread whose step emitted `emit`, if any. */
export const emitter = (w: World, emit: CID): Thread | undefined =>
  w.threads.find((t) => t.updates.some(({ u }) => u.emits?.some((c) => c.equals(emit))));

/** A record, or undefined when the store has no such block (or it is not dag-cbor). */
export async function maybe<T>(store: Store, cid: CID | undefined): Promise<T | undefined> {
  if (!cid) return undefined;
  try { return await store.get(cid) as T; } catch { return undefined; }
}

/** An admitted envelope's signed part, as the log entry names it (docs/MESSAGES.md). */
export interface EnvelopeRecord {
  sender?: { identityKey?: string; handle?: string; domain?: string };
  recipient?: { identityKey?: string; handle?: string; domain?: string };
  created?: string; contentHash?: string; signature?: string; [k: string]: unknown;
}

export const senderOf = (env: EnvelopeRecord | undefined) => env?.sender?.identityKey;

/** The subscriptions as they stood when entry `n` was processed (the updates written by earlier entries); all of them if n is absent. */
export function rulesAt(w: World, n?: number): Subscription[] {
  const before = (u: SubscriptionUpdate) => n === undefined || (w.entries.get(u.input.toString())?.entry.n ?? Infinity) < n;
  return fold((w.subscriptions ?? []).map((x) => x.u).filter(before));
}

/** How the runtime routed envelope entry `n`: a reply (by its body's `replyTo`) or the first subscription matching then. */
export function routeOf(w: World, n: number, sender: string | undefined, box: string | undefined, body: unknown):
  { reply: CID | null } | { sub: Subscription; i: number } | undefined {
  if (body && typeof body === "object" && "replyTo" in body) {
    const r = (body as { replyTo: unknown }).replyTo;
    return { reply: isCID(r) ? r : null };
  }
  if (!sender || box === undefined) return undefined;
  const rules = rulesAt(w, n);
  const i = rules.findIndex((s) => matches(s, sender, box));
  return i < 0 ? undefined : { sub: rules[i], i };
}

/** Who an identity is, as far as this instance knows. */
export function label(w: World, id: string | undefined): string | undefined {
  const g = w.genesis;
  if (!g || !id) return undefined;
  if (id === g.owner) return "owner";
  if (id === g.identity) return "instance";
  if (id === g.host) return "host";
  return Object.entries(g.peers ?? {}).find(([, v]) => v === id)?.[0];
}

/** Head names moved by any step, `main` first. */
export function headNames(w: World): Promise<string[]> {
  const cids = w.threads.flatMap((t) => t.updates.flatMap(({ u }) => u.heads ?? []));
  return Promise.all(cids.map(async (c) => {
    const u = await maybe<HeadUpdate>(w.store, c);
    return (await maybe<{ name?: string }>(w.store, u?.origin))?.name;
  })).then((ns) => [...new Set([MAIN, ...ns.filter((n): n is string => !!n)])]);
}

/** A head's moves, oldest first; empty for a name never moved. */
export async function headMoves(store: Store, name: string): Promise<Array<{ cid: CID; u: HeadUpdate }>> {
  const origin = headOrigin(name);
  const out: Array<{ cid: CID; u: HeadUpdate }> = [];
  try {
    for await (const c of store.chains.history(origin)) if (!c.equals(origin)) out.push({ cid: c, u: await store.get(c) as unknown as HeadUpdate });
  } catch (e) { if (!(e instanceof NotFound)) throw e; }
  return out;
}

/** The launchedBy chain up to the root: parent threads, then the entry that admitted the launching envelope. */
export async function ancestry(w: World, t: Thread): Promise<Array<{ thread: Thread } | { entry: CID; envelope: CID }>> {
  const out: Array<{ thread: Thread } | { entry: CID; envelope: CID }> = [];
  let at: Thread | undefined = t;
  while (at?.o.launchedBy) {
    const by: CID = at.o.launchedBy;
    const parent = w.byThread.get(by.toString());
    if (parent) { out.push({ thread: parent }); at = parent; continue; }
    const entry = await w.store.log.byEnvelope(by);
    if (entry) out.push({ entry, envelope: by });
    break;
  }
  return out;
}

/** dag-cbor bytes decoded, or undefined. */
export function tryDecode(bytes: Uint8Array): unknown {
  try { return decode(bytes); } catch { return undefined; }
}

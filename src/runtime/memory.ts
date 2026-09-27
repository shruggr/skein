// In-memory Store: the reference implementation the engine tests run on.
// Same block encoding as the durable store (dag-cbor, sha2-256, CIDv1), so
// CIDs agree across implementations. The index is derived and rebuildable.

import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as dagCbor from "@ipld/dag-cbor";
import { encode } from "./cid.ts";
import { checkExtends, NotFound, Rejected, type Filter, type Handle, type LogEntry, type Store } from "./store.ts";
import type { Block, Emission, Ms, NodeOrigin, Ref, ThreadOrigin, ThreadState } from "./types.ts";
import { verifyMessageSync, type Message } from "./records.ts";

interface Meta {
  cid: CID;
  kind: "thread" | "node";
  order: number;          // insertion order: tiebreak for same-ms origins
  at: Ms;
  tipAt: Ms;              // at of the latest block in the chain
  thread?: string;        // nodes: owning thread
  program?: string;       // threads
  parentless?: boolean;   // threads
  state?: ThreadState;    // threads: tip state; undefined = never started
  waitingOn?: string[];
  waitingFrom?: string;
  awaits?: string[];
  until?: Ms;
}

interface MessageMeta { cid: CID; from: string; to?: string; seq: number; at: Ms; order: number }

type Edge = Ref & { from: CID };

export function memoryStore(): Store {
  const bytes = new Map<string, Uint8Array>();
  const chains = new Map<string, CID[]>(); // origin → [origin, u1, u2, …]
  const originOf = new Map<string, CID>();
  const meta = new Map<string, Meta>();
  const out = new Map<string, Edge[]>();
  const inc = new Map<string, Edge[]>();
  const handles = new Map<string, Handle>();
  const messages = new Map<string, MessageMeta>(); // cid → row
  const bySeq = new Map<string, string>();          // `${from} ${seq}` → cid
  const locks = new Map<string, Promise<unknown>>();
  const log: CID[] = [];                            // entry CIDs, in order; not derived, survives rebuild
  const logged = new Map<string, CID>();            // envelope → entry
  const outcomes = new Map<string, CID>();          // emit → its outcome entry
  let cursor = 0;
  let order = 0;

  async function put(value: Block): Promise<CID> {
    const data = dagCbor.encode(value);
    const cid = CID.createV1(dagCbor.code, await sha256.digest(data));
    const k = cid.toString();
    if (!bytes.has(k)) bytes.set(k, data);
    return cid;
  }

  async function get<T extends Block = Block>(cid: CID): Promise<T> {
    const data = bytes.get(cid.toString());
    if (!data) throw new NotFound(cid.toString());
    return dagCbor.decode(data) as T;
  }

  function locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const next = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
    locks.set(key, next.catch(() => {}));
    return next;
  }

  function addEdge(e: Edge) {
    const f = e.from.toString(), t = e.to.toString();
    const list = out.get(f) ?? [];
    if (list.some((x) => x.rel === e.rel && x.to.toString() === t && x.locator === e.locator)) return;
    list.push(e);
    out.set(f, list);
    inc.set(t, [...(inc.get(t) ?? []), e]);
  }

  function indexOrigin(cid: CID, b: Block) {
    const kind = kindOf(b);
    if (kind === "thread") {
      const t = b as ThreadOrigin;
      meta.set(cid.toString(), { cid, kind: "thread", order: order++, at: t.at, tipAt: t.at, program: t.program?.toString(), parentless: !t.launchedBy });
      // launchedBy is the inverse of the node's "launched" edge; store it that way round.
      if (t.launchedBy) addEdge({ from: t.launchedBy, rel: "launched", to: cid });
    } else if (kind === "node") {
      const n = b as NodeOrigin;
      meta.set(cid.toString(), { cid, kind: "node", order: order++, at: n.at, tipAt: n.at, thread: n.thread.toString() });
      for (const r of n.refs ?? []) addEdge({ ...r, from: cid });
    }
  }

  function indexUpdate(origin: CID, u: Record<string, unknown>) {
    const m = meta.get(origin.toString());
    if (m && typeof u.at === "number") m.tipAt = u.at;
    if (m?.kind === "thread") {
      m.state = u.state as ThreadState;
      m.waitingOn = (u.waitingOn as CID[] | undefined)?.map(String);
      m.waitingFrom = typeof u.waitingFrom === "string" ? u.waitingFrom : undefined;
      m.awaits = (u.awaits as CID[] | undefined)?.map(String);
      m.until = u.until as Ms | undefined;
      for (const w of (u.waitingOn as CID[] | undefined) ?? []) addEdge({ from: origin, rel: "depends-on", to: w });
      if (u.resolution) addEdge({ from: origin, rel: "resolution", to: u.resolution as CID });
    } else if (m?.kind === "node") {
      const e = u.emit as Emission | undefined;
      if (e?.type === "launched" && e.thread) addEdge({ from: origin, rel: "launched", to: e.thread as CID });
    }
  }

  function register(cid: CID, b: Block) {
    const k = cid.toString();
    if (chains.has(k)) return;
    chains.set(k, [cid]);
    originOf.set(k, cid);
    indexOrigin(cid, b);
  }

  function indexMessage(cid: CID, m: Message) {
    const key = `${m.from} ${m.seq}`;
    const had = bySeq.get(key);
    if (had === cid.toString()) return;
    if (had) throw new Rejected("duplicate-seq", `message: ${m.from} already sent seq ${m.seq}`);
    bySeq.set(key, cid.toString());
    messages.set(cid.toString(), { cid, from: m.from, to: m.to, seq: m.seq, at: m.at, order: order++ });
  }

  const threads = () => [...meta.values()].filter((m) => m.kind === "thread");

  const store: Store = {
    put,
    get,
    async has(cid) { return bytes.has(cid.toString()); },
    async putBlock(cid, data) { if (!bytes.has(cid.toString())) bytes.set(cid.toString(), data); },
    async putMessage(m) {
      if (!verifyMessageSync(m)) throw new Rejected("bad-signature", "message: bad shape or signature");
      const { cid, bytes: data } = encode(m); // cid.ts's encode: the same bytes the signature was checked against
      const k = `${m.from} ${m.seq}`;
      if (bySeq.has(k) && bySeq.get(k) !== cid.toString()) throw new Rejected("duplicate-seq", `message: ${m.from} already sent seq ${m.seq}`);
      if (!bytes.has(cid.toString())) bytes.set(cid.toString(), data);
      indexMessage(cid, m);
      return cid;
    },
    async bytes(cid) {
      const data = bytes.get(cid.toString());
      if (!data) throw new NotFound(cid.toString());
      return data;
    },

    chains: {
      async open(origin) {
        const cid = await put(origin);
        register(cid, origin);
        return cid;
      },
      append(origin, body) {
        return locked(origin.toString(), async () => {
          const chain = chains.get(origin.toString());
          if (!chain) throw new NotFound(origin.toString());
          if (typeof body.at !== "number") throw new TypeError("append: body.at (log time) is required");
          const update = { ...body, origin, prev: chain[chain.length - 1], seq: chain.length };
          const cid = await put(update as unknown as Block);
          chain.push(cid);
          originOf.set(cid.toString(), origin);
          indexUpdate(origin, update);
          return cid;
        });
      },
      async tip(origin) {
        const chain = chains.get(origin.toString());
        if (chain) return chain[chain.length - 1];
        if (bytes.has(origin.toString())) return origin;
        throw new NotFound(origin.toString());
      },
      async *history(origin) {
        yield* chains.get(origin.toString()) ?? [];
      },
      async originOf(cid) {
        const o = originOf.get(cid.toString());
        if (o) return o;
        const b = await get(cid);
        return CID.asCID((b as { origin?: unknown }).origin) ?? cid;
      },
    },

    log: {
      async append(entry) {
        // No await before the push: appends must not interleave.
        if (entry.envelope && logged.has(entry.envelope.toString())) throw new Rejected("duplicate-envelope", `log: envelope ${entry.envelope} is already admitted`);
        if (entry.outcome && outcomes.has(entry.outcome.emit.toString())) throw new Rejected("duplicate-outcome", `log: emit ${entry.outcome.emit} already has an outcome`);
        const n = log.length;
        const tipEntry = n ? (dagCbor.decode(bytes.get(log[n - 1].toString())!) as LogEntry) : undefined;
        checkExtends(entry, log.at(-1), tipEntry);
        const e = encode(entry);
        bytes.set(e.cid.toString(), e.bytes);
        log.push(e.cid);
        if (entry.envelope) logged.set(entry.envelope.toString(), e.cid);
        if (entry.outcome) outcomes.set(entry.outcome.emit.toString(), e.cid);
        return e.cid;
      },
      async byEnvelope(envelope) { return logged.get(envelope.toString()); },
      async outcomeOf(emit) { return outcomes.get(emit.toString()); },
      async tip() { return log.at(-1); },
      async *entries(from = 0) {
        for (let i = from; i < log.length; i++) yield { cid: log[i], entry: await get<LogEntry>(log[i]) };
      },
    },

    edges: {
      async refsFrom(cid) {
        return (out.get(cid.toString()) ?? []).map(({ from: _, ...r }) => r);
      },
      async refsTo(cid) {
        return [...(inc.get(cid.toString()) ?? [])];
      },
      async *query(f: Filter) {
        if (f.kind === "message" || (f.kind === undefined && (f.from !== undefined || f.to !== undefined))) {
          const ms = [...messages.values()]
            .filter((m) => f.from === undefined || m.from === f.from)
            .filter((m) => f.to === undefined || m.to === f.to)
            .filter((m) => f.since === undefined || m.at >= f.since)
            .filter((m) => f.before === undefined || m.at < f.before)
            .sort((a, b) => b.at - a.at || b.order - a.order);
          yield* ms.slice(0, f.limit ?? ms.length).map((m) => m.cid);
          return;
        }
        const hits = [...meta.values()]
          .filter((m) => !f.kind || m.kind === f.kind)
          .filter((m) => !f.thread || m.thread === f.thread.toString())
          .filter((m) => !f.program || m.program === f.program.toString())
          .filter((m) => !f.state || (m.kind === "thread" && m.state !== undefined && f.state.includes(m.state)))
          .filter((m) => f.parentless === undefined || (m.kind === "thread" && m.parentless === f.parentless))
          .filter((m) => f.since === undefined || m.at >= f.since)
          .filter((m) => f.before === undefined || m.at < f.before)
          .sort(f.orderBy === "tipAt" ? (a, b) => b.tipAt - a.tipAt || b.order - a.order : (a, b) => b.at - a.at || b.order - a.order);
        yield* hits.slice(0, f.limit ?? hits.length).map((m) => m.cid);
      },
      async rebuild() {
        chains.clear(); originOf.clear(); meta.clear(); out.clear(); inc.clear(); messages.clear(); bySeq.clear();
        order = 0;
        const updates: Array<{ cid: CID; u: Record<string, unknown> }> = [];
        for (const k of bytes.keys()) {
          const cid = CID.parse(k);
          const b = await get(cid);
          const o = CID.asCID((b as { origin?: unknown }).origin);
          if (kindOf(b) === "message") { if (verifyMessageSync(b)) indexMessage(cid, b); } // put() can store unsigned look-alikes
          else if (o && typeof (b as { seq?: unknown }).seq === "number") updates.push({ cid, u: b as Record<string, unknown> });
          else if (kindOf(b) === "thread" || kindOf(b) === "node") register(cid, b);
        }
        updates.sort((a, b) => (a.u.seq as number) - (b.u.seq as number));
        for (const { cid, u } of updates) {
          const origin = u.origin as CID;
          if (!chains.has(origin.toString())) register(origin, await get(origin));
          chains.get(origin.toString())!.push(cid);
          originOf.set(cid.toString(), origin);
          indexUpdate(origin, u);
        }
      },
    },

    live: {
      handles: {
        async set(thread, handle) { handles.set(thread.toString(), structuredClone(handle)); },
        async get(thread) { const h = handles.get(thread.toString()); return h && structuredClone(h); },
        async clear(thread) { handles.delete(thread.toString()); },
      },
      async *resting(f = {}) {
        const hits = threads()
          .filter((m) => m.state !== "finished")
          .filter((m) => !f.state || (m.state !== undefined && f.state.includes(m.state)))
          .sort((a, b) => a.order - b.order);
        yield* hits.slice(0, f.limit ?? hits.length).map((m) => m.cid);
      },
      async *due(now) {
        yield* threads().filter((m) => m.state === "waiting" && m.until !== undefined && m.until <= now).map((m) => m.cid);
      },
      async *waitersOn(thread) {
        const k = thread.toString();
        yield* threads().filter((m) => m.state === "waiting" && m.waitingOn?.includes(k)).map((m) => m.cid);
      },
      async *waitingFrom(identity) {
        yield* threads().filter((m) => m.waitingFrom === identity).sort((a, b) => a.order - b.order).map((m) => m.cid);
      },
      async *awaiting(envelope) {
        const k = envelope.toString();
        yield* threads().filter((m) => m.awaits?.includes(k)).sort((a, b) => a.order - b.order).map((m) => m.cid);
      },
      cursor: {
        async get() { return cursor; },
        async set(n) { cursor = n; },
      },
    },

    async close() {},
  };
  return store;
}

const kindOf = (b: Block) => (b as { kind?: unknown }).kind;

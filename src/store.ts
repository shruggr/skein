// The store interface. Four layers: blocks, chains, edges, live.
// Everything above this (scheduler, runners, CLI, lenses) calls only this.
// The first implementation is one SQLite file via node:sqlite (sqlite.ts).

import type { CID } from "multiformats/cid";
import type { Block, Ref, RunnerKind, ThreadState, Ms } from "./types.ts";

export class NotFound extends Error {
  readonly cid: string;
  constructor(cid: string) { super(`not found: ${cid}`); this.cid = cid; }
}

// ---------------------------------------------------------------- 1. blocks
// Immutable, content-addressed. put is idempotent: same value, same CID.

export interface Blocks {
  put(value: Block): Promise<CID>;
  get<T extends Block = Block>(cid: CID): Promise<T>; // throws NotFound
  has(cid: CID): Promise<boolean>;
  /** The stored dag-cbor bytes, exactly as hashed. Throws NotFound. */
  bytes(cid: CID): Promise<Uint8Array>;
  /** Store bytes under a CID minted elsewhere (git-raw, raw). The caller vouches the CID matches. */
  putBlock(cid: CID, bytes: Uint8Array): Promise<void>;
}

// ---------------------------------------------------------------- 2. chains
// An origin plus its updates, in the ORDFS origin/seq shape.

export interface Chains {
  /** Write an origin block and register its chain (tip = origin, seq 0). */
  open(origin: Block): Promise<CID>;
  /** Write an update {origin, prev: tip, seq: n+1, at, ...body}; move the tip. Serialised per origin. */
  append(origin: CID, body: Record<string, unknown>): Promise<CID>;
  /** Latest update, or the origin itself if there are none. */
  tip(origin: CID): Promise<CID>;
  /** origin → tip, in seq order. */
  history(origin: CID): AsyncIterable<CID>;
  /** Given any block in a chain, its origin (identity). */
  originOf(cid: CID): Promise<CID>;
}

// ---------------------------------------------------------------- 3. edges
// The index. Both directions. Rebuildable from the blocks at any time.

export interface Filter {
  kind?: "thread" | "node";
  thread?: CID;           // nodes belonging to this thread
  runner?: RunnerKind;    // threads of this runner kind
  state?: ThreadState[];  // threads whose tip state is one of these
  parentless?: boolean;   // threads with no launchedBy
  since?: Ms;
  before?: Ms;
  limit?: number;
  orderBy?: "at" | "tipAt"; // newest origin (default) or most recent update first
}

export interface Edges {
  refsFrom(cid: CID): Promise<Ref[]>;
  refsTo(cid: CID): Promise<Array<Ref & { from: CID }>>;
  /** Structural narrowing over origins. Never text search. Newest first (by `orderBy`). */
  query(filter: Filter): AsyncIterable<CID>;
  /** Drop and rebuild the index from the blocks. */
  rebuild(): Promise<void>;
}

// ---------------------------------------------------------------- 4. live
// The only mutable state. Handles are transient; the worklist is derived.

export interface Handle { [k: string]: unknown } // opaque to everyone but its runner

export interface Live {
  handles: {
    set(thread: CID, handle: Handle): Promise<void>;
    get(thread: CID): Promise<Handle | undefined>;
    clear(thread: CID): Promise<void>;
  };
  /** Thread origins whose tip state is not finished — the scheduler's worklist. */
  resting(filter?: Pick<Filter, "runner" | "state" | "limit">): AsyncIterable<CID>;
  /** Threads whose `until` has passed (time trigger). */
  due(now: Ms): AsyncIterable<CID>;
  /** Threads waiting on `thread` (event trigger: it came to rest, wake these). */
  waitersOn(thread: CID): AsyncIterable<CID>;
}

// ---------------------------------------------------------------- the store

export interface Store extends Blocks {
  chains: Chains;
  edges: Edges;
  live: Live;
  close(): Promise<void>;
}

// ---------------------------------------------------------------- resolvers
// Outside the store. `skein:` is registered by default; others register at startup.

export type Resolved =
  | { ok: true; bytes: Uint8Array; contentType?: string }
  | { ok: false; reason: "unknown-scheme" | "not-found" | "unreachable"; message: string };

export interface Resolver { (url: URL): Promise<Resolved>; }

export interface Resolvers {
  register(scheme: string, resolver: Resolver): void;
  resolve(url: string | URL): Promise<Resolved>;
}

// The store interface. Five layers: blocks, chains, the input log, edges, live.
// Everything above this (scheduler, programs, dev inspection) calls only this.
// The first implementation is one SQLite file via node:sqlite (sqlite.ts).

import type { CID } from "multiformats/cid";
import type { Block, Ref, ThreadState, Ms } from "./types.ts";
import type { Message } from "./records.ts";
import type { Stamp } from "./syscalls.ts";

export class NotFound extends Error {
  readonly cid: string;
  constructor(cid: string) { super(`not found: ${cid}`); this.cid = cid; }
}

/** putMessage refused the record. The store is unchanged. */
export class Rejected extends Error {
  readonly reason: "bad-signature" | "duplicate-seq";
  constructor(reason: Rejected["reason"], message: string) { super(message); this.reason = reason; }
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
  /**
   * Write an update {...body, origin, prev: tip, seq: n+1}; move the tip. Serialised per origin.
   * `body.at` is required: the store has no clock (the runtime passes log time).
   */
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
  kind?: "thread" | "node" | "message"; // messages are single records, not chains: only message filters apply
  thread?: CID;           // nodes belonging to this thread
  program?: CID;          // threads running this program record
  from?: string;          // messages from this identity (implies kind "message")
  to?: string;            // messages to this identity or handle (implies kind "message")
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
  resting(filter?: Pick<Filter, "state" | "limit">): AsyncIterable<CID>;
  /** Threads whose `until` has passed (time trigger). */
  due(now: Ms): AsyncIterable<CID>;
  /** Threads waiting on `thread` (event trigger: it came to rest, wake these). */
  waitersOn(thread: CID): AsyncIterable<CID>;
  /** Thread origins whose tip has `waitingFrom === identity` (a message from it should wake them). */
  waitingFrom(identity: string): AsyncIterable<CID>;
  /** The scheduler's position in the log: entries with n < cursor have been processed. Not derived. */
  cursor: {
    get(): Promise<number>;
    set(n: number): Promise<void>;
  };
}

// ---------------------------------------------------------------- 5. the input log
// Every admitted message, in admission order, as a hash chain of log-entry
// records. The tip entry's CID is the instance's state hash. Not derived and
// never rebuilt: admission order is not recoverable from the messages.

export type LogEntry = {
  kind: "log";
  prev: CID | null; // the previous entry; null for the first
  n: number;        // 0-based position
  message: CID;     // a verified message in this store
  time: Stamp;      // the runtime's clock when it admitted the message: [sec, nsec] since the epoch; never before prev's
};

export interface Log {
  /**
   * Append an entry for a message already put with putMessage, stamped `time`
   * (raised to the previous entry's stamp if earlier: stamps never go back).
   * The store has no clock; log.ts reads it. A message already in the log returns its existing entry.
   */
  append(message: CID, time: Stamp): Promise<CID>;
  /** The latest entry (the state hash), or undefined for an empty log. */
  tip(): Promise<CID | undefined>;
  /** Entries with n >= from, in order. */
  entries(from?: number): AsyncIterable<{ cid: CID; entry: LogEntry }>;
}

// ---------------------------------------------------------------- the store

export interface Store extends Blocks {
  /** Verify and store a signed message; index it by (from, seq). Rejects a bad signature or a second message at one (from, seq). */
  putMessage(m: Message): Promise<CID>;
  chains: Chains;
  log: Log;
  edges: Edges;
  live: Live;
  close(): Promise<void>;
}

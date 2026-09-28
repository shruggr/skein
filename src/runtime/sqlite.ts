// The Store as one SQLite file (node:sqlite). `blocks` is the record; every
// other table except `handles` is an index derived from it and can be dropped
// and rebuilt (edges.rebuild). node:sqlite is synchronous, so each method body
// runs to completion without yielding; BEGIN IMMEDIATE covers other processes
// sharing the file.

import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { CID, decode, encode, fmt, fromBytes, isCID, parse } from "./cid.ts";
import { checkExtends, NotFound, Rejected, type Filter, type Handle, type LogEntry, type Store } from "./store.ts";
import type { Block, Ref } from "./types.ts";
import { verifyMessageSync, type Message } from "./records.ts";

const DDL = `
CREATE TABLE IF NOT EXISTS blocks (
  cid   BLOB PRIMARY KEY,
  bytes BLOB NOT NULL
) WITHOUT ROWID;

-- One row per origin. Columns below tip are derived from the origin block and
-- the tip block only, so a row can always be recomputed.
CREATE TABLE IF NOT EXISTS chains (
  origin      BLOB PRIMARY KEY REFERENCES blocks(cid),
  tip         BLOB NOT NULL REFERENCES blocks(cid),
  seq         INTEGER NOT NULL,   -- tip's seq; 0 = no updates yet
  kind        TEXT,               -- origin.kind
  thread      BLOB,               -- nodes: origin.thread
  launched_by BLOB,               -- origin.launchedBy
  at          INTEGER,            -- origin.at
  state       TEXT,               -- threads: tip.state (NULL until the first update)
  until       INTEGER,            -- threads: tip.until
  waiting_on  TEXT,               -- threads: tip.waitingOn as a JSON array of CID strings
  tip_at      INTEGER,            -- tip.at (origin.at until the first update): recent activity
  program     BLOB,               -- threads: origin.program
  waiting_from TEXT,              -- threads: tip.waitingFrom (an identity)
  awaits      TEXT                -- threads: tip.awaits (emitted envelopes awaiting a reply) as a JSON array of CID strings
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS chains_kind_at ON chains(kind, at);
CREATE INDEX IF NOT EXISTS chains_thread  ON chains(thread, at) WHERE thread IS NOT NULL;
CREATE INDEX IF NOT EXISTS chains_state   ON chains(state) WHERE state IS NOT NULL;
CREATE INDEX IF NOT EXISTS chains_until   ON chains(until) WHERE state = 'waiting';
-- Indexes on migrated columns are created after the migration below.

-- Every update's position. UNIQUE(origin, seq) is the backstop against forks.
CREATE TABLE IF NOT EXISTS updates (
  cid    BLOB PRIMARY KEY REFERENCES blocks(cid),
  origin BLOB NOT NULL REFERENCES chains(origin) ON DELETE CASCADE,
  seq    INTEGER NOT NULL,
  UNIQUE (origin, seq)
) WITHOUT ROWID;

-- Pointers out of a chain, keyed by the origin whatever block of the chain
-- holds them: (seq, ord) says which block and where in it, which keeps a
-- rebuild byte-identical regardless of walk order. "to" is a CID string or a
-- URL (URLs always contain ':', CID strings never do).
CREATE TABLE IF NOT EXISTS edges (
  "from"  BLOB NOT NULL REFERENCES chains(origin) ON DELETE CASCADE,
  seq     INTEGER NOT NULL,
  ord     INTEGER NOT NULL,
  "to"    TEXT NOT NULL,
  rel     TEXT NOT NULL,
  locator TEXT,
  PRIMARY KEY ("from", seq, ord)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS edges_to ON edges("to", rel);

-- Signed messages. Each is one record, not a chain. Only verified messages
-- get a row; UNIQUE("from", seq) refuses a sender's second message at a seq.
CREATE TABLE IF NOT EXISTS messages (
  cid    BLOB PRIMARY KEY REFERENCES blocks(cid),
  "from" TEXT NOT NULL,
  "to"   TEXT,
  seq    INTEGER NOT NULL,
  at     INTEGER NOT NULL,
  UNIQUE ("from", seq)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS messages_at      ON messages(at);
CREATE INDEX IF NOT EXISTS messages_from_at ON messages("from", at);
CREATE INDEX IF NOT EXISTS messages_to_at   ON messages("to", at) WHERE "to" IS NOT NULL;

-- Not derived and not rebuilt: program bookkeeping, overwritten freely.
CREATE TABLE IF NOT EXISTS handles (
  thread BLOB PRIMARY KEY,
  json   TEXT NOT NULL
) WITHOUT ROWID;

-- Not derived and not rebuilt: the input log. Each row is one signed
-- log-entry record (also in blocks); admission order is not recoverable from
-- the records. (An older file's message-based "log" table is left unread.)
-- The envelope column is the record the entry is unique by: an admitted envelope, or
-- an outcome's emit (one outcome per emit). They are different records, so
-- one column serves both.
CREATE TABLE IF NOT EXISTS entries (
  n        INTEGER PRIMARY KEY,
  cid      BLOB NOT NULL UNIQUE,
  envelope BLOB UNIQUE
);

-- Not derived: the scheduler's cursor and similar single values.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
) WITHOUT ROWID;
`;

type Row = Record<string, SQLOutputValue>;
type Obj = Record<string, unknown>;
export interface EdgeRow { to: string; rel: string; locator: string | null }

/** The SQLite store adds prefix lookup over origins (for the CLI's short CIDs). */
export interface SqliteStore extends Store {
  findByPrefix(prefix: string): Promise<CID[]>;
}

/**
 * `readOnly`: open an existing file for reading only (the explorer beside a
 * live runtime): no schema, no migration, no journal change; writes throw.
 */
export function openStore(path: string, o: { readOnly?: boolean } = {}): SqliteStore {
  const db = new DatabaseSync(path, { readOnly: o.readOnly ?? false });
  let stale = false;
  if (o.readOnly) db.exec("PRAGMA busy_timeout = 5000;");
  else {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    db.exec(DDL);
    // Older files: add missing derived columns, then rebuild once the store
    // exists. A new messages table beside old chains may owe rows to old blocks.
    const cols = new Set(db.prepare("PRAGMA table_info(chains)").all().map((c) => c.name));
    const added = [["tip_at", "INTEGER"], ["program", "BLOB"], ["waiting_from", "TEXT"], ["awaits", "TEXT"]].filter(([c]) => !cols.has(c));
    for (const [c, type] of added) db.exec(`ALTER TABLE chains ADD COLUMN ${c} ${type}`);
    stale = added.length > 0 || (tables.has("chains") && !tables.has("messages"));
    db.exec(`
      CREATE INDEX IF NOT EXISTS chains_tip_at       ON chains(kind, tip_at);
      CREATE INDEX IF NOT EXISTS chains_program      ON chains(program) WHERE program IS NOT NULL;
      CREATE INDEX IF NOT EXISTS chains_waiting_from ON chains(waiting_from) WHERE waiting_from IS NOT NULL;
      CREATE INDEX IF NOT EXISTS chains_awaits       ON chains(kind) WHERE awaits IS NOT NULL;
    `);
  }

  const q = {
    begin: db.prepare("BEGIN IMMEDIATE"),
    commit: db.prepare("COMMIT"),
    rollback: db.prepare("ROLLBACK"),

    blockPut: db.prepare("INSERT OR IGNORE INTO blocks (cid, bytes) VALUES (?, ?)"),
    blockGet: db.prepare("SELECT bytes FROM blocks WHERE cid = ?"),
    blockHas: db.prepare("SELECT 1 AS x FROM blocks WHERE cid = ?"),
    blockAll: db.prepare("SELECT cid, bytes FROM blocks ORDER BY cid"),

    chainIns: db.prepare(`INSERT OR IGNORE INTO chains
      (origin, tip, seq, kind, thread, launched_by, at, tip_at, program)
      VALUES (:origin, :origin, 0, :kind, :thread, :launched_by, :at, :at, :program)`),
    chainGet: db.prepare("SELECT tip, seq, kind FROM chains WHERE origin = ?"),
    chainMove: db.prepare(`UPDATE chains SET tip = :tip, seq = :seq,
      state = :state, until = :until, waiting_on = :waiting_on, tip_at = :tip_at, waiting_from = :waiting_from, awaits = :awaits
      WHERE origin = :origin`),
    updateIns: db.prepare("INSERT INTO updates (cid, origin, seq) VALUES (?, ?, ?)"),
    origins: db.prepare("SELECT origin FROM chains"),
    updateOrigin: db.prepare("SELECT origin FROM updates WHERE cid = ?"),
    updatesOf: db.prepare("SELECT cid FROM updates WHERE origin = ? ORDER BY seq"),
    lastUpdate: db.prepare("SELECT cid, seq FROM updates WHERE origin = ? ORDER BY seq DESC LIMIT 1"),
    edgeIns: db.prepare(`INSERT OR IGNORE INTO edges ("from", seq, ord, "to", rel, locator)
      VALUES (?, ?, ?, ?, ?, ?)`),

    // Same pointer from several blocks of one chain (waitingOn repeated across
    // updates) collapses to one ref, in order of first appearance.
    refsFrom: db.prepare(`SELECT "to", rel, locator FROM edges WHERE "from" = ?
      GROUP BY "to", rel, locator ORDER BY MIN(seq * 1048576 + ord)`),
    refsTo: db.prepare(`SELECT e."from", e.rel, e.locator FROM edges e
      JOIN chains c ON c.origin = e."from" WHERE e."to" = ?
      GROUP BY e."from", e.rel, e.locator ORDER BY MAX(c.at) DESC, e."from" DESC`),

    // One statement for every Filter combination: NULL means "don't narrow".
    query: db.prepare(`SELECT origin FROM chains WHERE
          (:kind IS NULL OR kind = :kind)
      AND (:thread IS NULL OR thread = :thread)
      AND (:program IS NULL OR program = :program)
      AND (:states IS NULL OR state IN (SELECT value FROM json_each(:states)))
      AND (:parentless IS NULL OR (kind = 'thread' AND (launched_by IS NULL) = :parentless))
      AND (:since IS NULL OR at >= :since)
      AND (:before IS NULL OR at < :before)
      ORDER BY CASE WHEN :tipAt THEN tip_at ELSE at END DESC, origin DESC LIMIT :limit`),
    messageQuery: db.prepare(`SELECT cid FROM messages WHERE
          (:from IS NULL OR "from" = :from)
      AND (:to IS NULL OR "to" = :to)
      AND (:since IS NULL OR at >= :since)
      AND (:before IS NULL OR at < :before)
      ORDER BY at DESC, cid DESC LIMIT :limit`),
    messageIns: db.prepare(`INSERT INTO messages (cid, "from", "to", seq, at) VALUES (:cid, :from, :to, :seq, :at)`),
    messageAt: db.prepare(`SELECT cid FROM messages WHERE "from" = ? AND seq = ?`),
    resting: db.prepare(`SELECT origin FROM chains
      WHERE kind = 'thread' AND (state IS NULL OR state <> 'finished')
      AND (:states IS NULL OR state IN (SELECT value FROM json_each(:states)))
      ORDER BY at, origin LIMIT :limit`),
    due: db.prepare(`SELECT origin FROM chains
      WHERE state = 'waiting' AND kind = 'thread' AND until <= ? ORDER BY until, origin`),
    waitersOn: db.prepare(`SELECT origin FROM chains
      WHERE kind = 'thread' AND waiting_on IS NOT NULL
      AND EXISTS (SELECT 1 FROM json_each(waiting_on) WHERE value = ?) ORDER BY at, origin`),
    waitingFrom: db.prepare(`SELECT origin FROM chains
      WHERE kind = 'thread' AND waiting_from = ? ORDER BY at, origin`),
    awaiting: db.prepare(`SELECT origin FROM chains
      WHERE kind = 'thread' AND awaits IS NOT NULL
      AND EXISTS (SELECT 1 FROM json_each(awaits) WHERE value = ?) ORDER BY at, origin`),

    handleSet: db.prepare(`INSERT INTO handles (thread, json) VALUES (?, ?)
      ON CONFLICT (thread) DO UPDATE SET json = excluded.json`),
    handleGet: db.prepare("SELECT json FROM handles WHERE thread = ?"),
    handleClear: db.prepare("DELETE FROM handles WHERE thread = ?"),

    wipeEdges: db.prepare("DELETE FROM edges"),
    wipeUpdates: db.prepare("DELETE FROM updates"),
    wipeChains: db.prepare("DELETE FROM chains"),
    wipeMessages: db.prepare("DELETE FROM messages"),

    logTip: db.prepare("SELECT n, cid FROM entries ORDER BY n DESC LIMIT 1"),
    logOf: db.prepare("SELECT cid FROM entries WHERE envelope = ?"),
    logIns: db.prepare("INSERT INTO entries (n, cid, envelope) VALUES (?, ?, ?)"),
    logFrom: db.prepare("SELECT cid FROM entries WHERE n >= ? ORDER BY n"),
    metaGet: db.prepare("SELECT value FROM meta WHERE key = ?"),
    metaSet: db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"),
  };

  function tx<T>(fn: () => T): T {
    q.begin.run();
    try {
      const r = fn();
      q.commit.run();
      return r;
    } catch (e) {
      if (db.isTransaction) q.rollback.run();
      throw e;
    }
  }

  function put(value: unknown): CID {
    const { cid, bytes } = encode(value);
    q.blockPut.run(cid.bytes, bytes);
    return cid;
  }

  function getBlock<T>(cid: CID): T {
    const row = q.blockGet.get(cid.bytes);
    if (!row) throw new NotFound(fmt(cid));
    return decode<T>(row.bytes as Uint8Array);
  }

  function chainRow(origin: CID): Row {
    const row = q.chainGet.get(origin.bytes);
    if (!row) throw new NotFound(fmt(origin));
    return row;
  }

  function writeEdges(from: CID, seq: number, edges: EdgeRow[]) {
    edges.forEach((e, i) => q.edgeIns.run(from.bytes, seq, i, e.to, e.rel, e.locator));
  }

  // Register an origin with tip = itself. Returns false if already registered.
  function register(cid: CID, block: Obj): boolean {
    const r = q.chainIns.run(originMeta(cid, block));
    if (r.changes === 0) return false;
    writeEdges(cid, 0, originEdges(block));
    return true;
  }

  function move(origin: CID, kind: unknown, tip: CID, seq: number, block: Obj) {
    q.chainMove.run({ origin: origin.bytes, tip: tip.bytes, seq, ...tipMeta(kind, block) });
  }

  function indexMessage(cid: CID, m: Message) {
    q.messageIns.run({ cid: cid.bytes, from: m.from, to: m.to ?? null, seq: m.seq, at: m.at });
  }

  function* rows(stmt: { all(p: Record<string, SQLInputValue>): Row[] }, p: Record<string, SQLInputValue>) {
    // all() rather than iterate(): callers append while they walk the results.
    for (const r of stmt.all(p)) yield fromBytes(r.origin as Uint8Array);
  }

  const store: SqliteStore = {
    async put(value) { return put(value); },
    async get<T extends Block = Block>(cid: CID) { return getBlock<T>(cid); },
    async has(cid) { return q.blockHas.get(cid.bytes) !== undefined; },
    async bytes(cid) {
      const row = q.blockGet.get(cid.bytes);
      if (!row) throw new NotFound(fmt(cid));
      return row.bytes as Uint8Array;
    },
    async putBlock(cid, data) { q.blockPut.run(cid.bytes, data); },

    async putMessage(m) {
      if (!verifyMessageSync(m)) throw new Rejected("bad-signature", "message: bad shape or signature");
      return tx(() => {
        const { cid } = encode(m);
        const at = q.messageAt.get(m.from, m.seq);
        if (at) {
          if (fromBytes(at.cid as Uint8Array).equals(cid)) return cid; // same record again: idempotent, like put
          throw new Rejected("duplicate-seq", `message: ${m.from} already sent seq ${m.seq}`);
        }
        put(m);
        indexMessage(cid, m);
        return cid;
      });
    },

    async findByPrefix(prefix) {
      // Origins are stored binary, so the match is on the formatted string; a full scan is fine at this scale.
      const out: CID[] = [];
      for (const r of q.origins.iterate()) {
        const cid = fromBytes(r.origin as Uint8Array);
        if (fmt(cid).startsWith(prefix)) out.push(cid);
      }
      return out;
    },

    chains: {
      async open(origin) {
        return tx(() => {
          const cid = put(origin);
          register(cid, origin as Obj);
          return cid;
        });
      },

      async append(origin, body) {
        return tx(() => {
          const row = chainRow(origin);
          const seq = (row.seq as number) + 1;
          // The chain fields are the store's to set; a caller's copies are overridden. `at` is the caller's: no clock here.
          if (typeof body.at !== "number") throw new TypeError("append: body.at (log time) is required");
          const update = { ...body, origin, prev: fromBytes(row.tip as Uint8Array), seq };
          const cid = put(update);
          q.updateIns.run(cid.bytes, origin.bytes, seq);
          writeEdges(origin, seq, updateEdges(update));
          move(origin, row.kind, cid, seq, update);
          return cid;
        });
      },

      async tip(origin) {
        return fromBytes(chainRow(origin).tip as Uint8Array);
      },

      async *history(origin) {
        chainRow(origin);
        const ups = q.updatesOf.all(origin.bytes);
        yield origin;
        for (const u of ups) yield fromBytes(u.cid as Uint8Array);
      },

      async originOf(cid) {
        if (q.chainGet.get(cid.bytes)) return cid;
        const u = q.updateOrigin.get(cid.bytes);
        if (u) return fromBytes(u.origin as Uint8Array);
        throw new NotFound(fmt(cid));
      },
    },

    log: {
      async append(entry) {
        return tx(() => {
          if (entry.envelope && q.logOf.get(entry.envelope.bytes)) throw new Rejected("duplicate-envelope", `log: envelope ${fmt(entry.envelope)} is already admitted`);
          if (entry.outcome && q.logOf.get(entry.outcome.emit.bytes)) throw new Rejected("duplicate-outcome", `log: emit ${fmt(entry.outcome.emit)} already has an outcome`);
          const last = q.logTip.get();
          const tipCid = last ? fromBytes(last.cid as Uint8Array) : undefined;
          checkExtends(entry, tipCid, tipCid ? getBlock<LogEntry>(tipCid) : undefined);
          const cid = put(entry);
          q.logIns.run(entry.n, cid.bytes, (entry.envelope ?? entry.outcome?.emit)?.bytes ?? null);
          return cid;
        });
      },
      async byEnvelope(envelope) {
        const r = q.logOf.get(envelope.bytes);
        const cid = r ? fromBytes(r.cid as Uint8Array) : undefined;
        return cid && getBlock<LogEntry>(cid).envelope ? cid : undefined;
      },
      async outcomeOf(emit) {
        const r = q.logOf.get(emit.bytes);
        const cid = r ? fromBytes(r.cid as Uint8Array) : undefined;
        return cid && getBlock<LogEntry>(cid).outcome ? cid : undefined;
      },
      async tip() {
        const last = q.logTip.get();
        return last ? fromBytes(last.cid as Uint8Array) : undefined;
      },
      async *entries(from = 0) {
        for (const r of q.logFrom.all(from)) {
          const cid = fromBytes(r.cid as Uint8Array);
          yield { cid, entry: getBlock<LogEntry>(cid) };
        }
      },
    },

    edges: {
      async refsFrom(cid) {
        return q.refsFrom.all(cid.bytes).map((r) => toRef(r.to as string, r.rel as string, r.locator));
      },

      async refsTo(cid) {
        return q.refsTo.all(fmt(cid)).map((r) => ({
          ...toRef(cid, r.rel as string, r.locator),
          from: fromBytes(r.from as Uint8Array),
        }));
      },

      async *query(f: Filter) {
        if (f.kind === "message" || (f.kind === undefined && (f.from !== undefined || f.to !== undefined))) {
          const ms = q.messageQuery.all({
            from: f.from ?? null, to: f.to ?? null, since: f.since ?? null, before: f.before ?? null, limit: f.limit ?? -1,
          });
          for (const r of ms) yield fromBytes(r.cid as Uint8Array);
          return;
        }
        yield* rows(q.query, {
          kind: f.kind ?? null,
          thread: f.thread?.bytes ?? null,
          program: f.program?.bytes ?? null,
          states: f.state ? JSON.stringify(f.state) : null,
          parentless: f.parentless === undefined ? null : f.parentless ? 1 : 0,
          since: f.since ?? null,
          before: f.before ?? null,
          tipAt: f.orderBy === "tipAt" ? 1 : 0,
          limit: f.limit ?? -1,
        });
      },

      async rebuild() {
        tx(() => {
          q.wipeEdges.run();
          q.wipeUpdates.run();
          q.wipeChains.run();
          q.wipeMessages.run();

          // Origins are thread/node blocks plus anything an update names as
          // its origin. A chain of another kind opened but never appended to
          // is indistinguishable from a plain block and is not recovered.
          const origins = new Map<string, { cid: CID; block: Obj }>();
          const named = new Set<string>();
          const ups: Array<{ cid: CID; origin: CID; seq: number; edges: EdgeRow[] }> = [];
          for (const r of q.blockAll.iterate()) {
            const cid = fromBytes(r.cid as Uint8Array);
            if (cid.code === RAW_CODE || cid.code === GIT_RAW_CODE) continue; // wasm modules, git blobs/trees: not dag-cbor
            const block = decode<unknown>(r.bytes as Uint8Array);
            if (!isObj(block)) continue;
            if (block.kind === "message") {
              // Re-verified: put() can store an unsigned look-alike. Plain INSERT: two
              // valid messages at one (from, seq) is equivocation, and should fail loudly.
              if (verifyMessageSync(block)) indexMessage(cid, block);
              continue;
            }
            if (isUpdate(block)) {
              ups.push({ cid, origin: block.origin, seq: block.seq, edges: updateEdges(block) });
              named.add(fmt(block.origin));
            } else if (block.kind === "thread" || block.kind === "node") {
              origins.set(fmt(cid), { cid, block });
            }
          }
          for (const s of named) {
            if (origins.has(s)) continue;
            const cid = parse(s);
            const row = q.blockGet.get(cid.bytes);
            if (!row) continue; // update whose origin we never stored: orphan, skip
            const block = decode<unknown>(row.bytes as Uint8Array);
            if (isObj(block) && !isUpdate(block)) origins.set(s, { cid, block });
          }

          for (const { cid, block } of origins.values()) register(cid, block);
          for (const u of ups) {
            if (!origins.has(fmt(u.origin))) continue;
            // Plain INSERT: two updates claiming one seq is a fork, and should fail loudly.
            q.updateIns.run(u.cid.bytes, u.origin.bytes, u.seq);
            writeEdges(u.origin, u.seq, u.edges);
          }
          for (const { cid, block } of origins.values()) {
            const last = q.lastUpdate.get(cid.bytes);
            if (!last) continue;
            const tip = fromBytes(last.cid as Uint8Array);
            move(cid, block.kind, tip, last.seq as number, getBlock<Obj>(tip));
          }
        });
      },
    },

    live: {
      handles: {
        async set(thread, handle: Handle) { q.handleSet.run(thread.bytes, JSON.stringify(handle)); },
        async get(thread) {
          const r = q.handleGet.get(thread.bytes);
          return r ? (JSON.parse(r.json as string) as Handle) : undefined;
        },
        async clear(thread) { q.handleClear.run(thread.bytes); },
      },

      async *resting(f = {}) {
        yield* rows(q.resting, {
          states: f.state ? JSON.stringify(f.state) : null,
          limit: f.limit ?? -1,
        });
      },

      async *due(now) {
        for (const r of q.due.all(now)) yield fromBytes(r.origin as Uint8Array);
      },

      async *waitersOn(thread) {
        for (const r of q.waitersOn.all(fmt(thread))) yield fromBytes(r.origin as Uint8Array);
      },

      async *waitingFrom(identity) {
        for (const r of q.waitingFrom.all(identity)) yield fromBytes(r.origin as Uint8Array);
      },

      async *awaiting(envelope) {
        for (const r of q.awaiting.all(fmt(envelope))) yield fromBytes(r.origin as Uint8Array);
      },

      cursor: {
        async get() { return (q.metaGet.get("cursor")?.value as number | undefined) ?? 0; },
        async set(n) { q.metaSet.run("cursor", n); },
      },
    },

    async close() { db.close(); },
  };
  if (stale) void store.edges.rebuild(); // synchronous body: done before we return
  return store;
}

// ---------------------------------------------------------------- derivation
// Pure functions of blocks. open/append and rebuild share them, which is what
// makes the index reproducible.

const RAW_CODE = 0x55, GIT_RAW_CODE = 0x78;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !isCID(v);
}

function isUpdate(b: Obj): b is Obj & { origin: CID; prev: CID; seq: number } {
  return isCID(b.origin) && isCID(b.prev) && Number.isInteger(b.seq) && (b.seq as number) >= 1;
}

const str = (v: unknown) => (typeof v === "string" ? v : null);
const num = (v: unknown) => (typeof v === "number" ? v : null);
const cidBytes = (v: unknown) => (isCID(v) ? v.bytes : null);

function originMeta(cid: CID, b: Obj): Record<string, SQLInputValue> {
  return {
    origin: cid.bytes,
    kind: str(b.kind),
    thread: b.kind === "node" ? cidBytes(b.thread) : null,
    launched_by: cidBytes(b.launchedBy),
    at: num(b.at),
    program: b.kind === "thread" ? cidBytes(b.program) : null,
  };
}

function tipMeta(kind: unknown, tip: Obj): Record<string, SQLInputValue> {
  const tip_at = num(tip.at);
  if (kind !== "thread") return { state: null, until: null, waiting_on: null, tip_at, waiting_from: null, awaits: null };
  const w = Array.isArray(tip.waitingOn) ? tip.waitingOn.filter(isCID).map(fmt) : null;
  const a = Array.isArray(tip.awaits) ? tip.awaits.filter(isCID).map(fmt) : null;
  return { state: str(tip.state), until: num(tip.until), waiting_on: w ? JSON.stringify(w) : null, tip_at, waiting_from: str(tip.waitingFrom), awaits: a?.length ? JSON.stringify(a) : null };
}

function edge(to: unknown, rel: string, locator?: unknown): EdgeRow[] {
  if (isCID(to)) return [{ to: fmt(to), rel, locator: str(locator) }];
  if (typeof to === "string") return [{ to, rel, locator: str(locator) }];
  return [];
}

export function originEdges(b: Obj): EdgeRow[] {
  const out: EdgeRow[] = [];
  if (Array.isArray(b.refs)) {
    for (const r of b.refs) if (isObj(r) && typeof r.rel === "string") out.push(...edge(r.to, r.rel, r.locator));
  }
  out.push(...edge(b.launchedBy, "launched-by"));
  return out;
}

export function updateEdges(u: Obj): EdgeRow[] {
  const out: EdgeRow[] = [];
  const rest = isObj(u.rest) ? u.rest : {};
  for (const w of [u.waitingOn, rest.waitingOn]) {
    if (Array.isArray(w)) for (const t of w) out.push(...edge(t, "depends-on"));
  }
  out.push(...edge(u.resolution, "resolves"));
  if (isObj(u.emit) && u.emit.type === "launched") out.push(...edge(u.emit.thread, "launched"));
  return out;
}

export function toRef(to: CID | string, rel: string, locator: SQLOutputValue): Ref {
  let target: CID | string = to;
  if (typeof to === "string" && !to.includes(":")) {
    try { target = parse(to); } catch { /* not a CID after all; hand back the string */ }
  }
  const ref: Ref = { to: target, rel };
  if (typeof locator === "string") ref.locator = locator;
  return ref;
}

// The Store as one SQLite file (node:sqlite). `blocks` is the record; every
// other table except `handles` is an index derived from it and can be dropped
// and rebuilt (edges.rebuild). node:sqlite is synchronous, so each method body
// runs to completion without yielding; BEGIN IMMEDIATE covers other processes
// sharing the file.

import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { CID, decode, encode, fmt, fromBytes, isCID, parse } from "./cid.ts";
import { NotFound, type Filter, type Handle, type Store } from "./store.ts";
import type { Block, Ref } from "./types.ts";

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
  runner      TEXT,               -- threads: origin.runner
  thread      BLOB,               -- nodes: origin.thread
  launched_by BLOB,               -- origin.launchedBy
  at          INTEGER,            -- origin.at
  state       TEXT,               -- threads: tip.state (NULL until the first update)
  until       INTEGER,            -- threads: tip.until
  waiting_on  TEXT                -- threads: tip.waitingOn as a JSON array of CID strings
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS chains_kind_at ON chains(kind, at);
CREATE INDEX IF NOT EXISTS chains_thread  ON chains(thread, at) WHERE thread IS NOT NULL;
CREATE INDEX IF NOT EXISTS chains_state   ON chains(state) WHERE state IS NOT NULL;
CREATE INDEX IF NOT EXISTS chains_until   ON chains(until) WHERE state = 'waiting';

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

-- Not derived and not rebuilt: runner bookkeeping, overwritten freely.
CREATE TABLE IF NOT EXISTS handles (
  thread BLOB PRIMARY KEY,
  json   TEXT NOT NULL
) WITHOUT ROWID;
`;

type Row = Record<string, SQLOutputValue>;
type Obj = Record<string, unknown>;
interface EdgeRow { to: string; rel: string; locator: string | null }

export function openStore(path: string): Store {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  db.exec(DDL);

  const q = {
    begin: db.prepare("BEGIN IMMEDIATE"),
    commit: db.prepare("COMMIT"),
    rollback: db.prepare("ROLLBACK"),

    blockPut: db.prepare("INSERT OR IGNORE INTO blocks (cid, bytes) VALUES (?, ?)"),
    blockGet: db.prepare("SELECT bytes FROM blocks WHERE cid = ?"),
    blockHas: db.prepare("SELECT 1 AS x FROM blocks WHERE cid = ?"),
    blockAll: db.prepare("SELECT cid, bytes FROM blocks ORDER BY cid"),

    chainIns: db.prepare(`INSERT OR IGNORE INTO chains
      (origin, tip, seq, kind, runner, thread, launched_by, at)
      VALUES (:origin, :origin, 0, :kind, :runner, :thread, :launched_by, :at)`),
    chainGet: db.prepare("SELECT tip, seq, kind FROM chains WHERE origin = ?"),
    chainMove: db.prepare(`UPDATE chains SET tip = :tip, seq = :seq,
      state = :state, until = :until, waiting_on = :waiting_on WHERE origin = :origin`),
    updateIns: db.prepare("INSERT INTO updates (cid, origin, seq) VALUES (?, ?, ?)"),
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
      AND (:runner IS NULL OR runner = :runner)
      AND (:states IS NULL OR state IN (SELECT value FROM json_each(:states)))
      AND (:parentless IS NULL OR (kind = 'thread' AND (launched_by IS NULL) = :parentless))
      AND (:since IS NULL OR at >= :since)
      AND (:before IS NULL OR at < :before)
      ORDER BY at DESC, origin DESC LIMIT :limit`),
    resting: db.prepare(`SELECT origin FROM chains
      WHERE kind = 'thread' AND (state IS NULL OR state <> 'finished')
      AND (:runner IS NULL OR runner = :runner)
      AND (:states IS NULL OR state IN (SELECT value FROM json_each(:states)))
      ORDER BY at, origin LIMIT :limit`),
    due: db.prepare(`SELECT origin FROM chains
      WHERE state = 'waiting' AND kind = 'thread' AND until <= ? ORDER BY until, origin`),
    waitersOn: db.prepare(`SELECT origin FROM chains
      WHERE kind = 'thread' AND waiting_on IS NOT NULL
      AND EXISTS (SELECT 1 FROM json_each(waiting_on) WHERE value = ?) ORDER BY at, origin`),

    handleSet: db.prepare(`INSERT INTO handles (thread, json) VALUES (?, ?)
      ON CONFLICT (thread) DO UPDATE SET json = excluded.json`),
    handleGet: db.prepare("SELECT json FROM handles WHERE thread = ?"),
    handleClear: db.prepare("DELETE FROM handles WHERE thread = ?"),

    wipeEdges: db.prepare("DELETE FROM edges"),
    wipeUpdates: db.prepare("DELETE FROM updates"),
    wipeChains: db.prepare("DELETE FROM chains"),
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

  function* rows(stmt: { all(p: Record<string, SQLInputValue>): Row[] }, p: Record<string, SQLInputValue>) {
    // all() rather than iterate(): callers append while they walk the results.
    for (const r of stmt.all(p)) yield fromBytes(r.origin as Uint8Array);
  }

  const store: Store = {
    async put(value) { return put(value); },
    async get<T extends Block = Block>(cid: CID) { return getBlock<T>(cid); },
    async has(cid) { return q.blockHas.get(cid.bytes) !== undefined; },

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
          // The chain fields are the store's to set; a caller's copies are overridden.
          const update = { ...body, origin, prev: fromBytes(row.tip as Uint8Array), seq, at: Date.now() };
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
        yield* rows(q.query, {
          kind: f.kind ?? null,
          thread: f.thread?.bytes ?? null,
          runner: f.runner ?? null,
          states: f.state ? JSON.stringify(f.state) : null,
          parentless: f.parentless === undefined ? null : f.parentless ? 1 : 0,
          since: f.since ?? null,
          before: f.before ?? null,
          limit: f.limit ?? -1,
        });
      },

      async rebuild() {
        tx(() => {
          q.wipeEdges.run();
          q.wipeUpdates.run();
          q.wipeChains.run();

          // Origins are thread/node blocks plus anything an update names as
          // its origin. A chain of another kind opened but never appended to
          // is indistinguishable from a plain block and is not recovered.
          const origins = new Map<string, { cid: CID; block: Obj }>();
          const named = new Set<string>();
          const ups: Array<{ cid: CID; origin: CID; seq: number; edges: EdgeRow[] }> = [];
          for (const r of q.blockAll.iterate()) {
            const cid = fromBytes(r.cid as Uint8Array);
            const block = decode<unknown>(r.bytes as Uint8Array);
            if (!isObj(block)) continue;
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
          runner: f.runner ?? null,
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
    },

    async close() { db.close(); },
  };
  return store;
}

// ---------------------------------------------------------------- derivation
// Pure functions of blocks. open/append and rebuild share them, which is what
// makes the index reproducible.

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
    runner: b.kind === "thread" ? str(b.runner) : null,
    thread: b.kind === "node" ? cidBytes(b.thread) : null,
    launched_by: cidBytes(b.launchedBy),
    at: num(b.at),
  };
}

function tipMeta(kind: unknown, tip: Obj): Record<string, SQLInputValue> {
  if (kind !== "thread") return { state: null, until: null, waiting_on: null };
  const w = Array.isArray(tip.waitingOn) ? tip.waitingOn.filter(isCID).map(fmt) : null;
  return { state: str(tip.state), until: num(tip.until), waiting_on: w ? JSON.stringify(w) : null };
}

function edge(to: unknown, rel: string, locator?: unknown): EdgeRow[] {
  if (isCID(to)) return [{ to: fmt(to), rel, locator: str(locator) }];
  if (typeof to === "string") return [{ to, rel, locator: str(locator) }];
  return [];
}

function originEdges(b: Obj): EdgeRow[] {
  const out: EdgeRow[] = [];
  if (Array.isArray(b.refs)) {
    for (const r of b.refs) if (isObj(r) && typeof r.rel === "string") out.push(...edge(r.to, r.rel, r.locator));
  }
  out.push(...edge(b.launchedBy, "launched-by"));
  return out;
}

function updateEdges(u: Obj): EdgeRow[] {
  const out: EdgeRow[] = [];
  const rest = isObj(u.rest) ? u.rest : {};
  for (const w of [u.waitingOn, rest.waitingOn]) {
    if (Array.isArray(w)) for (const t of w) out.push(...edge(t, "depends-on"));
  }
  out.push(...edge(u.resolution, "resolves"));
  if (isObj(u.emit) && u.emit.type === "launched") out.push(...edge(u.emit.thread, "launched"));
  return out;
}

function toRef(to: CID | string, rel: string, locator: SQLOutputValue): Ref {
  let target: CID | string = to;
  if (typeof to === "string" && !to.includes(":")) {
    try { target = parse(to); } catch { /* not a CID after all; hand back the string */ }
  }
  const ref: Ref = { to: target, rel };
  if (typeof locator === "string") ref.locator = locator;
  return ref;
}

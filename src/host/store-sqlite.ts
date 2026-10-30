// The host's store (the settled split, 2026-10-31): ONE SQLite database for the
// whole host (node's built-in `node:sqlite`, synchronous), every instance a
// SET of it — the store interface of the wasm kernel's shim (kernel-zig/web/
// kernel.js MemoryStore: getBlock/hasBlock/putBlock/getPointer/setPointer/
// begin/commit/rollback), so the machine asks for a record by CID, writes
// under its heads, and never knows where it lives (requirement 5).
//
//   blocks(cid BLOB PRIMARY KEY, bytes BLOB)          each block once for the host
//   members(set TEXT, cid BLOB, PRIMARY KEY(set, cid)) what each set holds
//   pointers(set TEXT, name TEXT, cid BLOB, PRIMARY KEY(set, name))
//
// An instance's view: a read answers when the CID is in its own set OR in the
// `host/chain` set (the chain exception, decided 2026-10-27: the host's header
// chain is the one shared read); a write goes to its own set. The `host/chain`
// set is written only by the host's chain holder (a view with no chain
// exception of its own). A batch (begin … commit) is one SQLite transaction at
// commit: reads see the batch, rollback drops it. Every worker opens its own
// connection (WAL; a writer waits on SQLite's lock, `busy_timeout`, for
// another worker's commit).
//
// host.db's `store` for such an instance: `sqlite:<db path>` (the set: its
// handle); its spec `sqlite:<db path>#<set>` (index-store.ts).

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { CHAIN_SET } from "../runtime/index-store.ts";

const key = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("latin1");

/** Open (and make) the host's database: the three tables, WAL. */
export function openHostDb(path: string, o: { readOnly?: boolean } = {}): DatabaseSync {
  if (!o.readOnly) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, o.readOnly ? { readOnly: true } : {});
  db.exec("PRAGMA busy_timeout = 60000");
  if (!o.readOnly) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec(`CREATE TABLE IF NOT EXISTS blocks (cid BLOB PRIMARY KEY, bytes BLOB NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS members ("set" TEXT NOT NULL, cid BLOB NOT NULL, PRIMARY KEY ("set", cid)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS pointers ("set" TEXT NOT NULL, name TEXT NOT NULL, cid BLOB NOT NULL, PRIMARY KEY ("set", name)) WITHOUT ROWID;`);
  }
  return db;
}

type Batch = { blocks: Map<string, [Uint8Array, Uint8Array]>; pointers: Map<string, Uint8Array> };

/**
 * One set of the host's database as the shim's store: an instance's (with the chain exception), or
 * the host chain's (`set` = host/chain). `readOnly`: a replay's source.
 */
export class SqliteSetStore {
  readonly db: DatabaseSync;
  readonly set: string;
  readonly readOnly: boolean;
  private tx: Batch | null = null;
  private q: { get: StatementSync; has: StatementSync; putBlock: StatementSync; putMember: StatementSync; ptr: StatementSync; setPtr: StatementSync };

  constructor(db: DatabaseSync, set: string, o: { readOnly?: boolean } = {}) {
    this.db = db;
    this.set = set;
    this.readOnly = !!o.readOnly;
    const sets = set === CHAIN_SET ? 'm."set" = ?1' : '(m."set" = ?1 OR m."set" = ?2)';
    this.q = {
      get: db.prepare(`SELECT b.bytes FROM members m JOIN blocks b ON b.cid = m.cid WHERE m.cid = ?3 AND ${sets} LIMIT 1`),
      has: db.prepare(`SELECT 1 FROM members m WHERE m.cid = ?3 AND ${sets} LIMIT 1`),
      putBlock: db.prepare("INSERT OR IGNORE INTO blocks (cid, bytes) VALUES (?, ?)"),
      putMember: db.prepare(`INSERT OR IGNORE INTO members ("set", cid) VALUES (?, ?)`),
      ptr: db.prepare(`SELECT cid FROM pointers WHERE "set" = ? AND name = ?`),
      setPtr: db.prepare(`INSERT INTO pointers ("set", name, cid) VALUES (?, ?, ?) ON CONFLICT ("set", name) DO UPDATE SET cid = excluded.cid`),
    };
  }

  private args(cid: Uint8Array): [string, string, Uint8Array] { return [this.set, CHAIN_SET, cid]; }

  getBlock(cid: Uint8Array): Uint8Array | undefined {
    const t = this.tx?.blocks.get(key(cid));
    if (t) return t[1];
    const r = this.q.get.get(...this.args(cid)) as { bytes: Uint8Array } | undefined;
    return r ? new Uint8Array(r.bytes) : undefined;
  }
  hasBlock(cid: Uint8Array): boolean {
    if (this.tx?.blocks.has(key(cid))) return true;
    return this.q.has.get(...this.args(cid)) !== undefined;
  }
  putBlock(cid: Uint8Array, bytes: Uint8Array): boolean {
    if (this.readOnly) return false;
    if (this.tx) { this.tx.blocks.set(key(cid), [cid, bytes]); return true; }
    this.q.putBlock.run(cid, bytes);
    this.q.putMember.run(this.set, cid);
    return true;
  }
  getPointer(name: string): Uint8Array | undefined {
    if (this.tx?.pointers.has(name)) return this.tx.pointers.get(name);
    const r = this.q.ptr.get(this.set, name) as { cid: Uint8Array } | undefined;
    return r ? new Uint8Array(r.cid) : undefined;
  }
  setPointer(name: string, cid: Uint8Array): boolean {
    if (this.readOnly) return false;
    if (this.tx) { this.tx.pointers.set(name, cid); return true; }
    this.q.setPtr.run(this.set, name, cid);
    return true;
  }
  begin(): void { this.tx = { blocks: new Map(), pointers: new Map() }; }
  commit(): boolean {
    const t = this.tx;
    this.tx = null;
    if (!t || (t.blocks.size === 0 && t.pointers.size === 0)) return true;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [cid, bytes] of t.blocks.values()) { this.q.putBlock.run(cid, bytes); this.q.putMember.run(this.set, cid); }
      for (const [name, cid] of t.pointers) this.q.setPtr.run(this.set, name, cid);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return true;
  }
  rollback(): void { this.tx = null; }

  /** Every block the set holds (a replay's source: the raw modules first; a checkpoint's extras). */
  *entries(): Generator<[Uint8Array, Uint8Array]> {
    for (const r of this.db.prepare(`SELECT m.cid, b.bytes FROM members m JOIN blocks b ON b.cid = m.cid WHERE m."set" = ?`).iterate(this.set) as Iterable<{ cid: Uint8Array; bytes: Uint8Array }>) yield [new Uint8Array(r.cid), new Uint8Array(r.bytes)];
  }
}

/** Whether the set has committed a state (its index's `state` pointer). */
export function setHasState(db: DatabaseSync, set: string): boolean {
  try { return db.prepare(`SELECT 1 FROM pointers WHERE "set" = ? AND name = 'state'`).get(set) !== undefined; } catch { return false; }
}

/**
 * A set as a native kernel's store file (kernel-zig/src/sqlite_store.zig: `blocks(cid, bytes)`,
 * `pointers(name, cid)`): the set's blocks and those of `host/chain` (what it reads through the
 * chain exception), its pointers — what `skein-kernel replay` takes (the two kernels agree:
 * requirement 1's proof). `out` must not exist.
 */
export function exportSet(dbPath: string, set: string, out: string): void {
  const src = new DatabaseSync(dbPath, { readOnly: true });
  const dst = new DatabaseSync(out);
  try {
    dst.exec(`CREATE TABLE blocks (cid BLOB PRIMARY KEY, bytes BLOB NOT NULL) WITHOUT ROWID;
      CREATE TABLE pointers (name TEXT PRIMARY KEY, cid BLOB NOT NULL) WITHOUT ROWID;`);
    const put = dst.prepare("INSERT OR IGNORE INTO blocks (cid, bytes) VALUES (?, ?)");
    dst.exec("BEGIN");
    for (const r of src.prepare(`SELECT b.cid, b.bytes FROM members m JOIN blocks b ON b.cid = m.cid WHERE m."set" = ? OR m."set" = ?`).iterate(set, CHAIN_SET) as Iterable<{ cid: Uint8Array; bytes: Uint8Array }>) put.run(r.cid, r.bytes);
    const ptr = dst.prepare("INSERT INTO pointers (name, cid) VALUES (?, ?)");
    for (const r of src.prepare(`SELECT name, cid FROM pointers WHERE "set" = ?`).all(set) as Array<{ name: string; cid: Uint8Array }>) ptr.run(r.name, r.cid);
    dst.exec("COMMIT");
  } finally { src.close(); dst.close(); }
}

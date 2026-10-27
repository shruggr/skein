// The host's opener of instance stores (#96, #133): a SQLite file through
// src/runtime/index-store.ts, or a set of the host's LMDB environment,
// `lmdb:<env dir>#<set>` (index-store.ts `storeSpec`), read here directly,
// read only, through lmdb-js — with the kernel's member gate
// (kernel-zig/src/lmdb_store.zig): a block is there if the set holds it, or
// the chain's set does. The disk is the host's (src/runtime reads none).

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fromBytes, type CID } from "../runtime/cid.ts";
import { CHAIN_SET, indexStoreOver, openStoreFile as openFile, parseLmdbSpec, type IndexStore } from "../runtime/index-store.ts";
import type { SqliteStore } from "../runtime/sqlite.ts";

/** A store, whichever backend: a file (index-store.ts openStoreFile), or an LMDB set, read only. */
export function openStoreFile(spec: string, o: { readOnly?: boolean } = {}): SqliteStore {
  const l = parseLmdbSpec(spec);
  if (!l) return openFile(spec, o);
  if (o.readOnly === false) throw new Error(`${spec}: an LMDB set is read only here (the kernel writes it; the host never does)`);
  return openLmdbStore(l.dir, l.set);
}

/** Whether a store is there to read: the file; for an LMDB set, its state pointer (the kernel has committed). */
export function storeExists(spec: string): boolean {
  const l = parseLmdbSpec(spec);
  if (!l) return existsSync(spec);
  if (!existsSync(join(l.dir, "data.mdb"))) return false;
  const e = lmdbEnv(l.dir);
  e.pointers.resetReadTxn();
  return e.pointers.doesExist(Buffer.concat([setPrefix(l.set), Buffer.from("state")]));
}

type LmdbDb = { get(k: Uint8Array): Buffer | undefined; doesExist(k: Uint8Array): boolean; getKeys(o: { start: Uint8Array; end?: Uint8Array }): Iterable<Buffer>; resetReadTxn(): void };
type LmdbEnv = { blocks: LmdbDb; members: LmdbDb; pointers: LmdbDb };
const envs = new Map<string, LmdbEnv>();

/**
 * The environment at `dir`, opened read only once per process (LMDB: one open per process) and
 * kept. lmdb-js must link LMDB 0.9.x (its data-v1 build: `LMDB_DATA_V1=true npm rebuild lmdb
 * --build-from-source`, kernel-zig/README.md): its prebuilt binaries link LMDB 0.9.90 (data format
 * 2, LMDB's 1.0 line), which cannot open the kernel's 0.9.36 environment.
 */
function lmdbEnv(dir: string): LmdbEnv {
  const had = envs.get(dir);
  if (had) return had;
  const lmdb = createRequire(import.meta.url)("lmdb") as { version: { major: number; minor: number; patch: number }; open(o: Record<string, unknown>): { openDB(o: Record<string, unknown>): LmdbDb } };
  const v = lmdb.version;
  if (v.major !== 0 || v.minor !== 9 || v.patch >= 90) throw new Error(`lmdb-js links LMDB ${v.major}.${v.minor}.${v.patch}, not 0.9.x: it cannot read the kernel's environment (rebuild it: LMDB_DATA_V1=true npm rebuild lmdb --build-from-source)`);
  const env = lmdb.open({ path: dir, readOnly: true, noSubdir: false, maxDbs: 4, maxReaders: 4096, mapSize: 2 ** 40 });
  const db = (name: string) => env.openDB({ name, encoding: "binary", keyEncoding: "binary" });
  const e = { blocks: db("blocks"), members: db("members"), pointers: db("pointers") };
  envs.set(dir, e);
  return e;
}

const setPrefix = (set: string) => Buffer.concat([Buffer.from(set), Buffer.from([0])]);
const prefixEnd = (p: Buffer) => { const b = Buffer.from(p); b[b.length - 1]++; return b; };

/**
 * A set of an LMDB environment through the index (#96), read only: the same reader as a SQLite
 * file's, with the kernel's gate — a block is there if the set holds it, or the chain's set does
 * (#133); one only another set holds is absent. Each state read takes a fresh snapshot.
 */
export function openLmdbStore(dir: string, set: string): IndexStore {
  const e = lmdbEnv(dir);
  const own = setPrefix(set), chain = setPrefix(CHAIN_SET);
  const member = (c: Uint8Array) => e.members.doesExist(Buffer.concat([own, c])) || e.members.doesExist(Buffer.concat([chain, c]));
  return indexStoreOver({
    get: (c) => (member(c) ? e.blocks.get(c) : undefined),
    has: (c) => member(c) && e.blocks.doesExist(c),
    pointer: () => { e.pointers.resetReadTxn(); return e.pointers.get(Buffer.concat([own, Buffer.from("state")])); },
    close: () => {},
  });
}

/** Every block a store holds (a SQLite file's `blocks`; an LMDB set's members), for a checkpoint's extras. */
export function* storeBlocks(spec: string): Generator<{ cid: CID; bytes: Uint8Array }> {
  const l = parseLmdbSpec(spec);
  if (l) {
    const e = lmdbEnv(l.dir);
    e.members.resetReadTxn();
    const own = setPrefix(l.set);
    for (const k of e.members.getKeys({ start: own, end: prefixEnd(own) })) {
      const c = new Uint8Array(k.subarray(own.length));
      const bytes = e.blocks.get(c);
      if (bytes) yield { cid: fromBytes(c), bytes: new Uint8Array(bytes) };
    }
    return;
  }
  const db = new DatabaseSync(spec, { readOnly: true });
  try {
    for (const r of db.prepare("SELECT cid, bytes FROM blocks").all() as Array<{ cid: Uint8Array; bytes: Uint8Array }>) yield { cid: fromBytes(new Uint8Array(r.cid)), bytes: new Uint8Array(r.bytes) };
  } finally { db.close(); }
}


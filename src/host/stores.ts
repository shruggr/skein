// The host's opener of instance stores (#96, #133): a SQLite file through
// src/runtime/index-store.ts, or a set of the host's LMDB environment,
// `lmdb:<env dir>#<set>` (index-store.ts `storeSpec`), read here directly,
// read only, through lmdb-js — with the kernel's member gate
// (kernel-zig/src/lmdb_store.zig): a block is there if the set holds it, or
// the chain's set does. The disk is the host's (src/runtime reads none).
//
// A set of the one-process kernel's RocksDB database, `rocksdb:<db dir>#<set>`
// (#158), is read through that process — RocksDB lets no second process see
// the live database — over its host-read socket (`<db dir>/kernel.sock`,
// kernel-zig/src/host.zig): `get`/`has` by CID through the set's member gate
// (the frame names the `set`: a block only another instance holds is absent,
// as for an LMDB set), the set's `state` pointer, and `members` (the CIDs it
// holds: a checkpoint's extras), the frames its stdin takes. The index reader here is
// synchronous, so the socket is spoken from a worker thread the caller waits
// on (Atomics.wait, the answer taken with receiveMessageOnPort). With no
// kernel process running there, a read is refused: the host must run.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from "node:worker_threads";
import { decode, encode, fromBytes, type CID } from "../runtime/cid.ts";
import { CHAIN_SET, indexStoreOver, openStoreFile as openFile, parseLmdbSpec, parseRocksSpec, type IndexStore } from "../runtime/index-store.ts";
import { KernelHost } from "./kernel.ts";
import type { SqliteStore } from "../runtime/sqlite.ts";

/** A store, whichever backend: a file (index-store.ts openStoreFile), or an LMDB set, read only. */
export function openStoreFile(spec: string, o: { readOnly?: boolean } = {}): SqliteStore {
  const r = parseRocksSpec(spec);
  if (r) {
    if (o.readOnly === false) throw new Error(`${spec}: a RocksDB set is read only here (the kernel writes it; the host never does)`);
    return openRocksStore(r.dir, r.set);
  }
  const l = parseLmdbSpec(spec);
  if (!l) return openFile(spec, o);
  if (o.readOnly === false) throw new Error(`${spec}: an LMDB set is read only here (the kernel writes it; the host never does)`);
  return openLmdbStore(l.dir, l.set);
}

/** Whether a store is there to read: the file; for an LMDB set, its state pointer (the kernel has committed). */
export function storeExists(spec: string): boolean {
  const r = parseRocksSpec(spec);
  if (r) return rocksReader(r.dir).request({ op: "state", h: r.set }) != null;
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

/** The host chain as it stands (#156): its record's CID, tip height and hash; undefined when empty. */
export type HostChain = { root: CID; height: number; hash: string };

/**
 * The host chain a store sees (#156): a RocksDB database's (the kernel process's `chain` frame over
 * its host-read socket), or a SQLite file's or an LMDB set's own (a serve instance's: the pointer
 * `host/chain` and the record it names, read directly).
 */
export function readHostChain(spec: string): HostChain | undefined {
  const r = parseRocksSpec(spec);
  if (r) {
    const v = rocksReader(r.dir).request({ op: "chain" }) as { root: CID; height: number | bigint; hash: string } | null;
    return v ? { root: v.root, height: Number(v.height), hash: v.hash } : undefined;
  }
  let ptr: Uint8Array | undefined;
  let get: (c: Uint8Array) => Uint8Array | undefined;
  const l = parseLmdbSpec(spec);
  if (l) {
    if (!existsSync(join(l.dir, "data.mdb"))) return undefined;
    const e = lmdbEnv(l.dir);
    e.pointers.resetReadTxn();
    ptr = e.pointers.get(Buffer.concat([setPrefix(l.set), Buffer.from("host/chain")]));
    get = (c) => e.blocks.get(c);
  } else {
    if (!existsSync(spec)) return undefined;
    const db = new DatabaseSync(spec, { readOnly: true });
    try {
      const t = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pointers'").get();
      ptr = t ? db.prepare("SELECT cid FROM pointers WHERE name = 'host/chain'").get()?.cid as Uint8Array | undefined : undefined;
      if (!ptr) return undefined;
      const b = db.prepare("SELECT bytes FROM blocks WHERE cid = ?").get(ptr)?.bytes as Uint8Array | undefined;
      get = () => b;
    } finally { db.close(); }
  }
  if (!ptr) return undefined;
  const bytes = get(ptr);
  if (!bytes) return undefined;
  const v = decode<{ tip?: { height: number | bigint; hash: string } }>(bytes);
  if (!v.tip) return undefined;
  return { root: fromBytes(ptr), height: Number(v.tip.height), hash: v.tip.hash };
}

/** Every block a store holds (a SQLite file's `blocks`; an LMDB set's members), for a checkpoint's extras. */
export function* storeBlocks(spec: string): Generator<{ cid: CID; bytes: Uint8Array }> {
  const r = parseRocksSpec(spec);
  if (r) {
    // #158: the set's members, listed by the kernel; each block read through it.
    const rd = rocksReader(r.dir);
    for (const c of rd.request({ op: "members", set: r.set }) as CID[]) {
      const bytes = rd.request({ op: "get", set: r.set, v: c });
      if (bytes instanceof Uint8Array) yield { cid: c, bytes };
    }
    return;
  }
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


// ---------------------------------------------------------------- RocksDB, through the kernel (#158)

/** The worker thread: speaks the host-read socket for a waiting caller (one request at a time). */
const READER_WORKER = `
const { workerData } = require("node:worker_threads");
const net = require("node:net");
const { sock, flag, port } = workerData;
const i32 = new Int32Array(flag);
let conn, buf = Buffer.alloc(0), pending = false;
const done = (m) => { port.postMessage(m); Atomics.store(i32, 0, 1); Atomics.notify(i32, 0); };
function connect(until) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(sock);
    c.once("connect", () => {
      c.removeAllListeners("error");
      c.on("error", () => {});
      c.on("close", () => { if (conn === c) conn = undefined; if (pending) { pending = false; done({ error: "the kernel's socket closed" }); } });
      c.on("data", onData);
      resolve(c);
    });
    c.once("error", (e) => { if (Date.now() < until) setTimeout(() => connect(until).then(resolve, reject), 50); else reject(e); });
  });
}
function onData(d) {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4) {
    const n = buf.readUInt32BE(0);
    if (buf.length < 4 + n) return;
    const f = new Uint8Array(buf.subarray(4, 4 + n));
    buf = buf.subarray(4 + n);
    if (pending) { pending = false; done({ frame: f }); }
  }
}
port.on("message", async ({ bytes, waitMs }) => {
  try {
    if (!conn) { buf = Buffer.alloc(0); conn = await connect(Date.now() + waitMs); }
    pending = true;
    const h = Buffer.alloc(4); h.writeUInt32BE(bytes.length);
    conn.write(Buffer.concat([h, Buffer.from(bytes)]));
  } catch (e) { done({ error: (e && e.code) || String(e) }); }
});
`;

class RocksReader {
  private flag = new Int32Array(new SharedArrayBuffer(4));
  private port: MessagePort;
  private worker: Worker;
  private nextId = 1;
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    this.worker = new Worker(READER_WORKER, { eval: true, workerData: { sock: join(dir, "kernel.sock"), flag: this.flag.buffer, port: port2 }, transferList: [port2] });
    this.worker.unref();
    this.port.unref();
  }

  /** One frame to the kernel and its `ok`, synchronously. */
  request(f: { op: string; h?: string; set?: string; v?: unknown }): unknown {
    // The process this node process runs may still be starting: wait for its socket a while; else not at all.
    const waitMs = KernelHost.running(this.dir) ? 15_000 : 0;
    Atomics.store(this.flag, 0, 0);
    this.port.postMessage({ bytes: encode({ id: this.nextId++, ...f }).bytes, waitMs });
    if (Atomics.wait(this.flag, 0, 0, waitMs + 30_000) === "timed-out") throw new Error(`${this.dir}: the kernel's host-read socket did not answer`);
    const m = receiveMessageOnPort(this.port)?.message as { frame?: Uint8Array; error?: string } | undefined;
    if (!m || m.error !== undefined) throw new Error(`${this.dir}: a RocksDB set is read through the host's kernel process (skein-kernel host), and none answers at ${join(this.dir, "kernel.sock")} (${m?.error ?? "no answer"}): start the host (skein-host run)`);
    const a = decode<{ ok?: unknown; error?: string }>(m.frame!);
    if (typeof a.error === "string") throw new Error(`${this.dir}: ${a.error}`);
    return a.ok;
  }
}

const readers = new Map<string, RocksReader>();
function rocksReader(dir: string): RocksReader {
  let r = readers.get(dir);
  if (!r) { r = new RocksReader(dir); readers.set(dir, r); }
  return r;
}

/**
 * A set of the one-process kernel's RocksDB database (#158), read only, through the kernel: blocks by
 * CID through the set's gate (what the instance holds), the state pointer read on every state read.
 */
export function openRocksStore(dir: string, set: string): IndexStore {
  const r = rocksReader(dir);
  const asBytes = (v: unknown) => (v instanceof Uint8Array ? v : undefined);
  return indexStoreOver({
    get: (c) => asBytes(r.request({ op: "get", set, v: fromBytes(c) })),
    has: (c) => r.request({ op: "has", set, v: fromBytes(c) }) === true,
    pointer: () => { const p = r.request({ op: "state", h: set }) as CID | null | undefined; return p ? p.bytes : undefined; },
    close: () => {},
  });
}

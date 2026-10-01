// The store format of issue #30, read from TypeScript: a SQLite file holding
// only `blocks` and a `pointers` row `state` → the state record
// {kind: "skein-state", log, cursor, heads, index: {<map>: <root>}}, whose
// maps are Merkle search trees of dag-cbor nodes [left, [[key, value, right]…]]
// (the SDK's mst.zig, shruggr/skein-sdk src/mst.zig; kernel-zig/src/index.zig; kernel-zig/README.md "The index").
//
// - `openStoreFile(path)`: the right reader for a store file — this one when
//   the file has the state pointer, else sqlite.ts's (a store of blocks the
//   tools write, or a file from before #30). The explorer, skein-dev and
//   skein-host open files through it.
// - `indexStore(db)`: the `Store` interface over the maps, read only (blocks
//   may be added: they are a key→bytes map). The pointer is read on every
//   call, so a reader beside a live kernel follows it.
// - `derive(store)` + `buildTree`: the same maps built here from any Store's
//   chains and log, canonically — each the root the kernel keeps for the same
//   log (index-store.test.ts and equiv/overlay.ts check it against stores the
//   kernel wrote).
//
// Keys: numbers 8-byte big-endian with the sign bit flipped; binary CIDs;
// strings uvarint-length-prefixed. The derivation is sqlite.ts's.

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { CID, decode, encode, fmt, fromBytes, isCID } from "./cid.ts";
import { keptEdges, openStore, originEdges, toRef, updateEdges, type SqliteStore } from "./sqlite.ts";
import { BITCOIN_BLOCK, bitcoinEdges, bitcoinLinks, decodeBitcoin, displayHash, isBitcoin } from "./bitcoin.ts";
import { NotFound, type Filter, type LogEntry, type Store } from "./store.ts";
import type { Block, Ref } from "./types.ts";

type Obj = Record<string, unknown>;
export const MAPS = ["log", "unique", "chains", "updates", "threads", "resting", "sleepers", "awaits", "edges", "heads"] as const;
export type MapName = typeof MAPS[number];
export const STATE_KIND = "skein-state";

// ---------------------------------------------------------------- format 2, for display

const KEY_FIELDS = new Set(["identity", "owner", "sender", "to", "identityKey"]);
const HEX_FIELDS = new Set(["contentHash", "signature"]);
const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");

/**
 * A record as the TypeScript readers (the explorer, skein-dev, skein-host)
 * show it. Format 2 (issue #33, kernel-zig/src/log.zig) keeps identity keys,
 * hashes and signatures as byte strings and a genesis's `names` as a list;
 * here they read back as the hex (and the `{key: name}` map) the display code
 * knows, and a §7.3 envelope's `content` as base64. Display only: the
 * record's CID is its stored bytes'.
 */
export function display(v: unknown): unknown {
  if (!v || typeof v !== "object" || v instanceof Uint8Array || isCID(v)) return v;
  if (Array.isArray(v)) return v.map(display);
  const o = v as Obj;
  const out: Obj = {};
  for (const [k, x] of Object.entries(o)) {
    if (x instanceof Uint8Array && KEY_FIELDS.has(k) && x.length === 33) out[k] = hexOf(x);
    else if (x instanceof Uint8Array && HEX_FIELDS.has(k)) out[k] = hexOf(x);
    else if (x instanceof Uint8Array && k === "content" && o.metanetHandles === "1.0") out[k] = Buffer.from(x).toString("base64");
    else if (k === "peers" && x && typeof x === "object" && !Array.isArray(x)) out[k] = Object.fromEntries(Object.entries(x as Obj).map(([r, p]) => [r, p instanceof Uint8Array ? hexOf(p) : p]));
    else if (k === "names" && Array.isArray(x) && o.kind === "genesis") out[k] = Object.fromEntries(x.map((n) => { const e = n as Obj; return [e.identityKey instanceof Uint8Array ? hexOf(e.identityKey) : String(e.identityKey), { handle: e.handle, domain: e.domain }]; }));
    else out[k] = display(x);
  }
  return out;
}

// ---------------------------------------------------------------- bitcoin blocks, for display

/**
 * The Zig kernel's bitcoin codecs decoded the IPLD way (#42, bitcoin.ts,
 * kernel-zig/src/bitcoin.zig): a header (bitcoin-block) links the previous
 * header and its merkle root; a 64-byte bitcoin-tx is a merkle node linking
 * its two children (nodes, or at the bottom transactions); a transaction's
 * inputs link what they spend. The tree and the ancestry are sparse, so a
 * link's target may not be held. The fields are the decoded node's.
 */
export { BITCOIN_BLOCK, BITCOIN_TX, DBL_SHA2_256 } from "./bitcoin.ts";

export function bitcoinView(cid: CID, bytes: Uint8Array): { codec: string; fields: Array<[string, string | CID]> } | undefined {
  const v = decodeBitcoin(cid, bytes) as Obj | CID[] | undefined;
  if (v === undefined) return undefined;
  const id = displayHash(cid.multihash.digest);
  if (Array.isArray(v)) {
    const [l, r] = v;
    return { codec: "bitcoin-tx (merkle node)", fields: [["hash", id], ["left", l], ["right", l.equals(r) ? "duplicate of left" : r], ["left (as a txid)", displayHash(l.multihash.digest)], ["right (as a txid)", displayHash(r.multihash.digest)]] };
  }
  if (cid.code === BITCOIN_BLOCK) {
    return { codec: "bitcoin-block", fields: [["block hash", id], ["version", String(v.version)], ["previousblockhash", isCID(v.previousblockhash) ? v.previousblockhash : "none (genesis)"], ["merkleroot", v.merkleroot as CID], ["time", String(v.time)], ["bits", (v.bits as number).toString(16)], ["nonce", String(v.nonce)]] };
  }
  const fields: Array<[string, string | CID]> = [["txid", id], ["version", String(v.version)], ["locktime", String(v.locktime)]];
  (v.vin as Obj[]).forEach((x, i) => {
    if (isCID(x.txid)) fields.push([`vin ${i}`, x.txid], [`vin ${i} spends`, `${displayHash(x.txid.multihash.digest)}:${x.vout}`]);
    else fields.push([`vin ${i}`, "coinbase"]);
  });
  (v.vout as Obj[]).forEach((o, i) => fields.push([`vout ${i}`, `${o.value} sat · ${(o.script as Uint8Array).length}-byte script`]));
  return { codec: "bitcoin-tx", fields };
}

// ---------------------------------------------------------------- keys

export function be64(n: number | bigint): Uint8Array {
  const u = BigInt.asUintN(64, BigInt(n)) ^ (1n << 63n);
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, u);
  return b;
}
export function readBe64(b: Uint8Array, at = 0): number {
  const u = new DataView(b.buffer, b.byteOffset + at, 8).getBigUint64(0) ^ (1n << 63n);
  return Number(BigInt.asIntN(64, u));
}
export function strKey(s: string): Uint8Array {
  const t = new TextEncoder().encode(s);
  const len: number[] = [];
  let v = t.length;
  while (v >= 0x80) { len.push((v & 0x7f) | 0x80); v >>>= 7; }
  len.push(v);
  return cat(Uint8Array.from(len), t);
}
function readStrKey(b: Uint8Array): { s: string; used: number } {
  let n = 0, shift = 0, i = 0;
  for (;;) { const c = b[i++]; n += (c & 0x7f) * 2 ** shift; if (!(c & 0x80)) break; shift += 7; }
  return { s: new TextDecoder().decode(b.subarray(i, i + n)), used: i + n };
}
export function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
export function compare(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
/** The length of the binary CID at the front of `b` (binary CIDs are prefix-free). */
function cidLen(b: Uint8Array): number {
  if (b[0] === 0x12 && b[1] === 0x20) return 34;
  let i = 0;
  const varint = () => { let n = 0, shift = 0; for (;;) { const c = b[i++]; n += (c & 0x7f) * 2 ** shift; if (!(c & 0x80)) return n; shift += 7; } };
  varint(); varint(); varint();
  const len = varint();
  return i + len;
}
/** A number as SQLite orders it: an integer as is, a float floored, anything else the least. */
function numKey(v: unknown): bigint {
  if (typeof v !== "number" || !Number.isFinite(v)) return -(1n << 63n);
  return BigInt(Math.floor(v));
}
const succ = (p: Uint8Array): Uint8Array | undefined => {
  const b = Uint8Array.from(p);
  for (let i = b.length - 1; i >= 0; i--) { if (b[i] !== 0xff) { b[i]++; return b.subarray(0, i + 1); } }
  return undefined;
};

// ---------------------------------------------------------------- the tree

/** A key's level: sha2-256(key)'s leading zero 5-bit groups. */
export function level(key: Uint8Array): number {
  const d = createHash("sha256").update(key).digest();
  let bit = 0;
  while (bit < 255 && !((d[bit >> 3] >> (7 - (bit & 7))) & 1)) bit++;
  return Math.floor(bit / 5);
}

type Entry = [Uint8Array, unknown, CID | null];
type Node = [CID | null, Entry[]];

/** Read the trees through `get` (a block's bytes by CID). */
export class Trees {
  private cache = new Map<string, Node>();
  private readonly get: (cid: CID) => Uint8Array | undefined;
  constructor(get: (cid: CID) => Uint8Array | undefined) { this.get = get; }

  node(cid: CID): Node {
    const k = cid.toString();
    let n = this.cache.get(k);
    if (n) return n;
    const b = this.get(cid);
    if (!b) throw new NotFound(k);
    n = decode<Node>(b);
    if (this.cache.size > 20_000) this.cache.clear();
    this.cache.set(k, n);
    return n;
  }

  lookup(root: CID | null, key: Uint8Array): unknown {
    for (let c = root; c;) {
      const [left, es] = this.node(c);
      let i = 0;
      while (i < es.length && compare(es[i][0], key) < 0) i++;
      if (i < es.length && compare(es[i][0], key) === 0) return es[i][1];
      c = i === 0 ? left : es[i - 1][2];
    }
    return undefined;
  }

  /** Entries with lo <= key < hi, in key order. */
  *range(root: CID | null, lo?: Uint8Array, hi?: Uint8Array): Generator<[Uint8Array, unknown]> {
    if (!root) return;
    const [left, es] = this.node(root);
    for (let j = 0; j <= es.length; j++) {
      const gap = j === 0 ? left : es[j - 1][2];
      const loOk = j === es.length || !lo || compare(lo, es[j][0]) < 0;
      const hiOk = j === 0 || !hi || compare(es[j - 1][0], hi) < 0;
      if (loOk && hiOk) yield* this.range(gap, lo, hi);
      if (j === es.length) break;
      const k = es[j][0];
      if (hi && compare(k, hi) >= 0) break;
      if (!lo || compare(k, lo) >= 0) yield [k, es[j][1]];
    }
  }

  prefixed(root: CID | null, p: Uint8Array) { return this.range(root, p, succ(p)); }
}

/** The canonical tree of these pairs: its root, and its nodes (to store). */
export function buildTree(pairs: Array<[Uint8Array, unknown]>): { root: CID | null; blocks: Array<{ cid: CID; bytes: Uint8Array }> } {
  const sorted = [...pairs].sort((a, b) => compare(a[0], b[0]));
  const lv = sorted.map(([k]) => level(k));
  const blocks: Array<{ cid: CID; bytes: Uint8Array }> = [];
  const make = (from: number, to: number): CID | null => {
    if (from >= to) return null;
    let top = -1;
    for (let i = from; i < to; i++) top = Math.max(top, lv[i]);
    const at: number[] = [];
    for (let i = from; i < to; i++) if (lv[i] === top) at.push(i);
    const left = make(from, at[0]);
    const es: Entry[] = at.map((i, j) => [sorted[i][0], sorted[i][1], make(i + 1, j + 1 < at.length ? at[j + 1] : to)]);
    const blk = encode([left, es]);
    blocks.push(blk);
    return blk.cid;
  };
  return { root: make(0, sorted.length), blocks };
}

// ---------------------------------------------------------------- the state

export interface State { cid: CID; log: CID | null; cursor: number; roots: Record<MapName, CID | null> }

export function readState(get: (cid: CID) => Uint8Array | undefined, cid: CID): State {
  const b = get(cid);
  if (!b) throw new NotFound(cid.toString());
  const v = decode<Obj>(b);
  if (v.kind !== STATE_KIND) throw new Error(`${cid} is not a state record`);
  const idx = v.index as Record<string, CID | null>;
  const roots = Object.fromEntries(MAPS.map((m) => [m, (m === "heads" ? v.heads : idx[m]) as CID | null ?? null])) as State["roots"];
  return { cid, log: (v.log as CID | null) ?? null, cursor: Number(v.cursor ?? 0), roots };
}

// ---------------------------------------------------------------- building (the derivation)

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v) && !isCID(v);

/** Every map's pairs for a store's chains and log, as index.zig derives them. */
export async function derive(store: Store): Promise<{ pairs: Record<MapName, Array<[Uint8Array, unknown]>>; log: CID | null; cursor: number }> {
  const pairs = Object.fromEntries(MAPS.map((m) => [m, []])) as unknown as Record<MapName, Array<[Uint8Array, unknown]>>;
  let tip: CID | null = null;
  // The unique map, first admission wins: record CID → [entry n, entry].
  const unique = new Map<string, [number, CID, Uint8Array]>();
  const mark = (u: CID, n: number, e: CID) => { const k = fmt(u); const had = unique.get(k); if (!had || had[0] > n) unique.set(k, [n, e, u.bytes]); };
  const nOf = new Map<string, number>();
  for await (const { cid, entry } of store.log.entries()) {
    pairs.log.push([be64(entry.n), cid]);
    nOf.set(fmt(cid), entry.n);
    // The record an entry is unique by (index.zig `uniqueOf`): its mail record (format 3, #40), a
    // libp2p `p2p` event record (#51, #42: a redelivered message is refused), or format 2's envelope / emit.
    const x = entry as LogEntry & { mail?: CID; event?: CID };
    let u = x.mail ?? x.envelope ?? x.outcome?.emit;
    if (!u && x.event && ((await store.get(x.event).catch(() => undefined)) as { kind?: unknown } | undefined)?.kind === "p2p") u = x.event;
    if (u) mark(u, entry.n, cid);
    tip = cid;
  }
  const seenEdge = new Set<string>();
  for await (const origin of store.edges.query({})) {
    const o = (await store.get(origin)) as unknown as Obj;
    const kind = typeof o.kind === "string" ? o.kind : undefined;
    const ups: CID[] = [];
    for await (const c of store.chains.history(origin)) if (!c.equals(origin)) ups.push(c);
    const tipCid = ups.at(-1) ?? origin;
    pairs.chains.push([origin.bytes, { tip: tipCid, seq: ups.length, ...(kind !== undefined ? { kind } : {}) }]);
    const edges = (seq: number, rows: Array<{ to: string; rel: string; locator: string | null }>) => rows.forEach((e, ord) => {
      const k = cat(strKey(e.to), origin.bytes, be64(seq), be64(ord));
      const ks = Buffer.from(k).toString("hex");
      if (seenEdge.has(ks)) return;
      seenEdge.add(ks);
      pairs.edges.push([k, [e.rel, e.locator]]);
    });
    edges(0, originEdges(o));
    for (const [i, c] of ups.entries()) {
      pairs.updates.push([cat(origin.bytes, be64(i + 1)), c]);
      const u = (await store.get(c)) as unknown as Obj;
      if (kind === "thread" && isRequestThread(o)) for (const r of routed(u)) mark(r, nOf.get(fmt(u.input as CID)) ?? Infinity, u.input as CID);
      const keptCids = (Array.isArray(u.kept) ? u.kept : []).filter(isCID) as CID[];
      const kept = await Promise.all((Array.isArray(u.kept) ? u.kept : []).map((k) => (isCID(k) && !isBitcoin(k) ? store.get(k).catch(() => undefined) : undefined)));
      edges(i + 1, [...updateEdges(u), ...keptEdges(kept)]);
      // A kept bitcoin transaction's inputs (#42): from the block itself at seq 0; headers and merkle nodes none.
      for (const k of keptCids) {
        if (!isBitcoin(k)) continue;
        const b = await store.bytes(k).catch(() => undefined);
        if (!b) continue;
        bitcoinEdges(k, b).forEach((l, ord) => {
          const key = cat(strKey(fmt(l.to)), k.bytes, be64(0), be64(ord));
          const ks = Buffer.from(key).toString("hex");
          if (seenEdge.has(ks)) return;
          seenEdge.add(ks);
          pairs.edges.push([key, [l.rel, l.locator]]);
        });
      }
    }
    const t = ups.length ? (await store.get(tipCid)) as unknown as Obj : undefined;
    if (kind === "thread") {
      const at = be64(numKey(o.at));
      pairs.threads.push([cat(at, origin.bytes), null]);
      if (t?.state !== "finished") pairs.resting.push([cat(at, origin.bytes), null]);
      if (t && t.state === "waiting" && typeof t.until === "number") pairs.sleepers.push([cat(be64(numKey(t.until)), origin.bytes), null]);
      if (t && Array.isArray(t.awaits)) for (const c of t.awaits) if (isCID(c)) pairs.awaits.push([cat(c.bytes, at, origin.bytes), null]);
    } else if (kind === "head" && t && typeof o.name === "string" && isCID(t.tree)) pairs.heads.push([strKey(o.name), t.tree]);
  }
  for (const [, e, u] of unique.values()) pairs.unique.push([u, e]);
  return { pairs, log: tip, cursor: await store.live.cursor.get() };
}

/** A request's thread (#68, scheduler.zig isRequestThread): the middleware launched by the request record it names. */
function isRequestThread(o: Obj): boolean {
  const args = o.args as Obj | undefined;
  return isObj(args) && isCID(args.request) && typeof args.transport === "string" && isCID(o.launchedBy) && (args.request as CID).equals(o.launchedBy as CID);
}

/**
 * What a request thread's step routed that is unique (#68, scheduler.zig
 * routeAdmits): the messages and libp2p `p2p` events its answer's `admit`
 * lists — marked under the entry that drove the step, unless admitted before.
 */
function routed(u: Obj): CID[] {
  if (u.state === "errored") return [];
  const out = (u.result as Obj | undefined)?.stdout;
  if (!(out instanceof Uint8Array)) return [];
  let v: unknown;
  try { v = decode(out); } catch { return []; }
  const admit = isObj(v) && Array.isArray(v.admit) ? v.admit : [];
  const got: CID[] = [];
  for (const x of admit) {
    if (!isObj(x)) continue;
    if (isObj(x.mail) && x.mail.kind === "mail") got.push(encode(x.mail).cid);
    else if (isObj(x.event) && x.event.kind === "p2p" && typeof x.box === "string" && x.box.length > 0) got.push(encode(x.event).cid);
  }
  return got;
}

// ---------------------------------------------------------------- reading (the Store)

/** Does this SQLite file carry the state pointer (the format of #30)? */
export function hasStatePointer(path: string): boolean {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const t = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pointers'").get();
    return !!t && !!db.prepare("SELECT 1 FROM pointers WHERE name = 'state'").get();
  } finally { db.close(); }
}

/**
 * A store file, whichever format it is in: the new format (#30) through the
 * index, read only (blocks may be added unless `readOnly`); any other
 * through sqlite.ts.
 */
export function openStoreFile(path: string, o: { readOnly?: boolean } = {}): SqliteStore {
  let fresh = true;
  try { fresh = !hasStatePointer(path); } catch { /* no such file yet: sqlite.ts makes it */ }
  if (fresh) return openStore(path, o);
  return indexStore(new DatabaseSync(path, { readOnly: o.readOnly ?? false }), o);
}

class ReadOnly extends Error {
  constructor(what: string) { super(`${what}: this store's index is kept by the Zig kernel (issue #30); readonly here`); }
}

/** A store over the kernel's index (#30): its state record, and every head's name and root (the state's `heads` map). */
export type IndexStore = SqliteStore & { state(): State; heads(): Array<{ name: string; root: CID }> };

export function indexStore(db: DatabaseSync, o: { readOnly?: boolean } = {}): IndexStore {
  db.exec("PRAGMA busy_timeout = 5000;");
  const blockGet = db.prepare("SELECT bytes FROM blocks WHERE cid = ?");
  const blockHas = db.prepare("SELECT 1 AS x FROM blocks WHERE cid = ?");
  const blockPut = o.readOnly ? undefined : db.prepare("INSERT OR IGNORE INTO blocks (cid, bytes) VALUES (?, ?)");
  const pointer = db.prepare("SELECT cid FROM pointers WHERE name = 'state'");
  const get = (c: CID) => blockGet.get(c.bytes)?.bytes as Uint8Array | undefined;
  const trees = new Trees(get);
  let last: State | undefined;
  const state = (): State => {
    const r = pointer.get();
    if (!r) throw new Error("no state pointer");
    const c = fromBytes(r.cid as Uint8Array);
    if (!last || !last.cid.equals(c)) last = readState(get, c);
    return last;
  };
  const root = (m: MapName) => state().roots[m];
  const block = <T>(c: CID): T => { const b = get(c); if (!b) throw new NotFound(fmt(c)); return decode<T>(b); };
  const chain = (origin: CID) => trees.lookup(root("chains"), origin.bytes) as { tip: CID; seq: number; kind?: string } | undefined;
  const updatesOf = (origin: CID) => [...trees.prefixed(root("updates"), origin.bytes)].map(([, v]) => v as CID);
  const tipOf = (origin: CID, row: { tip: CID }) => (row.tip.equals(origin) ? undefined : block<Obj>(row.tip));

  type Meta = { cid: CID; kind?: string; o: Obj; t?: Obj; at: number | null; tipAt: number | null };
  const metas = (): Meta[] => [...trees.range(root("chains"))].map(([k, v]) => {
    const cid = fromBytes(k);
    const row = v as { tip: CID; kind?: string };
    const o = block<Obj>(cid);
    const t = tipOf(cid, row);
    const at = typeof o.at === "number" ? o.at : null;
    return { cid, kind: row.kind, o, t, at, tipAt: t ? (typeof t.at === "number" ? t.at : null) : at };
  });
  const threadsBy = (pred: (m: Meta) => boolean): CID[] => metas()
    .filter((m) => m.kind === "thread" && pred(m))
    .sort((a, b) => (a.at ?? -Infinity) - (b.at ?? -Infinity) || compare(a.cid.bytes, b.cid.bytes))
    .map((m) => m.cid);
  const cids = (list: unknown) => (Array.isArray(list) ? list.filter(isCID).map(fmt) : []);

  const store: IndexStore = {
    state,
    heads: () => [...trees.range(root("heads"))].map(([k, v]) => ({ name: readStrKey(k).s, root: v as CID })),
    async put(value: Block) {
      if (!blockPut) throw new ReadOnly("put");
      const b = encode(value);
      blockPut.run(b.cid.bytes, b.bytes);
      return b.cid;
    },
    async get<T extends Block = Block>(cid: CID) { return display(block<T>(cid)) as T; },
    async has(cid) { return blockHas.get(cid.bytes) !== undefined; },
    async bytes(cid) { const b = get(cid); if (!b) throw new NotFound(fmt(cid)); return b; },
    async putBlock(cid, bytes) { if (!blockPut) throw new ReadOnly("putBlock"); blockPut.run(cid.bytes, bytes); },
    async putMessage() { throw new ReadOnly("putMessage"); },
    async findByPrefix(prefix) {
      return [...trees.range(root("chains"))].map(([k]) => fromBytes(k)).filter((c) => fmt(c).startsWith(prefix));
    },

    chains: {
      async open() { throw new ReadOnly("chains.open"); },
      async append() { throw new ReadOnly("chains.append"); },
      async tip(origin) {
        const row = chain(origin);
        if (!row) throw new NotFound(fmt(origin));
        return row.tip;
      },
      async *history(origin) {
        if (!chain(origin)) throw new NotFound(fmt(origin));
        yield origin;
        yield* updatesOf(origin);
      },
      async originOf(cid) {
        if (chain(cid)) return cid;
        const b = get(cid);
        if (b) {
          const u = decode<unknown>(b);
          if (isObj(u) && isCID(u.origin) && typeof u.seq === "number") {
            const at = trees.lookup(root("updates"), cat(u.origin.bytes, be64(u.seq)));
            if (isCID(at) && at.equals(cid)) return u.origin;
          }
        }
        throw new NotFound(fmt(cid));
      },
    },

    log: {
      async append() { throw new ReadOnly("log.append"); },
      async byEnvelope(envelope) {
        const c = trees.lookup(root("unique"), envelope.bytes) as CID | undefined;
        return c && block<LogEntry>(c).envelope ? c : undefined;
      },
      async outcomeOf(emit) {
        const c = trees.lookup(root("unique"), emit.bytes) as CID | undefined;
        return c && block<LogEntry>(c).outcome ? c : undefined;
      },
      async tip() { return state().log ?? undefined; },
      async *entries(from = 0) {
        for (const [, v] of [...trees.range(root("log"), be64(from))]) yield { cid: v as CID, entry: block<LogEntry>(v as CID) };
      },
    },

    edges: {
      async refsFrom(cid) {
        // A bitcoin block's own links (#42): what an input spends, a header's previous header and root, a node's children.
        if (isBitcoin(cid)) {
          const b = get(cid);
          return b ? bitcoinLinks(cid, b).map((l) => toRef(l.to, l.rel, l.locator === null ? null : String(l.locator))) : [];
        }
        const row = chain(cid);
        if (!row) return [];
        const rows: Array<{ pos: number; to: string; rel: string; locator: string | null }> = [];
        originEdges(block<Obj>(cid)).forEach((e, ord) => rows.push({ pos: ord, ...e }));
        const withKept = (u: Obj) => [...updateEdges(u), ...keptEdges((Array.isArray(u.kept) ? u.kept : []).map((k) => {
          const b = isCID(k) ? get(k) : undefined;
          try { return b && decode(b); } catch { return undefined; }
        }))];
        updatesOf(cid).forEach((u, i) => withKept(block<Obj>(u)).forEach((e, ord) => rows.push({ pos: (i + 1) * 1048576 + ord, ...e })));
        const first = new Map<string, (typeof rows)[number]>();
        for (const r of rows) {
          const k = JSON.stringify([r.to, r.rel, r.locator]);
          const had = first.get(k);
          if (!had || r.pos < had.pos) first.set(k, r);
        }
        return [...first.values()].sort((a, b) => a.pos - b.pos).map((r) => toRef(r.to, r.rel, r.locator));
      },
      async refsTo(cid) {
        const p = strKey(fmt(cid));
        const groups = new Map<string, { from: CID; rel: string; locator: string | null; at: number | null }>();
        for (const [k, v] of trees.prefixed(root("edges"), p)) {
          const rest = k.subarray(p.length);
          const from = fromBytes(rest.subarray(0, cidLen(rest)));
          const [rel, loc] = v as [string, string | number | null];
          const locator = typeof loc === "number" ? String(loc) : loc; // a bitcoin block's vout / child (#42)
          const g = JSON.stringify([fmt(from), rel, locator]);
          if (groups.has(g)) continue;
          const o = isBitcoin(from) ? {} as Obj : block<Obj>(from); // a kept bitcoin block points from itself
          groups.set(g, { from, rel, locator, at: typeof o.at === "number" ? o.at : null });
        }
        return [...groups.values()]
          .sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity) || compare(b.from.bytes, a.from.bytes))
          .map((g) => ({ ...toRef(cid, g.rel, g.locator), from: g.from }));
      },
      async *query(f: Filter) {
        if (f.kind === "message" || (f.kind === undefined && (f.from !== undefined || f.to !== undefined))) return; // the kernel keeps no messages
        const key = (m: Meta) => (f.orderBy === "tipAt" ? m.tipAt : m.at);
        const hits = metas()
          .filter((m) => !f.kind || m.kind === f.kind)
          .filter((m) => !f.thread || (m.kind === "node" && isCID(m.o.thread) && m.o.thread.equals(f.thread)))
          .filter((m) => !f.program || (m.kind === "thread" && isCID(m.o.program) && m.o.program.equals(f.program)))
          .filter((m) => !f.state || (m.kind === "thread" && typeof m.t?.state === "string" && (f.state as string[]).includes(m.t.state)))
          .filter((m) => f.parentless === undefined || (m.kind === "thread" && !isCID(m.o.launchedBy) === f.parentless))
          .filter((m) => f.since === undefined || (m.at !== null && m.at >= f.since))
          .filter((m) => f.before === undefined || (m.at !== null && m.at < f.before))
          .sort((a, b) => (key(b) ?? -Infinity) - (key(a) ?? -Infinity) || compare(b.cid.bytes, a.cid.bytes));
        yield* hits.slice(0, f.limit ?? hits.length).map((m) => m.cid);
      },
      async rebuild() { throw new ReadOnly("rebuild"); },
    },

    live: {
      handles: {
        async set() { throw new ReadOnly("handles.set"); },
        async get() { return undefined; },
        async clear() { throw new ReadOnly("handles.clear"); },
      },
      async *resting(f = {}) {
        let n = 0;
        for (const [k] of [...trees.range(root("resting"))]) {
          if (f.limit !== undefined && n >= f.limit) return;
          const origin = fromBytes(k.subarray(8));
          if (f.state) {
            const row = chain(origin);
            const t = row ? tipOf(origin, row) : undefined;
            if (typeof t?.state !== "string" || !(f.state as string[]).includes(t.state)) continue;
          }
          n++;
          yield origin;
        }
      },
      async *due(now) {
        for (const [k] of [...trees.range(root("sleepers"), undefined, be64(Math.floor(now) + 1))]) yield fromBytes(k.subarray(8));
      },
      async *waitersOn(thread) {
        yield* threadsBy((m) => cids(m.t?.waitingOn).includes(fmt(thread)));
      },
      async *waitingFrom(identity) {
        yield* threadsBy((m) => m.t?.waitingFrom === identity);
      },
      async *awaiting(envelope) {
        for (const [k] of [...trees.prefixed(root("awaits"), envelope.bytes)]) yield fromBytes(k.subarray(envelope.bytes.length + 8));
      },
      cursor: {
        async get() { return state().cursor; },
        async set() { throw new ReadOnly("cursor.set"); },
      },
    },

    async close() { db.close(); },
  };
  return store;
}

export { readStrKey, cidLen };
export type { Ref };

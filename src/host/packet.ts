// Bootstrap packets (issue #4, docs/BOOTSTRAP.md): on the pattern of BRC-176,
// a BEEF bag of the transactions that carry a system tree's objects (or a
// whole instance's, for a checkpoint) plus a **scope** — the root it is
// verified against. Reading one is an object lookup into the bag, not a
// chain reader; where the bag came from is nobody's concern.
//
//   packet   dag-cbor {kind: "skein-packet", version: 1, scope: CID, beef: bytes,
//                      index?: [{tx: CID(bitcoin-tx), vout: int, cid: CID}]}
//   scope    a git tree (a system tree: boot a new instance from it), or a
//            skein-state record (#30: a checkpoint — restore the instance, its
//            index read, never rebuilt)
//   carrier  an output `OP_FALSE OP_RETURN <content-type> <payload>`:
//              ordfs/dir     a gib directory manifest: resolves to the git tree of its entries
//              ordfs/patch   [0x00][36B base outpoint][vcdiff]: resolves to apply(delta, resolve(base))
//              anything else the payload as it is
//            A resolved payload is an object for a CID if it hashes to it —
//            for a git blob either as the whole object or as the file's bare
//            content (how ORDFS/gib carry files); a bitcoin-tx CID is also
//            served by the bag's own transaction of that txid.
//   index    where each object is (optional: without it every carrier output
//            is resolved and keyed by every CID its bytes hash to)
//
// Verification is offline. **Completeness**: every object reachable from the
// scope must come out of the bag — a system tree's trees and blobs (patched
// files walked to their bases), the modules its bin/<name>.cid files name; a
// checkpoint's every link (dag-cbor links, tree entries) from the state
// record down. **Content addressing**: every object is checked against its
// CID (git sha1, sha2-256, dbl-sha2-256). **Chain inclusion** only when asked
// (`chainTracker`): every carrier transaction must then have a merkle path
// in the bag that verifies against the tracker's headers.
//
// The writer (`writePacket`) makes the transactions itself: synthetic,
// unfunded (a made-up input), never broadcast — a test fixture and a file
// format, not a publisher. A real publisher (gib, 1sat inscriptions or B
// outputs, funded and broadcast) is out of scope; its outputs would be read
// the same way once their carrier shape is mapped onto (content-type, payload).

import { createHash } from "node:crypto";
import { Beef, MerklePath, Script, Transaction, type ChainTracker } from "@bsv/sdk";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import { decode, encode } from "../runtime/cid.ts";
import { GIT_RAW, hashTree, parseTree, sha1Cid, type Entry, type EntryMode } from "../runtime/tree.ts";
import { BIN, DAG_CBOR, gitBody, MemBlocks, RAW, type Objects } from "./boot.ts";
import { vcdiffDecode } from "./vcdiff.ts";

export const PACKET_KIND = "skein-packet";
export const BITCOIN_TX = 0xb1;
export const BITCOIN_BLOCK = 0xb0;
/** A 64-byte merkle node (#29, kernel-zig/src/cid.zig): its CID is its merkle hash. */
export const BITCOIN_MERKLE = 0xb3;
const SHA1 = 0x11, SHA2_256 = 0x12, DBL_SHA2_256 = 0x56;
const OP_FALSE = 0x00, OP_RETURN = 0x6a;

export class PacketError extends Error {
  readonly code: "malformed" | "scope-mismatch" | "incomplete" | "hash-mismatch" | "unproven";
  constructor(code: PacketError["code"], message: string) { super(`packet ${code}: ${message}`); this.code = code; }
}

export interface IndexEntry { tx: CID; vout: number; cid: CID }
export interface PacketRecord { kind: typeof PACKET_KIND; version: 1; scope: CID; beef: Uint8Array; index?: IndexEntry[] }

// ---------------------------------------------------------------- ids

const sha1 = (b: Uint8Array) => createHash("sha1").update(b).digest();
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest();
const blobObject = (content: Uint8Array) => Buffer.concat([Buffer.from(`blob ${content.length}\0`, "latin1"), content]);

/** A transaction's CID: bitcoin-tx, dbl-sha2-256, the digest in internal byte order (the txid reversed). */
export function txCid(txidHex: string): CID {
  return CID.createV1(BITCOIN_TX, Digest.create(DBL_SHA2_256, Buffer.from(txidHex, "hex").reverse()));
}
export function txidOf(c: CID): string {
  if (c.code !== BITCOIN_TX || c.multihash.code !== DBL_SHA2_256) throw new PacketError("malformed", `${c} is not a bitcoin-tx CID`);
  return Buffer.from(c.multihash.digest).reverse().toString("hex");
}

/** Do `bytes` hash to `cid` (git sha1, sha2-256, dbl-sha2-256)? */
export function hashMatches(cid: CID, bytes: Uint8Array): boolean {
  const d = Buffer.from(cid.multihash.digest);
  switch (cid.multihash.code) {
    case SHA1: return cid.code === GIT_RAW && d.equals(sha1(bytes));
    case SHA2_256: return (cid.code === RAW || cid.code === DAG_CBOR) && d.equals(sha256(bytes));
    case DBL_SHA2_256: return (cid.code === BITCOIN_TX || (cid.code === BITCOIN_BLOCK && bytes.length === 80) || (cid.code === BITCOIN_MERKLE && bytes.length === 64)) && d.equals(sha256(sha256(bytes)));
    default: return false;
  }
}

/** The block `payload` is for `cid`, if it is one: as it is, or (a git blob) framed as a blob object. */
function asBlock(cid: CID, payload: Uint8Array): Uint8Array | undefined {
  if (hashMatches(cid, payload)) return payload;
  if (cid.code === GIT_RAW && cid.multihash.code === SHA1) {
    const framed = blobObject(payload);
    if (Buffer.from(cid.multihash.digest).equals(sha1(framed))) return new Uint8Array(framed);
  }
  return undefined;
}

// ---------------------------------------------------------------- links (completeness)

const merkleCid = (h: Uint8Array) => CID.createV1(BITCOIN_MERKLE, Digest.create(DBL_SHA2_256, Uint8Array.from(h)));

/**
 * The CIDs a block links to: dag-cbor links, git tree entries; a header its
 * merkle root's node and a merkle node its children (#29) — `optional`: the
 * tree is sparse (only the paths to held transactions), so a child that is
 * not held is not missing; none for blobs, raw, transactions.
 */
export function linksOf(cid: CID, bytes: Uint8Array): Array<{ cid: CID; tree?: boolean; optional?: boolean }> {
  if (cid.code === BITCOIN_BLOCK && bytes.length === 80) return [{ cid: merkleCid(bytes.subarray(36, 68)), optional: true }];
  if (cid.code === BITCOIN_MERKLE && bytes.length === 64) return [{ cid: merkleCid(bytes.subarray(0, 32)), optional: true }, { cid: merkleCid(bytes.subarray(32, 64)), optional: true }];
  if (cid.code === DAG_CBOR) {
    const out: Array<{ cid: CID }> = [];
    const walk = (v: unknown): void => {
      const c = CID.asCID(v);
      if (c) { out.push({ cid: c }); return; }
      if (v instanceof Uint8Array || v === null || typeof v !== "object") return;
      for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x);
    };
    walk(decode(bytes));
    return out;
  }
  if (cid.code === GIT_RAW && gitBody(bytes, "tree")) return parseTree(bytes, cid).map((e) => ({ cid: e.cid }));
  return [];
}

/**
 * The closure a scope requires: a system tree's objects plus the modules its
 * bin/<name>.cid name; a state record's every link. `get` returns a block,
 * checked against its CID, or undefined (then `missing` lists it).
 */
export async function closure(scope: CID, get: (cid: CID) => Promise<Uint8Array | undefined>): Promise<{ blocks: Array<{ cid: CID; bytes: Uint8Array }>; missing: string[] }> {
  const blocks: Array<{ cid: CID; bytes: Uint8Array }> = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  const visit = async (cid: CID, path: string, optional = false): Promise<Uint8Array | undefined> => {
    const k = cid.toString();
    if (seen.has(k)) return undefined;
    seen.add(k);
    const bytes = await get(cid);
    if (!bytes) { if (!optional) missing.push(`${path || "/"} (${k})`); return undefined; }
    blocks.push({ cid, bytes });
    for (const l of linksOf(cid, bytes)) await visit(l.cid, cid.code === GIT_RAW ? `${path}/${nameIn(bytes, cid, l.cid)}` : `${path}→${short(l.cid)}`, l.optional);
    return bytes;
  };
  const root = await visit(scope, "");
  if (root && scope.code === GIT_RAW) {
    // A system tree's bin/<name>.cid: the module it names is part of the tree's closure.
    const bin = parseTree(root, scope).find((e) => e.name === BIN && e.mode === "40000");
    const binBytes = bin && blocks.find((b) => b.cid.equals(bin.cid))?.bytes;
    if (bin && binBytes) {
      for (const e of parseTree(binBytes, bin.cid)) {
        if (!e.name.endsWith(".cid")) continue;
        const f = blocks.find((b) => b.cid.equals(e.cid))?.bytes;
        const text = f && gitBody(f, "blob");
        if (!text) continue;
        let m: CID;
        try { m = CID.parse(Buffer.from(text).toString("utf8").trim()); } catch { continue; } // the loader refuses it with a reason
        await visit(m, `/${BIN}/${e.name} → module`);
      }
    }
  }
  return { blocks, missing };
}

const short = (c: CID) => c.toString().slice(-8);
function nameIn(tree: Uint8Array, cid: CID, child: CID): string {
  return parseTree(tree, cid).find((e) => e.cid.equals(child))?.name ?? short(child);
}

// ---------------------------------------------------------------- carriers

/** Pushes of an `OP_FALSE OP_RETURN <type> <payload>` script, or undefined. */
export function carrierOf(script: Uint8Array): { type: string; payload: Uint8Array } | undefined {
  if (script.length < 2 || script[0] !== OP_FALSE || script[1] !== OP_RETURN) return undefined;
  const pushes: Uint8Array[] = [];
  let i = 2;
  while (i < script.length) {
    const op = script[i++]!;
    let n: number;
    if (op >= 1 && op <= 75) n = op;
    else if (op === 0x4c) n = script[i++]!;
    else if (op === 0x4d) { n = script[i]! | (script[i + 1]! << 8); i += 2; }
    else if (op === 0x4e) { n = (script[i]! | (script[i + 1]! << 8) | (script[i + 2]! << 16) | (script[i + 3]! << 24)) >>> 0; i += 4; }
    else if (op === 0) n = 0;
    else return undefined;
    if (i + n > script.length) return undefined;
    pushes.push(script.subarray(i, i + n));
    i += n;
  }
  if (pushes.length !== 2) return undefined;
  return { type: Buffer.from(pushes[0]!).toString("utf8"), payload: pushes[1]! };
}

function push(b: Uint8Array): Uint8Array {
  const n = b.length;
  const head = n <= 75 ? [n] : n <= 0xff ? [0x4c, n] : n <= 0xffff ? [0x4d, n & 0xff, n >> 8] : [0x4e, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
  return Buffer.concat([Buffer.from(head), b]);
}

export function carrierScript(type: string, payload: Uint8Array): Uint8Array {
  return new Uint8Array(Buffer.concat([Buffer.from([OP_FALSE, OP_RETURN]), push(Buffer.from(type, "utf8")), push(payload)]));
}

/** An outpoint as ORDFS writes it: 32-byte txid (internal order) + 4-byte LE vout. */
const outpointBytes = (txid: string, vout: number) => { const b = Buffer.alloc(36); Buffer.from(txid, "hex").reverse().copy(b); b.writeUInt32LE(vout, 32); return b; };
const outpointOf = (b: Uint8Array) => ({ txid: Buffer.from(b.subarray(0, 32)).reverse().toString("hex"), vout: Buffer.from(b).readUInt32LE(32) });

// ordfs/dir (ordfs-formats.html): [1B version=1][2B count][entries: flags, name len, name, target]
const KIND_DIR = 1, EXEC = 2, SYMLINK = 4, REFTYPE = 8;

export function encodeDir(entries: Array<{ name: string; mode: EntryMode; txid?: string; vout: number }>): Uint8Array {
  const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  const parts: Buffer[] = [Buffer.from([1, sorted.length >> 8, sorted.length & 0xff])];
  for (const e of sorted) {
    const flags = (e.mode === "40000" ? KIND_DIR : 0) | (e.mode === "100755" ? EXEC : 0) | (e.mode === "120000" ? SYMLINK : 0) | (e.txid ? REFTYPE : 0);
    const name = Buffer.from(e.name, "utf8");
    parts.push(Buffer.from([flags, name.length]), name, e.txid ? outpointBytes(e.txid, e.vout) : Buffer.from([e.vout]));
  }
  return new Uint8Array(Buffer.concat(parts));
}

function decodeDir(b: Uint8Array): Array<{ name: string; mode: EntryMode; txid?: string; vout: number }> {
  if (b[0] !== 1 || b.length < 3) throw new PacketError("malformed", "ordfs/dir: bad version");
  const n = (b[1]! << 8) | b[2]!;
  const out: Array<{ name: string; mode: EntryMode; txid?: string; vout: number }> = [];
  let i = 3, last: Buffer | undefined;
  for (let k = 0; k < n; k++) {
    const flags = b[i++]!;
    if (flags & 0xf0) throw new PacketError("malformed", "ordfs/dir: reserved flag bits");
    const len = b[i++]!;
    const name = Buffer.from(b.subarray(i, i + len)); i += len;
    if (!len || name.includes(0) || name.includes(0x2f) || (last && Buffer.compare(last, name) >= 0)) throw new PacketError("malformed", "ordfs/dir: bad or unsorted name");
    last = name;
    const mode: EntryMode = flags & KIND_DIR ? "40000" : flags & SYMLINK ? "120000" : flags & EXEC ? "100755" : "100644";
    if (flags & REFTYPE) { const op = outpointOf(b.subarray(i, i + 36)); i += 36; out.push({ name: name.toString("utf8"), mode, ...op }); }
    else out.push({ name: name.toString("utf8"), mode, vout: b[i++]! });
    if (i > b.length) throw new PacketError("malformed", "ordfs/dir: truncated");
  }
  if (i !== b.length) throw new PacketError("malformed", "ordfs/dir: trailing bytes");
  return out;
}

// ---------------------------------------------------------------- reading

export interface ReadOptions {
  /** The root the caller means to accept; the packet's scope must be it. */
  scope?: CID;
  /** Require chain inclusion: every carrier transaction's merkle path must verify against these headers. */
  chainTracker?: ChainTracker;
}

export interface Verified {
  scope: CID;
  kind: "tree" | "checkpoint";
  /** Every block the scope requires, each checked against its CID. */
  blocks: MemBlocks;
  list: Array<{ cid: CID; bytes: Uint8Array }>;
  /** Transactions objects came out of (and patch bases), by txid. */
  carriers: string[];
}

export function decodePacket(bytes: Uint8Array): PacketRecord {
  let p: PacketRecord;
  try { p = decode<PacketRecord>(bytes); } catch { throw new PacketError("malformed", "not dag-cbor"); }
  if (!p || p.kind !== PACKET_KIND || p.version !== 1) throw new PacketError("malformed", `not a ${PACKET_KIND} v1`);
  if (!CID.asCID(p.scope)) throw new PacketError("malformed", "no scope");
  if (!(p.beef instanceof Uint8Array)) throw new PacketError("malformed", "no beef");
  if (p.index !== undefined && (!Array.isArray(p.index) || p.index.some((e) => !CID.asCID(e?.tx) || !Number.isInteger(e?.vout) || !CID.asCID(e?.cid)))) throw new PacketError("malformed", "bad index");
  return p;
}

/** Read and verify a packet: the blocks its scope requires, every one checked; else a PacketError. */
export async function readPacket(bytes: Uint8Array, o: ReadOptions = {}): Promise<Verified> {
  const p = decodePacket(bytes);
  const scope = CID.asCID(p.scope)!;
  if (o.scope && !o.scope.equals(scope)) throw new PacketError("scope-mismatch", `the packet's scope is ${scope}, not ${o.scope}`);
  if (scope.code !== GIT_RAW && scope.code !== DAG_CBOR) throw new PacketError("malformed", "the scope is neither a git tree nor a state record");
  let beef: Beef;
  try { beef = Beef.fromBinary(Array.from(p.beef)); } catch (e) { throw new PacketError("malformed", `beef: ${(e as Error).message}`); }
  const txs = new Map<string, Transaction>();
  for (const b of beef.txs) {
    if (!b.tx) continue; // txid-only (BRC-96): not a body
    if (b.tx.id("hex") !== b.txid) throw new PacketError("hash-mismatch", `beef: ${b.txid} does not match its body`);
    txs.set(b.txid, b.tx);
  }
  const used = new Set<string>();
  const output = (txid: string, vout: number) => {
    const tx = txs.get(txid);
    if (!tx) return undefined;
    const out = tx.outputs[vout];
    if (!out) return undefined;
    used.add(txid);
    return carrierOf(Uint8Array.from(out.lockingScript.toBinary()));
  };

  // Resolution: an outpoint's bytes (patches applied), and the git objects a directory manifest makes.
  const derived = new Map<string, Uint8Array>();
  const resolved = new Map<string, Uint8Array>();
  const resolving = new Set<string>();
  const resolve = (txid: string, vout: number, depth = 0): Uint8Array | undefined => {
    const key = `${txid}_${vout}`;
    if (resolved.has(key)) return resolved.get(key);
    if (resolving.has(key) || depth > 1000) throw new PacketError("malformed", `a patch or directory cycle at ${key}`);
    resolving.add(key);
    try {
      const c = output(txid, vout);
      if (!c) return undefined;
      let bytes: Uint8Array | undefined;
      if (c.type === "ordfs/patch") {
        if (c.payload.length < 37 || c.payload[0] !== 0) throw new PacketError("malformed", `ordfs/patch at ${key}`);
        const base = outpointOf(c.payload.subarray(1, 37));
        const b = resolve(base.txid, base.vout, depth + 1);
        if (!b) return undefined; // the base is missing: incomplete
        bytes = vcdiffDecode(c.payload.subarray(37), b);
      } else if (c.type === "ordfs/dir") {
        const entries: Entry[] = [];
        for (const e of decodeDir(c.payload)) {
          const at = e.txid ?? txid;
          const child = resolve(at, e.vout, depth + 1);
          if (!child) return undefined;
          if (e.mode === "40000") entries.push({ mode: e.mode, name: e.name, cid: sha1Cid(sha1(child)) });
          else {
            // A file: ORDFS carries its bare content; the git blob is that content framed.
            const obj = new Uint8Array(blobObject(child));
            const cid = sha1Cid(sha1(obj));
            derived.set(cid.toString(), obj);
            entries.push({ mode: e.mode, name: e.name, cid });
          }
        }
        const t = hashTree(entries);
        derived.set(t.cid.toString(), t.object);
        bytes = t.object;
      } else bytes = c.payload;
      resolved.set(key, bytes);
      return bytes;
    } finally { resolving.delete(key); }
  };

  // Where each CID is: the index, else every carrier output keyed by what its bytes hash to.
  const where = new Map<string, Array<{ txid: string; vout: number }>>();
  const at = (cid: CID, txid: string, vout: number) => { const k = cid.toString(); where.set(k, [...(where.get(k) ?? []), { txid, vout }]); };
  if (p.index) for (const e of p.index) at(CID.asCID(e.cid)!, txidOf(CID.asCID(e.tx)!), e.vout);
  else {
    for (const [txid, tx] of txs) tx.outputs.forEach((_, vout) => {
      const b = resolve(txid, vout);
      if (!b) return;
      const h1 = sha1(b), h2 = sha256(b);
      at(sha1Cid(h1), txid, vout);
      at(sha1Cid(sha1(blobObject(b))), txid, vout);
      at(CID.createV1(RAW, Digest.create(SHA2_256, h2)), txid, vout);
      at(CID.createV1(DAG_CBOR, Digest.create(SHA2_256, h2)), txid, vout);
    });
  }

  const get = async (cid: CID): Promise<Uint8Array | undefined> => {
    const d = derived.get(cid.toString());
    if (d) return d;
    if (cid.code === BITCOIN_TX) { const tx = txs.get(txidOf(cid)); if (tx) { used.add(txidOf(cid)); return Uint8Array.from(tx.toBinary()); } }
    const places = where.get(cid.toString());
    if (!places) return undefined;
    for (const { txid, vout } of places) {
      const b = resolve(txid, vout);
      if (!b) continue;
      const block = asBlock(cid, b);
      if (block) return block;
      if (p.index) throw new PacketError("hash-mismatch", `${txid}:${vout} does not hash to ${cid}`);
    }
    return undefined;
  };

  const { blocks, missing } = await closure(scope, get);
  if (missing.length) throw new PacketError("incomplete", `${missing.length} object(s) the scope reaches are not in the bag: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? " …" : ""}`);
  if (scope.code === DAG_CBOR) {
    const s = decode<{ kind?: string }>(blocks[0]!.bytes);
    if (s?.kind !== "skein-state") throw new PacketError("malformed", "a dag-cbor scope must be a skein-state record (a checkpoint)");
  }
  // Extras: what the index lists beyond the closure (a checkpoint's records no link reaches) — each verified, then kept.
  const inClosure = new Set(blocks.map((b) => b.cid.toString()));
  for (const e of p.index ?? []) {
    const c = CID.asCID(e.cid)!;
    if (inClosure.has(c.toString())) continue;
    inClosure.add(c.toString());
    const b = await get(c);
    if (!b) throw new PacketError("incomplete", `the index lists ${c}, which the bag does not carry`);
    blocks.push({ cid: c, bytes: b });
  }
  if (o.chainTracker) {
    for (const txid of used) {
      const bt = beef.findTxid(txid);
      const mp = bt?.bumpIndex !== undefined ? beef.bumps[bt.bumpIndex] : undefined;
      if (!mp) throw new PacketError("unproven", `${txid} has no merkle path in the bag`);
      if (!(await mp.verify(txid, o.chainTracker))) throw new PacketError("unproven", `${txid}'s merkle path does not verify against the headers`);
    }
  }
  const mem = new MemBlocks();
  for (const b of blocks) await mem.putBlock(b.cid, b.bytes);
  return { scope, kind: scope.code === GIT_RAW ? "tree" : "checkpoint", blocks: mem, list: blocks, carriers: [...used] };
}

// ---------------------------------------------------------------- writing

export interface WriteOptions {
  /** "ordfs" (default): trees as ordfs/dir manifests and files as bare content, as gib publishes; "git": every object as it is. */
  form?: "ordfs" | "git";
  /** Give every transaction a merkle path (a block at height 1, 2, …) and return the headers' roots. */
  mined?: boolean;
  /** Carrier outputs per transaction, and bytes per transaction, before a new one starts. */
  maxOutputs?: number;
  maxBytes?: number;
  /** Leave the index out (readers then scan). */
  noIndex?: boolean;
  /**
   * Blocks to carry beyond the scope's closure (a checkpoint's records that no
   * link reaches: a run's args, an emitted envelope's signed part). Listed in
   * the index, so a reader verifies and keeps them; the index is then required.
   */
  extras?: Array<{ cid: CID; bytes: Uint8Array }>;
}

export interface Written { bytes: Uint8Array; packet: PacketRecord; txids: string[]; roots: Record<number, string>; objects: number }

/**
 * A packet of everything `scope` requires, read out of `objects`, carried in
 * synthetic transactions (never broadcast; see the header).
 */
export async function writePacket(scope: CID, objects: Objects, o: WriteOptions = {}): Promise<Written> {
  const { blocks, missing } = await closure(scope, async (c) => {
    const b = await objects.get(c);
    if (b && !hashMatches(c, b)) throw new PacketError("hash-mismatch", `the source's ${c} does not hash to it`);
    return b;
  });
  if (missing.length) throw new PacketError("incomplete", `the source lacks ${missing.length} object(s): ${missing.slice(0, 5).join(", ")}`);
  if (o.extras?.length && o.noIndex) throw new PacketError("malformed", "extras need the index");
  const have = new Set(blocks.map((b) => b.cid.toString()));
  for (const x of o.extras ?? []) {
    if (have.has(x.cid.toString())) continue;
    if (!hashMatches(x.cid, x.bytes)) throw new PacketError("hash-mismatch", `extra ${x.cid} does not hash to it`);
    have.add(x.cid.toString());
    blocks.push(x);
  }
  const form = o.form ?? "ordfs";
  const maxOutputs = Math.min(o.maxOutputs ?? 200, 256), maxBytes = o.maxBytes ?? 1 << 20;
  const byCid = new Map(blocks.map((b) => [b.cid.toString(), b]));

  const done: Transaction[] = [];
  let cur: Transaction | undefined, curBytes = 0;
  const placed = new Map<string, { tx: Transaction; vout: number }>();
  const index: Array<{ tx: Transaction; vout: number; cid: CID }> = [];
  const close = () => { if (cur) done.push(cur); cur = undefined; curBytes = 0; };
  const open = () => {
    const t = new Transaction();
    // A made-up, unfunded input: the transaction only carries data (and is never broadcast).
    t.addInput({ sourceTXID: sha256(Buffer.from(`skein-packet ${scope} ${done.length}`)).toString("hex"), sourceOutputIndex: 0, unlockingScript: new Script(), sequence: 0xffffffff });
    cur = t;
    return t;
  };
  const txidOfTx = (t: Transaction) => t.id("hex") as string;
  const room = (n: number) => { if (cur && (cur.outputs.length >= maxOutputs || curBytes + n > maxBytes)) close(); return cur ?? open(); };
  const add = (cid: CID, type: string, payload: () => Uint8Array) => {
    const est = payload().length;
    const t = room(est);
    const data = payload(); // after `room`: a directory's same-tx references depend on which transaction it lands in
    t.addOutput({ lockingScript: Script.fromBinary(Array.from(carrierScript(type, data))), satoshis: 0 });
    curBytes += data.length;
    placed.set(cid.toString(), { tx: t, vout: t.outputs.length - 1 });
    index.push({ tx: t, vout: t.outputs.length - 1, cid });
  };

  // Post-order over trees (children first), then everything else.
  const emitted = new Set<string>();
  const emit = (cid: CID) => {
    const k = cid.toString();
    if (emitted.has(k)) return;
    emitted.add(k);
    const b = byCid.get(k);
    if (!b) return;
    const tree = cid.code === GIT_RAW && gitBody(b.bytes, "tree") ? parseTree(b.bytes, cid) : undefined;
    if (tree) {
      for (const e of tree) emit(e.cid);
      if (form === "ordfs" && tree.every((e) => e.mode !== "160000" && placed.has(e.cid.toString()))) {
        add(cid, "ordfs/dir", () => encodeDir(tree.map((e) => {
          const at = placed.get(e.cid.toString())!;
          return { name: e.name, mode: e.mode as EntryMode, vout: at.vout, ...(at.tx === cur ? {} : { txid: txidOfTx(at.tx) }) };
        })));
        return;
      }
      add(cid, "application/octet-stream", () => b.bytes);
      return;
    }
    const blob = cid.code === GIT_RAW ? gitBody(b.bytes, "blob") : undefined;
    if (blob && form === "ordfs") add(cid, "application/octet-stream", () => blob);
    else add(cid, "application/octet-stream", () => b.bytes);
  };
  for (const b of blocks) emit(b.cid);
  close();

  const roots: Record<number, string> = {};
  const beef = new Beef();
  done.forEach((t, i) => {
    if (o.mined) {
      const txid = txidOfTx(t);
      // A two-transaction block: a made-up coinbase at offset 0 (offset 0 is a coinbase to verify()), this one at 1.
      const coinbase = sha256(Buffer.from(`skein-packet coinbase ${i + 1}`)).toString("hex");
      t.merklePath = new MerklePath(i + 1, [[{ offset: 0, hash: coinbase }, { offset: 1, hash: txid, txid: true }]]);
      roots[i + 1] = t.merklePath.computeRoot(txid);
    }
    beef.mergeTransaction(t);
  });
  const packet: PacketRecord = {
    kind: PACKET_KIND, version: 1, scope, beef: Uint8Array.from(beef.toBinary()),
    ...(o.noIndex ? {} : { index: index.map((x) => ({ tx: txCid(txidOfTx(x.tx)), vout: x.vout, cid: x.cid })) }),
  };
  return { bytes: encode(packet).bytes, packet, txids: done.map(txidOfTx), roots, objects: blocks.length };
}

/** A ChainTracker over a fixed set of header roots {height: root hex} (offline). */
export function rootsTracker(roots: Record<string | number, string>): ChainTracker {
  return {
    isValidRootForHeight: async (root: string, height: number) => roots[height] === root,
    currentHeight: async () => Math.max(0, ...Object.keys(roots).map(Number)),
  };
}

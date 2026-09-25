// The filesystem as records. Files and directories are git objects byte for
// byte ("blob <len>\0…", "tree <len>\0…"), addressed CIDv1(git-raw, sha1 of
// the whole object), so the digest *is* git's object id: a real repo, gib and
// this store share one id space with no translation layer.
//
// Pure: hashing and reading only. Scanning a directory and checking a tree out
// onto a disk are outside the machine (src/dev/scan.ts).

import { createHash } from "node:crypto";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import type { Blocks } from "./store.ts";

export const GIT_RAW = 0x78;
const SHA1 = 0x11;

/** Modes we write. */
export type Mode = "100644" | "100755" | "120000" | "40000";
/** Modes we read: 160000 (gitlink/submodule) only arrives from real repos. */
export type EntryMode = Mode | "160000";
export interface Entry { mode: EntryMode; name: string; cid: CID }
export interface Leaf { mode: EntryMode; cid: CID }

/** All this module needs from a store. */
export type TreeBlocks = Pick<Blocks, "bytes" | "has" | "putBlock">;

const MODES = new Set<string>(["100644", "100755", "120000", "40000", "160000"]);

// ---------------------------------------------------------------- ids

export function gitCid(sha1hex: string): CID {
  if (!/^[0-9a-f]{40}$/.test(sha1hex)) throw new Error(`not a sha1: ${sha1hex}`);
  return CID.createV1(GIT_RAW, Digest.create(SHA1, Buffer.from(sha1hex, "hex")));
}

export function gitSha(cid: CID): string {
  if (cid.code !== GIT_RAW || cid.multihash.code !== SHA1) throw new Error(`not a git object cid: ${cid}`);
  return Buffer.from(cid.multihash.digest).toString("hex");
}

export function sha1Cid(digest: Uint8Array): CID {
  return CID.createV1(GIT_RAW, Digest.create(SHA1, digest));
}

export function header(type: "blob" | "tree", len: number): Buffer {
  return Buffer.from(`${type} ${len}\0`, "latin1");
}

// ---------------------------------------------------------------- hashing

export function blobCid(bytes: Uint8Array): CID {
  return sha1Cid(createHash("sha1").update(header("blob", bytes.length)).update(bytes).digest());
}

export function hashBlob(bytes: Uint8Array): { cid: CID; object: Uint8Array } {
  const object = Buffer.concat([header("blob", bytes.length), bytes]);
  return { cid: sha1Cid(createHash("sha1").update(object).digest()), object };
}

export function hashTree(entries: Entry[]): { cid: CID; object: Uint8Array } {
  const seen = new Set<string>();
  const keyed = entries.map((e) => {
    if (!MODES.has(e.mode)) throw new Error(`bad mode ${e.mode} for ${e.name}`);
    if (!e.name || e.name.includes("/") || e.name.includes("\0")) throw new Error(`bad entry name: ${JSON.stringify(e.name)}`);
    if (seen.has(e.name)) throw new Error(`duplicate entry: ${e.name}`);
    seen.add(e.name);
    gitSha(e.cid); // throws unless it is a git object id
    // git orders as if a directory's name ended in "/" (so "foo.txt" < "foo" dir < "foo0").
    return { e, key: Buffer.from(e.mode === "40000" ? `${e.name}/` : e.name, "utf8") };
  });
  keyed.sort((a, b) => Buffer.compare(a.key, b.key));
  const parts: Uint8Array[] = [];
  for (const { e } of keyed) parts.push(Buffer.from(`${e.mode} ${e.name}\0`, "utf8"), e.cid.multihash.digest);
  const body = Buffer.concat(parts);
  const object = Buffer.concat([header("tree", body.length), body]);
  return { cid: sha1Cid(createHash("sha1").update(object).digest()), object };
}

// ---------------------------------------------------------------- reading

function body(object: Uint8Array, type: "blob" | "tree", cid?: CID): Buffer {
  const buf = Buffer.from(object.buffer, object.byteOffset, object.byteLength);
  const nul = buf.indexOf(0);
  const head = nul < 0 ? "" : buf.toString("latin1", 0, nul);
  if (head !== `${type} ${buf.length - nul - 1}`) throw new Error(`not a git ${type}: ${cid}`);
  return buf.subarray(nul + 1);
}

export function parseTree(object: Uint8Array, cid?: CID): Entry[] {
  const b = body(object, "tree", cid);
  const out: Entry[] = [];
  let i = 0;
  while (i < b.length) {
    const sp = b.indexOf(0x20, i);
    const z = sp < 0 ? -1 : b.indexOf(0, sp);
    if (z < 0 || z + 21 > b.length) throw new Error(`truncated tree: ${cid}`);
    const mode = b.toString("latin1", i, sp);
    if (!MODES.has(mode)) throw new Error(`unsupported mode ${mode} in ${cid}`);
    out.push({ mode: mode as EntryMode, name: b.toString("utf8", sp + 1, z), cid: sha1Cid(b.subarray(z + 1, z + 21)) });
    i = z + 21;
  }
  return out;
}

export async function readTree(blocks: TreeBlocks, cid: CID): Promise<Entry[]> {
  gitSha(cid);
  return parseTree(await blocks.bytes(cid), cid);
}

export async function readBlob(blocks: TreeBlocks, cid: CID): Promise<Uint8Array> {
  gitSha(cid);
  return body(await blocks.bytes(cid), "blob", cid);
}

/** The entry at `path` ("" is the root tree itself), or undefined. */
export async function lookup(blocks: TreeBlocks, tree: CID, path: string): Promise<Leaf | undefined> {
  let at: Leaf = { mode: "40000", cid: tree };
  for (const seg of path.split("/").filter(Boolean)) {
    if (at.mode !== "40000") return undefined;
    const e = (await readTree(blocks, at.cid)).find((x) => x.name === seg);
    if (!e) return undefined;
    at = e;
  }
  return at;
}

/** File contents (a symlink's contents are its target). */
export async function readFile(blocks: TreeBlocks, tree: CID, path: string): Promise<Uint8Array> {
  const e = await lookup(blocks, tree, path);
  if (!e) throw new Error(`no such path: ${path}`);
  if (e.mode === "40000" || e.mode === "160000") throw new Error(`not a file: ${path}`);
  return readBlob(blocks, e.cid);
}

/** Every entry under `path`, depth first in tree order. Directories only with `dirs`. */
export async function* walk(
  blocks: TreeBlocks, tree: CID, path = "", opts: { dirs?: boolean } = {},
): AsyncGenerator<{ path: string; mode: EntryMode; cid: CID }> {
  const start = await lookup(blocks, tree, path);
  if (!start || start.mode !== "40000") throw new Error(`not a directory: ${path}`);
  const prefix = path.split("/").filter(Boolean).join("/");
  async function* rec(cid: CID, pre: string): AsyncGenerator<{ path: string; mode: EntryMode; cid: CID }> {
    for (const e of await readTree(blocks, cid)) {
      const p = pre ? `${pre}/${e.name}` : e.name;
      if (e.mode === "40000") {
        if (opts.dirs) yield { path: p, mode: e.mode, cid: e.cid };
        yield* rec(e.cid, p);
      } else yield { path: p, mode: e.mode, cid: e.cid };
    }
  }
  yield* rec(start.cid, prefix);
}

// ---------------------------------------------------------------- diff

export interface Change {
  type: "added" | "removed" | "modified" | "renamed";
  path: string;
  /** renamed: the old path. */
  from?: string;
  a?: Leaf;
  b?: Leaf;
}

/** File-level changes a → b, sorted by path. Identical subtrees are skipped unread. */
export async function diff(blocks: TreeBlocks, a: CID, b: CID, opts: { renames?: boolean } = {}): Promise<Change[]> {
  const out: Change[] = [];
  const all = async (cid: CID, pre: string, type: "added" | "removed") => {
    for await (const e of walk(blocks, cid)) out.push({ type, path: `${pre}/${e.path}`, [type === "added" ? "b" : "a"]: { mode: e.mode, cid: e.cid } });
  };
  const rec = async (x: CID, y: CID, pre: string): Promise<void> => {
    const ex = new Map((await readTree(blocks, x)).map((e) => [e.name, e]));
    const ey = new Map((await readTree(blocks, y)).map((e) => [e.name, e]));
    for (const name of new Set([...ex.keys(), ...ey.keys()])) {
      const l = ex.get(name), r = ey.get(name);
      if (l && r && l.mode === r.mode && l.cid.equals(r.cid)) continue;
      const p = pre ? `${pre}/${name}` : name;
      const lDir = l?.mode === "40000", rDir = r?.mode === "40000";
      if (lDir && rDir) { await rec(l.cid, r.cid, p); continue; }
      if (lDir) await all(l.cid, p, "removed");
      if (rDir) await all(r.cid, p, "added");
      const lf = l && !lDir ? { mode: l.mode, cid: l.cid } : undefined;
      const rf = r && !rDir ? { mode: r.mode, cid: r.cid } : undefined;
      if (lf && rf) out.push({ type: "modified", path: p, a: lf, b: rf });
      else if (lf) out.push({ type: "removed", path: p, a: lf });
      else if (rf) out.push({ type: "added", path: p, b: rf });
    }
  };
  await rec(a, b, "");

  let changes = out;
  if (opts.renames ?? true) {
    // Exact renames only: the same blob gone from one path and new at another.
    const gone = new Map<string, Change[]>();
    for (const c of out) {
      if (c.type !== "removed") continue;
      const k = c.a!.cid.toString();
      gone.set(k, [...(gone.get(k) ?? []), c]);
    }
    const paired = new Set<Change>();
    changes = out.flatMap((c): Change[] => {
      if (c.type !== "added") return [c];
      const from = gone.get(c.b!.cid.toString())?.shift();
      if (!from) return [c];
      paired.add(from);
      return [{ type: "renamed", path: c.path, from: from.path, a: from.a, b: c.b }];
    }).filter((c) => !paired.has(c));
  }
  return changes.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

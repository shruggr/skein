// The filesystem as records. Files and directories are git objects byte for
// byte ("blob <len>\0…", "tree <len>\0…"), addressed CIDv1(git-raw, sha1 of
// the whole object), so the digest *is* git's object id: a real repo, gib and
// this store share one id space with no translation layer.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
import { join, resolve, sep } from "node:path";
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
// Above this, hash from a stream first so a file the store already has is never held whole.
const STREAM_OVER = 1 << 20;

// ---------------------------------------------------------------- ids

export function gitCid(sha1hex: string): CID {
  if (!/^[0-9a-f]{40}$/.test(sha1hex)) throw new Error(`not a sha1: ${sha1hex}`);
  return CID.createV1(GIT_RAW, Digest.create(SHA1, Buffer.from(sha1hex, "hex")));
}

export function gitSha(cid: CID): string {
  if (cid.code !== GIT_RAW || cid.multihash.code !== SHA1) throw new Error(`not a git object cid: ${cid}`);
  return Buffer.from(cid.multihash.digest).toString("hex");
}

function sha1Cid(digest: Uint8Array): CID {
  return CID.createV1(GIT_RAW, Digest.create(SHA1, digest));
}

function header(type: "blob" | "tree", len: number): Buffer {
  return Buffer.from(`${type} ${len}\0`, "latin1");
}

// ---------------------------------------------------------------- hashing

function blobCid(bytes: Uint8Array): CID {
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

// ---------------------------------------------------------------- scan

export interface ScanOptions {
  /** relPath is "/"-separated from the scanned root. Replaces the default. */
  ignore?: (relPath: string) => boolean;
}

export function defaultIgnore(rel: string): boolean {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  return base === ".git" || base === "node_modules";
}

// Bounds open file descriptors; directory recursion itself is unbounded (readdir holds no fd across awaits).
function gate(n: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    while (active >= n) await new Promise<void>((r) => waiting.push(r));
    active++;
    try { return await fn(); } finally { active--; waiting.shift()?.(); }
  };
}

async function putBlob(blocks: TreeBlocks, bytes: Uint8Array): Promise<CID> {
  const cid = blobCid(bytes);
  if (!(await blocks.has(cid))) await blocks.putBlock(cid, hashBlob(bytes).object);
  return cid;
}

async function streamCid(path: string, size: number): Promise<CID | undefined> {
  const h = createHash("sha1").update(header("blob", size));
  let n = 0;
  for await (const chunk of createReadStream(path)) { h.update(chunk as Buffer); n += (chunk as Buffer).length; }
  return n === size ? sha1Cid(h.digest()) : undefined; // changed underfoot: caller rereads
}

async function scanFile(blocks: TreeBlocks, path: string, name: string): Promise<Entry> {
  const st = await fs.lstat(path);
  // git records only the owner's execute bit (core.filemode).
  const mode: Mode = st.mode & 0o100 ? "100755" : "100644";
  if (st.size > STREAM_OVER) {
    const cid = await streamCid(path, st.size);
    if (cid && (await blocks.has(cid))) return { mode, name, cid };
  }
  return { mode, name, cid: await putBlob(blocks, await fs.readFile(path)) };
}

/** Hash a directory into the store; returns the root tree. Empty directories vanish, as in git. */
export async function scan(blocks: TreeBlocks, dir: string, opts: ScanOptions = {}): Promise<CID> {
  const ignore = opts.ignore ?? defaultIgnore;
  const limit = gate(64);
  const tree = async (abs: string, rel: string): Promise<CID | undefined> => {
    const dirents = await fs.readdir(abs, { withFileTypes: true });
    const found = await Promise.all(dirents.map(async (d): Promise<Entry | undefined> => {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (ignore(r)) return undefined;
      const p = join(abs, d.name);
      if (d.isDirectory()) {
        const cid = await tree(p, r);
        return cid && { mode: "40000", name: d.name, cid };
      }
      if (d.isSymbolicLink()) {
        return limit(async () => ({ mode: "120000", name: d.name, cid: await putBlob(blocks, await fs.readlink(p, { encoding: "buffer" })) }));
      }
      if (d.isFile()) return limit(() => scanFile(blocks, p, d.name));
      return undefined; // fifos, sockets, devices: git skips them too
    }));
    const entries = found.filter((e): e is Entry => e !== undefined);
    if (entries.length === 0 && rel !== "") return undefined;
    const { cid, object } = hashTree(entries);
    if (!(await blocks.has(cid))) await blocks.putBlock(cid, object);
    return cid;
  };
  return (await tree(resolve(dir), ""))!;
}

// ---------------------------------------------------------------- materialize

function checkName(name: string, rel: string): void {
  // Trees come from anywhere; a name is one path segment or nothing. ".git" is refused as git does.
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0") || name.toLowerCase() === ".git") {
    throw new Error(`refusing tree entry ${JSON.stringify(name)} under ${JSON.stringify(rel || ".")}`);
  }
}

async function lstatOr(path: string): Promise<Stats | undefined> {
  try { return await fs.lstat(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
}

/**
 * Check `tree` out into `dir`: afterwards scan(dir) === tree. Anything not in the
 * tree is removed, except paths `ignore` matches (by default .git and node_modules).
 * Never writes through an existing symlink.
 */
export async function materialize(blocks: TreeBlocks, tree: CID, dir: string, opts: ScanOptions = {}): Promise<void> {
  const ignore = opts.ignore ?? defaultIgnore;
  const root = resolve(dir);
  await fs.mkdir(root, { recursive: true });
  const limit = gate(32);
  const inside = (p: string) => {
    if (p !== root && !p.startsWith(root + sep)) throw new Error(`refusing to write outside ${root}: ${p}`);
  };

  const leaf = async (e: Entry, p: string, st: Stats | undefined) => {
    const data = await readBlob(blocks, e.cid);
    if (e.mode === "120000") {
      if (st?.isSymbolicLink() && (await fs.readlink(p, { encoding: "buffer" })).equals(data)) return;
      if (st) await fs.rm(p, { recursive: true, force: true });
      await fs.symlink(Buffer.from(data), p);
      return;
    }
    const exec = e.mode === "100755";
    if (st?.isFile()) {
      if (st.size !== data.length || !(await fs.readFile(p)).equals(data)) await fs.writeFile(p, data);
      if (Boolean(st.mode & 0o100) !== exec) {
        // Add x wherever r is set (git's 0777&~umask shape); drop all x otherwise.
        await fs.chmod(p, exec ? st.mode | ((st.mode & 0o444) >> 2) : st.mode & ~0o111);
      }
      return;
    }
    if (st) await fs.rm(p, { recursive: true, force: true });
    // "wx": O_EXCL refuses to follow anything that raced into place.
    await fs.writeFile(p, data, { mode: exec ? 0o777 : 0o666, flag: "wx" });
  };

  const checkout = async (cid: CID, abs: string, rel: string): Promise<void> => {
    const entries = await readTree(blocks, cid);
    for (const e of entries) checkName(e.name, rel);
    const want = new Set(entries.map((e) => e.name));
    // Clear stale entries first so a file<->dir swap finds its slot empty.
    for (const name of await fs.readdir(abs)) {
      if (!want.has(name) && !ignore(rel ? `${rel}/${name}` : name)) await fs.rm(join(abs, name), { recursive: true, force: true });
    }
    await Promise.all(entries.map(async (e) => {
      const p = join(abs, e.name);
      inside(p);
      const st = await lstatOr(p);
      if (e.mode === "40000" || e.mode === "160000") {
        if (st && !st.isDirectory()) await fs.rm(p, { force: true }); // a symlink here must not be descended
        if (!st?.isDirectory()) await fs.mkdir(p);
        if (e.mode === "40000") await checkout(e.cid, p, rel ? `${rel}/${e.name}` : e.name);
        return;
      }
      await limit(() => leaf(e, p, st));
    }));
  };

  await checkout(tree, root, "");
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

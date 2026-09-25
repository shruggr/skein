// Directory <-> tree objects on a real disk. Outside the machine: the runtime
// never reads or writes a disk. This is the client's job (docs/ARCH.md, "How a
// file gets in and out"); skein-dev uses it as a stand-in for the client.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { CID } from "multiformats/cid";
import { blobCid, hashBlob, hashTree, header, readBlob, readTree, sha1Cid, type Entry, type Mode, type TreeBlocks } from "../runtime/tree.ts";

// Above this, hash from a stream first so a file the store already has is never held whole.
const STREAM_OVER = 1 << 20;

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


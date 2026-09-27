// A mutable, copy-on-write view of a git-shaped tree. Nodes load lazily from
// the store; a node keeps its original CID until something under it changes,
// so commit() re-hashes only the changed spine and every untouched subtree
// keeps its CID unread.

import type { CID } from "multiformats/cid";
import { hashBlob, hashTree, parseTree, readBlob, type Entry, type TreeBlocks } from "../tree.ts";

export type Node = DirNode | FileNode | LinkNode | ModuleNode;

interface Base { ino: number; parent?: DirNode }
export interface DirNode extends Base { kind: "dir"; cid?: CID; entries?: Map<string, Node>; readonly?: boolean }
export interface FileNode extends Base { kind: "file"; exec: boolean; cid?: CID; data?: Uint8Array }
export interface LinkNode extends Base { kind: "link"; cid?: CID; target?: Uint8Array }
/** A gitlink (submodule, mode 160000): kept as is, shown as an empty read-only directory. */
export interface ModuleNode extends Base { kind: "module"; cid: CID }

export class FsError extends Error {
  readonly errno: number;
  constructor(errno: number, message = `errno ${errno}`) { super(message); this.errno = errno; }
}

// wasi errno values used by the filesystem.
export const E = {
  ACCES: 2, BADF: 8, EXIST: 20, INVAL: 28, IO: 29, ISDIR: 31, LOOP: 32, NAMETOOLONG: 37,
  NOENT: 44, NOSYS: 52, NOTDIR: 54, NOTEMPTY: 55, NOTSUP: 58, PERM: 63, PIPE: 64, ROFS: 69, SPIPE: 70,
  NOTCAPABLE: 76,
} as const;

const MAX_LINKS = 40;

export class Vfs {
  readonly root: DirNode;
  private nextIno = 1;
  /** Inode numbers for this run's pipes and /dev/null (wasi/host.ts): far from the tree's. */
  descIno = 1 << 30;
  private readonly blocks: TreeBlocks;

  constructor(blocks: TreeBlocks, root: CID) {
    this.blocks = blocks;
    this.root = { kind: "dir", cid: root, ino: this.nextIno++ };
  }

  private fromEntry(e: Entry, parent: DirNode): Node {
    const ino = this.nextIno++;
    switch (e.mode) {
      case "40000": return { kind: "dir", cid: e.cid, ino, parent };
      case "120000": return { kind: "link", cid: e.cid, ino, parent };
      case "160000": return { kind: "module", cid: e.cid, ino, parent };
      default: return { kind: "file", exec: e.mode === "100755", cid: e.cid, ino, parent };
    }
  }

  newDir(parent: DirNode): DirNode { return { kind: "dir", entries: new Map(), ino: this.nextIno++, parent }; }
  newFile(parent: DirNode, data: Uint8Array = new Uint8Array(0), exec = false): FileNode {
    return { kind: "file", exec, data, ino: this.nextIno++, parent };
  }
  newLink(parent: DirNode, target: Uint8Array): LinkNode { return { kind: "link", target, ino: this.nextIno++, parent }; }

  // ---------------------------------------------------------------- loading

  async entries(d: DirNode): Promise<Map<string, Node>> {
    if (!d.entries) {
      const m = new Map<string, Node>();
      for (const e of parseTree(await this.blocks.bytes(d.cid!), d.cid)) m.set(e.name, this.fromEntry(e, d));
      d.entries ??= m; // a concurrent load may have won
    }
    return d.entries;
  }

  async data(f: FileNode): Promise<Uint8Array> {
    f.data ??= await readBlob(this.blocks, f.cid!);
    return f.data;
  }

  async target(l: LinkNode): Promise<Uint8Array> {
    l.target ??= await readBlob(this.blocks, l.cid!);
    return l.target;
  }

  /** Mark a node changed: it and every directory above it lose their CIDs. */
  dirty(n: Node): void {
    for (let x: Node | undefined = n; x; x = x.parent) {
      if (x.kind === "module") continue;
      x.cid = undefined;
    }
  }

  // ---------------------------------------------------------------- paths

  /**
   * Resolve `path` from directory `at`. Absolute paths and ".." stop at the root
   * (the tree is the whole world). Symlinks in the middle are always followed;
   * the last one only with `follow`.
   */
  async resolve(at: DirNode, path: string, follow: boolean, hops = 0): Promise<Node> {
    const { dir, name } = await this.resolveParent(at, path, hops);
    if (name === "" || name === ".") return dir;
    if (name === "..") return dir.parent ?? dir;
    const n = (await this.entries(dir)).get(name);
    if (!n) throw new FsError(E.NOENT);
    if (n.kind === "link" && follow) return this.followLink(dir, n, hops);
    return n;
  }

  private async followLink(dir: DirNode, l: LinkNode, hops: number): Promise<Node> {
    if (hops >= MAX_LINKS) throw new FsError(E.LOOP);
    const t = Buffer.from(await this.target(l)).toString("utf8");
    return this.resolve(t.startsWith("/") ? this.root : dir, t, true, hops + 1);
  }

  /** The directory that holds the last component, and that component's name. */
  async resolveParent(at: DirNode, path: string, hops = 0): Promise<{ dir: DirNode; name: string }> {
    if (path.includes("\0")) throw new FsError(E.INVAL);
    let dir = path.startsWith("/") ? this.root : at;
    const parts = path.split("/").filter((p) => p !== "");
    const name = parts.pop() ?? "";
    for (const p of parts) {
      if (p === ".") continue;
      if (p === "..") { dir = dir.parent ?? dir; continue; }
      let n = (await this.entries(dir)).get(p);
      if (!n) throw new FsError(E.NOENT);
      if (n.kind === "link") n = await this.followLink(dir, n, hops);
      if (n.kind === "module") n = await this.moduleDir(n);
      if (n.kind !== "dir") throw new FsError(E.NOTDIR);
      dir = n;
    }
    return { dir, name };
  }

  /** Submodules read as an empty directory that refuses writes. */
  private async moduleDir(m: ModuleNode): Promise<DirNode> {
    return { kind: "dir", entries: new Map(), ino: m.ino, parent: m.parent, readonly: true };
  }

  /** Absolute path of a directory (for getcwd-like needs and diagnostics). */
  pathOf(n: Node): string {
    const parts: string[] = [];
    for (let x: Node = n; x.parent; x = x.parent) {
      const name = [...x.parent.entries!.entries()].find(([, v]) => v === x)?.[0];
      if (name === undefined) break;
      parts.unshift(name);
    }
    return "/" + parts.join("/");
  }

  // ---------------------------------------------------------------- mutation

  async link(dir: DirNode, name: string, n: Node): Promise<void> {
    checkName(name);
    if (dir.readonly) throw new FsError(E.ROFS);
    const m = await this.entries(dir);
    m.set(name, n);
    n.parent = dir;
    this.dirty(dir);
  }

  async unlink(dir: DirNode, name: string): Promise<Node | undefined> {
    const m = await this.entries(dir);
    const n = m.get(name);
    if (!n) return undefined;
    m.delete(name);
    this.dirty(dir);
    n.parent = undefined;
    return n;
  }

  // ---------------------------------------------------------------- commit

  /** Hash every changed directory bottom-up, store new objects, return the root CID. */
  async commit(): Promise<CID> {
    return this.hashDir(this.root);
  }

  private async put(cid: CID, object: Uint8Array): Promise<void> {
    if (!(await this.blocks.has(cid))) await this.blocks.putBlock(cid, object);
  }

  private async hashDir(d: DirNode): Promise<CID> {
    if (d.cid) return d.cid;
    const out: Entry[] = [];
    for (const [name, n] of d.entries!) {
      switch (n.kind) {
        case "dir": out.push({ mode: "40000", name, cid: await this.hashDir(n) }); break;
        case "module": out.push({ mode: "160000", name, cid: n.cid }); break;
        case "link": out.push({ mode: "120000", name, cid: await this.hashLeaf(n, n.target) }); break;
        case "file": out.push({ mode: n.exec ? "100755" : "100644", name, cid: await this.hashLeaf(n, n.data) }); break;
      }
    }
    const { cid, object } = hashTree(out);
    await this.put(cid, object);
    d.cid = cid;
    return cid;
  }

  private async hashLeaf(n: FileNode | LinkNode, bytes: Uint8Array | undefined): Promise<CID> {
    if (n.cid) return n.cid;
    const { cid, object } = hashBlob(bytes!);
    await this.put(cid, object);
    n.cid = cid;
    return cid;
  }
}

export function checkName(name: string): void {
  if (!name || name === "." || name === ".." || name.includes("/")) throw new FsError(E.INVAL);
  if (Buffer.byteLength(name) > 255) throw new FsError(E.NAMETOOLONG);
}

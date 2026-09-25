// wasi_snapshot_preview1 over a Vfs, for one process (one wasm instance).
// This is the runtime's kernel surface (docs/ARCH.md, "The kernel"). Nothing
// here touches a host: the filesystem is the tree, stdio are in-memory pipes.
// clock_time_get, random_get and sleeps (poll_oneoff on clocks) are handed to
// the caller (`clock`, `random`, `sleep`); the scheduler answers them from the
// current log entry (runtime/syscalls.ts), and a sleep may park the instance
// until a later entry arrives. Imports that may wait
// (a record from the store, a sleep, a spawned child) are async and
// wrapped with JSPI (WebAssembly.Suspending): the wasm stack is parked on the
// promise and resumes when it settles.

import { NotFound } from "../store.ts";
import { E, FsError, checkName, type DirNode, type FileNode, type Node, type Vfs } from "./vfs.ts";

// JSPI (stage 4, shipped in Node 26) is not in TypeScript's lib yet.
export const JSPI = WebAssembly as unknown as {
  Suspending: new (f: (...a: never[]) => unknown) => object;
  promising: (f: () => void) => () => Promise<void>;
};

// ---------------------------------------------------------------- open file descriptions

/** A byte queue between processes. Processes run one at a time, so an empty pipe reads as end of file. */
export class Pipe {
  private chunks: Uint8Array[] = [];
  private head = 0;
  size = 0;
  readonly limit: number;
  constructor(limit = 64 << 20, initial?: Uint8Array) {
    this.limit = limit;
    if (initial?.length) this.write(initial);
  }
  write(b: Uint8Array): boolean {
    if (this.size + b.length > this.limit) return false;
    this.chunks.push(b.slice());
    this.size += b.length;
    return true;
  }
  read(max: number): Uint8Array {
    const parts: Uint8Array[] = [];
    let n = 0;
    while (n < max && this.chunks.length) {
      const c = this.chunks[0];
      const take = Math.min(max - n, c.length - this.head);
      parts.push(c.subarray(this.head, this.head + take));
      n += take;
      this.head += take;
      if (this.head === c.length) { this.chunks.shift(); this.head = 0; }
    }
    this.size -= n;
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  }
  drain(): Uint8Array { return this.read(this.size); }
}

export type Desc =
  | { t: "file"; node: FileNode; pos: number; append: boolean; read: boolean; write: boolean; ino: number }
  | { t: "dir"; node: DirNode; preopen?: string; ino: number }
  | { t: "pipe"; pipe: Pipe; end: "r" | "w"; ino: number }
  | { t: "null"; ino: number };

// Pipes and null get inode numbers far from the tree's.
let descIno = 1 << 30;
export const nullDesc = (): Desc => ({ t: "null", ino: descIno++ });
export const pipeDesc = (pipe: Pipe, end: "r" | "w"): Desc => ({ t: "pipe", pipe, end, ino: descIno++ });

// ---------------------------------------------------------------- constants

const FT = { UNKNOWN: 0, CHAR: 2, DIR: 3, FILE: 4, LINK: 7 } as const;
const O = { CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8 } as const;
const FDFLAG_APPEND = 1;
const RIGHT_READ = 1n << 1n, RIGHT_WRITE = 1n << 6n;
const ALL_RIGHTS = (1n << 30n) - 1n;

export class ProcExit extends Error {
  readonly code: number;
  constructor(code: number) { super(`exit ${code}`); this.code = code; }
}

// ---------------------------------------------------------------- the process

export interface SpawnRequest { program: string; cwd: string; argv: string[]; env: string[]; stdio: [Desc, Desc, Desc] }

export interface ProcessOptions {
  vfs: Vfs;
  args: string[];
  env: string[];
  /** fd → description. 0-2 are stdio; the preopen for "/" is added at 3. */
  stdio: [Desc, Desc, Desc];
  /** clock_time_get(id): nanoseconds. */
  clock: (id: number) => bigint | Promise<bigint>;
  /** random_get: `len` bytes. */
  random: (len: number) => Uint8Array | Promise<Uint8Array>;
  /** A poll on clocks only (a sleep). May suspend until the machine's time reaches the earliest deadline. Default: returns at once. */
  sleep?: (clocks: Array<{ timeout: bigint; absolute: boolean }>) => void | Promise<void>;
  /** Host services for the shell (the "skein" import module). */
  spawn?: (req: SpawnRequest) => Promise<number | undefined>;
  commandExists?: (name: string) => boolean;
}

type Fn = (...a: never[]) => unknown;

export class Process {
  readonly fds = new Map<number, Desc>();
  memory!: WebAssembly.Memory;
  private readonly o: ProcessOptions;

  constructor(o: ProcessOptions) {
    this.o = o;
    o.stdio.forEach((d, i) => this.fds.set(i, d));
    this.fds.set(3, { t: "dir", node: o.vfs.root, preopen: "/", ino: o.vfs.root.ino });
  }

  private get dv() { return new DataView(this.memory.buffer); }
  private get u8() { return new Uint8Array(this.memory.buffer); }
  private str(ptr: number, len: number): string { return Buffer.from(this.u8.subarray(ptr, ptr + len)).toString("utf8"); }
  private add(d: Desc): number { let fd = 3; while (this.fds.has(fd)) fd++; this.fds.set(fd, d); return fd; }
  private desc(fd: number): Desc { const d = this.fds.get(fd); if (!d) throw new FsError(E.BADF); return d; }
  private dirDesc(fd: number): DirNode { const d = this.desc(fd); if (d.t !== "dir") throw new FsError(d.t === "file" ? E.NOTDIR : E.BADF); return d.node; }

  /** Iovecs at `iovs` as [ptr, len] pairs. */
  private iovs(iovs: number, n: number): Array<[number, number]> {
    const dv = this.dv, out: Array<[number, number]> = [];
    for (let i = 0; i < n; i++) out.push([dv.getUint32(iovs + i * 8, true), dv.getUint32(iovs + i * 8 + 4, true)]);
    return out;
  }

  private writeStat(buf: number, ino: number, ft: number, size: number): void {
    // Git records no times, so neither does the tree: every file reads as the epoch.
    const dv = this.dv, t = 0n;
    dv.setBigUint64(buf, 1n, true);
    dv.setBigUint64(buf + 8, BigInt(ino), true);
    dv.setUint8(buf + 16, ft);
    dv.setBigUint64(buf + 24, 1n, true);
    dv.setBigUint64(buf + 32, BigInt(size), true);
    dv.setBigUint64(buf + 40, t, true);
    dv.setBigUint64(buf + 48, t, true);
    dv.setBigUint64(buf + 56, t, true);
  }

  private async nodeStat(n: Node): Promise<[number, number]> {
    switch (n.kind) {
      case "dir": case "module": return [FT.DIR, 0];
      case "file": return [FT.FILE, (await this.o.vfs.data(n)).length];
      case "link": return [FT.LINK, (await this.o.vfs.target(n)).length];
    }
  }

  // ---------------------------------------------------------------- the import object

  imports(): WebAssembly.Imports {
    const sync: Record<string, Fn> = {
      args_sizes_get: (argc: number, size: number) => this.sizes(this.o.args, argc, size),
      args_get: (argv: number, buf: number) => this.strings(this.o.args, argv, buf),
      environ_sizes_get: (n: number, size: number) => this.sizes(this.o.env, n, size),
      environ_get: (env: number, buf: number) => this.strings(this.o.env, env, buf),
      clock_res_get: (_id: number, out: number) => { this.dv.setBigUint64(out, 1n, true); return 0; },
      proc_exit: (code: number) => { throw new ProcExit(code); },
      proc_raise: () => E.NOSYS,
      sched_yield: () => 0,
      fd_write: (fd: number, iovs: number, n: number, nw: number) => this.fdWrite(fd, iovs, n, nw),
      fd_read: (fd: number, iovs: number, n: number, nr: number) => this.fdRead(fd, iovs, n, nr),
      fd_pread: (fd: number, iovs: number, n: number, off: bigint, nr: number) => this.fdRead(fd, iovs, n, nr, Number(off)),
      fd_pwrite: () => E.NOTSUP,
      fd_seek: (fd: number, off: bigint, whence: number, out: number) => this.fdSeek(fd, off, whence, out),
      fd_tell: (fd: number, out: number) => this.fdSeek(fd, 0n, 1, out),
      fd_close: (fd: number) => (this.fds.delete(fd) ? 0 : E.BADF),
      fd_fdstat_get: (fd: number, buf: number) => this.fdstat(fd, buf),
      fd_fdstat_set_flags: (fd: number, flags: number) => {
        const d = this.desc(fd);
        if (d.t === "file") d.append = (flags & FDFLAG_APPEND) !== 0;
        return 0;
      },
      fd_fdstat_set_rights: () => 0,
      fd_prestat_get: (fd: number, buf: number) => {
        const d = this.fds.get(fd);
        if (!d || d.t !== "dir" || !d.preopen) return E.BADF;
        this.dv.setUint8(buf, 0);
        this.dv.setUint32(buf + 4, Buffer.byteLength(d.preopen), true);
        return 0;
      },
      fd_prestat_dir_name: (fd: number, ptr: number, len: number) => {
        const d = this.fds.get(fd);
        if (!d || d.t !== "dir" || !d.preopen) return E.BADF;
        this.u8.set(Buffer.from(d.preopen).subarray(0, len), ptr);
        return 0;
      },
      fd_filestat_set_size: (fd: number, size: bigint) => {
        const d = this.desc(fd);
        if (d.t !== "file" || !d.write) return E.BADF;
        this.setData(d.node, resize(d.node.data!, Number(size)));
        return 0;
      },
      fd_filestat_set_times: () => 0, // git records no times
      fd_advise: () => 0,
      fd_allocate: () => 0,
      fd_datasync: () => 0,
      fd_sync: () => 0,
      fd_renumber: (from: number, to: number) => {
        const d = this.desc(from);
        this.fds.set(to, d);
        this.fds.delete(from);
        return 0;
      },
      path_filestat_set_times: () => 0,
      sock_accept: () => E.NOTSUP, sock_recv: () => E.NOTSUP, sock_send: () => E.NOTSUP, sock_shutdown: () => E.NOTSUP,
    };

    const async: Record<string, Fn> = {
      poll_oneoff: (inp: number, out: number, n: number, nout: number) => this.pollOneoff(inp, out, n, nout),
      // Read memory views only after the await: a suspension may have grown (and so detached) memory.
      clock_time_get: async (id: number, _prec: bigint, out: number) => {
        const t = await this.o.clock(id);
        this.dv.setBigUint64(out, t, true);
        return 0;
      },
      random_get: async (buf: number, len: number) => {
        const bytes = await this.o.random(len);
        this.u8.set(bytes.subarray(0, len), buf);
        return 0;
      },
      fd_filestat_get: (fd: number, buf: number) => this.fdFilestat(fd, buf),
      fd_readdir: (fd: number, buf: number, len: number, cookie: bigint, used: number) => this.fdReaddir(fd, buf, len, cookie, used),
      path_open: (dirfd: number, dirflags: number, p: number, pl: number, oflags: number, rb: bigint, _ri: bigint, fdflags: number, out: number) =>
        this.pathOpen(dirfd, dirflags, this.str(p, pl), oflags, rb, fdflags, out),
      path_filestat_get: (fd: number, flags: number, p: number, pl: number, buf: number) => this.pathFilestat(fd, flags, this.str(p, pl), buf),
      path_create_directory: (fd: number, p: number, pl: number) => this.mkdir(fd, this.str(p, pl)),
      path_remove_directory: (fd: number, p: number, pl: number) => this.rmdir(fd, this.str(p, pl)),
      path_unlink_file: (fd: number, p: number, pl: number) => this.unlinkFile(fd, this.str(p, pl)),
      path_rename: (fd: number, p: number, pl: number, fd2: number, q: number, ql: number) => this.rename(fd, this.str(p, pl), fd2, this.str(q, ql)),
      path_symlink: (p: number, pl: number, fd: number, q: number, ql: number) => this.symlink(this.u8.slice(p, p + pl), fd, this.str(q, ql)),
      path_readlink: (fd: number, p: number, pl: number, buf: number, len: number, used: number) => this.readlink(fd, this.str(p, pl), buf, len, used),
      path_link: (fd: number, _flags: number, p: number, pl: number, fd2: number, q: number, ql: number) => this.hardlink(fd, this.str(p, pl), fd2, this.str(q, ql)),
    };

    const wasi: Record<string, unknown> = {};
    for (const [k, f] of Object.entries(sync)) wasi[k] = this.guard(f);
    for (const [k, f] of Object.entries(async)) wasi[k] = new JSPI.Suspending(this.guardAsync(f));

    const skein = {
      cmd_exists: (p: number, l: number) => (this.o.commandExists?.(this.str(p, l)) ? 1 : 0),
      pipe: (out: number) => {
        const pipe = new Pipe();
        const r = this.add(pipeDesc(pipe, "r")), w = this.add(pipeDesc(pipe, "w"));
        this.dv.setUint32(out, r, true);
        this.dv.setUint32(out + 4, w, true);
        return 0;
      },
      spawn: new JSPI.Suspending(this.guardAsync((req: number, len: number, i: number, o: number, e: number, code: number) =>
        this.spawn(req, len, [i, o, e], code))),
    };
    return { wasi_snapshot_preview1: wasi as WebAssembly.ModuleImports, skein: skein as WebAssembly.ModuleImports };
  }

  private guard(f: Fn): Fn {
    return ((...a: never[]) => {
      try { return f(...a); } catch (e) { return errnoOf(e); }
    }) as Fn;
  }

  private guardAsync(f: Fn): Fn {
    return (async (...a: never[]) => {
      try { return await f(...a); } catch (e) { return errnoOf(e); }
    }) as Fn;
  }

  // ---------------------------------------------------------------- args, env

  private sizes(list: string[], count: number, size: number): number {
    this.dv.setUint32(count, list.length, true);
    this.dv.setUint32(size, list.reduce((n, s) => n + Buffer.byteLength(s) + 1, 0), true);
    return 0;
  }

  private strings(list: string[], ptrs: number, buf: number): number {
    const dv = this.dv, u8 = this.u8;
    list.forEach((s, i) => {
      dv.setUint32(ptrs + i * 4, buf, true);
      const b = Buffer.from(s + "\0");
      u8.set(b, buf);
      buf += b.length;
    });
    return 0;
  }

  // ---------------------------------------------------------------- fd io

  private setData(n: FileNode, data: Uint8Array): void {
    n.data = data;
    this.o.vfs.dirty(n);
  }

  private fdWrite(fd: number, iovs: number, n: number, nw: number): number {
    const d = this.desc(fd);
    const bufs = this.iovs(iovs, n).map(([p, l]) => this.u8.slice(p, p + l));
    const total = bufs.reduce((s, b) => s + b.length, 0);
    switch (d.t) {
      case "null": break;
      case "pipe":
        if (d.end !== "w") return E.BADF;
        for (const b of bufs) if (!d.pipe.write(b)) return E.PIPE;
        break;
      case "file": {
        if (!d.write) return E.BADF;
        const data = d.node.data!;
        const at = d.append ? data.length : d.pos;
        const next = resize(data, Math.max(data.length, at + total));
        let off = at;
        for (const b of bufs) { next.set(b, off); off += b.length; }
        this.setData(d.node, next);
        d.pos = off;
        break;
      }
      case "dir": return E.BADF;
    }
    this.dv.setUint32(nw, total, true);
    return 0;
  }

  private fdRead(fd: number, iovs: number, n: number, nr: number, at?: number): number {
    const d = this.desc(fd);
    let got = 0;
    const u8 = this.u8;
    for (const [p, l] of this.iovs(iovs, n)) {
      let chunk: Uint8Array;
      if (d.t === "null") chunk = new Uint8Array(0);
      else if (d.t === "pipe") { if (d.end !== "r") return E.BADF; chunk = d.pipe.read(l); }
      else if (d.t === "file") {
        if (!d.read) return E.BADF;
        const pos = at === undefined ? d.pos : at + got;
        chunk = d.node.data!.subarray(pos, pos + l);
        if (at === undefined) d.pos += chunk.length;
      } else return E.ISDIR;
      u8.set(chunk, p);
      got += chunk.length;
      if (chunk.length < l) break;
    }
    this.dv.setUint32(nr, got, true);
    return 0;
  }

  private fdSeek(fd: number, off: bigint, whence: number, out: number): number {
    const d = this.desc(fd);
    if (d.t !== "file") return d.t === "dir" ? E.BADF : E.SPIPE;
    const base = whence === 0 ? 0 : whence === 1 ? d.pos : d.node.data!.length;
    const pos = base + Number(off);
    if (pos < 0) return E.INVAL;
    d.pos = pos;
    this.dv.setBigUint64(out, BigInt(pos), true);
    return 0;
  }

  private fdstat(fd: number, buf: number): number {
    const d = this.desc(fd);
    const dv = this.dv;
    // Nothing is a terminal: a char device must lack seek/tell rights to count as a tty, and ours has them all.
    const ft = d.t === "file" ? FT.FILE : d.t === "dir" ? FT.DIR : d.t === "null" ? FT.CHAR : FT.UNKNOWN;
    dv.setUint8(buf, ft);
    dv.setUint16(buf + 2, d.t === "file" && d.append ? FDFLAG_APPEND : 0, true);
    dv.setBigUint64(buf + 8, ALL_RIGHTS, true);
    dv.setBigUint64(buf + 16, ALL_RIGHTS, true);
    return 0;
  }

  private async fdFilestat(fd: number, buf: number): Promise<number> {
    const d = this.desc(fd);
    if (d.t === "file") this.writeStat(buf, d.ino, FT.FILE, d.node.data!.length);
    else if (d.t === "dir") this.writeStat(buf, d.ino, FT.DIR, 0);
    else this.writeStat(buf, d.ino, d.t === "null" ? FT.CHAR : FT.UNKNOWN, d.t === "pipe" ? d.pipe.size : 0);
    return 0;
  }

  private async fdReaddir(fd: number, buf: number, len: number, cookie: bigint, used: number): Promise<number> {
    const dir = this.dirDesc(fd);
    const entries = [...(await this.o.vfs.entries(dir)).entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const list: Array<[string, number, number]> = [[".", dir.ino, FT.DIR], ["..", (dir.parent ?? dir).ino, FT.DIR]];
    for (const [name, n] of entries) list.push([name, n.ino, n.kind === "file" ? FT.FILE : n.kind === "link" ? FT.LINK : FT.DIR]);
    const out: Buffer[] = [];
    let size = 0;
    for (let i = Number(cookie); i < list.length && size < len; i++) {
      const [name, ino, ft] = list[i];
      const nb = Buffer.from(name);
      const ent = Buffer.alloc(24 + nb.length);
      ent.writeBigUInt64LE(BigInt(i + 1), 0);
      ent.writeBigUInt64LE(BigInt(ino), 8);
      ent.writeUInt32LE(nb.length, 16);
      ent.writeUInt8(ft, 20);
      nb.copy(ent, 24);
      out.push(ent);
      size += ent.length;
    }
    const all = Buffer.concat(out).subarray(0, len); // a truncated last entry tells libc to retry bigger
    this.u8.set(all, buf);
    this.dv.setUint32(used, all.length, true);
    return 0;
  }

  // ---------------------------------------------------------------- paths

  private async pathOpen(dirfd: number, dirflags: number, path: string, oflags: number, rights: bigint, fdflags: number, out: number): Promise<number> {
    const vfs = this.o.vfs;
    const base = this.dirDesc(dirfd);
    const dev = this.device(base, path);
    if (dev) { this.dv.setUint32(out, this.add(dev), true); return 0; }
    const follow = (dirflags & 1) !== 0;
    const wantWrite = (rights & RIGHT_WRITE) !== 0n || (oflags & O.TRUNC) !== 0;
    const { dir, name } = await vfs.resolveParent(base, path);
    let node: Node | undefined;
    if (name === "" || name === ".") node = dir;
    else if (name === "..") node = dir.parent ?? dir;
    else {
      node = (await vfs.entries(dir)).get(name);
      if (node?.kind === "link" && follow) {
        try { node = await vfs.resolve(dir, name, true); } catch (e) {
          // A dangling symlink with O_CREAT creates its target, as on unix.
          if (!(e instanceof FsError && e.errno === E.NOENT && oflags & O.CREAT)) throw e;
          const t = Buffer.from(await vfs.target(node as never)).toString("utf8");
          return this.pathOpen(dirfd, dirflags, t.startsWith("/") ? t : `${vfs.pathOf(dir)}/${t}`, oflags, rights, fdflags, out);
        }
      }
    }
    if (node && oflags & O.CREAT && oflags & O.EXCL) return E.EXIST;
    if (!node) {
      if (!(oflags & O.CREAT)) return E.NOENT;
      if (oflags & O.DIRECTORY) return E.INVAL;
      checkName(name);
      if (dir.readonly) return E.ROFS;
      node = vfs.newFile(dir);
      await vfs.link(dir, name, node);
    }
    if (node.kind === "link") return E.LOOP;
    if (node.kind === "dir" || node.kind === "module") {
      if (wantWrite) return E.ISDIR;
      const d = node.kind === "dir" ? node : await vfs.resolve(dir, name, true) as DirNode;
      this.dv.setUint32(out, this.add({ t: "dir", node: d, ino: node.ino }), true);
      return 0;
    }
    if (oflags & O.DIRECTORY) return E.NOTDIR;
    await vfs.data(node);
    if (oflags & O.TRUNC && node.data!.length) this.setData(node, new Uint8Array(0));
    const desc: Desc = {
      t: "file", node, pos: 0, ino: node.ino,
      append: (fdflags & FDFLAG_APPEND) !== 0,
      read: (rights & RIGHT_READ) !== 0n || !wantWrite,
      write: wantWrite,
    };
    this.dv.setUint32(out, this.add(desc), true);
    return 0;
  }

  /**
   * /dev/null and /dev/std{in,out,err} exist whatever the tree holds (unless it has its own /dev).
   * They are not part of the tree and never appear in a listing.
   */
  private device(base: DirNode, path: string): Desc | undefined {
    const root = this.o.vfs.root;
    if (base !== root && !path.startsWith("/")) return undefined;
    const p = path.split("/").filter((x) => x && x !== ".").join("/");
    if (!p.startsWith("dev/") || root.entries?.has("dev")) return undefined;
    switch (p) {
      case "dev/null": return nullDesc();
      case "dev/stdin": return this.fds.get(0);
      case "dev/stdout": return this.fds.get(1);
      case "dev/stderr": return this.fds.get(2);
    }
    return undefined;
  }

  private async pathFilestat(fd: number, flags: number, path: string, buf: number): Promise<number> {
    const dev = this.device(this.dirDesc(fd), path);
    if (dev) { this.writeStat(buf, dev.ino, FT.CHAR, 0); return 0; }
    const n = await this.o.vfs.resolve(this.dirDesc(fd), path, (flags & 1) !== 0);
    const [ft, size] = await this.nodeStat(n);
    this.writeStat(buf, n.ino, ft, size);
    return 0;
  }

  private async mkdir(fd: number, path: string): Promise<number> {
    const vfs = this.o.vfs;
    const { dir, name } = await vfs.resolveParent(this.dirDesc(fd), path);
    if (name === "" || name === "." || name === "..") return E.EXIST;
    if ((await vfs.entries(dir)).has(name)) return E.EXIST;
    if (dir.readonly) return E.ROFS;
    await vfs.link(dir, name, vfs.newDir(dir));
    return 0;
  }

  private async rmdir(fd: number, path: string): Promise<number> {
    const vfs = this.o.vfs;
    const { dir, name } = await vfs.resolveParent(this.dirDesc(fd), path);
    if (name === "" || name === "." || name === "..") return E.INVAL;
    const n = (await vfs.entries(dir)).get(name);
    if (!n) return E.NOENT;
    if (n.kind !== "dir" && n.kind !== "module") return E.NOTDIR;
    if (n.kind === "dir" && (await vfs.entries(n)).size) return E.NOTEMPTY;
    await vfs.unlink(dir, name);
    return 0;
  }

  private async unlinkFile(fd: number, path: string): Promise<number> {
    const vfs = this.o.vfs;
    const { dir, name } = await vfs.resolveParent(this.dirDesc(fd), path);
    if (name === "" || name === "." || name === "..") return E.ISDIR;
    const n = (await vfs.entries(dir)).get(name);
    if (!n) return E.NOENT;
    if (n.kind === "dir" || n.kind === "module") return E.ISDIR;
    await vfs.unlink(dir, name);
    return 0;
  }

  private async rename(fd: number, from: string, fd2: number, to: string): Promise<number> {
    const vfs = this.o.vfs;
    const a = await vfs.resolveParent(this.dirDesc(fd), from);
    const b = await vfs.resolveParent(this.dirDesc(fd2), to);
    if ([a.name, b.name].some((x) => x === "" || x === "." || x === "..")) return E.INVAL;
    const src = (await vfs.entries(a.dir)).get(a.name);
    if (!src) return E.NOENT;
    const dst = (await vfs.entries(b.dir)).get(b.name);
    if (dst === src) return 0;
    if (b.dir.readonly) return E.ROFS;
    if (src.kind === "dir") {
      for (let x: DirNode | undefined = b.dir; x; x = x.parent) if (x === src) return E.INVAL; // into itself
      if (dst && dst.kind !== "dir") return E.NOTDIR;
      if (dst?.kind === "dir" && (await vfs.entries(dst)).size) return E.NOTEMPTY;
    } else if (dst?.kind === "dir") return E.ISDIR;
    checkName(b.name);
    await vfs.unlink(a.dir, a.name);
    await vfs.link(b.dir, b.name, src);
    return 0;
  }

  private async symlink(target: Uint8Array, fd: number, path: string): Promise<number> {
    const vfs = this.o.vfs;
    const { dir, name } = await vfs.resolveParent(this.dirDesc(fd), path);
    if ((await vfs.entries(dir)).has(name)) return E.EXIST;
    if (dir.readonly) return E.ROFS;
    checkName(name);
    await vfs.link(dir, name, vfs.newLink(dir, target));
    return 0;
  }

  private async readlink(fd: number, path: string, buf: number, len: number, used: number): Promise<number> {
    const n = await this.o.vfs.resolve(this.dirDesc(fd), path, false);
    if (n.kind !== "link") return E.INVAL;
    const t = (await this.o.vfs.target(n)).subarray(0, len);
    this.u8.set(t, buf);
    this.dv.setUint32(used, t.length, true);
    return 0;
  }

  /** Git has no hard links: a link is a copy that shares nothing afterwards. */
  private async hardlink(fd: number, from: string, fd2: number, to: string): Promise<number> {
    const vfs = this.o.vfs;
    const src = await vfs.resolve(this.dirDesc(fd), from, false);
    if (src.kind !== "file") return E.PERM;
    const { dir, name } = await vfs.resolveParent(this.dirDesc(fd2), to);
    if ((await vfs.entries(dir)).has(name)) return E.EXIST;
    if (dir.readonly) return E.ROFS;
    checkName(name);
    await vfs.link(dir, name, vfs.newFile(dir, (await vfs.data(src)).slice(), src.exec));
    return 0;
  }

  // ---------------------------------------------------------------- time

  /**
   * fd subscriptions are ready at once (reads never block: processes run one at
   * a time). A poll on clocks only is a sleep: handed to `sleep`, which may
   * suspend the instance until the machine's time passes the deadline.
   */
  private async pollOneoff(inp: number, out: number, n: number, nout: number): Promise<number> {
    let dv = this.dv;
    const clocks: Array<{ timeout: bigint; absolute: boolean }> = [];
    let fds = false;
    for (let i = 0; i < n; i++) {
      const s = inp + i * 48;
      if (dv.getUint8(s + 8) === 0) clocks.push({ timeout: dv.getBigUint64(s + 24, true), absolute: (dv.getUint16(s + 40, true) & 1) !== 0 });
      else fds = true;
    }
    if (clocks.length && !fds && this.o.sleep) {
      await this.o.sleep(clocks);
      dv = this.dv; // memory may have grown while suspended
    }
    for (let i = 0; i < n; i++) {
      const s = inp + i * 48, e = out + i * 32;
      const tag = dv.getUint8(s + 8);
      dv.setBigUint64(e, dv.getBigUint64(s, true), true);
      dv.setUint16(e + 8, 0, true);
      dv.setUint8(e + 10, tag);
      let bytes = 0n;
      if (tag === 1) {
        const d = this.fds.get(dv.getUint32(s + 16, true));
        if (d?.t === "pipe") bytes = BigInt(d.pipe.size);
        else if (d?.t === "file") bytes = BigInt(Math.max(0, d.node.data!.length - d.pos));
      }
      dv.setBigUint64(e + 16, bytes, true);
      dv.setUint16(e + 24, 0, true);
    }
    dv.setUint32(nout, n, true);
    return 0;
  }

  // ---------------------------------------------------------------- spawn

  private async spawn(req: number, len: number, stdio: number[], code: number): Promise<number> {
    if (!this.o.spawn) return E.NOSYS;
    const fields = Buffer.from(this.u8.subarray(req, req + len)).toString("utf8").split("\0");
    let i = 0;
    const program = fields[i++], cwd = fields[i++];
    const argc = Number(fields[i++]);
    const argv = fields.slice(i, i + argc); i += argc;
    const envc = Number(fields[i++]);
    const env = fields.slice(i, i + envc);
    const descs = stdio.map((fd) => (fd < 0 ? nullDesc() : this.fds.get(fd) ?? nullDesc())) as [Desc, Desc, Desc];
    const rc = await this.o.spawn({ program, cwd, argv, env, stdio: descs });
    if (rc === undefined) return E.NOENT;
    this.dv.setInt32(code, rc, true);
    return 0;
  }
}

function errnoOf(e: unknown): number {
  if (e instanceof FsError) return e.errno;
  if (e instanceof ProcExit) throw e;
  if (e instanceof NotFound) return E.IO; // a record missing from the store
  throw e;
}

/** A copy of `data` at `len` bytes; the store's buffers are never written in place. */
function resize(data: Uint8Array, len: number): Uint8Array {
  if (len === data.length && owned.has(data)) return data;
  const cap = owned.has(data) ? data.buffer.byteLength : 0;
  if (len <= cap && data.byteOffset === 0) {
    const v = new Uint8Array(data.buffer, 0, len);
    if (len > data.length) v.fill(0, data.length);
    owned.add(v);
    return v;
  }
  const buf = new Uint8Array(Math.max(len, Math.min(len * 2, len + (16 << 20)), 4096));
  buf.set(data.subarray(0, Math.min(len, data.length)));
  const v = buf.subarray(0, len);
  owned.add(v);
  return v;
}
const owned = new WeakSet<Uint8Array>();

// The wasm shell: brush (bash-compatible, WASI) running uutils coreutils (WASI),
// all over a copy-on-write view of a git-shaped tree. Nothing reaches a host:
// the tree is the whole filesystem, the modules come from the caller (the
// runtime loads them from the store by CID), and clock/random reads go to the
// caller's `clock`/`random`/`sleep` — derived from the current log entry when
// a thread runs this (runtime/scheduler.ts), fixed values otherwise. The result is a new root
// tree CID plus captured output.
//
// Process model: brush is patched (wasm/README.md) to ask the host to run
// external commands through the "skein" import module. The host runs each one
// to completion as a fresh WASI instance sharing the same filesystem view, so
// pipelines execute stage by stage with in-memory pipes between them.

import type { CID } from "multiformats/cid";
import { hashTree, type TreeBlocks } from "./tree.ts";
import { Vfs, FsError, type DirNode, type FileNode } from "./wasi/vfs.ts";
import { JSPI, Pipe, Process, ProcExit, nullDesc, pipeDesc, type Desc, type SpawnRequest } from "./wasi/host.ts";

export interface ShellOptions {
  tree: CID;
  cmd: string;
  /** Absolute path inside the tree. Default "/". */
  cwd?: string;
  env?: Record<string, string>;
  stdin?: Uint8Array;
  /** The compiled modules. */
  modules: Modules;
  /** clock_time_get(id) in ns. Default: `time` for every clock. */
  clock?: (id: number) => bigint | Promise<bigint>;
  /** random_get. Default: a splitmix stream from `seed`. */
  random?: (len: number) => Uint8Array | Promise<Uint8Array>;
  /**
   * A sleep (poll_oneoff on clocks). Default: returns at once — and, when
   * `clock` is not given either, moves the run's virtual clock to the
   * deadline, so a program that waits until a time has passed (QuickJS's
   * timers) sees it pass instead of spinning.
   */
  sleep?: (clocks: Array<{ timeout: bigint; absolute: boolean }>) => void | Promise<void>;
  /** Without `clock`: the time clock reads start at, in ms since the epoch (it moves only by sleeps). Default 0. */
  time?: number;
  /** Without `random`: seed for the stream. Default 0. */
  seed?: number;
  /** Cap on captured stdout / stderr and on any pipe, in bytes. Default 64 MiB. */
  limit?: number;
}

export interface ShellResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
  tree: CID;
}

// ---------------------------------------------------------------- programs

export interface Modules {
  brush: WebAssembly.Module;
  coreutils: WebAssembly.Module;
  /**
   * Single-purpose WASI programs beyond brush/coreutils, keyed by the command
   * name the shell runs them under (argv[0] is that name). See wasm/README.md
   * for what each one is built from.
   */
  extra?: Record<string, WebAssembly.Module>;
  /**
   * What an `extra` program needs besides its module, by command name: files
   * mounted read-only at `mount` for that program only (not part of the tree,
   * never committed), and environment defaults the caller's env overrides.
   * Python's stdlib zip is one (wasm/README.md, "python").
   */
  support?: Record<string, Support>;
}

export interface Support {
  /** Absolute path the files are mounted under (a preopen of the process). */
  mount: string;
  /** Path relative to `mount` -> bytes. */
  files: Record<string, Uint8Array>;
  env?: Record<string, string>;
}

/** A read-only directory tree holding `files`, outside the Vfs's root. */
function mountDir(vfs: Vfs, files: Record<string, Uint8Array>): DirNode {
  const root: DirNode = { kind: "dir", entries: new Map(), readonly: true, ino: vfs.descIno++ };
  for (const [path, data] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const parts = path.split("/").filter(Boolean);
    const name = parts.pop()!;
    let dir = root;
    for (const p of parts) {
      let next = dir.entries!.get(p);
      if (!next) { next = { kind: "dir", entries: new Map(), readonly: true, ino: vfs.descIno++, parent: dir }; dir.entries!.set(p, next); }
      if (next.kind !== "dir") throw new Error(`support file under a file: ${path}`);
      dir = next;
    }
    const f: FileNode = { kind: "file", exec: false, data, ino: vfs.descIno++, parent: dir };
    dir.entries!.set(name, f);
  }
  return root;
}

const SHELLS = new Set(["sh", "bash", "brush"]);
const coreutilsNames = new WeakMap<WebAssembly.Module, Promise<Set<string>>>();

/** The utilities a coreutils build contains, from its own `--list`. Pure: fixed clock, zero random. */
function utilities(coreutils: WebAssembly.Module): Promise<Set<string>> {
  let p = coreutilsNames.get(coreutils);
  if (!p) {
    p = (async () => {
      const out = new Pipe();
      const vfs = new Vfs(emptyBlocks, EMPTY_TREE);
      await runModule(coreutils, {
        vfs, args: ["coreutils", "--list"], env: [], stdio: [nullDesc(vfs), pipeDesc(vfs, out, "w"), nullDesc(vfs)],
        clock: () => 0n, random: (n) => new Uint8Array(n),
      });
      return new Set(Buffer.from(out.drain()).toString("utf8").split(/\s+/).filter(Boolean));
    })();
    coreutilsNames.set(coreutils, p);
  }
  return p;
}

/** The names the shell can run besides its builtins. */
export async function commands(modules: Modules): Promise<string[]> {
  return [...SHELLS, "coreutils", ...(await utilities(modules.coreutils)), ...Object.keys(modules.extra ?? {})].sort();
}

// The empty tree, for the one run that needs no filesystem.
const EMPTY = hashTree([]);
export const EMPTY_TREE = EMPTY.cid;
export const emptyBlocks: TreeBlocks = {
  bytes: async () => EMPTY.object,
  has: async () => true,
  putBlock: async () => {},
};

// ---------------------------------------------------------------- running a module

type RunOptions = ConstructorParameters<typeof Process>[0];

/**
 * Instantiate and run a WASI command to exit. `extend` adds import
 * namespaces (or functions in one) given the process, whose `memory` is set
 * before the module starts.
 */
export async function runModule(mod: WebAssembly.Module, o: RunOptions, extend?: (proc: Process) => Record<string, Record<string, unknown>>): Promise<number> {
  const proc = new Process(o);
  const imports = proc.imports();
  for (const [ns, fns] of Object.entries(extend?.(proc) ?? {})) imports[ns] = { ...(imports[ns] ?? {}), ...fns } as WebAssembly.ModuleImports;
  // Anything the module imports that we do not provide fails with ENOSYS rather than at link time.
  for (const imp of WebAssembly.Module.imports(mod)) {
    const ns = (imports[imp.module] ??= {}) as Record<string, unknown>;
    if (imp.kind === "function" && !(imp.name in ns)) ns[imp.name] = () => 52;
  }
  const inst = await WebAssembly.instantiate(mod, imports);
  proc.memory = inst.exports.memory as WebAssembly.Memory;
  const start = JSPI.promising(inst.exports._start as () => void);
  try {
    await start();
    return 0;
  } catch (e) {
    if (e instanceof ProcExit) return e.code;
    if (e instanceof WebAssembly.RuntimeError) {
      writeTo(o.stdio[2], `${o.args[0]}: trapped: ${e.message}\n`);
      return 134;
    }
    throw e;
  }
}

function writeTo(d: Desc, s: string): void {
  if (d.t === "pipe" && d.end === "w") d.pipe.write(Buffer.from(s));
}

/** splitmix32: a deterministic stream, for runs outside a thread (no attested seed). */
function prng(seed: number): (len: number) => Uint8Array {
  let s = seed >>> 0;
  return (len) => {
    const buf = new Uint8Array(len);
    for (let i = 0; i < buf.length; i++) {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      buf[i] = (z ^ (z >>> 16)) & 0xff;
    }
    return buf;
  };
}

// ---------------------------------------------------------------- the shell

/** A `#!` line's interpreter: its basename (through `env`, skipping `env -S`) and any arguments after it. */
function shebang(data: Uint8Array): { name: string; args: string[] } | undefined {
  const end = data.indexOf(0x0a);
  const words = Buffer.from(data.subarray(2, end < 0 ? Math.min(data.length, 256) : end)).toString("utf8").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return undefined;
  let [prog, ...rest] = words;
  if (prog.split("/").pop() === "env") {
    while (rest[0]?.startsWith("-")) rest.shift();
    [prog, ...rest] = rest;
    if (!prog) return undefined;
  }
  return { name: prog.split("/").pop()!, args: rest };
}

export async function runShell(blocks: TreeBlocks, o: ShellOptions): Promise<ShellResult> {
  const vfs = new Vfs(blocks, o.tree);
  const cwd = "/" + (o.cwd ?? "/").split("/").filter(Boolean).join("/");
  const at = await vfs.resolve(vfs.root, cwd, true).catch((e) => {
    if (e instanceof FsError) return undefined;
    throw e;
  });
  if (at?.kind !== "dir") throw new Error(`cwd is not a directory in the tree: ${cwd}`);

  const limit = o.limit ?? 64 << 20;
  const stdout = new Pipe(limit), stderr = new Pipe(limit);
  const stdin = new Pipe(Math.max(limit, o.stdin?.length ?? 0), o.stdin);
  let now = BigInt(o.time ?? 0) * 1_000_000n;
  const clock = o.clock ?? (() => now);
  const random = o.random ?? prng(o.seed ?? 0);
  const sleep = o.sleep ?? (o.clock ? undefined : (clocks: Array<{ timeout: bigint; absolute: boolean }>) => {
    const until = clocks.map((c) => (c.absolute ? c.timeout : now + c.timeout)).reduce((a, b) => (a < b ? a : b));
    if (until > now) now = until;
  });
  const { brush, coreutils, extra = {}, support = {} } = o.modules;
  const utils = await utilities(coreutils);
  const exists = (name: string) => SHELLS.has(name) || name === "coreutils" || utils.has(name) || name in extra;

  const envList = (env: Record<string, string>) => Object.entries(env).map(([k, v]) => `${k}=${v}`);

  const spawn = async (req: SpawnRequest): Promise<number | undefined> => {
    const env = [...req.env.filter((e) => !e.startsWith("PWD=")), `PWD=${req.cwd || "/"}`];
    let file: WebAssembly.Module, args: string[], name: string | undefined;
    if (!req.program.includes("/")) {
      if (SHELLS.has(req.program)) { file = brush; args = ["bash", "--disable-color", ...req.argv.slice(1)]; }
      else if (req.program === "coreutils") { file = coreutils; args = ["coreutils", ...req.argv.slice(1)]; }
      else if (utils.has(req.program)) { file = coreutils; args = [req.program, ...req.argv.slice(1)]; }
      else if (req.program in extra) { name = req.program; file = extra[name]; args = [name, ...req.argv.slice(1)]; }
      else return undefined;
    } else {
      // A path in the tree: a `#!` script. Its interpreter runs it when that
      // is an extra program (`#!/usr/bin/env python3`, `#!/usr/bin/node`);
      // anything else runs under the shell. Nothing else is executable.
      const node = await vfs.resolve(vfs.root, req.program.startsWith("/") ? req.program : `${req.cwd}/${req.program}`, true).catch(() => undefined);
      if (!node) return undefined;
      const data = node.kind === "file" ? await vfs.data(node) : undefined;
      if (!data || data[0] !== 0x23 || data[1] !== 0x21) {
        writeTo(req.stdio[2], `${req.argv[0]}: cannot execute: only #! scripts run from the tree\n`);
        return 126;
      }
      const interp = shebang(data);
      if (interp && interp.name in extra && !SHELLS.has(interp.name)) {
        name = interp.name;
        file = extra[name];
        args = [name, ...interp.args, req.program, ...req.argv.slice(1)];
      } else {
        file = brush;
        args = ["bash", "--disable-color", req.program, ...req.argv.slice(1)];
      }
    }
    const sup = name === undefined ? undefined : support[name];
    if (sup?.env) for (const [k, v] of Object.entries(sup.env)) if (!env.some((e) => e.startsWith(`${k}=`))) env.push(`${k}=${v}`);
    const mounts = sup ? [{ path: sup.mount, dir: mountDir(vfs, sup.files) }] : undefined;
    return runModule(file, { vfs, args, env, stdio: req.stdio, clock, random, sleep, spawn, commandExists: exists, mounts });
  };

  const env = { HOME: "/", PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", USER: "skein", ...o.env, PWD: cwd };
  const exitCode = await runModule(brush, {
    vfs,
    args: ["bash", "--disable-color", "-c", o.cmd],
    env: envList(env),
    stdio: [pipeDesc(vfs, stdin, "r"), pipeDesc(vfs, stdout, "w"), pipeDesc(vfs, stderr, "w")],
    clock, random, sleep, spawn, commandExists: exists,
  });
  return { exitCode, stdout: stdout.drain(), stderr: stderr.drain(), tree: await vfs.commit() };
}

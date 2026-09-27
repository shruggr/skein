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
import { Vfs, FsError } from "./wasi/vfs.ts";
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
  /** A sleep (poll_oneoff on clocks). Default: returns at once. */
  sleep?: (clocks: Array<{ timeout: bigint; absolute: boolean }>) => void | Promise<void>;
  /** Without `clock`: the time every clock read returns, in ms since the epoch. Default 0. */
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
  return [...SHELLS, "coreutils", ...(await utilities(modules.coreutils))].sort();
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
  const fixed = BigInt(o.time ?? 0) * 1_000_000n;
  const clock = o.clock ?? (() => fixed);
  const random = o.random ?? prng(o.seed ?? 0);
  const sleep = o.sleep;
  const { brush, coreutils } = o.modules;
  const utils = await utilities(coreutils);
  const exists = (name: string) => SHELLS.has(name) || name === "coreutils" || utils.has(name);

  const envList = (env: Record<string, string>) => Object.entries(env).map(([k, v]) => `${k}=${v}`);

  const spawn = async (req: SpawnRequest): Promise<number | undefined> => {
    const env = [...req.env.filter((e) => !e.startsWith("PWD=")), `PWD=${req.cwd || "/"}`];
    let file: WebAssembly.Module, args: string[];
    if (!req.program.includes("/")) {
      if (SHELLS.has(req.program)) { file = brush; args = ["bash", "--disable-color", ...req.argv.slice(1)]; }
      else if (req.program === "coreutils") { file = coreutils; args = ["coreutils", ...req.argv.slice(1)]; }
      else if (utils.has(req.program)) { file = coreutils; args = [req.program, ...req.argv.slice(1)]; }
      else return undefined;
    } else {
      // A path in the tree: scripts run under the shell; nothing else is executable.
      const node = await vfs.resolve(vfs.root, req.program.startsWith("/") ? req.program : `${req.cwd}/${req.program}`, true).catch(() => undefined);
      if (!node) return undefined;
      const head = node.kind === "file" ? (await vfs.data(node)).subarray(0, 2) : undefined;
      if (!head || head[0] !== 0x23 || head[1] !== 0x21) {
        writeTo(req.stdio[2], `${req.argv[0]}: cannot execute: only shell scripts run from the tree\n`);
        return 126;
      }
      file = brush;
      args = ["bash", "--disable-color", req.program, ...req.argv.slice(1)];
    }
    return runModule(file, { vfs, args, env, stdio: req.stdio, clock, random, sleep, spawn, commandExists: exists });
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

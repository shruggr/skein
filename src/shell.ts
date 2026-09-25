// The wasm shell: brush (bash-compatible, WASI) running uutils coreutils (WASI),
// all over a copy-on-write view of a git-shaped tree. Nothing reaches the host:
// the tree is the whole filesystem, time is an input, randomness is seeded,
// and the result is a new root tree CID plus captured output.
//
// Process model: brush is patched (wasm/README.md) to ask the host to run
// external commands through the "skein" import module. The host runs each one
// to completion as a fresh WASI instance sharing the same filesystem view, so
// pipelines execute stage by stage with in-memory pipes between them.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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
  /** The attested time every clock read returns, in ms since the epoch. Default 0. */
  time?: number;
  /** Seed for random_get (and so $RANDOM, hash seeds). Default 0. */
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

const WASM_DIR = fileURLToPath(new URL("../wasm/", import.meta.url));
const modules = new Map<string, Promise<WebAssembly.Module>>();

function module(file: string): Promise<WebAssembly.Module> {
  let m = modules.get(file);
  if (!m) {
    m = readFile(WASM_DIR + file).then((b) => WebAssembly.compile(b));
    modules.set(file, m);
  }
  return m;
}

const SHELLS = new Set(["sh", "bash", "brush"]);
let coreutilsNames: Promise<Set<string>> | undefined;

/** The utilities the coreutils build contains, from its own `--list`. */
async function utilities(): Promise<Set<string>> {
  coreutilsNames ??= (async () => {
    const out = new Pipe();
    const vfs = new Vfs(emptyBlocks, EMPTY_TREE);
    await runModule(await module("coreutils.wasm"), {
      vfs, args: ["coreutils", "--list"], env: [], stdio: [nullDesc(), pipeDesc(out, "w"), nullDesc()],
      time: 0n, random: (b) => b.fill(0),
    });
    return new Set(Buffer.from(out.drain()).toString("utf8").split(/\s+/).filter(Boolean));
  })();
  return coreutilsNames;
}

/** The names the shell can run besides its builtins. */
export async function commands(): Promise<string[]> {
  return [...SHELLS, "coreutils", ...(await utilities())].sort();
}

// The empty tree, for the one run that needs no filesystem.
const EMPTY = hashTree([]);
const EMPTY_TREE = EMPTY.cid;
const emptyBlocks: TreeBlocks = {
  bytes: async () => EMPTY.object,
  has: async () => true,
  putBlock: async () => {},
};

// ---------------------------------------------------------------- running a module

type RunOptions = ConstructorParameters<typeof Process>[0];

async function runModule(mod: WebAssembly.Module, o: RunOptions): Promise<number> {
  const proc = new Process(o);
  const imports = proc.imports();
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

/** splitmix32: a deterministic stream for random_get. */
function prng(seed: number): (buf: Uint8Array) => void {
  let s = seed >>> 0;
  return (buf) => {
    for (let i = 0; i < buf.length; i++) {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      buf[i] = (z ^ (z >>> 16)) & 0xff;
    }
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
  const time = BigInt(o.time ?? 0) * 1_000_000n;
  const random = prng(o.seed ?? 0);
  const [brush, utils] = await Promise.all([module("brush.wasm"), utilities()]);
  const exists = (name: string) => SHELLS.has(name) || name === "coreutils" || utils.has(name);

  const envList = (env: Record<string, string>) => Object.entries(env).map(([k, v]) => `${k}=${v}`);

  const spawn = async (req: SpawnRequest): Promise<number | undefined> => {
    const env = [...req.env.filter((e) => !e.startsWith("PWD=")), `PWD=${req.cwd || "/"}`];
    let file: string, args: string[];
    if (!req.program.includes("/")) {
      if (SHELLS.has(req.program)) { file = "brush.wasm"; args = ["bash", "--disable-color", ...req.argv.slice(1)]; }
      else if (req.program === "coreutils") { file = "coreutils.wasm"; args = ["coreutils", ...req.argv.slice(1)]; }
      else if (utils.has(req.program)) { file = "coreutils.wasm"; args = [req.program, ...req.argv.slice(1)]; }
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
      file = "brush.wasm";
      args = ["bash", "--disable-color", req.program, ...req.argv.slice(1)];
    }
    return runModule(await module(file), { vfs, args, env, stdio: req.stdio, time, random, spawn, commandExists: exists });
  };

  const env = { HOME: "/", PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", USER: "skein", ...o.env, PWD: cwd };
  const exitCode = await runModule(brush, {
    vfs,
    args: ["bash", "--disable-color", "-c", o.cmd],
    env: envList(env),
    stdio: [pipeDesc(stdin, "r"), pipeDesc(stdout, "w"), pipeDesc(stderr, "w")],
    time, random, spawn, commandExists: exists,
  });
  return { exitCode, stdout: stdout.drain(), stderr: stderr.drain(), tree: await vfs.commit() };
}

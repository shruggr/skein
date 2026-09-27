// Running a handler program: a plain WASI command with the `skein` import
// namespace (wasi/skein-imports.ts), stepped by the scheduler. One run is one
// step: it runs to completion over one input. It sees no filesystem (an empty
// tree), stdout/stderr are captured, and its clock and random are the thread's
// (syscalls.ts), so a step is a pure function of its input and the answers
// to its attested calls.

import { Pipe, nullDesc, pipeDesc } from "./wasi/host.ts";
import { Vfs } from "./wasi/vfs.ts";
import { emptyBlocks, EMPTY_TREE, runModule } from "./shell.ts";
import { skeinImports, type ProgramHost } from "./wasi/skein-imports.ts";

export interface StepOutput {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export async function runProgram(mod: WebAssembly.Module, host: ProgramHost, o: {
  name: string;
  clock: (id: number) => bigint | Promise<bigint>;
  random: (len: number) => Uint8Array | Promise<Uint8Array>;
  limit?: number;
}): Promise<StepOutput> {
  const limit = o.limit ?? 1 << 20;
  const stdout = new Pipe(limit), stderr = new Pipe(limit);
  const vfs = new Vfs(emptyBlocks, EMPTY_TREE);
  const exitCode = await runModule(mod, {
    vfs,
    args: [o.name],
    env: [],
    stdio: [nullDesc(vfs), pipeDesc(vfs, stdout, "w"), pipeDesc(vfs, stderr, "w")],
    clock: o.clock,
    random: o.random,
  }, (proc) => ({ skein: skeinImports(proc, host) }));
  return { exitCode, stdout: stdout.drain(), stderr: stderr.drain() };
}

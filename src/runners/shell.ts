// shell: one process. The node's request is the spec; stdout/stderr become
// coalesced `text` emissions; the exit becomes a `conclusion`. A non-zero
// exit is a finished result — the command answered. Only spawn failure,
// timeout, or losing the process is errored (blew-up).

import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { CID } from "multiformats/cid";
import type { ThreadOrigin } from "../types.ts";
import type { Runner, RunnerContext, Status } from "./types.ts";
import { openNode } from "./util.ts";

export interface ShellSpec { cmd: string; cwd?: string; timeoutMs?: number }

export interface ShellOptions {
  maxConcurrent?: number;
  flushMs?: number;    // coalesce output chunks for this long…
  flushBytes?: number; // …or until this much is buffered
  killGraceMs?: number;
}

interface Run {
  child: ChildProcess;
  node: CID;
  writes: Promise<unknown>; // emissions in order, conclusion last
  ended: boolean;
  code?: number | null;
  signal?: string | null;
  failure?: string;
}

export function shellRunner(opts: ShellOptions = {}): Runner {
  const max = opts.maxConcurrent ?? 8;
  const flushMs = opts.flushMs ?? 200;
  const flushBytes = opts.flushBytes ?? 8192;
  const grace = opts.killGraceMs ?? 2000;
  const runs = new Map<string, Run>();

  return {
    kind: "shell",

    async start(thread, ctx) {
      if (runs.has(thread.toString())) return;
      if ([...runs.values()].filter((r) => !r.ended).length >= max) return; // refuse: offered again next pass
      const spec = (await ctx.store.get<ThreadOrigin>(thread)).spec as ShellSpec;
      if (typeof spec?.cmd !== "string") {
        return ctx.update(thread, { state: "errored", error: { kind: "cant-do", message: "shell spec needs cmd" } });
      }
      const node = await openNode(ctx.store, { thread, prev: [], request: spec });
      // running is recorded before spawning: a crash in between reads as lost, never as a silent double run.
      await ctx.update(thread, { state: "running" });
      launch(thread, node, spec, ctx);
      const run = runs.get(thread.toString())!;
      if (run.child.pid !== undefined) await ctx.store.live.handles.set(thread, { pid: run.child.pid, startedAt: Date.now(), node: node.toString() });
    },

    async check(thread, ctx) {
      const k = thread.toString();
      const run = runs.get(k);
      if (run) {
        if (!run.ended) return { state: "running" };
        await run.writes;
        runs.delete(k);
        await ctx.store.live.handles.clear(thread);
        if (run.failure) return { state: "errored", error: { kind: "blew-up", message: run.failure } };
        return { state: "finished", resolution: run.node, note: run.signal ? `signal ${run.signal}` : `exit ${run.code}` };
      }
      // Not ours in this process: started before a restart, or crashed.
      const h = await ctx.store.live.handles.get(thread);
      if (h && typeof h.pid === "number" && alive(h.pid)) return { state: "running" }; // orphan still going; its exit is unobservable
      await ctx.store.live.handles.clear(thread);
      if (typeof h?.node === "string") await ctx.rest(CID.parse(h.node), { state: "errored" });
      return { state: "errored", error: { kind: "blew-up", message: h ? `lost: pid ${h.pid} gone with no exit recorded` : "lost: no handle" } };
    },
  };

  function launch(thread: CID, node: CID, spec: ShellSpec, ctx: RunnerContext) {
    // Own process group so a timeout kills the whole pipeline, not just sh.
    const child = spawn("/bin/sh", ["-c", spec.cmd], { cwd: spec.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const run: Run = { child, node, writes: Promise.resolve(), ended: false };
    runs.set(thread.toString(), run);
    const write = (fn: () => Promise<unknown>) => { run.writes = run.writes.then(fn).catch((e) => ctx.log(`shell ${thread}: write failed: ${e}`)); };

    let buf = "", stream = "stdout", timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      clearTimeout(timer); timer = undefined;
      if (!buf) return;
      const text = buf, s = stream;
      buf = "";
      write(() => ctx.emit(node, { type: "text", text, stream: s }));
    };
    const onData = (s: string, dec: StringDecoder) => (chunk: Buffer) => {
      if (s !== stream) flush();
      stream = s;
      buf += dec.write(chunk);
      if (buf.length >= flushBytes) flush();
      else timer ??= setTimeout(flush, flushMs);
    };
    const outDec = new StringDecoder("utf8"), errDec = new StringDecoder("utf8");
    child.stdout!.on("data", onData("stdout", outDec));
    child.stderr!.on("data", onData("stderr", errDec));

    let killer: ReturnType<typeof setTimeout> | undefined;
    const timeout = spec.timeoutMs ? setTimeout(() => {
      run.failure = `timeout after ${spec.timeoutMs}ms`;
      kill(child, "SIGTERM");
      killer = setTimeout(() => kill(child, "SIGKILL"), grace);
    }, spec.timeoutMs) : undefined;

    const finish = (code: number | null, signal: string | null) => {
      if (run.ended) return;
      clearTimeout(timeout); clearTimeout(killer);
      buf += outDec.end() + errDec.end();
      flush();
      run.code = code; run.signal = signal;
      const text = run.failure ?? (signal ? `killed by ${signal}` : `exit ${code}`);
      write(() => ctx.emit(node, { type: "conclusion", text, exitCode: code, signal }));
      write(() => ctx.rest(node, { state: run.failure ? "errored" : "finished" }));
      run.ended = true;
      write(async () => ctx.wake(thread));
    };
    child.on("error", (e) => { run.failure ??= `spawn failed: ${e.message}`; if (child.pid === undefined) finish(null, null); });
    child.on("close", finish);
  }
}

function kill(child: ChildProcess, sig: NodeJS.Signals) {
  try { process.kill(-child.pid!, sig); } catch { child.kill(sig); }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

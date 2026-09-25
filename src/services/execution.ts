// execution: runs commands for the instance.
//
//   request  { kind: "run", cmd, tree?: CID, cwd?: string, timeoutMs?: number }
//   reply    { kind: "ran", exitCode, signal?, stdout, stderr, truncated?, tree?, error?, ms }
//            or { kind: "failed", error } (malformed request, lost on restart)
//
// With a tree: the tree is materialized into a fresh $SKEIN_HOME/work/<request
// cid>, the command runs there (cwd relative to it), and the directory is
// scanned back into a tree afterwards — the reply's `tree` is the new state,
// so file edits are in the graph as a tree before anything else sees them.
// The directory is removed after the scan.
// Without a tree: the command runs in place in `cwd` (absolute) or $SKEIN_CWD
// (default: home), as v1 did, and the reply has no tree — the host filesystem
// isn't a record.
//
// TODO(sandbox): VM.md makes the host responsible for isolation, and nothing
// here provides it yet: the command runs as this user with the host's network,
// filesystem and environment. Before this runs anything a model wrote
// unattended it needs a container per request (the materialized tree as its
// only writable mount, no host home, network off unless the request's program
// declares it) and limits (CPU time, memory, pids, disk), with limit hits
// reported in the reply like the timeout is.

import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { CID } from "multiformats/cid";
import { fmt, isCID } from "../cid.ts";
import { materialize, scan } from "../tree.ts";
import { skeinHome, workDir } from "../env.ts";
import { failed, type HostCtx, type Request, type Service, type ServiceCtx } from "./types.ts";

export interface ExecutionOptions {
  home?: string;        // default $SKEIN_HOME
  cwd?: string;         // tree-less default; default $SKEIN_CWD or home
  timeoutMs?: number;   // default 300 s; a request may ask for less or more
  maxOutput?: number;   // bytes kept per stream; default 256 KiB
  killGraceMs?: number;
  keepWork?: boolean;   // leave work dirs behind (debugging)
}

export function executionService(opts: ExecutionOptions = {}): Service {
  const cap = opts.maxOutput ?? 256 * 1024;
  const grace = opts.killGraceMs ?? 2000;
  const running = new Set<string>();

  const service: Service = {
    name: "execution",

    async handle(req, ctx) {
      const k = fmt(req.cid);
      if (running.has(k)) return;
      const b = req.msg.body as { kind?: unknown; cmd?: unknown; tree?: unknown; cwd?: unknown; timeoutMs?: unknown } | null;
      if (b?.kind !== "run" || typeof b.cmd !== "string" || !b.cmd) {
        await ctx.reply(failed("cant-do", "execution: expected {kind: \"run\", cmd}"));
        return;
      }
      if (b.tree !== undefined && !isCID(b.tree)) { await ctx.reply(failed("cant-do", "execution: tree must be a CID")); return; }
      running.add(k);
      try {
        await run(req, ctx, b.cmd, b.tree as CID | undefined, typeof b.cwd === "string" ? b.cwd : undefined,
          typeof b.timeoutMs === "number" ? b.timeoutMs : opts.timeoutMs ?? 300_000);
      } finally {
        running.delete(k);
      }
    },

    async recover(ctx: HostCtx) {
      for await (const req of ctx.pending()) {
        if (running.has(fmt(req.cid))) continue;
        const h = await ctx.store.live.handles.get(req.cid);
        if (h) {
          // Started by a previous process: its exit is unobservable now.
          if (typeof h.pid === "number") kill(h.pid, "SIGKILL");
          await ctx.store.live.handles.clear(req.cid);
          await ctx.replyTo(req, failed("blew-up", `lost: pid ${h.pid} was running when the host restarted`));
        } else {
          ctx.redeliver(req);
        }
      }
    },
  };
  return service;

  async function run(req: Request, ctx: ServiceCtx, cmd: string, tree: CID | undefined, cwd: string | undefined, timeoutMs: number) {
    const t0 = Date.now();
    const work = tree ? join(opts.home ?? skeinHome(), "work", fmt(req.cid)) : undefined;
    let dir: string;
    if (work) {
      await rm(work, { recursive: true, force: true });
      await mkdir(work, { recursive: true });
      await materialize(ctx.store, tree!, work);
      dir = resolve(work, cwd ?? ".");
      const rel = relative(work, dir);
      if (rel.startsWith("..") || isAbsolute(rel)) { await ctx.reply(failed("cant-do", `cwd ${cwd} is outside the tree`)); return; }
      await mkdir(dir, { recursive: true });
    } else {
      dir = cwd && isAbsolute(cwd) ? cwd : resolve(opts.cwd ?? workDir(), cwd ?? ".");
    }

    // Own process group so a timeout kills the whole pipeline, not just bash.
    const child = spawn("bash", ["-c", cmd], { cwd: dir, stdio: ["ignore", "pipe", "pipe"], detached: true });
    if (child.pid !== undefined) await ctx.store.live.handles.set(req.cid, { pid: child.pid, startedAt: t0, dir });
    const out = capture(child.stdout!), err = capture(child.stderr!);
    let error: string | undefined;
    let killer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      error = `timeout after ${timeoutMs}ms`;
      kill(child.pid, "SIGTERM");
      killer = setTimeout(() => kill(child.pid, "SIGKILL"), grace);
    }, timeoutMs);
    const { code, signal } = await new Promise<{ code: number | null; signal: string | null }>((res) => {
      child.on("error", (e) => { error ??= `spawn failed: ${e.message}`; if (child.pid === undefined) res({ code: null, signal: null }); });
      child.on("close", (code, signal) => res({ code, signal }));
    });
    clearTimeout(timer); clearTimeout(killer);

    let next: CID | undefined;
    if (work) {
      next = await scan(ctx.store, work);
      if (!opts.keepWork) await rm(work, { recursive: true, force: true });
    }
    const o = out.done(), e = err.done();
    const truncated = o.dropped || e.dropped ? { ...(o.dropped ? { stdout: o.dropped } : {}), ...(e.dropped ? { stderr: e.dropped } : {}) } : undefined;
    await ctx.reply({
      kind: "ran", exitCode: code, ...(signal ? { signal } : {}), stdout: o.text, stderr: e.text,
      ...(truncated ? { truncated } : {}), ...(next ? { tree: next } : {}), ...(error ? { error } : {}), ms: Date.now() - t0,
    });
    await ctx.store.live.handles.clear(req.cid);
  }

  function capture(stream: NodeJS.ReadableStream) {
    const dec = new StringDecoder("utf8");
    let text = "", kept = 0, dropped = 0;
    stream.on("data", (chunk: Buffer) => {
      const room = cap - kept;
      if (room > 0) { const part = chunk.subarray(0, room); text += dec.write(part); kept += part.length; }
      dropped += Math.max(0, chunk.length - Math.max(room, 0));
    });
    return {
      done: () => {
        const t = text + dec.end();
        return { text: dropped ? `${t}\n…[${dropped} bytes truncated]` : t, dropped };
      },
    };
  }
}

function kill(pid: number | undefined, sig: NodeJS.Signals) {
  if (pid === undefined) return;
  try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch { /* gone */ } }
}


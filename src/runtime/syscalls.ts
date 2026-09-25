// The binding table: which WASI syscalls are answered inside (pure) and which
// leave the runtime (attested) and to which peer identity (docs/ARCH.md, "The
// kernel"). Pure syscalls are deterministic functions of the thread's own
// state and are never recorded. An attested syscall is one message out and one
// signed message back, bound to the state that asked; the reply is in the log,
// so replay answers it from there.
//
// The table in code is the default. An admin message
//   { kind: "bind", syscall, to: <identity> }
// overrides one entry from its place in the log on; a thread uses the table as
// of the log entry that launched it, so replay uses the binding the original
// run used. Genesis writes the defaults as bind messages too, so an instance's
// log states its own configuration.
//
// Attested syscalls today:
//
//   clock_time_get (CLOCK_REALTIME)  one request per call:
//       out  { kind: "time", state: <log entry> }
//       back { kind: "time", time: <ms since epoch>, state } + replies-to
//   random_get  one request per *thread*, then a local stream:
//       out  { kind: "random", state }
//       back { kind: "random", seed: <32 bytes>, state } + replies-to
//     Why per thread: Rust's std calls random_get at every process start to
//     seed HashMap's RandomState, and brush spawns a process per external
//     command, so a message per call would be a round trip per `ls`. One
//     attested 32-byte seed per thread feeds a SHA-256 counter stream
//     (`seedStream`); every later read in that thread, in any of its
//     processes, draws from it. The stream is a pure function of the seed and
//     the read order, which is deterministic, so replay reproduces it.
//
// Pure, by decision: CLOCK_MONOTONIC / PROCESS / THREAD read a per-thread
// counter that advances 1 ms per read (Rust's Instant::now is monotonic and
// is called freely; only wall-clock time needs a witness). poll_oneoff sleeps
// return at once. Everything else in preview1 — files, pipes, stdio, spawn,
// args, env — is answered from the tree and the thread's own state.

import { createHash } from "node:crypto";
import type { CID } from "multiformats/cid";
import { isCID } from "./cid.ts";
import { isIdentity, type Identity, type Message } from "./records.ts";

/** WASI clock ids. */
export const CLOCK = { REALTIME: 0, MONOTONIC: 1, PROCESS_CPUTIME: 2, THREAD_CPUTIME: 3 } as const;

/** Syscalls that can be bound. "clock_time_get" is CLOCK_REALTIME; the other clocks are "clock_time_get:monotonic". */
export type Syscall = "clock_time_get" | "clock_time_get:monotonic" | "random_get";
export const SYSCALLS: readonly Syscall[] = ["clock_time_get", "clock_time_get:monotonic", "random_get"];

export type Binding =
  | { kind: "pure" }
  | { kind: "peer"; to: Identity }
  // TODO: a mock is a binding to a bundle of recorded replies. Read side only: a thread bound to one errors.
  | { kind: "bundle"; bundle: CID };

/** The defaults, by name: "pure", or a peer by the wallet keyID its identity derives from. */
export const DEFAULT_BINDINGS: Record<Syscall, "pure" | { peer: string }> = {
  "clock_time_get": { peer: "clock" },
  "clock_time_get:monotonic": "pure",
  "random_get": { peer: "clock" },
};

/** The rest of wasi_snapshot_preview1 that host.ts implements: always pure, not rebindable. */
export const PURE_SYSCALLS = [
  "args_get", "args_sizes_get", "environ_get", "environ_sizes_get", "clock_res_get", "poll_oneoff", "sched_yield",
  "proc_exit", "proc_raise", "fd_*", "path_*", "sock_* (ENOTSUP)", "skein.spawn", "skein.pipe", "skein.cmd_exists",
] as const;

export type Bind = { kind: "bind"; syscall: Syscall; to: Identity | "pure" | { bundle: CID } };

export function isBind(x: unknown): x is Bind {
  const b = x as Partial<Bind> | null;
  if (!b || typeof b !== "object" || b.kind !== "bind" || !SYSCALLS.includes(b.syscall as Syscall)) return false;
  const to = b.to as unknown;
  return to === "pure" || isIdentity(to) || (typeof to === "object" && to !== null && isCID((to as { bundle?: unknown }).bundle));
}

function toBinding(to: Bind["to"]): Binding {
  if (to === "pure") return { kind: "pure" };
  if (typeof to === "string") return { kind: "peer", to };
  return { kind: "bundle", bundle: to.bundle };
}

/** The table over the log: defaults, then admin binds in log order. */
export class Bindings {
  private readonly defaults: Record<Syscall, Binding>;
  private readonly overrides: Array<{ n: number; syscall: Syscall; binding: Binding }> = [];

  constructor(peers: Record<string, Identity>) {
    const d = {} as Record<Syscall, Binding>;
    for (const s of SYSCALLS) {
      const v = DEFAULT_BINDINGS[s];
      if (v === "pure") d[s] = { kind: "pure" };
      else {
        const to = peers[v.peer];
        if (!to) throw new Error(`default binding for ${s}: no identity for peer "${v.peer}"`);
        d[s] = { kind: "peer", to };
      }
    }
    this.defaults = d;
  }

  /** Apply an admin bind at log position n. Positions must arrive in order. */
  apply(n: number, b: Bind): void {
    this.overrides.push({ n, syscall: b.syscall, binding: toBinding(b.to) });
  }

  /** The binding for `syscall` as of log position n (inclusive). */
  at(n: number, syscall: Syscall): Binding {
    let out = this.defaults[syscall];
    for (const o of this.overrides) {
      if (o.n > n) break;
      if (o.syscall === syscall) out = o.binding;
    }
    return out;
  }
}

// ---------------------------------------------------------------- message bodies

export type TimeRequest = { kind: "time"; state: CID };
export type TimeReply = { kind: "time"; time: number; state: CID };
export type RandomRequest = { kind: "random"; state: CID };
export type RandomReply = { kind: "random"; seed: Uint8Array; state: CID };
export type Request = TimeRequest | RandomRequest;

/** Is `reply` a valid answer to `request`? Same kind, from the identity asked, bound to the same state. */
export function answers(request: Message, reply: Message): boolean {
  const q = request.body as Request, a = reply.body as Record<string, unknown> | null;
  if (!a || typeof a !== "object" || reply.from !== request.to || a.kind !== q.kind) return false;
  if (!isCID(a.state) || !a.state.equals(q.state)) return false;
  if (q.kind === "time") return typeof a.time === "number" && Number.isSafeInteger(a.time) && a.time >= 0;
  return a.seed instanceof Uint8Array && a.seed.length >= 32;
}

// ---------------------------------------------------------------- the random stream

/** A deterministic byte stream from a seed: SHA-256(seed ‖ counter as u64 BE), block after block. */
export function seedStream(seed: Uint8Array): (len: number) => Uint8Array {
  let counter = 0n;
  let buf = new Uint8Array(0);
  let off = 0;
  return (len) => {
    const out = new Uint8Array(len);
    let i = 0;
    while (i < len) {
      if (off === buf.length) {
        const c = new Uint8Array(8);
        new DataView(c.buffer).setBigUint64(0, counter++);
        buf = new Uint8Array(createHash("sha256").update(seed).update(c).digest());
        off = 0;
      }
      const take = Math.min(len - i, buf.length - off);
      out.set(buf.subarray(off, off + take), i);
      i += take;
      off += take;
    }
    return out;
  };
}

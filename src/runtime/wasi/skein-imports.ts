// The `skein` import namespace for handler programs: the machine's syscalls
// beyond WASI (docs/ARCH.md, "The kernel"). Pure ones (input, get, put,
// putblock, keep, launch, await, head, advance) are answered from the store and the thread; the
// attested ones (wallet, emit's seal) leave through the runtime and are recorded,
// and on replay are served from the record (runtime/program.ts).
//
// ABI. Pointers and lengths are i32; CIDs are binary. Every import that
// returns bytes has the shape  f(…, out_ptr, out_cap) → n : n >= 0 is the full
// length, written only if n <= out_cap; otherwise the result is held and
// `take(out_ptr, out_cap)` copies it without repeating the call. n < 0 is an
// error, and `error(out_ptr, out_cap)` returns its message.
//
//   input(out, cap) → n                       the step's input record (dag-cbor)
//   get(cid, cid_len, out, cap) → n            a record's bytes
//   put(data, len, out, cap) → n               store dag-cbor (re-encoded canonically); → its CID
//   putblock(cid, cid_len, data, len) → 0      store bytes under a CID minted elsewhere; the hash is checked
//   keep(cid, cid_len) → 0                     keep a stored record in the thread's state: listed in this
//                                              step's update (`kept`), so later steps find it from `tip`
//   launch(prog, prog_len, args, args_len, out, cap) → n   open a thread; → its origin CID
//   emit(cid, cid_len, out, cap) → n           sign an outbound envelope named by an emit record (attested:
//                                              the instance wallet signs it now); → the envelope record's CID. Sent when the step ends.
//   await(cid, cid_len) → 0                    rest on a reply to an envelope this step emitted: the step ends
//                                              `waiting` with `awaits`, and an admitted envelope whose body's
//                                              `replyTo` is that CID is this thread's next input
//   head(name, name_len, out, cap) → n         the tree CID a named head points at; n = 0 if it has none (docs/VM.md "Heads")
//   advance(name, name_len, tree, tree_len) → 0   move a named head to a tree in the store, when the step
//                                              ends without error
//   wallet(frame, len, out, cap) → n           a BRC-100 wallet wire request frame → result frame (attested)
//   take(out, cap) → n                         the held result of the last call
//   error(out, cap) → n                        the last error's message

import { CID } from "multiformats/cid";
import { JSPI, type Process } from "./host.ts";

export interface ProgramHost {
  input(): Uint8Array;
  get(cid: CID): Promise<Uint8Array>;
  put(bytes: Uint8Array): Promise<CID>;
  putBlock(cid: CID, bytes: Uint8Array): Promise<void>;
  keep(cid: CID): Promise<void>;
  launch(program: CID, args: CID): Promise<CID>;
  emit(cid: CID): Promise<CID>;
  awaitReply(envelope: CID): Promise<void>;
  head(name: string): Promise<CID | undefined>;
  advance(name: string, tree: CID): Promise<void>;
  wallet(frame: Uint8Array): Promise<Uint8Array>;
  /** Errors that must end the run rather than be returned to the program (the runtime stopping, a replay diverging). */
  fatal?(e: unknown): boolean;
}

export function skeinImports(proc: Process, host: ProgramHost): Record<string, unknown> {
  let held: Uint8Array = new Uint8Array(0);
  let lastError = "";
  const u8 = () => new Uint8Array(proc.memory.buffer);
  const bytes = (p: number, n: number) => u8().slice(p, p + n);
  const cid = (p: number, n: number) => CID.decode(bytes(p, n));
  const str = (p: number, n: number) => Buffer.from(bytes(p, n)).toString("utf8");

  /** Write `r` to (out, cap) if it fits; hold it either way; return its length. */
  const out = (r: Uint8Array, p: number, cap: number) => {
    held = r;
    if (r.length <= cap) u8().set(r, p); // memory may have grown during an await: take a fresh view
    return r.length;
  };
  const fail = (e: unknown): number => {
    if (host.fatal?.(e)) throw e;
    lastError = e instanceof Error ? e.message : String(e);
    return -1;
  };
  const sync = (f: () => number) => () => { try { return f(); } catch (e) { return fail(e); } };
  const async = <A extends number[]>(f: (...a: A) => Promise<number>) =>
    new JSPI.Suspending(async (...a: A) => { try { return await f(...a); } catch (e) { return fail(e); } });

  return {
    input: (p: number, cap: number) => sync(() => out(host.input(), p, cap))(),
    get: async(async (c: number, cl: number, p: number, cap: number) => out(await host.get(cid(c, cl)), p, cap)),
    put: async(async (d: number, dl: number, p: number, cap: number) => out((await host.put(bytes(d, dl))).bytes, p, cap)),
    putblock: async(async (c: number, cl: number, d: number, dl: number) => { await host.putBlock(cid(c, cl), bytes(d, dl)); return 0; }),
    keep: async(async (c: number, cl: number) => { await host.keep(cid(c, cl)); return 0; }),
    launch: async(async (pp: number, pl: number, ap: number, al: number, p: number, cap: number) =>
      out((await host.launch(cid(pp, pl), cid(ap, al))).bytes, p, cap)),
    emit: async(async (c: number, cl: number, p: number, cap: number) => out((await host.emit(cid(c, cl))).bytes, p, cap)),
    await: async(async (c: number, cl: number) => { await host.awaitReply(cid(c, cl)); return 0; }),
    head: async(async (n: number, nl: number, p: number, cap: number) => out((await host.head(str(n, nl)))?.bytes ?? new Uint8Array(0), p, cap)),
    advance: async(async (n: number, nl: number, c: number, cl: number) => { await host.advance(str(n, nl), cid(c, cl)); return 0; }),
    wallet: async(async (f: number, fl: number, p: number, cap: number) => out(await host.wallet(bytes(f, fl)), p, cap)),
    take: (p: number, cap: number) => sync(() => { if (held.length > cap) throw new Error("take: buffer too small"); u8().set(held, p); return held.length; })(),
    error: (p: number, cap: number) => {
      const b = Buffer.from(lastError, "utf8");
      u8().set(b.subarray(0, cap), p);
      return b.length;
    },
  };
}

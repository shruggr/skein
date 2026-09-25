// Time and randomness inside the machine (docs/ARCH.md, "Time and
// randomness"). Both are pure: they derive from the log entry a thread is
// currently being driven by (its `input`), so replay reproduces them exactly
// and nothing ever leaves the runtime to ask.
//
// Time. When the runtime admits an input it stamps the log entry with its own
// clock reading (log.ts; `time: [sec, nsec]`). clock_time_get, for every clock
// id (realtime, monotonic, process, thread), returns a per-thread Lamport
// clock: the first read returns the entry's stamp; each later read returns
// max(stamp of the current entry, last value + 1 ns). So two reads in a row
// differ by exactly 1 ns, time never runs backwards, and a thread driven by a
// later entry jumps forward to that entry's stamp.
//
// Sleep. poll_oneoff with a clock subscription whose deadline is not after
// "now" returns at once; otherwise the thread rests `waiting` with
// `until: <deadline in ms, rounded up>` and the scheduler wakes it when it
// processes an entry stamped at or after the deadline. The runtime needs
// *some* input to observe time passing; main.ts admits a self-signed `tick`
// from a coarse timer while anything sleeps.
//
// Random. random_get draws from a SHA-256 counter stream keyed by
// (current log entry CID, thread origin CID): distinct per entry and per
// sibling thread, fixed on replay, and with no seed anywhere. Never use it for
// secrets — it is a pure function of public records. Keys and nonces that must
// be secret come from the wallet.

import { createHash } from "node:crypto";
import type { CID } from "multiformats/cid";

/** A log-entry stamp: whole seconds and nanoseconds since the Unix epoch (both safe integers, nsec < 1e9). */
export type Stamp = [sec: number, nsec: number];

export const stampNs = (s: Stamp): bigint => BigInt(s[0]) * 1_000_000_000n + BigInt(s[1]);
export const nsStamp = (ns: bigint): Stamp => [Number(ns / 1_000_000_000n), Number(ns % 1_000_000_000n)];
export const msStamp = (ms: number): Stamp => [Math.floor(ms / 1000), (ms % 1000) * 1_000_000];

export function isStamp(x: unknown): x is Stamp {
  return Array.isArray(x) && x.length === 2 && x.every((v) => Number.isSafeInteger(v) && v >= 0) && x[1] < 1_000_000_000;
}

/** The later of two stamps. */
export const maxStamp = (a: Stamp, b: Stamp): Stamp => (stampNs(a) >= stampNs(b) ? a : b);

/** WASI clock ids. All read the same per-thread clock. */
export const CLOCK = { REALTIME: 0, MONOTONIC: 1, PROCESS_CPUTIME: 2, THREAD_CPUTIME: 3 } as const;

/** A thread's clock: the current entry's stamp as a floor, +1 ns per read. */
export class ThreadClock {
  private base = 0n;
  private last: bigint | undefined;

  /** The thread is now driven by an entry stamped `ns`. The base only moves forward. */
  drive(ns: bigint): void {
    if (ns > this.base) this.base = ns;
  }

  /** clock_time_get. */
  read(): bigint {
    this.last = this.last === undefined || this.base > this.last ? this.base : this.last + 1n;
    return this.last;
  }

  /** "Now" without consuming a read: what a relative sleep counts from. */
  peek(): bigint {
    return this.last === undefined || this.base > this.last ? this.base : this.last;
  }
}

/** The random stream for (entry, thread): SHA-256(key ‖ counter as u64 BE), block after block. */
export function entropy(entry: CID, thread: CID): (len: number) => Uint8Array {
  const key = createHash("sha256").update(entry.bytes).update(thread.bytes).digest();
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
        buf = new Uint8Array(createHash("sha256").update(key).update(c).digest());
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

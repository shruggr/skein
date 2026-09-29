// Time and randomness as the log defines them (docs/ARCH.md, "Time and
// randomness"; the kernel's syscalls.zig). Both are pure functions of records.
//
// Time. Every log entry carries its admission stamp, `time: [sec, nsec]`;
// inside the machine every clock reads from the stamp of the entry a step is
// driven by, never from a wall clock.
//
// Random. random_get draws from a SHA-256 counter stream keyed by
// (current log entry CID, thread origin CID): distinct per entry and per
// sibling thread, fixed on replay, and with no seed anywhere. Never use it for
// secrets — it is a pure function of public records. The kernel's stream is
// checked against this one (kernel-zig/test/fixtures.json).

import { createHash } from "node:crypto";
import type { CID } from "multiformats/cid";

/** A log-entry stamp: whole seconds and nanoseconds since the Unix epoch (both safe integers, nsec < 1e9). */
export type Stamp = [sec: number, nsec: number];

export const stampNs = (s: Stamp): bigint => BigInt(s[0]) * 1_000_000_000n + BigInt(s[1]);
export const msStamp = (ms: number): Stamp => [Math.floor(ms / 1000), (ms % 1000) * 1_000_000];

/** The later of two stamps. */
export const maxStamp = (a: Stamp, b: Stamp): Stamp => (stampNs(a) >= stampNs(b) ? a : b);

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

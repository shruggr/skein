// Test helpers shared across directories (and kernel-zig/equiv). Not part of
// anything that runs.

import type { CID } from "multiformats/cid";
import type { Stamp } from "./runtime/syscalls.ts";
import { dirBundles } from "./client/client.ts";

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

export const T0: Stamp = [1_790_000_000, 250_000_000];
export const iso = (s: Stamp) => new Date(s[0] * 1000 + Math.floor(s[1] / 1e6)).toISOString();

/** A settable clock for admission stamps. */
export function scriptClock(start: Stamp = T0) {
  let now: Stamp = start;
  return { now: () => now, set(s: Stamp) { now = s; } };
}

/** A directory as the client sends it: {root, bundles of ≤ 1 MiB, the last naming the root}. */
export async function bundlesOf(dir: string, limit?: number): Promise<{ root: CID; bundles: Uint8Array[]; records: number }> {
  return dirBundles(dir, { limit });
}

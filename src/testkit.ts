// Test helpers shared across directories (and kernel-zig/equiv). Not part of
// anything that runs.

import type { CID } from "multiformats/cid";
import type { Listed, MessageBox } from "./peers/infer.ts";
import type { Stamp } from "./runtime/syscalls.ts";
import { dirBundles } from "./client/client.ts";

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

/** An in-process BRC-33 messagebox: sendMessage / listMessages / acknowledgeMessage, per identity. */
export function messageBoxHub() {
  const boxes = new Map<string, Listed[]>();
  let n = 0;
  const key = (recipient: string, box: string) => `${recipient} ${box}`;
  const deliver = (recipient: string, box: string, m: Omit<Listed, "messageId" | "created_at">) => {
    const q = boxes.get(key(recipient, box)) ?? [];
    n++;
    q.push({ ...m, messageId: `m${n}`, created_at: String(n).padStart(8, "0") });
    boxes.set(key(recipient, box), q);
  };
  return {
    as(identity: string): MessageBox {
      return {
        list: async (box) => [...(boxes.get(key(identity, box)) ?? [])],
        ack: async (ids) => {
          for (const [k, q] of boxes) if (k.startsWith(`${identity} `)) boxes.set(k, q.filter((m) => !ids.includes(m.messageId)));
        },
        send: async ({ recipient, box, body }) => deliver(recipient, box, { sender: identity, body: JSON.stringify(body) }),
      };
    },
    /** Put a message in a box as if `sender` had authenticated (tests of forged senders). */
    inject: deliver,
    pending: (recipient: string, box: string) => [...(boxes.get(key(recipient, box)) ?? [])],
  };
}
export type Hub = ReturnType<typeof messageBoxHub>;

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

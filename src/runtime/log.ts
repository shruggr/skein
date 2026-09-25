// The input log (docs/ARCH.md): every admitted message, in order, as a hash
// chain of log-entry records
//
//   { kind: "log", prev: <previous entry | null>, n, message: <message cid>, time: [sec, nsec] }
//
// The tip entry's CID is the instance's **state hash**: it commits to every
// input the instance has seen, in order, and when it saw each one.
//
// `time` is the runtime's own clock reading at admission, unsigned and
// immutable once written: seconds and nanoseconds since the Unix epoch, two
// safe integers (a single ns count would not fit a JS number, and dag-cbor
// would hand it back as a bigint). It never goes back: an entry is stamped at
// least its predecessor's time. This file is the ONE place in src/runtime that
// reads the wall clock (isolation.test.ts allows it here only). Everything
// inside the machine that needs time derives it from these stamps
// (syscalls.ts); randomness derives from the entry's CID and gets no stamp.

import type { CID } from "multiformats/cid";
import { rootIdentity, signerFor, identityOf, type KeyWallet } from "./identity.ts";
import { genesis, signMessage, subscription, type Message } from "./records.ts";
import { SHELL_CID, SHELL_PROGRAM } from "./programs.ts";
import type { LogEntry, Store } from "./store.ts";
import { msStamp, type Stamp } from "./syscalls.ts";

export type { LogEntry };

/** The runtime's clock: wall time now, ms resolution, as a stamp. */
export function now(): Stamp {
  return msStamp(Date.now());
}

export function isLogEntry(x: unknown): x is LogEntry {
  const e = x as Partial<LogEntry> | null;
  return !!e && e.kind === "log" && typeof e.n === "number" && e.message !== undefined;
}

/**
 * Verify and store a message, then append it to the log stamped with the
 * runtime's clock (or `time`, when replaying a log or in tests). Returns the
 * new entry (the new state hash).
 */
export async function admit(store: Store, m: Message, time: Stamp = now()): Promise<CID> {
  return store.log.append(await store.putMessage(m), time);
}

/** The log as records, in order. */
export async function readLog(store: Store): Promise<Array<{ cid: CID; entry: LogEntry; message: Message }>> {
  const out: Array<{ cid: CID; entry: LogEntry; message: Message }> = [];
  for await (const { cid, entry } of store.log.entries()) out.push({ cid, entry, message: await store.get<Message>(entry.message) });
  return out;
}

/** Copy a log (messages and stamps, in order) into another store: what replay feeds a fresh runtime. */
export async function copyLog(from: Store, to: Store): Promise<void> {
  for (const { entry, message } of await readLog(from)) await to.log.append(await to.putMessage(message), entry.time);
}

/**
 * The names the runtime derives identities for, as wallet keyIDs. `timer`
 * signs the ticks main.ts admits so sleepers see time pass; it is not the
 * runtime identity so that replay (which copies ticks from the log) cannot
 * collide with the seqs of messages the runtime recomputes.
 */
export const NAMES = { runtime: "runtime", admin: "admin", david: "david", timer: "timer" } as const;

/**
 * An empty log starts with admin-signed messages: the genesis (naming the
 * wallet's identity key as root) and the default subscriptions. The messages
 * are dated 0 (the runtime's clock is in the entry stamps, not in what the
 * admin signs), so the same wallet always signs the same genesis.
 *
 * Default subscriptions, tried in order:
 *   { from: admin, kind: "run" } → shell     { from: david, kind: "run" } → shell
 */
export async function ensureGenesis(store: Store, wallet: KeyWallet, name = "skein", time: Stamp = now()): Promise<{ created: boolean; entries: CID[] }> {
  await store.put(SHELL_PROGRAM);
  if (await store.log.tip()) return { created: false, entries: [] };
  const admin = await signerFor(wallet, NAMES.admin);
  const david = await identityOf(wallet, NAMES.david);
  const bodies: unknown[] = [
    genesis(await rootIdentity(wallet), name, 0),
    subscription({ from: admin.identity, kind: "run" }, SHELL_CID, 0),
    subscription({ from: david, kind: "run" }, SHELL_CID, 0),
  ];
  const entries: CID[] = [];
  for (const [seq, body] of bodies.entries()) entries.push(await admit(store, await signMessage(admin, { seq, at: 0, body }), time));
  return { created: true, entries };
}

/** Short form for log lines. */
export const short = (c: CID | string) => c.toString().slice(-8);

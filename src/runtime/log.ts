// The input log (docs/ARCH.md): every admitted message, in order, as a hash
// chain of log-entry records
//
//   { kind: "log", prev: <previous entry | null>, n, message: <message cid> }
//
// The tip entry's CID is the instance's **state hash**: it commits to every
// input the instance has seen, in order. Storage is the store's (Store.log);
// this module is admission, reading, and the genesis an empty log starts with.

import type { CID } from "multiformats/cid";
import { encode } from "./cid.ts";
import { rootIdentity, signerFor, identityOf, type KeyWallet } from "./identity.ts";
import { genesis, signMessage, subscription, type Message } from "./records.ts";
import { SHELL_CID, SHELL_PROGRAM } from "./programs.ts";
import type { LogEntry, Store } from "./store.ts";
import type { Bind } from "./syscalls.ts";

export type { LogEntry };

export function isLogEntry(x: unknown): x is LogEntry {
  const e = x as Partial<LogEntry> | null;
  return !!e && e.kind === "log" && typeof e.n === "number" && e.message !== undefined;
}

/** Verify and store a message, then append it to the log. Returns the new entry (the new state hash). */
export async function admit(store: Store, m: Message): Promise<CID> {
  return store.log.append(await store.putMessage(m));
}

/** The log as records, in order. */
export async function readLog(store: Store): Promise<Array<{ cid: CID; entry: LogEntry; message: Message }>> {
  const out: Array<{ cid: CID; entry: LogEntry; message: Message }> = [];
  for await (const { cid, entry } of store.log.entries()) out.push({ cid, entry, message: await store.get<Message>(entry.message) });
  return out;
}

/**
 * The names the runtime derives identities for, as wallet keyIDs. In
 * production a peer (clock, a person) has its own wallet and its identity is
 * configured by a bind or subscription message; deriving them all from one
 * wallet is the single-machine default.
 */
export const NAMES = { runtime: "runtime", admin: "admin", david: "david", clock: "clock" } as const;

/**
 * An empty log starts with admin-signed messages: the genesis (naming the
 * wallet's identity key as root), the default subscriptions, and the default
 * bindings. They are dated 0: the runtime has no clock, and the instance's
 * first attested time is its birth certificate. Signing is deterministic
 * (RFC 6979), so the same wallet always writes the same genesis.
 *
 * Default subscriptions, tried in order:
 *   { from: admin, kind: "run" } → shell     { from: david, kind: "run" } → shell
 *   { from: clock }              → resolve-waiter (attested replies)
 */
export async function ensureGenesis(store: Store, wallet: KeyWallet, name = "skein"): Promise<{ created: boolean; entries: CID[] }> {
  await store.put(SHELL_PROGRAM);
  if (await store.log.tip()) return { created: false, entries: [] };
  const admin = await signerFor(wallet, NAMES.admin);
  const [david, clock] = await Promise.all([identityOf(wallet, NAMES.david), identityOf(wallet, NAMES.clock)]);
  const binds: Bind[] = [
    { kind: "bind", syscall: "clock_time_get", to: clock },
    { kind: "bind", syscall: "random_get", to: clock },
  ];
  const bodies: unknown[] = [
    genesis(await rootIdentity(wallet), name, 0),
    subscription({ from: admin.identity, kind: "run" }, SHELL_CID, 0),
    subscription({ from: david, kind: "run" }, SHELL_CID, 0),
    subscription({ from: clock }, "resolve-waiter", 0),
    ...binds,
  ];
  const entries: CID[] = [];
  for (const [seq, body] of bodies.entries()) entries.push(await admit(store, await signMessage(admin, { seq, at: 0, body })));
  return { created: true, entries };
}

/** Short form for log lines. */
export const short = (c: CID | string) => {
  const s = c.toString();
  return s.slice(-8);
};

export const cidOf = (x: unknown) => encode(x).cid;

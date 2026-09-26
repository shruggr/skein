// The host's side of the log (docs/MESSAGES.md): a log entry is the host's
// statement — "message n arrived at t", "wake at t" — so the providers make
// it here, outside the machine: stamp it with the host's clock, sign it with
// the host wallet ([2, "skein log"], key "1", anyone), and hand the finished
// entry to the runtime (Runtime.admit), which checks it against the genesis's
// `host`. This is where the clock is: nothing in src/runtime reads one.

import type { CID } from "multiformats/cid";
import { signAnyone, type KeyWallet } from "../runtime/identity.ts";
import { entryBytes, genesisFor, LOG_KEY_ID, LOG_PROTOCOL, nextEntry, type EntryBody, type InstanceConfig, type LogEntry } from "../runtime/log.ts";
import { PROGRAMS } from "../runtime/programs.ts";
import { isGenesis } from "../runtime/records.ts";
import type { Runtime } from "../runtime/scheduler.ts";
import { Rejected, type Store } from "../runtime/store.ts";
import { msStamp, type Stamp } from "../runtime/syscalls.ts";

/** The host's clock: wall time now, ms resolution, as a stamp. */
export function now(): Stamp {
  return msStamp(Date.now());
}

/** Sign an entry with the host wallet. */
export async function signEntry(host: KeyWallet, unsigned: Omit<LogEntry, "sig">): Promise<LogEntry> {
  return { ...unsigned, sig: await signAnyone(host, LOG_PROTOCOL, LOG_KEY_ID, entryBytes(unsigned)) };
}

/**
 * Admit an entry through the runtime: the next entry over `body`, stamped
 * `time`, signed by the host, with the records it names. If another provider
 * admitted first (the tip moved: "out-of-order"), sign the new next one and
 * try again.
 */
export async function admitEntry(runtime: Runtime, host: KeyWallet, body: EntryBody, records: { envelope?: object; body?: Uint8Array } = {}, time: Stamp = now()): Promise<CID> {
  for (let tries = 0; ; tries++) {
    const entry = await signEntry(host, await nextEntry(runtime.store, body, time));
    try {
      return await runtime.admit(entry, records);
    } catch (e) {
      if (!(e instanceof Rejected && e.reason === "out-of-order") || tries >= 10) throw e;
    }
  }
}

/**
 * Sign the next entry and append it straight to a store, not through a
 * runtime: the genesis entry, and tests writing a log while nothing runs.
 */
export async function appendEntry(store: Store, host: KeyWallet, body: EntryBody, time: Stamp = now()): Promise<{ cid: CID; entry: LogEntry }> {
  const entry = await signEntry(host, await nextEntry(store, body, time));
  return { cid: await store.log.append(entry), entry };
}

/**
 * An empty log starts with the genesis entry, signed by the host like every
 * entry. The program records it names are put into the store (their modules
 * are not: `skein-dev install`).
 */
export async function ensureGenesis(store: Store, wallet: KeyWallet, host: KeyWallet, c: InstanceConfig, time: Stamp = now()): Promise<{ created: boolean; entry?: CID }> {
  for (const p of Object.values(PROGRAMS)) await store.put(p);
  if (await store.log.tip()) return { created: false };
  const g = await genesisFor(wallet, host, c);
  if (!isGenesis(g)) throw new TypeError("genesis: malformed config");
  const { cid } = await appendEntry(store, host, { genesis: await store.put(g) }, time);
  return { created: true, entry: cid };
}

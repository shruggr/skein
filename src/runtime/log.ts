// The input log (skein next, SPEC.md section 2; kernel-zig/src/log.zig is authoritative): every
// input, in order, as a hash chain of log-entry records. This is the host's mirror of the shape, for
// building the genesis entry (src/host/genesis.ts over nextEntry) and reading entries. Every other
// entry the kernel appends at COMMIT (the host hands it the arrival; the kernel assigns prev and n).
//
//   { kind: "log", prev: <entry | null>, n, time: [sec, nsec],
//     genesis: <cid>                       n = 0: the starting state
//   | request: <cid>, door                 a request record (its payload, its signature when its
//                                          sender is proven), `door` what the check established
//   | event: <cid>, name, door }           an event record from the host (the chain pointer, a
//                                          proof, a deploy BEEF) under its name
//
// No signature: the sender signed its request, `prev` fixes the order, and the stamp is the host's
// word. The tip entry's CID is the instance's **state hash**.

import type { WalletProtocol } from "@bsv/sdk";
import { CID } from "multiformats/cid";
import { encode } from "./cid.ts";
import { isGenesis, type Genesis } from "./records.ts";
import type { LogEntry, Store } from "./store.ts";
import { maxStamp, type Stamp } from "./syscalls.ts";
import type { Ms } from "./types.ts";

/** What an entry admits: exactly one of these (log.zig). */
export type EntryBody = { genesis: CID } | { request: CID; door: Record<string, unknown> } | { event: CID; name: string; door: Record<string, unknown> };

/** A log entry in format 8. */
export type Entry = { kind: "log"; prev: CID | null; n: number; time: Stamp } & EntryBody;

/** A stamp as the `at` (ms) of the records written while processing its entry. */
export const stampMs = (s: Stamp): Ms => s[0] * 1000 + Math.floor(s[1] / 1_000_000);

const isCid = (x: unknown): boolean => CID.asCID(x) !== null;
const isName = (x: unknown): boolean => typeof x === "string" && x.length > 0;

/** An entry as log.zig has it: `kind: "log"`, a number `n`, exactly one of genesis | request | event, an event's `name`. */
export function isLogEntry(x: unknown): x is Entry {
  const e = x as Record<string, unknown> | null;
  if (!e || typeof e !== "object" || e.kind !== "log" || typeof e.n !== "number") return false;
  if (["genesis", "event", "request"].filter((k) => e[k] !== undefined).length !== 1) return false;
  if (e.event !== undefined ? !isCid(e.event) || !isName(e.name) : e.name !== undefined) return false;
  if (e.request !== undefined && !isCid(e.request)) return false;
  return true;
}

/**
 * The next entry: extending the tip, stamped `time` (raised to the tip's
 * stamp if earlier). The host builds only the genesis this way (#163); the
 * kernel keeps the same rule for every entry it appends.
 */
export async function nextEntry(store: Store, body: EntryBody, time: Stamp): Promise<Entry> {
  const tipCid = await store.log.tip();
  const tip = tipCid ? await store.get<{ kind: string; n: number; time: Stamp }>(tipCid) : undefined;
  return { kind: "log" as const, prev: tipCid ?? null, n: tip ? tip.n + 1 : 0, time: tip ? maxStamp(time, tip.time) : time, ...body };
}

// ---------------------------------------------------------------- format 1
// Before format 2 (#33) an entry was the host's statement, signed by the
// host: protocol [2, "skein log"], key "1", counterparty anyone, over the
// entry's dag-cbor without `sig`. The kernel refuses such a store; these are
// kept for the signature fixtures (kernel-zig/test/fixtures.ts).

export const LOG_PROTOCOL: WalletProtocol = [2, "skein log"];
export const LOG_KEY_ID = "1";

/** A format-1 entry's signed bytes: its dag-cbor with `sig` removed. */
export function entryBytes(e: LogEntry | Omit<LogEntry, "sig"> | Entry): Uint8Array {
  const { sig: _, ...rest } = e as LogEntry;
  return encode(rest).bytes;
}

/**
 * `fuelPerStep` (issue #5): the one limit on a step's fuel (wasm instructions)
 * in the Zig kernel, which records every step's fuel on its update; a step
 * that runs out ends `errored`, "fuel exhausted". 10^12, generous until
 * something hits it.
 */
export const FUEL_PER_STEP = "1000000000000";

export const DEFAULTS: Record<string, string> = { fuelPerStep: FUEL_PER_STEP };

/** The log as records, in order. */
export async function readLog(store: Store): Promise<Array<{ cid: CID; entry: LogEntry }>> {
  const out: Array<{ cid: CID; entry: LogEntry }> = [];
  for await (const x of store.log.entries()) out.push(x);
  return out;
}

/** The genesis a log starts with. */
export async function genesisOf(store: Store): Promise<Genesis> {
  for await (const { entry } of store.log.entries()) {
    const g = entry.genesis ? await store.get(entry.genesis) : undefined;
    if (!isGenesis(g)) throw new Error("log: entry 0 is not a genesis");
    return g;
  }
  throw new Error("log: empty");
}

/** Short form for log lines. */
export const short = (c: CID | string) => c.toString().slice(-8);

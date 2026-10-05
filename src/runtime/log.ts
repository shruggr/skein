// The input log (docs/VM.md, docs/MESSAGES.md "The log, format 8"): every
// input, in order, as a hash chain of log-entry records. The kernel
// (kernel-zig/src/log.zig) is authoritative: it refuses an entry that is
// malformed or does not extend its tip. This is the host's mirror of the
// shape, for building entries (src/host/genesis.ts over nextEntry) and
// reading them.
//
//   { kind: "log", prev: <entry | null>, n, time: [sec, nsec],
//     genesis: <cid>                       n = 0: the starting state
//   | request: <cid>, transport: <name>    a package as a transport carried it in (#68):
//                                          the record of an http request, a libp2p message
//                                          or frame, or a provider's signed message (`local`)
//   | mail: <cid>                          a message the host admits directly (#40, #70)
//   | event: <cid>, box: <name> }          a record from the host's wiring (a header, a
//                                          proof), routed by box or subject (#29, #65)
//
// No signature (format 2, #33): the sender signed its request, `prev` fixes
// the order, and the stamp is the host's word. The tip entry's CID is the
// instance's **state hash**. `time` is the host's clock at admission, never
// before the previous entry's; everything inside the machine derives time
// from these stamps (syscalls.ts).

import type { WalletProtocol } from "@bsv/sdk";
import { CID } from "multiformats/cid";
import { encode } from "./cid.ts";
import { isGenesis, type Genesis } from "./records.ts";
import type { LogEntry, Store } from "./store.ts";
import { maxStamp, type Stamp } from "./syscalls.ts";
import type { Ms } from "./types.ts";

/** What an entry admits: exactly one of these (log.zig isLogEntry). */
export type EntryBody = { genesis: CID } | { request: CID; transport: string } | { mail: CID } | { event: CID; box: string };

/** A log entry in format 8. */
export type Entry = { kind: "log"; prev: CID | null; n: number; time: Stamp } & EntryBody;

/** A stamp as the `at` (ms) of the records written while processing its entry. */
export const stampMs = (s: Stamp): Ms => s[0] * 1000 + Math.floor(s[1] / 1_000_000);

const isCid = (x: unknown): boolean => CID.asCID(x) !== null;
const isName = (x: unknown): boolean => typeof x === "string" && x.length > 0;

/**
 * A format-8 entry, as log.zig's isLogEntry has it: `kind: "log"`, a number
 * `n`, exactly one of genesis | mail | event | request, a non-empty `box` with
 * an event and only with it, a non-empty `transport` with a request and only
 * with it, and none of the older formats' fields (`sig`, `wake`,
 * `envelope`, `body`, `outcome`).
 */
export function isLogEntry(x: unknown): x is Entry {
  const e = x as Record<string, unknown> | null;
  if (!e || typeof e !== "object" || e.kind !== "log" || typeof e.n !== "number") return false;
  if (["sig", "wake", "envelope", "body", "outcome"].some((k) => e[k] !== undefined)) return false;
  if (["genesis", "mail", "event", "request"].filter((k) => e[k] !== undefined).length !== 1) return false;
  if (e.event !== undefined ? !isCid(e.event) || !isName(e.box) : e.box !== undefined) return false;
  if (e.request !== undefined ? !isCid(e.request) || !isName(e.transport) : e.transport !== undefined) return false;
  if (e.mail !== undefined && !isCid(e.mail)) return false;
  return true;
}

/**
 * The next entry: extending the tip, stamped `time` (raised to the tip's
 * stamp if earlier). The kernel refuses an entry that no longer extends its
 * tip.
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
// kept for what makes one to check that (kernel-zig/equiv/old-store.ts) and
// for the signature fixtures (kernel-zig/test/fixtures.ts).

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

export const DEFAULTS: Record<string, string> = { model: "ripper/qwen38", thinking: "off", fuelPerStep: FUEL_PER_STEP };

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

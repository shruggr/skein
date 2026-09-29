// The input log (docs/ARCH.md, docs/MESSAGES.md): every input, in order, as a
// hash chain of signed log-entry records
//
//   { kind: "log", prev: <entry | null>, n, time: [sec, nsec],
//     genesis: <cid>                  n = 0: the starting state
//   | envelope: <cid>, box: <name>,   an admitted BRC-169 envelope's signed part (its JSON object
//     body: <cid>                     without `content`, as dag-cbor), its BRC-33 box, and its
//                                     plaintext body (the dag-cbor bytes, whose sha2-256 is the
//                                     envelope's signed contentHash)
//   | wake: <thread origin>           a sleeper's deadline reached; no message, no sender
//   | outcome: {emit: <emit record>,  what the delivery provider made of an emit: sent
//       status: "delivered"           (once per emit), or refused for good — a permanent
//             | "failed", reason?}    refusal, or transient errors past its retry bound
//     sig }
//
// The tip entry's CID is the instance's **state hash**. In this format (1)
// an entry is the host's statement — "message n arrived at t", "wake at t",
// "emit e was delivered (or failed) at t" — so `sig` is the host's signature
// over the entry's dag-cbor without `sig`: protocol [2, "skein log"], key "1",
// counterparty anyone, so anyone holding the genesis's `host` can check every
// stamp (verifyEntry). The kernel writes format 3 (issues #33, #40;
// kernel-zig/src/log.zig): the same chain with no `sig` (no host key) and mail
// entries; src/host/genesis.ts builds them over nextEntry.
//
// `time` is the host's clock at admission, never before the previous entry's.
// Everything inside the machine derives time from these stamps (syscalls.ts).

import type { WalletProtocol } from "@bsv/sdk";
import { CID } from "multiformats/cid";
import { encode } from "./cid.ts";
import { verifyAnyone } from "./identity.ts";
import { isGenesis, type Genesis, type Identity } from "./records.ts";
import type { LogEntry, Outcome, Store } from "./store.ts";
import { maxStamp, type Stamp } from "./syscalls.ts";
import type { Ms } from "./types.ts";

export type { LogEntry, Outcome };

export const LOG_PROTOCOL: WalletProtocol = [2, "skein log"];
export const LOG_KEY_ID = "1";

/** A stamp as the `at` (ms) of the records written while processing its entry. */
export const stampMs = (s: Stamp): Ms => s[0] * 1000 + Math.floor(s[1] / 1_000_000);

export function isLogEntry(x: unknown): x is LogEntry {
  const e = x as Partial<LogEntry> | null;
  return !!e && e.kind === "log" && typeof e.n === "number" && e.sig instanceof Uint8Array
    && [e.genesis, e.envelope, e.wake, e.outcome].filter((v) => v !== undefined).length === 1
    && (e.envelope === undefined) === (e.body === undefined)
    && (e.outcome === undefined || isOutcome(e.outcome));
}

export function isOutcome(x: unknown): x is Outcome {
  const o = x as Partial<Outcome> | null;
  return !!o && typeof o === "object" && CID.asCID(o.emit) !== null
    && (o.status === "delivered" || o.status === "failed")
    && (o.reason === undefined || typeof o.reason === "string");
}

/** The signed bytes: the entry's dag-cbor with `sig` removed. */
export function entryBytes(e: LogEntry | Omit<LogEntry, "sig">): Uint8Array {
  const { sig: _, ...rest } = e as LogEntry;
  return encode(rest).bytes;
}

/** The entry's signature against the host identity (the genesis's `host`). No wallet needed. */
export function verifyEntry(e: LogEntry, host: Identity): boolean {
  return verifyAnyone(host, LOG_PROTOCOL, LOG_KEY_ID, entryBytes(e), e.sig);
}

export type EntryBody = { genesis: CID } | { envelope: CID; box: string; body: CID } | { wake: CID } | { outcome: Outcome };

/**
 * The next entry, unsigned: extending the tip, stamped `time` (raised to the
 * tip's stamp if earlier). The store refuses an entry that no longer extends
 * its tip.
 */
export async function nextEntry(store: Store, body: EntryBody, time: Stamp): Promise<Omit<LogEntry, "sig">> {
  const tipCid = await store.log.tip();
  const tip = tipCid ? await store.get<LogEntry>(tipCid) : undefined;
  return { kind: "log" as const, prev: tipCid ?? null, n: tip ? tip.n + 1 : 0, time: tip ? maxStamp(time, tip.time) : time, ...body };
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

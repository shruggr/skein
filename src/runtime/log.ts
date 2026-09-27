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
//     sig }
//
// The tip entry's CID is the instance's **state hash**. An entry is the host's
// statement — "message n arrived at t", "wake at t" — so `sig` is the host's
// signature (the host wallet, not the instance's) over the entry's dag-cbor
// without `sig`: protocol [2, "skein log"], key "1", counterparty anyone, so
// anyone holding the genesis's `host` can check every stamp and every kick
// (verifyEntry). It is made once, by the provider that delivers the entry
// (src/host: the messagebox delivery for admissions, the tick for wakes),
// through the host wallet; the runtime admits the finished entry
// (Runtime.admit) and verifies it. Replay copies the entry and verifies it,
// never re-signs.
//
// `time` is the host's clock at admission, never before the previous entry's.
// Nothing in src/runtime reads a clock; everything inside derives time from
// these stamps (syscalls.ts).

import type { WalletProtocol } from "@bsv/sdk";
import type { CID } from "multiformats/cid";
import { encode } from "./cid.ts";
import { rootIdentity, verifyAnyone, type KeyWallet } from "./identity.ts";
import { isGenesis, type Genesis, type Identity, type Subscription } from "./records.ts";
import { PROGRAM_CIDS } from "./programs.ts";
import type { LogEntry, Store } from "./store.ts";
import { maxStamp, type Stamp } from "./syscalls.ts";
import type { Ms } from "./types.ts";

export type { LogEntry };

export const LOG_PROTOCOL: WalletProtocol = [2, "skein log"];
export const LOG_KEY_ID = "1";

/** A stamp as the `at` (ms) of the records written while processing its entry. */
export const stampMs = (s: Stamp): Ms => s[0] * 1000 + Math.floor(s[1] / 1_000_000);

export function isLogEntry(x: unknown): x is LogEntry {
  const e = x as Partial<LogEntry> | null;
  return !!e && e.kind === "log" && typeof e.n === "number" && e.sig instanceof Uint8Array
    && [e.genesis, e.envelope, e.wake].filter((v) => v !== undefined).length === 1
    && (e.envelope === undefined) === (e.body === undefined);
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

export type EntryBody = { genesis: CID } | { envelope: CID; box: string; body: CID } | { wake: CID };

/**
 * The next entry, unsigned: extending the tip, stamped `time` (raised to the
 * tip's stamp if earlier). What a provider signs; the store refuses an entry
 * that no longer extends its tip.
 */
export async function nextEntry(store: Store, body: EntryBody, time: Stamp): Promise<Omit<LogEntry, "sig">> {
  const tipCid = await store.log.tip();
  const tip = tipCid ? await store.get<LogEntry>(tipCid) : undefined;
  return { kind: "log" as const, prev: tipCid ?? null, n: tip ? tip.n + 1 : 0, time: tip ? maxStamp(time, tip.time) : time, ...body };
}

export interface InstanceConfig {
  /** The identity the instance acts for; the default subscriptions route its `run`, `objects`, `head` and `chat` boxes. */
  owner: Identity;
  handle?: string;  // default "skein"
  domain?: string;  // default "localhost"
  /** Default: (owner, run) → run-handler, (owner, objects) → objects-handler, (owner, head) → head-handler, (owner, chat) → loop. */
  subscriptions?: Subscription[];
  /** Peers by role: `infer` is the inference peer the loop asks. */
  peers?: Record<string, Identity>;
  /** Default: {model: "ripper/qwen38", thinking: "off"}. */
  defaults?: Record<string, string>;
  /** Reply-only boxes the delivery provider collects. Default: ["completions", "say"] (answers to `infer`, and other agents' answers to the loop's `message`). */
  collect?: string[];
}

export const DEFAULTS: Record<string, string> = { model: "ripper/qwen38", thinking: "off" };

/** The genesis record for a config: the instance identity is the instance wallet's, `host` the host wallet's. */
export async function genesisFor(wallet: KeyWallet, host: KeyWallet, c: InstanceConfig): Promise<Genesis> {
  return {
    kind: "genesis",
    identity: await rootIdentity(wallet),
    handle: c.handle ?? "skein",
    domain: c.domain ?? "localhost",
    owner: c.owner,
    host: await rootIdentity(host),
    programs: { ...PROGRAM_CIDS },
    subscriptions: c.subscriptions ?? [
      { match: { sender: c.owner, box: "run" }, handler: PROGRAM_CIDS["run-handler"] },
      { match: { sender: c.owner, box: "objects" }, handler: PROGRAM_CIDS["objects-handler"] },
      { match: { sender: c.owner, box: "head" }, handler: PROGRAM_CIDS["head-handler"] },
      { match: { sender: c.owner, box: "chat" }, handler: PROGRAM_CIDS.loop },
    ],
    ...(c.peers && Object.keys(c.peers).length ? { peers: c.peers } : {}),
    defaults: c.defaults ?? DEFAULTS,
    collect: c.collect ?? ["completions", "say"],
  };
}

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

/**
 * Copy a log into another store — its entries exactly as signed, and the
 * records they name (genesis, programs, envelopes, bodies) — verifying every
 * signature. What replay feeds a fresh runtime. No wallet, no keys.
 */
export async function copyLog(from: Store, to: Store): Promise<void> {
  const g = await genesisOf(from);
  for (const p of Object.values(g.programs)) await to.putBlock(p, await from.bytes(p));
  for await (const { cid, entry } of from.log.entries()) {
    if (!verifyEntry(entry, g.host)) throw new Error(`log: entry #${entry.n} (${short(cid)}) has a bad signature`);
    for (const c of [entry.genesis, entry.envelope, entry.body]) if (c) await to.putBlock(c, await from.bytes(c));
    const copied = await to.log.append(entry);
    if (!copied.equals(cid)) throw new Error(`log: entry #${entry.n} copied to a different CID`);
  }
}

/** Short form for log lines. */
export const short = (c: CID | string) => c.toString().slice(-8);

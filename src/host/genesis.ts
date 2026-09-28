// Format 2 (issue #33) on the router's side: the genesis a new instance's log
// starts with, and unsigned entries.
//
//   entry    {kind: "log", prev, n, time, genesis | envelope+box+body | wake | outcome}   — no `sig`: no host key
//   genesis  {kind: "genesis", identity: bytes(33), owner: bytes(33), handle, domain, programs,
//             subscriptions: [{match: {sender?: bytes(33), box}, handler}], peers?: {role: bytes(33)},   (last: `:mail` → messagebox)
//             defaults, names?: [{identityKey: bytes(33), handle, domain}], collect}
//
// The stamp is the router's clock at admission (#10): the sequence is the
// order. `programs` are the kernel's own pins (its `programs` frame), so the
// genesis names exactly the modules the kernel installed.

import type { CID } from "multiformats/cid";
import { DEFAULTS, nextEntry, type EntryBody } from "../runtime/log.ts";
import { Rejected } from "../runtime/store.ts";
import type { Stamp } from "../runtime/syscalls.ts";
import { now as clockNow } from "./entry.ts";
import type { Kernel } from "./kernel.ts";

export const keyBytes = (hex: string): Uint8Array => {
  if (!/^0[23][0-9a-f]{64}$/.test(hex)) throw new TypeError(`not an identity key: ${hex}`);
  return Uint8Array.from(Buffer.from(hex, "hex"));
};
export const keyHex = (k: unknown): string => k instanceof Uint8Array ? Buffer.from(k).toString("hex") : String(k);

type Named = { handle: string; domain: string };

export interface Genesis2Config {
  identity: string;
  owner: string;
  handle: string;
  domain: string;
  infer?: string;
  ownerHandle?: Named;
  inferHandle?: Named;
  defaults?: Record<string, string>;
  /** Anyone may open a `chat` (default true): the seed after the owner's boxes. */
  openChat?: boolean;
  /** More seed subscriptions, after these (e.g. the wallet's boxes, #29): a sender (hex) or none, a box, a handler program record. */
  subscriptions?: Array<{ sender?: string; box: string; handler: CID }>;
}

/** The genesis record for a new instance over the kernel's programs (name → program record CID). */
export function genesis2(c: Genesis2Config, programs: Record<string, CID>): Record<string, unknown> {
  const owner = keyBytes(c.owner);
  const sub = (box: string, handler: string, sender?: Uint8Array) => ({ match: { ...(sender ? { sender } : {}), box }, handler: programs[handler] });
  const subscriptions = [
    sub("run", "run-handler", owner), sub("objects", "objects-handler", owner), sub("head", "head-handler", owner),
    sub("chat", "loop", owner), sub("subscribe", "subscribe-handler", owner),
    ...(c.openChat === false ? [] : [sub("chat", "loop")]),
    // The messagebox's records for the identities this instance keeps mail for (vmmail.ts): the router's `mail` entries.
    ...(programs.messagebox ? [sub(":mail", "messagebox")] : []),
    ...(c.subscriptions ?? []).map((x) => ({ match: { ...(x.sender ? { sender: keyBytes(x.sender) } : {}), box: x.box }, handler: x.handler })),
  ];
  const names = [{ identityKey: owner, ...(c.ownerHandle ?? { handle: "david", domain: "localhost" }) }];
  if (c.infer) names.push({ identityKey: keyBytes(c.infer), ...(c.inferHandle ?? { handle: "infer", domain: "localhost" }) });
  return {
    kind: "genesis", identity: keyBytes(c.identity), handle: c.handle, domain: c.domain, owner, programs, subscriptions,
    ...(c.infer ? { peers: { infer: keyBytes(c.infer) } } : {}),
    defaults: c.defaults ?? DEFAULTS, names, collect: ["completions"],
  };
}

/** Write the genesis into an empty store through its kernel; the entry's CID. */
export async function writeGenesis(k: Kernel, c: Genesis2Config, time: Stamp = clockNow()): Promise<CID> {
  const programs = await k.call("programs") as Record<string, CID>;
  const g = await k.store.put(genesis2(c, programs) as never);
  return await k.store.log.append(await nextEntry(k.store, { genesis: g }, time) as never);
}

/** Admit the next entry over `body` (unsigned), retrying if the tip moved under it. */
export async function admit2(k: Kernel, body: EntryBody, records: { envelope?: object; body?: Uint8Array } = {}, time: Stamp = clockNow()): Promise<CID> {
  for (let tries = 0; ; tries++) {
    try {
      return await k.admit(await nextEntry(k.store, body, time) as never, records);
    } catch (e) {
      if (!(e instanceof Rejected && e.reason === "out-of-order") || tries >= 10) throw e;
    }
  }
}

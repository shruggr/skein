// The host's side of an instance's front door (#40): an HTTP request becomes
// one kernel `call` of the front door program (fn "http"); what it answers is
// the HTTP response, and the entries it returns are admitted through the one
// call in that writes. Nothing else of a request reaches the instance's log:
// the front door verifies and signs (BRC-103/104) inside the VM, a read — a
// poll — writes nothing at all, and neither does a handshake. `then` is a
// second call, made once the admitted entries are processed (an overlay
// submit's answer, which a step computes).
//
// Sessions are not state: the front door's session table is the kernel
// process's `scratch` (kernel.ts), passed in each call's argument and changed
// by the answer's `scratch` list. This side never reads an entry of it; only
// the front door understands BRC-104. A new kernel process starts with an
// empty table, so after a restart a client's first request gets a 401 and the
// stock client shakes hands again (one round trip).

import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { encode } from "../runtime/cid.ts";
import type { Stamp } from "../runtime/syscalls.ts";
import { now as clockNow } from "./clock.ts";
import { admit2 } from "./genesis.ts";
import type { CallAnswer, Kernel } from "./kernel.ts";

/** A raw request as the front door takes it: `path` as the client signed it, `route` what the routes table sees. */
export interface FrontRequest {
  method: string;
  path: string;
  route?: string;
  query: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** An entry the front door asks the host to admit: a message (#40 `mail`) or a plain event in a box. */
export type AdmitSpec = { mail: Record<string, unknown>; body?: Uint8Array } | { event: Record<string, unknown>; box: string };

export interface FrontAnswer {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  admit?: AdmitSpec[];
  then?: { program: CID; fn: string; arg: Uint8Array };
  /** Changes to the kernel's scratch table (applied by `callFrontDoor`): no value drops the key. */
  scratch?: ScratchChange[];
  /** Fuel the call used (the ledger's), and which op it was. */
  fuel: number;
}

export interface ScratchChange { key: string; value?: Uint8Array }

/** The scratch table's hard bound (the front door keeps its own, lower): past it the oldest key goes. */
export const SCRATCH_MAX = 4096;

/** Apply a front door answer's scratch changes to the kernel's table, in order. */
export function applyScratch(table: Map<string, Uint8Array>, changes: ScratchChange[] | undefined): void {
  for (const c of changes ?? []) {
    if (typeof c?.key !== "string") continue;
    table.delete(c.key);
    if (c.value instanceof Uint8Array) table.set(c.key, c.value);
  }
  for (const k of table.keys()) { if (table.size <= SCRATCH_MAX) break; table.delete(k); }
}

/** Lower-cased header names, one value each (joined with ", "). */
export function headerMap(h: Record<string, string | string[] | undefined> | Headers): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (k: string, v: string | string[] | undefined) => { if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v; };
  if (h instanceof Headers) h.forEach((v, k) => add(k, v));
  else for (const [k, v] of Object.entries(h as Record<string, string | string[] | undefined>)) add(k, v);
  return out;
}

/**
 * One request through the front door: a kernel call with the kernel's scratch
 * table beside the request; the answer's scratch changes are applied before
 * this returns (so a handshake's session serves the very next request). Fails
 * only if the call itself fails (the front door's own error).
 */
export async function callFrontDoor(k: Kernel, req: FrontRequest, o: { now?: number; program?: CID | string } = {}): Promise<FrontAnswer> {
  const arg = { ...clean(req), scratch: Object.fromEntries(k.scratch) };
  const a: CallAnswer = await k.invoke(o.program ?? "frontdoor", "http", dagCbor.encode(arg), { now: o.now });
  if (!a.ok) {
    return { status: 500, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify({ status: "error", code: "ERR_FRONT_DOOR", description: a.error })), fuel: a.fuel };
  }
  const r = dagCbor.decode(a.result) as { status: number; headers?: Record<string, string>; body?: Uint8Array; admit?: AdmitSpec[]; then?: FrontAnswer["then"]; scratch?: ScratchChange[] };
  if (!k.gone) applyScratch(k.scratch, r.scratch);
  return { status: r.status, headers: r.headers ?? {}, body: r.body ?? new Uint8Array(), ...(r.admit ? { admit: r.admit } : {}), ...(r.then ? { then: r.then } : {}), ...(r.scratch ? { scratch: r.scratch } : {}), fuel: a.fuel };
}

/** Admit what the front door returned: put each entry's records, then the entry (in order). */
export async function admitAll(k: Kernel, admit: AdmitSpec[], now: () => Stamp = clockNow): Promise<CID[]> {
  const out: CID[] = [];
  for (const x of admit) {
    if ("event" in x) {
      const ev = await k.store.put(x.event as never);
      out.push(await admit2(k, { box: x.box, event: ev } as never, {}, now()));
    } else {
      const body = x.body ?? new Uint8Array();
      const mail = await k.store.put(x.mail as never);
      out.push(await admit2(k, { mail } as never, { body } as never, now()));
    }
  }
  return out;
}

/** A fetch over one instance's front door, no socket: for a client in a test, or a URL of the host's own. */
export function frontDoorFetch(k: Kernel, o: { now?: () => Stamp; route?: (path: string) => string; onAnswer?: (a: FrontAnswer) => void } = {}): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const req = input instanceof Request ? input : new Request(url, init);
    const body = new Uint8Array(await req.arrayBuffer());
    const fr: FrontRequest = { method: req.method, path: url.pathname, route: o.route ? o.route(url.pathname) : url.pathname, query: url.search, headers: headerMap(req.headers), body };
    const a = await callFrontDoor(k, fr);
    o.onAnswer?.(a);
    if (a.admit?.length) await admitAll(k, a.admit, o.now);
    return new Response(a.body.length ? Buffer.from(a.body) : null, { status: a.status, headers: a.headers });
  }) as typeof fetch;
}

/** Drop undefined (dag-cbor has none). */
function clean<T extends object>(v: T): T {
  return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) as T;
}

export const cidOf = (v: unknown): CID => encode(v).cid;

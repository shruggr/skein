// The host's side of an instance's front door (#68, #66): a light router.
// A request a transport carries in is appended as received — one `request`
// entry, the raw request its record (method, path, headers with the
// x-bsv-auth-* ones, body) — and nothing is verified here. The kernel steps
// the instance's middleware (the front door) on it as the request's own
// thread; the host holds the client's connection until that thread comes to
// rest for good (finished or errored, not waiting) and answers with what
// the thread's last step answered, signed on the client's session inside.
// However many entries the thread takes, the client sees one answer; past
// the wait's bound it gets 503 + Retry-After and the thread goes on.
//
// A route whose answer is a read of live state (the explorer) answers
// {read}: the thread verified it and ended, and the answer is one kernel
// `call` of the front door's fn "read", signed there (not recorded).
//
// Sessions are state (#68): the front door keeps them as records (head
// `frontdoor/sessions`); this side holds none.

import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { encode } from "../runtime/cid.ts";
import type { Stamp } from "../runtime/syscalls.ts";
import { now as clockNow } from "./clock.ts";
import { admit2 } from "./genesis.ts";
import type { Kernel, RequestAnswer } from "./kernel.ts";

/** A raw request as the host appends it: `path` as the client signed it, `route` what the routes table sees. */
export interface FrontRequest {
  method: string;
  path: string;
  route?: string;
  query: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface FrontAnswer {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  /** The request's entry and the thread it launched (absent: not processed within the wait). */
  entry?: CID;
  thread?: CID;
  /** Fuel of the read call, when the answer was one (the steps' fuel is on their updates). */
  fuel?: number;
  /**
   * A read's caller (hex): the identity the front door verified on the
   * request's thread (its answer's `read.caller`). Absent when the request
   * named none or the answer was no read.
   */
  caller?: string;
}

/** How long a synchronous client waits on its request's thread by default (ms): SKEIN_ANSWER_WAIT_MS, else two minutes. */
export const ANSWER_WAIT_MS = Number(process.env.SKEIN_ANSWER_WAIT_MS) > 0 ? Number(process.env.SKEIN_ANSWER_WAIT_MS) : 120_000;
/** The Retry-After (s) a client that waited past the bound, or met a host shutting down, is told. */
export const RETRY_AFTER_S = 5;

const jsonBody = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

/** 503 + Retry-After: the wait's bound passed (the thread goes on), or the host is shutting down. */
export function unavailable(description: string, extra: Partial<FrontAnswer> = {}): FrontAnswer {
  return { status: 503, headers: { "content-type": "application/json", "retry-after": String(RETRY_AFTER_S) }, body: jsonBody({ status: "error", code: "ERR_UNAVAILABLE", description }), ...extra };
}

/** Lower-cased header names, one value each (joined with ", "). */
export function headerMap(h: Record<string, string | string[] | undefined> | Headers): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (k: string, v: string | string[] | undefined) => { if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v; };
  if (h instanceof Headers) h.forEach((v, k) => add(k, v));
  else for (const [k, v] of Object.entries(h as Record<string, string | string[] | undefined>)) add(k, v);
  return out;
}

/** Append a package as received (#68): its record put, then one `request` entry naming it and its transport. */
export async function appendRequest(k: Kernel, transport: string, record: Record<string, unknown>, time: Stamp = clockNow()): Promise<CID> {
  const rc = await k.store.put(record as never);
  return await admit2(k, { request: rc, transport }, {}, time);
}

/** An HTTP request's record (log.zig: {kind: "http", method, path, route, query, headers, body}). */
export function httpRecord(req: FrontRequest): Record<string, unknown> {
  return { kind: "http", method: req.method, path: req.path, route: req.route ?? req.path, query: req.query, headers: req.headers, body: req.body };
}

/**
 * One HTTP request through the instance: appended, then waited on (#66)
 * until its thread comes to rest or `waitMs` passes (503 + Retry-After).
 * `stop`, when it settles first, answers 503 too (the host shutting down).
 */
export async function frontDoor(k: Kernel, req: FrontRequest, o: { now?: Stamp; waitMs?: number; stop?: Promise<unknown> } = {}): Promise<FrontAnswer> {
  const entry = await appendRequest(k, "http", httpRecord(req), o.now ?? clockNow());
  const waited = k.answer(entry, o.waitMs ?? ANSWER_WAIT_MS);
  const a = o.stop ? await Promise.race([waited, o.stop.then(() => undefined)]) : await waited;
  if (!a) return unavailable("the host is shutting down", { entry });
  return await httpAnswer(k, entry, a);
}

/** A request thread's answer as the HTTP response: its last step's, a read after it, or 500/503. */
export async function httpAnswer(k: Kernel, entry: CID, a: RequestAnswer): Promise<FrontAnswer> {
  const at = { entry, ...(a.thread ? { thread: a.thread } : {}) };
  if (a.state === "errored") return { status: 500, headers: { "content-type": "application/json" }, body: jsonBody({ status: "error", code: "ERR_FRONT_DOOR", description: a.error }), ...at };
  if (a.state !== "finished") return unavailable(`not answered yet (its thread is ${a.state}): try again`, at);
  const r = dagCbor.decode(a.answer) as { status?: number; headers?: Record<string, string>; body?: Uint8Array; read?: { caller?: unknown } };
  if (r.read !== undefined && r.status === undefined) {
    const caller = r.read?.caller instanceof Uint8Array ? { caller: Buffer.from(r.read.caller).toString("hex") } : {};
    // A read of live state (the explorer): the front door answers it as a call, and signs it there.
    const c = await k.invoke("frontdoor", "read", dagCbor.encode({ request: await requestOf(k, entry), read: r.read }));
    if (!c.ok) return { status: 500, headers: { "content-type": "application/json" }, body: jsonBody({ status: "error", code: "ERR_FRONT_DOOR", description: c.error }), fuel: c.fuel, ...caller, ...at };
    const x = dagCbor.decode(c.result) as { status: number; headers?: Record<string, string>; body?: Uint8Array };
    return { status: x.status, headers: x.headers ?? {}, body: x.body ?? new Uint8Array(), fuel: c.fuel, ...caller, ...at };
  }
  if (typeof r.status !== "number") return { status: 500, headers: { "content-type": "application/json" }, body: jsonBody({ status: "error", code: "ERR_FRONT_DOOR", description: "the request's thread ended with no answer" }), ...at };
  return { status: r.status, headers: r.headers ?? {}, body: r.body ?? new Uint8Array(), ...at };
}

/** The request record an entry names. */
async function requestOf(k: Kernel, entry: CID): Promise<CID> {
  const e = await k.store.get(entry) as { request?: CID };
  if (!e.request) throw new Error(`${entry} is not a request entry`);
  return e.request;
}

/** A fetch over one instance's front door, no socket: for a client in a test, or a URL of the host's own. */
export function frontDoorFetch(k: Kernel, o: { now?: () => Stamp; route?: (path: string) => string; onAnswer?: (a: FrontAnswer) => void; waitMs?: number } = {}): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const req = input instanceof Request ? input : new Request(url, init);
    const body = new Uint8Array(await req.arrayBuffer());
    const fr: FrontRequest = { method: req.method, path: url.pathname, route: o.route ? o.route(url.pathname) : url.pathname, query: url.search, headers: headerMap(req.headers), body };
    const a = await frontDoor(k, fr, { now: o.now?.(), waitMs: o.waitMs });
    o.onAnswer?.(a);
    return new Response(a.body.length ? Buffer.from(a.body) : null, { status: a.status, headers: a.headers });
  }) as typeof fetch;
}

export const cidOf = (v: unknown): CID => encode(v).cid;

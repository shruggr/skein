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
//
// One table (#143; docs/MESSAGES.md "The front door"). Every HTTP request
// goes to the kernel's door: its route matched (exact path, then the longest
// prefix), the route's filters run (kernel.brc104 — the session and signature
// — kernel.beef, an app's own), the gate checked. What passes is admitted —
// one entry — and its thread waited on (frontDoor). What a filter rejects or
// answers, and what the gate refuses, writes nothing: the door's answer comes
// back at once (DoorAnswered) and the front door's fn "respond" signs it on
// the request's session when the request is signed (a call: nothing logged).
// A read route — filters only, no handler — is such an answer: the host
// serves it by the door, as a call, its fuel on the host's meter. The
// handshake (/.well-known/auth) is a route of its own (the front door's).

import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { encode } from "../runtime/cid.ts";
import { stampMs } from "../runtime/log.ts";
import type { Stamp } from "../runtime/syscalls.ts";
import { now as clockNow } from "./clock.ts";
import { admit2 } from "./genesis.ts";
import { DoorAnswered, type DoorAnswer } from "./door-answer.ts";
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
  /** Fuel of the door's filters and the answering call, when the answer was the door's or a read (the steps' fuel is on their updates). */
  fuel?: number;
  /**
   * The caller (hex) of an answer the host metered: a read after the request's thread (its
   * answer's `read.caller`), or the principal the door's filters yielded for an answer it gave
   * without an entry. Absent when the request named none.
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

/**
 * Append a package as received (#68): one `request` entry naming it and its
 * transport. The record goes with the frame, not into the store (#121): the
 * kernel's door matches the route, runs its filters and the gate, and puts
 * the package as it hands it back (a BEEF's bytes never stored), so the entry
 * written — its CID, returned — may name another record than this. A package
 * the door turns away or answers writes nothing (#143): DoorAnswered.
 */
export async function appendRequest(k: Kernel, transport: string, record: Record<string, unknown>, time: Stamp = clockNow()): Promise<CID> {
  return await admit2(k, { request: cidOf(record), transport }, { request: record }, time);
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
  const now = o.now ?? clockNow();
  let entry: CID;
  try {
    entry = await appendRequest(k, "http", httpRecord(req), now);
  } catch (e) {
    if (e instanceof DoorAnswered) return await doorAnswer(k, e.answer, req, now);
    throw e;
  }
  const waited = k.answer(entry, o.waitMs ?? ANSWER_WAIT_MS);
  const a = o.stop ? await Promise.race([waited, o.stop.then(() => undefined)]) : await waited;
  if (!a) return unavailable("the host is shutting down", { entry });
  return await httpAnswer(k, entry, a, req);
}

/**
 * A request thread's answer as the HTTP response: its last step's, a read after it, or 500/503.
 * `req`, the request as received: a door refusal of a signed one is answered by the front door.
 */
export async function httpAnswer(k: Kernel, entry: CID, a: RequestAnswer, req?: FrontRequest): Promise<FrontAnswer> {
  const at = { entry, ...(a.thread ? { thread: a.thread } : {}) };
  void req;
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

/**
 * The door's answer without an entry (#143: a filter's rejection or answer — a read route's — or the
 * gate's refusal), as the HTTP response: a signed request gets it signed on its session — a
 * front-door call (fn "respond") with the request as received, at the request's time — and an
 * unsigned one, or one whose session does not verify (unknown, expired: the stock client shakes
 * hands again), gets it plain.
 */
export async function doorAnswer(k: Kernel, d: DoorAnswer, req: FrontRequest, now: Stamp = clockNow()): Promise<FrontAnswer> {
  const meter = { fuel: d.fuel, ...(d.principal ? { caller: Buffer.from(d.principal).toString("hex") } : {}) };
  const plain: FrontAnswer = d.kind === "answer"
    ? { status: d.status, headers: { ...(d.headers ?? {}), "content-type": d.type ?? d.headers?.["content-type"] ?? "application/json" }, body: d.body ?? new Uint8Array(), ...meter }
    : { status: d.status, headers: { "content-type": "application/json" }, body: jsonBody({ status: "error", code: d.code ?? "ERR_REFUSED", description: d.reason ?? "refused" }), ...meter };
  if (!isSigned(req.headers)) return plain;
  const arg = d.kind === "answer"
    ? { request: httpRecord(req), answer: { status: d.status, ...(d.type ? { type: d.type } : {}), ...(d.headers ? { headers: d.headers } : {}), body: d.body ?? new Uint8Array() } }
    : { request: httpRecord(req), refused: { status: d.status, code: d.code ?? "ERR_REFUSED", reason: d.reason ?? "refused" } };
  const c = await k.invoke("frontdoor", "respond", dagCbor.encode(arg), { now: stampMs(now) });
  if (!c.ok) return plain;
  const x = dagCbor.decode(c.result) as { status: number; headers?: Record<string, string>; body?: Uint8Array };
  return { status: x.status, headers: x.headers ?? {}, body: x.body ?? new Uint8Array(), ...meter, fuel: d.fuel + c.fuel };
}

/** The request record an entry names. */
async function requestOf(k: Kernel, entry: CID): Promise<CID> {
  const e = await k.store.get(entry) as { request?: CID };
  if (!e.request) throw new Error(`${entry} is not a request entry`);
  return e.request;
}

// ---------------------------------------------------------------- one table (#143)

/** The BRC-104 handshake's path: a route of its own (the front door's fn "handshake"). */
export const HANDSHAKE_PATH = "/.well-known/auth";

/** Whether a request carries BRC-104 headers (x-bsv-auth-*): a signed request. */
export const isSigned = (headers: Record<string, string>): boolean => Object.keys(headers).some((h) => h.toLowerCase().startsWith("x-bsv-auth-"));

/**
 * One HTTP request through the kernel's door (#143): its route's filters decide — admitted and
 * waited on, or answered at once with nothing logged (a read route; a rejection; the gate's refusal).
 */
export async function serveHttp(k: Kernel, req: FrontRequest, o: { now?: Stamp; waitMs?: number; stop?: Promise<unknown> } = {}): Promise<FrontAnswer> {
  return await frontDoor(k, req, o);
}

/** A fetch over one instance's door (serveHttp), no socket: for a client in a test, or a URL of the host's own. */
export function frontDoorFetch(k: Kernel, o: { now?: () => Stamp; route?: (path: string) => string; onAnswer?: (a: FrontAnswer) => void; waitMs?: number } = {}): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const req = input instanceof Request ? input : new Request(url, init);
    const body = new Uint8Array(await req.arrayBuffer());
    const fr: FrontRequest = { method: req.method, path: url.pathname, route: o.route ? o.route(url.pathname) : url.pathname, query: url.search, headers: headerMap(req.headers), body };
    const a = await serveHttp(k, fr, { now: o.now?.(), waitMs: o.waitMs });
    o.onAnswer?.(a);
    return new Response(a.body.length ? Buffer.from(a.body) : null, { status: a.status, headers: a.headers });
  }) as typeof fetch;
}

export const cidOf = (v: unknown): CID => encode(v).cid;

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
// Two doors (#135; docs/MESSAGES.md "The front door"). The kernel's door
// admits messages only; a read is a `call`. An HTTP request goes to one of
// them by its path (serveHttp): the instance's reads (the head `reads`,
// plan.ts READS_HEAD) and its http rows are matched together, exact paths
// first, then the longest prefix — a read and a row never share a path.
// A read wins: the front door's fn "read" runs the read's function over the
// current state (a call: no entry, nothing logged; the fuel reported for
// the host's meter), the request as received, signed or not, any method —
// a signed one verified and answered signed on its session. A row wins, or
// nothing matches: a signed request goes through the door (appended, its
// thread waited on: frontDoor). An unsigned one goes through the door only
// at an open row (sender `*`) whose filter validates the payload (#135,
// David 2026-10-07: "signed or validatable. Validated." — `beef`, every
// BUMP checked against the chain state; one that does not check is the
// door's refusal, answered plain): admitted with no sender key, answered
// plain. Any other unsigned request is answered here, 401 when a row is at
// the path (a message route: sign it), else 404 — never an entry. The
// handshake (/.well-known/auth) is the door's.

import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { encode } from "../runtime/cid.ts";
import { stampMs } from "../runtime/log.ts";
import type { Stamp } from "../runtime/syscalls.ts";
import { now as clockNow } from "./clock.ts";
import { admit2 } from "./genesis.ts";
import type { Kernel, Refusal, RequestAnswer } from "./kernel.ts";
import { READS_HEAD, type ReadEntry } from "./plan.ts";
import type { DispatchRow } from "../runtime/dispatch.ts";

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

/**
 * Append a package as received (#68): one `request` entry naming it and its
 * transport. The record goes with the frame, not into the store (#121): the
 * kernel's door verifies the sender, matches the row, runs the row's filter
 * and puts the package as it hands it back (a BEEF's bytes never stored), so
 * the entry written — its CID, returned — may name another record than this.
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
  const entry = await appendRequest(k, "http", httpRecord(req), o.now ?? clockNow());
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
  // #121: refused at the door (the middleware, or the row's filter): no thread ran; the refusal answers.
  if (a.state === "refused") return await refusalAnswer(k, entry, a.refused, req, at);
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
 * A door refusal's answer (#121, #135): a signed request gets it signed on its session — a
 * front-door call (fn "refusal") with the request as received (a filter may have rewritten the
 * record the entry names; the signature covers the bytes) at the entry's time — and an unsigned
 * one, or one whose session does not verify (unknown, expired: the stock client shakes hands
 * again), gets it plain.
 */
async function refusalAnswer(k: Kernel, entry: CID, refused: Refusal, req: FrontRequest | undefined, at: Partial<FrontAnswer>): Promise<FrontAnswer> {
  const status = refused.status ?? 400, code = refused.code ?? "ERR_REFUSED";
  const plain: FrontAnswer = { status, headers: { "content-type": "application/json" }, body: jsonBody({ status: "error", code, description: refused.reason }), ...at };
  if (!req || !Object.keys(req.headers).some((h) => h.toLowerCase().startsWith("x-bsv-auth-"))) return plain;
  const time = (await k.store.get(entry) as { time?: Stamp }).time;
  const c = await k.invoke("frontdoor", "refusal", dagCbor.encode({ request: httpRecord(req), refused: { status, code, reason: refused.reason } }), time ? { now: stampMs(time) } : {});
  if (!c.ok) return plain; // a front door pinned before fn "refusal"
  const x = dagCbor.decode(c.result) as { status: number; headers?: Record<string, string>; body?: Uint8Array };
  return { status: x.status, headers: x.headers ?? {}, body: x.body ?? new Uint8Array(), fuel: c.fuel, ...at };
}

/** The request record an entry names. */
async function requestOf(k: Kernel, entry: CID): Promise<CID> {
  const e = await k.store.get(entry) as { request?: CID };
  if (!e.request) throw new Error(`${entry} is not a request entry`);
  return e.request;
}

// ---------------------------------------------------------------- two doors (#135)

/** The BRC-104 handshake's path: the door's own, signed or not. */
export const HANDSHAKE_PATH = "/.well-known/auth";

/** Whether a request carries BRC-104 headers (x-bsv-auth-*): a signed request. */
export const isSigned = (headers: Record<string, string>): boolean => Object.keys(headers).some((h) => h.toLowerCase().startsWith("x-bsv-auth-"));

/** The door filters that prove a payload (#135; kernel-zig/src/door.zig, programs/frontdoor/gate.zig `validating`). */
export const VALIDATING_FILTERS: readonly string[] = ["beef"];

/** Whether a row admits an unsigned request (#135: signed or validated): open (sender `*`) and its filter validates the payload. */
export const validatesUnsigned = (row: DispatchRow): boolean => row.sender === "*" && VALIDATING_FILTERS.includes(String(row.filter ?? ""));

/** The reads head as last read, per kernel: its root and its reads. */
const readsSeen = new WeakMap<Kernel, { root: string; reads: ReadEntry[] }>();

/** The instance's reads (#135): the reads head's record, read again only when its root moved. */
export async function currentReads(k: Kernel): Promise<ReadEntry[]> {
  const root = await k.call("head", READS_HEAD) as CID | null;
  if (!root) return [];
  const seen = readsSeen.get(k);
  if (seen?.root === root.toString()) return seen.reads;
  const r = await k.store.get(root).catch(() => undefined) as { kind?: string; reads?: ReadEntry[] } | undefined;
  const reads = r?.kind === "reads" && Array.isArray(r.reads) ? r.reads : [];
  readsSeen.set(k, { root: root.toString(), reads });
  return reads;
}

/**
 * Where an http path goes (#135): a read or an http row, matched together as the dispatch table
 * matches its rows — exact paths first, then the longest prefix (a read and a row never share a path;
 * were one to, the read wins). Undefined: neither.
 */
export function routeOf(reads: ReadEntry[], rows: DispatchRow[], path: string): { read: ReadEntry } | { row: DispatchRow } | undefined {
  const http = rows.filter((r) => r.transport === "http");
  const exactRead = reads.find((r) => !r.prefix && r.address === path);
  if (exactRead) return { read: exactRead };
  const exactRow = http.find((r) => r.prefix !== true && r.address === path);
  if (exactRow) return { row: exactRow };
  let best: { read: ReadEntry } | { row: DispatchRow } | undefined, len = -1;
  for (const r of reads) if (r.prefix && path.startsWith(r.address) && r.address.length > len) { best = { read: r }; len = r.address.length; }
  for (const r of http) if (r.prefix === true && path.startsWith(r.address) && r.address.length > len) { best = { row: r }; len = r.address.length; }
  return best;
}

/**
 * A read served (#135): the front door's fn "read" with the request as received and the read as its
 * `match` — the read's function called over the current state; a signed request verified and its
 * answer signed on its session. Nothing is appended.
 */
export async function serveRead(k: Kernel, req: FrontRequest, read: ReadEntry, o: { now?: Stamp } = {}): Promise<FrontAnswer> {
  const c = await k.invoke("frontdoor", "read", dagCbor.encode({ request: httpRecord(req), match: read }), { now: stampMs(o.now ?? clockNow()) });
  if (!c.ok) return { status: 500, headers: { "content-type": "application/json" }, body: jsonBody({ status: "error", code: "ERR_READ", description: c.error }), fuel: c.fuel };
  const x = dagCbor.decode(c.result) as { status: number; headers?: Record<string, string>; body?: Uint8Array; caller?: Uint8Array };
  return { status: x.status, headers: x.headers ?? {}, body: x.body ?? new Uint8Array(), fuel: c.fuel, ...(x.caller instanceof Uint8Array ? { caller: Buffer.from(x.caller).toString("hex") } : {}) };
}

/**
 * One HTTP request through the two doors (#135): a read served by a call (serveRead); a signed
 * request for a row, or for nothing, through the door (frontDoor); an unsigned one through the door
 * only for an open row whose filter validates the payload (validatesUnsigned), else for a row 401,
 * for nothing 404 — answered here, nothing appended. The handshake goes to the door.
 */
export async function serveHttp(k: Kernel, req: FrontRequest, o: { now?: Stamp; waitMs?: number; stop?: Promise<unknown> } = {}): Promise<FrontAnswer> {
  const route = req.route ?? req.path;
  const signed = isSigned(req.headers);
  if (route !== HANDSHAKE_PATH) {
    const reads = await currentReads(k);
    const rows = reads.length || !signed ? (await k.dispatch()).rows : [];
    const to = routeOf(reads, rows, route);
    if (to && "read" in to) return await serveRead(k, req, to.read, o);
    if (!signed && !(to && validatesUnsigned(to.row))) {
      return to
        ? { status: 401, headers: { "content-type": "application/json" }, body: jsonBody({ status: "error", code: "ERR_UNAUTHORIZED", description: `${route}: a message route — the request is signed (BRC-104: shake hands at ${HANDSHAKE_PATH})` }) }
        : { status: 404, headers: { "content-type": "application/json" }, body: jsonBody({ status: "error", code: "ERR_NOT_FOUND", description: `nothing at ${route} (no read, no message route)` }) };
    }
  }
  return await frontDoor(k, req, o);
}


/** A fetch over one instance's two doors (serveHttp), no socket: for a client in a test, or a URL of the host's own. */
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

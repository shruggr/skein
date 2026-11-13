// The host's carrier (skein next, SPEC.md sections 2, 4 and 8): whatever brought an arrival in — an
// HTTP request, a libp2p frame, the host's own signed request, an event from its wiring — it becomes
// ONE record, and the host calls CHECK then COMMIT on the instance's worker:
//
//   request record  {kind: "request", payload: {method, path, query, headers, body}, signature?}
//                   `path` exactly as the client sent it (the kernel strips a leading
//                   `/@<its own handle>` for matching); `headers` the ones BRC-104 signs (content-type,
//                   authorization, x-bsv-* but x-bsv-auth-*): what a handler sees and what makes an
//                   identical signed request the same record; the x-bsv-auth-* headers gathered into
//                   `signature {scheme: "brc104", …}`; no auth headers: no `signature` (a content-proven
//                   row takes it, or the kernel refuses it)
//   CHECK           reads only: a refusal (nothing written) goes back as it is; a read row's answer is
//                   the answer; READY goes to COMMIT untouched
//   COMMIT          the entry written and its step run: the handler's answer, or — the handler awaits —
//                   "waiting", and its answer comes in the kernel's later `answered` notice; the
//                   client's connection is held until then (the connection is the only timer: a client
//                   that goes, or the host shutting down, ends the wait; the thread goes on)

import type { CID } from "multiformats/cid";
import type { Stamp } from "../runtime/syscalls.ts";
import { now as clockNow } from "./clock.ts";
import { brc104Headers, brc104Signature, isSigned, type Brc104Headers, type HttpAnswer } from "./brc104.ts";
import { DoorAnswered, doorAnswer, type DoorAnswer } from "./door-answer.ts";
import type { Answer, Answered, KernelSurface, RequestRecord } from "./kernel.ts";

export { DoorAnswered };

/** A request as the host takes it from a carrier: the path as sent, lower-cased headers, the body. */
export interface Payload { method: string; path: string; query: string; headers: Record<string, string>; body: Uint8Array }

/** The headers a request record carries: those BRC-104 signs (content-type, authorization, x-bsv-* but x-bsv-auth-*). */
export function payloadHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k0, v] of Object.entries(h)) {
    const k = k0.toLowerCase();
    if ((k.startsWith("x-bsv-") && !k.startsWith("x-bsv-auth")) || k === "content-type" || k === "authorization") out[k] = v;
  }
  return out;
}

/** A carrier's request as the one record (SPEC 2), with its BRC-104 headers when it is signed; a malformed signed request is a problem. */
export function requestRecord(p: Payload): { record: RequestRecord; auth?: Brc104Headers } | { problem: string } {
  const payload = { method: p.method, path: p.path, query: p.query, headers: payloadHeaders(p.headers), body: p.body };
  if (!isSigned(p.headers)) return { record: { kind: "request", payload } };
  const auth = brc104Headers(p.headers);
  if ("problem" in auth) return auth;
  return { record: { kind: "request", payload, signature: brc104Signature(auth) }, auth };
}

/** Lower-cased header names, one value each (joined with ", "). */
export function headerMap(h: Record<string, string | string[] | undefined> | Headers): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (k: string, v: string | string[] | undefined) => { if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v; };
  if (h instanceof Headers) h.forEach((v, k) => add(k, v));
  else for (const [k, v] of Object.entries(h as Record<string, string | string[] | undefined>)) add(k, v);
  return out;
}

/** What one arrival came to. */
export type Outcome =
  /** Refused at CHECK or COMMIT: nothing written. */
  | { kind: "refused"; refusal: DoorAnswer }
  /** A read row's answer (CHECK only): nothing written. */
  | { kind: "read"; answer: Answer; fuel: number; principal?: Uint8Array }
  /** Committed: the entry, and the handler's answer once its thread came to rest (state finished, errored, kernel, none). */
  | { kind: "committed"; entry: CID; state: string; thread?: CID; answer?: Answer }
  /** Committed, and the wait for its answer ended first (the client went, the host is stopping). */
  | { kind: "gone"; entry: CID };

/**
 * The `answered` notices, by entry: a COMMIT that came back "waiting" waits here for its thread's
 * answer. A notice that comes before its wait is kept (the last 256).
 */
export class Answers {
  private waiting = new Map<string, Array<(a: Answered) => void>>();
  private early = new Map<string, Answered>();

  notice(a: Answered): void {
    const k = a.entry.toString();
    const w = this.waiting.get(k);
    if (!w) {
      this.early.set(k, a);
      while (this.early.size > 256) this.early.delete(this.early.keys().next().value!);
      return;
    }
    this.waiting.delete(k);
    for (const f of w) f(a);
  }

  /** The entry's answer, or undefined when `signal` fires or `stop` settles first. */
  wait(entry: CID, o: { signal?: AbortSignal; stop?: Promise<unknown> } = {}): Promise<Answered | undefined> {
    const k = entry.toString();
    const had = this.early.get(k);
    if (had) { this.early.delete(k); return Promise.resolve(had); }
    return new Promise((resolve) => {
      let done = false;
      const finish = (a: Answered | undefined) => {
        if (done) return;
        done = true;
        const list = this.waiting.get(k);
        if (list) { const i = list.indexOf(take); if (i >= 0) list.splice(i, 1); if (!list.length) this.waiting.delete(k); }
        resolve(a);
      };
      const take = (a: Answered) => finish(a);
      let list = this.waiting.get(k);
      if (!list) this.waiting.set(k, (list = []));
      list.push(take);
      if (o.signal?.aborted) return finish(undefined);
      o.signal?.addEventListener("abort", () => finish(undefined), { once: true });
      void o.stop?.then(() => finish(undefined));
    });
  }
}

const norm = (a: unknown): Answer => {
  const x = (a ?? {}) as Record<string, unknown>;
  const body = x.body instanceof Uint8Array ? x.body : typeof x.body === "string" ? new TextEncoder().encode(x.body) : new Uint8Array();
  return {
    status: Number(x.status ?? 500), body,
    ...(typeof x.type === "string" ? { type: x.type } : {}),
    ...(x.headers && typeof x.headers === "object" && !(x.headers instanceof Uint8Array) ? { headers: x.headers as Record<string, string> } : {}),
  };
};

/**
 * One arrival through the instance (SPEC 4): CHECK, then — READY — COMMIT on the instance's worker,
 * then (a handler that awaits) the wait for its `answered` notice.
 */
export async function carry(k: KernelSurface, arrival: { request: RequestRecord } | { event: Record<string, unknown>; name: string }, o: { now?: Stamp; answers?: Answers; signal?: AbortSignal; stop?: Promise<unknown> } = {}): Promise<Outcome> {
  const c = await k.check(arrival, o.now ?? clockNow());
  if ("refused" in c) return { kind: "refused", refusal: doorAnswer(c.refused as unknown as Record<string, unknown>) };
  if ("read" in c) return { kind: "read", answer: norm(c.read.answer), fuel: Number(c.read.fuel ?? 0), ...(c.read.principal ? { principal: c.read.principal } : {}) };
  const m = await k.commit(c.ready);
  if ("refused" in m) return { kind: "refused", refusal: doorAnswer(m.refused as unknown as Record<string, unknown>) };
  const x = m.committed;
  if (x.state !== "waiting") return { kind: "committed", entry: x.entry, state: x.state, ...(x.thread ? { thread: x.thread } : {}), ...(x.answer ? { answer: norm(x.answer) } : {}) };
  if (!o.answers) return { kind: "gone", entry: x.entry };
  const a = await o.answers.wait(x.entry, { signal: o.signal, stop: o.stop });
  if (!a) return { kind: "gone", entry: x.entry };
  return { kind: "committed", entry: x.entry, state: a.state, thread: a.thread, ...(a.answer ? { answer: norm(a.answer) } : {}) };
}

const json = (status: number, v: unknown, extra: Record<string, string> = {}): HttpAnswer => ({ status, headers: { "content-type": "application/json", ...extra }, body: new TextEncoder().encode(JSON.stringify(v)) });

/** The Retry-After (s) a client told the host is shutting down gets. */
export const RETRY_AFTER_S = 5;

/** 503 + Retry-After: the host is shutting down (the thread goes on). */
export function unavailable(description: string): HttpAnswer {
  return json(503, { status: "error", code: "ERR_UNAVAILABLE", description }, { "retry-after": String(RETRY_AFTER_S) });
}

/** A handler's answer as an HTTP answer: its headers, its type as content-type. */
export function answerHttp(a: Answer): HttpAnswer {
  return { status: a.status, headers: { ...(a.headers ?? {}), ...(a.type ? { "content-type": a.type } : {}) }, body: a.body };
}

/** An outcome as the HTTP answer (unsigned: the caller signs it on the request's session). */
export function httpOf(o: Outcome): HttpAnswer {
  switch (o.kind) {
    case "refused": return json(o.refusal.status, { status: "error", code: o.refusal.code ?? "ERR_REFUSED", description: o.refusal.reason ?? "refused" });
    case "read": return answerHttp(o.answer);
    case "gone": return unavailable(`not answered before the wait ended (entry ${o.entry}): its thread goes on`);
    case "committed":
      if (o.answer) return answerHttp(o.answer);
      if (o.state === "errored") return json(500, { status: "error", code: "ERR_HANDLER", description: `the handler failed (entry ${o.entry})` });
      return { status: 204, headers: {}, body: new Uint8Array() };
  }
}

/** A refusal as the error it is for the host's own callers (admitEvent, messageLocal). */
export function refusedError(o: Extract<Outcome, { kind: "refused" }>): DoorAnswered { return new DoorAnswered(o.refusal); }

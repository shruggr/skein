// The host's broadcaster (#58, reviving #29's Arcade peer): one Arcade
// (bsv-blockchain/arcade) per host, reached by every instance through the
// router, and one status subscription for the whole host. No queue here and
// no BRC-103: the VM's `broadcast` record is the queue (docs/WALLET.md), the
// interface is the kernel's recorded `http` import, and this is a plain proxy.
//
//   POST /arc/v1/tx          an instance's broadcast: the body (an Atomic BEEF, a BEEF, or a raw
//                            transaction) goes to Arcade's POST /tx as Extended Format (the raw
//                            transaction if its inputs' sources are not in it), under the host's
//                            callback token (X-CallbackToken, X-FullStatusUpdates: true, and
//                            X-CallbackUrl when one is configured); the answer is Arcade's own —
//                            status and JSON (202 RECEIVED, the current status of a duplicate, 400
//                            with a reason, 503 + Retry-After) — so the recorded answer is a receipt
//   GET  /arc/v1/tx/<txid>   the re-ask at a deadline: Arcade's GET /tx/<txid>, answered as is
//                            (404: Arcade never saw it — the wallet posts it again)
//   POST /arc/callback       Arcade's webhook ({txid, txStatus, blockHash, blockHeight, merklePath,
//                            timestamp}), `Authorization: Bearer <the host token>`
//
// Arcade unreachable (or slow past `timeoutMs`) is answered 503 with a JSON
// body and no txStatus: to the wallet a transient failure, re-asked at its
// deadline. The paths keep ARC's `/v1/tx` shape for clients outside; the
// instances reach the same Broadcaster as the `broadcast` provider (#70).
//
// The subscription: one SSE connection to Arcade's `/events?callbackToken=`
// (every transaction submitted under the token), resumed with
// `Last-Event-ID` from the last event id taken (host.db `stream_cursor`,
// written once the event is routed), reconnecting with backoff (feeds.ts
// SseStream, the header feeds' client). Webhooks, when Arcade is given a
// callback URL, take the same path. Each status becomes the `status` record
// the wallet consumes (feeds.ts statusOf) and is admitted into box `chain`
// of **every instance whose state holds the transaction**; txid + txStatus +
// blockHash already routed (host.db `status_seen`) is not routed again.
//
// Who holds a transaction is read, never written: the kernel's `has` of the
// transaction's CID (bitcoin-tx: its txid) — a wallet holds every
// transaction it broadcast or received, an overlay every one it admitted.
// The answers are cached per txid (txid → instances): filled by the
// broadcast route (who asked) and by a sweep of every enabled instance
// (hydrated to ask) at the first status of a txid since the router started;
// a later status asks again only the running instances not yet known.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Transaction } from "@bsv/sdk";
import { DEFAULT_BOX, SseStream, statusOf } from "./feeds.ts";
import type { HostDb } from "./instances.ts";

/** The host's Arcade (host config: SKEIN_ARC_* in the environment or $SKEIN_HOME/host.env). */
export interface ArcConfig {
  /** Arcade's API, e.g. https://arcade.example.com (its POST /tx, GET /tx/:txid). */
  url: string;
  /** The host's one callback token: X-CallbackToken on every submission, the SSE stream's scope, the webhook's bearer. */
  token: string;
  /** Arcade's SSE service (its own port): default <url>/events. */
  events?: string;
  /** Where Arcade posts webhooks: a URL of this router's POST /arc/callback that Arcade can reach (Arcade wants public HTTPS). Unset: SSE only. */
  callbackUrl?: string;
}

/** The route's paths on the router. */
export const ARC_ROUTE = "/arc";

/** The host's Arcade from SKEIN_ARC_URL, SKEIN_ARC_TOKEN, SKEIN_ARC_EVENTS_URL, SKEIN_ARC_CALLBACK_URL (the environment, else $SKEIN_HOME/host.env); none without a URL. */
export function hostArcConfig(vars: Record<string, string | undefined>, home?: string): ArcConfig | undefined {
  const file: Record<string, string> = {};
  const envFile = home ? join(home, "host.env") : undefined;
  if (envFile && existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const m = /^\s*(?:export\s+)?(SKEIN_ARC_[A-Z_]+)=(.*)$/.exec(line);
      if (m) file[m[1]!] = m[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
    }
  }
  const get = (k: string) => vars[k] || file[k] || undefined;
  const url = get("SKEIN_ARC_URL");
  if (!url) return undefined;
  const token = get("SKEIN_ARC_TOKEN");
  if (!token) throw new Error("SKEIN_ARC_URL is set but SKEIN_ARC_TOKEN is not: the host's callback token scopes its status stream");
  const events = get("SKEIN_ARC_EVENTS_URL"), callbackUrl = get("SKEIN_ARC_CALLBACK_URL");
  return { url: url.replace(/\/+$/, ""), token, ...(events ? { events } : {}), ...(callbackUrl ? { callbackUrl } : {}) };
}

export interface ArcAnswer { status: number; headers: Record<string, string>; body: Uint8Array }

export interface BroadcasterOptions {
  arc: ArcConfig;
  db: HostDb;
  /** Admit a status record into `handle`'s box (Router.admitEvent). */
  admit(handle: string, box: string, event: Record<string, unknown>): Promise<unknown>;
  /** The instances a transaction may be in: every enabled row, and those whose kernel runs now. */
  instances(): { all: string[]; running: string[] };
  /** Whether `handle`'s state holds the transaction (a read), hydrating it if it is not running. */
  holds(handle: string, txid: string): Promise<boolean>;
  log?(source: string, line: string): void;
  fetch?: typeof fetch;
  /** SSE reconnect backoff, ms (default 500 → 30 000). */
  backoff?: { min: number; max: number };
  /** How long a call to Arcade may take (default 30 000 ms). */
  timeoutMs?: number;
  /** Transactions whose holders are cached (default 100 000; the oldest go first). */
  maxKnown?: number;
}

const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const json = (status: number, v: unknown, headers: Record<string, string> = {}): ArcAnswer => ({ status, headers: { "content-type": "application/json", ...headers }, body: enc(v) });
const TXID = /^[0-9a-f]{64}$/;

/** The transaction a broadcast body carries (Atomic BEEF, BEEF, raw), and the bytes to post to Arcade: Extended Format when its inputs' sources are there. */
export function arcadeBody(body: Uint8Array): { txid?: string; bytes: Uint8Array } {
  const bytes = [...body];
  let tx: Transaction | undefined;
  for (const parse of [() => Transaction.fromAtomicBEEF(bytes), () => Transaction.fromBEEF(bytes)]) {
    try { tx = parse(); break; } catch { /* the next form */ }
  }
  if (!tx) {
    try { return { txid: Transaction.fromBinary(bytes).id("hex"), bytes: body }; } catch { return { bytes: body }; }
  }
  try { return { txid: tx.id("hex"), bytes: Uint8Array.from(tx.toEF()) }; } catch { return { txid: tx.id("hex"), bytes: Uint8Array.from(tx.toBinary()) }; }
}

export class Broadcaster {
  readonly o: BroadcasterOptions;
  /** txid → the instances known to hold it, and whether every enabled instance was asked. */
  private known = new Map<string, { handles: Set<string>; swept: boolean }>();
  /** Statuses being routed now (txid + key): a webhook and the stream delivering the same one route it once. */
  private inflight = new Map<string, Promise<number>>();
  private stream?: SseStream;
  /** Counts (tests, the log): statuses routed, redeliveries dropped, admissions. */
  readonly stats = { routed: 0, duplicates: 0, admitted: 0 };

  constructor(o: BroadcasterOptions) { this.o = o; }

  private say(source: string, line: string): void { this.o.log?.(source, line); }

  /** Arcade's SSE service for the host's token. */
  eventsUrl(): string { return this.o.arc.events ?? `${this.o.arc.url}/events`; }

  /** Open the subscription (resuming after the last event id taken). */
  start(): void {
    if (this.stream) return;
    const key = this.eventsUrl();
    const url = new URL(key);
    url.searchParams.set("callbackToken", this.o.arc.token);
    this.stream = new SseStream(url.toString(), async (ev) => {
      if (ev.event === undefined || ev.event === "status" || ev.event === "message") {
        let v: unknown;
        try { v = JSON.parse(ev.data); } catch { this.say("router", `arcade: an event that is not JSON: ignored`); v = undefined; }
        if (v !== undefined) await this.deliver(v, "stream");
      }
      if (ev.id !== undefined) this.o.db.setCursor(key, ev.id);
    }, { lastId: this.o.db.cursor(key), backoff: this.o.backoff, fetch: this.o.fetch, log: (l) => this.say("router", `arcade events ${key}: ${l}`) });
    this.stream.start();
  }

  async stop(): Promise<void> { await this.stream?.stop(); this.stream = undefined; }

  /** `handle` holds `txid` (it asked about it). */
  note(txid: string, handle: string): void {
    const t = txid.toLowerCase();
    let k = this.known.get(t);
    if (!k) {
      this.known.set(t, (k = { handles: new Set(), swept: false }));
      const max = this.o.maxKnown ?? 100_000;
      if (this.known.size > max) this.known.delete(this.known.keys().next().value!);
    }
    k.handles.add(handle);
  }

  /** The instances holding `txid`: the cached ones, and those a read finds (every enabled one the first time, then the running ones not known yet). */
  async holders(txid: string): Promise<string[]> {
    const k = this.known.get(txid) ?? { handles: new Set<string>(), swept: false };
    this.known.set(txid, k);
    const { all, running } = this.o.instances();
    const ask = (k.swept ? running : all).filter((h) => !k.handles.has(h));
    for (const h of ask) {
      try { if (await this.o.holds(h, txid)) k.handles.add(h); } catch (e) { this.say(h, `arcade: could not read whether it holds ${txid.slice(0, 8)}: ${(e as Error).message}`); }
    }
    k.swept = true;
    return [...k.handles].filter((h) => all.includes(h));
  }

  /** One status from Arcade (the stream's or a webhook's JSON): admitted into every instance holding the transaction, once. The number of instances it reached. */
  async deliver(v: unknown, via: "stream" | "webhook"): Promise<number> {
    const ev = statusOf(v);
    if (typeof ev === "string") { this.say("router", `arcade ${via}: not a status (${ev}): ignored`); return 0; }
    const txid = ev.txid as string;
    const key = `${String(ev.txStatus)} ${String(ev.blockHash ?? "")}`;
    const busy = this.inflight.get(`${txid} ${key}`);
    if (busy) { await busy; this.stats.duplicates++; return 0; }
    if (this.o.db.hasStatus(txid, key)) { this.stats.duplicates++; return 0; }
    const p = (async () => {
      const hs = await this.holders(txid);
      let n = 0;
      for (const h of hs) {
        try { await this.o.admit(h, DEFAULT_BOX, ev); n++; } catch (e) { this.say(h, `arcade: status ${txid.slice(0, 8)} ${String(ev.txStatus)} not admitted: ${(e as Error).message}`); }
      }
      this.o.db.markStatus(txid, key);
      this.stats.routed++;
      this.stats.admitted += n;
      this.say("router", `arcade ${via}: ${txid.slice(0, 8)} ${String(ev.txStatus)}${ev.merklePath ? " (with its merkle path)" : ""} → ${hs.length ? hs.join(", ") : "no instance holds it"}`);
      return n;
    })();
    this.inflight.set(`${txid} ${key}`, p);
    try { return await p; } finally { this.inflight.delete(`${txid} ${key}`); }
  }

  // ---------------------------------------------------------------- the route

  private async arcade(method: string, path: string, init: { headers?: Record<string, string>; body?: Uint8Array } = {}): Promise<ArcAnswer> {
    try {
      const r = await (this.o.fetch ?? fetch)(`${this.o.arc.url}${path}`, {
        method, headers: { accept: "application/json", ...init.headers }, body: init.body as BodyInit | undefined,
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 30_000),
      });
      const headers: Record<string, string> = { "content-type": r.headers.get("content-type") ?? "application/json" };
      const retry = r.headers.get("retry-after");
      if (retry) headers["retry-after"] = retry;
      return { status: r.status, headers, body: new Uint8Array(await r.arrayBuffer()) };
    } catch (e) {
      // Not Arcade's answer: a transient failure, re-asked at the deadline.
      return json(503, { status: 503, title: "Arcade unreachable", extraInfo: (e as Error).message }, { "retry-after": "1" });
    }
  }

  /** POST /arc/v1/tx: a transaction to broadcast, from instance `from` (if an instance's http). */
  async submit(body: Uint8Array, from?: string): Promise<ArcAnswer> {
    const { txid, bytes } = arcadeBody(body);
    if (txid && from) this.note(txid, from);
    const a = this.o.arc;
    const r = await this.arcade("POST", "/tx", {
      headers: {
        "content-type": "application/octet-stream", "x-callbacktoken": a.token, "x-fullstatusupdates": "true",
        ...(a.callbackUrl ? { "x-callbackurl": a.callbackUrl } : {}),
      },
      body: bytes,
    });
    this.say(from ?? "router", `broadcast ${txid ? txid.slice(0, 8) : "(not a transaction)"} → Arcade: HTTP ${r.status}${((s) => s ? ` ${s}` : "")(summary(r.body))}`);
    return r;
  }

  /** GET /arc/v1/tx/<txid>: Arcade's status of a transaction, for instance `from`. */
  async status(txid: string, from?: string): Promise<ArcAnswer> {
    const t = txid.toLowerCase();
    if (!TXID.test(t)) return json(400, { status: 400, title: "not a txid" });
    if (from) this.note(t, from);
    return await this.arcade("GET", `/tx/${t}`);
  }

  /** POST /arc/callback: Arcade's webhook, with the host token as bearer; answered once the status is routed (Arcade retries otherwise). */
  async callback(headers: Record<string, string | undefined>, raw: Uint8Array): Promise<ArcAnswer> {
    if (headers.authorization !== `Bearer ${this.o.arc.token}`) return json(401, { status: "error", code: "ERR_UNAUTHORIZED" });
    let v: unknown;
    try { v = JSON.parse(new TextDecoder().decode(raw)); } catch { return json(400, { status: "error", code: "ERR_BAD_BODY", description: "not JSON" }); }
    const ev = statusOf(v);
    if (typeof ev === "string") return json(400, { status: "error", code: "ERR_BAD_CALLBACK", description: ev });
    await this.deliver(v, "webhook");
    return json(200, { status: "success" });
  }
}

/** An Arcade answer in a few words for the log: its txStatus, else its reason / title. */
function summary(body: Uint8Array): string {
  try {
    const j = JSON.parse(new TextDecoder().decode(body.subarray(0, 4000))) as Record<string, unknown>;
    return String(j.txStatus ?? j.reason ?? j.title ?? j.extraInfo ?? "");
  } catch { return ""; }
}

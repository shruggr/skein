// The host's broadcaster (#58, #65): one Arcade (bsv-blockchain/arcade) per
// host, the wiring that carries the instances' broadcast events out and
// their transactions' proofs and statuses in. The instance never sees a URL,
// a 503 or a retry: a step emits a broadcast event (kernel `emit`, {event:
// "broadcast", tx, beef?}) and ends waiting on the transaction; the kernel
// hands the event here once the step is committed (providers.ts, transport
// `event`).
//
// Out — the durable queue (#58's): each transaction is queued in host.db
// (`broadcast_queue`, by txid: the bytes for Arcade, who broadcast it) and
// posted to Arcade's POST /tx in Extended Format (the Atomic BEEF's subject
// with its inputs' sources; the raw transaction when the event carried no
// BEEF) under the host's one callback token (X-CallbackToken,
// X-FullStatusUpdates: true, X-CallbackUrl when the host has a public
// webhook URL). Arcade's answer settles the row: a 2xx (RECEIVED, or a
// duplicate's current status) or a 4xx (a rejection) is taken as a status
// (below) and the row goes; a 5xx or no answer (backpressure, Arcade down)
// keeps it, tried again with backoff (`retry`: 1 s doubling to 5 min) until
// `giveUpMs` (a day) after it was queued. A restart picks the queue up where
// it was; a transaction queued again while queued is one row (its
// broadcasters added).
//
// In — one SSE session per host: Arcade's `/events?callbackToken=<the host
// token>` carries every transaction submitted under the token, resumed with
// `Last-Event-ID` (the last event id taken, host.db `stream_cursor`, written
// once the event is routed), reconnecting with backoff (feeds.ts SseStream);
// Arcade's webhooks, when it has a callback URL, take the same path (POST
// /arc/callback, the host token as bearer). Each status goes to **every
// instance whose state holds the transaction** (#58), two ways (#65):
//
//   a merkle path (MINED, IMMUTABLE with its BUMP)   a **proof event** in box `chain`, unsigned:
//       {kind: "proof", subject: <tx CID>, txid, path: bytes (BRC-74), blockHash?, blockHeight?}
//       — self-validating, recorded by the VM only when the path's root is its header's at that
//       height; specific wiring (this session), never an open box
//   anything else (RECEIVED, SEEN_ON_NETWORK, REJECTED, DOUBLE_SPEND_ATTEMPTED, …)
//       a **status message** from the host's status provider (providers.ts `status`): a signed
//       message, box `status`, `subject` the transaction's CID, body {kind: "status", txid,
//       txStatus, blockHash?, blockHeight?, extraInfo?} — admitted by an instance only if it
//       subscribes to that provider ({sender: <its key>, box: "status"}). Optional: an instance
//       without the subscription learns acceptance from the proof, rejection from a competing
//       proof or abandonment (docs/WALLET.md).
//
// A status already routed (txid + txStatus + blockHash, host.db
// `status_seen`) is not routed again — but Arcade's answer to a post always
// reaches the instances that broadcast it (a later broadcaster's news). Who holds a transaction is read, never
// written: the kernel's `has` of the transaction's CID (bitcoin-tx: its
// txid), cached per txid — filled by the broadcasts (who sent it) and by a
// sweep of every enabled instance (hydrated to ask) at a txid's first status
// since the router started; a later status asks again only the running
// instances not yet known.
//
// Arcade itself may later sign its statuses (a signed-message callback beside
// webhook and SSE): it would then be the status provider an instance
// subscribes to, and nothing on the instance's side changes.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Transaction } from "@bsv/sdk";
import { DEFAULT_BOX, SseStream, statusOf, txCid } from "./feeds.ts";
import type { HostDb } from "./instances.ts";

/** The host's Arcade (host config: SKEIN_ARC_* in the environment or $SKEIN_HOME/host.env). */
export interface ArcConfig {
  /** Arcade's API, e.g. https://arcade.example.com (its POST /tx). */
  url: string;
  /** The host's one callback token: X-CallbackToken on every submission, the SSE stream's scope, the webhook's bearer. */
  token: string;
  /** Arcade's SSE service (its own port): default <url>/events. */
  events?: string;
  /** Where Arcade posts webhooks: a URL of this router's POST /arc/callback that Arcade can reach (Arcade wants public HTTPS). Unset: SSE only. */
  callbackUrl?: string;
}

/** The webhook's path on the router. */
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
  /** Admit a proof event into `handle`'s box (Router.admitEvent): unsigned, self-validating. */
  admit(handle: string, box: string, event: Record<string, unknown>): Promise<unknown>;
  /** Send `handle` a status message from the host's status provider (providers.ts `status`): box `status`, `subject` the transaction's CID. */
  status(handle: string, body: Record<string, unknown>, subject: ReturnType<typeof txCid>): Promise<unknown>;
  /** The instances a transaction may be in: every enabled row, and those whose kernel runs now. */
  instances(): { all: string[]; running: string[] };
  /** Whether `handle`'s state holds the transaction (a read), hydrating it if it is not running. */
  holds(handle: string, txid: string): Promise<boolean>;
  log?(source: string, line: string): void;
  fetch?: typeof fetch;
  /** SSE reconnect backoff, ms (default 500 → 30 000). */
  backoff?: { min: number; max: number };
  /** A queued broadcast Arcade did not take: tried again after `min` ms, doubling to `max` (default 1 000 → 300 000). */
  retry?: { min: number; max: number };
  /** A queued broadcast is dropped this long after it was queued (default a day: the instance abandons it by then). */
  giveUpMs?: number;
  /** How long a call to Arcade may take (default 30 000 ms). */
  timeoutMs?: number;
  /** Transactions whose holders are cached (default 100 000; the oldest go first). */
  maxKnown?: number;
  /** The clock (ms): the queue's. */
  now?(): number;
}

const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const json = (status: number, v: unknown, headers: Record<string, string> = {}): ArcAnswer => ({ status, headers: { "content-type": "application/json", ...headers }, body: enc(v) });

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

/** A status with a merkle path as the proof event an instance records (#65), or undefined. */
export function proofOf(ev: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!(ev.merklePath instanceof Uint8Array)) return undefined;
  return {
    kind: "proof", subject: ev.subject, txid: ev.txid, path: ev.merklePath,
    ...(typeof ev.blockHash === "string" ? { blockHash: ev.blockHash } : {}), ...(typeof ev.blockHeight === "number" ? { blockHeight: ev.blockHeight } : {}),
  };
}

/** A status without a path as the status provider's message body (#65). */
export function statusBodyOf(ev: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: "status", txid: ev.txid, txStatus: ev.txStatus,
    ...(typeof ev.blockHash === "string" ? { blockHash: ev.blockHash } : {}), ...(typeof ev.blockHeight === "number" ? { blockHeight: ev.blockHeight } : {}),
    ...(typeof ev.extraInfo === "string" && ev.extraInfo ? { extraInfo: ev.extraInfo } : {}),
  };
}

export class Broadcaster {
  readonly o: BroadcasterOptions;
  /** txid → the instances known to hold it, and whether every enabled instance was asked. */
  private known = new Map<string, { handles: Set<string>; swept: boolean }>();
  /** Statuses being routed now (txid + key): a webhook and the stream delivering the same one route it once. */
  private inflight = new Map<string, Promise<number>>();
  private stream?: SseStream;
  private timer?: ReturnType<typeof setTimeout>;
  private pumping?: Promise<void>;
  private again = false;
  private stopped = false;
  /** Counts (tests, the log): statuses routed, redeliveries dropped, admissions (proofs and status messages), posts. */
  readonly stats = { routed: 0, duplicates: 0, admitted: 0, proofs: 0, statuses: 0, posted: 0 };

  constructor(o: BroadcasterOptions) { this.o = o; }

  private say(source: string, line: string): void { this.o.log?.(source, line); }
  private now(): number { return (this.o.now ?? Date.now)(); }

  /** Arcade's SSE service for the host's token. */
  eventsUrl(): string { return this.o.arc.events ?? `${this.o.arc.url}/events`; }

  /** Open the subscription (resuming after the last event id taken), and take up the queue where it was. */
  start(): void {
    this.stopped = false;
    this.kick();
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

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.pumping;
    await this.stream?.stop();
    this.stream = undefined;
  }

  /** `handle` holds `txid` (it broadcast it). */
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

  /**
   * One status from Arcade (the stream's, a webhook's, or its answer to a
   * post): routed to every instance holding the transaction, once — a proof
   * as an event, anything else as a status message. `askers` (a post's
   * broadcasters) get it even when it was routed before: Arcade's answer to
   * a duplicate is the news for an instance that broadcast it later. The
   * number of instances it reached.
   */
  async deliver(v: unknown, via: "stream" | "webhook" | "post", askers: string[] = []): Promise<number> {
    const ev = statusOf(v);
    if (typeof ev === "string") { this.say("router", `arcade ${via}: not a status (${ev}): ignored`); return 0; }
    const txid = ev.txid as string;
    const key = `${String(ev.txStatus)} ${String(ev.blockHash ?? "")}`;
    const proof = proofOf(ev);
    const send = async (hs: string[]): Promise<number> => {
      let n = 0;
      for (const h of hs) {
        try {
          if (proof) await this.o.admit(h, DEFAULT_BOX, proof);
          else await this.o.status(h, statusBodyOf(ev), txCid(txid));
          n++;
        } catch (e) { this.say(h, `arcade: ${proof ? "proof" : "status"} ${txid.slice(0, 8)} ${String(ev.txStatus)} not delivered: ${(e as Error).message}`); }
      }
      return n;
    };
    const busy = this.inflight.get(`${txid} ${key}`);
    if (busy) await busy;
    if (busy || this.o.db.hasStatus(txid, key)) {
      this.stats.duplicates++;
      if (!askers.length) return 0;
      const n = await send(askers);
      this.say("router", `arcade ${via}: ${txid.slice(0, 8)} ${String(ev.txStatus)} (routed before) → ${askers.join(", ")}, who broadcast it`);
      return n;
    }
    const p = (async () => {
      const hs = [...new Set([...(await this.holders(txid)), ...askers])];
      const n = await send(hs);
      this.o.db.markStatus(txid, key);
      this.stats.routed++;
      this.stats.admitted += n;
      if (proof) this.stats.proofs += n; else this.stats.statuses += n;
      this.say("router", `arcade ${via}: ${txid.slice(0, 8)} ${String(ev.txStatus)}${proof ? " (a proof event)" : " (a status message)"} → ${hs.length ? hs.join(", ") : "no instance holds it"}`);
      return n;
    })();
    this.inflight.set(`${txid} ${key}`, p);
    try { return await p; } finally { this.inflight.delete(`${txid} ${key}`); }
  }

  // ---------------------------------------------------------------- out: the queue

  /**
   * A broadcast event from `handle` (#65): the transaction's bytes and, if
   * the event carried it, its Atomic BEEF. Queued durably and posted; the
   * txid, or undefined when the bytes are not a transaction.
   */
  enqueue(handle: string, tx: Uint8Array, beef?: Uint8Array): string | undefined {
    let raw: string;
    try { raw = Transaction.fromBinary([...tx]).id("hex"); } catch { this.say(handle, "broadcast: the event's transaction does not parse: dropped"); return undefined; }
    // The BEEF's subject must be the transaction: else the raw transaction goes (Arcade then needs its parents).
    const fromBeef = beef ? arcadeBody(beef) : undefined;
    const bytes = fromBeef?.txid === raw ? fromBeef.bytes : tx;
    if (beef && fromBeef?.txid !== raw) this.say(handle, `broadcast ${raw.slice(0, 8)}: the event's BEEF is not of its transaction: the raw transaction goes`);
    this.note(raw, handle);
    this.o.db.queueBroadcast(raw, bytes, handle, this.now());
    this.kick();
    return raw;
  }

  /** Post what is due now, then wait for the next. */
  private kick(): void {
    if (this.stopped) return;
    if (this.pumping) { this.again = true; return; }
    this.pumping = this.pump().catch((e) => this.say("router", `broadcast queue: ${(e as Error).message}`)).finally(() => {
      this.pumping = undefined;
      if (this.again) { this.again = false; this.kick(); }
    });
  }

  private async pump(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const row of this.o.db.dueBroadcasts(this.now())) {
      if (this.stopped) return;
      await this.post(row);
    }
    const next = this.o.db.nextBroadcastAt();
    if (next !== undefined && !this.stopped) this.timer = setTimeout(() => this.kick(), Math.min(2 ** 31 - 1, Math.max(0, next - this.now()) + 1));
  }

  private async post(row: { txid: string; body: Uint8Array; instances: string[]; attempts: number; since: number }): Promise<void> {
    for (const h of row.instances) this.note(row.txid, h);
    const from = row.instances[0] ?? "router";
    const a = this.o.arc;
    const r = await this.arcade("POST", "/tx", {
      headers: {
        "content-type": "application/octet-stream", "x-callbacktoken": a.token, "x-fullstatusupdates": "true",
        ...(a.callbackUrl ? { "x-callbackurl": a.callbackUrl } : {}),
      },
      body: row.body,
    });
    this.stats.posted++;
    const what = summary(r.body);
    this.say(from, `broadcast ${row.txid.slice(0, 8)} → Arcade: ${r.status ? `HTTP ${r.status}` : "no answer"}${what ? ` ${what}` : ""}`);
    if (r.status >= 200 && r.status < 500 && r.status !== 408 && r.status !== 425 && r.status !== 429) {
      // Taken (or a duplicate's current status) or refused: the row goes, and the answer is a status.
      this.o.db.unqueueBroadcast(row.txid);
      let v: Record<string, unknown> = {};
      try { v = JSON.parse(new TextDecoder().decode(r.body)) as Record<string, unknown>; } catch { /* no JSON: below */ }
      const reason = [v.reason, v.extraInfo, v.detail, v.title].find((x) => typeof x === "string" && x) as string | undefined;
      const status = r.status < 300
        ? { ...v, txid: row.txid, txStatus: typeof v.txStatus === "string" && v.txStatus ? v.txStatus : "RECEIVED" }
        : { txid: row.txid, txStatus: typeof v.txStatus === "string" && v.txStatus ? v.txStatus : "REJECTED", ...(reason ? { extraInfo: reason } : {}) };
      await this.deliver(status, "post", row.instances);
      return;
    }
    // Not taken (backpressure, unreachable): tried again later, until given up.
    const at = this.now();
    if (at - row.since >= (this.o.giveUpMs ?? 86_400_000)) {
      this.o.db.unqueueBroadcast(row.txid);
      this.say(from, `broadcast ${row.txid.slice(0, 8)}: Arcade did not take it in ${Math.round((at - row.since) / 1000)} s: dropped (the instance abandons it)`);
      return;
    }
    const { min, max } = this.o.retry ?? { min: 1000, max: 300_000 };
    const wait = Math.min(max, min * 2 ** Math.min(row.attempts, 30));
    const retryAfter = Number(r.headers["retry-after"]);
    this.o.db.retryBroadcast(row.txid, at + Math.max(wait, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0), `${r.status || "no answer"} ${what}`.trim());
  }

  /** Whether a post (and the routing of its answer) is under way. */
  busy(): boolean { return this.pumping !== undefined; }

  /** Until the posts under way, and the routing of their answers, are done (tests, the corpus: Router.settled). */
  async idle(): Promise<void> {
    while (this.pumping) await this.pumping;
  }

  /** The queue as it stands (tests, the log). */
  queued(): Array<{ txid: string; attempts: number; next: number }> { return this.o.db.broadcasts().map(({ txid, attempts, next }) => ({ txid, attempts, next })); }

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
      // No answer: not taken, tried again.
      return json(0, { title: "Arcade unreachable", extraInfo: (e as Error).message });
    }
  }

  // ---------------------------------------------------------------- the webhook

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

// Billing (#130), the host's side. The kernel meters what is in its log and
// prepays the host block by block from the instance's own wallet
// (kernel-zig/src/billing.zig, scheduler.zig billingAfter); the host:
//
//   terms     its key (a child of the master secret: provider key `billing`) and what it supports
//             — X, the rates, its free allowance per skein, its tick interval, its grace — published
//             at /.well-known/skein-host (`billing`). The owner grants them as the host row, a kernel
//             row of the skein's dispatch table (`skein plan host`): no row, nothing is billed, the
//             skein is served as before; a row naming another key or lower rates (or X) than this
//             host's: it stops serving (the gate).
//   meter     what never reaches the log: the fuel of the read calls it makes (the explorer's reads,
//             frontdoor.ts) and the bytes it serves, per instance, since its last tick; each a line
//             of its log for the period.
//   tick      every tickMs (and at once for a skein whose host row it has not ticked yet, and early
//             when what it holds unreported would take the tally to the allocation): a message
//             signed by its key, in the host row's box — {kind: "tick", at, allowance, fuel, served,
//             log: <the CID of its log record for the period>} — the period's record kept in host.db.
//   payment   the wallet's `payment` event (the pay step's): kept in host.db and broadcast (its
//             Arcade), the output checked against the BRC-29 key the remittance derives.
//   the gate  asleep (the kernel's billing state says so: consumed ≥ allocation and nothing paid) or
//             the terms not this host's: nothing is forwarded to the instance — a request is 402,
//             a libp2p message ignored, a provider's answer, a feed's event dropped — but a payment
//             for it (POST /fund/<handle> on the host's origin, handed in on the funding row,
//             FUND_ROUTE, a message: signed with the host's billing key over a BRC-104 session, #135) and its own messages to itself (the loopback: its wallet's ingest at the
//             chain app). No tick is sent; the tally is frozen in the kernel.
//   grace     when it went asleep is in host.db; past the grace the host may reclaim it
//             (`skein-host reclaim`): disabled, its row and store removed. Nothing does it on its own.
//
// Amounts: X, the allowance and payments in satoshis; the tally in nanosatoshis (a bigint here).

import type { CID } from "multiformats/cid";
import { encode } from "../runtime/cid.ts";
import type { DispatchRow } from "../runtime/dispatch.ts";

/** The kernel's head (billing.zig HEAD). */
export const BILLING_HEAD = "billing";
/** The host row's kernel operation. */
export const TICK_OP = "tick";
/** The host row's box by convention (the row's address is what a tick goes to). */
export const BILLING_BOX = "billing";
/** The funding row's path in an instance (the default image's: the wallet's fn `fund`, the `beef` filter). */
export const FUND_ROUTE = "/wallet/fund";
/** The host's funding endpoint: POST <the host's origin>/fund/<handle>. */
export const FUND_PREFIX = "/fund/";
/** The header carrying BRC-100 internalizeAction outputs (JSON) with a funding: the public one, at POST /fund/<handle>. */
export const OUTPUTS_HEADER = "x-skein-outputs";
export const DESCRIPTION_HEADER = "x-skein-description";
/**
 * #135: the same headers as the host hands a funding in, on its BRC-104 session (signed with its
 * billing key) to the funding row — x-bsv-*, so the session's signature covers them (the SDK's
 * AuthFetch signs those); the wallet's `fund` reads these.
 */
export const SIGNED_OUTPUTS_HEADER = "x-bsv-skein-outputs";
export const SIGNED_DESCRIPTION_HEADER = "x-bsv-skein-description";
export const NSAT = 1_000_000_000n;

export const RATE_NAMES = ["fuel", "storage", "served", "fetch", "authfetch", "publish"] as const;
export type RateName = typeof RATE_NAMES[number];
/**
 * The rates, whole sats: fuel per 10^9 fuel; storage per 10^6 bytes held a day; served per 10^6
 * bytes served; fetch, authfetch and publish per event (billing.zig).
 */
export type Rates = Record<RateName, number>;

/** What this host supports. */
export interface BillingConfig {
  /** The block a skein prepays at a time (sats). */
  x: number;
  rates: Rates;
  /** The free allowance per skein (sats): its allocation before any payment. */
  allowance: number;
  /** How often it ticks a billed skein (ms). */
  tickMs: number;
  /** How long after a skein went asleep it may be reclaimed (ms). */
  graceMs: number;
}

/** Small dev defaults (#130 decided, "Numbers": configuration; real numbers later). */
export const DEV_BILLING: BillingConfig = {
  x: 1_000,
  rates: { fuel: 1, storage: 1, served: 1, fetch: 1, authfetch: 1, publish: 1 },
  allowance: 10_000,
  tickMs: 60_000,
  graceMs: 7 * 86_400_000,
};

/**
 * The host's billing from its environment: SKEIN_BILLING=off for none; else DEV_BILLING with
 * SKEIN_BILLING_X, SKEIN_BILLING_RATES (JSON {fuel, storage, served, fetch, authfetch, publish}),
 * SKEIN_BILLING_ALLOWANCE, SKEIN_BILLING_TICK_MS, SKEIN_BILLING_GRACE_MS over it.
 */
export function billingConfig(v: Record<string, string | undefined>): BillingConfig | undefined {
  if (v.SKEIN_BILLING === "off" || v.SKEIN_BILLING === "0") return undefined;
  const num = (name: string, d: number) => {
    const s = v[name];
    if (s === undefined || s === "") return d;
    const n = Number(s);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name}: a whole number, not ${s}`);
    return n;
  };
  let rates = DEV_BILLING.rates;
  if (v.SKEIN_BILLING_RATES) {
    const r = JSON.parse(v.SKEIN_BILLING_RATES) as Record<string, unknown>;
    rates = { ...rates };
    for (const [k, x] of Object.entries(r)) {
      if (!(RATE_NAMES as readonly string[]).includes(k) || typeof x !== "number" || !Number.isSafeInteger(x) || x < 0) throw new Error(`SKEIN_BILLING_RATES: ${k}: a rate is one of ${RATE_NAMES.join(", ")}, a whole number of sats`);
      rates[k as RateName] = x;
    }
  }
  const x = num("SKEIN_BILLING_X", DEV_BILLING.x);
  if (x < 1) throw new Error("SKEIN_BILLING_X: at least 1 sat");
  return { x, rates, allowance: num("SKEIN_BILLING_ALLOWANCE", DEV_BILLING.allowance), tickMs: Math.max(1, num("SKEIN_BILLING_TICK_MS", DEV_BILLING.tickMs)), graceMs: num("SKEIN_BILLING_GRACE_MS", DEV_BILLING.graceMs) };
}

const hexOf = (k: unknown): string | undefined => k instanceof Uint8Array ? Buffer.from(k).toString("hex") : typeof k === "string" && /^0[23][0-9a-f]{64}$/.test(k) ? k : undefined;
const whole = (n: unknown): number | undefined => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : typeof n === "bigint" && n >= 0n && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : undefined;

/** The host row's terms: the host's key (hex), X, the rates, the box ticks go to. */
export interface Terms { host: string; x: number; rates: Rates; address: string }

/** The host row (billing.zig termsOf): the first kernel row whose fn is `tick`, in table order. */
export function termsOf(rows: DispatchRow[]): Terms | undefined {
  for (const r of rows) {
    if (r.program !== "kernel" || r.fn !== TICK_OP) continue;
    const host = hexOf(r.sender);
    const x = whole(r.x);
    if (!host || !x) return undefined;
    const rates = Object.fromEntries(RATE_NAMES.map((n) => [n, 0])) as Rates;
    const given = r.rates;
    if (given && typeof given === "object") for (const n of RATE_NAMES) { const v = whole((given as Record<string, unknown>)[n]); if (v !== undefined) rates[n] = v; }
    return { host, x, rates, address: r.address };
  }
  return undefined;
}

/** Why the terms are not what this host (key `host`) supports (undefined: they are): another key, X or a rate below its own. */
export function mismatch(cfg: BillingConfig, host: string, t: Terms): string | undefined {
  if (t.host !== host) return `the host row names ${t.host.slice(0, 8)}…, not this host's key ${host.slice(0, 8)}…`;
  if (t.x < cfg.x) return `x ${t.x} is below this host's ${cfg.x}`;
  for (const n of RATE_NAMES) if (t.rates[n] < cfg.rates[n]) return `the ${n} rate ${t.rates[n]} is below this host's ${cfg.rates[n]}`;
  return undefined;
}

/** The kernel's billing state (the head `billing`'s record), as the host reads it. */
export interface BillingState { host: string; allowance: bigint; paid: bigint; tally: bigint; lastTick: number; ticks: number; bytes: number; payments: number; asleep: boolean }

const big = (n: unknown): bigint | undefined => typeof n === "bigint" ? n : typeof n === "number" && Number.isSafeInteger(n) ? BigInt(n) : undefined;

export function stateOf(rec: unknown): BillingState | undefined {
  const r = rec as Record<string, unknown> | undefined;
  if (!r || r.kind !== "billing") return undefined;
  const host = hexOf(r.host);
  const [allowance, paid, tally] = [big(r.allowance), big(r.paid), big(r.tally)];
  if (!host || allowance === undefined || paid === undefined || tally === undefined || typeof r.asleep !== "boolean") return undefined;
  return { host, allowance, paid, tally, lastTick: Number(r.lastTick), ticks: Number(r.ticks), bytes: Number(r.bytes), payments: Number(r.payments), asleep: r.asleep };
}

/** What the instance may consume (nanosats). */
export const allocation = (s: BillingState): bigint => (s.allowance + s.paid) * NSAT;

/** The host's amounts at the rates (nanosats): billing.zig priceHost. */
export const priceHost = (r: Rates, fuel: number, served: number): bigint => BigInt(fuel) * BigInt(r.fuel) + BigInt(served) * BigInt(r.served) * 1000n;

/** One line of the host's log for a period: a read call, or a response served. */
export interface LogLine { at: number; op: string; caller?: string; fuel: number; bytes: number }

/** What the host has metered for an instance since its last tick. */
export class Period {
  since: number;
  fuel = 0;
  served = 0;
  lines: LogLine[] = [];
  constructor(since: number) { this.since = since; }
  add(l: LogLine): void {
    this.fuel += l.fuel;
    this.served += l.bytes;
    this.lines.push(l);
  }
  get empty(): boolean { return this.lines.length === 0; }
}

/**
 * The period's record — {kind: "host-log", instance: <its identity>, from, to, lines: [{at, op,
 * caller?, fuel, bytes}]} — and its CID, which the tick commits to (`log`): the host keeps the
 * record (host.db billing_ticks), so it can show what it charged.
 */
export function periodRecord(identity: string, p: Period, to: number): { record: Record<string, unknown>; bytes: Uint8Array; cid: CID } {
  const record = {
    kind: "host-log", instance: Uint8Array.from(Buffer.from(identity, "hex")), from: p.since, to,
    lines: p.lines.map((l) => ({ at: l.at, op: l.op, ...(l.caller ? { caller: Uint8Array.from(Buffer.from(l.caller, "hex")) } : {}), fuel: l.fuel, bytes: l.bytes })),
  };
  const b = encode(record);
  return { record, bytes: b.bytes, cid: b.cid };
}

/** A tick's body (billing.zig tickOf). */
export function tickBody(at: number, cfg: BillingConfig, p: Period, log: CID): Record<string, unknown> {
  return { kind: "tick", at, allowance: cfg.allowance, fuel: p.fuel, served: p.served, log };
}

/** What the host knows of a billed instance after it last read it. */
export interface BillingView { terms?: Terms; state?: BillingState; mismatch?: string }

/** Why the host forwards nothing to the instance but a payment (undefined: it forwards as usual). */
export function closedBy(v: BillingView | undefined, fundAt: string): string | undefined {
  if (!v?.terms) return undefined;
  if (v.mismatch) return `this host does not serve these terms: ${v.mismatch}`;
  if (v.state?.asleep && v.state.host === v.terms.host) return `asleep: its allocation is consumed and its wallet paid nothing; a payment to it wakes it (POST ${fundAt})`;
  return undefined;
}

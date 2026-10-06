// Billing (#130), the host's side. The kernel meters what is in its log and
// prepays the host block by block from the instance's own wallet
// (kernel-zig/src/billing.zig, scheduler.zig billingAfter); the host:
//
//   pricing   only where the host defines it: `skein-host run` bills no one and publishes no terms
//             unless SKEIN_BILLING_X is set (billingConfig) — X, the rates, its free allowance per
//             skein, its grace. Its key is a child of the master secret (provider key `billing`),
//             published with the terms at /.well-known/skein-host (`billing`). The owner grants them
//             as the host row, a kernel row of the skein's dispatch table (`skein plan host`). On a
//             host that bills, a skein with no host row, or one naming another key or lower rates
//             (or X) than this host's, is not served (the gate).
//   meter     what never reaches the log: the fuel of the calls it makes for the instance (the
//             explorer's reads and the refusals' answers, frontdoor.ts; the door's `verify` at each
//             admission, which the kernel hands back) and the bytes it serves, per instance, since its
//             last attestation; each a line of its log for the period.
//   attest    no periodic message (the walk of the build): on any entry it appends for the instance
//             while it has external cost not yet reported, an attestation rides on the entry —
//             `attest: {fuel, served, log, signature}`, `log` the CID of its log record for the period
//             (kept in host.db), signed by its key for this skein (billing.zig attestedBy). Nothing is
//             attached otherwise.
//   wake      the first, when it reads a host row naming it and no billing state of its own: a
//             message from its key at the host row, {kind: "wake", allowance, received} — billing
//             starts on it. After that, after every call-in, it computes when what is outstanding —
//             storage accruing on the bytes kept, and what it has not attested — reaches the
//             allocation (dueAt) and keeps that time in host.db; when it comes, it wakes the instance
//             (the same message), and the kernel's evaluation fires the pay step. Checking the due
//             times writes and loads nothing. `received` is what it has received from the skein
//             (below): the kernel's `paid` becomes it at every wake.
//   payment   a `payment` event from the instance (its pay step's, or any app's): validated against
//             this host's key for the skein (the pre-set BRC-29 rule for the pair, hostingKey) — taken,
//             what the host internalizes — kept in host.db and broadcast (its Arcade); what Arcade says
//             of it is its status there. A rejected one is no longer received: the skein, held, sleeps
//             until a funding, after which the host's wake tells the kernel what it did receive (the
//             wake's `received`, which the kernel's `paid` becomes), and it pays again.
//   the gate  what the host serves on is what it received: the instance's allowance and every payment
//             paying its key that it took and Arcade has not rejected, against the tally it reads — not
//             the kernel's own paid / asleep. Once the tally reaches that, or with no host row or terms it does not
//             serve, nothing is forwarded to the instance — a request is 402, a libp2p message
//             ignored, a provider's answer, a feed's event dropped — but a funding (POST
//             /fund/<handle>, handed in on the funding row once Arcade accepted it, FUND_ROUTE) and
//             its own messages to itself (the loopback: its wallet's ingest at the chain app).
//   funding   POST /fund/<handle>, the body an Atomic BEEF and nothing else: its outputs must pay the
//             skein's funding key (the pre-set BRC-29 rule with counterparty anyone, fundingKey,
//             derived from its identity key); the host broadcasts it and waits for Arcade's
//             acceptance, and only then hands it in — which wakes the skein. Junk never reaches it.
//   grace     when the gate first held it unpaid is in host.db; past the grace the host may reclaim it
//             (`skein-host reclaim`): disabled, its row and store removed. Nothing does it on its own.
//
// Amounts: X, the allowance and payments in satoshis; the tally in nanosatoshis (a bigint here).

import { KeyDeriver, P2PKH, PrivateKey, type PublicKey, type Transaction, type WalletProtocol } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { encode } from "../runtime/cid.ts";
import type { DispatchRow } from "../runtime/dispatch.ts";

/** The kernel's head (billing.zig HEAD). */
export const BILLING_HEAD = "billing";
/** The host row's kernel operation (billing.zig OP): the host's wake comes in on it. */
export const BILLING_OP = "billing";
/** The host row's box by convention (the row's address is what a wake goes to). */
export const BILLING_BOX = "billing";
/** The funding row's path in an instance (the default image's: the wallet's fn `fund`, the `beef` filter). */
export const FUND_ROUTE = "/wallet/fund";
/** The host's funding endpoint: POST <the host's origin>/fund/<handle>, the body an Atomic BEEF. */
export const FUND_PREFIX = "/fund/";
export const NSAT = 1_000_000_000n;
/** The attestation's signature (billing.zig): [2, "skein billing"], key "attestation", counterparty anyone. */
export const ATTEST_PROTOCOL: WalletProtocol = [2, "skein billing"];
export const ATTEST_KEY_ID = "attestation";
/**
 * The pre-set BRC-29 derivations (programs/wallet): protocol [2, "3241645161d8"], keyID
 * "<derivationPrefix> <derivationSuffix>". A hosting payment (the skein → the host, counterparty the
 * host; the host derives with counterparty the skein): prefix base64 "skein", suffix base64 "hosting".
 * A funding (anyone → the skein, counterparty anyone): prefix base64 "skein", suffix base64 "funding".
 */
export const BRC29_PROTOCOL: WalletProtocol = [2, "3241645161d8"];
export const HOSTING_PREFIX = "c2tlaW4=", HOSTING_SUFFIX = "aG9zdGluZw==";
export const FUNDING_PREFIX = "c2tlaW4=", FUNDING_SUFFIX = "ZnVuZGluZw==";

export const RATE_NAMES = ["fuel", "storage", "served", "fetch", "authfetch", "publish"] as const;
export type RateName = typeof RATE_NAMES[number];
/**
 * The rates, whole sats: fuel per 10^9 fuel; storage per 10^6 bytes held a day; served per 10^6
 * bytes served; fetch, authfetch and publish per event (billing.zig).
 */
export type Rates = Record<RateName, number>;

/** What this host bills by: its pricing (no defaults: a host that defines none bills no one). */
export interface BillingConfig {
  /** The block a skein prepays at a time (sats). */
  x: number;
  rates: Rates;
  /** The free allowance per skein (sats): its allocation before any payment. */
  allowance: number;
  /** How long after its gate first held a skein unpaid the host may reclaim it (ms); none: `skein-host reclaim --grace`. */
  graceMs?: number;
  /** How often the host checks its computed wakes (ms; default 1000). */
  checkMs?: number;
}

/**
 * The host's pricing from its environment (#130: billing exists only where the host defines it):
 * none unless SKEIN_BILLING_X (the sats a skein prepays at a time) is set; then SKEIN_BILLING_RATES
 * (JSON {fuel, storage, served, fetch, authfetch, publish}: whole sats, a rate not given is 0),
 * SKEIN_BILLING_ALLOWANCE (the free allowance per skein, sats; 0 if not given),
 * SKEIN_BILLING_GRACE_MS (the grace; none if not given), SKEIN_BILLING_CHECK_MS.
 */
export function billingConfig(v: Record<string, string | undefined>): BillingConfig | undefined {
  if (v.SKEIN_BILLING_X === undefined || v.SKEIN_BILLING_X === "") return undefined;
  const num = (name: string): number | undefined => {
    const s = v[name];
    if (s === undefined || s === "") return undefined;
    const n = Number(s);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name}: a whole number, not ${s}`);
    return n;
  };
  const rates = Object.fromEntries(RATE_NAMES.map((n) => [n, 0])) as Rates;
  if (v.SKEIN_BILLING_RATES) {
    const r = JSON.parse(v.SKEIN_BILLING_RATES) as Record<string, unknown>;
    for (const [k, x] of Object.entries(r)) {
      if (!(RATE_NAMES as readonly string[]).includes(k) || typeof x !== "number" || !Number.isSafeInteger(x) || x < 0) throw new Error(`SKEIN_BILLING_RATES: ${k}: a rate is one of ${RATE_NAMES.join(", ")}, a whole number of sats`);
      rates[k as RateName] = x;
    }
  }
  const x = num("SKEIN_BILLING_X")!;
  if (x < 1) throw new Error("SKEIN_BILLING_X: at least 1 sat");
  const grace = num("SKEIN_BILLING_GRACE_MS"), check = num("SKEIN_BILLING_CHECK_MS");
  return { x, rates, allowance: num("SKEIN_BILLING_ALLOWANCE") ?? 0, ...(grace !== undefined ? { graceMs: grace } : {}), ...(check ? { checkMs: check } : {}) };
}

const hexOf = (k: unknown): string | undefined => k instanceof Uint8Array ? Buffer.from(k).toString("hex") : typeof k === "string" && /^0[23][0-9a-f]{64}$/.test(k) ? k : undefined;
const whole = (n: unknown): number | undefined => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : typeof n === "bigint" && n >= 0n && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : undefined;

/** The host row's terms: the host's key (hex), X, the rates, the box wakes go to. */
export interface Terms { host: string; x: number; rates: Rates; address: string }

/** The host row (billing.zig termsOf): the first kernel row whose fn is `billing`, in table order. */
export function termsOf(rows: DispatchRow[]): Terms | undefined {
  for (const r of rows) {
    if (r.program !== "kernel" || r.fn !== BILLING_OP) continue;
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
export interface BillingState { host: string; allowance: bigint; paid: bigint; tally: bigint; lastCharge: number; bytes: number; payments: number; asleep: boolean }

const big = (n: unknown): bigint | undefined => typeof n === "bigint" ? n : typeof n === "number" && Number.isSafeInteger(n) ? BigInt(n) : undefined;

export function stateOf(rec: unknown): BillingState | undefined {
  const r = rec as Record<string, unknown> | undefined;
  if (!r || r.kind !== "billing") return undefined;
  const host = hexOf(r.host);
  const [allowance, paid, tally] = [big(r.allowance), big(r.paid), big(r.tally)];
  if (!host || allowance === undefined || paid === undefined || tally === undefined || typeof r.asleep !== "boolean") return undefined;
  return { host, allowance, paid, tally, lastCharge: Number(r.lastCharge), bytes: Number(r.bytes), payments: Number(r.payments), asleep: r.asleep };
}

/** What the instance may consume as its kernel counts it (nanosats): the allowance and what its pay steps paid. */
export const allocation = (s: BillingState): bigint => (s.allowance + s.paid) * NSAT;

/** The host's amounts at the rates (nanosats): billing.zig priceHost. */
export const priceHost = (r: Rates, fuel: number, served: number): bigint => BigInt(fuel) * BigInt(r.fuel) + BigInt(served) * BigInt(r.served) * 1000n;

/** Storage for `ms` (nanosats): billing.zig priceStorage — bytes × ms × rate / 86 400, rounded down. */
export const priceStorage = (r: Rates, bytes: number, ms: number): bigint => ms <= 0 ? 0n : BigInt(bytes) * BigInt(Math.floor(ms)) * BigInt(r.storage) / 86_400n;

/**
 * When what is outstanding reaches the allocation (ms), the host's computed wake: the tally, plus
 * what the host has not attested (`owed`), plus storage accruing on the bytes kept since the last
 * charge. `now` (or earlier: due at once) when it has already; undefined when nothing accrues
 * (no storage rate, no bytes) and it has not. Asleep (the kernel paid nothing): none — a funding
 * wakes it.
 */
export function dueAt(s: BillingState, rates: Rates, owed: bigint, now: number): number | undefined {
  if (s.asleep) return undefined;
  const left = allocation(s) - s.tally - owed;
  if (left <= 0n) return now;
  const perMs = BigInt(s.bytes) * BigInt(rates.storage);
  if (perMs === 0n) return undefined;
  // bytes × ms × rate / 86 400 ≥ left  ⇔  ms ≥ left × 86 400 / (bytes × rate), rounded up.
  const ms = (left * 86_400n + perMs - 1n) / perMs;
  return Math.max(now, s.lastCharge + Number(ms > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : ms));
}

/** One line of the host's log for a period: a read call, a door's verify, a response served. */
export interface LogLine { at: number; op: string; caller?: string; fuel: number; bytes: number }

/** What the host has metered for an instance since its last attestation. */
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
  /** Lines that came in while this period was out on an entry the kernel refused: back in order. */
  absorb(later: Period): void {
    for (const l of later.lines) this.add(l);
  }
  /** Whether there is external cost to report (an amount, not merely a line). */
  get owing(): boolean { return this.fuel > 0 || this.served > 0; }
}

/**
 * The period's record — {kind: "host-log", instance: <its identity>, from, to, lines: [{at, op,
 * caller?, fuel, bytes}]} — and its CID, which the attestation commits to (`log`): the host keeps the
 * record (host.db billing_periods), so it can show what it charged.
 */
export function periodRecord(identity: string, p: Period, to: number): { record: Record<string, unknown>; bytes: Uint8Array; cid: CID } {
  const record = {
    kind: "host-log", instance: Uint8Array.from(Buffer.from(identity, "hex")), from: p.since, to,
    lines: p.lines.map((l) => ({ at: l.at, op: l.op, ...(l.caller ? { caller: Uint8Array.from(Buffer.from(l.caller, "hex")) } : {}), fuel: l.fuel, bytes: l.bytes })),
  };
  const b = encode(record);
  return { record, bytes: b.bytes, cid: b.cid };
}

/** What the attestation's signature covers (billing.zig attestationPreimage): {kind: "attestation", instance, fuel, served, log}. */
export function attestationPreimage(identity: string, fuel: number, served: number, log: CID): Uint8Array {
  return dagCbor.encode({ kind: "attestation", instance: Uint8Array.from(Buffer.from(identity, "hex")), fuel, served, log });
}

/** The skein's funding key (#130): BRC-29 by the pre-set rule, counterparty anyone — anyone derives it from the identity key. */
export function fundingKey(identity: string): PublicKey {
  return new KeyDeriver(new PrivateKey(1)).derivePublicKey(BRC29_PROTOCOL, `${FUNDING_PREFIX} ${FUNDING_SUFFIX}`, identity, false);
}

/** This host's key for the skein's hosting payments (#130): BRC-29 by the pre-set rule for the pair, counterparty the skein. */
export function hostingKey(billingKey: PrivateKey, identity: string): PrivateKey {
  return new KeyDeriver(billingKey).derivePrivateKey(BRC29_PROTOCOL, `${HOSTING_PREFIX} ${HOSTING_SUFFIX}`, identity);
}

/** The outputs of `tx` paying P2PKH to `key`, and their sats. */
export function paying(tx: Transaction, key: PublicKey): Array<{ vout: number; satoshis: number }> {
  const want = new P2PKH().lock(key.toHash()).toHex();
  const out: Array<{ vout: number; satoshis: number }> = [];
  tx.outputs.forEach((o, vout) => { if (o.lockingScript.toHex() === want) out.push({ vout, satoshis: o.satoshis ?? 0 }); });
  return out;
}

/** What the host knows of a billed instance after it last read it. */
export interface BillingView { terms?: Terms; state?: BillingState; mismatch?: string }

/**
 * Why this host forwards nothing to the instance but a funding (undefined: it forwards as usual).
 * `received`: the sats it took from the instance that Arcade has not rejected (host.db received).
 */
export function closedBy(v: BillingView | undefined, received: bigint, fundAt: string): string | undefined {
  if (!v) return undefined;
  if (!v.terms) return "no host row: this host bills every skein it serves (its owner grants it the host row: skein plan host)";
  if (v.mismatch) return `this host does not serve these terms: ${v.mismatch}`;
  const s = v.state;
  if (!s || s.host !== v.terms.host) return undefined; // billing starts with the host's first wake
  if (s.tally >= (s.allowance + received) * NSAT) return `unpaid: what it used has reached what this host received (its allowance and ${received} sats paid); a payment to it wakes it (POST ${fundAt})`;
  return undefined;
}

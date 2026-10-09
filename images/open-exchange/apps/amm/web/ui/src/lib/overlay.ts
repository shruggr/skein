/**
 * The instance client against the skein instance's AMM app routes, all
 * under one base URL (`AMM_OVERLAY`, src/lib/config.ts: the
 * app's base URL, `https://<handle>.<host>/amm` or `<host>/@<handle>/amm`):
 *
 *   GET  <base>/listTopicManagers            {tm_mandala_<txid>_<vout>: {name, shortDescription}, …}: the registered token topics
 *   GET  <base>/listLookupServiceProviders   {ls_amm: …, ls_mandala: …, ls_mandala_deploys: …}
 *   POST <base>/lookup   {service: "ls_amm", query: {tokenId, …}}   BRC-24
 *   GET  <base>/.live/tm_mandala_<txid>_0-live        [{sender, at, body, from}]: the validators beating on a
 *                                             token, kept by the runtime's liveness tool (skein#138)
 *
 * A skein takes no unsigned HTTP but GET/HEAD and the front door's `submit`
 * row: any other POST without a BRC-104 session is 401. The GETs and the
 * submit (src/lp/removeLiquidity.ts `submitToOverlay`, 0.6.3) are plain
 * `fetch`; every other POST (the lookups here) goes through the connected
 * wallet's `AuthFetch` (src/wallet/authFetch.ts), a `SignedFetch`.
 *
 * Why not the stock `@bsv/sdk` `LookupResolver` / `TopicBroadcaster`:
 *  - `LookupResolver.query`/`queryDetailed` merge output-list answers only;
 *    a freeform answer (amm-lookup's `{}` and `{outpoint}`) is dropped.
 *  - `TopicBroadcaster` refuses any topic not matching `^tm_[a-z]+(_[a-z]+)*$`
 *    of at most 50 characters, before any request; `tm_<64 hex>` fails both.
 * The page never submits anything (it broadcasts nothing), so there is no
 * submit client here.
 *
 * Names (skein-mandala docs/MANDALA.md "The topic"; programs/amm-lookup/README.md
 * "Queries"): a token's topic is `tm_mandala_<assetId>` (BRC-207; David Case,
 * 2026-10-08; skein-mandala 0.9.0), the asset id `<txid>_<vout>`, `_0`
 * included: a token deployed at output 0 is the topic `tm_mandala_<txid>_0`,
 * a BRC-161 token deployed at a non-zero output `tm_mandala_<txid>_<vout>`.
 * The old `tm_<txid>_<vout>` and the bare `tm_<txid>` are no topic. One lookup service,
 * `ls_amm`, answers for every token topic the overlay serves; each query
 * names its token (`tokenId`: `<txid>`, `<txid>_<vout>` or `<txid>.<vout>`).
 */
import type { PoolState } from "@amm-poc/matching-engine";
import { outpointText, tokenIdText } from "./tokenId";

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

export interface TokenTopic {
  /** `tm_mandala_<txid>_<vout>` (`tm_mandala_<txid>_0` at output 0). */
  topic: string;
  /** Deploy txid, 64 lowercase hex, display order. */
  txid: string;
  vout: number;
  kind: "native" | "legacy";
  /**
   * The token id, `<txid>_<vout>` (src/lib/tokenId.ts, BRC-162 "Token
   * identification"): `tm_mandala_<txid>_<vout>` → `<txid>_<vout>`, `_0`
   * included. What an `ls_amm` query names (any form).
   */
  tokenId: string;
}

/** The AMM pool lookup service (programs/amm-lookup): one service over every token topic. */
export const AMM_LOOKUP_SERVICE = "ls_amm";

const TOPIC = /^tm_mandala_([0-9a-f]{64})_(0|[1-9]\d*)$/;

/** A token topic name, `tm_mandala_<txid>_<vout>` (BRC-207), or null for anything else (the old `tm_mandala_<txid>_<vout>`, `tm_mandala`, `tm_demo`, a `-live` topic, ...). */
export function parseTokenTopic(name: string): TokenTopic | null {
  const m = TOPIC.exec(name);
  if (!m) return null;
  const txid = m[1]!;
  const vout = Number(m[2]);
  return { topic: name, txid, vout, kind: vout === 0 ? "native" : "legacy", tokenId: tokenIdText({ txid, vout }) };
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export type ServiceListing = Record<string, { name: string; shortDescription?: string }>;

/**
 * The lookup's pool record on the wire (programs/amm-lookup/README.md, "The
 * engine's PoolState shape"): JSON numbers, so they become bigints here. A
 * reserve above 2^53 would already have lost precision in `JSON.parse`; that
 * is the instance's JSON encoding (amm-lookup README), not fixed here.
 */
interface WirePoolState {
  outpoint: string;
  bsvReserve: number;
  tokenReserve: number;
  liquidityFeeBps: number;
  validationFeeBps: number;
  /** The pool's CommissionBps. Absent from a lookup that predates the commission: read as 0 (planSwap re-checks the leg against the script). */
  commissionBps?: number;
  validatorIdentityKey: string;
  lastSeen?: number;
}

export function toPoolState(raw: WirePoolState): PoolState {
  return {
    outpoint: raw.outpoint,
    bsvReserve: BigInt(raw.bsvReserve),
    tokenReserve: BigInt(raw.tokenReserve),
    liquidityFeeBps: BigInt(raw.liquidityFeeBps),
    validationFeeBps: BigInt(raw.validationFeeBps),
    commissionBps: BigInt(raw.commissionBps ?? 0),
    validatorIdentityKey: raw.validatorIdentityKey,
    ...(raw.lastSeen === undefined || raw.lastSeen === null ? {} : { lastSeen: raw.lastSeen }),
  };
}

/**
 * A `POST /lookup` freeform answer as `PoolState[]`: `{}` answers
 * `{type: "freeform", result: PoolState[]}`, `{outpoint}` answers
 * `{type: "freeform", result: {hops, current}}` (one element here). Anything
 * else is `[]`.
 */
export function parseLookupAnswer(answer: unknown): PoolState[] {
  const a = answer as { type?: string; result?: unknown } | unknown[];
  const result = Array.isArray(a) ? a : a && typeof a === "object" && a.type === "freeform" ? a.result : undefined;
  if (Array.isArray(result)) return (result as WirePoolState[]).map(toPoolState);
  if (result && typeof result === "object" && "current" in result) {
    return [toPoolState((result as { current: WirePoolState }).current)];
  }
  return [];
}

/** One output of an `output-list` answer: the BEEF holding it and its index. */
export interface LookupOutput {
  beef: number[];
  outputIndex: number;
}

/** The `{outpoint, beef: true}` answer: `{type: "output-list", outputs: [{beef: number[], outputIndex}]}`. */
export function parseOutputList(answer: unknown): LookupOutput[] {
  const a = answer as { type?: string; outputs?: unknown };
  if (!a || a.type !== "output-list" || !Array.isArray(a.outputs)) return [];
  return (a.outputs as { beef?: unknown; outputIndex?: unknown }[])
    .filter((o) => Array.isArray(o.beef) && typeof o.outputIndex === "number")
    .map((o) => ({ beef: o.beef as number[], outputIndex: o.outputIndex as number }));
}

/**
 * The liveness window, ms: a validator whose last beat is older is not offered
 * (the app's `config.overlay.market.window`, 40 s against a 30 s beat; the
 * instance's own read already keeps only the beats within its window).
 */
export const LIVE_WINDOW_MS = 40_000;

/** A validator seen beating on a token's `tm_mandala_<txid>_0-live` (the runtime's liveness read). */
export interface LiveValidator {
  identityKey: string;
  /** libp2p peer ID, text (base58): what the swap names for the relay to dial. */
  peerId: string;
  /** The beat's time, ms epoch. */
  at: number;
  ageMs: number;
  /** The beat is within the window. */
  live: boolean;
}

export interface LiveAnswer {
  now: number;
  windowMs: number;
  validators: LiveValidator[];
  /** False when the instance keeps no liveness for the topic (404: not a market for it). */
  kept: boolean;
}

/** The beacon topic of a token topic: `tm_mandala_<txid>_0` → `tm_mandala_<txid>_0-live`. */
export function liveTopicOf(topic: string): string {
  return `${topic}-live`;
}

/** `GET <base>/.live/<topic>`: the runtime's liveness read (skein docs/MESSAGES.md "Liveness (#138)"). */
export function liveUrl(base: string, liveTopic: string): string {
  return `${base.replace(/\/+$/, "")}/.live/${encodeURIComponent(liveTopic)}`;
}

/**
 * The liveness read's answer, `[{sender: <hex>, at: <ms>, body: <base64>, from: <peer ID>}]`
 * newest first, as the validators live. The beat has no body (skein-amm 0.6.0, shruggr/skein#120,
 * David 2026-10-06: "the frame carries the sender's identity key and the gossip message the peer
 * id"): the validator's identity is `sender` (the host verified the beat's signature against it)
 * and its peer ID `from`. An entry without both is skipped; the latest beat per identity is kept;
 * `live` when within `windowMs` of `now`.
 */
export function parseLiveBeats(answer: unknown, now: number, windowMs: number = LIVE_WINDOW_MS): LiveAnswer {
  const byKey = new Map<string, LiveValidator>();
  for (const x of Array.isArray(answer) ? (answer as Record<string, unknown>[]) : []) {
    if (!x || typeof x !== "object" || typeof x.sender !== "string" || !/^[0-9a-fA-F]{66}$/.test(x.sender)) continue;
    if (typeof x.from !== "string" || x.from.length === 0) continue;
    const at = typeof x.at === "number" ? x.at : 0;
    const identityKey = x.sender.toLowerCase();
    const prev = byKey.get(identityKey);
    if (prev && prev.at >= at) continue;
    const ageMs = Math.max(0, now - at);
    byKey.set(identityKey, { identityKey, peerId: x.from, at, ageMs, live: ageMs <= windowMs });
  }
  return { now, windowMs, validators: [...byKey.values()].sort((p, q) => q.at - p.at), kept: true };
}

/** No liveness kept for the topic (the read's 404). */
export function noLiveness(now: number, windowMs: number = LIVE_WINDOW_MS): LiveAnswer {
  return { now, windowMs, validators: [], kept: false };
}

/** Several topics' answers as one: the latest beat per identity. */
export function mergeLive(answers: LiveAnswer[], now: number = Date.now(), windowMs: number = LIVE_WINDOW_MS): LiveAnswer {
  const byKey = new Map<string, LiveValidator>();
  for (const a of answers) for (const v of a.validators) if (!byKey.has(v.identityKey) || byKey.get(v.identityKey)!.at < v.at) byKey.set(v.identityKey, v);
  return { now, windowMs, validators: [...byKey.values()].sort((p, q) => q.at - p.at), kept: answers.some((a) => a.kept) };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** The connected wallet's BRC-104 client (`@bsv/sdk` `AuthFetch`, or a test's fake): every POST to the instance. */
export interface SignedFetch {
  fetch(url: string, config?: { method?: string; headers?: Record<string, string>; body?: unknown }): Promise<Response>;
}

/** The signed client, or an error saying a wallet is needed (null: none connected). */
export function needSigned(af: SignedFetch | null | undefined): SignedFetch {
  if (!af) throw new Error("connect a wallet: a lookup is a POST, which the instance takes only signed (BRC-104)");
  return af;
}

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function listTopicManagers(base: string): Promise<ServiceListing> {
  return (await getJson(`${base}/listTopicManagers`)) as ServiceListing;
}

export async function listLookupServiceProviders(base: string): Promise<ServiceListing> {
  return (await getJson(`${base}/listLookupServiceProviders`)) as ServiceListing;
}

/** The token topics the instance serves, in listing order (non-token topics skipped). */
export async function listTokenTopics(base: string): Promise<TokenTopic[]> {
  const topics = await listTopicManagers(base);
  return Object.keys(topics).map(parseTokenTopic).filter((t): t is TokenTopic => t !== null);
}

/** `POST <base>/lookup {service, query}`, signed. */
export async function lookup(af: SignedFetch | null, base: string, service: string, query: Record<string, unknown>): Promise<unknown> {
  const url = `${base}/lookup`;
  const res = await needSigned(af).fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ service, query }),
  });
  if (!res.ok) throw new Error(`POST ${url}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/**
 * Every live pool of a token (`{tokenId}`) or the newest continuation of an
 * outpoint (`{tokenId, outpoint}`), from `ls_amm`. `tokenId` is the token's
 * id (`<txid>_<vout>`, `<txid>`).
 */
export async function queryPools(
  af: SignedFetch | null,
  base: string,
  tokenId: string,
  query: { outpoint: string } | Record<string, never> = {},
): Promise<PoolState[]> {
  return parseLookupAnswer(await lookup(af, base, AMM_LOOKUP_SERVICE, { tokenId, ...query }));
}

/** The pool output (or its newest continuation) with its BEEF: `{tokenId, outpoint, beef: true}`. */
export async function lookupPoolOutput(af: SignedFetch | null, base: string, tokenId: string, outpoint: string): Promise<LookupOutput> {
  const outs = parseOutputList(await lookup(af, base, AMM_LOOKUP_SERVICE, { tokenId, outpoint, beef: true }));
  if (outs.length === 0) throw new Error(`lookup ${AMM_LOOKUP_SERVICE} ${tokenId}: no output for ${outpointText(outpoint)}`);
  return outs[0]!;
}

/**
 * The validators live on a token topic (`tm_mandala_<txid>_0`): `GET <base>/.live/tm_mandala_<txid>_0-live`; a 404
 * (the instance keeps no liveness for it) is `kept: false` with none.
 */
export async function fetchLive(
  base: string,
  topic: string,
  windowMs: number = LIVE_WINDOW_MS,
  fetchFn: (url: string, init?: RequestInit) => Promise<Pick<Response, "ok" | "status" | "json" | "text">> = fetch,
): Promise<LiveAnswer> {
  const url = liveUrl(base, liveTopicOf(topic));
  const res = await fetchFn(url, { headers: { accept: "application/json" } });
  const now = Date.now();
  if (res.status === 404) return noLiveness(now, windowMs);
  if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return parseLiveBeats(await res.json(), now, windowMs);
}

/** `fetchLive` for each token topic: tokenId → its answer (or the error reading it). */
export async function fetchLiveByToken(base: string, topics: TokenTopic[], windowMs: number = LIVE_WINDOW_MS): Promise<Map<string, LiveAnswer | Error>> {
  const out = new Map<string, LiveAnswer | Error>();
  await Promise.all(
    topics.map(async (t) => {
      try {
        out.set(t.tokenId, await fetchLive(base, t.topic, windowMs));
      } catch (e) {
        out.set(t.tokenId, e instanceof Error ? e : new Error(String(e)));
      }
    }),
  );
  return out;
}

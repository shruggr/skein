/**
 * The Swap page's market view, shaped from the instance's answers (pure):
 * the token topics it serves, each token's pools from its lookup, each pool's
 * marginal price, and its validator's liveness from the runtime's liveness
 * read of the token's beacon topic (`GET <base>/.live/tm_mandala_<txid>_0-live`). Token
 * metadata (symbol, decimals, icon) comes from the wallet when it holds the
 * token's deploy output (the LP page's inventory); otherwise only the id.
 */
import type { PoolState } from "@amm-poc/matching-engine";
import type { LiveAnswer, TokenTopic } from "../lib/overlay";
import type { IconRef } from "../lp/inventory";
import { formatAmount } from "../lp/amounts";

export interface TokenMeta {
  sym?: string;
  dec?: number;
  icon?: IconRef;
}

export interface ValidatorStatus {
  identityKey: string;
  /** Its last beat on the token's `-live` topic is within the window. */
  live: boolean;
  /** Present in the token's liveness read at all. */
  seen: boolean;
  peerId?: string;
  at?: number;
  ageMs?: number;
}

export interface PoolRow {
  pool: PoolState;
  /** Marginal price, sats per token (display units when `dec` is known, else per base unit). */
  price: string;
  priceUnit: "token" | "base unit";
  validator: ValidatorStatus;
}

export interface MarketToken {
  topic: TokenTopic;
  meta?: TokenMeta;
  pools: PoolRow[];
  /** The validators live on the token (`GET <base>/.live/tm_mandala_<txid>_0-live`), or null when unread. */
  live: LiveAnswer | null;
  /** The lookup failed for this token. */
  error?: string;
  /** The liveness read failed for this token. */
  liveError?: string;
}

export const PRICE_DECIMALS = 8;

/**
 * bsvReserve / tokenReserve, in sats per display token when `dec` is known
 * (× 10^dec), as a decimal string with up to 8 places. Pre-fee: what an
 * infinitesimal swap would pay.
 */
export function marginalPrice(pool: Pick<PoolState, "bsvReserve" | "tokenReserve">, dec?: number): string {
  if (pool.tokenReserve <= 0n) return "—";
  const scale = 10n ** BigInt(PRICE_DECIMALS);
  const num = pool.bsvReserve * 10n ** BigInt(dec ?? 0) * scale;
  return formatAmount(num / pool.tokenReserve, PRICE_DECIMALS);
}

/** sats ÷ tokens (base units) as sats per display token, 8 places; "—" when either is 0. */
export function priceOf(sats: bigint, tokens: bigint, dec?: number): string {
  if (sats <= 0n || tokens <= 0n) return "—";
  return marginalPrice({ bsvReserve: sats, tokenReserve: tokens }, dec);
}

export function validatorStatus(identityKey: string, live: LiveAnswer | null): ValidatorStatus {
  const v = live?.validators.find((x) => x.identityKey === identityKey.toLowerCase());
  if (!v) return { identityKey, live: false, seen: false };
  return { identityKey, live: v.live, seen: true, peerId: v.peerId, at: v.at, ageMs: v.ageMs };
}

/** The engine's `lastSeen` from the heartbeat map (pools whose validator was never seen keep none). */
export function withLastSeen(pools: PoolState[], live: LiveAnswer | null): PoolState[] {
  return pools.map((p) => {
    const v = live?.validators.find((x) => x.identityKey === p.validatorIdentityKey.toLowerCase());
    return v ? { ...p, lastSeen: v.at } : p;
  });
}

export function buildMarketView(
  topics: TokenTopic[],
  pools: Map<string, PoolState[] | Error>,
  liveByToken: Map<string, LiveAnswer | Error>,
  meta: Map<string, TokenMeta>,
): MarketToken[] {
  return topics.map((topic) => {
    const m = meta.get(topic.tokenId);
    const answer = pools.get(topic.tokenId);
    const read = liveByToken.get(topic.tokenId);
    const live = read && !(read instanceof Error) ? read : null;
    const token: MarketToken = { topic, pools: [], live, ...(m ? { meta: m } : {}), ...(read instanceof Error ? { liveError: read.message } : {}) };
    if (answer instanceof Error) return { ...token, error: answer.message };
    const dec = m?.dec;
    token.pools = (answer ?? [])
      .map((pool) => ({
        pool,
        price: marginalPrice(pool, dec),
        priceUnit: dec === undefined ? ("base unit" as const) : ("token" as const),
        validator: validatorStatus(pool.validatorIdentityKey, live),
      }))
      // Cheapest tokens first (most tokens per sat).
      .sort((a, b) => cmpPrice(a.pool, b.pool) || a.pool.outpoint.localeCompare(b.pool.outpoint));
    return token;
  });
}

function cmpPrice(a: PoolState, b: PoolState): number {
  const l = a.bsvReserve * b.tokenReserve;
  const r = b.bsvReserve * a.tokenReserve;
  return l < r ? -1 : l > r ? 1 : 0;
}

export function shortKey(k: string): string {
  return k.length > 20 ? `${k.slice(0, 10)}…${k.slice(-6)}` : k;
}

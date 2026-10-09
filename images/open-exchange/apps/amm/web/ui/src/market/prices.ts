/**
 * Prices from the beats (skein-amm 0.9.0, David Case 2026-10-09: "Pricing
 * lives in the AMM LOOKUP's own beacon"). Every skein's `ls_amm` beats on
 * `ls_amm-live` a body (dag-cbor) carrying, per token, that skein's
 * per-validator totals of its listed pools:
 *
 *   {tokens: {<assetId>: {<validator identity, hex>: {sats, tokens, pools}}}}
 *
 * re-declared whenever it changes; a skein's liveness keeps each sender's
 * latest beat within the window. The page combines the beats it holds into a
 * token's marginal price, Σsats / Σtokens across the LIVE validators:
 *
 * - a validator is live when its own beat is held — on `ls_amm-live` or on
 *   the token's topic `tm_mandala_<assetId>-live` (every skein is a
 *   validator, beating its topics);
 * - one report per validator: its own beat's (the sender is the validator),
 *   else the newest beat naming it (several skeins may index the same pools);
 * - the depth is the sats a buy needs to move the price up by 2%, x·(√1.02 − 1),
 *   over the summed sats.
 */
import { decode } from "cbor2";
import type { Beat } from "../lib/skein";

export interface ValidatorTotals {
  sats: bigint;
  tokens: bigint;
  pools: number;
}

/** One sender's body: per token, per validator. Malformed parts are dropped. */
export function beatTotals(body: Uint8Array): Map<string, Map<string, ValidatorTotals>> {
  const out = new Map<string, Map<string, ValidatorTotals>>();
  let v: unknown;
  try {
    v = decode(body);
  } catch {
    return out;
  }
  const tokens = (v as { tokens?: unknown } | null)?.tokens;
  if (!tokens || typeof tokens !== "object") return out;
  for (const [tokenId, vals] of Object.entries(tokens as Record<string, unknown>)) {
    if (!vals || typeof vals !== "object") continue;
    const m = new Map<string, ValidatorTotals>();
    for (const [validator, t] of Object.entries(vals as Record<string, unknown>)) {
      const x = t as { sats?: unknown; tokens?: unknown; pools?: unknown };
      const num = (n: unknown) => (typeof n === "bigint" ? n : typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? BigInt(n) : null);
      const sats = num(x.sats);
      const toks = num(x.tokens);
      if (sats === null || toks === null) continue;
      m.set(validator.toLowerCase(), { sats, tokens: toks, pools: Number(num(x.pools) ?? 0n) });
    }
    if (m.size > 0) out.set(tokenId, m);
  }
  return out;
}

export interface TokenPrice {
  tokenId: string;
  /** Sats per whole token (`dec` places), Σsats / Σtokens over the live validators; null with none. */
  marginalPrice: number | null;
  depth: { bps: number; sats: bigint } | null;
  pools: number;
  reserves: { sats: bigint; tokens: bigint };
  /** The live validators counted. */
  validators: string[];
}

/** The sats a buy needs to move a constant-product price up by `bps`: x·(√(1+bps/10⁴) − 1). */
export function depthOf(sats: bigint, bps = 200): { bps: number; sats: bigint } | null {
  if (sats === 0n) return null;
  return { bps, sats: BigInt(Math.round(Number(sats) * (Math.sqrt(1 + bps / 10_000) - 1))) };
}

/**
 * Each token's price from the `ls_amm-live` beats `beats`, counting only the validators in `live`
 * (identity keys, hex: the senders of the beats held, `liveSenders`). `dec` per token (0 when unknown).
 */
export function pricesFromBeats(beats: Beat[], live: Set<string>, dec: (tokenId: string) => number = () => 0): Map<string, TokenPrice> {
  // Per token, per validator: the report chosen (own beat first, else the newest).
  const chosen = new Map<string, Map<string, { t: ValidatorTotals; own: boolean; at: number }>>();
  for (const b of beats) {
    for (const [tokenId, vals] of beatTotals(b.body)) {
      const per = chosen.get(tokenId) ?? new Map();
      chosen.set(tokenId, per);
      for (const [validator, t] of vals) {
        const own = validator === b.sender;
        const prev = per.get(validator);
        if (prev && (prev.own && !own || (prev.own === own && prev.at >= b.at))) continue;
        per.set(validator, { t, own, at: b.at });
      }
    }
  }
  const out = new Map<string, TokenPrice>();
  for (const [tokenId, per] of chosen) {
    let sats = 0n;
    let tokens = 0n;
    let pools = 0;
    const validators: string[] = [];
    for (const [validator, r] of per) {
      if (!live.has(validator)) continue;
      sats += r.t.sats;
      tokens += r.t.tokens;
      pools += r.t.pools;
      validators.push(validator);
    }
    const d = dec(tokenId);
    out.set(tokenId, {
      tokenId,
      marginalPrice: tokens > 0n ? Number(sats) / (Number(tokens) / 10 ** d) : null,
      depth: depthOf(sats),
      pools,
      reserves: { sats, tokens },
      validators: validators.sort(),
    });
  }
  return out;
}

/** The senders of the beats held (identity keys, hex): the live skeins. */
export function liveSenders(...lists: Beat[][]): Set<string> {
  const s = new Set<string>();
  for (const l of lists) for (const b of l) s.add(b.sender);
  return s;
}

/**
 * The swap form → the engine's `PlanRequest`, and the engine's `Plan` → what
 * the page shows (pure). The planning itself is the engine's (`plan`, partial
 * fills across several pools when allowed); nothing is re-derived here except
 * display numbers: per-leg fees (LP, validator, commission), effective price
 * and slippage against the mid price.
 */
import { plan as enginePlan } from "@amm-poc/matching-engine";
import type { Direction, FixedCost, Plan, PlanRequest, PoolState } from "@amm-poc/matching-engine";
import type { LiveAnswer } from "../lib/overlay";
import { FEE_RATE_SATS_PER_KB } from "../lib/config";
import { parseAmount } from "../lp/amounts";
import { priceOf, validatorStatus, withLastSeen, type ValidatorStatus } from "./view";

/**
 * Estimated miner fee per leg, in sats, for the engine's per-leg cost
 * heuristic: a swap is ~13 KB (docs/notes.md, "Publishing is part of
 * submit") at `VITE_FEE_RATE`. The exact fee of a built swap is
 * `swapFunding` (src/market/swapAction.ts).
 */
export const LEG_MINER_FEE_SATS = BigInt(Math.ceil(13 * FEE_RATE_SATS_PER_KB));

export interface SwapForm {
  direction: Direction;
  /** Sats (bsvToToken) or tokens in display units (tokenToBsv). */
  amount: string;
  slippageBps: string;
  allowPartial: boolean;
}

export type PlanInput = { ok: true; request: PlanRequest } | { ok: false; error: string };

/**
 * The pools the planner may use (0.4.0, shruggr/skein#120): those whose validator is in the token's
 * liveness read (`GET <base>/.live/tm_mandala_<txid>_0-live`) within the window. No read, none.
 */
export function livePools(pools: PoolState[], live: LiveAnswer | null): PoolState[] {
  if (!live) return [];
  return pools.filter((p) => validatorStatus(p.validatorIdentityKey, live).live);
}

/**
 * Parses the form against one token's pools; only the pools whose validator is live (`livePools`)
 * are planned. `dec` scales a token amount (base units when unknown).
 */
export function buildPlanRequest(
  tokenId: string,
  form: SwapForm,
  pools: PoolState[],
  live: LiveAnswer | null,
  dec: number | undefined,
): PlanInput {
  if (!form.amount.trim()) return { ok: false, error: "enter an amount" };
  let amountIn: bigint;
  try {
    amountIn = parseAmount(form.amount, form.direction === "bsvToToken" ? 0 : (dec ?? 0));
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (amountIn <= 0n) return { ok: false, error: "the amount must be positive" };
  let toleranceBps: bigint;
  try {
    toleranceBps = BigInt(form.slippageBps.trim() || "0");
  } catch {
    return { ok: false, error: "slippage: whole basis points" };
  }
  if (toleranceBps < 0n || toleranceBps > 10000n) return { ok: false, error: "slippage: 0-10000 bps" };
  if (pools.length === 0) return { ok: false, error: "no pools for this token" };
  const usable = livePools(pools, live);
  if (usable.length === 0) {
    return {
      ok: false,
      error: !live
        ? "no liveness read for this token: no pool can be planned"
        : !live.kept
          ? "this instance keeps no liveness for this token (its market role is off for it): no validator is known live"
          : `no pool's validator has beaten within ${Math.round(live.windowMs / 1000)} s on this token`,
    };
  }
  const fixedCost: FixedCost = { minerFeeSats: LEG_MINER_FEE_SATS };
  return {
    ok: true,
    request: {
      tokenId,
      direction: form.direction,
      amountIn,
      slippage: { toleranceBps },
      allowPartial: form.allowPartial,
      fixedCost,
      inventory: withLastSeen(usable, live),
    },
  };
}

export interface LegView {
  outpoint: string;
  pool: PoolState;
  amountIn: bigint;
  amountOut: bigint;
  lpFee: bigint;
  validatorFee: bigint;
  /** The pool's commission (CommissionBps of amountIn), in the input asset; 0 for a pool with none. */
  commission: bigint;
  validator: ValidatorStatus;
}

export interface PlanView {
  direction: Direction;
  legs: LegView[];
  totalIn: bigint;
  totalOut: bigint;
  /** In the input asset (LP and validator fees and the commission are taken from amountIn). */
  lpFees: bigint;
  validatorFees: bigint;
  commissions: bigint;
  /** Sats per display token paid (bsvToToken) or received (tokenToBsv). */
  effectivePrice: string;
  /** The best pool's marginal price, same unit. */
  midPrice: string;
  /** What the order would get at the mid price, minus what the plan gets, in bps of the former (fees included). */
  slippageVsMidBps: bigint;
  /** The engine's absolute bound (from toleranceBps against its quoted mid). */
  minAmountOut: bigint;
  meetsSlippageBound: boolean;
  filledCompletely: boolean;
  /** amountIn the plan leaves unfilled. */
  unfilled: bigint;
}

export function planView(p: Plan, inventory: PoolState[], live: LiveAnswer | null, dec: number | undefined): PlanView {
  const byOutpoint = new Map(inventory.map((x) => [x.outpoint, x]));
  const legs: LegView[] = p.legs.map((l) => {
    const pool = byOutpoint.get(l.outpoint)!;
    return {
      outpoint: l.outpoint,
      pool,
      amountIn: l.amountIn,
      amountOut: l.amountOut,
      lpFee: l.liquidityFee,
      validatorFee: l.validationFee,
      commission: l.commission,
      validator: validatorStatus(pool.validatorIdentityKey, live),
    };
  });
  const sum = (f: (l: LegView) => bigint) => legs.reduce((a, l) => a + f(l), 0n);
  const totalIn = sum((l) => l.amountIn);
  const totalOut = sum((l) => l.amountOut);
  const bsvToToken = p.direction === "bsvToToken";

  // Mid: the best pool's marginal price (most output per unit in), pre-fee.
  let best: PoolState | undefined;
  for (const x of inventory) {
    if (!best) best = x;
    else if (bsvToToken ? x.tokenReserve * best.bsvReserve > best.tokenReserve * x.bsvReserve : x.bsvReserve * best.tokenReserve > best.bsvReserve * x.tokenReserve) best = x;
  }
  let midOut = 0n;
  if (best && totalIn > 0n) midOut = bsvToToken ? (totalIn * best.tokenReserve) / best.bsvReserve : (totalIn * best.bsvReserve) / best.tokenReserve;
  const slippageVsMidBps = midOut > 0n ? ((midOut - totalOut) * 10000n) / midOut : 0n;

  return {
    direction: p.direction,
    legs,
    totalIn,
    totalOut,
    lpFees: sum((l) => l.lpFee),
    validatorFees: sum((l) => l.validatorFee),
    commissions: sum((l) => l.commission),
    effectivePrice: bsvToToken ? priceOf(totalIn, totalOut, dec) : priceOf(totalOut, totalIn, dec),
    midPrice: best ? priceOf(best.bsvReserve, best.tokenReserve, dec) : "—",
    slippageVsMidBps,
    minAmountOut: p.resolvedMinAmountOut,
    meetsSlippageBound: p.meetsSlippageBound,
    filledCompletely: p.filledCompletely,
    unfilled: p.originalAmountIn - totalIn,
  };
}

/** Plans with the engine and shapes the result. */
export function quote(request: PlanRequest, live: LiveAnswer | null, dec: number | undefined): { plan: Plan; view: PlanView } {
  const p = enginePlan(request);
  return { plan: p, view: planView(p, request.inventory, live, dec) };
}

/**
 * Races (docs/notes.md "Market UI and matching engine"): the plan's pools
 * that are no longer in a fresh lookup answer (spent by someone else's swap
 * since the plan was made). A pool's outpoint changes on every spend, so
 * "gone" is exactly "not listed".
 */
export function goneFromLookup(planned: Pick<Plan, "legs">, fresh: PoolState[]): string[] {
  const live = new Set(fresh.map((p) => p.outpoint));
  return planned.legs.map((l) => l.outpoint).filter((op) => !live.has(op));
}

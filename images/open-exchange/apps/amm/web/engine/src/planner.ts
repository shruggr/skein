import { computeSwap } from "./pricing.js";
import { planSplit, quoteMid } from "./allocation.js";
import type { Direction, FixedCost, Leg, Plan, PlanRequest, PoolState, SlippageBound } from "./types.js";

/** Applies the liveness filter (pure: caller supplies `now`, engine never reads the clock). */
export function filterLivePools(
  inventory: PoolState[],
  livenessThreshold: number | undefined,
  now: number | undefined,
): PoolState[] {
  if (livenessThreshold === undefined || now === undefined) return inventory;
  return inventory.filter((p) => p.lastSeen !== undefined && now - p.lastSeen <= livenessThreshold);
}

/**
 * Resolves a SlippageBound to a single absolute minAmountOut. When both
 * minAmountOut and toleranceBps are given, the stricter (larger) bound wins.
 * toleranceBps is measured against the "quoted mid": the unconstrained
 * optimal-split amountOut across every eligible pool right now, ignoring
 * fixed per-leg costs.
 */
export function resolveMinAmountOut(
  pools: PoolState[],
  direction: Direction,
  amountIn: bigint,
  slippage: SlippageBound,
): bigint {
  let bound = 0n;
  if (slippage.minAmountOut !== undefined && slippage.minAmountOut > bound) {
    bound = slippage.minAmountOut;
  }
  if (slippage.toleranceBps !== undefined) {
    const quote = quoteMid(pools, direction, amountIn);
    const tolerant = (quote * (10000n - slippage.toleranceBps)) / 10000n;
    if (tolerant > bound) bound = tolerant;
  }
  return bound;
}

function pickBestSingleLeg(
  pools: PoolState[],
  direction: Direction,
  amountIn: bigint,
  minAmountOut: bigint,
): Leg | null {
  let best: Leg | null = null;
  for (const pool of pools) {
    const result = computeSwap(pool, direction, amountIn);
    if (result === null) continue;
    if (minAmountOut > 0n && result.amountOut < minAmountOut) continue;
    const leg: Leg = {
      outpoint: pool.outpoint,
      amountIn,
      liquidityFee: result.liquidityFee,
      validationFee: result.validationFee,
      commission: result.commission,
      amountOut: result.amountOut,
      newBsvReserve: result.newBsvReserve,
      newTokenReserve: result.newTokenReserve,
    };
    if (
      best === null ||
      leg.amountOut > best.amountOut ||
      (leg.amountOut === best.amountOut && leg.outpoint < best.outpoint)
    ) {
      best = leg;
    }
  }
  return best;
}

/** Core planning step shared by plan() and replan(): plan `amountIn` against `pools` given an absolute minAmountOut. */
export function planOrder(
  pools: PoolState[],
  direction: Direction,
  amountIn: bigint,
  allowPartial: boolean,
  fixedCost: FixedCost,
  minAmountOut: bigint,
): Leg[] {
  if (amountIn <= 0n || pools.length === 0) return [];

  if (!allowPartial) {
    const best = pickBestSingleLeg(pools, direction, amountIn, minAmountOut);
    return best ? [best] : [];
  }

  return planSplit(pools, direction, amountIn, fixedCost);
}

/** Plans a fresh order against the given inventory. Pure, deterministic. */
export function plan(request: PlanRequest): Plan {
  const eligible = filterLivePools(request.inventory, request.livenessThreshold, request.now);
  const resolvedMinAmountOut = resolveMinAmountOut(eligible, request.direction, request.amountIn, request.slippage);

  const legs = planOrder(
    eligible,
    request.direction,
    request.amountIn,
    request.allowPartial,
    request.fixedCost,
    resolvedMinAmountOut,
  );

  const totalAmountIn = legs.reduce((a, l) => a + l.amountIn, 0n);
  const totalAmountOut = legs.reduce((a, l) => a + l.amountOut, 0n);
  const usedOutpoints = new Set(legs.map((l) => l.outpoint));
  const remainingInventory = eligible.filter((p) => !usedOutpoints.has(p.outpoint));

  return {
    legs,
    totalAmountIn,
    totalAmountOut,
    meetsSlippageBound: totalAmountOut >= resolvedMinAmountOut,
    filledCompletely: totalAmountIn === request.amountIn,
    direction: request.direction,
    allowPartial: request.allowPartial,
    fixedCost: request.fixedCost,
    livenessThreshold: request.livenessThreshold,
    now: request.now,
    originalAmountIn: request.amountIn,
    resolvedMinAmountOut,
    cumulativeFilledAmountIn: 0n,
    cumulativeFilledAmountOut: 0n,
    remainingInventory,
  };
}

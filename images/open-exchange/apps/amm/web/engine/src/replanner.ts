import { planOrder } from "./planner.js";
import type { Leg, LegResult, Plan, PoolState } from "./types.js";

/**
 * Re-plans the remainder of an order after a round of legs has been
 * attempted. Pure and deterministic: no clock, no randomness, ties broken
 * by outpoint.
 *
 * Semantics for each leg result:
 *  - filled: locked in. Its amountIn/amountOut count toward the order's
 *    cumulative fill and its pool is gone (spent).
 *  - rejected with newPoolState: the pool is still available, re-priced
 *    from the validator's returned state, and stays a candidate.
 *  - rejected with no newPoolState, or timeout, or a leg with no matching
 *    result at all: the pool's true state is unknown (it may have raced
 *    with another swap), so it is conservatively dropped from the
 *    candidate set rather than retried against stale reserves.
 *
 * The slippage budget is cumulative across rounds: resolvedMinAmountOut
 * (fixed at the first plan() call) applies to the whole order, and each
 * round only needs to cover what filled legs haven't already delivered.
 *
 * Stops (returns a plan with empty legs) once the order is fully filled,
 * or once nothing eligible remains for the remainder.
 */
export function replan(plan: Plan, results: LegResult[]): Plan {
  const resultByOutpoint = new Map(results.map((r) => [r.outpoint, r] as const));

  let filledIn = 0n;
  let filledOut = 0n;
  const repriced: PoolState[] = [];

  for (const leg of plan.legs) {
    const result = resultByOutpoint.get(leg.outpoint);
    if (result === undefined) continue; // unknown outcome: drop, conservative
    if (result.status === "filled") {
      filledIn += leg.amountIn;
      filledOut += leg.amountOut;
    } else if (result.status === "rejected" && result.newPoolState) {
      repriced.push(result.newPoolState);
    }
    // rejected without newPoolState, or timeout: pool dropped (unknown state)
  }

  const nextInventory = [...plan.remainingInventory, ...repriced];

  const cumulativeFilledAmountIn = plan.cumulativeFilledAmountIn + filledIn;
  const cumulativeFilledAmountOut = plan.cumulativeFilledAmountOut + filledOut;
  const remainder = plan.originalAmountIn - cumulativeFilledAmountIn;
  const remainingMinAmountOut =
    plan.resolvedMinAmountOut > cumulativeFilledAmountOut
      ? plan.resolvedMinAmountOut - cumulativeFilledAmountOut
      : 0n;

  const base = {
    direction: plan.direction,
    allowPartial: plan.allowPartial,
    fixedCost: plan.fixedCost,
    livenessThreshold: plan.livenessThreshold,
    now: plan.now,
    originalAmountIn: plan.originalAmountIn,
    resolvedMinAmountOut: plan.resolvedMinAmountOut,
    cumulativeFilledAmountIn,
    cumulativeFilledAmountOut,
  };

  if (remainder <= 0n) {
    return {
      ...base,
      legs: [],
      totalAmountIn: 0n,
      totalAmountOut: 0n,
      meetsSlippageBound: cumulativeFilledAmountOut >= plan.resolvedMinAmountOut,
      filledCompletely: true,
      remainingInventory: nextInventory,
    };
  }

  const newLegs: Leg[] = planOrder(
    nextInventory,
    plan.direction,
    remainder,
    plan.allowPartial,
    plan.fixedCost,
    remainingMinAmountOut,
  );

  const totalAmountIn = newLegs.reduce((a, l) => a + l.amountIn, 0n);
  const totalAmountOut = newLegs.reduce((a, l) => a + l.amountOut, 0n);
  const usedOutpoints = new Set(newLegs.map((l) => l.outpoint));
  const remainingInventory = nextInventory.filter((p) => !usedOutpoints.has(p.outpoint));

  return {
    ...base,
    legs: newLegs,
    totalAmountIn,
    totalAmountOut,
    meetsSlippageBound: cumulativeFilledAmountOut + totalAmountOut >= plan.resolvedMinAmountOut,
    filledCompletely: cumulativeFilledAmountIn + totalAmountIn === plan.originalAmountIn,
    remainingInventory,
  };
}

/**
 * Water-filling allocation across constant-product pools.
 *
 * Splitting an order across N constant-product pools to maximise total
 * amountOut is solved by equalising the *marginal* price across the pools
 * used (the standard water-filling / optimal-routing result). For a pool
 * with input-side reserve R_in, output-side reserve R_out and post-fee
 * multiplier m = (10000 - liquidityFeeBps - validationFeeBps - commissionBps) / 10000, the
 * marginal price at post-fee input `net` is:
 *
 *   price(net) = R_in * R_out / (R_in + net)^2
 *
 * Setting price(net) = P (a shared shadow price) gives a closed form:
 *
 *   net(P) = sqrt(R_in * R_out / P) - R_in        (clamped to >= 0)
 *
 * This module works in `number` for the continuous optimisation (it is a
 * planning heuristic, not a settlement — every leg that is actually
 * returned is re-derived with exact BigInt contract arithmetic in
 * pricing.ts and rejected if the contract would reject it). Reserve sizes
 * for BSV (<= ~2.1e15 sats) and realistic token amounts fit in a double's
 * 53-bit mantissa with no meaningful loss for this purpose.
 */
import { computeSwap } from "./pricing.js";
import type { Direction, FixedCost, Leg, PoolState } from "./types.js";

interface PoolMath {
  pool: PoolState;
  /** Reserve of the asset being sold into this pool. */
  inputReserve: number;
  /** Reserve of the asset being bought out of this pool. */
  outputReserve: number;
  k: number;
  /** (10000 - fees) / 10000, the fraction of amountIn that becomes net input. */
  m: number;
  /** Marginal price at net = 0, i.e. output per unit of input, fee-adjusted. */
  spotPrice: number;
}

function toPoolMath(pool: PoolState, direction: Direction): PoolMath {
  const bsv = Number(pool.bsvReserve);
  const tok = Number(pool.tokenReserve);
  const inputReserve = direction === "tokenToBsv" ? tok : bsv;
  const outputReserve = direction === "tokenToBsv" ? bsv : tok;
  const feeBps = Number(pool.liquidityFeeBps) + Number(pool.validationFeeBps) + Number(pool.commissionBps);
  const m = Math.max(0, (10000 - feeBps) / 10000);
  const k = inputReserve * outputReserve;
  const spotPrice = inputReserve > 0 ? (m * outputReserve) / inputReserve : 0;
  return { pool, inputReserve, outputReserve, k, m, spotPrice };
}

/**
 * Shadow price P is the marginal amountOut per unit of amountIn (pre-fee),
 * matching `spotPrice`'s basis: d(out)/d(amountIn) = m * d(out)/d(net) =
 * m * R_in*R_out / (R_in+net)^2. Solving for net at a given P:
 *
 *   net(P) = sqrt(m * k / P) - R_in
 */
function netAt(pm: PoolMath, shadowPrice: number): number {
  if (shadowPrice <= 0 || pm.k <= 0 || pm.m <= 0 || !isFinite(shadowPrice)) return Infinity;
  const net = Math.sqrt((pm.m * pm.k) / shadowPrice) - pm.inputReserve;
  return net > 0 ? net : 0;
}

function amountInAt(pm: PoolMath, shadowPrice: number): number {
  if (pm.m <= 0) return 0;
  return netAt(pm, shadowPrice) / pm.m;
}

function totalAmountInAt(pms: PoolMath[], shadowPrice: number): number {
  let sum = 0;
  for (const pm of pms) sum += amountInAt(pm, shadowPrice);
  return sum;
}

function outputAt(pm: PoolMath, net: number): number {
  if (net <= 0) return 0;
  return (net * pm.outputReserve) / (pm.inputReserve + net);
}

/** Finds the shadow price P such that sum(amountInAt(pm, P)) == target. */
function solveShadowPrice(pms: PoolMath[], target: number): number {
  if (pms.length === 0 || target <= 0) return Infinity;
  const maxSpot = Math.max(...pms.map((p) => p.spotPrice));
  if (!isFinite(maxSpot) || maxSpot <= 0) return Infinity;

  let hi = maxSpot; // at P = maxSpot, at least one pool's net is ~0 -> total ~0 (upper bound on total)
  let lo = maxSpot / 2;
  let guard = 0;
  while (totalAmountInAt(pms, lo) < target && guard < 400) {
    lo = lo / 2;
    guard++;
    if (lo < Number.EPSILON) break;
  }

  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (totalAmountInAt(pms, mid) > target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function totalOutputForTarget(pms: PoolMath[], target: number): number {
  if (target <= 0 || pms.length === 0) return 0;
  const price = solveShadowPrice(pms, target);
  let out = 0;
  for (const pm of pms) out += outputAt(pm, netAt(pm, price));
  return out;
}

/** Fixed per-leg cost (sats), converted into the output asset's units for comparison. */
function fixedCostInOutputUnits(pm: PoolMath, direction: Direction, fixedCost: FixedCost): number {
  const sats = Number(fixedCost.minerFeeSats);
  if (direction === "tokenToBsv") {
    // output asset is BSV: no conversion needed.
    return sats;
  }
  // output asset is the token: convert sats -> tokens at this pool's spot ratio.
  const bsv = Number(pm.pool.bsvReserve);
  const tok = Number(pm.pool.tokenReserve);
  if (bsv <= 0) return Infinity;
  return sats * (tok / bsv);
}

/** Largest-remainder rounding of float shares to integer BigInt summing exactly to target. */
function roundAllocation(pms: PoolMath[], floatShares: number[], target: bigint): bigint[] {
  const totalFloat = floatShares.reduce((a, b) => a + b, 0);
  if (totalFloat <= 0 || target <= 0n) return pms.map(() => 0n);

  const targetNum = Number(target);
  const scaled = floatShares.map((s) => (s / totalFloat) * targetNum);
  const floors = scaled.map((s) => BigInt(Math.max(0, Math.floor(s))));
  let used = floors.reduce((a, b) => a + b, 0n);
  let remainder = target - used;

  const order = scaled
    .map((s, i) => ({ i, frac: s - Math.floor(s), outpoint: pms[i]!.pool.outpoint }))
    .sort((a, b) => b.frac - a.frac || (a.outpoint < b.outpoint ? -1 : a.outpoint > b.outpoint ? 1 : 0));

  const result = [...floors];
  let idx = 0;
  while (remainder > 0n && idx < order.length) {
    const target_ = order[idx]!.i;
    result[target_] = (result[target_] ?? 0n) + 1n;
    remainder -= 1n;
    idx++;
  }
  if (remainder > 0n && result.length > 0) {
    result[0] = (result[0] ?? 0n) + remainder;
  }
  return result;
}

/**
 * Plans a split of `amountIn` across `pools` (already filtered to the
 * requested token and liveness threshold, deduplicated by outpoint). Adds
 * pools in descending spot-price order while the next pool's marginal
 * improvement in total amountOut exceeds its fixed per-leg cost, then
 * equalises marginal price across the chosen pools and rounds to exact
 * integer, contract-valid legs.
 *
 * Returns legs sorted by outpoint for a deterministic, stable plan shape.
 */
export function planSplit(
  pools: PoolState[],
  direction: Direction,
  amountIn: bigint,
  fixedCost: FixedCost,
): Leg[] {
  if (pools.length === 0 || amountIn <= 0n) return [];

  const sorted = pools
    .map((p) => toPoolMath(p, direction))
    .sort((a, b) => b.spotPrice - a.spotPrice || (a.pool.outpoint < b.pool.outpoint ? -1 : 1));

  const targetNum = Number(amountIn);

  let bestN = 1;
  let prevOut = totalOutputForTarget(sorted.slice(0, 1), targetNum);
  for (let n = 2; n <= sorted.length; n++) {
    const out = totalOutputForTarget(sorted.slice(0, n), targetNum);
    const gain = out - prevOut;
    const justAdded = sorted[n - 1]!;
    const cost = fixedCostInOutputUnits(justAdded, direction, fixedCost);
    if (gain > cost) {
      bestN = n;
      prevOut = out;
    } else {
      break;
    }
  }

  const active = sorted.slice(0, bestN);
  const price = solveShadowPrice(active, targetNum);
  const shares = active.map((pm) => amountInAt(pm, price));
  let allocation = roundAllocation(active, shares, amountIn);

  // Fold any allocation the contract would reject (net <= 0 or out <= 0,
  // possible only for tiny rounded shares) into the largest remaining leg,
  // deterministically, until every nonzero leg is contract-valid.
  for (let pass = 0; pass < active.length; pass++) {
    let changed = false;
    for (let i = 0; i < active.length; i++) {
      const amt = allocation[i]!;
      if (amt <= 0n) continue;
      const result = computeSwap(active[i]!.pool, direction, amt);
      if (result === null) {
        // fold into the largest other allocation (tie-break by outpoint)
        let bestJ = -1;
        for (let j = 0; j < active.length; j++) {
          if (j === i) continue;
          if (
            bestJ === -1 ||
            allocation[j]! > allocation[bestJ]! ||
            (allocation[j] === allocation[bestJ] && active[j]!.pool.outpoint < active[bestJ]!.pool.outpoint)
          ) {
            bestJ = j;
          }
        }
        if (bestJ === -1) break;
        allocation[bestJ] = (allocation[bestJ] ?? 0n) + amt;
        allocation[i] = 0n;
        changed = true;
      }
    }
    if (!changed) break;
  }

  const legs: Leg[] = [];
  for (let i = 0; i < active.length; i++) {
    const amt = allocation[i]!;
    if (amt <= 0n) continue;
    const pm = active[i]!;
    const result = computeSwap(pm.pool, direction, amt);
    if (result === null) continue; // still invalid even after folding; drop it
    legs.push({
      outpoint: pm.pool.outpoint,
      amountIn: amt,
      liquidityFee: result.liquidityFee,
      validationFee: result.validationFee,
      commission: result.commission,
      amountOut: result.amountOut,
      newBsvReserve: result.newBsvReserve,
      newTokenReserve: result.newTokenReserve,
    });
  }

  legs.sort((a, b) => (a.outpoint < b.outpoint ? -1 : a.outpoint > b.outpoint ? 1 : 0));
  return legs;
}

/**
 * The unconstrained "quoted mid": the total amountOut an optimal split
 * across every given pool would produce for amountIn, ignoring fixed
 * per-leg costs entirely (used only to resolve a toleranceBps slippage
 * bound into an absolute minAmountOut).
 */
export function quoteMid(pools: PoolState[], direction: Direction, amountIn: bigint): bigint {
  if (pools.length === 0 || amountIn <= 0n) return 0n;
  const legs = planSplit(pools, direction, amountIn, { minerFeeSats: 0n });
  return legs.reduce((a, l) => a + l.amountOut, 0n);
}

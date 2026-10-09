# @amm-poc/matching-engine

Pure TypeScript planning library for the AMM market UI's matching engine.
No UI framework, no network: it plans swaps over an inventory of pools the
caller supplies (queried from the overlay elsewhere) and returns a set of
legs to build, sign and broadcast. See `docs/notes.md` in the main repo,
"Pool contract draft (2026-09-23)" and "Overlay and communication layer on
skein (2026-09-29)" (the "Market UI and matching engine" and "Commission
fee" paragraphs), and `pool/Pool.runar.go` for the contract this
mirrors.

## Install / test

```
npm install
npm test         # vitest run
npm run typecheck
```

(No `bun` was available in the dev environment this was built in, so this
uses `npm` + `vitest` per the task's fallback.)

## API

```ts
import { plan, replan, computeSwap, feeAmount } from "@amm-poc/matching-engine";
```

### `computeSwap(pool, direction, amountIn): SwapResult | null`

Contract-exact swap arithmetic (BigInt), mirroring `pool/Pool.runar.go`'s
`Swap` method bit for bit:

```
liquidityFee = ceil(amountIn * liquidityFeeBps / 10000)
validationFee = ceil(amountIn * validationFeeBps / 10000)
commission = ceil(amountIn * commissionBps / 10000)
net = amountIn - liquidityFee - validationFee - commission   // must be > 0
amountOut = floor(net * outputReserve / (inputReserve + net))
                                                   // must be > 0
```

Returns `null` if the contract's own assertions (`net > 0`, `amountOut >
0`) would fail for this amountIn against this pool — i.e. this is not a
valid swap.

### `plan(request: PlanRequest): Plan`

Plans a fresh order against an inventory of pools. Deterministic and pure:
no clock, no randomness; ties are always broken by outpoint (ascending).

- `allowPartial: false` — only pools where the **entire** `amountIn` swaps
  within the slippage bound are eligible; the engine picks the single best
  one (max `amountOut`, tie-break by outpoint). If none qualify, returns an
  empty plan with `meetsSlippageBound: false`.
- `allowPartial: true` (default expectation) — splits the order across
  pools by water-filling: pools are added in descending (fee-adjusted)
  spot-price order while the next pool's marginal improvement in total
  `amountOut` exceeds its fixed per-leg cost (`fixedCost.minerFeeSats`,
  converted into the output asset's units — see
  "Assumptions" below). The chosen pools are then filled so their marginal
  price is equalized (continuous water-filling, closed form), and the
  continuous split is rounded to integers with largest-remainder rounding
  (ties broken by outpoint), then **re-derived from the exact BigInt
  contract formula**. Any rounded leg the contract would reject (net <= 0
  or out <= 0 — only possible for a sub-1-unit rounding remainder) is
  folded into the largest other leg and re-derived, so every leg the
  planner returns is a leg the contract would actually accept.
- The plan's `meetsSlippageBound` flag reports whether the (would-be)
  result satisfies the resolved slippage bound. If it doesn't, `plan()`
  still returns the best achievable allocation (not an empty plan) with
  the flag set to `false` — callers that want "no fill unless it clears
  the bound" should check the flag rather than assume an empty plan.
- An optional liveness filter (`livenessThreshold` + `now`, both supplied
  by the caller — the engine never reads the clock) excludes pools whose
  `lastSeen` is older than the threshold, or that have no `lastSeen` at all
  while the filter is active.

### `replan(plan: Plan, results: LegResult[]): Plan`

Re-plans the remainder of an order after a round of legs has been
attempted. Pure and deterministic, chainable: `replan()`'s return value is
itself a valid `Plan` that can be fed back into `replan()` again for the
next round, carrying cumulative bookkeeping (`cumulativeFilledAmountIn/Out`,
`originalAmountIn`, `resolvedMinAmountOut`) forward automatically.

Per-leg result handling:

- `filled` — locked in. Its `amountIn`/`amountOut` count toward the
  order's cumulative fill; its pool is gone (spent).
- `rejected` with `newPoolState` — the pool is re-priced from the
  validator's returned state (new outpoint + reserves) and stays a
  candidate for the remainder.
- `rejected` with no `newPoolState`, `timeout`, or a leg with no matching
  result at all — the pool's true state is unknown (it may have raced with
  another swap), so it is **dropped** from the candidate set rather than
  retried against stale reserves. (See "Assumptions.")

The slippage budget is cumulative across rounds: `resolvedMinAmountOut` is
fixed once, at the first `plan()` call, against the whole order; each
`replan()` round only needs to make up what hasn't already been filled.
`replan()` stops (returns a plan with empty `legs`) once the order is
fully filled, or once nothing eligible remains for the remainder.

### Types

See `src/types.ts` for the full shapes: `PoolState`, `FixedCost`,
`SlippageBound`, `PlanRequest`, `Leg`, `Plan`, `LegResult`.

## Assumptions

A few judgment calls the task left open, made explicit here:

1. **Slippage bound resolution.** `SlippageBound` supports both
   `minAmountOut` and `toleranceBps`; when both are given, the stricter
   (larger) resolved bound wins. `toleranceBps` is measured against a
   "quoted mid": the unconstrained optimal split across *every* eligible
   pool for the requested `amountIn`, ignoring fixed per-leg costs
   entirely. This is recomputed once per `plan()` call (not once per
   `replan()` round — the bound is fixed at the start of the order).
2. **Fixed cost units.** `fixedCost` is always denominated in sats (the
   miner fee, paid in BSV regardless of swap direction). The commission is
   not a fixed cost: it is the pool's `commissionBps`, a third fee on
   amountIn next to the LP and validator fees (in the fee multiplier `m`
   and in `computeSwap`); each `Leg` carries its `commission`. When the output asset is BSV
   (`tokenToBsv`), the water-filling gate compares directly in sats. When
   the output asset is the token (`bsvToToken`), the sats cost is
   converted to token-equivalent units using the newly-added pool's spot
   ratio (`tokenReserve / bsvReserve`) for the comparison. This is a
   heuristic gate for *how many* legs to use, not a settlement value.
3. **Water-filling is continuous, then rounded and re-verified.** The
   optimizer works in IEEE doubles for speed and simplicity (reserves at
   realistic BSV/token magnitudes fit a double's 53-bit mantissa with no
   meaningful loss for planning purposes). The result is converted to
   integer BigInt amounts (largest-remainder rounding, ties by outpoint)
   and every leg is re-derived through `computeSwap` (exact BigInt), which
   is what the planner actually returns and what determines
   `meetsSlippageBound`. A rounded leg the contract would reject is folded
   into the largest other leg rather than dropped silently.
4. **`meetsSlippageBound` on an empty/no-inventory plan.** If no bound was
   requested (`slippage: {}`) and there's no inventory to plan against, the
   resolved bound is `0`, so an empty plan trivially "meets" it. Callers
   should check `filledCompletely` (or `legs.length`) separately to detect
   "nothing was planned," rather than relying on `meetsSlippageBound` alone.
5. **`replan()` drops pools with an unknown post-attempt state** (a
   `rejected` leg with no `newPoolState`, a `timeout`, or a leg absent from
   `results` entirely) rather than retrying them against the stale
   pre-attempt reserves, since a race could have moved the pool to a state
   the engine can't see. They simply fall out of the candidate set; a
   caller that later learns their true state (e.g. via the overlay's spend
   index, per the "Market UI and matching engine" note about following
   pool continuations to the newest outpoint) can add them back into a
   fresh `inventory` on the next top-level `plan()` call.
6. **Liveness filter excludes pools with no `lastSeen`** whenever
   `livenessThreshold`/`now` are supplied, on the conservative assumption
   that "never seen" is at least as stale as "seen too long ago."
7. **`allowPartial: false` picks the best single pool** among those that
   can fill the *entire* `amountIn` within the slippage bound in one leg
   (max `amountOut`, ties broken by outpoint), per the task's spec. It
   does not attempt any splitting.
8. **Every pool in `inventory` is assumed pre-scoped to `tokenId`** — the
   `PoolState` shape given in the task has no per-pool token id field, so
   the engine trusts the caller queried the overlay for the right token.
9. **Determinism.** All internal sorts break ties by `outpoint` (lexical,
   ascending): pool selection order, single-leg pick, and rounding-
   remainder distribution. No leg is ever chosen by insertion order.

## Files

- `src/types.ts` — shared types.
- `src/pricing.ts` — contract-exact BigInt swap arithmetic (`computeSwap`, `feeAmount`).
- `src/allocation.ts` — continuous water-filling split + integer rounding (`planSplit`, `quoteMid`).
- `src/planner.ts` — `plan()`, single-leg selection, liveness filter, slippage bound resolution.
- `src/replanner.ts` — `replan()`.
- `test/pricing.test.ts` — `computeSwap` checked against an independently transcribed oracle of the Go contract's formula, for a table of cases (typical, zero fees, high fees, tiny amounts with ceil-rounding edge cases, a reject case, asymmetric reserves, heavy price impact, realistic large BSV magnitudes).
- `test/planner.test.ts` — single pool, split-beats-single, fixed-cost-prevents-split, `allowPartial: false`, slippage exhaustion, liveness filter, `bsvToToken` direction, determinism.
- `test/replanner.test.ts` — re-pricing after rejection (better and worse new state), partial-fill + cumulative slippage budget, stopping when nothing eligible remains, stopping when fully filled, multi-round chaining.

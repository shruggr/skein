import { describe, expect, it } from "vitest";
import { plan } from "../src/planner.js";
import { replan } from "../src/replanner.js";
import { computeSwap } from "../src/pricing.js";
import type { FixedCost, LegResult, PlanRequest } from "../src/types.js";
import { makePool } from "./helpers.js";

const noCost: FixedCost = { minerFeeSats: 0n };

function baseRequest(overrides: Partial<PlanRequest>): PlanRequest {
  return {
    tokenId: "token-1",
    direction: "tokenToBsv",
    amountIn: 100_000n,
    slippage: {},
    allowPartial: true,
    fixedCost: noCost,
    inventory: [],
    ...overrides,
  };
}

describe("replan after a rejection", () => {
  it("re-prices the rejected pool from its returned state and retries the remainder", () => {
    const poolA = makePool({ outpoint: "a:0", bsvReserve: 5_000_000n, tokenReserve: 5_000_000n });
    const request = baseRequest({ amountIn: 100_000n, allowPartial: false, inventory: [poolA] });
    const initial = plan(request);
    expect(initial.legs).toHaveLength(1);
    expect(initial.legs[0]!.outpoint).toBe("a:0");

    // Someone else's swap moved the pool's price (still an independently
    // valid pool state) before ours landed; the validator rejects and
    // returns the pool's new outpoint/reserves.
    const repriced = makePool({
      outpoint: "a:1",
      bsvReserve: 5_100_000n,
      tokenReserve: 4_900_000n,
    });
    const results: LegResult[] = [{ outpoint: "a:0", status: "rejected", newPoolState: repriced }];

    const next = replan(initial, results);
    expect(next.legs).toHaveLength(1);
    expect(next.legs[0]!.outpoint).toBe("a:1"); // re-priced pool, new outpoint
    expect(next.cumulativeFilledAmountIn).toBe(0n);
    expect(next.totalAmountIn).toBe(100_000n); // full remainder replanned

    // Sanity: the new leg's numbers are exactly the contract's swap against the new state.
    const expected = computeSwap(repriced, "tokenToBsv", 100_000n);
    expect(expected).not.toBeNull();
    expect(next.legs[0]!.amountOut).toBe(expected!.amountOut);
  });

  it("handles a new state that is worse for the taker (still fills, lower output)", () => {
    const poolA = makePool({ outpoint: "a:0", bsvReserve: 5_000_000n, tokenReserve: 5_000_000n });
    const request = baseRequest({ amountIn: 100_000n, allowPartial: false, inventory: [poolA] });
    const initial = plan(request);
    const originalQuote = initial.legs[0]!.amountOut;

    // The race went the other way: a token->bsv swap by someone else just
    // landed, moving reserves against our direction too (worse price for us).
    const repriced = makePool({
      outpoint: "a:1",
      bsvReserve: 4_900_000n,
      tokenReserve: 5_100_000n,
    });
    const results: LegResult[] = [{ outpoint: "a:0", status: "rejected", newPoolState: repriced }];
    const next = replan(initial, results);

    expect(next.legs).toHaveLength(1);
    expect(next.legs[0]!.outpoint).toBe("a:1");
    expect(next.legs[0]!.amountOut).toBeLessThan(originalQuote);
  });

  it("accounts for a filled leg and only replans the remainder, with a cumulative slippage budget", () => {
    const poolA = makePool({ outpoint: "a:0", bsvReserve: 5_000_000n, tokenReserve: 5_000_000n });
    const poolB = makePool({ outpoint: "b:0", bsvReserve: 5_000_000n, tokenReserve: 5_000_000n });
    const amountIn = 1_000_000n;
    const request = baseRequest({
      amountIn,
      inventory: [poolA, poolB],
      slippage: { minAmountOut: 0n },
    });
    const initial = plan(request);
    expect(initial.legs.length).toBe(2);

    const [legA, legB] = initial.legs;
    const results: LegResult[] = [
      { outpoint: legA!.outpoint, status: "filled" },
      { outpoint: legB!.outpoint, status: "timeout" },
    ];
    const next = replan(initial, results);

    expect(next.cumulativeFilledAmountIn).toBe(legA!.amountIn);
    expect(next.cumulativeFilledAmountOut).toBe(legA!.amountOut);
    // timeout: pool state unknown, dropped -> nothing left to plan against.
    expect(next.legs).toHaveLength(0);
    expect(next.filledCompletely).toBe(false);
  });

  it("stops once nothing eligible remains (timeout with no other pools)", () => {
    const poolA = makePool({ outpoint: "a:0", bsvReserve: 1_000_000n, tokenReserve: 1_000_000n });
    const request = baseRequest({
      amountIn: 100_000n,
      allowPartial: false,
      inventory: [poolA],
      slippage: { minAmountOut: 90_000n }, // a real bound, so an unfilled order fails it
    });
    const initial = plan(request);

    const results: LegResult[] = [{ outpoint: "a:0", status: "timeout" }];
    const next = replan(initial, results);

    expect(next.legs).toHaveLength(0);
    expect(next.remainingInventory).toHaveLength(0);
    expect(next.filledCompletely).toBe(false);
    expect(next.meetsSlippageBound).toBe(false); // still owes the whole order's worth of output
  });

  it("stops once the order is fully filled", () => {
    const poolA = makePool({ outpoint: "a:0", bsvReserve: 1_000_000n, tokenReserve: 1_000_000n });
    const request = baseRequest({ amountIn: 100_000n, allowPartial: false, inventory: [poolA] });
    const initial = plan(request);

    const results: LegResult[] = [{ outpoint: "a:0", status: "filled" }];
    const next = replan(initial, results);

    expect(next.legs).toHaveLength(0);
    expect(next.filledCompletely).toBe(true);
    expect(next.cumulativeFilledAmountIn).toBe(100_000n);
    expect(next.meetsSlippageBound).toBe(true);
  });

  it("is chainable across multiple replan rounds", () => {
    const poolA = makePool({ outpoint: "a:0", bsvReserve: 1_000_000n, tokenReserve: 1_000_000n });
    const request = baseRequest({ amountIn: 100_000n, allowPartial: false, inventory: [poolA] });
    const round1 = plan(request);

    const repriced1 = makePool({ outpoint: "a:1", bsvReserve: 1_010_000n, tokenReserve: 990_000n });
    const round2 = replan(round1, [{ outpoint: "a:0", status: "rejected", newPoolState: repriced1 }]);
    expect(round2.legs).toHaveLength(1);
    expect(round2.legs[0]!.outpoint).toBe("a:1");

    const round3 = replan(round2, [{ outpoint: "a:1", status: "filled" }]);
    expect(round3.legs).toHaveLength(0);
    expect(round3.filledCompletely).toBe(true);
    expect(round3.cumulativeFilledAmountIn).toBe(100_000n);
  });
});

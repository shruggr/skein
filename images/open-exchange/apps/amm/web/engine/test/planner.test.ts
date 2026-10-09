import { describe, expect, it } from "vitest";
import { plan } from "../src/planner.js";
import type { FixedCost, PlanRequest } from "../src/types.js";
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

describe("single pool", () => {
  it("fills the whole order against the only pool available", () => {
    const pool = makePool({ outpoint: "a:0", bsvReserve: 10_000_000n, tokenReserve: 10_000_000n });
    const request = baseRequest({ amountIn: 50_000n, inventory: [pool] });
    const result = plan(request);

    expect(result.legs).toHaveLength(1);
    expect(result.legs[0]!.outpoint).toBe("a:0");
    expect(result.totalAmountIn).toBe(50_000n);
    expect(result.filledCompletely).toBe(true);
    expect(result.meetsSlippageBound).toBe(true);
    expect(result.totalAmountOut).toBeGreaterThan(0n);
  });

  it("returns an empty plan when there is no inventory", () => {
    const request = baseRequest({ inventory: [] });
    const result = plan(request);
    expect(result.legs).toHaveLength(0);
    expect(result.totalAmountIn).toBe(0n);
    expect(result.filledCompletely).toBe(false);
    // No slippage bound was requested, so the (empty) result trivially meets it;
    // callers must check filledCompletely separately to detect "nothing planned".
    expect(result.meetsSlippageBound).toBe(true);
  });
});

describe("splitting across pools", () => {
  it("beats a single pool when the order has real price impact", () => {
    const poolA = makePool({ outpoint: "a:0", bsvReserve: 5_000_000n, tokenReserve: 5_000_000n });
    const poolB = makePool({ outpoint: "b:0", bsvReserve: 5_000_000n, tokenReserve: 5_000_000n });
    // 20% of a single pool's reserve: heavy enough price impact that splitting helps.
    const amountIn = 1_000_000n;

    const split = plan(baseRequest({ amountIn, inventory: [poolA, poolB], fixedCost: noCost }));
    const single = plan(baseRequest({ amountIn, inventory: [poolA], fixedCost: noCost }));

    expect(split.legs.length).toBe(2);
    expect(split.totalAmountIn).toBe(amountIn);
    expect(split.totalAmountOut).toBeGreaterThan(single.totalAmountOut);
  });

  it("never uses the same pool twice", () => {
    const poolA = makePool({ outpoint: "a:0", bsvReserve: 2_000_000n, tokenReserve: 2_000_000n });
    const poolB = makePool({ outpoint: "b:0", bsvReserve: 2_000_000n, tokenReserve: 2_000_000n });
    const poolC = makePool({ outpoint: "c:0", bsvReserve: 2_000_000n, tokenReserve: 2_000_000n });
    const result = plan(baseRequest({ amountIn: 900_000n, inventory: [poolA, poolB, poolC] }));
    const outpoints = result.legs.map((l) => l.outpoint);
    expect(new Set(outpoints).size).toBe(outpoints.length);
  });
});

describe("fixed per-leg cost", () => {
  it("prevents a pointless split when the improvement doesn't cover the cost", () => {
    const poolA = makePool({ outpoint: "a:0", bsvReserve: 50_000_000n, tokenReserve: 50_000_000n });
    const poolB = makePool({ outpoint: "b:0", bsvReserve: 50_000_000n, tokenReserve: 50_000_000n });
    // Small order relative to reserves: price impact, and thus any gain from
    // splitting, is tiny. A large fixed cost should keep the plan to 1 leg.
    const amountIn = 1_000n;
    const highCost: FixedCost = { minerFeeSats: 15_000n };

    const result = plan(baseRequest({ amountIn, inventory: [poolA, poolB], fixedCost: highCost }));
    expect(result.legs).toHaveLength(1);
  });

  it("still splits when the fixed cost is negligible relative to the gain", () => {
    const poolA = makePool({ outpoint: "a:0", bsvReserve: 5_000_000n, tokenReserve: 5_000_000n });
    const poolB = makePool({ outpoint: "b:0", bsvReserve: 5_000_000n, tokenReserve: 5_000_000n });
    const amountIn = 1_000_000n;
    const tinyCost: FixedCost = { minerFeeSats: 1n };

    const result = plan(baseRequest({ amountIn, inventory: [poolA, poolB], fixedCost: tinyCost }));
    expect(result.legs.length).toBe(2);
  });
});

describe("allowPartial = false", () => {
  it("only considers pools that can fill the whole order within slippage, and picks the best", () => {
    // Small pool: swapping the whole order here has heavy price impact -> fails the bound.
    const smallPool = makePool({ outpoint: "small:0", bsvReserve: 200_000n, tokenReserve: 200_000n });
    // Two pools big enough to absorb the whole order within bound; pick the higher-output one.
    const okPool = makePool({ outpoint: "ok:0", bsvReserve: 20_000_000n, tokenReserve: 20_000_000n });
    const betterPool = makePool({
      outpoint: "better:0",
      bsvReserve: 20_000_000n,
      tokenReserve: 20_000_000n,
      liquidityFeeBps: 5n,
      validationFeeBps: 1n,
    });

    const amountIn = 100_000n;
    const request = baseRequest({
      amountIn,
      allowPartial: false,
      inventory: [smallPool, okPool, betterPool],
      slippage: { minAmountOut: 90_000n },
    });
    const result = plan(request);

    expect(result.legs).toHaveLength(1);
    expect(result.legs[0]!.outpoint).toBe("better:0"); // lower fees -> more output
    expect(result.legs[0]!.amountIn).toBe(amountIn);
    expect(result.meetsSlippageBound).toBe(true);
  });

  it("returns an empty plan when no single pool can fill the whole order within slippage", () => {
    const smallPool = makePool({ outpoint: "small:0", bsvReserve: 150_000n, tokenReserve: 150_000n });
    const request = baseRequest({
      amountIn: 100_000n,
      allowPartial: false,
      inventory: [smallPool],
      slippage: { minAmountOut: 99_000n }, // impossible: heavy price impact on this small a pool
    });
    const result = plan(request);
    expect(result.legs).toHaveLength(0);
    expect(result.meetsSlippageBound).toBe(false);
  });
});

describe("slippage exhaustion", () => {
  it("flags meetsSlippageBound = false and still returns the best achievable plan", () => {
    const poolA = makePool({ outpoint: "a:0", bsvReserve: 1_000_000n, tokenReserve: 1_000_000n });
    const poolB = makePool({ outpoint: "b:0", bsvReserve: 1_000_000n, tokenReserve: 1_000_000n });
    const request = baseRequest({
      amountIn: 100_000n,
      inventory: [poolA, poolB],
      slippage: { minAmountOut: 1_000_000_000n }, // unreachable
    });
    const result = plan(request);

    expect(result.legs.length).toBeGreaterThan(0);
    expect(result.totalAmountIn).toBe(100_000n); // still fully allocated...
    expect(result.totalAmountOut).toBeLessThan(1_000_000_000n);
    expect(result.meetsSlippageBound).toBe(false); // ...but flagged as not meeting the bound
  });
});

describe("liveness filter", () => {
  it("excludes pools whose validator lastSeen is older than the threshold", () => {
    const fresh = makePool({ outpoint: "fresh:0", lastSeen: 1_000 });
    const stale = makePool({ outpoint: "stale:0", lastSeen: 0 });
    const unknown = makePool({ outpoint: "unknown:0" }); // no lastSeen at all
    const request = baseRequest({
      amountIn: 10_000n,
      inventory: [fresh, stale, unknown],
      livenessThreshold: 500,
      now: 1_000,
    });
    const result = plan(request);
    const used = new Set(result.legs.map((l) => l.outpoint));
    expect(used.has("fresh:0")).toBe(true);
    expect(used.has("stale:0")).toBe(false);
    expect(used.has("unknown:0")).toBe(false);
  });

  it("does not filter anything when no threshold/now is given", () => {
    const stale = makePool({ outpoint: "stale:0", lastSeen: 0 });
    const request = baseRequest({ amountIn: 10_000n, inventory: [stale] });
    const result = plan(request);
    expect(result.legs).toHaveLength(1);
  });
});

describe("bsvToToken direction", () => {
  it("splits an order across pools the same way as tokenToBsv", () => {
    const poolA = makePool({ outpoint: "a:0", bsvReserve: 5_000_000n, tokenReserve: 5_000_000n });
    const poolB = makePool({ outpoint: "b:0", bsvReserve: 5_000_000n, tokenReserve: 5_000_000n });
    const amountIn = 1_000_000n;
    const result = plan(
      baseRequest({ direction: "bsvToToken", amountIn, inventory: [poolA, poolB], fixedCost: noCost }),
    );
    expect(result.legs.length).toBe(2);
    expect(result.totalAmountIn).toBe(amountIn);
    for (const leg of result.legs) {
      expect(leg.newTokenReserve).toBeLessThan(5_000_000n); // tokens paid out
      expect(leg.newBsvReserve).toBeGreaterThan(5_000_000n); // bsv paid in
    }
  });

  it("converts the fixed sats cost into token-equivalent units when comparing to the output-side gain", () => {
    const poolA = makePool({ outpoint: "a:0", bsvReserve: 50_000_000n, tokenReserve: 50_000_000n });
    const poolB = makePool({ outpoint: "b:0", bsvReserve: 50_000_000n, tokenReserve: 50_000_000n });
    const amountIn = 1_000n;
    const highCost: FixedCost = { minerFeeSats: 15_000n };
    const result = plan(
      baseRequest({ direction: "bsvToToken", amountIn, inventory: [poolA, poolB], fixedCost: highCost }),
    );
    expect(result.legs).toHaveLength(1);
  });
});

describe("determinism", () => {
  it("produces the same plan regardless of inventory order, ties broken by outpoint", () => {
    const poolA = makePool({ outpoint: "aaa:0", bsvReserve: 3_000_000n, tokenReserve: 3_000_000n });
    const poolB = makePool({ outpoint: "bbb:0", bsvReserve: 3_000_000n, tokenReserve: 3_000_000n });
    const poolC = makePool({ outpoint: "ccc:0", bsvReserve: 3_000_000n, tokenReserve: 3_000_000n });

    const request1 = baseRequest({ amountIn: 500_000n, inventory: [poolA, poolB, poolC] });
    const request2 = baseRequest({ amountIn: 500_000n, inventory: [poolC, poolA, poolB] });
    const request3 = baseRequest({ amountIn: 500_000n, inventory: [poolB, poolC, poolA] });

    const r1 = plan(request1);
    const r2 = plan(request2);
    const r3 = plan(request3);

    expect(r1.legs).toEqual(r2.legs);
    expect(r1.legs).toEqual(r3.legs);
  });

  it("breaks single-leg ties (allowPartial = false) by outpoint", () => {
    const poolA = makePool({ outpoint: "z:0", bsvReserve: 9_000_000n, tokenReserve: 9_000_000n });
    const poolB = makePool({ outpoint: "a:0", bsvReserve: 9_000_000n, tokenReserve: 9_000_000n });
    const request = baseRequest({ amountIn: 10_000n, allowPartial: false, inventory: [poolA, poolB] });
    const result = plan(request);
    expect(result.legs[0]!.outpoint).toBe("a:0");
  });
});

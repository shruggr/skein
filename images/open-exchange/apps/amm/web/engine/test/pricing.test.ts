import { describe, expect, it } from "vitest";
import { computeSwap, feeAmount } from "../src/pricing.js";
import type { Direction } from "../src/types.js";

/**
 * Independent re-implementation of pool/Pool.runar.go's Swap arithmetic,
 * transcribed directly from the Go source (see pool/Pool.runar.go lines
 * 79-94), used as the oracle for computeSwap(). Kept deliberately separate
 * from src/pricing.ts so this test can't just be checking the code against
 * itself.
 *
 *   lpFee = (amountIn*LpFeeBps + 9999) / 10000
 *   validatorFee = (amountIn*ValidatorFeeBps + 9999) / 10000
 *   net = amountIn - lpFee - validatorFee   // assert net > 0
 *
 *   !bsvIn (token in):
 *     out = net * bsvReserve / (tokenReserve + net)
 *   bsvIn (bsv in):
 *     out = net * tokenReserve / (bsvReserve + net)
 *   // assert out > 0
 */
function contractOracle(
  bsvReserve: bigint,
  tokenReserve: bigint,
  lpFeeBps: bigint,
  validatorFeeBps: bigint,
  amountIn: bigint,
  bsvIn: boolean,
): { lpFee: bigint; validatorFee: bigint; net: bigint; out: bigint } | "reject" {
  const lpFee = (amountIn * lpFeeBps + 9999n) / 10000n;
  const validatorFee = (amountIn * validatorFeeBps + 9999n) / 10000n;
  const net = amountIn - lpFee - validatorFee;
  if (!(net > 0n)) return "reject";

  const out = bsvIn ? (net * tokenReserve) / (bsvReserve + net) : (net * bsvReserve) / (tokenReserve + net);
  if (!(out > 0n)) return "reject";
  return { lpFee, validatorFee, net, out };
}

interface Case {
  name: string;
  bsvReserve: bigint;
  tokenReserve: bigint;
  liquidityFeeBps: bigint;
  validationFeeBps: bigint;
  amountIn: bigint;
  direction: Direction; // tokenToBsv <-> !bsvIn, bsvToToken <-> bsvIn
}

const cases: Case[] = [
  {
    name: "simple token->bsv, mid-size pool, typical fees",
    bsvReserve: 10_000_000n,
    tokenReserve: 5_000_000n,
    liquidityFeeBps: 30n,
    validationFeeBps: 5n,
    amountIn: 100_000n,
    direction: "tokenToBsv",
  },
  {
    name: "simple bsv->token, mid-size pool, typical fees",
    bsvReserve: 10_000_000n,
    tokenReserve: 5_000_000n,
    liquidityFeeBps: 30n,
    validationFeeBps: 5n,
    amountIn: 250_000n,
    direction: "bsvToToken",
  },
  {
    name: "zero fees",
    bsvReserve: 1_000_000n,
    tokenReserve: 1_000_000n,
    liquidityFeeBps: 0n,
    validationFeeBps: 0n,
    amountIn: 10_000n,
    direction: "tokenToBsv",
  },
  {
    name: "large fees (500 bps total)",
    bsvReserve: 2_000_000n,
    tokenReserve: 8_000_000n,
    liquidityFeeBps: 300n,
    validationFeeBps: 200n,
    amountIn: 50_000n,
    direction: "bsvToToken",
  },
  {
    name: "tiny amountIn, nonzero fees, ceil rounding matters",
    bsvReserve: 1_000_000n,
    tokenReserve: 1_000_000n,
    liquidityFeeBps: 30n,
    validationFeeBps: 5n,
    amountIn: 7n,
    direction: "tokenToBsv",
  },
  {
    name: "amountIn = 1, fee rounds fee up to consume everything (should reject)",
    bsvReserve: 1_000_000n,
    tokenReserve: 1_000_000n,
    liquidityFeeBps: 30n,
    validationFeeBps: 5n,
    amountIn: 1n,
    direction: "tokenToBsv",
  },
  {
    name: "asymmetric reserves, bsv->token",
    bsvReserve: 21_000_000n,
    tokenReserve: 100n,
    liquidityFeeBps: 25n,
    validationFeeBps: 5n,
    amountIn: 1_000_000n,
    direction: "bsvToToken",
  },
  {
    name: "large amountIn relative to reserve (heavy price impact)",
    bsvReserve: 1_000_000n,
    tokenReserve: 1_000_000n,
    liquidityFeeBps: 30n,
    validationFeeBps: 5n,
    amountIn: 5_000_000n,
    direction: "tokenToBsv",
  },
  {
    name: "very large numbers (near-realistic max sats)",
    bsvReserve: 2_100_000_000_000_000n,
    tokenReserve: 21_000_000_000_000n,
    liquidityFeeBps: 30n,
    validationFeeBps: 5n,
    amountIn: 123_456_789_012n,
    direction: "bsvToToken",
  },
];

describe("computeSwap matches the contract's exact integer arithmetic", () => {
  for (const c of cases) {
    it(c.name, () => {
      const pool = {
        bsvReserve: c.bsvReserve,
        tokenReserve: c.tokenReserve,
        liquidityFeeBps: c.liquidityFeeBps,
        validationFeeBps: c.validationFeeBps,
        commissionBps: 0n,
      };
      const bsvIn = c.direction === "bsvToToken";
      const oracle = contractOracle(c.bsvReserve, c.tokenReserve, c.liquidityFeeBps, c.validationFeeBps, c.amountIn, bsvIn);
      const actual = computeSwap(pool, c.direction, c.amountIn);

      if (oracle === "reject") {
        expect(actual).toBeNull();
        return;
      }
      expect(actual).not.toBeNull();
      expect(actual!.liquidityFee).toBe(oracle.lpFee);
      expect(actual!.validationFee).toBe(oracle.validatorFee);
      expect(actual!.commission).toBe(0n);
      expect(actual!.net).toBe(oracle.net);
      expect(actual!.amountOut).toBe(oracle.out);

      // reserve bookkeeping matches direction-specific contract branches
      if (c.direction === "tokenToBsv") {
        expect(actual!.newBsvReserve).toBe(c.bsvReserve - oracle.out);
        expect(actual!.newTokenReserve).toBe(c.tokenReserve + oracle.net);
      } else {
        expect(actual!.newBsvReserve).toBe(c.bsvReserve + oracle.net);
        expect(actual!.newTokenReserve).toBe(c.tokenReserve - oracle.out);
      }
    });
  }
});

describe("feeAmount", () => {
  it("rounds up (ceil), matching (amountIn*bps + 9999) / 10000", () => {
    expect(feeAmount(1n, 1n)).toBe(1n); // any nonzero rate takes >= 1
    expect(feeAmount(10_000n, 1n)).toBe(1n); // exact: 1 unit
    expect(feeAmount(10_001n, 1n)).toBe(2n); // ceil rounds up
    expect(feeAmount(100n, 0n)).toBe(0n); // zero rate takes nothing
  });
});

describe("computeSwap contract invariants", () => {
  it("rejects amountIn <= 0", () => {
    const pool = { bsvReserve: 1000n, tokenReserve: 1000n, liquidityFeeBps: 30n, validationFeeBps: 5n, commissionBps: 0n };
    expect(computeSwap(pool, "tokenToBsv", 0n)).toBeNull();
    expect(computeSwap(pool, "tokenToBsv", -5n)).toBeNull();
  });

  it("never returns amountOut >= the output reserve (asymptotic curve)", () => {
    const pool = { bsvReserve: 1000n, tokenReserve: 1000n, liquidityFeeBps: 30n, validationFeeBps: 5n, commissionBps: 0n };
    const result = computeSwap(pool, "tokenToBsv", 1_000_000_000n);
    expect(result).not.toBeNull();
    expect(result!.amountOut).toBeLessThan(pool.bsvReserve);
  });
});

describe("computeSwap with a commission (CommissionBps)", () => {
  // programs/amm-topic/gen/main.go's fixture pool: 30 / 5 / 10 bps; swap_bsv_in and
  // swap_tokens_in (vectors.zig pool0 -> pool1 -> pool2).
  it("takes ceil(amountIn * CommissionBps / 10000) from amountIn, like the other fees", () => {
    const pool0 = { bsvReserve: 1_000_000n, tokenReserve: 5_000_000n, liquidityFeeBps: 30n, validationFeeBps: 5n, commissionBps: 10n };
    const s1 = computeSwap(pool0, "bsvToToken", 20_000n)!;
    expect(s1).toEqual({ liquidityFee: 60n, validationFee: 10n, commission: 20n, net: 19_910n, amountOut: 97_606n, newBsvReserve: 1_019_910n, newTokenReserve: 4_902_394n });
    const pool1 = { ...pool0, bsvReserve: s1.newBsvReserve, tokenReserve: s1.newTokenReserve };
    const s2 = computeSwap(pool1, "tokenToBsv", 50_000n)!;
    expect(s2.commission).toBe(50n);
    expect([s2.newBsvReserve, s2.newTokenReserve]).toEqual([1_009_659n, 4_952_169n]);
    // The commission costs the taker output against the same pool without one.
    expect(computeSwap({ ...pool0, commissionBps: 0n }, "bsvToToken", 20_000n)!.amountOut).toBeGreaterThan(s1.amountOut);
    expect(feeAmount(1n, 10n)).toBe(1n);
  });

  it("rejects an amountIn the three fees together consume", () => {
    const pool = { bsvReserve: 1000n, tokenReserve: 1000n, liquidityFeeBps: 3000n, validationFeeBps: 3000n, commissionBps: 4000n };
    expect(computeSwap(pool, "bsvToToken", 100n)).toBeNull();
  });
});

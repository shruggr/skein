import { describe, expect, it } from "vitest";
import { parseLookupAnswer } from "../src/lib/overlay";

// Recorded against the running instance (amm-poc-deploy/deploy/boot.sh),
// curl -s -X POST http://amm.localhost:8200/lookup -H 'content-type:
// application/json' -d '{"service":"ls_amm_948b...5214c","query":{}}' —
// the seeded pool, before the fixture swap.
const RECORDED_ALL_POOLS = {
  type: "freeform",
  result: [
    {
      outpoint: "43d8857e41da26ec6c7dd4981a08456ca0ef94b36fc6665f8b5054a14ab9391a_0",
      bsvReserve: 1000000,
      tokenReserve: 5000000,
      liquidityFeeBps: 30,
      validationFeeBps: 5,
      validatorIdentityKey: "03142715675faf8da1ecc4d51e0b9e539fa0d52fdd96ed60dbe99adb15d6b05ad9",
    },
  ],
};

// Recorded the same way with query {"outpoint": "<the pool's outpoint>"}.
const RECORDED_FOLLOW_OUTPOINT = {
  type: "freeform",
  result: {
    hops: 0,
    current: RECORDED_ALL_POOLS.result[0],
  },
};

describe("parseLookupAnswer", () => {
  it("parses a {} answer into the engine's PoolState, reserves/fees as bigint", () => {
    const pools = parseLookupAnswer(RECORDED_ALL_POOLS);
    expect(pools).toEqual([
      {
        outpoint: "43d8857e41da26ec6c7dd4981a08456ca0ef94b36fc6665f8b5054a14ab9391a_0",
        bsvReserve: 1000000n,
        tokenReserve: 5000000n,
        liquidityFeeBps: 30n,
        validationFeeBps: 5n,
        commissionBps: 0n, // recorded before the commission: absent, read as 0
        validatorIdentityKey: "03142715675faf8da1ecc4d51e0b9e539fa0d52fdd96ed60dbe99adb15d6b05ad9",
      },
    ]);
    // bigint, not number — mixing this with the engine's BigInt arithmetic
    // (pricing.ts) throws otherwise.
    expect(typeof pools[0].bsvReserve).toBe("bigint");
  });

  it("parses an {outpoint} answer ({hops, current}) into a single-element PoolState[]", () => {
    const pools = parseLookupAnswer(RECORDED_FOLLOW_OUTPOINT);
    expect(pools).toHaveLength(1);
    expect(pools[0]).toEqual({
      outpoint: "43d8857e41da26ec6c7dd4981a08456ca0ef94b36fc6665f8b5054a14ab9391a_0",
      bsvReserve: 1000000n,
      tokenReserve: 5000000n,
      liquidityFeeBps: 30n,
      validationFeeBps: 5n,
      commissionBps: 0n,
      validatorIdentityKey: "03142715675faf8da1ecc4d51e0b9e539fa0d52fdd96ed60dbe99adb15d6b05ad9",
    });
  });

  it("reads a pool's commissionBps when the lookup carries it", () => {
    const withCommission = { type: "freeform", result: [{ ...RECORDED_ALL_POOLS.result[0], commissionBps: 10 }] };
    expect(parseLookupAnswer(withCommission)[0]!.commissionBps).toBe(10n);
  });

  it("normalizes a dropped/empty answer to []", () => {
    expect(parseLookupAnswer({ type: "output-list", outputs: [] })).toEqual([]);
    expect(parseLookupAnswer(undefined)).toEqual([]);
  });
});

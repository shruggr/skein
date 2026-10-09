import type { PoolState } from "../src/types.js";

export function makePool(overrides: Partial<PoolState> & { outpoint: string }): PoolState {
  return {
    bsvReserve: 10_000_000n,
    tokenReserve: 10_000_000n,
    liquidityFeeBps: 30n,
    validationFeeBps: 5n,
    commissionBps: 0n,
    validatorIdentityKey: "validator-" + overrides.outpoint,
    ...overrides,
  };
}

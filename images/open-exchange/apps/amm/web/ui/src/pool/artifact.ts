import type { RunarArtifact } from "runar-sdk";
import poolArtifactJson from "./pool.artifact.json";

/**
 * The compiled Pool contract (pool/Pool.runar.go), as the Go compiler writes
 * it (`compiler.ArtifactToJSON`; see README.md "pool.artifact.json"). Its
 * `script` is byte-identical to the template in
 * programs/amm-topic/src/fixtures/pool_artifact.zig.
 */
export const poolArtifact = poolArtifactJson as unknown as RunarArtifact;

/** Public method indices (the method selector pushed last in a call). */
export const METHOD_INDEX = { swap: 0, addLiquidity: 1, removeLiquidity: 2 } as const;
export type PoolMethod = keyof typeof METHOD_INDEX;

/** Constructor parameter order (pool/Pool.runar.go's fields). */
export const CTOR = {
  tokenReserve: 0,
  lpPubKey: 1,
  validatorPubKey: 2,
  validatorIdentity: 3,
  assetId: 4,
  lpFeeBps: 5,
  validatorFeeBps: 6,
  commissionBps: 7,
} as const;

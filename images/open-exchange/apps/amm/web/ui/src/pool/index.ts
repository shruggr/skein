/**
 * The AMM Pool script template (pool/Pool.runar.go) over runar-sdk, from the
 * local Rúnar checkout (README.md, "runar-sdk from the local checkout").
 * Independent of React.
 */
export {
  PoolTemplate,
  PoolBuildError,
  p2pkhUnlock,
  type Pool,
  type PoolArgs,
  type PoolFields,
  type PoolUtxo,
  type BuilderInput,
  type FeeSpec,
  type SwapParams,
  type SwapExpectation,
  type SwapAmounts,
  type SwapPlanParams,
  type CallPlan,
  type AddLiquidityParams,
  type RemoveLiquidityParams,
  type PoolCall,
  type PoolSigner,
  type SigSlot,
  type PoolBuildErrorCode,
} from "./template";
export { poolArtifact, METHOD_INDEX, type PoolMethod } from "./artifact";
export { decodeMandala, mandalaValuePrefix, type MandalaPrefix, type MandalaRole } from "./mandala";

/**
 * Types for the matching engine. All monetary / reserve quantities are
 * BigInt to mirror the pool contract's integer arithmetic exactly
 * (see pool/Pool.runar.go). Floating point is only ever used internally,
 * as a heuristic for *how* to split an order across pools; every number
 * that ends up in a Leg is produced by exact BigInt contract arithmetic.
 */

/** Which asset is being sold. The taker always receives the other one. */
export type Direction = "bsvToToken" | "tokenToBsv";

/** One pool UTXO, as the caller's inventory query would report it. */
export interface PoolState {
  /** txid:vout of the pool UTXO. */
  outpoint: string;
  bsvReserve: bigint;
  tokenReserve: bigint;
  /** LP fee rate, in basis points, taken from amountIn (ceil). */
  liquidityFeeBps: bigint;
  /** Validator fee rate, in basis points, taken from amountIn (ceil). */
  validationFeeBps: bigint;
  /**
   * Commission rate (the contract's CommissionBps, fixed at deploy), in basis
   * points, taken from amountIn (ceil) and paid to the relay's address.
   */
  commissionBps: bigint;
  /** The pool's validator identity key (33-byte hex or similar). Opaque to the engine. */
  validatorIdentityKey: string;
  /** Last time (ms epoch) this pool's validator was seen live, if known. */
  lastSeen?: number;
}

/** Fixed cost the taker pays to add one more leg to a plan, in satoshis. */
export interface FixedCost {
  /** Estimated miner fee for this leg's transaction, in sats. */
  minerFeeSats: bigint;
}

/**
 * Slippage bound on the *total* amountOut across every leg of the order.
 * Both forms may be given; the engine resolves them to a single absolute
 * `minAmountOut` and uses whichever is stricter (larger).
 */
export interface SlippageBound {
  /** Minimum acceptable total amountOut, in the output asset's smallest unit. */
  minAmountOut?: bigint;
  /**
   * Tolerance in basis points against the "quoted mid": the total amountOut
   * an unconstrained optimal split across all eligible pools would produce
   * right now, ignoring fixed per-leg costs. minAmountOut is then
   * quote * (10000 - toleranceBps) / 10000.
   */
  toleranceBps?: bigint;
}

/** A single pool's leg of a plan, with the pool's exact post-swap state. */
export interface Leg {
  outpoint: string;
  amountIn: bigint;
  liquidityFee: bigint;
  validationFee: bigint;
  /** The commission, in the input asset. */
  commission: bigint;
  amountOut: bigint;
  /** Pool reserves after this leg, per the contract's swap arithmetic. */
  newBsvReserve: bigint;
  newTokenReserve: bigint;
}

export interface PlanRequest {
  tokenId: string;
  direction: Direction;
  amountIn: bigint;
  slippage: SlippageBound;
  allowPartial: boolean;
  fixedCost: FixedCost;
  /** Pools available for this token. Assumed already scoped to tokenId. */
  inventory: PoolState[];
  /** Exclude pools whose validator lastSeen is older than this many ms before `now`. */
  livenessThreshold?: number;
  /**
   * Caller-supplied "current time" (ms epoch) for the liveness filter. The
   * engine never reads the clock itself, to stay pure. Required if
   * livenessThreshold is set; pools with no lastSeen are excluded whenever
   * a liveness filter is active.
   */
  now?: number;
}

export interface Plan {
  /** Legs to build, sign and broadcast in parallel for this round. */
  legs: Leg[];
  /** Sum of this round's legs' amountIn. */
  totalAmountIn: bigint;
  /** Sum of this round's legs' amountOut (expected, pre-execution). */
  totalAmountOut: bigint;
  /**
   * True if, assuming this round's legs all fill as planned, the
   * cumulative amountOut (including prior rounds) meets resolvedMinAmountOut.
   */
  meetsSlippageBound: boolean;
  /** True if this round's legs cover the full remaining order (originalAmountIn - cumulativeFilledAmountIn). */
  filledCompletely: boolean;

  // --- bookkeeping carried across replan() rounds ---
  direction: Direction;
  allowPartial: boolean;
  fixedCost: FixedCost;
  livenessThreshold?: number;
  now?: number;
  /** The full order size, constant across every round. */
  originalAmountIn: bigint;
  /** Absolute slippage bound for the whole order, resolved once at the first plan() call. */
  resolvedMinAmountOut: bigint;
  /** amountIn confirmed filled in prior rounds (not including this round's legs). */
  cumulativeFilledAmountIn: bigint;
  /** amountOut confirmed received in prior rounds. */
  cumulativeFilledAmountOut: bigint;
  /**
   * Pools not used by this round's legs but still known-live candidates for
   * a future replan() round (i.e. the rest of the inventory passed to plan(),
   * after the liveness/eligibility filter).
   */
  remainingInventory: PoolState[];
}

export type LegResult =
  | { outpoint: string; status: "filled" }
  | { outpoint: string; status: "rejected"; newPoolState?: PoolState }
  | { outpoint: string; status: "timeout" };

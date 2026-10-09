/**
 * The AMM Pool script template (pool/Pool.runar.go) over runar-sdk.
 *
 * On chain a pool output is a BRC-162 (Mandala) value output wrapped around the
 * Rúnar contract:
 *
 *   0x20 <assetId:32> <push tokenReserve> OP_2DROP || code || OP_RETURN || state
 *
 * `code` is the artifact's template with the readonly constructor args
 * (assetId, lpFeeBps, validatorFeeBps, commissionBps) spliced in; `state` is TokenReserve
 * (8 bytes LE sign-magnitude) ‖ LpPubKey ‖ ValidatorPubKey ‖ ValidatorIdentity.
 * runar-sdk knows nothing of the prefix, so this module splits it off and hands
 * runar-sdk only `code || OP_RETURN || state`.
 *
 * A method call (input 0's unlocking script) is pushes only, in the order the
 * compiled contract reads them:
 *
 *   _codePart  arg0 .. argN-1  _changePKH  _changeAmount  txPreimage  methodIndex
 *
 * The preimage is BIP-143 (ALL|FORKID) over the pool input with the scriptCode
 * after Rúnar's leading `OP_NOP OP_CODESEPARATOR`; every signature a method
 * checks (validator's, LP's) is over sha256d of that preimage. BIP-143 does not
 * cover any unlocking script, so the builder (taker or LP) finishes the whole
 * transaction, signs its own inputs, and leaves the validator's slot empty
 * (`OP_0`); the validator then fills its slot with `signPoolInput` without
 * invalidating anything else. That is the sequence pool/pool_test.go and
 * programs/amm-topic/gen use.
 *
 * Uses from runar-sdk: artifact matching, constructor-arg and state extraction,
 * state serialization, the code part, the BIP-143 preimage at the code
 * separator (`computeOpPushTxWithCodeSep`), and its push encoders.
 * `RunarContract.prepareCall` is not used: it needs a Provider to select
 * funding and sets the fee from a fee rate, it builds the continuation from
 * the bare artifact script (no BRC-162 prefix), and this contract's outputs
 * come from `addRawOutput` with a prefix the SDK cannot predict.
 */
import {
  EMPTY_SIG,
  RunarContract,
  encodeArg,
  encodePushData,
  encodeScriptNumber,
  extractConstructorArgs,
  extractStateFromScript,
  findLastOpReturn,
  matchesArtifact,
  serializeState,
} from "runar-sdk";
import {
  Hash,
  LockingScript,
  P2PKH,
  PrivateKey,
  PublicKey,
  Signature,
  Transaction,
  UnlockingScript,
  Utils,
} from "@bsv/sdk";
import { CTOR, METHOD_INDEX, poolArtifact, type PoolMethod } from "./artifact";
import { decodeMandala, mandalaValuePrefix } from "./mandala";
import { deriveValidatorPubKey } from "../lib/keys";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The readonly constructor args (compiled into the code). */
export interface PoolArgs {
  /** The token's 32-byte BRC-162 id, hex, wire (internal) byte order. */
  assetId: string;
  lpFeeBps: bigint;
  validatorFeeBps: bigint;
  /** The relay's commission (constructor param 7), bps of amountIn in the input asset, paid to Swap's `commissionPkh`. */
  commissionBps: bigint;
}

/** The mutable state after OP_RETURN. Keys are 33-byte compressed hex. */
export interface PoolFields {
  tokenReserve: bigint;
  lpPubKey: string;
  validatorPubKey: string;
  validatorIdentity: string;
}

/** A decoded pool locking script. */
export interface Pool {
  args: PoolArgs;
  state: PoolFields;
  /** The Rúnar code (hex): what a call pushes as `_codePart`. */
  code: string;
  /** `code || OP_RETURN || state` (hex): the script runar-sdk sees. */
  contractScript: string;
}

/** A pool output being spent. */
export interface PoolUtxo {
  txid: string;
  vout: number;
  satoshis: number;
  script: string | LockingScript;
  /** The pool's source transaction, when known (kept on the input for BEEF). */
  sourceTransaction?: Transaction;
}

/** A non-pool input the builder adds after the pool (funding, token inputs). */
export interface BuilderInput {
  txid: string;
  vout: number;
  satoshis: number;
  lockingScript: string | LockingScript;
  sourceTransaction?: Transaction;
  /**
   * Signs this input once the transaction is final (e.g. `new P2PKH().unlock(key,
   * "all", false, satoshis, lockingScript)`; a Mandala token on P2PKH unlocks the
   * same way). Omitted: the input is left unsigned for a wallet to sign, and
   * `estimatedUnlockLength` (default 107, a P2PKH) sizes the fee.
   */
  unlock?: { sign(tx: Transaction, inputIndex: number): Promise<UnlockingScript>; estimateLength(): Promise<number> };
  estimatedUnlockLength?: number;
}

/** The miner fee: absolute sats, or a rate over the finished size. */
export type FeeSpec = { sats: number } | { satsPerKb: number };

interface CallCommon {
  pool: PoolUtxo;
  inputs: BuilderInput[];
  /** Hash160 (hex) the change goes to. */
  changePkh: string;
  fee: FeeSpec;
}

export interface SwapParams extends CallCommon {
  amountIn: bigint;
  /** true: BSV in, tokens out. */
  bsvIn: boolean;
  /** Hash160 (hex) of the taker's payout. */
  userPkh: string;
  /** The validator key for the continuation. Default: derived from ValidatorIdentity and the pool outpoint (src/lib/keys.ts). */
  nextValidatorPubKey?: string;
  /**
   * Hash160 (hex) the commission goes to (Swap's `commissionPkh`): the relay's
   * `amm.swap.terms` address, or the taker's own. Always pushed; an output
   * only when the commission (ceil(amountIn·CommissionBps/10000)) is nonzero.
   */
  commissionPkh: string;
  /** What the caller priced the leg against; any mismatch is refused (see PoolBuildError). */
  expect?: SwapExpectation;
}

/** `SwapParams` without the funding (inputs, change, fee): see `PoolTemplate.planSwap`. */
export type SwapPlanParams = Omit<SwapParams, "inputs" | "changePkh" | "fee">;

/** A pool call's required outputs and method arguments, before any funding is chosen. */
export interface CallPlan {
  pool: Pool;
  poolUtxo: PoolUtxo;
  method: PoolMethod;
  /** The outputs the contract requires, in order; change (if any) follows them. */
  outputs: { satoshis: bigint; script: string }[];
  /** The method arguments, signature slots `EMPTY_SIG`. */
  args: unknown[];
  sigSlots: Partial<Record<SigSlot, number>>;
  next: { pool: Pool; satoshis: number; script: LockingScript };
}

export interface SwapExpectation {
  bsvReserve?: bigint;
  tokenReserve?: bigint;
  lpFeeBps?: bigint;
  validatorFeeBps?: bigint;
  commissionBps?: bigint;
  lpFee?: bigint;
  validatorFee?: bigint;
  commission?: bigint;
  amountOut?: bigint;
  minAmountOut?: bigint;
}

export interface AddLiquidityParams extends CallCommon {
  addBsv: bigint;
  addTokens: bigint;
  nextLpPubKey: string;
  nextValidatorPubKey?: string;
  /** The LP's current key; when given, the LP slot is signed here. */
  lpKey?: PoolSigner;
}

export interface RemoveLiquidityParams extends CallCommon {
  removeBsv: bigint;
  removeTokens: bigint;
  nextLpPubKey: string;
  /** The LP's current key; when given, the LP slot is signed here. */
  lpKey?: PoolSigner;
}

/** Signs a 32-byte sighash, returning a DER signature (without the sighash byte). */
export type PoolSigner = PrivateKey | ((sighash: number[]) => Promise<number[]>);

export type SigSlot = "validator" | "lp";

/** A built pool call. */
export interface PoolCall {
  tx: Transaction;
  method: PoolMethod;
  /** The spent pool. */
  pool: Pool;
  /** The continuation (output 0), or null when RemoveLiquidity closes the pool. */
  next: { pool: Pool; satoshis: number; script: LockingScript } | null;
  /** BIP-143 preimage (hex) the pool's signatures are over. */
  preimage: string;
  /** sha256d(preimage), hex: what the validator / LP sign. */
  sighash: string;
  /** Signature slots still OP_0 in input 0. */
  unsigned: SigSlot[];
  change: number;
  fee: number;
  /** Swap only: the trade, as the contract computes it. */
  swap?: SwapAmounts;
}

/** A swap's trade, as the contract computes it (each fee in the input asset). */
export interface SwapAmounts {
  amountOut: bigint;
  lpFee: bigint;
  validatorFee: bigint;
  commission: bigint;
}

export type PoolBuildErrorCode =
  | "not_a_pool"
  | "stale_pool"
  | "fee_mismatch"
  | "quote_mismatch"
  | "slippage"
  | "token_mismatch"
  | "insufficient_funds"
  | "invalid";

/** A refusal by the builder's own checks: nothing was signed. */
export class PoolBuildError extends Error {
  constructor(
    readonly code: PoolBuildErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "PoolBuildError";
  }
}

// ---------------------------------------------------------------------------
// Script helpers
// ---------------------------------------------------------------------------

const toHex = (b: number[] | Uint8Array) => Utils.toHex(Array.from(b));
const fromHex = (h: string) => Utils.toArray(h, "hex") as number[];
const scriptHex = (s: string | LockingScript) => (typeof s === "string" ? s.toLowerCase() : s.toHex());

const p2pkhHex = (pkh: string) => `76a914${pkh}88ac`;
const pkhOf = (pubKeyHex: string) => toHex(Hash.hash160(fromHex(pubKeyHex)) as number[]);

function tokenPrefixHex(assetId: string, amount: bigint): string {
  return toHex(mandalaValuePrefix(fromHex(assetId), amount));
}

/** `tokenP2pkh` in Pool.runar.go: a Mandala value output of `amount` to `pkh`. */
function tokenP2pkhHex(assetId: string, amount: bigint, pkh: string): string {
  return tokenPrefixHex(assetId, amount) + p2pkhHex(pkh);
}

function ctorArgs(args: PoolArgs, state: PoolFields): unknown[] {
  const a: unknown[] = [];
  a[CTOR.tokenReserve] = state.tokenReserve;
  a[CTOR.lpPubKey] = state.lpPubKey;
  a[CTOR.validatorPubKey] = state.validatorPubKey;
  a[CTOR.validatorIdentity] = state.validatorIdentity;
  a[CTOR.assetId] = args.assetId;
  a[CTOR.lpFeeBps] = args.lpFeeBps;
  a[CTOR.validatorFeeBps] = args.validatorFeeBps;
  a[CTOR.commissionBps] = args.commissionBps;
  return a;
}

function stateHex(state: PoolFields): string {
  return serializeState(poolArtifact.stateFields!, { ...state });
}

function isHex(s: unknown, bytes: number): s is string {
  return typeof s === "string" && s.length === bytes * 2 && /^[0-9a-f]*$/.test(s);
}

// ---------------------------------------------------------------------------
// The template
// ---------------------------------------------------------------------------

export class PoolTemplate {
  /**
   * Decodes a pool locking script: a Mandala value prefix with a 32-byte id and
   * no payload, then the Pool artifact (template bytes between the constructor
   * slots), then the state. Also requires prefix id == assetId and prefix
   * amount == TokenReserve (the admission check of Pool.runar.go's doc).
   * Returns null for anything else.
   */
  static decode(script: string | LockingScript | number[]): Pool | null {
    const bytes = Array.isArray(script) ? script : fromHex(scriptHex(script));
    const prefix = decodeMandala(bytes);
    if (!prefix || prefix.role !== "value" || prefix.payload !== undefined) return null;
    if (prefix.idBytes?.length !== 32) return null;

    const contractScript = toHex(bytes.slice(prefix.length));
    if (!matchesArtifact(poolArtifact, contractScript)) return null;
    const ctor = extractConstructorArgs(poolArtifact, contractScript);
    let raw: Record<string, unknown> | null;
    try {
      raw = extractStateFromScript(poolArtifact, contractScript);
    } catch {
      return null;
    }
    if (!raw) return null;
    const { assetId, lpFeeBps, validatorFeeBps, commissionBps } = ctor;
    const { tokenReserve, lpPubKey, validatorPubKey, validatorIdentity } = raw;
    if (!isHex(assetId, 32) || typeof lpFeeBps !== "bigint" || typeof validatorFeeBps !== "bigint" || typeof commissionBps !== "bigint") return null;
    if (typeof tokenReserve !== "bigint" || !isHex(lpPubKey, 33) || !isHex(validatorPubKey, 33) || !isHex(validatorIdentity, 33)) {
      return null;
    }
    if (assetId !== toHex(prefix.idBytes) || tokenReserve !== prefix.amount) return null;

    const opReturn = findLastOpReturn(contractScript);
    return {
      args: { assetId, lpFeeBps, validatorFeeBps, commissionBps },
      state: { tokenReserve, lpPubKey, validatorPubKey, validatorIdentity },
      code: contractScript.slice(0, opReturn),
      contractScript,
    };
  }

  /**
   * The pool locking script for `args` and `state`: the Mandala prefix for
   * TokenReserve (which the contract writes itself on every continuation, but
   * nothing on chain writes for a deploy) in front of runar-sdk's locking
   * script for the constructor args.
   */
  static lockDeploy(args: PoolArgs, state: PoolFields): LockingScript {
    if (!isHex(args.assetId, 32)) throw new Error("lockDeploy: assetId must be 32 bytes of hex");
    for (const k of ["lpPubKey", "validatorPubKey", "validatorIdentity"] as const) {
      PublicKey.fromString(state[k]); // throws on a malformed key
    }
    const contract = new RunarContract(poolArtifact, ctorArgs(args, state));
    return LockingScript.fromHex(tokenPrefixHex(args.assetId, state.tokenReserve) + contract.getLockingScript());
  }

  /** The continuation script: `code` kept byte for byte, prefix and state rewritten. */
  static lockContinuation(pool: Pool, state: PoolFields): LockingScript {
    return LockingScript.fromHex(tokenPrefixHex(pool.args.assetId, state.tokenReserve) + pool.code + "6a" + stateHex(state));
  }

  // -------------------------------------------------------------------------
  // Methods
  // -------------------------------------------------------------------------

  /**
   * Swap (method 0). Outputs: 0 pool, 1 the taker's payout, then the LP fee,
   * the validator fee and the commission (each only when nonzero, each in
   * the input asset), then change. Token payouts and token fees are 1-sat
   * Mandala outputs; BSV ones are P2PKH. The validator's slot is left empty.
   */
  static async swap(p: SwapParams): Promise<PoolCall> {
    const plan = PoolTemplate.planSwap(p);
    // Tokens in: the token inputs must carry exactly amountIn (no token change
    // output exists). BSV in: no token of this asset may be spent (it would burn).
    checkTokenInputs(p.inputs, plan.pool.args.assetId, p.bsvIn ? 0n : p.amountIn);
    const call = await buildCall({
      common: p,
      pool: plan.pool,
      method: "swap",
      outputs: plan.outputs,
      args: plan.args,
      sigSlots: plan.sigSlots,
    });
    call.next = plan.next;
    call.next.script = call.tx.outputs[0]!.lockingScript;
    call.swap = plan.swap;
    return call;
  }

  /**
   * The Swap call without its funding: the outputs the contract requires (in
   * order: pool, payout, LP fee, validator fee, commission; no change) and
   * the method arguments, with the validator's slot empty. For a builder that
   * does not pick the funding itself (a BRC-100 wallet's `createAction` picks
   * inputs and change): hand these outputs over, then fill input 0 with
   * `callUnlock` over the transaction the wallet produced. Same checks and
   * refusals as `swap` except the funding ones.
   */
  static planSwap(p: SwapPlanParams): CallPlan & { swap: SwapAmounts } {
    const pool = decodeUtxo(p.pool);
    const { args, state } = pool;
    const bsvReserve = BigInt(p.pool.satoshis);
    const e = p.expect ?? {};
    if (e.bsvReserve !== undefined && e.bsvReserve !== bsvReserve) {
      throw new PoolBuildError("stale_pool", `BSV reserve is ${bsvReserve}, priced against ${e.bsvReserve}`);
    }
    if (e.tokenReserve !== undefined && e.tokenReserve !== state.tokenReserve) {
      throw new PoolBuildError("stale_pool", `token reserve is ${state.tokenReserve}, priced against ${e.tokenReserve}`);
    }
    if (e.lpFeeBps !== undefined && e.lpFeeBps !== args.lpFeeBps) {
      throw new PoolBuildError("fee_mismatch", `pool LP fee is ${args.lpFeeBps} bps, priced at ${e.lpFeeBps}`);
    }
    if (e.validatorFeeBps !== undefined && e.validatorFeeBps !== args.validatorFeeBps) {
      throw new PoolBuildError("fee_mismatch", `pool validator fee is ${args.validatorFeeBps} bps, priced at ${e.validatorFeeBps}`);
    }
    if (e.commissionBps !== undefined && e.commissionBps !== args.commissionBps) {
      throw new PoolBuildError("fee_mismatch", `pool commission is ${args.commissionBps} bps, priced at ${e.commissionBps}`);
    }

    if (!isHex(p.commissionPkh, 20)) throw new PoolBuildError("invalid", "commissionPkh must be 20 bytes of hex");
    if (!isHex(p.userPkh, 20)) throw new PoolBuildError("invalid", "userPkh must be 20 bytes of hex");

    // Pool.runar.go Swap, line for line.
    const amountIn = p.amountIn;
    if (amountIn <= 0n) throw new PoolBuildError("invalid", "amountIn must be > 0");
    const lpFee = (amountIn * args.lpFeeBps + 9999n) / 10000n;
    const validatorFee = (amountIn * args.validatorFeeBps + 9999n) / 10000n;
    const commission = (amountIn * args.commissionBps + 9999n) / 10000n;
    const net = amountIn - lpFee - validatorFee - commission;
    if (net <= 0n) throw new PoolBuildError("invalid", "amountIn does not cover the fees");
    let out = (net * bsvReserve) / (state.tokenReserve + net);
    let newBsv = bsvReserve - out;
    let newTokens = state.tokenReserve + net;
    if (p.bsvIn) {
      out = (net * state.tokenReserve) / (bsvReserve + net);
      newBsv = bsvReserve + net;
      newTokens = state.tokenReserve - out;
    }
    if (out <= 0n) throw new PoolBuildError("invalid", "amountIn too small: nothing out");
    if (newBsv <= 0n || newTokens <= 0n) throw new PoolBuildError("invalid", "the swap would empty the pool");
    if (e.lpFee !== undefined && e.lpFee !== lpFee) {
      throw new PoolBuildError("fee_mismatch", `LP fee is ${lpFee}, priced at ${e.lpFee}`);
    }
    if (e.validatorFee !== undefined && e.validatorFee !== validatorFee) {
      throw new PoolBuildError("fee_mismatch", `validator fee is ${validatorFee}, priced at ${e.validatorFee}`);
    }
    if (e.commission !== undefined && e.commission !== commission) {
      throw new PoolBuildError("fee_mismatch", `commission is ${commission}, priced at ${e.commission}`);
    }
    if (e.amountOut !== undefined && e.amountOut !== out) {
      throw new PoolBuildError("quote_mismatch", `amount out is ${out}, quoted ${e.amountOut}`);
    }
    if (e.minAmountOut !== undefined && out < e.minAmountOut) {
      throw new PoolBuildError("slippage", `amount out ${out} is below the minimum ${e.minAmountOut}`);
    }

    const nextValidatorPubKey = p.nextValidatorPubKey ?? deriveValidatorPubKey(state.validatorIdentity, { txid: p.pool.txid, vout: p.pool.vout });
    PublicKey.fromString(nextValidatorPubKey);
    const nextState: PoolFields = { ...state, tokenReserve: newTokens, validatorPubKey: nextValidatorPubKey };
    const lpPkh = pkhOf(state.lpPubKey);
    const validatorPkh = pkhOf(state.validatorPubKey);
    const payout = (amount: bigint, pkh: string, isBsv: boolean) =>
      isBsv ? { satoshis: amount, script: p2pkhHex(pkh) } : { satoshis: 1n, script: tokenP2pkhHex(args.assetId, amount, pkh) };

    const continuation = PoolTemplate.lockContinuation(pool, nextState);
    const outputs: { satoshis: bigint; script: string }[] = [
      { satoshis: newBsv, script: continuation.toHex() },
      payout(out, p.userPkh, !p.bsvIn),
    ];
    if (lpFee > 0n) outputs.push(payout(lpFee, lpPkh, p.bsvIn));
    if (validatorFee > 0n) outputs.push(payout(validatorFee, validatorPkh, p.bsvIn));
    if (commission > 0n) outputs.push(payout(commission, p.commissionPkh, p.bsvIn));

    return {
      pool,
      poolUtxo: p.pool,
      method: "swap",
      outputs,
      args: [EMPTY_SIG, nextValidatorPubKey, amountIn, p.bsvIn, p.userPkh, p.commissionPkh],
      sigSlots: { validator: 0 },
      next: { pool: { ...pool, state: nextState, contractScript: pool.code + "6a" + stateHex(nextState) }, satoshis: Number(newBsv), script: continuation },
      swap: { amountOut: out, lpFee, validatorFee, commission },
    };
  }

  /**
   * The pool input's unlocking script for `plan` over a finished transaction
   * `tx` whose input 0 spends `plan.poolUtxo` and whose outputs are
   * `plan.outputs`, then (optionally) one P2PKH change output: `change` names
   * it (`{pkh, satoshis}`), or `null` when there is none. Signature slots stay
   * empty (`OP_0`), to be filled with `signPoolInput`. Throws when `tx` does
   * not have that shape (the contract would refuse it).
   */
  static callUnlock(plan: CallPlan, tx: Transaction, change: { pkh: string; satoshis: number } | null): { unlockingScript: UnlockingScript; preimage: string; sighash: string } {
    const in0 = tx.inputs[0];
    if (!in0 || in0.sourceTXID !== plan.poolUtxo.txid || in0.sourceOutputIndex !== plan.poolUtxo.vout) {
      throw new PoolBuildError("invalid", "input 0 does not spend the pool");
    }
    const want = plan.outputs.length + (change ? 1 : 0);
    if (tx.outputs.length !== want) throw new PoolBuildError("invalid", `the transaction has ${tx.outputs.length} outputs, the call needs ${want}`);
    plan.outputs.forEach((o, i) => {
      const got = tx.outputs[i]!;
      if (BigInt(got.satoshis ?? -1) !== o.satoshis || got.lockingScript.toHex() !== o.script) {
        throw new PoolBuildError("invalid", `output ${i} is not the one the contract requires`);
      }
    });
    if (change) {
      if (!isHex(change.pkh, 20)) throw new PoolBuildError("invalid", "change pkh must be 20 bytes of hex");
      const got = tx.outputs[plan.outputs.length]!;
      if (got.satoshis !== change.satoshis || got.lockingScript.toHex() !== p2pkhHex(change.pkh)) {
        throw new PoolBuildError("invalid", "the last output is not the named P2PKH change");
      }
    }
    const methodIndex = METHOD_INDEX[plan.method];
    const preimage = contractPreimage(tx, plan.pool, plan.poolUtxo.satoshis, methodIndex);
    const hex = callUnlockHex(plan.pool, plan.args, change?.pkh ?? "00".repeat(20), BigInt(change?.satoshis ?? 0), preimage, methodIndex);
    return { unlockingScript: UnlockingScript.fromHex(hex), preimage, sighash: toHex(Hash.hash256(fromHex(preimage)) as number[]) };
  }

  /**
   * An upper bound on the length of `plan`'s pool unlocking script once every
   * signature slot is filled: what a wallet's `createAction` is told as the
   * pool input's `unlockingScriptLength` before the transaction exists (the
   * fee is sized from it). The preimage's length depends only on the code, so
   * it is exact; the change amount is bounded by 2^53.
   */
  static maxCallUnlockLength(plan: CallPlan): number {
    const tx = new Transaction();
    tx.addInput({ sourceTXID: plan.poolUtxo.txid, sourceOutputIndex: plan.poolUtxo.vout, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
    for (const o of plan.outputs) tx.addOutput({ satoshis: Number(o.satoshis), lockingScript: LockingScript.fromHex(o.script) });
    const methodIndex = METHOD_INDEX[plan.method];
    const preimage = contractPreimage(tx, plan.pool, plan.poolUtxo.satoshis, methodIndex);
    const hex = callUnlockHex(plan.pool, plan.args, "00".repeat(20), BigInt(Number.MAX_SAFE_INTEGER), preimage, methodIndex);
    return hex.length / 2 + Object.keys(plan.sigSlots).length * (SIG_PUSH_LEN - 1);
  }

  /**
   * AddLiquidity (method 1). Outputs: 0 pool, then change. Needs the LP's and
   * the validator's signatures; the LP's is filled here when `lpKey` is given.
   */
  static async addLiquidity(p: AddLiquidityParams): Promise<PoolCall> {
    const plan = PoolTemplate.planAddLiquidity(p);
    checkTokenInputs(p.inputs, plan.pool.args.assetId, p.addTokens);
    const call = await buildCall({
      common: p,
      pool: plan.pool,
      method: "addLiquidity",
      outputs: plan.outputs,
      args: plan.args,
      sigSlots: plan.sigSlots,
    });
    call.next = { ...plan.next, script: call.tx.outputs[0]!.lockingScript };
    if (p.lpKey) await PoolTemplate.signPoolInput(call, "lp", p.lpKey);
    return call;
  }

  /**
   * The AddLiquidity call without its funding (as `planSwap` for Swap): the
   * one output the contract requires (the continuation at pool sats +
   * addBsv, TokenReserve + addTokens, the next LP and validator keys) and
   * the method arguments, both signature slots empty. The contract does not
   * fix the ratio (the LP owns the pool): any addBsv, addTokens >= 0, not
   * both 0. For a builder that funds the call itself: add the funding and
   * exactly `addTokens` of token inputs, fill input 0 with `callUnlock`, the
   * LP's slot with `signPoolInput`; the validator signs its slot last.
   */
  static planAddLiquidity(p: { pool: PoolUtxo; addBsv: bigint; addTokens: bigint; nextLpPubKey: string; nextValidatorPubKey?: string }): CallPlan {
    const pool = decodeUtxo(p.pool);
    const { state } = pool;
    if (p.addBsv < 0n || p.addTokens < 0n || p.addBsv + p.addTokens <= 0n) {
      throw new PoolBuildError("invalid", "addBsv and addTokens must be >= 0, and not both 0");
    }
    const nextValidatorPubKey = p.nextValidatorPubKey ?? deriveValidatorPubKey(state.validatorIdentity, { txid: p.pool.txid, vout: p.pool.vout });
    PublicKey.fromString(nextValidatorPubKey);
    PublicKey.fromString(p.nextLpPubKey);
    const nextState: PoolFields = {
      ...state,
      tokenReserve: state.tokenReserve + p.addTokens,
      lpPubKey: p.nextLpPubKey,
      validatorPubKey: nextValidatorPubKey,
    };
    const newBsv = BigInt(p.pool.satoshis) + p.addBsv;
    const continuation = PoolTemplate.lockContinuation(pool, nextState);
    return {
      pool,
      poolUtxo: p.pool,
      method: "addLiquidity",
      outputs: [{ satoshis: newBsv, script: continuation.toHex() }],
      args: [EMPTY_SIG, EMPTY_SIG, p.nextLpPubKey, nextValidatorPubKey, p.addBsv, p.addTokens],
      sigSlots: { lp: 0, validator: 1 },
      next: { pool: { ...pool, state: nextState, contractScript: pool.code + "6a" + stateHex(nextState) }, satoshis: Number(newBsv), script: continuation },
    };
  }

  /**
   * RemoveLiquidity (method 2). Outputs: 0 pool (unless both reserves reach 0),
   * then the BSV withdrawal and the token withdrawal to the LP's current key
   * (each when nonzero), then change. LP-only: no validator signature.
   */
  static async removeLiquidity(p: RemoveLiquidityParams): Promise<PoolCall> {
    const plan = PoolTemplate.planRemoveLiquidity(p);
    checkTokenInputs(p.inputs, plan.pool.args.assetId, 0n);
    const call = await buildCall({
      common: p,
      pool: plan.pool,
      method: "removeLiquidity",
      outputs: plan.outputs,
      args: plan.args,
      sigSlots: plan.sigSlots,
    });
    call.next = plan.closing ? null : { ...plan.next, script: call.tx.outputs[0]!.lockingScript };
    if (p.lpKey) await PoolTemplate.signPoolInput(call, "lp", p.lpKey);
    return call;
  }

  /**
   * The RemoveLiquidity call without its funding (as `planSwap` for Swap):
   * the outputs the contract requires (pool unless closing, the BSV
   * withdrawal, the token withdrawal, each to Hash160 of the current
   * LpPubKey) and the method arguments, the LP's slot empty. For a BRC-100
   * wallet that picks the funding and the change: hand these outputs over,
   * fill input 0 with `callUnlock`, then the LP's slot with `signPoolInput`.
   */
  static planRemoveLiquidity(p: { pool: PoolUtxo; removeBsv: bigint; removeTokens: bigint; nextLpPubKey: string }): CallPlan & { closing: boolean } {
    const pool = decodeUtxo(p.pool);
    const { args, state } = pool;
    if (p.removeBsv < 0n || p.removeTokens < 0n || p.removeBsv + p.removeTokens <= 0n) {
      throw new PoolBuildError("invalid", "removeBsv and removeTokens must be >= 0, and not both 0");
    }
    PublicKey.fromString(p.nextLpPubKey);
    const newBsv = BigInt(p.pool.satoshis) - p.removeBsv;
    const newTokens = state.tokenReserve - p.removeTokens;
    const closing = newBsv === 0n && newTokens === 0n;
    if (!closing && !(newBsv > 0n && newTokens > 0n)) {
      throw new PoolBuildError("invalid", "either both reserves stay positive or both reach zero");
    }
    const nextState: PoolFields = { ...state, tokenReserve: newTokens, lpPubKey: p.nextLpPubKey };
    const lpPkh = pkhOf(state.lpPubKey);
    const outputs: { satoshis: bigint; script: string }[] = [];
    // A closing call has no continuation (and a zero token reserve has no Mandala prefix to write).
    const continuation = closing ? new LockingScript() : PoolTemplate.lockContinuation(pool, nextState);
    if (!closing) outputs.push({ satoshis: newBsv, script: continuation.toHex() });
    if (p.removeBsv > 0n) outputs.push({ satoshis: p.removeBsv, script: p2pkhHex(lpPkh) });
    if (p.removeTokens > 0n) outputs.push({ satoshis: 1n, script: tokenP2pkhHex(args.assetId, p.removeTokens, lpPkh) });
    return {
      pool,
      poolUtxo: p.pool,
      method: "removeLiquidity",
      outputs,
      args: [EMPTY_SIG, p.nextLpPubKey, p.removeBsv, p.removeTokens],
      sigSlots: { lp: 0 },
      next: { pool: { ...pool, state: nextState, contractScript: pool.code + "6a" + stateHex(nextState) }, satoshis: Number(newBsv), script: continuation },
      closing,
    };
  }

  // -------------------------------------------------------------------------
  // The pool input's signatures
  // -------------------------------------------------------------------------

  /**
   * The BIP-143 preimage of `tx`'s pool input (input 0), computed from the
   * transaction itself. Needs the pool output being spent: `source`, or input
   * 0's `sourceTransaction`.
   */
  static preimage(tx: Transaction, source?: { satoshis: number; script: string | LockingScript }): string {
    const in0 = tx.inputs[0];
    if (!in0) throw new Error("preimage: no input 0");
    let satoshis: number | undefined;
    let lock: string | LockingScript | undefined;
    if (source) {
      satoshis = source.satoshis;
      lock = source.script;
    } else {
      const out = in0.sourceTransaction?.outputs[in0.sourceOutputIndex];
      satoshis = out?.satoshis;
      lock = out?.lockingScript;
    }
    if (satoshis === undefined || lock === undefined) throw new Error("preimage: the spent pool output is unknown");
    const pool = PoolTemplate.decode(lock);
    if (!pool) throw new Error("preimage: input 0 does not spend a pool");
    const call = parseCall(tx.inputs[0]!.unlockingScript?.toHex() ?? "");
    const methodIndex = call ? Number(call.methodIndex) : 0;
    return contractPreimage(tx, pool, satoshis, methodIndex);
  }

  /**
   * Fills signature slot `slot` of the pool input with `signer`'s signature
   * over the preimage recomputed from `call.tx` (which must agree with the
   * preimage pushed in the call). Every other push is kept byte for byte;
   * no other input's signature is affected.
   */
  static async signPoolInput(call: Pick<PoolCall, "tx" | "pool" | "method" | "unsigned"> & { sourceSatoshis?: number }, slot: SigSlot, signer: PoolSigner): Promise<void> {
    const tx = call.tx;
    const unlock = tx.inputs[0]!.unlockingScript?.toHex() ?? "";
    const parsed = parseCall(unlock);
    if (!parsed) throw new Error("signPoolInput: input 0 is not a pool call");
    const methodIndex = METHOD_INDEX[call.method];
    if (parsed.methodIndex !== BigInt(methodIndex)) throw new Error("signPoolInput: method index differs");
    const satoshis = call.sourceSatoshis ?? sourceSatoshisOf(tx);
    const preimage = contractPreimage(tx, call.pool, satoshis, methodIndex);
    if (preimage !== parsed.preimage) throw new Error("signPoolInput: the pushed preimage does not match the transaction");
    const argIndex = SIG_SLOTS[call.method][slot];
    if (argIndex === undefined) throw new Error(`signPoolInput: ${call.method} has no ${slot} signature`);
    const expected = slot === "validator" ? call.pool.state.validatorPubKey : call.pool.state.lpPubKey;
    if (signer instanceof PrivateKey && signer.toPublicKey().toString() !== expected) {
      throw new Error(`signPoolInput: that key is not the pool's ${slot} key (${expected})`);
    }
    const sighash = Hash.hash256(fromHex(preimage)) as number[];
    const der = signer instanceof PrivateKey ? (signer.sign(Hash.sha256(fromHex(preimage)) as number[]) as Signature).toDER() as number[] : await signer(sighash);
    const sigHex = toHex(der) + "41";
    tx.inputs[0]!.unlockingScript = UnlockingScript.fromHex(replacePush(unlock, parsed.pushes, 1 + argIndex, encodePushData(sigHex)));
    call.unsigned = call.unsigned.filter((s) => s !== slot);
  }
}

/** Arg index of each signature, per method (Pool.runar.go's parameter order). */
const SIG_SLOTS: Record<PoolMethod, Partial<Record<SigSlot, number>>> = {
  swap: { validator: 0 },
  addLiquidity: { lp: 0, validator: 1 },
  removeLiquidity: { lp: 0 },
};

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function decodeUtxo(utxo: PoolUtxo): Pool {
  const pool = PoolTemplate.decode(utxo.script);
  if (!pool) throw new PoolBuildError("not_a_pool", `${utxo.txid}:${utxo.vout} is not a pool output`);
  if (!Number.isSafeInteger(utxo.satoshis) || utxo.satoshis <= 0) throw new PoolBuildError("invalid", "pool satoshis");
  return pool;
}

function checkTokenInputs(inputs: BuilderInput[], assetId: string, expected: bigint): void {
  let sum = 0n;
  for (const i of inputs) {
    const t = decodeMandala(fromHex(scriptHex(i.lockingScript)));
    if (t && t.idBytes && toHex(t.idBytes) === assetId) sum += t.amount;
  }
  if (sum !== expected) {
    throw new PoolBuildError("token_mismatch", `token inputs carry ${sum} of the pool's token, the call needs exactly ${expected}`);
  }
}

function sourceSatoshisOf(tx: Transaction): number {
  const in0 = tx.inputs[0]!;
  const sats = in0.sourceTransaction?.outputs[in0.sourceOutputIndex]?.satoshis;
  if (sats === undefined) throw new Error("the pool input's source satoshis are unknown");
  return sats;
}

function contractPreimage(tx: Transaction, pool: Pool, satoshis: number, methodIndex: number): string {
  if (!tx.inputs[0]!.sourceTXID) {
    throw new Error("the pool input needs its sourceTXID");
  }
  const contract = RunarContract.fromUtxo(poolArtifact, {
    txid: tx.inputs[0]!.sourceTXID,
    outputIndex: tx.inputs[0]!.sourceOutputIndex,
    satoshis,
    script: pool.contractScript,
  });
  return contract.computeOpPushTxWithCodeSep(tx, 0, pool.contractScript, satoshis, methodIndex).preimageHex;
}

interface ParsedCall {
  pushes: { start: number; end: number }[]; // hex offsets
  preimage: string;
  methodIndex: bigint;
}

/** Splits a pushes-only unlocking script; null when it is not one. */
function parseCall(hex: string): ParsedCall | null {
  const pushes: { start: number; end: number; data: string; op: number }[] = [];
  let pos = 0;
  while (pos < hex.length) {
    const op = parseInt(hex.slice(pos, pos + 2), 16);
    let len: number;
    let at = pos + 2;
    if (op === 0) len = 0;
    else if (op <= 0x4b) len = op;
    else if (op === 0x4c) {
      len = parseInt(hex.slice(at, at + 2), 16);
      at += 2;
    } else if (op === 0x4d) {
      len = parseInt(hex.slice(at + 2, at + 4) + hex.slice(at, at + 2), 16);
      at += 4;
    } else if (op === 0x4e) {
      len = parseInt(hex.slice(at + 6, at + 8) + hex.slice(at + 4, at + 6) + hex.slice(at + 2, at + 4) + hex.slice(at, at + 2), 16);
      at += 8;
    } else if (op === 0x4f || (op >= 0x51 && op <= 0x60)) len = 0;
    else return null;
    const end = at + len * 2;
    if (end > hex.length) return null;
    pushes.push({ start: pos, end, data: hex.slice(at, end), op });
    pos = end;
  }
  if (pushes.length < 3) return null;
  const sel = pushes[pushes.length - 1]!;
  const methodIndex = sel.op === 0 ? 0n : sel.op >= 0x51 && sel.op <= 0x60 ? BigInt(sel.op - 0x50) : -1n;
  return { pushes, preimage: pushes[pushes.length - 2]!.data, methodIndex };
}

function replacePush(hex: string, pushes: { start: number; end: number }[], i: number, push: string): string {
  const p = pushes[i]!;
  return hex.slice(0, p.start) + push + hex.slice(p.end);
}

/** `_codePart args… _changePKH _changeAmount txPreimage methodIndex`, as pushes. */
function callUnlockHex(pool: Pool, args: unknown[], changePkh: string, change: bigint, preimage: string, methodIndex: number): string {
  let hex = encodePushData(pool.code);
  for (const a of args) hex += encodeArg(a);
  return hex + encodePushData(changePkh) + encodeArg(change) + encodePushData(preimage) + encodeScriptNumber(BigInt(methodIndex));
}

const P2PKH_UNLOCK_LEN = 107;
const SIG_PUSH_LEN = 74; // length byte + a DER signature (<= 72) + the sighash byte

async function buildCall(o: {
  common: CallCommon;
  pool: Pool;
  method: PoolMethod;
  outputs: { satoshis: bigint; script: string }[];
  args: unknown[];
  sigSlots: Partial<Record<SigSlot, number>>;
}): Promise<PoolCall> {
  const { common, pool, method } = o;
  if (!isHex(common.changePkh, 20)) throw new PoolBuildError("invalid", "changePkh must be 20 bytes of hex");
  const methodIndex = METHOD_INDEX[method];
  const totalIn = BigInt(common.pool.satoshis) + common.inputs.reduce((s, i) => s + BigInt(i.satoshis), 0n);
  const totalOut = o.outputs.reduce((s, x) => s + x.satoshis, 0n);

  const assemble = (change: bigint): Transaction => {
    const tx = new Transaction();
    tx.version = 1;
    tx.lockTime = 0;
    tx.addInput({
      sourceTXID: common.pool.txid,
      sourceOutputIndex: common.pool.vout,
      sourceTransaction: common.pool.sourceTransaction,
      unlockingScript: new UnlockingScript(),
      sequence: 0xffffffff,
    });
    for (const i of common.inputs) {
      tx.addInput({
        sourceTXID: i.txid,
        sourceOutputIndex: i.vout,
        sourceTransaction: i.sourceTransaction,
        unlockingScript: new UnlockingScript(),
        sequence: 0xffffffff,
      });
    }
    for (const x of o.outputs) tx.addOutput({ satoshis: Number(x.satoshis), lockingScript: LockingScript.fromHex(x.script) });
    if (change > 0n) tx.addOutput({ satoshis: Number(change), lockingScript: LockingScript.fromHex(p2pkhHex(common.changePkh)) });
    return tx;
  };

  const unlockFor = (tx: Transaction, change: bigint): { hex: string; preimage: string } => {
    const preimage = contractPreimage(tx, pool, common.pool.satoshis, methodIndex);
    return { hex: callUnlockHex(pool, o.args, common.changePkh, change, preimage, methodIndex), preimage };
  };

  // The fee: fixed, or iterated to a fixed point over the finished size (the
  // change push and output depend on the fee).
  let fee: bigint;
  if ("sats" in common.fee) {
    fee = BigInt(common.fee.sats);
  } else {
    const rate = common.fee.satsPerKb;
    const otherUnlocks = await Promise.all(
      common.inputs.map(async (i) => (i.unlock ? await i.unlock.estimateLength() : (i.estimatedUnlockLength ?? P2PKH_UNLOCK_LEN))),
    );
    const emptySigs = Object.keys(o.sigSlots).length;
    fee = 0n;
    for (let round = 0; round < 4; round++) {
      const change = totalIn - totalOut - fee;
      const tx = assemble(change > 0n ? change : 0n);
      const { hex } = unlockFor(tx, change > 0n ? change : 0n);
      tx.inputs[0]!.unlockingScript = UnlockingScript.fromHex(hex);
      const size = tx.toBinary().length + emptySigs * (SIG_PUSH_LEN - 1) + otherUnlocks.reduce((s, n) => s + n + (n < 0xfd ? 0 : 2), 0);
      const next = BigInt(Math.ceil((size * rate) / 1000));
      if (next === fee) break;
      fee = next;
    }
  }
  const change = totalIn - totalOut - fee;
  if (change < 0n) {
    throw new PoolBuildError("insufficient_funds", `inputs ${totalIn} sats, outputs ${totalOut} + fee ${fee}`);
  }

  const tx = assemble(change);
  const { hex, preimage } = unlockFor(tx, change);
  tx.inputs[0]!.unlockingScript = UnlockingScript.fromHex(hex);
  for (const [n, i] of common.inputs.entries()) {
    if (i.unlock) tx.inputs[n + 1]!.unlockingScript = await i.unlock.sign(tx, n + 1);
  }
  return {
    tx,
    method,
    pool,
    next: null,
    preimage,
    sighash: toHex(Hash.hash256(fromHex(preimage)) as number[]),
    unsigned: Object.keys(o.sigSlots) as SigSlot[],
    change: Number(change),
    fee: Number(fee),
  };
}

/** A P2PKH unlocker for a builder input (also a Mandala token held on P2PKH). */
export function p2pkhUnlock(key: PrivateKey, satoshis: number, lockingScript: string | LockingScript): BuilderInput["unlock"] {
  return new P2PKH().unlock(key, "all", false, satoshis, typeof lockingScript === "string" ? LockingScript.fromHex(lockingScript) : lockingScript);
}

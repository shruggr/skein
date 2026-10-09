/**
 * AddLiquidity through the user's wallet (docs/notes.md "Swap funding and
 * signing", with the LP as the caller). Pool.runar.go `AddLiquidity` checks
 * the LP's signature AND the validator's (the script cannot see token
 * inputs; the validator vouches for them), rotates both keys, and has one
 * output: the continuation at pool sats + addBsv, TokenReserve + addTokens.
 * It does not fix the ratio: the LP owns the pool, so any addBsv, addTokens
 * >= 0 (not both 0) is accepted; the form offers the current ratio as a
 * helper (`tokensAtRatio` / `satsAtRatio`) and shows the price after.
 *
 *   1. `getPublicKey` of the matched LP key (refused unless it is the pool's
 *      LpPubKey), `getPublicKey` of the next LP key: BRC-29, `lpKeyId(<spent
 *      pool outpoint>)` (as RemoveLiquidity rotates it, so "my pools" finds
 *      it from the pool's history). `listOutputs` (bsv21, the token's tag,
 *      entire transactions) for the token inputs' sources when tokens go in.
 *   2. `PoolTemplate.planAddLiquidity`: the continuation and the method args.
 *      The next validator key: the anyone-child of ValidatorIdentity for the
 *      spent pool outpoint (src/lib/keys.ts), as a swap's.
 *   3. **Funding transaction**: `createFunding` (src/market/swapAction.ts)
 *      with `noSend: true` (gated: the validator broadcasts it): one exact
 *      output, P2PKH to `amm-funding-<hex>`, `1sat-deposit`, tags
 *      `amm-funding` + `hold:<expires>`, customInstructions `{…, amm: {add:
 *      <pool outpoint>, expires}}`. Amount (`swapFunding` over the plan):
 *      addBsv − the token inputs' sats (the call has no Mandala output besides
 *      the pool, so they go to the miner) + the add's miner fee at the rate.
 *   4. **Add transaction**, built here: inputs pool (`callUnlock`,
 *      `_changeAmount = 0`; the LP's slot `createSignature` under the current
 *      LP key; the validator's slot `OP_0`), the funding output, the token
 *      inputs (exactly addTokens: a contract call has no token change, so no
 *      exact subset means "not built: token split"); outputs exactly the
 *      contract's. Funding and token inputs signed with `createSignature`
 *      (SIGHASH_ALL|FORKID) and checked with `Spend`.
 *   5. The relay (src/lp/liquidityRelay.ts) carries both to the validator,
 *      who signs last and broadcasts both.
 *   6. Accepted: `completeAddLiquidity` internalizes the continuation (basket
 *      insertion into `bsv21` as an `amm-pool` row under the next LP key) and
 *      relinquishes the funding output, the spent pool row and the token
 *      inputs. Refused / timed out: `abandonAddLiquidity` aborts the funding.
 */
import { BSV21_BASKET, P1SAT_PROTOCOL, bsv21FilterTags } from "@1sat/actions";
import { DEPOSIT_BASKET } from "@1sat/types";
import { Beef, LockingScript, PublicKey, Transaction, UnlockingScript, type WalletInterface, type WalletProtocol } from "@bsv/sdk";
import type { PoolState } from "@amm-poc/matching-engine";
import { PoolTemplate, type CallPlan } from "../pool";
import {
  SWAP_TTL_MS,
  createFunding,
  finalCallOf,
  poolUtxoFrom,
  selectExactTokenInputs,
  signP2pkhWithWallet,
  spendValid,
  swapFunding,
  type Funding,
  type SwapFunding,
  type TokenInput,
} from "../market/swapAction";
import type { LookupOutput } from "../lib/overlay";
import { LP_KEY_PROTOCOL, lpKeyId, poolCustomInstructions, POOL_TAG, type BasketFiling } from "./poolDeploy";
import type { LpKeyRef } from "./myPools";
import { tokenSourceBeef } from "./wallet";
import { sdkTokenId } from "../lib/tokenId";

export class AddShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AddShapeError";
  }
}

export const TOKEN_SPLIT = "not built: token split (no set of your token outputs adds up exactly to the tokens to add, and a contract call has no token change output)";

/** Tokens that keep the pool's price for `addBsv` sats (rounded down). */
export function tokensAtRatio(s: Pick<PoolState, "bsvReserve" | "tokenReserve">, addBsv: bigint): bigint {
  return s.bsvReserve > 0n ? (addBsv * s.tokenReserve) / s.bsvReserve : 0n;
}

/** Sats that keep the pool's price for `addTokens` tokens (rounded down). */
export function satsAtRatio(s: Pick<PoolState, "bsvReserve" | "tokenReserve">, addTokens: bigint): bigint {
  return s.tokenReserve > 0n ? (addTokens * s.bsvReserve) / s.tokenReserve : 0n;
}

/** Token inputs carrying exactly `amount`, or null ("not built: token split"). */
export function selectAddTokenInputs(candidates: TokenInput[], amount: bigint): TokenInput[] | null {
  return amount === 0n ? [] : selectExactTokenInputs(candidates, amount);
}

export interface AddLiquidityInput {
  wallet: WalletInterface;
  /** `<txid>_0` (src/lib/tokenId.ts). */
  tokenId: string;
  meta?: { sym?: string; dec?: number };
  /** The lookup's `{outpoint, beef: true}` answer for the pool. */
  poolOutput: LookupOutput;
  lpKey: LpKeyRef;
  addBsv: bigint;
  addTokens: bigint;
  /** Exactly `addTokens` (`selectAddTokenInputs`). */
  tokenInputs: TokenInput[];
  /** sats per 1000 bytes (`VITE_FEE_RATE`). */
  satsPerKb: number;
  now?: number;
  ttlMs?: number;
}

export interface PreparedAddLiquidity {
  /** The spent pool, `<txid>_<vout>` (the relay's `pool`). */
  pool: string;
  /** The same, `txid.vout` (its basket row). */
  poolOutpoint: string;
  /** The pool's ValidatorIdentity (hex). */
  validator: string;
  expires: number;
  plan: CallPlan;
  addBsv: bigint;
  addTokens: bigint;
  nextLpKey: { protocolID: WalletProtocol; keyID: string; publicKey: string };
  funding: SwapFunding & Funding & { reference: string };
  /** Every input signed except the pool's validator slot. */
  tx: Transaction;
  /** Provisional: the validator's signature changes it. */
  txid: string;
  /** The add as AtomicBEEF: the funding, the token inputs' and the pool's sources with it. */
  atomicBeef: number[];
  tokenInputs: TokenInput[];
  /** Output 0 into `bsv21` as a pool row under the next LP key. */
  continuation: BasketFiling;
}

const P1SAT = P1SAT_PROTOCOL as WalletProtocol;

/** Steps 1-4 (see the module comment). Aborts the funding action on any failure after it exists. */
export async function prepareAddLiquidity(i: AddLiquidityInput): Promise<PreparedAddLiquidity> {
  const { wallet } = i;
  const tokensIn = i.tokenInputs.reduce((a, t) => a + t.amount, 0n);
  if (tokensIn !== i.addTokens) throw new AddShapeError(`token inputs carry ${tokensIn}, the deposit needs exactly ${i.addTokens}`);
  const poolUtxo = poolUtxoFrom(i.poolOutput);
  const pool = PoolTemplate.decode(poolUtxo.script);
  if (!pool) throw new AddShapeError("the lookup's output is not a pool");
  const lpArgs = { protocolID: i.lpKey.protocolID, keyID: i.lpKey.keyID, counterparty: i.lpKey.counterparty };
  const { publicKey: currentLp } = await wallet.getPublicKey({ ...lpArgs, forSelf: true });
  if (PublicKey.fromString(currentLp).toString() !== pool.state.lpPubKey) {
    throw new AddShapeError(`the wallet key ${i.lpKey.keyID} is not this pool's LP key`);
  }
  const poolId = `${poolUtxo.txid}_${poolUtxo.vout}`;
  const nextKeyID = lpKeyId(poolId);
  const { publicKey: nextPub } = await wallet.getPublicKey({ protocolID: LP_KEY_PROTOCOL, keyID: nextKeyID, counterparty: "self", forSelf: true });
  const plan = PoolTemplate.planAddLiquidity({ pool: poolUtxo, addBsv: i.addBsv, addTokens: i.addTokens, nextLpPubKey: nextPub });

  // The wallet's filings carry 1sat-sdk's id form, `<txid>_0` (src/lib/tokenId.ts).
  const sdkId = sdkTokenId(i.tokenId);
  let tokenBeef: Beef | null = null;
  if (i.tokenInputs.length > 0) {
    tokenBeef = await tokenSourceBeef(wallet, i.tokenId, { tags: bsv21FilterTags({ tokenId: sdkId }) });
    if (!tokenBeef) throw new AddShapeError("the wallet returned no BEEF for the token inputs");
    for (const t of i.tokenInputs) if (!tokenBeef.findTxid(t.txid)) throw new AddShapeError(`the wallet's BEEF lacks the token input ${t.outpoint}`);
  }

  const continuation: BasketFiling = {
    outputIndex: 0,
    basket: BSV21_BASKET,
    tags: [...bsv21FilterTags({ tokenId: sdkId }), POOL_TAG],
    customInstructions: poolCustomInstructions({ tokenId: sdkId, ...i.meta, protocolID: LP_KEY_PROTOCOL, keyID: nextKeyID, args: pool.args, validatorIdentity: pool.state.validatorIdentity }),
  };

  // Step 3: the funding, nosend.
  const amounts = swapFunding(plan, i.tokenInputs, i.satsPerKb);
  const expires = (i.now ?? Date.now()) + (i.ttlMs ?? SWAP_TTL_MS);
  const sym = i.meta?.sym ?? "token";
  const f = await createFunding(wallet, {
    satoshis: amounts.satoshis,
    expires,
    amm: { add: poolId },
    description: `AMM add-liquidity funding: ${sym}`,
    labels: ["amm-add-liquidity"],
    outputDescription: `AMM add-liquidity funding: ${sym}`,
    noSend: true,
  });
  const reference = f.reference!;
  try {
    // Step 4: the add transaction.
    const tx = new Transaction();
    tx.version = 1;
    tx.lockTime = 0;
    tx.addInput({ sourceTXID: poolUtxo.txid, sourceOutputIndex: poolUtxo.vout, sourceTransaction: poolUtxo.sourceTransaction, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
    tx.addInput({ sourceTXID: f.txid, sourceOutputIndex: 0, sourceTransaction: f.tx, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
    for (const t of i.tokenInputs) {
      const src = tokenBeef!.findAtomicTransaction(t.txid) ?? tokenBeef!.findTxid(t.txid)!.tx!;
      tx.addInput({ sourceTXID: t.txid, sourceOutputIndex: t.vout, sourceTransaction: src, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
    }
    for (const o of plan.outputs) tx.addOutput({ satoshis: Number(o.satoshis), lockingScript: LockingScript.fromHex(o.script) });

    tx.inputs[0]!.unlockingScript = PoolTemplate.callUnlock(plan, tx, null).unlockingScript;
    await PoolTemplate.signPoolInput(
      { tx, pool: plan.pool, method: "addLiquidity", unsigned: ["lp", "validator"], sourceSatoshis: poolUtxo.satoshis },
      "lp",
      async (sighash) => (await wallet.createSignature({ ...lpArgs, hashToDirectlySign: sighash })).signature,
    );
    tx.inputs[1]!.unlockingScript = await signP2pkhWithWallet(wallet, tx, 1, { satoshis: amounts.satoshis, lockingScript: f.lockingScript, protocolID: P1SAT, keyID: f.keyID, counterparty: "self" });
    for (const [n, t] of i.tokenInputs.entries()) tx.inputs[n + 2]!.unlockingScript = await signP2pkhWithWallet(wallet, tx, n + 2, t);
    for (let n = 1; n < tx.inputs.length; n++) {
      if (!spendValid(tx, n)) throw new AddShapeError(`input ${n} of the add does not validate`);
    }
    return {
      pool: poolId,
      poolOutpoint: `${poolUtxo.txid}.${poolUtxo.vout}`,
      validator: pool.state.validatorIdentity,
      expires,
      plan,
      addBsv: i.addBsv,
      addTokens: i.addTokens,
      nextLpKey: { protocolID: LP_KEY_PROTOCOL, keyID: nextKeyID, publicKey: nextPub },
      funding: { ...amounts, ...f, reference },
      tx,
      txid: tx.id("hex"),
      atomicBeef: tx.toAtomicBEEF(true),
      tokenInputs: i.tokenInputs,
      continuation,
    };
  } catch (err) {
    await wallet.abortAction({ reference }).catch(() => undefined);
    throw err;
  }
}

export interface CompletedAddLiquidity {
  txid: string;
  /** The new pool, `<txid>_0`. */
  pool: string;
  internalized: boolean;
  relinquished: string[];
  /** Internalize or relinquish errors (the add itself is final). */
  errors: string[];
}

/**
 * Accepted: the validator's final transaction (checked against ours: only
 * the pool input's unlocking script differs) is internalized with the
 * continuation as a pool row under the next LP key; the funding output, the
 * spent pool row and the token inputs are relinquished. The funding stays a
 * `nosend` action; the wallet's TaskCheckNoSends finds its proof once mined.
 */
export async function completeAddLiquidity(wallet: WalletInterface, p: PreparedAddLiquidity, raw: number[], txid?: string): Promise<CompletedAddLiquidity> {
  const final = finalCallOf(p.tx, raw, txid, "the add we built");
  const id = final.id("hex");
  const out: CompletedAddLiquidity = { txid: id, pool: `${id}_0`, internalized: false, relinquished: [], errors: [] };
  const c = p.continuation;
  try {
    const r = await wallet.internalizeAction({
      tx: final.toAtomicBEEF(true),
      outputs: [{ outputIndex: c.outputIndex, protocol: "basket insertion", insertionRemittance: { basket: c.basket, tags: c.tags, customInstructions: c.customInstructions } }],
      description: "AMM liquidity deposit",
      labels: ["amm-add-liquidity"],
    });
    out.internalized = r.accepted;
  } catch (err) {
    out.errors.push(`internalizeAction: ${err instanceof Error ? err.message : String(err)}`);
  }
  const spent = [
    { basket: DEPOSIT_BASKET, output: p.funding.outpoint },
    { basket: BSV21_BASKET, output: p.poolOutpoint },
    ...p.tokenInputs.map((t) => ({ basket: BSV21_BASKET, output: t.outpoint })),
  ];
  for (const s of spent) {
    try {
      await wallet.relinquishOutput(s);
      out.relinquished.push(s.output);
    } catch (err) {
      out.errors.push(`relinquishOutput ${s.output}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

/** Refused or timed out: the funding action is aborted, freeing the wallet's inputs (its output never existed on chain). */
export async function abandonAddLiquidity(wallet: WalletInterface, p: PreparedAddLiquidity): Promise<void> {
  await wallet.abortAction({ reference: p.funding.reference });
}

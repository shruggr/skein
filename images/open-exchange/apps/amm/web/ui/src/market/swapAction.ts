/**
 * One swap leg through the user's BRC-100 wallet (docs/notes.md, "Swap
 * funding and signing"). The page holds no keys: every key and signature
 * comes from the wallet (`getPublicKey`, `createAction`, `signAction`,
 * `createSignature`).
 *
 *   1. `PoolTemplate.planSwap`: the outputs the contract requires (pool,
 *      payout, LP fee, validator fee, commission) and the method arguments.
 *      The commission goes to the relay's `amm.swap.terms` address; when the
 *      relay names none and the pool's CommissionBps is nonzero, to a key of
 *      the taker's own (see "the commission" below). The funding amount is
 *      exact: what the contract's outputs take beyond the pool's and the
 *      token inputs' sats (amount in + 1 sat per Mandala output the taker
 *      pays for), plus the miner fee of the final swap (`swapFunding`).
 *   2. **Funding transaction**: `createAction` (`signAndProcess: false`,
 *      `noSend`) with one output of that amount, P2PKH to a P1SAT key
 *      (`amm-funding-<hex>`), filed in 1sat-sdk's `1sat-deposit` staging
 *      basket with tags `amm-funding` and `hold:<expires>` (as OrdLock v2
 *      front funding is), then `signAction` (`noSend`): the wallet keeps a
 *      signed `nosend` transaction and broadcasts nothing.
 *   3. **Swap transaction**, built here: inputs pool (`callUnlock`, the
 *      validator's slot `OP_0`, `_changeAmount = 0`), the funding output,
 *      the token inputs (token → sats); outputs exactly the contract's, no
 *      change. The funding and token inputs are signed with `createSignature`
 *      (SIGHASH_ALL|FORKID over the BIP-143 sighash computed here) and every
 *      input but the pool's is checked with `Spend`.
 *   4. The relay (src/market/relay.ts) carries both to the validator.
 *   5. Accepted: `completeSwap` internalizes the payout (sats: BRC-29 wallet
 *      payment; tokens: basket insertion into `bsv21`), and the commission
 *      when it is the taker's own (same two forms), and relinquishes the
 *      funding output and the token inputs. Refused / timed out:
 *      `abandonSwap` aborts the funding action (its output never existed).
 */
import { BSV21_BASKET, P1SAT_PROTOCOL, bsv21FilterTags, buildBsv21CustomInstructions } from "@1sat/actions";
import { DEPOSIT_BASKET, depositHoldTag } from "@1sat/types";
import {
  Beef,
  Hash,
  LockingScript,
  P2PKH,
  PublicKey,
  Spend,
  Transaction,
  TransactionSignature,
  UnlockingScript,
  Utils,
  type CreateActionArgs,
  type InternalizeOutput,
  type WalletInterface,
  type WalletProtocol,
} from "@bsv/sdk";
import type { Direction, Leg, PoolState } from "@amm-poc/matching-engine";
import { PoolTemplate, decodeMandala, type CallPlan, type PoolUtxo } from "../pool";
import type { LookupOutput } from "../lib/overlay";
import { isPoolRow } from "../lp/poolRows";
import { tokenSourceBeef } from "../lp/wallet";
import { outpointText, parseOutpoint, parseTokenId, sdkTokenId } from "../lib/tokenId";
import { payoutId, type PendingPayout } from "../wallet/pendingPayouts";
import { WALLET_PAYMENT, identityKeyOf, newBrc29Payout, type Brc29Payout } from "../wallet/brc29";

/** A P2PKH unlocking script's upper bound: push(DER ≤ 72 + sighash byte) + push(33-byte key). */
export const P2PKH_UNLOCK_LENGTH = 108;
/** Tag of a funding output in `1sat-deposit` (as 1sat-sdk's `ordlock-funding`). */
export const FUNDING_TAG = "amm-funding";
export const FUNDING_KEY_PREFIX = "amm-funding-";
/** How long the relay may take, and how long the funding output is held from `sweepDeposit`. */
export const SWAP_TTL_MS = 2 * 60_000;

/** BRC-100 descriptions are 5-50 characters. */
function describe(text: string): string {
  return text.length <= 50 ? text : `${text.slice(0, 49)}…`;
}

const toHex = (b: number[]) => Utils.toHex(b);

function randomHex(bytes = 8): string {
  return toHex(Array.from(crypto.getRandomValues(new Uint8Array(bytes))));
}

export class LegShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegShapeError";
  }
}

// ---------------------------------------------------------------------------
// Token inputs (token → sats)
// ---------------------------------------------------------------------------

/** A `bsv21` basket output the wallet can sign: a Mandala value output of the token, with its key. */
export interface TokenInput {
  /** `txid.vout` (BRC-100 outpoint form). */
  outpoint: string;
  txid: string;
  vout: number;
  satoshis: number;
  lockingScript: string;
  amount: bigint;
  protocolID: WalletProtocol;
  keyID: string;
  counterparty: string;
}

/** The token's 32-byte wire id (internal byte order) for a token with a 32-byte id (`<txid>_0`; `<txid>` and `<txid>.0` read the same). */
export function assetIdOf(tokenId: string): string {
  const r = parseTokenId(tokenId);
  if (!r || r.vout !== 0) throw new Error(`pools exist only for 32-byte ids (<txid>_0), not ${tokenId}`);
  return toHex(Utils.toArray(r.txid, "hex").reverse());
}

/**
 * The basket rows usable as token inputs for `tokenId`: Mandala value outputs
 * with this 32-byte id (the pool template counts only those) whose
 * customInstructions name the key (protocolID, keyID).
 */
export function tokenInputsOf(
  rows: { outpoint: string; satoshis: number; lockingScript?: string; tags?: string[]; customInstructions?: string }[],
  tokenId: string,
): TokenInput[] {
  const assetId = assetIdOf(tokenId);
  const out: TokenInput[] = [];
  for (const r of rows) {
    // A pool the wallet holds as LP carries the same Mandala prefix; it is not a token input.
    if (!r.lockingScript || isPoolRow(r)) continue;
    const t = decodeMandala(Utils.toArray(r.lockingScript, "hex"));
    if (!t || t.role !== "value" || !t.idBytes || toHex(Array.from(t.idBytes)) !== assetId) continue;
    let ci: { protocolID?: unknown; keyID?: unknown; counterparty?: unknown } = {};
    try {
      ci = JSON.parse(r.customInstructions ?? "{}");
    } catch {
      continue;
    }
    if (!Array.isArray(ci.protocolID) || typeof ci.keyID !== "string") continue;
    const op = parseOutpoint(r.outpoint);
    if (!op) continue;
    out.push({
      outpoint: `${op.txid}.${op.vout}`,
      txid: op.txid,
      vout: op.vout,
      satoshis: r.satoshis,
      lockingScript: r.lockingScript,
      amount: t.amount,
      protocolID: ci.protocolID as WalletProtocol,
      keyID: ci.keyID,
      counterparty: typeof ci.counterparty === "string" ? ci.counterparty : "self",
    });
  }
  return out;
}

/**
 * Token outputs summing to exactly `amount`, or null. The pool contract has
 * no token change output (Pool.runar.go Swap: the token inputs are the
 * amountIn), so an inexact selection cannot be spent into a swap. Fewest
 * outputs first; a bounded search.
 */
export function selectExactTokenInputs(candidates: TokenInput[], amount: bigint): TokenInput[] | null {
  const sorted = [...candidates].sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0)).slice(0, 24);
  for (let size = 1; size <= Math.min(sorted.length, 6); size++) {
    const pick: TokenInput[] = [];
    const walk = (from: number, left: bigint): boolean => {
      if (pick.length === size) return left === 0n;
      for (let i = from; i < sorted.length; i++) {
        if (sorted[i]!.amount > left) continue;
        pick.push(sorted[i]!);
        if (walk(i + 1, left - sorted[i]!.amount)) return true;
        pick.pop();
      }
      return false;
    };
    if (walk(0, amount)) return pick;
  }
  return null;
}

/** The pool output from the lookup's BEEF, as the template's PoolUtxo. */
export function poolUtxoFrom(poolOutput: LookupOutput): PoolUtxo {
  const tx = Transaction.fromAtomicBEEF(poolOutput.beef);
  const out = tx.outputs[poolOutput.outputIndex];
  if (!out) throw new LegShapeError(`the lookup's BEEF has no output ${poolOutput.outputIndex}`);
  return { txid: tx.id("hex"), vout: poolOutput.outputIndex, satoshis: out.satoshis!, script: out.lockingScript, sourceTransaction: tx };
}

/**
 * A P2PKH (or Mandala-on-P2PKH) input signed by the wallet: BIP-143 over
 * the finished transaction under `scope` (ALL|FORKID; a delivered deploy's
 * SINGLE|FORKID, 0.9.0), `createSignature` with `hashToDirectlySign`
 * (1sat-sdk's `signP2PKHInputWallet`).
 */
export async function signP2pkhWithWallet(
  wallet: WalletInterface,
  tx: Transaction,
  inputIndex: number,
  src: { satoshis: number; lockingScript: string; protocolID: WalletProtocol; keyID: string; counterparty: string },
  scope: number = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID,
): Promise<UnlockingScript> {
  const input = tx.inputs[inputIndex]!;
  const preimage = TransactionSignature.format({
    sourceTXID: input.sourceTXID!,
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis: src.satoshis,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.filter((_, n) => n !== inputIndex),
    inputIndex,
    outputs: tx.outputs,
    inputSequence: input.sequence ?? 0xffffffff,
    subscript: LockingScript.fromHex(src.lockingScript),
    lockTime: tx.lockTime,
    scope,
  });
  const sighash = Hash.sha256(Hash.sha256(Array.from(preimage)));
  const args = { protocolID: src.protocolID, keyID: src.keyID, counterparty: src.counterparty };
  const { signature } = await wallet.createSignature({ ...args, hashToDirectlySign: Array.from(sighash) });
  const { publicKey } = await wallet.getPublicKey({ ...args, forSelf: true });
  return new UnlockingScript().writeBin([...signature, scope]).writeBin(Utils.toArray(publicKey, "hex"));
}

// ---------------------------------------------------------------------------
// The funding amount
// ---------------------------------------------------------------------------

function varIntSize(n: number): number {
  return n < 0xfd ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9;
}

/**
 * The final swap's size in bytes: the pool input at `maxCallUnlockLength`
 * (validator's signature in), `takerInputs` P2PKH inputs (funding, tokens)
 * at 108 bytes of unlocking script, the contract's outputs, no change.
 */
export function swapTxSize(plan: CallPlan, takerInputs: number): number {
  const poolUnlock = PoolTemplate.maxCallUnlockLength(plan);
  let size = 4 + varIntSize(1 + takerInputs);
  size += 36 + varIntSize(poolUnlock) + poolUnlock + 4;
  size += takerInputs * (36 + varIntSize(P2PKH_UNLOCK_LENGTH) + P2PKH_UNLOCK_LENGTH + 4);
  size += varIntSize(plan.outputs.length);
  for (const o of plan.outputs) {
    const len = o.script.length / 2;
    size += 8 + varIntSize(len) + len;
  }
  return size + 4;
}

export interface SwapFunding {
  /** The funding output's exact amount. */
  satoshis: number;
  /** What the contract's outputs take beyond the pool's and the token inputs' sats. */
  outputs: number;
  fee: number;
  size: number;
  satsPerKb: number;
}

/**
 * The exact funding: Σ contract outputs − pool sats − token inputs' sats
 * (sats in: amount in + 1 for the token payout, the fees and the commission
 * being part of amount in; tokens in: 1 per Mandala fee or commission output
 * − the token inputs' sats), plus
 * ceil(size × rate / 1000) for the final swap.
 */
export function swapFunding(plan: CallPlan, tokenInputs: { satoshis: number }[], satsPerKb: number): SwapFunding {
  const outSum = plan.outputs.reduce((a, o) => a + o.satoshis, 0n);
  const tokenSats = tokenInputs.reduce((a, t) => a + BigInt(t.satoshis), 0n);
  const outputs = Number(outSum - BigInt(plan.poolUtxo.satoshis) - tokenSats);
  const size = swapTxSize(plan, 1 + tokenInputs.length);
  const fee = Math.ceil((size * satsPerKb) / 1000);
  return { satoshis: Math.max(1, outputs + fee), outputs, fee, size, satsPerKb };
}

// ---------------------------------------------------------------------------
// The leg
// ---------------------------------------------------------------------------

export interface PrepareSwapInput {
  wallet: WalletInterface;
  /** `<txid>_0` (src/lib/tokenId.ts). */
  tokenId: string;
  meta?: { sym?: string; dec?: number };
  direction: Direction;
  leg: Leg;
  pool: PoolState;
  /** The lookup's `{outpoint, beef: true}` answer for `leg.outpoint`. */
  poolOutput: LookupOutput;
  /**
   * The relay's commission address (`amm.swap.terms`, hash160 hex), or null
   * when the relay names none: a pool with a nonzero CommissionBps then pays
   * the commission to a fresh key of the taker's own.
   */
  commissionPkh: string | null;
  /** token → sats: inputs carrying exactly `leg.amountIn`. */
  tokenInputs?: TokenInput[];
  /** sats per 1000 bytes (`VITE_FEE_RATE`). */
  satsPerKb: number;
  now?: number;
  ttlMs?: number;
}

/** The funding output's customInstructions (sweepDeposit reads protocolID / keyID / counterparty). */
export interface FundingInstructions {
  protocolID: WalletProtocol;
  keyID: string;
  counterparty: "self";
  /** What the funding is for (swap: `{pool, expires}`; deploy: `{deploy, expires}`; remove: `{remove, expires}`). */
  amm: { expires: number } & Record<string, unknown>;
}

/** A funding transaction's one output, as the wallet made it. */
export interface Funding {
  createArgs: CreateActionArgs;
  /** The nosend action's reference (abortAction releases it); absent once the wallet has broadcast. */
  reference?: string;
  tx: Transaction;
  /** The funding transaction as the wallet's AtomicBEEF (with its ancestry). */
  atomicBeef: number[];
  txid: string;
  /** `txid.vout` */
  outpoint: string;
  lockingScript: string;
  keyID: string;
  instructions: FundingInstructions;
}

export interface FundingRequest {
  satoshis: number;
  expires: number;
  /** `amm` of the customInstructions, without `expires`. */
  amm: Record<string, unknown>;
  description: string;
  labels: string[];
  outputDescription: string;
  /**
   * true: `createAction` (signAndProcess false, noSend) + `signAction`
   * (noSend), a gated call (swap, deploy) whose funding someone else
   * broadcasts. false: one `createAction` the wallet signs and broadcasts
   * at once (`acceptDelayedBroadcast: false`), an LP-only call.
   */
  noSend: boolean;
}

/**
 * The funding transaction (docs/notes.md, "Swap funding and signing"): one
 * exact output, P2PKH to a fresh P1SAT key (`amm-funding-<hex>`), filed in
 * `1sat-deposit` with tags `amm-funding` and `hold:<expires>`, its key in
 * the customInstructions (sweepDeposit reads protocolID / keyID /
 * counterparty). The output must come back as output 0; a nosend action
 * that does not is aborted.
 */
export async function createFunding(wallet: WalletInterface, r: FundingRequest): Promise<Funding> {
  const keyID = `${FUNDING_KEY_PREFIX}${randomHex()}`;
  const { publicKey: fundingKey } = await wallet.getPublicKey({ protocolID: P1SAT, keyID, counterparty: "self", forSelf: true });
  const lockingScript = new P2PKH().lock(PublicKey.fromString(fundingKey).toAddress()).toHex();
  const instructions: FundingInstructions = { protocolID: P1SAT, keyID, counterparty: "self", amm: { ...r.amm, expires: r.expires } };
  const createArgs: CreateActionArgs = {
    description: describe(r.description),
    labels: r.labels,
    outputs: [
      {
        lockingScript,
        satoshis: r.satoshis,
        outputDescription: describe(r.outputDescription),
        basket: DEPOSIT_BASKET,
        tags: [FUNDING_TAG, depositHoldTag(r.expires)],
        customInstructions: JSON.stringify(instructions),
      },
    ],
    options: r.noSend ? { signAndProcess: false, randomizeOutputs: false, noSend: true } : { randomizeOutputs: false, acceptDelayedBroadcast: false },
  };
  const created = await wallet.createAction(createArgs);
  let atomicBeef: number[];
  let reference: string | undefined;
  if (r.noSend) {
    reference = created.signableTransaction?.reference;
    if (!reference) throw new LegShapeError("the wallet returned no signable funding transaction");
    try {
      const signed = await wallet.signAction({ reference, spends: {}, options: { noSend: true } });
      if (!signed.tx) throw new LegShapeError("the wallet returned no signed funding transaction");
      atomicBeef = Array.from(signed.tx);
    } catch (err) {
      await wallet.abortAction({ reference }).catch(() => undefined);
      throw err;
    }
  } else {
    if (!created.tx) throw new LegShapeError("the wallet returned no funding transaction");
    atomicBeef = Array.from(created.tx);
  }
  const tx = Transaction.fromAtomicBEEF(atomicBeef);
  const out0 = tx.outputs[0];
  if (!out0 || out0.satoshis !== r.satoshis || out0.lockingScript.toHex() !== lockingScript) {
    if (reference) await wallet.abortAction({ reference }).catch(() => undefined);
    throw new LegShapeError("the wallet moved the funding output; it must be output 0");
  }
  const txid = tx.id("hex");
  return { createArgs, ...(reference ? { reference } : {}), tx, atomicBeef, txid, outpoint: `${txid}.0`, lockingScript, keyID, instructions };
}

export type SwapPayout =
  | { kind: "bsv21"; outputIndex: number; basket: string; tags: string[]; customInstructions: string }
  | ({ kind: "brc29" } & Brc29Payout);

export interface PreparedSwap {
  /** The pool outpoint `<txid>_<vout>`. */
  pool: string;
  validator: string;
  expires: number;
  plan: CallPlan;
  funding: SwapFunding & {
    createArgs: CreateActionArgs;
    reference: string;
    tx: Transaction;
    /** signAction's AtomicBEEF of the funding transaction (what the relay is sent). */
    atomicBeef: number[];
    txid: string;
    /** `txid.vout` */
    outpoint: string;
    lockingScript: string;
    instructions: FundingInstructions;
  };
  /** Every input signed except the pool's validator slot. */
  swap: Transaction;
  tokenInputs: TokenInput[];
  payout: SwapPayout;
  commission: SwapCommission;
}

/** The leg's commission (the pool's CommissionBps of amount in, in the input asset). */
export interface SwapCommission {
  /** 0 when the pool's CommissionBps is 0: no output. */
  amount: bigint;
  /** Swap's `commissionPkh` (pushed even when there is no output). */
  pkh: string;
  /** "relay": the relay's address; "own": the taker's key, internalized with the payout; "none": no output. */
  to: "relay" | "own" | "none";
  /** "own" only: the wallet's record of the commission output. */
  payout?: SwapPayout;
}

const ZERO_PKH = "00".repeat(20);

const P1SAT = P1SAT_PROTOCOL as WalletProtocol;

/** Steps 1-3 (see the module comment). Throws `PoolBuildError` / `LegShapeError`; aborts the funding action on any failure after it exists. */
export async function prepareSwap(i: PrepareSwapInput): Promise<PreparedSwap> {
  const { wallet, leg, pool } = i;
  const bsvIn = i.direction === "bsvToToken";
  const poolUtxo = poolUtxoFrom(i.poolOutput);
  if (`${poolUtxo.txid}_${poolUtxo.vout}` !== leg.outpoint) {
    throw new LegShapeError(`the pool moved: the lookup's tip is ${poolUtxo.txid}.${poolUtxo.vout}, the plan priced ${outpointText(leg.outpoint)}`);
  }
  const tokenInputs = i.tokenInputs ?? [];
  const tokensIn = tokenInputs.reduce((a, t) => a + t.amount, 0n);
  if (bsvIn ? tokenInputs.length > 0 : tokensIn !== leg.amountIn) {
    throw new LegShapeError(`token inputs carry ${tokensIn}, the leg needs exactly ${bsvIn ? 0n : leg.amountIn}`);
  }

  // The payout key: tokens under 1sat-sdk's conventions, sats as a BRC-29 payment to self.
  const poolArgs = PoolTemplate.decode(poolUtxo.script)?.args;
  if (!poolArgs) throw new LegShapeError(`${outpointText(leg.outpoint)} is not a pool output`);
  const commissionAmount = (leg.amountIn * poolArgs.commissionBps + 9999n) / 10000n;
  const commissionTo: SwapCommission["to"] = commissionAmount === 0n ? "none" : i.commissionPkh ? "relay" : "own";

  // The payout key: tokens under 1sat-sdk's conventions, sats as a BRC-29 payment to self.
  // The taker's own commission (in the input asset) is keyed the same way, the other way round.
  const identity = !bsvIn || commissionTo === "own" ? await identityKeyOf(wallet) : "";
  // The wallet's filings (keyIDs, tags, customInstructions) carry 1sat-sdk's id form, `<txid>_0`.
  const sdkId = sdkTokenId(i.tokenId);
  const payoutKeyID = `${sdkId}-${randomHex()}`;
  const brc29 = bsvIn ? null : await newBrc29Payout(wallet, identity);
  const payoutKey = brc29 ? brc29.publicKey : (await wallet.getPublicKey({ protocolID: P1SAT, keyID: payoutKeyID, counterparty: "self", forSelf: true })).publicKey;
  const userPkh = toHex(PublicKey.fromString(payoutKey).toHash() as number[]);

  let ownCommission: { brc29: Awaited<ReturnType<typeof newBrc29Payout>> | null; keyID: string; pkh: string } | null = null;
  if (commissionTo === "own") {
    const keyID = `${sdkId}-${randomHex()}`;
    const own = bsvIn ? await newBrc29Payout(wallet, identity) : null;
    const key = own ? own.publicKey : (await wallet.getPublicKey({ protocolID: P1SAT, keyID, counterparty: "self", forSelf: true })).publicKey;
    ownCommission = { brc29: own, keyID, pkh: toHex(PublicKey.fromString(key).toHash() as number[]) };
  }
  const commissionPkh = ownCommission?.pkh ?? i.commissionPkh ?? ZERO_PKH;

  const plan = PoolTemplate.planSwap({
    pool: poolUtxo,
    amountIn: leg.amountIn,
    bsvIn,
    userPkh,
    commissionPkh,
    expect: {
      bsvReserve: pool.bsvReserve,
      tokenReserve: pool.tokenReserve,
      lpFeeBps: pool.liquidityFeeBps,
      validatorFeeBps: pool.validationFeeBps,
      commissionBps: pool.commissionBps,
      lpFee: leg.liquidityFee,
      validatorFee: leg.validationFee,
      commission: leg.commission,
      amountOut: leg.amountOut,
    },
  });
  const amounts = swapFunding(plan, tokenInputs, i.satsPerKb);
  const expires = (i.now ?? Date.now()) + (i.ttlMs ?? SWAP_TTL_MS);
  const sym = i.meta?.sym ?? "token";

  const payout: SwapPayout = brc29
    ? { kind: "brc29", outputIndex: 1, satoshis: Number(plan.outputs[1]!.satoshis), lockingScript: plan.outputs[1]!.script, remittance: brc29.remittance }
    : {
        kind: "bsv21",
        outputIndex: 1,
        basket: BSV21_BASKET,
        tags: bsv21FilterTags({ tokenId: sdkId }),
        customInstructions: buildBsv21CustomInstructions({
          token: { id: sdkId, amt: String(leg.amountOut), op: "transfer", sym: i.meta?.sym, dec: i.meta?.dec },
          protocolID: P1SAT,
          keyID: payoutKeyID,
          counterparty: "self",
        }),
      };

  // The commission is the last output when there is one (Pool.runar.go Swap).
  const commission: SwapCommission = { amount: commissionAmount, pkh: commissionPkh, to: commissionTo };
  if (ownCommission) {
    const at = plan.outputs.length - 1;
    const out = plan.outputs[at]!;
    commission.payout = ownCommission.brc29
      ? { kind: "brc29", outputIndex: at, satoshis: Number(out.satoshis), lockingScript: out.script, remittance: ownCommission.brc29.remittance }
      : {
          kind: "bsv21",
          outputIndex: at,
          basket: BSV21_BASKET,
          tags: bsv21FilterTags({ tokenId: sdkId }),
          customInstructions: buildBsv21CustomInstructions({
            token: { id: sdkId, amt: String(commissionAmount), op: "transfer", sym: i.meta?.sym, dec: i.meta?.dec },
            protocolID: P1SAT,
            keyID: ownCommission.keyID,
            counterparty: "self",
          }),
        };
  }

  // Token inputs: their source transactions, for the final swap's BEEF.
  let tokenBeef: Beef | null = null;
  if (tokenInputs.length > 0) {
    tokenBeef = await tokenSourceBeef(wallet, i.tokenId, { tags: bsv21FilterTags({ tokenId: sdkId }) });
    if (!tokenBeef) throw new LegShapeError("the wallet returned no BEEF for the token inputs");
    for (const t of tokenInputs) if (!tokenBeef.findTxid(t.txid)) throw new LegShapeError(`the wallet's BEEF lacks the token input ${t.outpoint}`);
  }

  // Step 2: the funding transaction.
  const f = await createFunding(wallet, {
    satoshis: amounts.satoshis,
    expires,
    amm: { pool: leg.outpoint },
    description: "AMM swap funding",
    labels: ["amm-swap"],
    outputDescription: `AMM swap funding ${bsvIn ? "sats → " + sym : sym + " → sats"}`,
    noSend: true,
  });
  const reference = f.reference!;
  const { keyID, lockingScript: fundingScript, tx: fundingTx, txid: fundingTxid } = f;
  try {
    // Step 3: the swap transaction.
    const swap = new Transaction();
    swap.version = 1;
    swap.lockTime = 0;
    swap.addInput({ sourceTXID: poolUtxo.txid, sourceOutputIndex: poolUtxo.vout, sourceTransaction: poolUtxo.sourceTransaction, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
    swap.addInput({ sourceTXID: fundingTxid, sourceOutputIndex: 0, sourceTransaction: fundingTx, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
    for (const t of tokenInputs) {
      const src = tokenBeef!.findAtomicTransaction(t.txid) ?? tokenBeef!.findTxid(t.txid)!.tx!;
      swap.addInput({ sourceTXID: t.txid, sourceOutputIndex: t.vout, sourceTransaction: src, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
    }
    for (const o of plan.outputs) swap.addOutput({ satoshis: Number(o.satoshis), lockingScript: LockingScript.fromHex(o.script) });

    swap.inputs[0]!.unlockingScript = PoolTemplate.callUnlock(plan, swap, null).unlockingScript;
    swap.inputs[1]!.unlockingScript = await signP2pkhWithWallet(wallet, swap, 1, { satoshis: amounts.satoshis, lockingScript: fundingScript, protocolID: P1SAT, keyID, counterparty: "self" });
    for (const [n, t] of tokenInputs.entries()) swap.inputs[n + 2]!.unlockingScript = await signP2pkhWithWallet(wallet, swap, n + 2, t);
    for (let n = 1; n < swap.inputs.length; n++) {
      if (!spendValid(swap, n)) throw new LegShapeError(`input ${n} of the swap does not validate`);
    }

    return {
      pool: leg.outpoint,
      validator: pool.validatorIdentityKey,
      expires,
      plan,
      funding: { ...amounts, createArgs: f.createArgs, reference, tx: fundingTx, atomicBeef: f.atomicBeef, txid: fundingTxid, outpoint: f.outpoint, lockingScript: fundingScript, instructions: f.instructions },
      swap,
      tokenInputs,
      payout,
      commission,
    };
  } catch (err) {
    await wallet.abortAction({ reference }).catch(() => undefined);
    throw err;
  }
}

/** @bsv/sdk's `Spend` over input `n` of `tx` (its source output from `sourceTransaction`). */
export function spendValid(tx: Transaction, n: number): boolean {
  const inp = tx.inputs[n]!;
  const src = inp.sourceTransaction?.outputs[inp.sourceOutputIndex];
  if (!src) return false;
  try {
    return new Spend({
      sourceTXID: inp.sourceTXID ?? inp.sourceTransaction!.id("hex"),
      sourceOutputIndex: inp.sourceOutputIndex,
      sourceSatoshis: src.satoshis!,
      lockingScript: src.lockingScript,
      transactionVersion: tx.version,
      otherInputs: tx.inputs.filter((_, j) => j !== n),
      outputs: tx.outputs,
      inputIndex: n,
      unlockingScript: inp.unlockingScript!,
      inputSequence: inp.sequence ?? 0xffffffff,
      lockTime: tx.lockTime,
    }).validate();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// After the relay's answer
// ---------------------------------------------------------------------------

/**
 * The validator's final transaction, checked against ours: same inputs (in
 * order, the taker's unlocking scripts unchanged), same outputs; only input
 * 0's unlocking script (the validator's slot) differs. Its inputs get our
 * source transactions, so it serializes as AtomicBEEF.
 */
export function finalSwapOf(p: PreparedSwap, raw: number[], txid?: string): Transaction {
  return finalCallOf(p.swap, raw, txid, "the swap we built");
}

/**
 * A validator-signed pool call checked against the one we built (`ours`):
 * same inputs in order with our unlocking scripts on every input but the
 * pool's (input 0), same outputs. Shared by the swap and AddLiquidity.
 */
export function finalCallOf(ours: Transaction, raw: number[], txid: string | undefined, what: string): Transaction {
  let tx: Transaction;
  try {
    tx = Transaction.fromBinary(raw);
  } catch {
    tx = Transaction.fromBEEF(raw);
  }
  if (txid && tx.id("hex") !== txid) throw new LegShapeError(`the relay's transaction is ${tx.id("hex")}, not ${txid}`);
  const same =
    tx.inputs.length === ours.inputs.length &&
    tx.outputs.length === ours.outputs.length &&
    tx.inputs.every((inp, n) => {
      const o = ours.inputs[n]!;
      const src = inp.sourceTXID ?? inp.sourceTransaction?.id("hex");
      return src === o.sourceTXID && inp.sourceOutputIndex === o.sourceOutputIndex && (n === 0 || inp.unlockingScript?.toHex() === o.unlockingScript!.toHex());
    }) &&
    tx.outputs.every((out, n) => out.satoshis === ours.outputs[n]!.satoshis && out.lockingScript.toHex() === ours.outputs[n]!.lockingScript.toHex());
  if (!same) throw new LegShapeError(`the relay's transaction is not ${what}`);
  tx.inputs.forEach((inp, n) => {
    inp.sourceTransaction = ours.inputs[n]!.sourceTransaction;
    inp.sourceTXID = ours.inputs[n]!.sourceTXID;
  });
  return tx;
}

export interface CompletedSwap {
  txid: string;
  internalized: boolean;
  relinquished: string[];
  /** Internalize or relinquish errors (the swap itself is final). */
  errors: string[];
}

/**
 * Accepted: the wallet takes the payout in (`internalizeAction`) and drops
 * what the swap spent from its baskets (`relinquishOutput`: the funding
 * output in `1sat-deposit`, the token inputs in `bsv21`). The funding
 * transaction stays a `nosend` action; the wallet's TaskCheckNoSends finds
 * its proof once the validator's broadcast is mined.
 */
export async function completeSwap(wallet: WalletInterface, p: PreparedSwap, raw: number[], txid?: string): Promise<CompletedSwap> {
  const final = finalSwapOf(p, raw, txid);
  const out: CompletedSwap = { txid: final.id("hex"), internalized: false, relinquished: [], errors: [] };
  const outputs: InternalizeOutput[] = [internalizeOutputOf(p.payout)];
  if (p.commission.payout) outputs.push(internalizeOutputOf(p.commission.payout));
  try {
    const r = await wallet.internalizeAction({
      tx: final.toAtomicBEEF(true),
      outputs,
      description: p.payout.kind === "brc29" ? "AMM swap payout" : "AMM swap tokens",
      labels: ["amm-swap"],
    });
    out.internalized = r.accepted;
  } catch (err) {
    out.errors.push(`internalizeAction: ${err instanceof Error ? err.message : String(err)}`);
  }
  const spent = [
    { basket: DEPOSIT_BASKET, output: p.funding.outpoint },
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

function internalizeOutputOf(o: SwapPayout): InternalizeOutput {
  return o.kind === "brc29"
    ? { outputIndex: o.outputIndex, protocol: WALLET_PAYMENT, paymentRemittance: { ...o.remittance } }
    : { outputIndex: o.outputIndex, protocol: "basket insertion", insertionRemittance: { basket: o.basket, tags: o.tags, customInstructions: o.customInstructions } };
}

/** Refused or timed out: the funding action is aborted, freeing the wallet's inputs (its output never existed on chain). */
export async function abandonSwap(wallet: WalletInterface, p: PreparedSwap): Promise<void> {
  await wallet.abortAction({ reference: p.funding.reference });
}

/**
 * The pending-payout records of the swap's sats outputs to the taker (the
 * payout of a tokens-in swap, the taker's own commission of a sats-in swap;
 * none for token outputs), written before the swap is submitted. Their txid
 * is provisional: the validator's signature changes it.
 */
export function pendingSwapPayouts(p: PreparedSwap, tokenId: string, now = Date.now()): PendingPayout[] {
  const txid = p.swap.id("hex");
  const out: PendingPayout[] = [];
  for (const [o, description] of [[p.payout, "AMM swap payout"], [p.commission.payout, "AMM swap commission"]] as const) {
    if (o?.kind !== "brc29") continue;
    out.push({
      id: payoutId(txid, o.outputIndex),
      kind: "swap",
      txid,
      vout: o.outputIndex,
      satoshis: o.satoshis,
      lockingScript: o.lockingScript,
      remittance: o.remittance,
      final: false,
      tokenId,
      reference: p.funding.reference,
      description,
      createdAt: now,
    });
  }
  return out;
}

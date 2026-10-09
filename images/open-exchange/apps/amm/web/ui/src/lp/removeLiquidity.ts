/**
 * RemoveLiquidity through the user's wallet. LP-only: no third party gates
 * it (Pool.runar.go `RemoveLiquidity` checks the LP's signature alone), so
 * the funding is not a nosend action: the wallet broadcasts it at once.
 *
 *   1. `POST lookup {outpoint, beef: true}`: the pool output's AtomicBEEF.
 *   2. `PoolTemplate.planRemoveLiquidity`: the outputs the contract requires
 *      (continuation unless closing, BSV withdrawal, token withdrawal — each
 *      withdrawal to Hash160 of the current LpPubKey) and the method args.
 *      The next LP key: `getPublicKey`, the BRC-29 LP key for the spent pool
 *      outpoint (`lpKeyId`, src/lp/poolDeploy.ts).
 *   3. **Funding transaction**: `createFunding` (src/market/swapAction.ts)
 *      with `noSend: false`: one `createAction` (`randomizeOutputs: false`,
 *      `acceptDelayedBroadcast: false`) with one exact output — what the
 *      contract's outputs take beyond the pool's sats (1 per Mandala token
 *      withdrawal) plus the remove's miner fee at the rate (`swapFunding`
 *      over the plan) — P2PKH to a P1SAT key `amm-funding-<hex>`, in
 *      `1sat-deposit` with tags `amm-funding` + `hold:<expires>`. The wallet
 *      signs and broadcasts it.
 *   4. **Remove transaction**, built here: inputs pool (`callUnlock`,
 *      `_changeAmount = 0`; the LP's slot filled with `createSignature`
 *      under the pool's LP key) and the funding output (`createSignature`,
 *      SIGHASH_ALL|FORKID); outputs exactly the contract's, no change. Both
 *      inputs are checked with `Spend`.
 *   5. `POST <base>/submit` (`x-topics: tm_mandala_<txid>_0`) with the remove's
 *      AtomicBEEF; the funding transaction is in it as the unproven parent
 *      (the engine verifies against it, as it does the fixture's unproven
 *      pool deploy). The answer is BRC-22's STEAK (skein-overlay 0.9.1),
 *      or 503 when nothing is decided yet; the outcome is read with a
 *      lookup too (`awaitAdmitted`).
 *   6. `completeRemoveLiquidity`: one `internalizeAction` — the sats
 *      withdrawal as a BRC-29 wallet payment (the contract pays the current
 *      LP key, a BRC-29 key `"<prefix> <suffix>"`, so the remittance is its
 *      two halves and the user's own identity as sender), the token
 *      withdrawal and the continuation as basket insertions into `bsv21` —
 *      then `relinquishOutput` of the funding output (`1sat-deposit`) and the
 *      spent pool output (`bsv21`, when the wallet holds it as a row).
 *
 * If anything fails after step 3 the funding output stays in `1sat-deposit`
 * (on chain, the wallet's): 1sat-sdk's `sweepDeposit` reclaims it once the
 * hold lapses.
 *
 * A pool whose current LP key predates BRC-29 LP keys (`P1SAT_PROTOCOL`,
 * `amm-lp-…`) cannot withdraw sats as a wallet payment: the contract pays
 * that key, and the wallet only internalizes a payment locked to the BRC-29
 * key of its remittance. Its first RemoveLiquidity has to withdraw tokens only
 * (which rotates the LP key to a BRC-29 one); sats come out on the next.
 */
import { BSV21_BASKET, P1SAT_PROTOCOL, bsv21FilterTags, buildBsv21CustomInstructions } from "@1sat/actions";
import { DEPOSIT_BASKET } from "@1sat/types";
import { LockingScript, PublicKey, Transaction, UnlockingScript, type InternalizeOutput, type WalletInterface, type WalletProtocol } from "@bsv/sdk";
import { PoolTemplate, type CallPlan } from "../pool";
import { SWAP_TTL_MS, createFunding, poolUtxoFrom, signP2pkhWithWallet, spendValid, swapFunding, type Funding, type SwapFunding } from "../market/swapAction";
import { needSigned, type LookupOutput, type SignedFetch } from "../lib/overlay";
import { LP_KEY_PROTOCOL, lpKeyId, poolCustomInstructions, POOL_TAG, type BasketFiling } from "./poolDeploy";
import type { LpKeyRef } from "./myPools";
import { WALLET_PAYMENT, identityKeyOf, isBrc29Protocol, splitBrc29KeyID, type Brc29Payout, type PaymentRemittance } from "../wallet/brc29";
import { payoutId, type PendingPayout } from "../wallet/pendingPayouts";
import { sdkTokenId } from "../lib/tokenId";

export class RemoveShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoveShapeError";
  }
}

export interface RemoveLiquidityInput {
  wallet: WalletInterface;
  /** `<txid>_0` (src/lib/tokenId.ts). */
  tokenId: string;
  meta?: { sym?: string; dec?: number };
  poolOutput: LookupOutput;
  lpKey: LpKeyRef;
  removeBsv: bigint;
  removeTokens: bigint;
  /** sats per 1000 bytes (`VITE_FEE_RATE`). */
  satsPerKb: number;
  now?: number;
  ttlMs?: number;
}

export interface PreparedRemoveLiquidity {
  plan: CallPlan & { closing: boolean };
  /** The pool output spent, `txid.vout`. */
  poolOutpoint: string;
  nextLpKey: { protocolID: WalletProtocol; keyID: string; publicKey: string } | null;
  /** Broadcast by the wallet (no reference: there is nothing to abort). */
  funding: SwapFunding & Funding;
  expires: number;
  /** Both inputs signed. */
  tx: Transaction;
  txid: string;
  hex: string;
  size: number;
  /** The remove's AtomicBEEF (the funding and the pool's ancestry with it): the `/submit` body. */
  beef: number[];
  /** `tm_mandala_<assetId>`, `tm_mandala_<txid>_0` (BRC-207, David Case 2026-10-08) */
  topic: string;
  /** The sats withdrawal as a BRC-29 payment (null when no sats are withdrawn). */
  payout: Brc29Payout | null;
  /** The token withdrawal into `bsv21` (null when no tokens are withdrawn). */
  tokens: BasketFiling | null;
  /** The continuation into `bsv21` as a pool row (null when closing). */
  continuation: BasketFiling | null;
}

/** The remittance of a payment to the LP key `lpKey` (a BRC-29 key), or null for a pre-BRC-29 LP key. */
export function lpRemittance(lpKey: LpKeyRef, senderIdentityKey: string): PaymentRemittance | null {
  if (!isBrc29Protocol(lpKey.protocolID) || lpKey.counterparty !== "self") return null;
  const parts = splitBrc29KeyID(lpKey.keyID);
  return parts ? { ...parts, senderIdentityKey } : null;
}

export const LEGACY_LP_KEY =
  "this pool's LP key predates BRC-29 LP keys, and the contract pays the sats withdrawal to it, so the wallet could not take it in as a payment: withdraw tokens only first (that moves the pool to a BRC-29 LP key), then the sats";

const P1SAT = P1SAT_PROTOCOL as WalletProtocol;

/** Steps 2-4 (see the module comment). */
export async function prepareRemoveLiquidity(i: RemoveLiquidityInput): Promise<PreparedRemoveLiquidity> {
  const { wallet } = i;
  let remittance: PaymentRemittance | null = null;
  if (i.removeBsv > 0n) {
    if (!isBrc29Protocol(i.lpKey.protocolID)) throw new RemoveShapeError(LEGACY_LP_KEY);
    remittance = lpRemittance(i.lpKey, await identityKeyOf(wallet));
    if (!remittance) throw new RemoveShapeError(`the LP key ${i.lpKey.keyID} is not a BRC-29 key to self`);
  }
  const poolUtxo = poolUtxoFrom(i.poolOutput);
  const pool = PoolTemplate.decode(poolUtxo.script);
  if (!pool) throw new RemoveShapeError("the lookup's output is not a pool");
  const lpArgs = { protocolID: i.lpKey.protocolID, keyID: i.lpKey.keyID, counterparty: i.lpKey.counterparty };
  const { publicKey: currentLp } = await wallet.getPublicKey({ ...lpArgs, forSelf: true });
  if (PublicKey.fromString(currentLp).toString() !== pool.state.lpPubKey) {
    throw new RemoveShapeError(`the wallet key ${i.lpKey.keyID} is not this pool's LP key`);
  }

  const closing = i.removeBsv === BigInt(poolUtxo.satoshis) && i.removeTokens === pool.state.tokenReserve;
  // The contract always takes a next key; a closing call has no continuation to hold it.
  const nextKeyID = lpKeyId(`${poolUtxo.txid}_${poolUtxo.vout}`);
  const { publicKey: nextPub } = await wallet.getPublicKey({ protocolID: LP_KEY_PROTOCOL, keyID: nextKeyID, counterparty: "self", forSelf: true });
  const nextLpKey = closing ? null : { protocolID: LP_KEY_PROTOCOL, keyID: nextKeyID, publicKey: nextPub };
  const plan = PoolTemplate.planRemoveLiquidity({ pool: poolUtxo, removeBsv: i.removeBsv, removeTokens: i.removeTokens, nextLpPubKey: nextPub });

  // Where each output lands in the wallet afterwards; the filings carry 1sat-sdk's id form, `<txid>_0` (src/lib/tokenId.ts).
  const sdkId = sdkTokenId(i.tokenId);
  let at = 0;
  const continuation: BasketFiling | null = closing
    ? null
    : {
        outputIndex: at++,
        basket: BSV21_BASKET,
        tags: [...bsv21FilterTags({ tokenId: sdkId }), POOL_TAG],
        customInstructions: poolCustomInstructions({ tokenId: sdkId, ...i.meta, protocolID: LP_KEY_PROTOCOL, keyID: nextKeyID, args: plan.pool.args, validatorIdentity: plan.pool.state.validatorIdentity }),
      };
  const payout: Brc29Payout | null =
    i.removeBsv > 0n ? { outputIndex: at, satoshis: Number(plan.outputs[at]!.satoshis), lockingScript: plan.outputs[at++]!.script, remittance: remittance! } : null;
  const tokens: BasketFiling | null =
    i.removeTokens > 0n
      ? {
          outputIndex: at++,
          basket: BSV21_BASKET,
          tags: bsv21FilterTags({ tokenId: sdkId }),
          customInstructions: buildBsv21CustomInstructions({
            token: { id: sdkId, amt: String(i.removeTokens), op: "transfer", sym: i.meta?.sym, dec: i.meta?.dec },
            protocolID: i.lpKey.protocolID,
            keyID: i.lpKey.keyID,
            counterparty: i.lpKey.counterparty,
          }),
        }
      : null;

  // Step 3: the funding, broadcast by the wallet.
  const amounts = swapFunding(plan, [], i.satsPerKb);
  const expires = (i.now ?? Date.now()) + (i.ttlMs ?? SWAP_TTL_MS);
  const sym = i.meta?.sym ?? "token";
  const poolOutpoint = `${poolUtxo.txid}.${poolUtxo.vout}`;
  const f = await createFunding(wallet, {
    satoshis: amounts.satoshis,
    expires,
    amm: { remove: `${poolUtxo.txid}_${poolUtxo.vout}` },
    description: `AMM remove-liquidity funding: ${sym}`,
    labels: ["amm-remove-liquidity"],
    outputDescription: `AMM remove-liquidity funding: ${sym}`,
    noSend: false,
  });

  // Step 4: the remove transaction.
  const tx = new Transaction();
  tx.version = 1;
  tx.lockTime = 0;
  tx.addInput({ sourceTXID: poolUtxo.txid, sourceOutputIndex: poolUtxo.vout, sourceTransaction: poolUtxo.sourceTransaction, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
  tx.addInput({ sourceTXID: f.txid, sourceOutputIndex: 0, sourceTransaction: f.tx, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
  for (const o of plan.outputs) tx.addOutput({ satoshis: Number(o.satoshis), lockingScript: LockingScript.fromHex(o.script) });
  tx.inputs[0]!.unlockingScript = PoolTemplate.callUnlock(plan, tx, null).unlockingScript;
  await PoolTemplate.signPoolInput(
    { tx, pool: plan.pool, method: "removeLiquidity", unsigned: ["lp"], sourceSatoshis: poolUtxo.satoshis },
    "lp",
    async (sighash) => (await wallet.createSignature({ ...lpArgs, hashToDirectlySign: sighash })).signature,
  );
  tx.inputs[1]!.unlockingScript = await signP2pkhWithWallet(wallet, tx, 1, { satoshis: amounts.satoshis, lockingScript: f.lockingScript, protocolID: P1SAT, keyID: f.keyID, counterparty: "self" });
  for (const n of [0, 1]) {
    if (!spendValid(tx, n)) throw new RemoveShapeError(`input ${n} of the remove does not validate (the funding ${f.outpoint} stays in ${DEPOSIT_BASKET})`);
  }
  return {
    plan,
    poolOutpoint,
    nextLpKey,
    funding: { ...amounts, ...f },
    expires,
    tx,
    txid: tx.id("hex"),
    hex: tx.toHex(),
    size: tx.toBinary().length,
    beef: tx.toAtomicBEEF(true),
    topic: `tm_mandala_${sdkTokenId(i.tokenId)}`,
    payout,
    tokens,
    continuation,
  };
}

/** The pending-payout record of a prepared RemoveLiquidity (null without a sats withdrawal), written before it is submitted. */
export function pendingRemovePayout(s: PreparedRemoveLiquidity, tokenId: string, now = Date.now()): PendingPayout | null {
  if (!s.payout) return null;
  return {
    id: payoutId(s.txid, s.payout.outputIndex),
    kind: "remove-liquidity",
    txid: s.txid,
    vout: s.payout.outputIndex,
    satoshis: s.payout.satoshis,
    lockingScript: s.payout.lockingScript,
    remittance: s.payout.remittance,
    final: true,
    tokenId,
    ...(s.plan.closing ? {} : { poolOutpoint: `${s.txid}_0` }),
    description: "AMM liquidity withdrawal",
    createdAt: now,
  };
}

export interface CompletedRemove {
  internalized: boolean;
  relinquished: string[];
  errors: string[];
}

/**
 * Step 6, after a successful submit: the withdrawals (sats as a BRC-29
 * wallet payment, tokens as a basket insertion) and the continuation (a
 * pool row) in one `internalizeAction`; the funding output and the spent
 * pool output relinquished. A pool found by its history, not as a basket
 * row, makes the pool's `relinquishOutput` fail harmlessly (listed in
 * `errors`).
 */
export async function completeRemoveLiquidity(wallet: WalletInterface, s: PreparedRemoveLiquidity): Promise<CompletedRemove> {
  const out: CompletedRemove = { internalized: false, relinquished: [], errors: [] };
  const outputs: InternalizeOutput[] = [];
  const insert = (o: BasketFiling): InternalizeOutput => ({ outputIndex: o.outputIndex, protocol: "basket insertion", insertionRemittance: { basket: o.basket, tags: o.tags, customInstructions: o.customInstructions } });
  if (s.continuation) outputs.push(insert(s.continuation));
  if (s.payout) outputs.push({ outputIndex: s.payout.outputIndex, protocol: WALLET_PAYMENT, paymentRemittance: { ...s.payout.remittance } });
  if (s.tokens) outputs.push(insert(s.tokens));
  try {
    const r = await wallet.internalizeAction({ tx: s.beef, outputs, description: "AMM liquidity withdrawal", labels: ["amm-remove-liquidity"] });
    out.internalized = r.accepted;
  } catch (err) {
    out.errors.push(`internalizeAction: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const r of [{ basket: DEPOSIT_BASKET, output: s.funding.outpoint }, { basket: BSV21_BASKET, output: s.poolOutpoint }]) {
    try {
      await wallet.relinquishOutput(r);
      out.relinquished.push(r.output);
    } catch (err) {
      out.errors.push(`relinquishOutput ${r.output}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

/** BRC-22's STEAK: per topic, the outputs admitted and the coins retained and removed. */
export type Steak = Record<string, { outputsToAdmit: number[]; coinsToRetain: number[]; coinsRemoved: number[] }>;

/**
 * Submit to the instance (BRC-22; skein-overlay 0.9.1, docs/OVERLAY.md "Submitting"): `POST
 * <base>/submit` (`x-topics` the token topic, the body the BEEF) waits on the submission and
 * answers the STEAK; 503 with Retry-After when nothing is decided within the host's bound (the
 * submission stands: `steak` absent). Plain `fetch`, unsigned (0.6.3; David 2026-10-08: "We
 * shouldn't be using authfetch for the submit http method."): the front door (shruggr/skein#135)
 * admits an unsigned POST at the overlay's `submit` row (sender `*`, filter `beef`), and
 * `@bsv/sdk`'s AuthFetch refuses the `x-topics` header client-side.
 */
export async function submitToOverlay(
  base: string,
  topic: string,
  beef: number[],
  fetchFn: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
): Promise<{ steak?: Steak }> {
  const res = await fetchFn(`${base}/submit`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-topics": topic },
    body: new Uint8Array(beef),
  });
  const text = await res.text();
  if (res.status === 503) return {};
  if (!res.ok) throw new Error(`POST ${base}/submit: ${res.status} ${text.slice(0, 300)}`);
  let steak: unknown;
  try {
    steak = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (!steak || typeof steak !== "object" || Array.isArray(steak)) throw new Error(`POST ${base}/submit: want the STEAK, got ${text.slice(0, 300)}`);
  return { steak: steak as Steak };
}

/** The STEAK in words: the topics that admitted outputs, else "taken by no topic"; no STEAK, "not decided yet". */
export function steakText(r: { steak?: Steak }): string {
  if (!r.steak) return "not decided yet";
  const took = Object.entries(r.steak).filter(([, e]) => e.outputsToAdmit.length > 0).map(([t, e]) => `${t} (outputs ${e.outputsToAdmit.join(", ")})`);
  return took.length ? `admitted under ${took.join("; ")}` : "taken by no topic";
}

/** The output of the remove the lookup is asked about: the continuation, else the token withdrawal (null: neither). */
export function admittedOutput(s: Pick<PreparedRemoveLiquidity, "continuation" | "tokens">): number | null {
  return s.continuation?.outputIndex ?? s.tokens?.outputIndex ?? null;
}

/**
 * Whether the overlay admitted `txid`: `ls_mandala {txid, outputIndex}` (one Mandala output, if
 * unspent; skein-mandala docs/MANDALA.md) asked until it answers the output or `timeoutMs` passes.
 * The engine admits once the chain app accepts the transaction (its broadcast succeeded).
 */
export async function awaitAdmitted(
  af: SignedFetch | null,
  base: string,
  txid: string,
  outputIndex: number,
  o: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const signed = needSigned(af);
  const deadline = Date.now() + (o.timeoutMs ?? 60_000);
  for (;;) {
    const res = await signed.fetch(`${base}/lookup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ service: "ls_mandala", query: { txid, outputIndex } }),
    });
    if (res.ok) {
      const a = (await res.json()) as { outputs?: unknown[] };
      if (Array.isArray(a.outputs) && a.outputs.length > 0) return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, o.intervalMs ?? 2_000));
  }
}

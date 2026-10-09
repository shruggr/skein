/**
 * Creating a pool from a token in the wallet: the deploy is DELIVERED to the
 * skein, not broadcast (skein-amm 0.9.0, David Case 2026-10-09). The page
 * holds no keys: every key and signature comes from the wallet
 * (`getPublicKey`, `createAction`, `signAction`, `createSignature`).
 *
 *   1. **Funding transaction**: `createFunding` (src/market/swapAction.ts):
 *      `createAction` (signAndProcess false, noSend) + `signAction` (noSend),
 *      one exact output, P2PKH to a P1SAT key `amm-funding-<hex>`, in
 *      `1sat-deposit` (tags `amm-funding` + `hold:<expires>`). The amount:
 *      what the deploy's outputs and the validator's claim take beyond the
 *      token inputs' sats, plus the miner fee of the deploy with the claim
 *      at the rate (`deployFunding`).
 *   2. **Deploy transaction**, built here, every input signed
 *      SIGHASH_SINGLE|FORKID over its own output (`createSignature` over the
 *      BIP-143 sighash; checked with `Spend`), so the validator can append
 *      the claim after them:
 *        input 0     the first token input   → output 0, the pool
 *        input j     each further input (the other token inputs, then the
 *                    funding, last)          → output j, an LP output: the
 *                    token change (Mandala value, P2PKH to the change key,
 *                    filed in `bsv21`) first when the inputs carry more
 *                    than the deposit and the claim's unit, else the LP's
 *                    sats change (1 sat, P2PKH to the BRC-29 change key: a
 *                    wallet payment to self)
 *      The token inputs carry exactly ONE unit more than the pool takes and
 *      the token change: that unit is the validator's claim.
 *   3. The relay (src/lp/poolRelay.ts, `amm.pool.submit`, the skein's own
 *      validator, `amm.pool.terms`) delivers it; the validator checks it
 *      against its terms, appends the claim (one unit, P2PKH to the pool's
 *      validator key, its payload that key's signature over the pool's
 *      script and the first token input), submits it to its overlay (which
 *      broadcasts it) and answers the claimed deploy.
 *   4. Accepted: `completePoolDeploy` checks the answer is our deploy with
 *      one output appended, internalizes the pool output (basket insertion
 *      into `bsv21`, tag `amm-pool`, no `amt`; its claim's vout in the
 *      customInstructions), the token change and the sats change, and
 *      relinquishes the funding output and the token inputs. Refused /
 *      timed out: `abandonPoolDeploy` aborts the funding action.
 *
 * Keys:
 *  - LP key: a BRC-29 key (src/wallet/brc29.ts) — `getPublicKey({protocolID:
 *    [2, "3241645161d8"], keyID: "<derivationPrefix> <derivationSuffix>",
 *    counterparty: "self", forSelf: true})` with derivationPrefix =
 *    base64("amm-lp") and derivationSuffix = base64("<txid>_<vout>"), keyed by
 *    the first deposit input. Close pays the pool's BSV to Hash160 of it, so
 *    the payout is a wallet payment the wallet internalizes (sender = the
 *    user's own identity). Pools created before have a 1sat-sdk LP key
 *    (`P1SAT_PROTOCOL`, keyID "amm-lp-<txid>_<vout>", `legacyLpKeyId`).
 *  - Change key (token change and sats change): BRC-29 like the LP key,
 *    derivationPrefix = base64("amm-change"), derivationSuffix =
 *    base64("<txid>_<vout>") of the same first deposit input
 *    (`changeKeyId`).
 *  - Validator key: the anyone-child of the validator's identity for
 *    `1-amm pool-<first deposit input>` (src/lib/keys.ts), a public
 *    derivation, computed here; the claim is locked to it.
 *
 * Filing: the pool output goes to the `bsv21` basket with tags
 * `bsv21:<tokenId>` and `amm-pool`, customInstructions `{id, op: "amm-pool",
 * sym, dec, protocolID, keyID, counterparty, amm: {...}}` and **no `amt`**:
 * 1sat-sdk's balance and `sendBsv21` input selection skip rows without an
 * amount, so the pool is never picked as an ordinary token input.
 */
import {
  BSV21_BASKET,
  P1SAT_PROTOCOL,
  bsv21FilterTags,
  buildBsv21CustomInstructions,
} from "@1sat/actions";
import { BSV21_DEPLOY_TAG, DEPOSIT_BASKET } from "@1sat/types";
import {
  LockingScript,
  P2PKH,
  PublicKey,
  Transaction,
  UnlockingScript,
  Utils,
  type InternalizeOutput,
  type WalletInterface,
  type WalletProtocol,
} from "@bsv/sdk";
import { BSV21 } from "@1sat/templates";
import { Script } from "@bsv/sdk";
import { PoolTemplate, decodeMandala, mandalaValuePrefix, type PoolArgs, type PoolFields } from "../pool";
import { deriveValidatorPubKey, validatorKeyId } from "../lib/keys";
import {
  P2PKH_UNLOCK_LENGTH,
  SWAP_TTL_MS,
  createFunding,
  selectExactTokenInputs,
  signP2pkhWithWallet,
  spendValid,
  type Funding,
  type SwapFunding,
  type TokenInput,
} from "../market/swapAction";
import { priceOf } from "../market/view";
/** The validator a pool names: its identity key (compressed, lowercase hex) and its libp2p peer ID. */
export interface ValidatorChoice {
  identityKey: string;
  peerId?: string;
}

import { BRC29_PROTOCOL, brc29KeyID, WALLET_PAYMENT, identityKeyOf } from "../wallet/brc29";
import { TransactionSignature } from "@bsv/sdk";
import { tokenSourceBeef } from "./wallet";
import { POOL_OP, POOL_TAG, isPoolRow } from "./poolRows";
import { parseOutpoint, parseTokenId, sdkTokenId, tokenIdOfWire, tokenIdText } from "../lib/tokenId";
export { POOL_OP, POOL_TAG, isPoolRow };
/** The keyID prefix of the pre-BRC-29 LP keys (`P1SAT_PROTOCOL`). */
export const LP_KEY_PREFIX = "amm-lp-";
/** The LP key's protocol: BRC-29 (see the module comment). */
export const LP_KEY_PROTOCOL: WalletProtocol = BRC29_PROTOCOL;
const LP_DERIVATION_PREFIX = Utils.toBase64(Utils.toArray("amm-lp", "utf8"));
const CHANGE_DERIVATION_PREFIX = Utils.toBase64(Utils.toArray("amm-change", "utf8"));
/** The validator's default terms (amm-validator's, `config.amm.ammValidator`); a deploy takes the skein's own from `amm.pool.terms`. */
export const DEFAULT_LP_FEE_BPS = 30n;
export const DEFAULT_VALIDATOR_FEE_BPS = 5n;
/** The claim's token amount (one unit) and its sat: the validator appends it after the LP's outputs. */
export const CLAIM_UNITS = 1n;
/** The claim output's script length at most: id push, OP_1, OP_2DROP, a 72-byte DER payload push, OP_DROP, P2PKH. */
export const CLAIM_SCRIPT_LENGTH = 1 + 32 + 1 + 1 + 1 + 72 + 1 + 25;
/** The deploy's sighash: SINGLE|FORKID, each input over its own output (0.9.0). */
export const DEPLOY_SCOPE = TransactionSignature.SIGHASH_SINGLE | TransactionSignature.SIGHASH_FORKID;

const toHex = (b: number[] | Uint8Array) => Utils.toHex(Array.from(b));

function describe(text: string): string {
  return text.length <= 50 ? text : `${text.slice(0, 49)}…`;
}

/** The LP key's BRC-29 derivation for a pool output created by a transaction whose input 0 spends `outpoint` (`<txid>_<vout>` or `txid.vout`). */
export function lpDerivation(outpoint: string): { derivationPrefix: string; derivationSuffix: string } {
  const [txid, vout] = outpoint.split(/[._]/);
  return { derivationPrefix: LP_DERIVATION_PREFIX, derivationSuffix: Utils.toBase64(Utils.toArray(`${txid}_${vout}`, "utf8")) };
}

/** The LP key's keyID (`LP_KEY_PROTOCOL`) for `outpoint`: `"<derivationPrefix> <derivationSuffix>"`. */
export function lpKeyId(outpoint: string): string {
  return brc29KeyID(lpDerivation(outpoint));
}

/** The token change key's BRC-29 derivation for a deploy whose input 0 spends `outpoint`: as `lpDerivation`, prefix "amm-change". */
export function changeDerivation(outpoint: string): { derivationPrefix: string; derivationSuffix: string } {
  const [txid, vout] = outpoint.split(/[._]/);
  return { derivationPrefix: CHANGE_DERIVATION_PREFIX, derivationSuffix: Utils.toBase64(Utils.toArray(`${txid}_${vout}`, "utf8")) };
}

/** The token change key's keyID (`LP_KEY_PROTOCOL`, BRC-29) for `outpoint`. */
export function changeKeyId(outpoint: string): string {
  return brc29KeyID(changeDerivation(outpoint));
}

/** The pre-BRC-29 LP keyID (`P1SAT_PROTOCOL`): `amm-lp-<txid>_<vout>`. */
export function legacyLpKeyId(outpoint: string): string {
  const [txid, vout] = outpoint.split(/[._]/);
  return `${LP_KEY_PREFIX}${txid}_${vout}`;
}

// ---------------------------------------------------------------------------
// Which tokens can go into a pool
// ---------------------------------------------------------------------------

export interface BasketRow {
  outpoint: string;
  satoshis: number;
  lockingScript?: string;
  tags?: string[];
  customInstructions?: string;
}

export interface PoolableToken {
  /** `<txid>_0`: a token with a 32-byte id (src/lib/tokenId.ts). */
  tokenId: string;
  txid: string;
  sym?: string;
  dec?: number;
  /** Spendable Mandala outputs of the token (value outputs; a fixed-supply deploy output too). */
  inputs: TokenInput[];
  balance: bigint;
}

export interface HiddenToken {
  tokenId: string;
  reason: string;
}

const LEGACY_HIDDEN = "legacy token (BRC-161 deploy, 36-byte id or JSON form): the Pool contract hard-codes a 32-byte asset id";

/**
 * The tokens a pool can be made of: Mandala outputs with a 32-byte id (or the
 * deploy output itself, as amm-topic's fixture pool deploy spends it) whose
 * customInstructions name the wallet key. Legacy tokens are listed as hidden.
 */
export function poolableTokens(rows: BasketRow[], meta: Map<string, { sym?: string; dec?: number }> = new Map()): { tokens: PoolableToken[]; hidden: HiddenToken[] } {
  const byId = new Map<string, PoolableToken>();
  const hidden = new Map<string, HiddenToken>();
  for (const r of rows) {
    if (!r.lockingScript || isPoolRow(r)) continue;
    const op = parseOutpoint(r.outpoint);
    if (!op) continue;
    const { txid, vout } = op;
    const bytes = Utils.toArray(r.lockingScript, "hex") as number[];
    const t = decodeMandala(bytes);
    if (!t) {
      // Legacy JSON (BRC-161) token output: its id is `<txid>_<vout>`.
      try {
        const j = BSV21.decode(Script.fromHex(r.lockingScript));
        const named = j?.tokenData.id;
        const ref = named ? parseTokenId(named) : j?.tokenData.op?.startsWith("deploy") ? op : null;
        const id = ref ? tokenIdText(ref) : named;
        if (id) hidden.set(id, { tokenId: id, reason: LEGACY_HIDDEN });
      } catch {
        /* not a token */
      }
      continue;
    }
    let tokenId: string;
    if (t.role === "deploy") {
      if (t.amount <= 0n) continue;
      tokenId = tokenIdText(op);
      if (vout !== 0) {
        hidden.set(tokenId, { tokenId, reason: LEGACY_HIDDEN });
        continue;
      }
    } else if (t.role === "value" && t.idBytes) {
      tokenId = tokenIdOfWire(t.idBytes);
      if (t.idBytes.length !== 32) {
        hidden.set(tokenId, { tokenId, reason: LEGACY_HIDDEN });
        continue;
      }
    } else continue;

    let ci: { protocolID?: unknown; keyID?: unknown; counterparty?: unknown } = {};
    try {
      ci = JSON.parse(r.customInstructions ?? "{}");
    } catch {
      continue;
    }
    if (!Array.isArray(ci.protocolID) || typeof ci.keyID !== "string") continue;
    let tok = byId.get(tokenId);
    if (!tok) {
      const m = meta.get(tokenId);
      tok = { tokenId, txid: tokenId.slice(0, 64), inputs: [], balance: 0n, ...(m?.sym !== undefined ? { sym: m.sym } : {}), ...(m?.dec !== undefined ? { dec: m.dec } : {}) };
      byId.set(tokenId, tok);
    }
    tok.inputs.push({
      outpoint: `${txid}.${vout}`,
      txid,
      vout,
      satoshis: r.satoshis,
      lockingScript: r.lockingScript,
      amount: t.amount,
      protocolID: ci.protocolID as WalletProtocol,
      keyID: ci.keyID,
      counterparty: typeof ci.counterparty === "string" ? ci.counterparty : "self",
    });
    tok.balance += t.amount;
  }
  for (const id of byId.keys()) hidden.delete(id);
  return { tokens: [...byId.values()], hidden: [...hidden.values()] };
}

/**
 * The deposit's token inputs, which must carry `amount` and the claim's one
 * unit (0.9.0): one output carrying exactly `amount + 1` when the wallet has
 * one (no change), else one output carrying more (token change), else an
 * exact subset, else the largest outputs until covered. Each input is paired
 * with an output of its own, so fewer inputs mean fewer outputs. Null when
 * the wallet holds less than `amount + 1`.
 */
export function selectDepositInputs(candidates: TokenInput[], amount: bigint): { inputs: TokenInput[]; change: bigint } | null {
  if (amount <= 0n) return null;
  const need = amount + CLAIM_UNITS;
  const one = candidates.find((c) => c.amount === need);
  if (one) return { inputs: [one], change: 0n };
  const sorted = [...candidates].sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0));
  const big = [...sorted].reverse().find((c) => c.amount > need); // the smallest that covers it
  if (big) return { inputs: [big], change: big.amount - need };
  const exact = selectExactTokenInputs(candidates, need);
  if (exact) return { inputs: exact, change: 0n };
  const pick: TokenInput[] = [];
  let sum = 0n;
  for (const c of sorted) {
    if (sum >= need) break;
    pick.push(c);
    sum += c.amount;
  }
  return sum >= need ? { inputs: pick, change: sum - need } : null;
}

// ---------------------------------------------------------------------------
// The plan (pure)
// ---------------------------------------------------------------------------

export interface PoolDeployForm {
  tokenId: string;
  inputs: TokenInput[];
  tokens: bigint;
  sats: bigint;
  lpFeeBps: bigint;
  validatorFeeBps: bigint;
  /** The relay's commission (the contract's CommissionBps), fixed at deploy. Default 0: no commission output on any swap. */
  commissionBps?: bigint;
  lpPubKey: string;
  validator: ValidatorChoice;
  dec?: number;
}

export interface PoolDeployPlan {
  tokenId: string;
  /** `tm_mandala_<assetId>`, `tm_mandala_<txid>_0`: the token's topic (BRC-207, David Case 2026-10-08). */
  topic: string;
  args: PoolArgs;
  state: PoolFields;
  /** Output 0's script, hex. */
  lockingScript: string;
  /** Input 0: the first deposit input, `<txid>_<vout>`. */
  depositOutpoint: string;
  /** `1-amm pool-<depositOutpoint>`'s key ID. */
  validatorKeyId: string;
  lpKeyId: string;
  /** What the inputs carry beyond the deposit and the claim's unit. */
  tokenChange: bigint;
  sats: bigint;
  /** Initial marginal price, sats per token (display units when `dec` is known). */
  price: string;
}

export class PoolDeployError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PoolDeployError";
  }
}

/** A token with a 32-byte id (`<txid>_0`; `<txid>` / `<txid>.0` read the same) → the wire id (internal byte order), hex. */
export function assetIdHex(tokenId: string): string {
  const r = parseTokenId(tokenId);
  if (!r || r.vout !== 0) throw new PoolDeployError(`pools exist only for Mandala tokens with a 32-byte id (<txid>_0), not ${tokenId}`);
  return toHex((Utils.toArray(r.txid, "hex") as number[]).reverse());
}

export function planPoolDeploy(f: PoolDeployForm): PoolDeployPlan {
  const assetId = assetIdHex(f.tokenId);
  if (f.tokens <= 0n) throw new PoolDeployError("the token deposit must be positive");
  if (f.sats <= 0n || f.sats > BigInt(Number.MAX_SAFE_INTEGER)) throw new PoolDeployError("the sats deposit must be positive");
  const commissionBps = f.commissionBps ?? 0n;
  for (const [name, bps] of [["LP fee", f.lpFeeBps], ["validator fee", f.validatorFeeBps], ["commission", commissionBps]] as const) {
    if (bps < 0n || bps >= 10_000n) throw new PoolDeployError(`${name}: 0-9999 bps`);
  }
  if (f.lpFeeBps + f.validatorFeeBps + commissionBps >= 10_000n) throw new PoolDeployError("the fees together must stay below 100%");
  if (f.inputs.length === 0) throw new PoolDeployError("no token inputs");
  const held = f.inputs.reduce((a, t) => a + t.amount, 0n);
  if (held < f.tokens + CLAIM_UNITS) throw new PoolDeployError(`the inputs carry ${held}, the deposit and the claim's unit are ${f.tokens + CLAIM_UNITS}`);
  const first = f.inputs[0]!;
  const deposit = { txid: first.txid, vout: first.vout };
  const args: PoolArgs = { assetId, lpFeeBps: f.lpFeeBps, validatorFeeBps: f.validatorFeeBps, commissionBps };
  const state: PoolFields = {
    tokenReserve: f.tokens,
    lpPubKey: PublicKey.fromString(f.lpPubKey).toString(),
    validatorPubKey: deriveValidatorPubKey(f.validator.identityKey, deposit),
    validatorIdentity: PublicKey.fromString(f.validator.identityKey).toString(),
  };
  return {
    tokenId: f.tokenId,
    topic: `tm_mandala_${sdkTokenId(f.tokenId)}`,
    args,
    state,
    lockingScript: PoolTemplate.lockDeploy(args, state).toHex(),
    depositOutpoint: validatorKeyId(deposit),
    validatorKeyId: validatorKeyId(deposit),
    lpKeyId: lpKeyId(`${first.txid}_${first.vout}`),
    tokenChange: held - f.tokens - CLAIM_UNITS,
    sats: f.sats,
    price: priceOf(f.sats, f.tokens, f.dec),
  };
}

/** A Mandala value output of `amount` to `pubKey` (P2PKH), as Pool.runar.go's `tokenP2pkh` writes it. */
export function tokenP2pkhScript(tokenId: string, amount: bigint, pubKey: string): string {
  const prefix = mandalaValuePrefix(Utils.toArray(assetIdHex(tokenId), "hex"), amount);
  return toHex(prefix) + new P2PKH().lock(PublicKey.fromString(pubKey).toAddress()).toHex();
}

/** customInstructions of a pool output the wallet holds as LP (no `amt`: see the module comment). */
export function poolCustomInstructions(o: {
  tokenId: string;
  sym?: string;
  dec?: number;
  protocolID: WalletProtocol;
  keyID: string;
  args: PoolArgs;
  validatorIdentity: string;
}): string {
  return JSON.stringify({
    id: o.tokenId,
    op: POOL_OP,
    ...(o.sym ? { sym: o.sym } : {}),
    ...(o.dec !== undefined ? { dec: String(o.dec) } : {}),
    protocolID: o.protocolID,
    keyID: o.keyID,
    counterparty: "self",
    amm: { role: "lp", validatorIdentity: o.validatorIdentity, lpFeeBps: String(o.args.lpFeeBps), validatorFeeBps: String(o.args.validatorFeeBps), commissionBps: String(o.args.commissionBps) },
  });
}

// ---------------------------------------------------------------------------
// The funding amount
// ---------------------------------------------------------------------------

function varIntSize(n: number): number {
  return n < 0xfd ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9;
}

/** The deploy's size in bytes: `inputs` P2PKH-signed inputs (token inputs and the funding) at 108 bytes of unlocking script, the outputs (the claim among them). */
export function deployTxSize(outputs: { script: string }[], inputs: number): number {
  let size = 4 + varIntSize(inputs) + inputs * (36 + varIntSize(P2PKH_UNLOCK_LENGTH) + P2PKH_UNLOCK_LENGTH + 4);
  size += varIntSize(outputs.length);
  for (const o of outputs) {
    const len = o.script.length / 2;
    size += 8 + varIntSize(len) + len;
  }
  return size + 4;
}

/**
 * The exact funding of a deploy: Σ outputs (the LP's and the claim's sat) −
 * Σ token inputs' sats, plus ceil(size × rate / 1000) for the deploy with the
 * funding as one more input and the claim appended (0.9.0).
 */
export function deployFunding(outputs: { satoshis: number; script: string }[], tokenInputs: { satoshis: number }[], satsPerKb: number): SwapFunding {
  const withClaim = [...outputs, { satoshis: 1, script: "00".repeat(CLAIM_SCRIPT_LENGTH) }];
  const outSum = withClaim.reduce((a, o) => a + o.satoshis, 0);
  const tokenSats = tokenInputs.reduce((a, t) => a + t.satoshis, 0);
  const size = deployTxSize(withClaim, tokenInputs.length + 1);
  const fee = Math.ceil((size * satsPerKb) / 1000);
  const net = outSum - tokenSats;
  return { satoshis: Math.max(1, net + fee), outputs: net, fee, size, satsPerKb };
}

// ---------------------------------------------------------------------------
// The wallet sequence
// ---------------------------------------------------------------------------

/** The LP key for a deposit whose first input is `firstInput`. */
export async function deriveLpKey(wallet: WalletInterface, firstInput: { txid: string; vout: number }): Promise<{ protocolID: WalletProtocol; keyID: string; publicKey: string }> {
  const protocolID = LP_KEY_PROTOCOL;
  const keyID = lpKeyId(`${firstInput.txid}_${firstInput.vout}`);
  const { publicKey } = await wallet.getPublicKey({ protocolID, keyID, counterparty: "self", forSelf: true });
  return { protocolID, keyID, publicKey };
}

/** The token change key for a deposit whose first input is `firstInput` (see the module comment). */
export async function deriveChangeKey(wallet: WalletInterface, firstInput: { txid: string; vout: number }): Promise<{ protocolID: WalletProtocol; keyID: string; publicKey: string }> {
  const protocolID = LP_KEY_PROTOCOL;
  const keyID = changeKeyId(`${firstInput.txid}_${firstInput.vout}`);
  const { publicKey } = await wallet.getPublicKey({ protocolID, keyID, counterparty: "self", forSelf: true });
  return { protocolID, keyID, publicKey };
}

export class DeployShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployShapeError";
  }
}

/** How an output of ours is taken into a basket after the fact (`internalizeAction` basket insertion). */
export interface BasketFiling {
  outputIndex: number;
  basket: string;
  tags: string[];
  customInstructions: string;
}

export interface PreparePoolDeployInput {
  wallet: WalletInterface;
  form: Omit<PoolDeployForm, "lpPubKey" | "dec">;
  meta?: { sym?: string; dec?: number };
  /** sats per 1000 bytes (`VITE_FEE_RATE`). */
  satsPerKb: number;
  now?: number;
  ttlMs?: number;
}

export interface PreparedPoolDeploy {
  plan: PoolDeployPlan;
  /** The validator's identity key (hex). */
  validator: string;
  expires: number;
  lpKey: { protocolID: WalletProtocol; keyID: string; publicKey: string };
  funding: SwapFunding & Funding & { reference: string };
  /** The deploy as delivered: every input signed SIGHASH_SINGLE|FORKID, input i paired with output i. */
  deploy: Transaction;
  txid: string;
  /** The deploy as AtomicBEEF: the funding and the token inputs' source transactions with it. */
  atomicBeef: number[];
  tokenInputs: TokenInput[];
  /** Output 0 into `bsv21` as a pool row. */
  pool: BasketFiling;
  /** The token change into `bsv21` as an ordinary token output, when there is token change. */
  tokenChange: BasketFiling | null;
  /** The sats change outputs, each a BRC-29 payment to self (the change key). */
  satsChange: { outputIndex: number; satoshis: number; remittance: { derivationPrefix: string; derivationSuffix: string; senderIdentityKey: string } }[];
}

const P1SAT = P1SAT_PROTOCOL as WalletProtocol;

/** Steps 1-2 (see the module comment). Aborts the funding action on any failure after it exists. */
export async function preparePoolDeploy(i: PreparePoolDeployInput): Promise<PreparedPoolDeploy> {
  const { wallet, form } = i;
  const meta = i.meta ?? {};
  const first = form.inputs[0];
  if (!first) throw new PoolDeployError("no token inputs");
  const lpKey = await deriveLpKey(wallet, first);
  const plan = planPoolDeploy({ ...form, lpPubKey: lpKey.publicKey, dec: meta.dec });
  const sym = meta.sym ?? "token";

  // The wallet's filings carry 1sat-sdk's id form, `<txid>_0` (src/lib/tokenId.ts).
  const sdkId = sdkTokenId(plan.tokenId);
  const pool: BasketFiling = {
    outputIndex: 0,
    basket: BSV21_BASKET,
    tags: [...bsv21FilterTags({ tokenId: sdkId }), POOL_TAG],
    customInstructions: poolCustomInstructions({ tokenId: sdkId, ...meta, protocolID: lpKey.protocolID, keyID: lpKey.keyID, args: plan.args, validatorIdentity: plan.state.validatorIdentity }),
  };
  // One output per input after the pool: the token change first (if any), then the sats change.
  const change = await deriveChangeKey(wallet, first);
  const outputs: { satoshis: number; script: string }[] = [{ satoshis: Number(plan.sats), script: plan.lockingScript }];
  let tokenChange: BasketFiling | null = null;
  if (plan.tokenChange > 0n) {
    outputs.push({ satoshis: 1, script: tokenP2pkhScript(plan.tokenId, plan.tokenChange, change.publicKey) });
    tokenChange = {
      outputIndex: 1,
      basket: BSV21_BASKET,
      tags: bsv21FilterTags({ tokenId: sdkId }),
      customInstructions: buildBsv21CustomInstructions({
        token: { id: sdkId, amt: String(plan.tokenChange), op: "transfer", sym: meta.sym, dec: meta.dec },
        protocolID: change.protocolID,
        keyID: change.keyID,
        counterparty: "self",
      }),
    };
  }
  const satsChange: PreparedPoolDeploy["satsChange"] = [];
  const me = await identityKeyOf(wallet);
  const changeLock = new P2PKH().lock(PublicKey.fromString(change.publicKey).toAddress()).toHex();
  while (outputs.length < form.inputs.length + 1) {
    satsChange.push({ outputIndex: outputs.length, satoshis: 1, remittance: { ...changeDerivation(`${first.txid}_${first.vout}`), senderIdentityKey: me } });
    outputs.push({ satoshis: 1, script: changeLock });
  }

  // The token inputs' source transactions: the token's own basket, and `bsv21` (a deploy output there is tagged `bsv21:deploy`, not by its id).
  const tokenBeef = await tokenSourceBeef(wallet, plan.tokenId, { tags: [...bsv21FilterTags({ tokenId: sdkId }), BSV21_DEPLOY_TAG], tagQueryMode: "any" });
  if (!tokenBeef) throw new DeployShapeError("the wallet returned no BEEF for the token inputs");
  for (const t of form.inputs) if (!tokenBeef.findTxid(t.txid)) throw new DeployShapeError(`the wallet's BEEF lacks the token input ${t.outpoint}`);

  const amounts = deployFunding(outputs, form.inputs, i.satsPerKb);
  const expires = (i.now ?? Date.now()) + (i.ttlMs ?? SWAP_TTL_MS);
  const f = await createFunding(wallet, {
    satoshis: amounts.satoshis,
    expires,
    amm: { deploy: sdkId },
    description: `AMM pool deploy funding: ${sym}`,
    labels: ["amm-pool-deploy"],
    outputDescription: `AMM pool deploy funding: ${sym}`,
    noSend: true,
  });
  const reference = f.reference!;
  try {
    const tx = new Transaction();
    tx.version = 1;
    tx.lockTime = 0;
    for (const t of form.inputs) {
      const src = tokenBeef.findAtomicTransaction(t.txid) ?? tokenBeef.findTxid(t.txid)!.tx!;
      tx.addInput({ sourceTXID: t.txid, sourceOutputIndex: t.vout, sourceTransaction: src, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
    }
    tx.addInput({ sourceTXID: f.txid, sourceOutputIndex: 0, sourceTransaction: f.tx, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
    for (const o of outputs) tx.addOutput({ satoshis: o.satoshis, lockingScript: LockingScript.fromHex(o.script) });

    const fi = form.inputs.length;
    for (const [n, t] of form.inputs.entries()) tx.inputs[n]!.unlockingScript = await signP2pkhWithWallet(wallet, tx, n, t, DEPLOY_SCOPE);
    tx.inputs[fi]!.unlockingScript = await signP2pkhWithWallet(wallet, tx, fi, { satoshis: amounts.satoshis, lockingScript: f.lockingScript, protocolID: P1SAT, keyID: f.keyID, counterparty: "self" }, DEPLOY_SCOPE);
    for (let n = 0; n < tx.inputs.length; n++) {
      if (!spendValid(tx, n)) throw new DeployShapeError(`input ${n} of the deploy does not validate`);
    }
    return {
      plan,
      validator: plan.state.validatorIdentity,
      expires,
      lpKey,
      funding: { ...amounts, ...f, reference },
      deploy: tx,
      txid: tx.id("hex"),
      atomicBeef: tx.toAtomicBEEF(true),
      tokenInputs: form.inputs,
      pool,
      tokenChange,
      satsChange,
    };
  } catch (err) {
    await wallet.abortAction({ reference }).catch(() => undefined);
    throw err;
  }
}

export interface CompletedPoolDeploy {
  /** The claimed deploy's txid (the validator appended its claim). */
  txid: string;
  /** `<txid>_0` */
  pool: string;
  /** The claim's output index. */
  claimVout: number;
  internalized: boolean;
  relinquished: string[];
  /** Internalize or relinquish errors (the deploy itself is final). */
  errors: string[];
}

/** Whether `claimed` is `delivered` with one output appended and nothing else changed (0.9.0). */
export function isClaimedDeploy(delivered: Transaction, claimed: Transaction): boolean {
  if (claimed.version !== delivered.version || claimed.lockTime !== delivered.lockTime) return false;
  if (claimed.inputs.length !== delivered.inputs.length || claimed.outputs.length !== delivered.outputs.length + 1) return false;
  for (const [n, d] of delivered.inputs.entries()) {
    const c = claimed.inputs[n]!;
    if (c.sourceTXID !== (d.sourceTXID ?? d.sourceTransaction?.id("hex")) || c.sourceOutputIndex !== d.sourceOutputIndex) return false;
    if ((c.unlockingScript?.toHex() ?? "") !== (d.unlockingScript?.toHex() ?? "")) return false;
  }
  for (const [n, d] of delivered.outputs.entries()) {
    const c = claimed.outputs[n]!;
    if (c.satoshis !== d.satoshis || c.lockingScript.toHex() !== d.lockingScript.toHex()) return false;
  }
  return true;
}

/** The claimed deploy as AtomicBEEF: the validator's raw transaction over our deploy's ancestry. */
export function claimedBeef(p: PreparedPoolDeploy, raw: number[]): { tx: Transaction; beef: number[] } {
  let claimed: Transaction;
  try {
    claimed = Transaction.fromBinary(raw);
  } catch {
    claimed = Transaction.fromBEEF(raw);
  }
  if (!isClaimedDeploy(p.deploy, claimed)) throw new DeployShapeError(`the relay's deploy ${claimed.id("hex")} is not ours (${p.txid}) with a claim appended`);
  for (const [n, input] of claimed.inputs.entries()) input.sourceTransaction = p.deploy.inputs[n]!.sourceTransaction;
  return { tx: claimed, beef: claimed.toAtomicBEEF(true) };
}

/**
 * Accepted: the claimed deploy must be ours with one output appended (the
 * validator's claim); the wallet files the pool output, the token change and
 * the sats change (`internalizeAction`) and drops what the deploy spent from
 * its baskets (`relinquishOutput`: the funding output in `1sat-deposit`, the
 * token inputs in `bsv21`). The funding stays a `nosend` action; the
 * wallet's TaskCheckNoSends finds its proof once the deploy is mined.
 */
export async function completePoolDeploy(wallet: WalletInterface, p: PreparedPoolDeploy, raw?: number[], txid?: string): Promise<CompletedPoolDeploy> {
  if (!raw) throw new DeployShapeError("the relay answered no claimed deploy");
  const { tx, beef } = claimedBeef(p, raw);
  const id = tx.id("hex");
  if (txid && txid !== id) throw new DeployShapeError(`the relay's txid ${txid} is not its transaction's (${id})`);
  const claimVout = tx.outputs.length - 1;
  const out: CompletedPoolDeploy = { txid: id, pool: `${id}_0`, claimVout, internalized: false, relinquished: [], errors: [] };
  const ci = JSON.parse(p.pool.customInstructions) as { amm: Record<string, unknown> };
  ci.amm.claimVout = claimVout;
  const pool = { ...p.pool, customInstructions: JSON.stringify(ci) };
  const outputs: InternalizeOutput[] = [pool, ...(p.tokenChange ? [p.tokenChange] : [])].map((o) => ({
    outputIndex: o.outputIndex,
    protocol: "basket insertion",
    insertionRemittance: { basket: o.basket, tags: o.tags, customInstructions: o.customInstructions },
  }));
  for (const c of p.satsChange) outputs.push({ outputIndex: c.outputIndex, protocol: WALLET_PAYMENT, paymentRemittance: { ...c.remittance } });
  try {
    const r = await wallet.internalizeAction({ tx: beef, outputs, description: "AMM pool deploy", labels: ["amm-pool-deploy"] });
    out.internalized = r.accepted;
  } catch (err) {
    out.errors.push(`internalizeAction: ${err instanceof Error ? err.message : String(err)}`);
  }
  const spent = [{ basket: DEPOSIT_BASKET, output: p.funding.outpoint }, ...p.tokenInputs.map((t) => ({ basket: BSV21_BASKET, output: t.outpoint }))];
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
export async function abandonPoolDeploy(wallet: WalletInterface, p: PreparedPoolDeploy): Promise<void> {
  await wallet.abortAction({ reference: p.funding.reference });
}

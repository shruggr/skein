/**
 * The LP page's pool half: the pool deploy plan against amm-topic's fixture pool deploy, the
 * deploy's wallet sequence (fake BRC-100 wallet: nosend funding, page-built
 * deploy, every input validated with `Spend`) and its relay (amm.pool.submit
 * / amm.pool.status, accepted → internalize + relinquish, refused / timeout
 * → abort), and Close (0.9.0: the fee from the pool
 * or a broadcast funding, page-built close validated against the fixture
 * pool, submit, internalize + relinquish).
 */
import {
  BigNumber,
  Beef,
  ECDSA,
  LockingScript,
  P2PKH,
  PrivateKey,
  PublicKey,
  Spend,
  Transaction,
  UnlockingScript,
  Utils,
  type CreateActionArgs,
  type WalletInterface,
} from "@bsv/sdk";
import { P1SAT_PROTOCOL } from "@1sat/actions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PoolTemplate } from "../src/pool";
import { parseLiveBeats, parseTokenTopic, type SignedFetch } from "../src/lib/overlay";
import { PEER } from "./liveRead";
import {
  POOL_TAG,
  assetIdHex,
  LP_KEY_PROTOCOL,
  isPoolRow,
  legacyLpKeyId,
  lpKeyId,
  changeKeyId,
  planPoolDeploy,
  poolableTokens,
  deployFunding,
  deployTxSize,
  preparePoolDeploy,
  selectDepositInputs,
  tokenP2pkhScript,
  CLAIM_SCRIPT_LENGTH,
  type BasketRow,
} from "../src/lp/poolDeploy";
import { LEGACY_LP_KEY, awaitAdmitted, completeClose, prepareClose, steakText, submitToOverlay } from "../src/lp/close";
import { checkPoolDeployAgain, relayPoolDeploy } from "../src/lp/deployFlow";
import { parsePoolRecord } from "../src/lp/poolRelay";
import { dagBytes, readBytes, type AuthFetchLike } from "../src/market/relay";
import { FUNDING_TAG, spendValid, swapFunding, swapTxSize } from "../src/market/swapAction";
import { BRC29, brc29Side, isBrc29, type KeyArgs } from "./brc29Wallet";
import { tokenInputsOf } from "../src/market/swapAction";
import { buildInventory } from "../src/lp/inventory";
import { loadWalletAssets, mandalaBasket } from "../src/lp/wallet";
import liveRead from "./fixtures/live-read.json";
import v from "./fixtures/amm-topic-vectors.json";

// Keys and transactions of programs/amm-topic/gen/main.go.
const key = (n: number) => new PrivateKey(n.toString(16).padStart(2, "0").repeat(32), 16);
const lpKey = key(10);
const lpNext = key(11);
const pub = (k: PrivateKey) => k.toPublicKey().toString();
const fund = Transaction.fromHex(v.fund);
const tokenDeploy = Transaction.fromHex(v.token_deploy);
const poolDeploy = Transaction.fromHex(v.pool_deploy);
const swap1 = Transaction.fromHex(v.swap_bsv_in);
const swap2 = Transaction.fromHex(v.swap_tokens_in);
const DEPLOY_TXID = tokenDeploy.id("hex");
// The page's token id and the wallet's filings are the same `<txid>_0` (BRC-162 Token identification, David 2026-10-07).
const TOKEN_ID = `${DEPLOY_TXID}_0`;
const SDK_ID = TOKEN_ID;
const P1SAT = P1SAT_PROTOCOL as unknown as [number, string];
const walletRoot = key(50); // the fake wallet's root: identity key and honest BRC-29 derivations

afterEach(() => vi.unstubAllGlobals());

const deployRow: BasketRow = {
  outpoint: `${DEPLOY_TXID}.0`,
  satoshis: 1,
  lockingScript: tokenDeploy.outputs[0]!.lockingScript.toHex(),
  tags: ["bsv21:deploy"],
  customInstructions: JSON.stringify({ amt: "10000000", op: "deploy+mint", protocolID: P1SAT, keyID: "bsv21-deploy-TST-00" }),
};

describe("pool deploy: plan", () => {
  it("the fixture's inputs give the fixture's pool output, byte for byte", () => {
    const { tokens } = poolableTokens([deployRow]);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.tokenId).toBe(TOKEN_ID);
    const sel = selectDepositInputs(tokens[0]!.inputs, 5_000_000n)!;
    expect(sel.change).toBe(4_999_999n); // the deposit and the claim's unit (0.9.0)
    const plan = planPoolDeploy({
      tokenId: TOKEN_ID,
      inputs: sel.inputs,
      tokens: 5_000_000n,
      sats: 1_000_000n,
      lpFeeBps: BigInt(v.lpFeeBps),
      validatorFeeBps: BigInt(v.validatorFeeBps),
      commissionBps: BigInt(v.commissionBps),
      lpPubKey: pub(lpKey),
      validator: { identityKey: v.identity },
    });
    expect(plan.lockingScript).toBe(poolDeploy.outputs[0]!.lockingScript.toHex());
    expect(plan.state.validatorPubKey).toBe(v.pool0.validator);
    expect(plan.validatorKeyId).toBe(`${DEPLOY_TXID}_0`);
    // BRC-29 LP key: prefix base64("amm-lp"), suffix base64("<first input>").
    expect(plan.lpKeyId).toBe(`YW1tLWxw ${Utils.toBase64(Utils.toArray(`${DEPLOY_TXID}_0`, "utf8"))}`);
    expect(legacyLpKeyId(`${DEPLOY_TXID}.0`)).toBe(`amm-lp-${DEPLOY_TXID}_0`);
    expect(plan.args.assetId).toBe(Utils.toHex(tokenDeploy.hash() as number[]));
    expect(plan.topic).toBe(`tm_mandala_${DEPLOY_TXID}_0`);
    expect(plan.price).toBe("0.2");
    expect(PoolTemplate.decode(plan.lockingScript)!.state).toEqual(plan.state);
  });

  it("refusals: legacy id, zero deposits, fees", () => {
    expect(() => assetIdHex(`${DEPLOY_TXID}_1`)).toThrow(/32-byte id/);
    const base = { tokenId: TOKEN_ID, inputs: poolableTokens([deployRow]).tokens[0]!.inputs, tokens: 1n, sats: 1n, lpFeeBps: 30n, validatorFeeBps: 5n, lpPubKey: pub(lpKey), validator: { identityKey: v.identity } };
    expect(() => planPoolDeploy({ ...base, tokens: 0n })).toThrow(/token deposit/);
    expect(() => planPoolDeploy({ ...base, sats: 0n })).toThrow(/sats deposit/);
    expect(() => planPoolDeploy({ ...base, lpFeeBps: 10_000n })).toThrow(/LP fee/);
    expect(() => planPoolDeploy({ ...base, commissionBps: -1n })).toThrow(/commission/);
    expect(() => planPoolDeploy({ ...base, lpFeeBps: 5_000n, commissionBps: 5_000n })).toThrow(/below 100%/);
    // Commission defaults to 0, and is the constructor's param 7.
    expect(planPoolDeploy(base).args.commissionBps).toBe(0n);
    expect(PoolTemplate.decode(planPoolDeploy({ ...base, commissionBps: 25n }).lockingScript)!.args.commissionBps).toBe(25n);
    expect(() => planPoolDeploy({ ...base, tokens: 10_000_000n })).toThrow(/claim's unit/); // one unit is the claim's
    expect(planPoolDeploy({ ...base, tokens: 9_999_999n }).tokenChange).toBe(0n);
  });

  it("deposit selection (0.9.0: the deposit and the claim's one unit): one exact output, else one that covers it, else an exact subset, else cover; null when short", () => {
    const mk = (amount: bigint, n: number) => ({ ...poolableTokens([deployRow]).tokens[0]!.inputs[0]!, amount, outpoint: `${"ab".repeat(32)}.${n}`, vout: n });
    const c = [mk(5n, 0), mk(3n, 1), mk(2n, 2)];
    expect(selectDepositInputs(c, 4n)).toEqual({ inputs: [c[0]], change: 0n });
    expect(selectDepositInputs(c, 1n)).toEqual({ inputs: [c[2]], change: 0n });
    expect(selectDepositInputs(c, 3n)).toEqual({ inputs: [c[0]], change: 1n }); // the smallest single output that covers 4
    expect(selectDepositInputs(c, 7n)).toEqual({ inputs: [c[0], c[1]], change: 0n });
    expect(selectDepositInputs(c, 8n)).toEqual({ inputs: [c[0], c[1], c[2]], change: 1n });
    expect(selectDepositInputs(c, 10n)).toBeNull();
  });

  it("legacy tokens are hidden; pool rows are never token inputs nor balance", () => {
    const legacyId = Array.from({ length: 36 }, (_, i) => i);
    const lock = new P2PKH().lock(lpKey.toAddress()).toHex();
    // Mandala value prefix with a 36-byte id: <push36 id> <push amount 5> OP_2DROP.
    const legacy: BasketRow = { outpoint: `${"cd".repeat(32)}.1`, satoshis: 1, lockingScript: "24" + Utils.toHex(legacyId) + "55" + "6d" + lock, customInstructions: JSON.stringify({ protocolID: P1SAT, keyID: "k" }) };
    const poolRow: BasketRow = {
      outpoint: `${poolDeploy.id("hex")}.0`,
      satoshis: 1_000_000,
      lockingScript: poolDeploy.outputs[0]!.lockingScript.toHex(),
      tags: [`bsv21:${SDK_ID}`, POOL_TAG],
      customInstructions: JSON.stringify({ id: SDK_ID, op: "amm-pool", protocolID: P1SAT, keyID: lpKeyId(`${DEPLOY_TXID}_0`), counterparty: "self" }),
    };
    const r = poolableTokens([deployRow, legacy, poolRow]);
    expect(r.tokens.map((t) => [t.tokenId, t.balance])).toEqual([[TOKEN_ID, 10_000_000n]]);
    expect(r.hidden).toHaveLength(1);
    expect(r.hidden[0]!.reason).toMatch(/32-byte/);
    expect(isPoolRow(poolRow)).toBe(true);
    expect(tokenInputsOf([poolRow], TOKEN_ID)).toEqual([]);
    const inv = buildInventory([poolRow as never]);
    expect(inv.tokens).toEqual([]);
    expect(inv.pools).toEqual([`${poolDeploy.id("hex")}_0`]);
  });
});

/**
 * A fake BRC-100 wallet over the fixture keys. getPublicKey / createSignature:
 * a funding key (`amm-funding-…`) is derived with a real KeyDeriver over
 * `walletRoot` (./brc29Wallet.ts); any other key is the one `keys` names
 * (default lpKey; `honest` derives BRC-29 keys the same real way). The
 * identity key is walletRoot's; internalizeAction checks a wallet payment as
 * wallet-toolbox does. createAction: one input fund:`fundVout` (lpKey's), the
 * requested outputs in order, then a P2PKH change (200 sats of fee); with
 * `signAndProcess: false` it waits for signAction, otherwise it signs and
 * "broadcasts" at once. listOutputs answers the token deploy's BEEF. Records
 * every call.
 */
const side = brc29Side(walletRoot);
/** BRC-29 keys as the wallet derives them; any other request gets `other`. */
const honest = (other: (a: KeyArgs) => PrivateKey = () => key(99)) => (a: KeyArgs) => (isBrc29(a.protocolID) ? side.privateKey(a) : other(a));

function fakeWallet(fundVout: number, keys: (a: KeyArgs) => PrivateKey = () => lpKey) {
  const calls: { method: string; args: unknown }[] = [];
  const keyOf = (a: KeyArgs) => (a.keyID.startsWith("amm-funding-") ? side.privateKey(a) : keys(a));
  let pending: Transaction | undefined;
  const signFunding = async (tx: Transaction) => {
    tx.inputs[0]!.unlockingScript = await new P2PKH().unlock(lpKey).sign(tx, 0);
    return { txid: tx.id("hex"), tx: tx.toAtomicBEEF(true) };
  };
  const w = {
    async getPublicKey(args: KeyArgs & { identityKey?: boolean }) {
      calls.push({ method: "getPublicKey", args });
      if (args.identityKey) return { publicKey: side.identityKey };
      return { publicKey: pub(keyOf(args)) };
    },
    async createSignature(args: KeyArgs & { hashToDirectlySign: number[] }) {
      calls.push({ method: "createSignature", args });
      return { signature: ECDSA.sign(new BigNumber(args.hashToDirectlySign), keyOf(args), true).toDER() as number[] };
    },
    async createAction(args: CreateActionArgs) {
      calls.push({ method: "createAction", args });
      const tx = new Transaction();
      tx.addInput({ sourceTXID: fund.id("hex"), sourceOutputIndex: fundVout, sourceTransaction: fund, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
      for (const o of args.outputs ?? []) tx.addOutput({ satoshis: o.satoshis, lockingScript: LockingScript.fromHex(o.lockingScript) });
      const outSats = tx.outputs.reduce((a, o) => a + o.satoshis!, 0);
      tx.addOutput({ satoshis: fund.outputs[fundVout]!.satoshis! - outSats - 200, lockingScript: new P2PKH().lock(lpKey.toAddress()) });
      if (args.options?.signAndProcess === false) {
        pending = tx;
        return { signableTransaction: { tx: tx.toAtomicBEEF(true), reference: "ref-1" } };
      }
      return signFunding(tx);
    },
    async signAction(args: unknown) {
      calls.push({ method: "signAction", args });
      return signFunding(pending!);
    },
    async listOutputs(args: unknown) {
      calls.push({ method: "listOutputs", args });
      const b = new Beef();
      b.mergeTransaction(tokenDeploy);
      return { totalOutputs: 1, outputs: [], BEEF: b.toBinary() };
    },
    async abortAction(args: unknown) {
      calls.push({ method: "abortAction", args });
      return { aborted: true };
    },
    async relinquishOutput(args: unknown) {
      calls.push({ method: "relinquishOutput", args });
      return { relinquished: true };
    },
    async internalizeAction(args: never) {
      calls.push({ method: "internalizeAction", args });
      return side.internalizeAction(args);
    },
  };
  return { wallet: w as unknown as WalletInterface, calls };
}

function verify(tx: Transaction, i: number): boolean {
  const inp = tx.inputs[i]!;
  const src = inp.sourceTransaction!.outputs[inp.sourceOutputIndex]!;
  return new Spend({
    sourceTXID: inp.sourceTXID!,
    sourceOutputIndex: inp.sourceOutputIndex,
    sourceSatoshis: src.satoshis!,
    lockingScript: src.lockingScript,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.filter((_, j) => j !== i),
    outputs: tx.outputs,
    inputIndex: i,
    unlockingScript: inp.unlockingScript!,
    inputSequence: inp.sequence!,
    lockTime: tx.lockTime,
  }).validate();
}

const RATE = 100;
/** A claim's script: `0x20 <assetId> OP_1 OP_2DROP <72-byte payload> OP_DROP` and P2PKH. */
function claimScript(): LockingScript {
  const t = tokenP2pkhScript(TOKEN_ID, 1n, v.identity);
  return LockingScript.fromHex(t.slice(0, -50) + "48" + "30".repeat(72) + "75" + t.slice(-50));
}
/** Anything else a non-BRC-29 key asks for (none expected). */
const changeKey = key(40);
/** The fixture's LP key answers the deposit's BRC-29 LP keyID and the token deploy's key, so the pool output is the fixture's byte for byte. */
const deployKeys = (a: KeyArgs) =>
  a.keyID === lpKeyId(`${DEPLOY_TXID}_0`) || a.keyID.startsWith("bsv21-deploy") ? lpKey : isBrc29(a.protocolID) ? side.privateKey(a) : changeKey;
const CHANGE_KEY_ID = changeKeyId(`${DEPLOY_TXID}_0`);

async function deployPool(tokens = 5_000_000n, w = fakeWallet(0, deployKeys)) {
  const inputs = poolableTokens([deployRow]).tokens[0]!.inputs;
  const prepared = await preparePoolDeploy({
    wallet: w.wallet,
    form: { tokenId: TOKEN_ID, inputs, tokens, sats: 1_000_000n, lpFeeBps: 30n, validatorFeeBps: 5n, commissionBps: BigInt(v.commissionBps), validator: { identityKey: v.identity } },
    meta: { sym: "TST", dec: 0 },
    satsPerKb: RATE,
    now: 1_000,
  });
  return { ...w, prepared };
}

describe("pool deploy: funding and the deploy transaction", () => {
  it("the wallet sequence: LP key, change key, token BEEF, funding (createAction + signAction, nosend, exact, 1sat-deposit with the hold), every input signed with createSignature", async () => {
    const { calls, prepared } = await deployPool();
    expect(calls.map((c) => c.method)).toEqual([
      "getPublicKey", "getPublicKey", "getPublicKey", "listOutputs", "listOutputs", "getPublicKey", "createAction", "signAction",
      "createSignature", "getPublicKey", "createSignature", "getPublicKey",
    ]);
    expect(calls[0]!.args).toEqual({ protocolID: BRC29, keyID: lpKeyId(`${DEPLOY_TXID}_0`), counterparty: "self", forSelf: true });
    expect(LP_KEY_PROTOCOL).toEqual(BRC29);
    expect(calls[1]!.args).toEqual({ protocolID: BRC29, keyID: CHANGE_KEY_ID, counterparty: "self", forSelf: true });
    expect(calls[2]!.args).toEqual({ identityKey: true });
    // The token's own basket (1sat-sdk's filing), then the page's `bsv21` filings.
    expect(calls[3]!.args).toEqual({ basket: `mandala ${DEPLOY_TXID} 0`, include: "entire transactions", limit: 10000 });
    expect(calls[4]!.args).toEqual({ basket: "bsv21", tags: [`bsv21:${SDK_ID}`, "bsv21:deploy"], tagQueryMode: "any", include: "entire transactions", limit: 10000 });
    const keyID = (calls[5]!.args as { keyID: string }).keyID;
    expect(keyID).toMatch(/^amm-funding-[0-9a-f]{16}$/);
    const fundingScript = new P2PKH().lock(side.privateKey({ protocolID: P1SAT as never, keyID }).toAddress()).toHex();
    const expires = 1_000 + 120_000;
    const f = prepared.funding;
    expect(calls[6]!.args).toEqual({
      description: "AMM pool deploy funding: TST",
      labels: ["amm-pool-deploy"],
      outputs: [
        {
          lockingScript: fundingScript,
          satoshis: f.satoshis,
          outputDescription: "AMM pool deploy funding: TST",
          basket: "1sat-deposit",
          tags: [FUNDING_TAG, `hold:${expires}`],
          customInstructions: JSON.stringify({ protocolID: P1SAT, keyID, counterparty: "self", amm: { deploy: SDK_ID, expires } }),
        },
      ],
      options: { signAndProcess: false, randomizeOutputs: false, noSend: true },
    });
    expect(calls[7]!.args).toEqual({ reference: "ref-1", spends: {}, options: { noSend: true } });
    expect(calls[8]!.args).toMatchObject({ keyID: "bsv21-deploy-TST-00" });
    expect(calls[10]!.args).toMatchObject({ protocolID: P1SAT, keyID, counterparty: "self" });
    expect(prepared.expires).toBe(expires);
    expect(prepared.validator).toBe(v.identity);
  });

  it("the deploy (0.9.0): [token input, funding] → [pool (the fixture's, byte for byte), token change], each input SIGHASH_SINGLE|FORKID over its own output; one unit left for the claim; the funding exact with the claim's sat and bytes", async () => {
    const { prepared } = await deployPool();
    const d = prepared.deploy;
    expect(d.inputs.map((i) => `${i.sourceTXID}.${i.sourceOutputIndex}`)).toEqual([`${DEPLOY_TXID}.0`, prepared.funding.outpoint]);
    expect(d.outputs).toHaveLength(2);
    expect(d.outputs[0]!.lockingScript.toHex()).toBe(poolDeploy.outputs[0]!.lockingScript.toHex());
    expect(d.outputs[0]!.satoshis).toBe(1_000_000);
    const changeFiling = prepared.tokenChange!;
    const changeCi = JSON.parse(changeFiling.customInstructions);
    expect(changeCi).toMatchObject({ protocolID: BRC29, keyID: CHANGE_KEY_ID, counterparty: "self" });
    expect(d.outputs[1]!.lockingScript.toHex()).toBe(tokenP2pkhScript(TOKEN_ID, 4_999_999n, pub(side.privateKey({ protocolID: BRC29, keyID: CHANGE_KEY_ID } as KeyArgs))));
    expect(d.outputs[1]!.satoshis).toBe(1);
    expect(prepared.satsChange).toEqual([]);
    d.inputs.forEach((inp, i) => {
      expect(verify(d, i)).toBe(true);
      expect(spendValid(d, i)).toBe(true);
      const sig = inp.unlockingScript!.chunks[0]!.data!;
      expect(sig[sig.length - 1]).toBe(0x43); // SIGHASH_SINGLE|FORKID
    });
    // An output appended after the pair (the validator's claim) leaves every signature valid.
    const claimed = Transaction.fromBinary(d.toBinary());
    claimed.inputs.forEach((inp, i) => (inp.sourceTransaction = d.inputs[i]!.sourceTransaction));
    claimed.addOutput({ satoshis: 1, lockingScript: claimScript() });
    claimed.inputs.forEach((_, i) => expect(verify(claimed, i)).toBe(true));
    // Exact: the outputs (1,000,000 + 1) and the claim's sat − the token input's 1 sat, plus the fee over the deploy with the claim.
    const f = prepared.funding;
    expect(f.outputs).toBe(1_000_001);
    expect(f.size).toBe(deployTxSize([...d.outputs.map((o) => ({ script: o.lockingScript.toHex() })), { script: "00".repeat(CLAIM_SCRIPT_LENGTH) }], 2));
    expect(f.fee).toBe(Math.ceil((f.size * RATE) / 1000));
    expect(f.satoshis).toBe(1_000_001 + f.fee);
    const ins = d.inputs.reduce((a, i) => a + i.sourceTransaction!.outputs[i.sourceOutputIndex]!.satoshis!, 0);
    expect(ins - d.outputs.reduce((a, o) => a + o.satoshis!, 0)).toBe(f.fee + 1);
    expect(claimed.toBinary().length).toBeLessThanOrEqual(f.size);
    expect(f.size - claimed.toBinary().length).toBeLessThan(20);
    // The deploy's AtomicBEEF carries the funding and the token input's source.
    const b = Beef.fromBinary(prepared.atomicBeef);
    expect(b.atomicTxid).toBe(prepared.txid);
    expect(b.findTxid(prepared.funding.txid)).toBeDefined();
    expect(b.findTxid(DEPLOY_TXID)).toBeDefined();
    // Filing of the pool output: bsv21, amm-pool, the LP key, no amt.
    expect(prepared.pool).toMatchObject({ outputIndex: 0, basket: "bsv21", tags: [`bsv21:${SDK_ID}`, "amm-pool"] });
    const ci = JSON.parse(prepared.pool.customInstructions);
    expect(ci).toEqual({
      id: SDK_ID,
      op: "amm-pool",
      sym: "TST",
      dec: "0",
      protocolID: BRC29,
      keyID: lpKeyId(`${DEPLOY_TXID}_0`),
      counterparty: "self",
      amm: { role: "lp", validatorIdentity: v.identity, lpFeeBps: "30", validatorFeeBps: "5", commissionBps: "10" },
    });
    expect(ci.amt).toBeUndefined();
    expect(JSON.parse(changeFiling.customInstructions)).toMatchObject({ id: SDK_ID, amt: "4999999", op: "transfer" });
  });

  it("the token change is locked to the key derived from input 0 (BRC-29, prefix amm-change), never a random one", async () => {
    const rand = vi.spyOn(crypto, "getRandomValues");
    const a = await deployPool();
    const b = await deployPool();
    // getRandomValues is the funding key's only use (amm-funding-<hex>): one per deploy.
    expect(rand).toHaveBeenCalledTimes(2);
    rand.mockRestore();
    const derived = side.privateKey({ protocolID: BRC29, keyID: CHANGE_KEY_ID } as KeyArgs);
    const lock = tokenP2pkhScript(TOKEN_ID, 4_999_999n, pub(derived));
    for (const { prepared } of [a, b]) {
      expect(prepared.deploy.outputs[1]!.lockingScript.toHex()).toBe(lock);
      expect(JSON.parse(prepared.tokenChange!.customInstructions)).toMatchObject({ protocolID: BRC29, keyID: CHANGE_KEY_ID, counterparty: "self" });
    }
    // P2PKH to Hash160 of the derived key: the wallet can spend it.
    expect(lock.endsWith(new P2PKH().lock(derived.toAddress()).toHex())).toBe(true);
    expect(CHANGE_KEY_ID).not.toBe(lpKeyId(`${DEPLOY_TXID}_0`));
  });

  it("an exact deposit (the input carries the deposit and the claim's unit) has no token change: the funding's input is paired with a 1-sat sats change, a BRC-29 payment to self", async () => {
    const { prepared, calls } = await deployPool(9_999_999n);
    expect(prepared.tokenChange).toBeNull();
    expect(prepared.deploy.outputs).toHaveLength(2);
    const changePub = pub(side.privateKey({ protocolID: BRC29, keyID: CHANGE_KEY_ID } as KeyArgs));
    expect(prepared.deploy.outputs[1]!.lockingScript.toHex()).toBe(new P2PKH().lock(PrivateKey.fromString(side.privateKey({ protocolID: BRC29, keyID: CHANGE_KEY_ID } as KeyArgs).toString()).toAddress()).toHex());
    expect(prepared.satsChange).toEqual([{ outputIndex: 1, satoshis: 1, remittance: { derivationPrefix: "YW1tLWNoYW5nZQ==", derivationSuffix: Utils.toBase64(Utils.toArray(`${DEPLOY_TXID}_0`, "utf8")), senderIdentityKey: side.identityKey } }]);
    expect(changePub).toMatch(/^0[23]/);
    expect(prepared.funding.outputs).toBe(1_000_001);
    // LP key, funding key, and one per signature: no change key.
    expect(calls.filter((c) => c.method === "getPublicKey").map((c) => (c.args as { keyID?: string }).keyID).some((k) => k?.startsWith(`${SDK_ID}-`))).toBe(false);
    prepared.deploy.inputs.forEach((_, i) => expect(verify(prepared.deploy, i)).toBe(true));
    expect(deployFunding([{ satoshis: 10, script: "00" }], [{ satoshis: 1 }], 0).satoshis).toBe(10); // 10 out + the claim's sat − the token input's sat
  });

  it("a wallet that moves the funding output: refused, the funding action aborted", async () => {
    const w = fakeWallet(0, deployKeys);
    const ww = w.wallet as unknown as { createAction: (a: CreateActionArgs) => Promise<unknown> };
    const orig = ww.createAction.bind(ww);
    ww.createAction = (a) => orig({ ...a, outputs: [{ ...a.outputs![0]!, satoshis: a.outputs![0]!.satoshis + 1 }] });
    await expect(deployPool(5_000_000n, w)).rejects.toThrow(/funding output/);
    expect(w.calls.at(-1)).toEqual({ method: "abortAction", args: { reference: "ref-1" } });
  });
});

// ---------------------------------------------------------------------------
// The deploy's relay
// ---------------------------------------------------------------------------

const ID = "deploy-1";
function fakeRelay(answer: (fn: string, args: Record<string, unknown>, n: number) => { status: number; body: unknown }) {
  const calls: { url: string; method?: string; body: { fn: string; args: Record<string, unknown> } }[] = [];
  const af: AuthFetchLike = {
    async fetch(url, config) {
      const body = JSON.parse(config!.body!);
      calls.push({ url, method: config?.method, body });
      const a = answer(body.fn, body.args, calls.length);
      return { status: a.status, text: async () => JSON.stringify(a.body) };
    },
  };
  return { af, calls };
}
const ok = (fn: string, result: unknown) => ({ status: 200, body: { fn, result } });
/** The deploy with a claim appended (its shape: one unit, a 72-byte payload, P2PKH; the page checks the shape, the validator signs the claim). */
function claim(d: Transaction): Transaction {
  const c = Transaction.fromBinary(d.toBinary());
  c.addOutput({ satoshis: 1, lockingScript: claimScript() });
  return c;
}
const noSleep = async () => undefined;

describe("pool deploy: amm.pool.submit / amm.pool.status", () => {
  it("submits {funding, deploy, validator, expires} as DAG-JSON bytes, polls while pending; accepted: internalize the pool and the change, relinquish the funding and the token input", async () => {
    const { wallet, calls, prepared } = await deployPool();
    const claimed = claim(prepared.deploy);
    const { af, calls: http } = fakeRelay((fn, _a, n) =>
      fn === "amm.pool.submit" || n < 3 ? ok(fn, { id: ID, status: "pending" }) : ok(fn, { id: ID, status: "accepted", tx: dagBytes(claimed.toBinary()), txid: claimed.id("hex") }),
    );
    const before = calls.length;
    const seen: string[] = [];
    const o = await relayPoolDeploy({ wallet, authFetch: af, base: "http://amm2.localhost:8300/amm", sleep: noSleep, now: () => 0, onRecord: (r) => seen.push(r.status) }, prepared, PEER);
    expect(http.map((c) => [c.url, c.method, c.body.fn])).toEqual([
      ["http://amm2.localhost:8300/amm/call", "POST", "amm.pool.submit"],
      ["http://amm2.localhost:8300/amm/call", "POST", "amm.pool.status"],
      ["http://amm2.localhost:8300/amm/call", "POST", "amm.pool.status"],
    ]);
    expect(http[0]!.body.args).toEqual({
      funding: dagBytes(prepared.funding.atomicBeef),
      deploy: dagBytes(prepared.atomicBeef),
      validator: dagBytes(Utils.toArray(v.identity, "hex")),
      peerId: PEER,
      expires: 121_000,
    });
    expect(Beef.fromBinary(readBytes(http[0]!.body.args.funding)!).atomicTxid).toBe(prepared.funding.txid);
    expect(Beef.fromBinary(readBytes(http[0]!.body.args.deploy)!).atomicTxid).toBe(prepared.txid);
    expect(http[1]!.body.args).toEqual({ id: ID });
    expect(seen).toEqual(["pending", "pending", "accepted"]);

    const ctxid = claimed.id("hex");
    expect(o).toEqual({ status: "accepted", id: ID, txid: ctxid, completed: { txid: ctxid, pool: `${ctxid}_0`, claimVout: 2, internalized: true, relinquished: [prepared.funding.outpoint, `${DEPLOY_TXID}.0`], errors: [] } });
    const after = calls.slice(before);
    expect(after.map((c) => c.method)).toEqual(["internalizeAction", "relinquishOutput", "relinquishOutput"]);
    const ia = after[0]!.args as { tx: number[]; outputs: unknown[]; labels: string[] };
    expect(Beef.fromBinary(ia.tx).atomicTxid).toBe(ctxid);
    const poolCi = JSON.parse(prepared.pool.customInstructions);
    poolCi.amm.claimVout = 2;
    expect(ia.outputs).toEqual([
      { outputIndex: 0, protocol: "basket insertion", insertionRemittance: { basket: "bsv21", tags: [`bsv21:${SDK_ID}`, "amm-pool"], customInstructions: JSON.stringify(poolCi) } },
      { outputIndex: 1, protocol: "basket insertion", insertionRemittance: { basket: "bsv21", tags: [`bsv21:${SDK_ID}`], customInstructions: prepared.tokenChange!.customInstructions } },
    ]);
    expect(ia.labels).toEqual(["amm-pool-deploy"]);
    expect(after[1]!.args).toEqual({ basket: "1sat-deposit", output: prepared.funding.outpoint });
    expect(after[2]!.args).toEqual({ basket: "bsv21", output: `${DEPLOY_TXID}.0` });
    expect(calls.some((c) => c.method === "abortAction")).toBe(false);
  });

  it("accepted without the claimed deploy, with the deploy unclaimed, or another transaction: not filed (unknown), the wallet not asked", async () => {
    type Deployed = Awaited<ReturnType<typeof deployPool>>;
    for (const answer of [
      (_p: Deployed) => ({ id: ID, status: "accepted" }),
      (p: Deployed) => ({ id: ID, status: "accepted", tx: dagBytes(p.prepared.deploy.toBinary()) }),
      (p: Deployed) => ({ id: ID, status: "accepted", tx: dagBytes(claim(claim(p.prepared.deploy)).toBinary()) }),
      (p: Deployed) => ({ id: ID, status: "accepted", tx: dagBytes(claim(p.prepared.deploy).toBinary()), txid: "ab".repeat(32) }),
    ]) {
      const a = await deployPool();
      const r = fakeRelay((fn) => ok(fn, answer(a)));
      const o = await relayPoolDeploy({ wallet: a.wallet, authFetch: r.af, base: "http://x/amm", sleep: noSleep }, a.prepared, PEER);
      expect(o).toMatchObject({ status: "unknown", id: ID });
      expect(a.calls.some((c) => c.method === "internalizeAction")).toBe(false);
    }
  });

  it("refused: abortAction of the funding, nothing internalized", async () => {
    const { wallet, calls, prepared } = await deployPool();
    const { af } = fakeRelay((fn) => ok(fn, { id: ID, status: "refused", reason: "fees_unacceptable", detail: "commissionBps" }));
    expect(await relayPoolDeploy({ wallet, authFetch: af, base: "http://x/amm", sleep: noSleep }, prepared, PEER)).toEqual({ status: "refused", id: ID, reason: "fees_unacceptable: commissionBps" });
    expect(calls.at(-1)).toEqual({ method: "abortAction", args: { reference: "ref-1" } });
    expect(calls.some((c) => c.method === "internalizeAction" || c.method === "relinquishOutput")).toBe(false);
  });

  it("timeout: abortAction; an error answer to submit (no amm.pool.submit on the instance): abortAction", async () => {
    const a = await deployPool();
    const t = fakeRelay((fn, _a, n) => ok(fn, { id: ID, status: n === 1 ? "pending" : "timeout" }));
    expect(await relayPoolDeploy({ wallet: a.wallet, authFetch: t.af, base: "http://x/amm", sleep: noSleep, now: () => 0 }, a.prepared, PEER)).toEqual({ status: "timeout", id: ID });
    expect(a.calls.at(-1)).toEqual({ method: "abortAction", args: { reference: "ref-1" } });

    const b = await deployPool();
    const e = fakeRelay((fn) => ({ status: 404, body: { fn, error: { code: "unknown-fn", message: "amm.pool.submit is not provided" } } }));
    expect(await relayPoolDeploy({ wallet: b.wallet, authFetch: e.af, base: "http://x/amm", sleep: noSleep }, b.prepared, PEER)).toEqual({ status: "failed", reason: "amm.pool.submit: unknown-fn: amm.pool.submit is not provided" });
    expect(b.calls.at(-1)).toEqual({ method: "abortAction", args: { reference: "ref-1" } });
  });

  it("no answer (network, the relay's transport failure, pending past expiry): nothing aborted; Check again settles it", async () => {
    const { wallet, calls, prepared } = await deployPool();
    const lost: AuthFetchLike = { fetch: async () => { throw new Error("network down"); } };
    expect(await relayPoolDeploy({ wallet, authFetch: lost, base: "http://x/amm" }, prepared, PEER)).toEqual({ status: "unknown", reason: "amm.pool.submit: network down" });
    const failed = fakeRelay((fn) => ok(fn, { id: ID, status: "failed", reason: "dial" }));
    expect(await relayPoolDeploy({ wallet, authFetch: failed.af, base: "http://x/amm", sleep: noSleep }, prepared, PEER)).toEqual({ status: "unknown", id: ID, reason: "the relay could not reach the validator (dial)" });
    let t = 0;
    const pending = fakeRelay((fn) => ok(fn, { id: ID, status: "pending" }));
    expect(await relayPoolDeploy({ wallet, authFetch: pending.af, base: "http://x/amm", sleep: async () => void (t += 60_000), now: () => t }, prepared, PEER)).toEqual({ status: "unknown", id: ID, reason: "still pending past the deploy's expiry" });
    expect(calls.some((c) => c.method === "abortAction")).toBe(false);
    const c = claim(prepared.deploy);
    const later = fakeRelay((fn) => ok(fn, { id: ID, status: "accepted", tx: dagBytes(c.toBinary()), txid: c.id("hex") }));
    expect(await checkPoolDeployAgain({ wallet, authFetch: later.af, base: "http://x/amm" }, prepared, ID)).toMatchObject({ status: "accepted", txid: c.id("hex") });
    expect(() => parsePoolRecord({ id: ID, status: "bogus" })).toThrow(/unknown deploy status/);
    expect(parsePoolRecord({ id: ID, status: "accepted", tx: "0aff" })).toEqual({ id: ID, status: "accepted", tx: [10, 255] });
  });
});

// ---------------------------------------------------------------------------
// My pools
// ---------------------------------------------------------------------------

/** AtomicBEEF of `tx` carrying `ancestors`. */
function atomic(tx: Transaction, ancestors: Transaction[]): number[] {
  const b = new Beef();
  for (const a of ancestors) b.mergeRawTx(a.toBinary());
  b.mergeRawTx(tx.toBinary());
  return b.toBinaryAtomic(tx.id("hex"));
}

// ---------------------------------------------------------------------------
// Close (0.9.0)
// ---------------------------------------------------------------------------

describe("close: the whole pool to the LP, the fee from the pool or a broadcast funding; submit, internalize, relinquish", () => {
  // A pool like the fixture's after swap2, whose LP key is the wallet's BRC-29 LP key for some deposit outpoint.
  const depositOp = `${"33".repeat(32)}_0`;
  const lpRef = { protocolID: BRC29 as never, keyID: lpKeyId(depositOp), counterparty: "self" };
  const lpPub = side.publicKey({ ...lpRef, forSelf: true });
  const base = PoolTemplate.decode(swap2.outputs[0]!.lockingScript)!;
  const poolTx = new Transaction();
  poolTx.addInput({ sourceTXID: "44".repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
  poolTx.addOutput({ satoshis: swap2.outputs[0]!.satoshis!, lockingScript: PoolTemplate.lockContinuation(base, { ...base.state, lpPubKey: lpPub }) });
  const poolOutput = () => ({ beef: atomic(poolTx, []), outputIndex: 0 });
  const sats = BigInt(poolTx.outputs[0]!.satoshis!);
  const [derivationPrefix, derivationSuffix] = lpRef.keyID.split(" ") as [string, string];

  it("bsvFee 0: a funding output broadcast by the wallet (no noSend, exact: the token output's sat + fee); [pool, funding] → [every sat, every token] to the LP key; both inputs validate; completeClose files both and relinquishes the funding and the pool row", async () => {
    const { wallet, calls } = fakeWallet(3, honest());
    const s = await prepareClose({ wallet, tokenId: TOKEN_ID, meta: { sym: "TST", dec: 0 }, poolOutput: poolOutput(), lpKey: lpRef, bsvFee: 0n, satsPerKb: RATE, now: 1_000 });
    expect(calls.map((c) => c.method)).toEqual(["getPublicKey", "getPublicKey", "getPublicKey", "createAction", "createSignature", "createSignature", "getPublicKey"]);
    const create = calls.find((c) => c.method === "createAction")!.args as CreateActionArgs;
    expect(create.options).toEqual({ randomizeOutputs: false, acceptDelayedBroadcast: false });
    expect(JSON.parse(create.outputs![0]!.customInstructions!).amm).toEqual({ close: `${poolTx.id("hex")}_0`, expires: 121_000 });
    const f = s.funding!;
    expect(f.outputs).toBe(1);
    expect(f.satoshis).toBe(1 + f.fee);
    const tx = s.tx;
    expect(tx.inputs.map((i) => `${i.sourceTXID}.${i.sourceOutputIndex}`)).toEqual([`${poolTx.id("hex")}.0`, f.outpoint]);
    expect(tx.outputs.map((o) => o.satoshis)).toEqual([Number(sats), 1]);
    expect(tx.outputs[0]!.lockingScript.toHex()).toBe(new P2PKH().lock(PublicKey.fromString(lpPub).toAddress()).toHex());
    for (const i of [0, 1]) expect(verify(tx, i)).toBe(true);
    const ins = tx.inputs.reduce((a, i) => a + i.sourceTransaction!.outputs[i.sourceOutputIndex]!.satoshis!, 0);
    expect(ins - tx.outputs.reduce((a, o) => a + o.satoshis!, 0)).toBe(f.fee);
    expect(s.sats).toBe(sats);
    expect(s.tokenAmount).toBe(base.state.tokenReserve);
    expect(s.payout).toEqual({ outputIndex: 0, satoshis: Number(sats), lockingScript: tx.outputs[0]!.lockingScript.toHex(), remittance: { derivationPrefix, derivationSuffix, senderIdentityKey: side.identityKey } });
    expect(JSON.parse(s.tokens.customInstructions)).toMatchObject({ id: SDK_ID, amt: String(base.state.tokenReserve), op: "transfer", protocolID: BRC29, keyID: lpRef.keyID });
    expect(s.topic).toBe(`tm_mandala_${DEPLOY_TXID}_0`);

    const before = calls.length;
    const c = await completeClose(wallet, s, `${DEPLOY_TXID}.0`);
    expect(c).toEqual({ internalized: true, relinquished: [f.outpoint, `${DEPLOY_TXID}.0`], errors: [] });
    const after = calls.slice(before);
    expect(after.map((x) => x.method)).toEqual(["internalizeAction", "relinquishOutput", "relinquishOutput"]);
    const ia = after[0]!.args as { tx: number[]; outputs: unknown[]; labels: string[] };
    expect(ia.tx).toEqual(s.beef);
    expect(ia.labels).toEqual(["amm-close"]);
    expect(ia.outputs).toEqual([
      { outputIndex: 0, protocol: "wallet payment", paymentRemittance: s.payout!.remittance },
      { outputIndex: 1, protocol: "basket insertion", insertionRemittance: { basket: "bsv21", tags: [`bsv21:${SDK_ID}`], customInstructions: s.tokens.customInstructions } },
    ]);
  });

  it("bsvFee > 0: no funding (the wallet makes no action); [pool] → [sats − bsvFee, every token]; validates; a fee too small for the miner and the token's sat, or over the pool, is refused", async () => {
    const { wallet, calls } = fakeWallet(3, honest());
    const s = await prepareClose({ wallet, tokenId: TOKEN_ID, poolOutput: poolOutput(), lpKey: lpRef, bsvFee: 1_000n, satsPerKb: RATE });
    expect(s.funding).toBeNull();
    expect(calls.some((c) => c.method === "createAction")).toBe(false);
    expect(s.tx.inputs).toHaveLength(1);
    expect(s.tx.outputs.map((o) => o.satoshis)).toEqual([Number(sats) - 1_000, 1]);
    expect(verify(s.tx, 0)).toBe(true);
    await expect(prepareClose({ wallet, tokenId: TOKEN_ID, poolOutput: poolOutput(), lpKey: lpRef, bsvFee: 2n, satsPerKb: RATE })).rejects.toThrow(/at least/);
    await expect(prepareClose({ wallet, tokenId: TOKEN_ID, poolOutput: poolOutput(), lpKey: lpRef, bsvFee: sats + 1n, satsPerKb: RATE })).rejects.toThrow(/0 to the pool's/);
    // bsvFee = every sat: the tokens only, no wallet payment.
    const all = await prepareClose({ wallet, tokenId: TOKEN_ID, poolOutput: poolOutput(), lpKey: lpRef, bsvFee: sats, satsPerKb: RATE });
    expect(all.payout).toBeNull();
    expect(all.tx.outputs).toHaveLength(1);
    expect(all.tokens.outputIndex).toBe(0);
  });

  it("refuses a wallet key that is not the pool's LP key, and a pre-BRC-29 LP key with a payout, before any funding", async () => {
    const a = fakeWallet(3, () => key(99));
    await expect(prepareClose({ wallet: a.wallet, tokenId: TOKEN_ID, poolOutput: poolOutput(), lpKey: { protocolID: P1SAT as never, keyID: "x", counterparty: "self" }, bsvFee: sats, satsPerKb: RATE })).rejects.toThrow(/not this pool's LP key/);
    expect(a.calls.some((c) => c.method === "createAction")).toBe(false);
    const b = fakeWallet(3);
    await expect(prepareClose({ wallet: b.wallet, tokenId: TOKEN_ID, poolOutput: poolOutput(), lpKey: { protocolID: P1SAT as never, keyID: "lp", counterparty: "self" }, bsvFee: 0n, satsPerKb: RATE })).rejects.toThrow(LEGACY_LP_KEY);
    expect(b.calls).toEqual([]);
  });

  it("the submit (BRC-22, plain fetch): the STEAK, or nothing decided (503); awaitAdmitted asks ls_mandala", async () => {
    const { wallet } = fakeWallet(3, honest());
    const s = await prepareClose({ wallet, tokenId: TOKEN_ID, poolOutput: poolOutput(), lpKey: lpRef, bsvFee: 1_000n, satsPerKb: RATE });
    const STEAK = { [s.topic]: { outputsToAdmit: [1], coinsToRetain: [], coinsRemoved: [0] } };
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      if (url.endsWith("/submit")) return new Response(JSON.stringify(STEAK), { status: 200 });
      const q = JSON.parse(init.body as string) as { service: string; query: { txid: string; outputIndex: number } };
      const found = q.service === "ls_mandala" && q.query.txid === s.txid && seen.length > 2;
      return new Response(JSON.stringify({ type: "output-list", outputs: found ? [{ beef: [], outputIndex: q.query.outputIndex }] : [] }), { status: 200 });
    }) as unknown as SignedFetch["fetch"];
    const r = await submitToOverlay("http://x/amm", s.topic, s.beef, fetchFn as never);
    expect(seen[0]!.url).toBe("http://x/amm/submit");
    expect(seen[0]!.init.headers).toEqual({ "content-type": "application/octet-stream", "x-topics": s.topic });
    expect(r).toEqual({ steak: STEAK });
    expect(steakText(r)).toBe(`admitted under ${s.topic} (outputs 1)`);
    const later = (async () => new Response('{"status":"error"}', { status: 503 })) as unknown as SignedFetch["fetch"];
    expect(await submitToOverlay("http://x/amm", s.topic, s.beef, later as never)).toEqual({});
    expect(await awaitAdmitted({ fetch: fetchFn }, "http://x/amm", s.txid, 1, { intervalMs: 1 })).toBe(true);
  });
});

describe("token rows: the token's own basket (1sat-sdk's Mandala filing) and bsv21", () => {
  it("loadWalletAssets lists every `mandala <txid> <vout>` basket named by a `mandala`-labelled action; a fresh Mandala deploy is poolable", async () => {
    const asked: unknown[] = [];
    const ownRow = { ...deployRow, outpoint: `${DEPLOY_TXID}.0` };
    const wallet = {
      async listActions(args: unknown) {
        asked.push(args);
        return { totalActions: 1, actions: [{ labels: ["mandala", `mandala ${DEPLOY_TXID} 0`, "other"] }] };
      },
      async listOutputs(args: { basket: string }) {
        asked.push(args);
        return { totalOutputs: 0, outputs: args.basket === `mandala ${DEPLOY_TXID} 0` ? [ownRow] : [] };
      },
    } as never;
    const assets = await loadWalletAssets(wallet);
    expect(asked).toContainEqual({ labels: ["mandala"], includeLabels: true, limit: 10000 });
    expect(asked).toContainEqual({ basket: `mandala ${DEPLOY_TXID} 0`, include: "locking scripts", includeTags: true, includeCustomInstructions: true, limit: 10000 });
    expect(assets.tokenRows).toEqual([ownRow]);
    expect(poolableTokens(assets.tokenRows).tokens.map((t) => t.tokenId)).toEqual([TOKEN_ID]);
    expect(mandalaBasket(TOKEN_ID)).toBe(`mandala ${DEPLOY_TXID} 0`);
  });
});

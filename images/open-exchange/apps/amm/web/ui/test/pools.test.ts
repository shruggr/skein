/**
 * The LP page's pool half: the validator picker's BRC-169 resolver (fake
 * fetch), the pool deploy plan against amm-topic's fixture pool deploy, the
 * deploy's wallet sequence (fake BRC-100 wallet: nosend funding, page-built
 * deploy, every input validated with `Spend`) and its relay (amm.pool.submit
 * / amm.pool.status, accepted → internalize + relinquish, refused / timeout
 * → abort), "my pools" matching, and RemoveLiquidity (broadcast funding,
 * page-built remove validated against the fixture pool, submit, internalize
 * + relinquish).
 */
import {
  BigNumber,
  Beef,
  ECDSA,
  LockingScript,
  P2PKH,
  PrivateKey,
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
import { choiceFor, livenessOf, originOf, parseIdentityKey, parsePickerInput, resolveHandle, type FetchLike } from "../src/lp/validators";
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
  type BasketRow,
} from "../src/lp/poolDeploy";
import { findMyPools, historyKeys, historyOutpoints, matchPool, poolRowsOf } from "../src/lp/myPools";
import { LEGACY_LP_KEY, admittedOutput, awaitAdmitted, completeRemoveLiquidity, pendingRemovePayout, prepareRemoveLiquidity, steakText, submitToOverlay } from "../src/lp/removeLiquidity";
import { checkPoolDeployAgain, relayPoolDeploy } from "../src/lp/deployFlow";
import { parsePoolRecord } from "../src/lp/poolRelay";
import { dagBytes, readBytes, type AuthFetchLike } from "../src/market/relay";
import { FUNDING_TAG, spendValid, swapFunding, swapTxSize } from "../src/market/swapAction";
import { PendingPayoutStore, internalizeNow, type KV } from "../src/wallet/pendingPayouts";
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

// ---------------------------------------------------------------------------
// Validator picker
// ---------------------------------------------------------------------------

function fakeFetch(routes: Record<string, unknown>, calls: string[] = []): FetchLike {
  return async (url: string) => {
    calls.push(url);
    const body = routes[url];
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}), text: async () => "no route" };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
}

const AMM3 = "03cdee31ef0446ffb95aeae00353d9ab4c26a8555d597a9930b0ddd4f4cc1ae0d0";
const AMM2 = "02f2607898feca297bec05cc510475ff896fb3e9a1d3c0528f6ce2c4382eff472a";

describe("validator picker: BRC-169 resolver", () => {
  it("manifest → resolve endpoint → handle (the answers recorded from skein's router on :8400)", async () => {
    const calls: string[] = [];
    const f = fakeFetch(
      {
        "http://localhost:8400/manifest.json": { metanet: { handles: { resolve: "http://127.0.0.1:8400/.well-known/metanet-handles/resolve" } } },
        "http://127.0.0.1:8400/.well-known/metanet-handles/resolve?handle=amm3%40localhost": {
          handle: "amm3",
          domain: "localhost",
          identityKey: AMM3,
          messagebox: "http://amm3.localhost:8400",
        },
      },
      calls,
    );
    const r = await resolveHandle("amm3", "localhost:8400", f);
    expect(calls).toEqual([
      "http://localhost:8400/manifest.json",
      "http://127.0.0.1:8400/.well-known/metanet-handles/resolve?handle=amm3%40localhost",
    ]);
    expect(r).toMatchObject({ handle: "amm3@localhost:8400", identityKey: AMM3, messagebox: "http://amm3.localhost:8400" });
    const live = parseLiveBeats(liveRead, 1790844766808);
    expect(choiceFor(r.identityKey, live, r.handle)).toEqual({ identityKey: AMM3, peerId: PEER, handle: "amm3@localhost:8400" });
    expect(livenessOf(AMM3, live)).toBe("live");
  });

  it("default resolve path when the manifest names none; https for a public domain", async () => {
    const f = fakeFetch({
      "https://example.com/manifest.json": {},
      "https://example.com/.well-known/metanet-handles/resolve?handle=val%40example.com": { identityKey: AMM2.toUpperCase().replace("0X", "") },
    });
    const r = await resolveHandle("val", "example.com", f);
    expect(r.identityKey).toBe(AMM2);
    expect(r.resolveUrl).toBe("https://example.com/.well-known/metanet-handles/resolve");
    // amm2's key is not in this instance's liveness read: still choosable, "not seen live" (no peer ID to name).
    const live = parseLiveBeats(liveRead, 1790844766808);
    expect(choiceFor(AMM2, live, r.handle)).toEqual({ identityKey: AMM2, handle: "val@example.com" });
    expect(livenessOf(AMM2, live)).toBe("not seen live");
  });

  it("refusals: no manifest, unknown handle, an answer for another handle, a bad key", async () => {
    await expect(resolveHandle("x", "localhost:1", fakeFetch({}))).rejects.toThrow(/manifest.json: 404/);
    const base = { "http://localhost:2/manifest.json": {} };
    await expect(resolveHandle("x", "localhost:2", fakeFetch(base))).rejects.toThrow(/resolve\?handle=x%40localhost: 404/);
    const url = "http://localhost:2/.well-known/metanet-handles/resolve?handle=x%40localhost";
    await expect(resolveHandle("x", "localhost:2", fakeFetch({ ...base, [url]: { handle: "y", identityKey: AMM3 } }))).rejects.toThrow(/answered for y/);
    await expect(resolveHandle("x", "localhost:2", fakeFetch({ ...base, [url]: { identityKey: "02zz" } }))).rejects.toThrow(/no valid identityKey/);
  });

  it("input: a key, a handle, or neither; origins", () => {
    expect(parsePickerInput(` ${AMM3.toUpperCase()} `)).toEqual({ kind: "key", identityKey: AMM3 });
    expect(parsePickerInput("amm2@localhost:8300")).toEqual({ kind: "handle", name: "amm2", domain: "localhost:8300" });
    expect(parsePickerInput("amm2").kind).toBe("invalid");
    expect(parseIdentityKey("04" + "11".repeat(32))).toBeNull();
    expect(originOf("amm2.localhost:8300")).toBe("http://amm2.localhost:8300");
    expect(originOf("example.com")).toBe("https://example.com");
  });
});

// ---------------------------------------------------------------------------
// Pool deploy
// ---------------------------------------------------------------------------

/** The LP's token deploy output as a bsv21 basket row (the fixture deposits it directly, deploy:0). */
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
    expect(sel.change).toBe(5_000_000n);
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
    expect(() => planPoolDeploy({ ...base, tokens: 10_000_001n })).toThrow(/carry/);
  });

  it("deposit selection: an exact subset first, else cover with token change; null when short", () => {
    const mk = (amount: bigint, n: number) => ({ ...poolableTokens([deployRow]).tokens[0]!.inputs[0]!, amount, outpoint: `${"ab".repeat(32)}.${n}`, vout: n });
    const c = [mk(5n, 0), mk(3n, 1), mk(2n, 2)];
    expect(selectDepositInputs(c, 5n)).toEqual({ inputs: [c[0]], change: 0n });
    expect(selectDepositInputs(c, 8n)!.change).toBe(0n);
    expect(selectDepositInputs(c, 9n)).toEqual({ inputs: [c[0], c[1], c[2]], change: 1n });
    expect(selectDepositInputs(c, 11n)).toBeNull();
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
      "getPublicKey", "getPublicKey", "listOutputs", "listOutputs", "getPublicKey", "createAction", "signAction",
      "createSignature", "getPublicKey", "createSignature", "getPublicKey",
    ]);
    expect(calls[0]!.args).toEqual({ protocolID: BRC29, keyID: lpKeyId(`${DEPLOY_TXID}_0`), counterparty: "self", forSelf: true });
    expect(LP_KEY_PROTOCOL).toEqual(BRC29);
    expect(calls[1]!.args).toEqual({ protocolID: BRC29, keyID: CHANGE_KEY_ID, counterparty: "self", forSelf: true });
    // The token's own basket (1sat-sdk's filing), then the page's `bsv21` filings.
    expect(calls[2]!.args).toEqual({ basket: `mandala ${DEPLOY_TXID} 0`, include: "entire transactions", limit: 10000 });
    expect(calls[3]!.args).toEqual({ basket: "bsv21", tags: [`bsv21:${SDK_ID}`, "bsv21:deploy"], tagQueryMode: "any", include: "entire transactions", limit: 10000 });
    const keyID = (calls[4]!.args as { keyID: string }).keyID;
    expect(keyID).toMatch(/^amm-funding-[0-9a-f]{16}$/);
    const fundingScript = new P2PKH().lock(side.privateKey({ protocolID: P1SAT as never, keyID }).toAddress()).toHex();
    const expires = 1_000 + 120_000;
    const f = prepared.funding;
    expect(calls[5]!.args).toEqual({
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
    expect(calls[6]!.args).toEqual({ reference: "ref-1", spends: {}, options: { noSend: true } });
    expect(calls[7]!.args).toMatchObject({ keyID: "bsv21-deploy-TST-00" });
    expect(calls[9]!.args).toMatchObject({ protocolID: P1SAT, keyID, counterparty: "self" });
    expect(prepared.expires).toBe(expires);
    expect(prepared.validator).toBe(v.identity);
  });

  it("the deploy: [token inputs…, funding] → [pool (the fixture's, byte for byte), token change]; every input validates; no sats change; the funding is exact", async () => {
    const { prepared } = await deployPool();
    const d = prepared.deploy;
    expect(d.inputs.map((i) => `${i.sourceTXID}.${i.sourceOutputIndex}`)).toEqual([`${DEPLOY_TXID}.0`, prepared.funding.outpoint]);
    expect(d.outputs).toHaveLength(2);
    expect(d.outputs[0]!.lockingScript.toHex()).toBe(poolDeploy.outputs[0]!.lockingScript.toHex());
    expect(d.outputs[0]!.satoshis).toBe(1_000_000);
    const changeFiling = prepared.tokenChange!;
    const changeCi = JSON.parse(changeFiling.customInstructions);
    expect(changeCi).toMatchObject({ protocolID: BRC29, keyID: CHANGE_KEY_ID, counterparty: "self" });
    expect(d.outputs[1]!.lockingScript.toHex()).toBe(tokenP2pkhScript(TOKEN_ID, 5_000_000n, pub(side.privateKey({ protocolID: BRC29, keyID: CHANGE_KEY_ID } as KeyArgs))));
    expect(d.outputs[1]!.satoshis).toBe(1);
    d.inputs.forEach((_, i) => {
      expect(verify(d, i)).toBe(true);
      expect(spendValid(d, i)).toBe(true);
    });
    // Exact: outputs 1,000,001 − the token input's 1 sat, plus the fee; the deploy pays exactly that fee.
    const f = prepared.funding;
    expect(f.outputs).toBe(1_000_000);
    expect(f.size).toBe(deployTxSize(d.outputs.map((o) => ({ script: o.lockingScript.toHex() })), 2));
    expect(f.fee).toBe(Math.ceil((f.size * RATE) / 1000));
    expect(f.satoshis).toBe(1_000_000 + f.fee);
    const ins = d.inputs.reduce((a, i) => a + i.sourceTransaction!.outputs[i.sourceOutputIndex]!.satoshis!, 0);
    expect(ins - d.outputs.reduce((a, o) => a + o.satoshis!, 0)).toBe(f.fee);
    expect(d.toBinary().length).toBeLessThanOrEqual(f.size);
    expect(f.size - d.toBinary().length).toBeLessThan(20);
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
    expect(JSON.parse(changeFiling.customInstructions)).toMatchObject({ id: SDK_ID, amt: "5000000", op: "transfer" });
  });

  it("the token change is locked to the key derived from input 0 (BRC-29, prefix amm-change), never a random one", async () => {
    const rand = vi.spyOn(crypto, "getRandomValues");
    const a = await deployPool();
    const b = await deployPool();
    // getRandomValues is the funding key's only use (amm-funding-<hex>): one per deploy.
    expect(rand).toHaveBeenCalledTimes(2);
    rand.mockRestore();
    const derived = side.privateKey({ protocolID: BRC29, keyID: CHANGE_KEY_ID } as KeyArgs);
    const lock = tokenP2pkhScript(TOKEN_ID, 5_000_000n, pub(derived));
    for (const { prepared } of [a, b]) {
      expect(prepared.deploy.outputs[1]!.lockingScript.toHex()).toBe(lock);
      expect(JSON.parse(prepared.tokenChange!.customInstructions)).toMatchObject({ protocolID: BRC29, keyID: CHANGE_KEY_ID, counterparty: "self" });
    }
    // P2PKH to Hash160 of the derived key: the wallet can spend it.
    expect(lock.endsWith(new P2PKH().lock(derived.toAddress()).toHex())).toBe(true);
    expect(CHANGE_KEY_ID).not.toBe(lpKeyId(`${DEPLOY_TXID}_0`));
  });

  it("an exact deposit has no token change: one output, funding = the sats deposit − the token input's sat + fee", async () => {
    const { prepared, calls } = await deployPool(10_000_000n);
    expect(prepared.tokenChange).toBeNull();
    expect(prepared.deploy.outputs).toHaveLength(1);
    expect(prepared.funding.outputs).toBe(999_999);
    // LP key, funding key, and one per signature: no change key.
    expect(calls.filter((c) => c.method === "getPublicKey").map((c) => (c.args as { keyID: string }).keyID).some((k) => k.startsWith(`${SDK_ID}-`))).toBe(false);
    prepared.deploy.inputs.forEach((_, i) => expect(verify(prepared.deploy, i)).toBe(true));
    expect(deployFunding([{ satoshis: 10, script: "00" }], [{ satoshis: 1 }], 0).satoshis).toBe(9);
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
const noSleep = async () => undefined;

describe("pool deploy: amm.pool.submit / amm.pool.status", () => {
  it("submits {funding, deploy, validator, expires} as DAG-JSON bytes, polls while pending; accepted: internalize the pool and the change, relinquish the funding and the token input", async () => {
    const { wallet, calls, prepared } = await deployPool();
    const { af, calls: http } = fakeRelay((fn, _a, n) =>
      fn === "amm.pool.submit" || n < 3 ? ok(fn, { id: ID, status: "pending" }) : ok(fn, { id: ID, status: "accepted", tx: dagBytes(prepared.deploy.toBinary()), txid: prepared.txid }),
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

    expect(o).toEqual({ status: "accepted", id: ID, txid: prepared.txid, completed: { txid: prepared.txid, pool: `${prepared.txid}_0`, internalized: true, relinquished: [prepared.funding.outpoint, `${DEPLOY_TXID}.0`], errors: [] } });
    const after = calls.slice(before);
    expect(after.map((c) => c.method)).toEqual(["internalizeAction", "relinquishOutput", "relinquishOutput"]);
    const ia = after[0]!.args as { tx: number[]; outputs: unknown[]; labels: string[] };
    expect(Beef.fromBinary(ia.tx).atomicTxid).toBe(prepared.txid);
    expect(ia.outputs).toEqual([
      { outputIndex: 0, protocol: "basket insertion", insertionRemittance: { basket: "bsv21", tags: [`bsv21:${SDK_ID}`, "amm-pool"], customInstructions: prepared.pool.customInstructions } },
      { outputIndex: 1, protocol: "basket insertion", insertionRemittance: { basket: "bsv21", tags: [`bsv21:${SDK_ID}`], customInstructions: prepared.tokenChange!.customInstructions } },
    ]);
    expect(ia.labels).toEqual(["amm-pool-deploy"]);
    expect(after[1]!.args).toEqual({ basket: "1sat-deposit", output: prepared.funding.outpoint });
    expect(after[2]!.args).toEqual({ basket: "bsv21", output: `${DEPLOY_TXID}.0` });
    expect(calls.some((c) => c.method === "abortAction")).toBe(false);
  });

  it("accepted without tx / txid: ours is internalized; a different transaction is refused before the wallet is asked", async () => {
    const a = await deployPool();
    const bare = fakeRelay((fn) => ok(fn, { id: ID, status: "accepted" }));
    expect(await relayPoolDeploy({ wallet: a.wallet, authFetch: bare.af, base: "http://x/amm", sleep: noSleep }, a.prepared, PEER)).toMatchObject({ status: "accepted", completed: { internalized: true } });

    const b = await deployPool();
    const other = fakeRelay((fn) => ok(fn, { id: ID, status: "accepted", txid: "ab".repeat(32) }));
    await expect(relayPoolDeploy({ wallet: b.wallet, authFetch: other.af, base: "http://x/amm", sleep: noSleep }, b.prepared, PEER)).rejects.toThrow(/not ours/);
    expect(b.calls.some((c) => c.method === "internalizeAction")).toBe(false);
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
    const later = fakeRelay((fn) => ok(fn, { id: ID, status: "accepted", txid: prepared.txid }));
    expect(await checkPoolDeployAgain({ wallet, authFetch: later.af, base: "http://x/amm" }, prepared, ID)).toMatchObject({ status: "accepted", txid: prepared.txid });
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

describe("my pools", () => {
  const pool0 = PoolTemplate.decode(poolDeploy.outputs[0]!.lockingScript)!;
  const ref = { protocolID: P1SAT as never, keyID: legacyLpKeyId(`${DEPLOY_TXID}_0`), counterparty: "self" };

  it("matching: by the basket's outpoint, by a recorded key, or not at all", () => {
    const op = `${poolDeploy.id("hex")}_0`;
    expect(matchPool(op, pool0, new Map([[op, ref]]), new Map())).toEqual({ lpKey: ref, via: "basket" });
    expect(matchPool("other_0", pool0, new Map(), new Map([[pub(lpKey), { ...ref, source: "recorded key" as const }]]))).toEqual({ lpKey: ref, via: "recorded key" });
    expect(matchPool("other_0", pool0, new Map(), new Map([[pub(lpNext), { ...ref, source: "history" as const }]]))).toBeNull();
    const rows = poolRowsOf([{ outpoint: `${poolDeploy.id("hex")}.0`, satoshis: 1, tags: [POOL_TAG], customInstructions: JSON.stringify({ op: "amm-pool", protocolID: P1SAT, keyID: ref.keyID }) }]);
    expect(rows.get(op)).toEqual(ref);
  });

  it("history: input 0 along the pool's chain in the BEEF; per outpoint the BRC-29 LP key, then the pre-BRC-29 one", () => {
    const tx = Transaction.fromAtomicBEEF(atomic(swap1, [fund, tokenDeploy, poolDeploy]));
    const ops = [`${poolDeploy.id("hex")}_0`, `${DEPLOY_TXID}_0`, `${"22".repeat(32)}_0`];
    expect(historyOutpoints(tx)).toEqual(ops);
    expect(historyKeys(tx)).toEqual(
      ops.flatMap((op) => [
        { protocolID: BRC29, keyID: lpKeyId(op), counterparty: "self" },
        { protocolID: P1SAT, keyID: legacyLpKeyId(op), counterparty: "self" },
      ]),
    );
  });

  it("findMyPools over the instance's answers: the pool after a swap is the LP's, found from its history", async () => {
    const swapOp = `${swap1.id("hex")}_0`;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const q = JSON.parse(String(init!.body)).query;
      const body = q.beef
        ? { type: "output-list", outputs: [{ beef: atomic(swap1, [fund, tokenDeploy, poolDeploy]), outputIndex: 0 }] }
        : { type: "freeform", result: [{ outpoint: swapOp, bsvReserve: v.pool1.bsv, tokenReserve: v.pool1.tokens, liquidityFeeBps: 30, validationFeeBps: 5, validatorIdentityKey: v.identity }] };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const af = { fetch: fetchMock } as unknown as SignedFetch;
    // The wallet's LP key is the deposit's pre-BRC-29 one (amm-lp-<deploy:0>); every other keyID is some other key.
    const { wallet } = fakeWallet(0, honest((a) => (a.keyID === legacyLpKeyId(`${DEPLOY_TXID}_0`) ? lpKey : key(99))));
    const r = await findMyPools(af, "http://x/amm", wallet, [parseTokenTopic(`tm_mandala_${DEPLOY_TXID}_0`)!], []);
    expect(r.warnings).toEqual([]);
    expect(r.pools).toHaveLength(1);
    expect(r.pools[0]!.state.outpoint).toBe(swapOp);
    expect(r.pools[0]!.lpKey).toEqual({ protocolID: P1SAT, keyID: legacyLpKeyId(`${DEPLOY_TXID}_0`), counterparty: "self" });
    expect(r.pools[0]!.via).toBe("history");

    const none = await findMyPools(af, "http://x/amm", fakeWallet(0, honest()).wallet, [parseTokenTopic(`tm_mandala_${DEPLOY_TXID}_0`)!], []);
    expect(none.pools).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// RemoveLiquidity
// ---------------------------------------------------------------------------

describe("remove liquidity: funding and the remove transaction", () => {
  // The pool's current LP key, as a BRC-29 key to self (prefix "cur", suffix "rent", base64).
  const current = { protocolID: BRC29 as never, keyID: "Y3Vy cmVudA==", counterparty: "self" };
  const nextId = lpKeyId(`${swap2.id("hex")}_0`);
  const fixturePool = () => ({ beef: atomic(swap2, [fund, tokenDeploy, poolDeploy, swap1]), outputIndex: 0 });

  it("on the fixture pool: funding broadcast by the wallet (no noSend, exact: 1 sat for the token withdrawal + fee), [pool, funding] → exactly the contract's outputs; both inputs validate", async () => {
    // The fixture's keys answer the BRC-29 keyIDs here: lpKey the current LP key, lpNext the next (lpKeyId of swap2:0).
    const { wallet, calls } = fakeWallet(3, (a) => (a.keyID === nextId ? lpNext : lpKey));
    const s = await prepareRemoveLiquidity({ wallet, tokenId: TOKEN_ID, meta: { sym: "TST", dec: 0 }, poolOutput: fixturePool(), lpKey: current, removeBsv: 10_000n, removeTokens: 100_000n, satsPerKb: RATE, now: 1_000 });
    expect(calls.map((c) => c.method)).toEqual(["getPublicKey", "getPublicKey", "getPublicKey", "getPublicKey", "createAction", "createSignature", "createSignature", "getPublicKey"]);
    expect(calls[0]!.args).toEqual({ identityKey: true });
    expect(calls[2]!.args).toEqual({ protocolID: BRC29, keyID: nextId, counterparty: "self", forSelf: true });
    const keyID = (calls[3]!.args as { keyID: string }).keyID;
    expect(keyID).toMatch(/^amm-funding-[0-9a-f]{16}$/);
    expect(calls[5]!.args).toMatchObject({ protocolID: BRC29, keyID: current.keyID, counterparty: "self" });
    expect(calls[6]!.args).toMatchObject({ protocolID: P1SAT, keyID, counterparty: "self" });
    expect(calls.some((c) => c.method === "signAction")).toBe(false);

    const f = s.funding;
    const expires = 121_000;
    expect(calls[4]!.args).toEqual({
      description: "AMM remove-liquidity funding: TST",
      labels: ["amm-remove-liquidity"],
      outputs: [
        {
          lockingScript: new P2PKH().lock(side.privateKey({ protocolID: P1SAT as never, keyID }).toAddress()).toHex(),
          satoshis: f.satoshis,
          outputDescription: "AMM remove-liquidity funding: TST",
          basket: "1sat-deposit",
          tags: [FUNDING_TAG, `hold:${expires}`],
          customInstructions: JSON.stringify({ protocolID: P1SAT, keyID, counterparty: "self", amm: { remove: `${swap2.id("hex")}_0`, expires } }),
        },
      ],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
    });
    expect(f.reference).toBeUndefined();
    expect(f.outputs).toBe(1);
    expect(f.size).toBe(swapTxSize(s.plan, 1));
    expect(f.satoshis).toBe(1 + Math.ceil((f.size * RATE) / 1000));
    expect(swapFunding(s.plan, [], RATE)).toEqual({ satoshis: f.satoshis, outputs: 1, fee: f.fee, size: f.size, satsPerKb: RATE });

    const tx = s.tx;
    expect(tx.inputs.map((i) => `${i.sourceTXID}.${i.sourceOutputIndex}`)).toEqual([`${swap2.id("hex")}.0`, f.outpoint]);
    expect(tx.outputs.map((o) => [BigInt(o.satoshis!), o.lockingScript.toHex()])).toEqual(s.plan.outputs.map((o) => [o.satoshis, o.script]));
    // The fixture's remove_liquidity has the same three contract outputs (and a change after them, which this one does not have).
    const fixture = Transaction.fromHex(v.remove_liquidity);
    expect(tx.outputs.map((o) => o.lockingScript.toHex())).toEqual(fixture.outputs.slice(0, 3).map((o) => o.lockingScript.toHex()));
    for (const i of [0, 1]) expect(verify(tx, i)).toBe(true);
    const ins = tx.inputs.reduce((a, i) => a + i.sourceTransaction!.outputs[i.sourceOutputIndex]!.satoshis!, 0);
    expect(ins - tx.outputs.reduce((a, o) => a + o.satoshis!, 0)).toBe(f.fee);
    expect(tx.toBinary().length).toBeLessThanOrEqual(f.size);
    expect(PoolTemplate.decode(tx.outputs[0]!.lockingScript)!.state.lpPubKey).toBe(pub(lpNext));

    // The submit body: the remove's AtomicBEEF with the funding as its unproven parent.
    const b = Beef.fromBinary(s.beef);
    expect(b.atomicTxid).toBe(s.txid);
    expect(b.findTxid(f.txid)).toBeDefined();
    expect(b.findTxid(swap2.id("hex"))).toBeDefined();
    expect(s.topic).toBe(`tm_mandala_${DEPLOY_TXID}_0`);
    const STEAK = { [s.topic]: { outputsToAdmit: [0, 2], coinsToRetain: [], coinsRemoved: [0] } };
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      // skein-overlay 0.9.1: BRC-22, the STEAK; the outcome is a lookup too.
      if (url.endsWith("/submit")) return new Response(JSON.stringify(STEAK), { status: 200 });
      const q = JSON.parse(init.body as string) as { service: string; query: { txid: string; outputIndex: number } };
      const found = q.service === "ls_mandala" && q.query.txid === s.txid && seen.length > 2;
      return new Response(JSON.stringify({ type: "output-list", outputs: found ? [{ beef: [], outputIndex: q.query.outputIndex }] : [] }), { status: 200 });
    }) as unknown as SignedFetch["fetch"];
    const af: SignedFetch = { fetch: fetchFn };
    // Plain fetch, unsigned (0.6.3): the submit takes a fetch function, not the wallet's AuthFetch.
    const r = await submitToOverlay("http://x/amm", s.topic, s.beef, fetchFn as never);
    expect(seen[0]!.url).toBe("http://x/amm/submit");
    expect(seen[0]!.init.headers).toEqual({ "content-type": "application/octet-stream", "x-topics": s.topic });
    expect(Array.from(seen[0]!.init.body as Uint8Array)).toEqual(s.beef);
    expect(r).toEqual({ steak: STEAK });
    expect(steakText(r)).toBe(`admitted under ${s.topic} (outputs 0, 2)`);
    expect(steakText({})).toBe("not decided yet");
    const later = (async () => new Response('{"status":"error"}', { status: 503, headers: { "retry-after": "30" } })) as unknown as SignedFetch["fetch"];
    expect(await submitToOverlay("http://x/amm", s.topic, s.beef, later as never)).toEqual({});
    // Not admitted on the first lookup, admitted on the second: the continuation (output 0).
    expect(admittedOutput(s)).toBe(0);
    expect(await awaitAdmitted(af, "http://x/amm", s.txid, 0, { intervalMs: 1 })).toBe(true);
    expect(seen.slice(1).map((x) => x.url)).toEqual(["http://x/amm/lookup", "http://x/amm/lookup"]);
    expect(await awaitAdmitted(af, "http://x/amm", "00".repeat(32), 0, { intervalMs: 1, timeoutMs: 0 })).toBe(false);

    // Where each output lands.
    expect(s.continuation).toMatchObject({ outputIndex: 0, basket: "bsv21", tags: [`bsv21:${SDK_ID}`, "amm-pool"] });
    expect(JSON.parse(s.continuation!.customInstructions)).toMatchObject({ op: "amm-pool", protocolID: BRC29, keyID: nextId });
    expect(s.payout).toEqual({ outputIndex: 1, satoshis: 10_000, lockingScript: tx.outputs[1]!.lockingScript.toHex(), remittance: { derivationPrefix: "Y3Vy", derivationSuffix: "cmVudA==", senderIdentityKey: side.identityKey } });
    expect(s.tokens).toMatchObject({ outputIndex: 2, basket: "bsv21", tags: [`bsv21:${SDK_ID}`] });
    expect(JSON.parse(s.tokens!.customInstructions)).toMatchObject({ id: SDK_ID, amt: "100000", op: "transfer", protocolID: BRC29, keyID: "Y3Vy cmVudA==" });
  });

  it("refuses a wallet key that is not the pool's LP key, before any funding", async () => {
    const { wallet, calls } = fakeWallet(3, () => key(99));
    await expect(
      prepareRemoveLiquidity({ wallet, tokenId: TOKEN_ID, poolOutput: fixturePool(), lpKey: { protocolID: P1SAT as never, keyID: "x", counterparty: "self" }, removeBsv: 0n, removeTokens: 1n, satsPerKb: RATE }),
    ).rejects.toThrow(/not this pool's LP key/);
    expect(calls.some((c) => c.method === "createAction")).toBe(false);
  });

  it("a pre-BRC-29 LP key: sats cannot be withdrawn as a wallet payment (refused before the wallet is asked); tokens only rotates it to a BRC-29 LP key", async () => {
    const legacy = { protocolID: P1SAT as never, keyID: "lp-current", counterparty: "self" };
    const a = fakeWallet(3);
    await expect(prepareRemoveLiquidity({ wallet: a.wallet, tokenId: TOKEN_ID, poolOutput: fixturePool(), lpKey: legacy, removeBsv: 10_000n, removeTokens: 0n, satsPerKb: RATE })).rejects.toThrow(LEGACY_LP_KEY);
    expect(a.calls).toEqual([]);

    const b = fakeWallet(3, honest((k) => (k.keyID === "lp-current" ? lpKey : key(99))));
    const s = await prepareRemoveLiquidity({ wallet: b.wallet, tokenId: TOKEN_ID, poolOutput: fixturePool(), lpKey: legacy, removeBsv: 0n, removeTokens: 100_000n, satsPerKb: RATE });
    expect(s.payout).toBeNull();
    expect(s.nextLpKey).toEqual({ protocolID: BRC29, keyID: nextId, publicKey: side.publicKey({ protocolID: BRC29, keyID: nextId, counterparty: "self", forSelf: true }) });
    expect(PoolTemplate.decode(s.tx.outputs[0]!.lockingScript)!.state.lpPubKey).toBe(s.nextLpKey!.publicKey);
    for (const i of [0, 1]) expect(verify(s.tx, i)).toBe(true);
  });
});

describe("remove liquidity from a BRC-29-keyed pool: submit, internalize the withdrawals, relinquish; survives a reload", () => {
  afterEach(() => vi.unstubAllGlobals());

  // A pool like the fixture's after swap2, whose LP key is the wallet's BRC-29 LP key for some deposit outpoint.
  const depositOp = `${"33".repeat(32)}_0`;
  const lpRef = { protocolID: BRC29 as never, keyID: lpKeyId(depositOp), counterparty: "self" };
  const lpPub = side.publicKey({ ...lpRef, forSelf: true });
  const base = PoolTemplate.decode(swap2.outputs[0]!.lockingScript)!;
  const poolTx = new Transaction();
  poolTx.addInput({ sourceTXID: "44".repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
  poolTx.addOutput({ satoshis: swap2.outputs[0]!.satoshis!, lockingScript: PoolTemplate.lockContinuation(base, { ...base.state, lpPubKey: lpPub }) });
  const poolOutput = () => ({ beef: atomic(poolTx, []), outputIndex: 0 });
  const service = "ls_amm";

  it("prepared → recorded → completeRemoveLiquidity: one internalizeAction (continuation + tokens as basket insertions, sats as a wallet payment), funding and pool relinquished", async () => {
    const { wallet, calls } = fakeWallet(3, honest());
    const s = await prepareRemoveLiquidity({ wallet, tokenId: TOKEN_ID, poolOutput: poolOutput(), lpKey: lpRef, removeBsv: 10_000n, removeTokens: 100_000n, satsPerKb: RATE });
    for (const i of [0, 1]) expect(verify(s.tx, i)).toBe(true);
    const [derivationPrefix, derivationSuffix] = lpRef.keyID.split(" ") as [string, string];
    expect(s.payout!.remittance).toEqual({ derivationPrefix, derivationSuffix, senderIdentityKey: side.identityKey });
    // wallet-toolbox's recipient derivation (counterparty = the sender's identity key) gives the LP key itself.
    expect(side.privateKey({ protocolID: BRC29, keyID: lpRef.keyID, counterparty: side.identityKey }).toPublicKey().toString()).toBe(lpPub);

    const mem = new Map<string, string>();
    const store = new PendingPayoutStore({ getItem: (k) => mem.get(k) ?? null, setItem: (k, val) => void mem.set(k, val) });
    const rec = pendingRemovePayout(s, TOKEN_ID, 1)!;
    expect(rec).toMatchObject({ id: `${s.txid}:1`, kind: "remove-liquidity", final: true, poolOutpoint: `${s.txid}_0`, vout: 1, satoshis: 10_000 });
    expect(rec.reference).toBeUndefined();
    store.save(rec);

    const before = calls.length;
    const c = await completeRemoveLiquidity(wallet, s);
    expect(c).toEqual({ internalized: true, relinquished: [s.funding.outpoint, `${poolTx.id("hex")}.0`], errors: [] });
    const after = calls.slice(before);
    expect(after.map((x) => x.method)).toEqual(["internalizeAction", "relinquishOutput", "relinquishOutput"]);
    const ia = after[0]!.args as { tx: number[]; outputs: unknown[]; labels: string[] };
    expect(ia.tx).toEqual(s.beef);
    expect(ia.labels).toEqual(["amm-remove-liquidity"]);
    expect(ia.outputs).toEqual([
      { outputIndex: 0, protocol: "basket insertion", insertionRemittance: { basket: "bsv21", tags: [`bsv21:${SDK_ID}`, "amm-pool"], customInstructions: s.continuation!.customInstructions } },
      { outputIndex: 1, protocol: "wallet payment", paymentRemittance: rec.remittance },
      { outputIndex: 2, protocol: "basket insertion", insertionRemittance: { basket: "bsv21", tags: [`bsv21:${SDK_ID}`], customInstructions: s.tokens!.customInstructions } },
    ]);
    expect(after[1]!.args).toEqual({ basket: "1sat-deposit", output: s.funding.outpoint });
    expect(after[2]!.args).toEqual({ basket: "bsv21", output: `${poolTx.id("hex")}.0` });
    store.remove(rec.id);
    expect(store.list()).toEqual([]);
  });

  it("reload before internalizing: the record is read back, the tx's BEEF comes from the instance's lookup, internalized, cleared", async () => {
    const { wallet, calls } = fakeWallet(3, honest());
    const s = await prepareRemoveLiquidity({ wallet, tokenId: TOKEN_ID, poolOutput: poolOutput(), lpKey: lpRef, removeBsv: 10_000n, removeTokens: 100_000n, satsPerKb: RATE });
    const mem = new Map<string, string>();
    const kv: KV = { getItem: (k) => mem.get(k) ?? null, setItem: (k, val) => void mem.set(k, val) };
    new PendingPayoutStore(kv).save(pendingRemovePayout(s, TOKEN_ID, 1)!);

    const store = new PendingPayoutStore(kv); // reload
    const [rec] = store.list();
    const asked: unknown[] = [];
    const af: SignedFetch = { fetch: async (_url, init) => {
      asked.push(JSON.parse(String(init!.body)));
      return new Response(JSON.stringify({ type: "output-list", outputs: [{ beef: s.beef, outputIndex: 0 }] }), { status: 200 });
    } };
    expect(await internalizeNow(wallet, store, af, "http://x/amm", rec!)).toEqual({ accepted: true, txid: s.txid });
    expect(asked).toEqual([{ service, query: { tokenId: TOKEN_ID, outpoint: `${s.txid}_0`, beef: true } }]);
    expect(calls.filter((c) => c.method === "internalizeAction")).toHaveLength(1);
    expect(store.list()).toEqual([]);
  });

  it("closing the pool: no continuation, the sats withdrawal is output 0, funding covers the token withdrawal's sat + fee", async () => {
    const { wallet, calls } = fakeWallet(3, honest());
    const s = await prepareRemoveLiquidity({ wallet, tokenId: TOKEN_ID, poolOutput: poolOutput(), lpKey: lpRef, removeBsv: BigInt(poolTx.outputs[0]!.satoshis!), removeTokens: base.state.tokenReserve, satsPerKb: RATE });
    expect(s.plan.closing).toBe(true);
    expect(s.continuation).toBeNull();
    expect(s.payout!.outputIndex).toBe(0);
    expect(s.tokens!.outputIndex).toBe(1);
    expect(s.funding.outputs).toBe(1);
    for (const i of [0, 1]) expect(verify(s.tx, i)).toBe(true);
    expect(pendingRemovePayout(s, TOKEN_ID)!.poolOutpoint).toBeUndefined();
    expect((await completeRemoveLiquidity(wallet, s)).internalized).toBe(true);
    const ia = calls.find((c) => c.method === "internalizeAction")!.args as { outputs: { outputIndex: number; protocol: string }[] };
    expect(ia.outputs.map((o) => [o.outputIndex, o.protocol])).toEqual([[0, "wallet payment"], [1, "basket insertion"]]);
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

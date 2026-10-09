/**
 * AddLiquidity through a fake BRC-100 wallet and a fake relay, on the
 * amm-topic fixture pool after the first swap (swap_bsv_in:0, LP key(10),
 * validator key for pool_deploy:0): the nosend funding's shape and exact
 * amount, the add transaction (every input valid under `Spend` but the
 * pool's validator slot; signed in-test with the fixture validator key, the
 * pool input validates too), the relay's call and polling, accepted →
 * internalize + relinquish, refused / timeout / error → abortAction.
 */
import { BigNumber, Beef, ECDSA, LockingScript, P2PKH, PrivateKey, Transaction, UnlockingScript, Utils, type CreateActionArgs, type WalletInterface } from "@bsv/sdk";
import { P1SAT_PROTOCOL } from "@1sat/actions";
import { describe, expect, it } from "vitest";
import { PEER } from "./liveRead";
import { PoolTemplate, PoolBuildError } from "../src/pool";
import { FUNDING_TAG, spendValid, swapTxSize, tokenInputsOf } from "../src/market/swapAction";
import { dagBytes, readBytes, type AuthFetchLike } from "../src/market/relay";
import { LP_KEY_PROTOCOL, lpKeyId } from "../src/lp/poolDeploy";
import { TOKEN_SPLIT, prepareAddLiquidity, satsAtRatio, selectAddTokenInputs, tokensAtRatio, type PreparedAddLiquidity } from "../src/lp/addLiquidity";
import { checkAddLiquidityAgain, relayAddLiquidity } from "../src/lp/liquidityRelay";
import { BRC29, brc29Side } from "./brc29Wallet";
import v from "./fixtures/amm-topic-vectors.json";

const key = (n: number) => new PrivateKey(n.toString(16).padStart(2, "0").repeat(32), 16);
const lpKey = key(10); // the fixture pool's LP key
const taker = key(30); // owns fund:1 and pool_deploy:1 (50,000 tokens)
const identity = key(0x7f);
const anyone = new PrivateKey(1).toPublicKey();
const validatorKey = (txid: string, vout: number) => identity.deriveChild(anyone, `1-amm pool-${txid}_${vout}`);
const walletRoot = key(31);
const P1SAT = P1SAT_PROTOCOL as unknown as [0, string];
const TOKEN_KEY = "k1";
const LP_REF = { protocolID: P1SAT as never, keyID: "lp-current", counterparty: "self" };
const RATE = 100;

const fund = Transaction.fromHex(v.fund);
const tokenDeploy = Transaction.fromHex(v.token_deploy);
const poolDeploy = Transaction.fromHex(v.pool_deploy);
const swap1 = Transaction.fromHex(v.swap_bsv_in);
// The page's token id and the wallet's filings are the same `<txid>_0` (BRC-162 Token identification, David 2026-10-07).
const TOKEN_ID = `${tokenDeploy.id("hex")}_0`;
const SDK_ID = TOKEN_ID;
const POOL_ID = `${swap1.id("hex")}_0`;
const NEXT_LP_ID = lpKeyId(POOL_ID);
const VKEY = validatorKey(poolDeploy.id("hex"), 0);

const atomic = (tx: Transaction) => {
  const b = new Beef();
  b.mergeTransaction(tx);
  return b.toBinaryAtomic(tx.id("hex"));
};

/** Fake wallet: a real KeyDeriver over walletRoot, `lp-current` = the fixture LP key, `k1` = the taker's token key; createAction funds from fund:1. */
function fakeWallet() {
  const calls: { method: string; args: unknown }[] = [];
  const side = brc29Side(walletRoot);
  type K = { identityKey?: boolean; protocolID?: [0 | 1 | 2, string]; keyID?: string; counterparty?: string; forSelf?: boolean };
  const keyOf = (a: K) => (a.keyID === TOKEN_KEY ? taker : a.keyID === LP_REF.keyID ? lpKey : side.privateKey(a as never));
  let unsigned: Transaction | undefined;
  const w = {
    async getPublicKey(args: K) {
      calls.push({ method: "getPublicKey", args });
      if (args.identityKey) return { publicKey: side.identityKey };
      return { publicKey: keyOf(args).toPublicKey().toString() };
    },
    async createSignature(args: K & { hashToDirectlySign: number[] }) {
      calls.push({ method: "createSignature", args });
      return { signature: ECDSA.sign(new BigNumber(args.hashToDirectlySign), keyOf(args), true).toDER() as number[] };
    },
    async createAction(args: CreateActionArgs) {
      calls.push({ method: "createAction", args });
      const tx = new Transaction();
      tx.addInput({ sourceTXID: fund.id("hex"), sourceOutputIndex: 1, sourceTransaction: fund, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
      for (const x of args.outputs ?? []) tx.addOutput({ satoshis: x.satoshis, lockingScript: LockingScript.fromHex(x.lockingScript) });
      const spent = tx.outputs.reduce((a, x) => a + x.satoshis!, 0);
      tx.addOutput({ satoshis: fund.outputs[1]!.satoshis! - spent - 200, lockingScript: new P2PKH().lock(taker.toAddress()) });
      unsigned = tx;
      return { signableTransaction: { tx: atomic(tx), reference: "ref-1" } };
    },
    async signAction(args: unknown) {
      calls.push({ method: "signAction", args });
      unsigned!.inputs[0]!.unlockingScript = await new P2PKH().unlock(taker).sign(unsigned!, 0);
      return { txid: unsigned!.id("hex"), tx: atomic(unsigned!) };
    },
    async listOutputs(args: unknown) {
      calls.push({ method: "listOutputs", args });
      const b = new Beef();
      b.mergeTransaction(poolDeploy);
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
  return { wallet: w as unknown as WalletInterface, calls, side };
}

const tokenRow = () => {
  const out = poolDeploy.outputs[1]!;
  return { outpoint: `${poolDeploy.id("hex")}.1`, satoshis: 1, lockingScript: out.lockingScript.toHex(), customInstructions: JSON.stringify({ protocolID: [1, "1sat"], keyID: TOKEN_KEY, counterparty: "self" }) };
};

async function add(addBsv = 10_000n, addTokens = 50_000n, w = fakeWallet()) {
  const tokenInputs = selectAddTokenInputs(tokenInputsOf([tokenRow()], TOKEN_ID), addTokens)!;
  const prepared = await prepareAddLiquidity({
    wallet: w.wallet,
    tokenId: TOKEN_ID,
    meta: { sym: "TST", dec: 0 },
    poolOutput: { beef: atomic(swap1), outputIndex: 0 },
    lpKey: LP_REF,
    addBsv,
    addTokens,
    tokenInputs,
    satsPerKb: RATE,
    now: 1_000,
  });
  return { ...w, prepared };
}

/** What the validator does: fills its slot over the add it received. */
async function validatorSigns(p: PreparedAddLiquidity, raw: number[]): Promise<Transaction> {
  const tx = Transaction.fromBinary(raw);
  tx.inputs.forEach((inp, n) => (inp.sourceTransaction = p.tx.inputs[n]!.sourceTransaction));
  await PoolTemplate.signPoolInput({ tx, pool: p.plan.pool, method: "addLiquidity", unsigned: ["validator"] }, "validator", VKEY);
  return tx;
}

describe("add liquidity: plan and helpers", () => {
  it("planAddLiquidity: one output, the continuation with both keys rotated; the ratio is free", () => {
    const tx = swap1;
    const pool = { txid: tx.id("hex"), vout: 0, satoshis: tx.outputs[0]!.satoshis!, script: tx.outputs[0]!.lockingScript };
    const next = key(11).toPublicKey().toString();
    const plan = PoolTemplate.planAddLiquidity({ pool, addBsv: 0n, addTokens: 7n, nextLpPubKey: next });
    expect(plan.outputs).toHaveLength(1);
    expect(plan.outputs[0]!.satoshis).toBe(BigInt(v.pool1.bsv));
    const st = PoolTemplate.decode(plan.outputs[0]!.script)!.state;
    expect(st).toMatchObject({ tokenReserve: BigInt(v.pool1.tokens) + 7n, lpPubKey: next, validatorPubKey: validatorKey(tx.id("hex"), 0).toPublicKey().toString() });
    expect(plan.sigSlots).toEqual({ lp: 0, validator: 1 });
    expect(() => PoolTemplate.planAddLiquidity({ pool, addBsv: 0n, addTokens: 0n, nextLpPubKey: next })).toThrow(PoolBuildError);
    const s = { bsvReserve: 1_000n, tokenReserve: 5_000n };
    expect(tokensAtRatio(s, 10n)).toBe(50n);
    expect(satsAtRatio(s, 50n)).toBe(10n);
    expect(selectAddTokenInputs(tokenInputsOf([tokenRow()], TOKEN_ID), 40_000n)).toBeNull();
    expect(selectAddTokenInputs([], 0n)).toEqual([]);
    expect(TOKEN_SPLIT).toMatch(/^not built: token split/);
  });
});

describe("add liquidity: funding and the add transaction", () => {
  it("the wallet sequence and the funding: nosend, exact, 1sat-deposit, amm-funding + hold, {amm: {add, expires}}", async () => {
    const { calls, prepared, side } = await add();
    expect(calls.map((c) => c.method)).toEqual([
      "getPublicKey", "getPublicKey", "listOutputs", "listOutputs", "getPublicKey", "createAction", "signAction",
      "createSignature", "createSignature", "getPublicKey", "createSignature", "getPublicKey",
    ]);
    expect(calls[0]!.args).toEqual({ ...LP_REF, forSelf: true });
    expect(calls[1]!.args).toEqual({ protocolID: BRC29, keyID: NEXT_LP_ID, counterparty: "self", forSelf: true });
    expect(LP_KEY_PROTOCOL).toEqual(BRC29);
    expect(calls[2]!.args).toEqual({ basket: `mandala ${TOKEN_ID.slice(0, 64)} 0`, include: "entire transactions", limit: 10000 });
    expect(calls[3]!.args).toEqual({ basket: "bsv21", tags: [`bsv21:${SDK_ID}`], include: "entire transactions", limit: 10000 });
    const keyID = (calls[4]!.args as { keyID: string }).keyID;
    expect(keyID).toMatch(/^amm-funding-[0-9a-f]{16}$/);
    const f = prepared.funding;
    const expires = 121_000;
    expect(calls[5]!.args).toEqual({
      description: "AMM add-liquidity funding: TST",
      labels: ["amm-add-liquidity"],
      outputs: [
        {
          lockingScript: new P2PKH().lock(side.privateKey({ protocolID: P1SAT as never, keyID }).toAddress()).toHex(),
          satoshis: f.satoshis,
          outputDescription: "AMM add-liquidity funding: TST",
          basket: "1sat-deposit",
          tags: [FUNDING_TAG, `hold:${expires}`],
          customInstructions: JSON.stringify({ protocolID: P1SAT, keyID, counterparty: "self", amm: { add: POOL_ID, expires } }),
        },
      ],
      options: { signAndProcess: false, randomizeOutputs: false, noSend: true },
    });
    expect(calls[6]!.args).toEqual({ reference: "ref-1", spends: {}, options: { noSend: true } });
    expect(calls[7]!.args).toMatchObject({ ...LP_REF }); // the LP's slot, under the current LP key
    expect(calls[8]!.args).toMatchObject({ protocolID: P1SAT, keyID, counterparty: "self" });
    expect(calls[10]!.args).toMatchObject({ keyID: TOKEN_KEY });
    // Exact: addBsv − the token input's 1 sat + the fee for the final size.
    expect(f.outputs).toBe(9_999);
    expect(f.size).toBe(swapTxSize(prepared.plan, 2));
    expect(f.fee).toBe(Math.ceil((f.size * RATE) / 1000));
    expect(f.satoshis).toBe(9_999 + f.fee);
    expect(prepared.expires).toBe(expires);
    expect(prepared.validator).toBe(v.identity);
    expect(prepared.pool).toBe(POOL_ID);
  });

  it("the add: [pool, funding, token] → the contract's one output; every input but the pool's validates; with the validator's signature all do; the fee is exact", async () => {
    const { prepared, side } = await add();
    const tx = prepared.tx;
    expect(tx.inputs.map((i) => `${i.sourceTXID}.${i.sourceOutputIndex}`)).toEqual([`${swap1.id("hex")}.0`, prepared.funding.outpoint, `${poolDeploy.id("hex")}.1`]);
    expect(tx.outputs).toHaveLength(1);
    expect(tx.outputs[0]!.satoshis).toBe(v.pool1.bsv + 10_000);
    const next = PoolTemplate.decode(tx.outputs[0]!.lockingScript)!.state;
    expect(next).toEqual({
      tokenReserve: BigInt(v.pool1.tokens) + 50_000n,
      lpPubKey: side.publicKey({ protocolID: BRC29, keyID: NEXT_LP_ID, counterparty: "self", forSelf: true }),
      validatorPubKey: validatorKey(swap1.id("hex"), 0).toPublicKey().toString(),
      validatorIdentity: v.identity,
    });
    expect(spendValid(tx, 0)).toBe(false); // the validator's slot is OP_0
    for (const n of [1, 2]) expect(spendValid(tx, n)).toBe(true);
    const final = await validatorSigns(prepared, tx.toBinary());
    for (const n of [0, 1, 2]) expect(spendValid(final, n)).toBe(true);
    const ins = final.inputs.reduce((a, i) => a + i.sourceTransaction!.outputs[i.sourceOutputIndex]!.satoshis!, 0);
    expect(ins - final.outputs[0]!.satoshis!).toBe(prepared.funding.fee);
    expect(final.toBinary().length).toBeLessThanOrEqual(prepared.funding.size);
    // The relay's AtomicBEEF carries the funding and the token input's source.
    const b = Beef.fromBinary(prepared.atomicBeef);
    expect(b.atomicTxid).toBe(prepared.txid);
    expect(b.findTxid(prepared.funding.txid)).toBeDefined();
    expect(b.findTxid(poolDeploy.id("hex"))).toBeDefined();
    expect(prepared.continuation).toMatchObject({ outputIndex: 0, basket: "bsv21", tags: [`bsv21:${SDK_ID}`, "amm-pool"] });
    expect(JSON.parse(prepared.continuation.customInstructions)).toMatchObject({ op: "amm-pool", protocolID: BRC29, keyID: NEXT_LP_ID, counterparty: "self" });
  });

  it("sats only: no token inputs, no listOutputs; the pool input validates once the validator signs", async () => {
    const { prepared, calls } = await add(25_000n, 0n);
    expect(calls.some((c) => c.method === "listOutputs")).toBe(false);
    expect(prepared.tx.inputs).toHaveLength(2);
    expect(prepared.funding.outputs).toBe(25_000);
    const final = await validatorSigns(prepared, prepared.tx.toBinary());
    for (const n of [0, 1]) expect(spendValid(final, n)).toBe(true);
  });

  it("refusals: a key that is not the pool's LP key (before any funding); token inputs that do not carry exactly the deposit", async () => {
    const w = fakeWallet();
    await expect(
      prepareAddLiquidity({ wallet: w.wallet, tokenId: TOKEN_ID, poolOutput: { beef: atomic(swap1), outputIndex: 0 }, lpKey: { ...LP_REF, keyID: "other" }, addBsv: 1n, addTokens: 0n, tokenInputs: [], satsPerKb: RATE }),
    ).rejects.toThrow(/not this pool's LP key/);
    expect(w.calls.some((c) => c.method === "createAction")).toBe(false);
    await expect(
      prepareAddLiquidity({ wallet: w.wallet, tokenId: TOKEN_ID, poolOutput: { beef: atomic(swap1), outputIndex: 0 }, lpKey: LP_REF, addBsv: 1n, addTokens: 40_000n, tokenInputs: tokenInputsOf([tokenRow()], TOKEN_ID), satsPerKb: RATE }),
    ).rejects.toThrow(/exactly 40000/);
  });
});

// ---------------------------------------------------------------------------
// The relay
// ---------------------------------------------------------------------------

const ID = "add-1";
function fakeRelay(answer: (fn: string, args: Record<string, unknown>, n: number) => Promise<{ status: number; body: unknown }> | { status: number; body: unknown }) {
  const calls: { url: string; method?: string; body: { fn: string; args: Record<string, unknown> } }[] = [];
  const af: AuthFetchLike = {
    async fetch(url, config) {
      const body = JSON.parse(config!.body!);
      calls.push({ url, method: config?.method, body });
      const a = await answer(body.fn, body.args, calls.length);
      return { status: a.status, text: async () => JSON.stringify(a.body) };
    },
  };
  return { af, calls };
}
const ok = (fn: string, result: unknown) => ({ status: 200, body: { fn, result } });
const noSleep = async () => undefined;

describe("add liquidity: amm.liquidity.submit / amm.liquidity.status", () => {
  it("submits {funding, add, pool, validator, expires} as DAG-JSON bytes, polls while pending; accepted: internalize the continuation, relinquish funding, pool and token input", async () => {
    const { wallet, calls, prepared } = await add();
    let final: Transaction | undefined;
    const { af, calls: http } = fakeRelay(async (fn, args, n) => {
      if (fn === "amm.liquidity.submit") {
        const add = Transaction.fromAtomicBEEF(readBytes(args.add)!);
        final = await validatorSigns(prepared, add.toBinary());
        return ok(fn, { id: ID, status: "pending" });
      }
      return n < 3 ? ok(fn, { id: ID, status: "pending" }) : ok(fn, { id: ID, status: "accepted", tx: dagBytes(final!.toBinary()), txid: final!.id("hex") });
    });
    const before = calls.length;
    const seen: string[] = [];
    const o = await relayAddLiquidity({ wallet, authFetch: af, base: "http://amm2.localhost:8300/amm", sleep: noSleep, now: () => 0, onRecord: (r) => seen.push(r.status) }, prepared, PEER);
    expect(http.map((c) => [c.url, c.method, c.body.fn])).toEqual([
      ["http://amm2.localhost:8300/amm/call", "POST", "amm.liquidity.submit"],
      ["http://amm2.localhost:8300/amm/call", "POST", "amm.liquidity.status"],
      ["http://amm2.localhost:8300/amm/call", "POST", "amm.liquidity.status"],
    ]);
    expect(http[0]!.body.args).toEqual({
      funding: dagBytes(prepared.funding.atomicBeef),
      add: dagBytes(prepared.atomicBeef),
      pool: POOL_ID,
      validator: dagBytes(Utils.toArray(v.identity, "hex")),
      peerId: PEER,
      expires: 121_000,
    });
    expect(http[1]!.body.args).toEqual({ id: ID });
    expect(seen).toEqual(["pending", "pending", "accepted"]);
    const txid = final!.id("hex");
    expect(txid).not.toBe(prepared.txid);
    expect(o).toEqual({
      status: "accepted",
      id: ID,
      txid,
      completed: { txid, pool: `${txid}_0`, internalized: true, relinquished: [prepared.funding.outpoint, `${swap1.id("hex")}.0`, `${poolDeploy.id("hex")}.1`], errors: [] },
    });
    const after = calls.slice(before);
    expect(after.map((c) => c.method)).toEqual(["internalizeAction", "relinquishOutput", "relinquishOutput", "relinquishOutput"]);
    const ia = after[0]!.args as { tx: number[]; outputs: unknown[]; labels: string[]; description: string };
    expect(Beef.fromBinary(ia.tx).atomicTxid).toBe(txid);
    expect(ia.outputs).toEqual([
      { outputIndex: 0, protocol: "basket insertion", insertionRemittance: { basket: "bsv21", tags: [`bsv21:${SDK_ID}`, "amm-pool"], customInstructions: prepared.continuation.customInstructions } },
    ]);
    expect(ia.labels).toEqual(["amm-add-liquidity"]);
    expect(after[1]!.args).toEqual({ basket: "1sat-deposit", output: prepared.funding.outpoint });
    expect(after[2]!.args).toEqual({ basket: "bsv21", output: `${swap1.id("hex")}.0` });
    expect(after[3]!.args).toEqual({ basket: "bsv21", output: `${poolDeploy.id("hex")}.1` });
    expect(calls.some((c) => c.method === "abortAction")).toBe(false);
  });

  it("accepted with a transaction that is not ours: refused before the wallet is asked", async () => {
    const { wallet, calls, prepared } = await add();
    const { af } = fakeRelay((fn) => ok(fn, { id: ID, status: "accepted", tx: dagBytes(swap1.toBinary()), txid: swap1.id("hex") }));
    await expect(relayAddLiquidity({ wallet, authFetch: af, base: "http://x/amm", sleep: noSleep }, prepared, PEER)).rejects.toThrow(/not the add we built/);
    expect(calls.some((c) => c.method === "internalizeAction")).toBe(false);
  });

  it("refused: abortAction of the funding, the pool's state returned for replanning", async () => {
    const { wallet, calls, prepared } = await add();
    const wirePool = { outpoint: "ab".repeat(32) + "_0", bsvReserve: 1_100_000, tokenReserve: 4_800_000, lpFeeBps: 30, validatorFeeBps: 5, commissionBps: 10, validatorIdentity: v.identity };
    const { af } = fakeRelay((fn) => ok(fn, { id: ID, status: "refused", reason: "stale_pool", poolState: wirePool }));
    const o = await relayAddLiquidity({ wallet, authFetch: af, base: "http://x/amm", sleep: noSleep }, prepared, PEER);
    expect(o).toEqual({
      status: "refused",
      id: ID,
      reason: "stale_pool",
      pool: { outpoint: wirePool.outpoint, bsvReserve: 1_100_000n, tokenReserve: 4_800_000n, liquidityFeeBps: 30n, validationFeeBps: 5n, commissionBps: 10n, validatorIdentityKey: v.identity },
    });
    expect(calls.at(-1)).toEqual({ method: "abortAction", args: { reference: "ref-1" } });
    expect(calls.some((c) => c.method === "internalizeAction" || c.method === "relinquishOutput")).toBe(false);
  });

  it("timeout and an error answer to submit: abortAction; no answer: nothing aborted, Check again settles it", async () => {
    const a = await add();
    const t = fakeRelay((fn, _a, n) => ok(fn, { id: ID, status: n === 1 ? "pending" : "timeout" }));
    expect(await relayAddLiquidity({ wallet: a.wallet, authFetch: t.af, base: "http://x/amm", sleep: noSleep, now: () => 0 }, a.prepared, PEER)).toEqual({ status: "timeout", id: ID });
    expect(a.calls.at(-1)).toEqual({ method: "abortAction", args: { reference: "ref-1" } });

    const b = await add();
    const e = fakeRelay((fn) => ({ status: 404, body: { fn, error: { code: "unknown-fn", message: "amm.liquidity.submit is not provided" } } }));
    expect(await relayAddLiquidity({ wallet: b.wallet, authFetch: e.af, base: "http://x/amm", sleep: noSleep }, b.prepared, PEER)).toEqual({
      status: "failed",
      reason: "amm.liquidity.submit: unknown-fn: amm.liquidity.submit is not provided",
    });
    expect(b.calls.at(-1)).toEqual({ method: "abortAction", args: { reference: "ref-1" } });

    const c = await add();
    const lost: AuthFetchLike = { fetch: async () => { throw new Error("network down"); } };
    expect(await relayAddLiquidity({ wallet: c.wallet, authFetch: lost, base: "http://x/amm" }, c.prepared, PEER)).toEqual({ status: "unknown", reason: "amm.liquidity.submit: network down" });
    let now = 0;
    const pending = fakeRelay((fn) => ok(fn, { id: ID, status: "pending" }));
    expect(await relayAddLiquidity({ wallet: c.wallet, authFetch: pending.af, base: "http://x/amm", sleep: async () => void (now += 60_000), now: () => now }, c.prepared, PEER)).toEqual({
      status: "unknown",
      id: ID,
      reason: "still pending past the deposit's expiry",
    });
    expect(c.calls.some((x) => x.method === "abortAction")).toBe(false);
    const final = await validatorSigns(c.prepared, c.prepared.tx.toBinary());
    const later = fakeRelay((fn) => ok(fn, { id: ID, status: "accepted", tx: dagBytes(final.toBinary()), txid: final.id("hex") }));
    expect(await checkAddLiquidityAgain({ wallet: c.wallet, authFetch: later.af, base: "http://x/amm" }, c.prepared, ID)).toMatchObject({ status: "accepted", txid: final.id("hex"), completed: { internalized: true } });
  });
});

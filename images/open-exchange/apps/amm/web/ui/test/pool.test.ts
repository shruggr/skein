import { Hash, PrivateKey, Spend, Transaction, Utils } from "@bsv/sdk";
import { describe, expect, it } from "vitest";
import { PoolBuildError, PoolTemplate, p2pkhUnlock, type BuilderInput, type PoolUtxo } from "../src/pool";
import v from "./fixtures/amm-topic-vectors.json";

// Keys and transactions of programs/amm-topic/gen/main.go (see the fixture's _source).
const key = (n: number) => new PrivateKey(n.toString(16).padStart(2, "0").repeat(32), 16);
const identity = key(0x7f);
const lpKey = key(10);
const taker = key(30);
const anyone = new PrivateKey(1).toPublicKey();
const validatorKey = (txid: string, vout: number) => identity.deriveChild(anyone, `1-amm pool-${txid}_${vout}`);
const pkh = (k: PrivateKey) => Utils.toHex(k.toPublicKey().toHash() as number[]);
const pub = (k: PrivateKey) => k.toPublicKey().toString();

const fund = Transaction.fromHex(v.fund);
const tokenDeploy = Transaction.fromHex(v.token_deploy);
const poolDeploy = Transaction.fromHex(v.pool_deploy);
const swap1 = Transaction.fromHex(v.swap_bsv_in);
const swap2 = Transaction.fromHex(v.swap_tokens_in);
const close = Transaction.fromHex(v.close);
const closeFee = Transaction.fromHex(v.close_fee);
const assetId = Utils.toHex(tokenDeploy.hash() as number[]); // wire (internal) byte order

const poolUtxo = (tx: Transaction): PoolUtxo => ({
  txid: tx.id("hex"),
  vout: 0,
  satoshis: tx.outputs[0]!.satoshis!,
  script: tx.outputs[0]!.lockingScript,
  sourceTransaction: tx,
});
const input = (tx: Transaction, vout: number, k: PrivateKey): BuilderInput => {
  const o = tx.outputs[vout]!;
  return {
    txid: tx.id("hex"),
    vout,
    satoshis: o.satoshis!,
    lockingScript: o.lockingScript,
    sourceTransaction: tx,
    unlock: p2pkhUnlock(k, o.satoshis!, o.lockingScript),
  };
};

/** Input 0's unlocking script with argument push 1 (the first method arg) blanked, for a no-signature comparison. */
function verifyInput(tx: Transaction, i: number) {
  const src = tx.inputs[i]!.sourceTransaction!.outputs[tx.inputs[i]!.sourceOutputIndex]!;
  const spend = new Spend({
    sourceTXID: tx.inputs[i]!.sourceTXID!,
    sourceOutputIndex: tx.inputs[i]!.sourceOutputIndex,
    sourceSatoshis: src.satoshis!,
    lockingScript: src.lockingScript,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.filter((_, j) => j !== i),
    outputs: tx.outputs,
    inputIndex: i,
    unlockingScript: tx.inputs[i]!.unlockingScript!,
    inputSequence: tx.inputs[i]!.sequence!,
    lockTime: tx.lockTime,
  });
  return spend.validate();
}

describe("PoolTemplate.decode", () => {
  const pools = [
    { tx: poolDeploy, p: v.pool0, lp: lpKey },
    { tx: swap1, p: v.pool1, lp: lpKey },
    { tx: swap2, p: v.pool2, lp: lpKey },
  ];
  it.each(pools.map((x, i) => [i, x] as const))("pool%i", (_, { tx, p, lp }) => {
    const pool = PoolTemplate.decode(tx.outputs[0]!.lockingScript)!;
    expect(pool).not.toBeNull();
    expect(tx.outputs[0]!.satoshis).toBe(p.bsv);
    expect(pool.args).toEqual({ assetId, lpFeeBps: BigInt(v.lpFeeBps), validatorFeeBps: BigInt(v.validatorFeeBps), commissionBps: BigInt(v.commissionBps) });
    expect(pool.state).toEqual({ tokenReserve: BigInt(p.tokens), lpPubKey: pub(lp), validatorPubKey: p.validator, validatorIdentity: v.identity });
  });

  it("returns null for every non-pool output", () => {
    for (const tx of [fund, tokenDeploy, poolDeploy, swap1, swap2, close, closeFee]) {
      tx.outputs.forEach((o, i) => {
        if (i === 0 && tx !== fund && tx !== tokenDeploy) return;
        expect(PoolTemplate.decode(o.lockingScript)).toBeNull();
      });
    }
  });

  it("refuses a prefix that disagrees with the state", () => {
    const hex = poolDeploy.outputs[0]!.lockingScript.toHex();
    // 5,000,000 is pushed as 03 404b4c; change the prefix amount only.
    expect(hex.slice(66, 74)).toBe("03404b4c");
    expect(PoolTemplate.decode(hex.slice(0, 66) + "03414b4c" + hex.slice(74))).toBeNull();
  });
});

describe("PoolTemplate.lockDeploy", () => {
  it("rebuilds pool_deploy's pool output", () => {
    const pool = PoolTemplate.decode(poolDeploy.outputs[0]!.lockingScript)!;
    expect(PoolTemplate.lockDeploy(pool.args, pool.state).toHex()).toBe(poolDeploy.outputs[0]!.lockingScript.toHex());
  });
});

describe("rebuilding the fixtures", () => {
  it("swap_bsv_in: byte for byte, validator signing after the taker", async () => {
    const call = await PoolTemplate.swap({
      pool: poolUtxo(poolDeploy),
      inputs: [input(fund, 1, taker)],
      amountIn: 20_000n,
      bsvIn: true,
      userPkh: pkh(taker),
      commissionPkh: v.commissionPkh,
      changePkh: pkh(taker),
      fee: { sats: 499 }, // gen/main.go: change = funding - amountIn - 500, but the 1-sat token payout also comes out of the funding
    });
    expect(call.next!.pool.state.validatorPubKey).toBe(v.pool1.validator);
    expect(call.swap!.amountOut).toBe(BigInt(v.swapBsvInTokensOut));
    expect(call.swap!.commission).toBe(20n); // ceil(20,000 × 10 / 10,000)
    expect(call.tx.outputs[4]!.lockingScript.toHex()).toBe(`76a914${v.commissionPkh}88ac`);
    expect(call.unsigned).toEqual(["validator"]);
    // Everything but the validator's slot already matches.
    expect(call.tx.outputs.map((o) => [o.satoshis, o.lockingScript.toHex()])).toEqual(
      swap1.outputs.map((o) => [o.satoshis, o.lockingScript.toHex()]),
    );
    expect(call.tx.inputs[1]!.unlockingScript!.toHex()).toBe(swap1.inputs[1]!.unlockingScript!.toHex());
    // Pool 0's validator key is keyed by the LP's first token input, token_deploy:0.
    await PoolTemplate.signPoolInput(call, "validator", validatorKey(tokenDeploy.id("hex"), 0));
    expect(call.unsigned).toEqual([]);
    expect(call.tx.toHex()).toBe(v.swap_bsv_in);
    expect(verifyInput(call.tx, 0)).toBe(true);
  });

  it("swap_tokens_in: byte for byte", async () => {
    const call = await PoolTemplate.swap({
      pool: poolUtxo(swap1),
      inputs: [input(poolDeploy, 1, taker), input(fund, 2, taker)],
      amountIn: 50_000n,
      bsvIn: false,
      userPkh: pkh(taker),
      commissionPkh: v.commissionPkh,
      changePkh: pkh(taker),
      fee: { sats: 500 },
    });
    expect(call.next!.pool.state.validatorPubKey).toBe(v.pool2.validator);
    await PoolTemplate.signPoolInput(call, "validator", validatorKey(poolDeploy.id("hex"), 0));
    expect(call.tx.toHex()).toBe(v.swap_tokens_in);
  });

  it("close, bsvFee 0: byte for byte, LP-signed, the fee and the token output's sat from another input, Rúnar's change after (0.9.0)", async () => {
    const call = await PoolTemplate.close({
      pool: poolUtxo(swap2),
      inputs: [input(fund, 3, lpKey)],
      bsvFee: 0n,
      lpKey,
      changePkh: pkh(lpKey),
      fee: { sats: 600 },
    });
    expect(call.unsigned).toEqual([]);
    expect(call.next).toBeNull();
    expect(call.tx.toHex()).toBe(v.close);
    expect(verifyInput(call.tx, 0)).toBe(true);
  });

  it("close, bsvFee 1,000: byte for byte, the fee left from the pool's sats, no other input", async () => {
    const plan = PoolTemplate.planClose({ pool: poolUtxo(swap2), bsvFee: BigInt(v.closeFee) });
    expect(plan.outputs.map((o) => o.satoshis)).toEqual([BigInt(v.pool2.bsv - v.closeFee), 1n]);
    const call = await PoolTemplate.close({ pool: poolUtxo(swap2), inputs: [], bsvFee: BigInt(v.closeFee), lpKey, changePkh: pkh(lpKey), fee: { sats: v.closeFee - 1 } });
    expect(call.tx.toHex()).toBe(v.close_fee);
    expect(verifyInput(call.tx, 0)).toBe(true);
  });

  it("close: bsvFee the whole pool leaves the tokens only; over it, or negative, is refused", () => {
    const sats = BigInt(v.pool2.bsv);
    expect(PoolTemplate.planClose({ pool: poolUtxo(swap2), bsvFee: sats }).outputs).toHaveLength(1);
    expect(() => PoolTemplate.planClose({ pool: poolUtxo(swap2), bsvFee: sats + 1n })).toThrow(PoolBuildError);
    expect(() => PoolTemplate.planClose({ pool: poolUtxo(swap2), bsvFee: -1n })).toThrow(PoolBuildError);
  });

  it("a fee rate: the interpreter accepts the finished swap", async () => {
    const call = await PoolTemplate.swap({
      pool: poolUtxo(poolDeploy),
      inputs: [input(fund, 1, taker)],
      amountIn: 20_000n,
      bsvIn: true,
      userPkh: pkh(taker),
      commissionPkh: v.commissionPkh,
      changePkh: pkh(taker),
      fee: { satsPerKb: 100 },
    });
    await PoolTemplate.signPoolInput(call, "validator", validatorKey(tokenDeploy.id("hex"), 0));
    expect(call.tx.outputs).toHaveLength(6);
    // The estimate sizes each signature at its maximum DER length: exact, or a byte or two over.
    const size = call.tx.toBinary().length;
    expect(call.fee).toBeGreaterThanOrEqual(Math.ceil((size * 100) / 1000));
    expect(call.fee).toBeLessThanOrEqual(Math.ceil(((size + 4) * 100) / 1000));
    expect(verifyInput(call.tx, 0)).toBe(true);
    expect(verifyInput(call.tx, 1)).toBe(true);
  });

  it("refuses to sign a slot with a key that is not the pool's", async () => {
    const call = await PoolTemplate.swap({
      pool: poolUtxo(poolDeploy),
      inputs: [input(fund, 1, taker)],
      amountIn: 20_000n,
      bsvIn: true,
      userPkh: pkh(taker),
      commissionPkh: v.commissionPkh,
      changePkh: pkh(taker),
      fee: { sats: 499 },
    });
    await expect(PoolTemplate.signPoolInput(call, "validator", validatorKey(poolDeploy.id("hex"), 0))).rejects.toThrow(/not the pool's/);
    await expect(PoolTemplate.signPoolInput(call, "lp", lpKey)).rejects.toThrow(/no lp signature/);
  });

  it("the sighash is sha256d of the preimage, and preimage() recomputes it", async () => {
    const call = await PoolTemplate.swap({
      pool: poolUtxo(poolDeploy),
      inputs: [input(fund, 1, taker)],
      amountIn: 20_000n,
      bsvIn: true,
      userPkh: pkh(taker),
      commissionPkh: v.commissionPkh,
      changePkh: pkh(taker),
      fee: { sats: 500 },
    });
    expect(PoolTemplate.preimage(call.tx)).toBe(call.preimage);
    expect(call.sighash).toBe(Utils.toHex(Hash.hash256(Utils.toArray(call.preimage, "hex")) as number[]));
  });
});

describe("the builder's own checks", () => {
  const base = {
    inputs: [input(fund, 1, taker)],
    amountIn: 20_000n,
    bsvIn: true,
    userPkh: pkh(taker),
    commissionPkh: v.commissionPkh,
    changePkh: pkh(taker),
    fee: { sats: 500 },
  };
  const refusal = async (p: Promise<unknown>) => {
    const err = await p.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PoolBuildError);
    return (err as PoolBuildError).code;
  };

  it("refuses a leg priced at the wrong fee", async () => {
    expect(await refusal(PoolTemplate.swap({ ...base, pool: poolUtxo(poolDeploy), expect: { lpFeeBps: 25n } }))).toBe("fee_mismatch");
    expect(await refusal(PoolTemplate.swap({ ...base, pool: poolUtxo(poolDeploy), expect: { lpFee: 59n, validatorFee: 10n } }))).toBe("fee_mismatch");
  });

  it("refuses a pool output older than the state the leg was priced against", async () => {
    // Priced against pool1 (after swap_bsv_in), built on pool_deploy's spent output.
    const stale = { bsvReserve: BigInt(v.pool1.bsv), tokenReserve: BigInt(v.pool1.tokens) };
    expect(await refusal(PoolTemplate.swap({ ...base, pool: poolUtxo(poolDeploy), expect: stale }))).toBe("stale_pool");
  });

  it("refuses token inputs that do not match the swap", async () => {
    expect(
      await refusal(PoolTemplate.swap({ ...base, pool: poolUtxo(swap1), bsvIn: false, inputs: [input(fund, 2, taker)], amountIn: 50_000n })),
    ).toBe("token_mismatch");
  });

  it("refuses an underfunded call", async () => {
    expect(await refusal(PoolTemplate.swap({ ...base, pool: poolUtxo(poolDeploy), amountIn: 600_000n }))).toBe("insufficient_funds");
  });
});

describe("PoolTemplate.planSwap: the commission output", () => {
  const zeroCommission = (): PoolUtxo => {
    const pool = PoolTemplate.decode(poolDeploy.outputs[0]!.lockingScript)!;
    const script = PoolTemplate.lockDeploy({ ...pool.args, commissionBps: 0n }, pool.state);
    return { txid: poolDeploy.id("hex"), vout: 0, satoshis: v.pool0.bsv, script };
  };
  const relay = v.commissionPkh;

  it("sats in, 10 bps: pool, token payout, LP fee, validator fee, commission in sats to commissionPkh", () => {
    const plan = PoolTemplate.planSwap({ pool: poolUtxo(poolDeploy), amountIn: 20_000n, bsvIn: true, userPkh: pkh(taker), commissionPkh: relay });
    expect(plan.swap).toEqual({ amountOut: BigInt(v.swapBsvInTokensOut), lpFee: 60n, validatorFee: 10n, commission: 20n });
    expect(plan.outputs).toHaveLength(5);
    expect(plan.outputs[4]).toEqual({ satoshis: 20n, script: `76a914${relay}88ac` });
    expect(plan.outputs.map((o) => [o.satoshis, o.script])).toEqual(swap1.outputs.slice(0, 5).map((o) => [BigInt(o.satoshis!), o.lockingScript.toHex()]));
    expect(plan.args[5]).toBe(relay);
    expect(plan.args).toHaveLength(6);
    expect(plan.next.pool.args.commissionBps).toBe(10n);
  });

  it("tokens in, 10 bps: the commission is a 1-sat Mandala output of the token", () => {
    const plan = PoolTemplate.planSwap({ pool: poolUtxo(swap1), amountIn: 50_000n, bsvIn: false, userPkh: pkh(taker), commissionPkh: relay });
    expect(plan.swap.commission).toBe(50n);
    expect(plan.outputs).toHaveLength(5);
    expect(plan.outputs[4]!.satoshis).toBe(1n);
    expect(plan.outputs.map((o) => [o.satoshis, o.script])).toEqual(swap2.outputs.slice(0, 5).map((o) => [BigInt(o.satoshis!), o.lockingScript.toHex()]));
  });

  it("0 bps: no commission output, commissionPkh still pushed", () => {
    const plan = PoolTemplate.planSwap({ pool: zeroCommission(), amountIn: 20_000n, bsvIn: true, userPkh: pkh(taker), commissionPkh: relay });
    expect(plan.pool.args.commissionBps).toBe(0n);
    expect(plan.swap.commission).toBe(0n);
    expect(plan.outputs).toHaveLength(4);
    expect(plan.outputs.some((o) => o.script.includes(relay))).toBe(false);
    expect(plan.args[5]).toBe(relay);
    // More of amountIn enters the pool than at 10 bps.
    expect(plan.swap.amountOut).toBeGreaterThan(BigInt(v.swapBsvInTokensOut));
  });

  it("refuses a malformed commissionPkh and a leg priced at another commission", () => {
    expect(() => PoolTemplate.planSwap({ pool: poolUtxo(poolDeploy), amountIn: 20_000n, bsvIn: true, userPkh: pkh(taker), commissionPkh: "00" })).toThrow(PoolBuildError);
    expect(() =>
      PoolTemplate.planSwap({ pool: poolUtxo(poolDeploy), amountIn: 20_000n, bsvIn: true, userPkh: pkh(taker), commissionPkh: relay, expect: { commissionBps: 0n } }),
    ).toThrow(/fee_mismatch/);
    expect(() =>
      PoolTemplate.planSwap({ pool: poolUtxo(poolDeploy), amountIn: 20_000n, bsvIn: true, userPkh: pkh(taker), commissionPkh: relay, expect: { commission: 19n } }),
    ).toThrow(/fee_mismatch/);
  });
});

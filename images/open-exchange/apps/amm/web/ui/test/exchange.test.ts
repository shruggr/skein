/**
 * src/data/exchange.ts, wired (skein-amm 0.9.0): each function against a
 * fake instance (the routes it reads: listTopicManagers, /mandala/tokens,
 * the liveness reads, /lookup, /requests, /spends, /call, /sendMessage) and
 * a fake wallet, over the Go fixtures (src/fixtures/vectors.zig's copy).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Beef, Transaction, Utils, type WalletInterface } from "@bsv/sdk";
import { decode, encode } from "cbor2";
import { P1SAT_PROTOCOL } from "@1sat/actions";
import {
  closePosition,
  connectAction,
  deployPosition,
  deregisterToken,
  discoveryTokens,
  executeSwap,
  hostedTokens,
  isRoot,
  listingRequests,
  lookupOf,
  myPositions,
  myTokens,
  onDataChange,
  quoteSwap,
  registerToken,
  registeredTokens,
  requestListing,
  setExchangeContext,
  subscribePrices,
  tokenPools,
  topicOf,
  validatorTerms,
  walletSats,
} from "../src/data/exchange";
import { REFRESH_MS } from "../src/lib/config";
import { PendingPayoutStore } from "../src/wallet/pendingPayouts";
import { compactSats, fmtAmount, fmtChange, fmtPrice, parseInput } from "../src/ox/format";
import { parseRoute, routeHref } from "../src/ox/route";
import { PEER } from "./liveRead";
import v from "./fixtures/amm-topic-vectors.json";

const OUTPOINT = /^[0-9a-f]{64}\.\d+$/;
const BASE = "http://alice.localhost:8300/amm";
const tokenDeploy = Transaction.fromHex(v.token_deploy);
const fund = Transaction.fromHex(v.fund);
const poolDeploy = Transaction.fromHex(v.pool_deploy);
const swap1 = Transaction.fromHex(v.swap_bsv_in);
const DEPLOY = tokenDeploy.id("hex");
const TOKEN = `${DEPLOY}_0`;
const TOPIC = `tm_mandala_${TOKEN}`;
const OTHER = `${"cd".repeat(32)}_0`;
const ME = "02" + "11".repeat(32);
const V2 = "03" + "22".repeat(32);
const SKEIN = v.identity;

const b64 = (b: Uint8Array) => Utils.toBase64(Array.from(b));
const beat = (sender: string, at: number, body: unknown) => ({ sender, at, from: PEER, body: b64(encode(body, { cde: true })) });
function atomic(tx: Transaction, ancestors: Transaction[]): number[] {
  const b = new Beef();
  for (const a of ancestors) b.mergeRawTx(a.toBinary());
  b.mergeRawTx(tx.toBinary());
  return b.toBinaryAtomic(tx.id("hex"));
}
const wirePool = (txid: string, p: { bsv: number; tokens: number }) => ({ outpoint: `${txid}_0`, bsvReserve: p.bsv, tokenReserve: p.tokens, liquidityFeeBps: 30, validationFeeBps: 5, commissionBps: 10, validatorIdentityKey: SKEIN });

/** The instance: a route table over plain fetch and the wallet's signed fetch alike. */
interface Instance {
  topics: Record<string, unknown>;
  tokens: unknown[];
  live: Record<string, unknown[]>;
  pools: Record<string, unknown[]>;
  requests: unknown[];
  spends: Record<string, unknown>;
  mandala: Record<string, unknown>;
  sent: { url: string; body: Record<string, unknown> }[];
  calls: { fn: string; args: unknown }[];
  terms: Record<string, unknown>;
}

function instance(): Instance {
  return {
    topics: { [TOPIC]: { name: "Mandala" }, tm_mandala: { name: "Mandala discovery" } },
    tokens: [
      { tokenId: TOKEN, topic: TOPIC, sym: "TST", dec: 0, txid: DEPLOY, vout: 0 },
      { tokenId: OTHER, topic: `tm_mandala_${OTHER}`, sym: "OTH", dec: 2, txid: OTHER.slice(0, 64), vout: 0 },
    ],
    live: {
      // ls_amm's beats: this skein's own (its pools of the token), and another skein naming a validator that is not live.
      "ls_amm-live": [
        beat(SKEIN, 2_000, { tokens: { [TOKEN]: { [SKEIN]: { sats: 1_000_000, tokens: 5_000_000, pools: 1 } } } }),
        beat(ME, 1_000, { tokens: { [TOKEN]: { [SKEIN]: { sats: 1, tokens: 1, pools: 1 }, [V2]: { sats: 600, tokens: 300, pools: 1 } } } }),
      ],
      [`${TOPIC}-live`]: [{ sender: SKEIN, at: Date.now(), from: PEER, body: "" }],
    },
    pools: { [TOKEN]: [wirePool(poolDeploy.id("hex"), v.pool0)] },
    requests: [
      { tokenId: OTHER, from: ME, at: 300 },
      { tokenId: `${"ef".repeat(32)}_0`, from: V2, at: 400 },
    ],
    spends: {},
    mandala: {},
    sent: [],
    calls: [],
    terms: { validator: { "/": { bytes: Utils.toBase64(Utils.toArray(SKEIN, "hex")).replace(/=+$/, "") } }, peerId: PEER, lpFeeBps: 30, validatorFeeBps: 5, commissionBps: 0 },
  };
}

let inst: Instance;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function route(url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }): Promise<Response> {
  const u = new URL(url);
  const path = u.pathname.replace(/^\/amm/, "");
  if (path === "/listTopicManagers") return json(inst.topics);
  if (path === "/mandala/tokens") return json(inst.tokens);
  if (path.startsWith("/.live/")) {
    const t = decodeURIComponent(path.slice(7));
    return t in inst.live ? json(inst.live[t]) : json({}, 404);
  }
  if (path === "/requests") return json(inst.requests);
  if (path === "/spends") return json(inst.spends[u.searchParams.get("outpoint")!] ?? { outpoint: u.searchParams.get("outpoint"), hops: 0, closed: false });
  if (path === "/lookup") {
    const q = JSON.parse(String(init!.body)) as { service: string; query: Record<string, unknown> };
    if (q.service === "ls_amm") return json({ type: "freeform", result: inst.pools[String(q.query.tokenId)] ?? [] });
    if (q.service === "ls_mandala") return json(inst.mandala[`${q.query.txid}.${q.query.outputIndex}`] ?? { type: "output-list", outputs: [] });
  }
  if (path === "/call") {
    const b = JSON.parse(String(init!.body)) as { fn: string; args: unknown };
    inst.calls.push(b);
    if (b.fn === "amm.pool.terms") return json({ fn: b.fn, result: inst.terms });
    if (b.fn === "amm.swap.terms") return json({ fn: b.fn, result: { commissionPkh: null } });
  }
  if (u.pathname === "/sendMessage") {
    inst.sent.push({ url, body: decode(init!.body as Uint8Array) as Record<string, unknown> });
    return new Response(encode({ status: "success", id: `msg${inst.sent.length}` }) as BodyInit, { status: 200 });
  }
  return json({ error: `no route ${url}` }, 404);
}

/** A fake wallet: its token rows (`bsv21`), a default basket, its identity. */
function fakeWallet(rows: unknown[] = [], sats: number[] = [1_000, 2_500]): WalletInterface {
  return {
    async listOutputs(args: { basket: string; tags?: string[] }) {
      if (args.basket === "default") return { totalOutputs: sats.length, outputs: sats.map((s, i) => ({ outpoint: `${"aa".repeat(32)}.${i}`, satoshis: s, spendable: true })) };
      if (args.basket === "bsv21" && !args.tags) return { totalOutputs: rows.length, outputs: rows };
      return { totalOutputs: 0, outputs: [] };
    },
    async listActions() {
      return { totalActions: 0, actions: [] };
    },
    async getPublicKey() {
      return { publicKey: ME };
    },
  } as unknown as WalletInterface;
}

const af = { fetch: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => route(url, init) };

beforeEach(() => {
  inst = instance();
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => route(url, init as never));
  setExchangeContext({ base: BASE, wallet: null, af: null, identityKey: null, payouts: new PendingPayoutStore(null) });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const connect = (rows?: unknown[]) => setExchangeContext({ wallet: fakeWallet(rows), af: af as never, identityKey: ME });

describe("exchange.ts, wired", () => {
  it("hostedTokens: the registered Mandala tokens, priced from ls_amm's beats over the live validators (each validator's own report first); a token no beat reports, from this skein's listing", async () => {
    inst.topics[`tm_mandala_${OTHER}`] = {};
    inst.pools[OTHER] = [];
    const ts = await hostedTokens();
    expect(ts.map((t) => [t.tokenId, t.sym, t.dec])).toEqual([
      [TOKEN, "TST", 0],
      [OTHER, "OTH", 2],
    ]);
    const t = ts[0]!;
    // SKEIN's own report (1,000,000 / 5,000,000), not ME's of SKEIN; V2 is no live sender: left out.
    expect(t.reserves).toEqual({ sats: 1_000_000n, tokens: 5_000_000n });
    expect(t.pools).toBe(1);
    expect(t.marginalPrice).toBeCloseTo(0.2, 9);
    expect(t.depth!.sats).toBeGreaterThan(0n);
    // No beat, no listed pool: no price.
    expect(ts[1]).toMatchObject({ marginalPrice: null, pools: 0, reserves: { sats: 0n, tokens: 0n } });
  });

  it("subscribePrices: polls every REFRESH_MS and after an action (onDataChange); unsubscribed, it stops", async () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const off = subscribePrices((u) => seen.push(`${u.tokenId}:${u.reserves.sats}`));
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(seen).toEqual([`${TOKEN}:1000000`]);
    inst.live["ls_amm-live"] = [beat(SKEIN, 3_000, { tokens: { [TOKEN]: { [SKEIN]: { sats: 2_000_000, tokens: 5_000_000, pools: 1 } } } })];
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(seen.at(-1)).toBe(`${TOKEN}:2000000`);
    off();
    await vi.advanceTimersByTimeAsync(REFRESH_MS * 3);
    expect(seen).toHaveLength(2);
    const changes: number[] = [];
    const off2 = onDataChange(() => changes.push(1));
    off2();
  });

  it("tokenPools: this skein's listed pools, outpoints dotted, each validator live or not", async () => {
    const ps = await tokenPools(TOKEN);
    expect(ps).toEqual([{ outpoint: `${poolDeploy.id("hex")}.0`, tokenId: TOKEN, sats: BigInt(v.pool0.bsv), tokens: BigInt(v.pool0.tokens), validator: { identityKey: SKEIN, live: true } }]);
    inst.live[`${TOPIC}-live`] = [];
    expect((await tokenPools(TOKEN))[0]!.validator.live).toBe(false);
  });

  it("quoteSwap: the matching engine's plan over the live pools; a buy pays above marginal, a sell gets below; no live validator: refused", async () => {
    const buy = await quoteSwap({ tokenId: TOKEN, side: "buy", amountIn: 20_000n, maxSlippageBps: 100, allowPartial: false });
    expect(buy.legs).toHaveLength(1);
    expect(buy.legs[0]!.poolOutpoint).toMatch(OUTPOINT);
    expect(buy.legs[0]!.amountIn).toBe(20_000n);
    expect(buy.amountOut).toBe(BigInt(v.swapBsvInTokensOut));
    expect(buy.minAmountOut).toBeLessThanOrEqual(buy.amountOut);
    expect(buy.effectivePrice).toBeGreaterThan(buy.marginalPrice);
    expect(buy.fees).toEqual({ lpBps: 30, validatorBps: 5, commissionBps: 10 });
    const sell = await quoteSwap({ tokenId: TOKEN, side: "sell", amountIn: 50_000n, maxSlippageBps: 100, allowPartial: false });
    expect(sell.effectivePrice).toBeLessThan(sell.marginalPrice);
    inst.live[`${TOPIC}-live`] = [];
    await expect(quoteSwap({ tokenId: TOKEN, side: "buy", amountIn: 20_000n, maxSlippageBps: 100, allowPartial: false })).rejects.toThrow(/validator/);
  });

  it("executeSwap: needs a wallet; a planned pool spent since the quote stops it (no partial fills)", async () => {
    const q = await quoteSwap({ tokenId: TOKEN, side: "buy", amountIn: 20_000n, maxSlippageBps: 100, allowPartial: false });
    await expect(executeSwap(q)).rejects.toThrow(/Connect a wallet/);
    connect();
    inst.pools[TOKEN] = [];
    await expect(executeSwap(q)).rejects.toThrow(/spent since the quote/);
  });

  it("walletSats: the default basket's spendable sats", async () => {
    connect();
    expect(await walletSats()).toBe(3_500n);
  });

  it("myPositions: the wallet's pool rows read from the chain state — followed to the current output (its BEEF from ls_mandala), the claim spent = rescinded; closed ones left out", async () => {
    const pd = poolDeploy.id("hex");
    const row = {
      outpoint: `${pd}.0`,
      satoshis: v.pool0.bsv,
      lockingScript: poolDeploy.outputs[0]!.lockingScript.toHex(),
      tags: [`bsv21:${TOKEN}`, "amm-pool"],
      customInstructions: JSON.stringify({ id: TOKEN, op: "amm-pool", protocolID: [2, "3241645161d8"], keyID: "lp key", counterparty: "self", amm: { claimVout: v.claimVout } }),
    };
    connect([row]);
    inst.spends[`${pd}.0`] = { outpoint: `${pd}.0`, spentBy: swap1.id("hex"), current: `${swap1.id("hex")}.0`, hops: 1, closed: false };
    inst.spends[`${pd}.${v.claimVout}`] = { outpoint: `${pd}.${v.claimVout}`, spentBy: "ab".repeat(32), hops: 0, closed: false };
    inst.mandala[`${swap1.id("hex")}.0`] = { type: "output-list", outputs: [{ beef: atomic(swap1, [fund, tokenDeploy, poolDeploy]), outputIndex: 0 }] };
    const ps = await myPositions();
    expect(ps).toEqual([
      {
        outpoint: `${swap1.id("hex")}.0`,
        tokenId: TOKEN,
        sym: "TST",
        dec: 0,
        sats: BigInt(v.pool1.bsv),
        tokens: BigInt(v.pool1.tokens),
        validator: { identityKey: SKEIN, live: true },
        rescinded: true,
      },
    ]);
    // Closed: gone from the list; and a close of a position not held is refused.
    inst.spends[`${pd}.0`] = { outpoint: `${pd}.0`, hops: 2, closed: true };
    expect(await myPositions()).toEqual([]);
    await expect(closePosition({ outpoint: `${swap1.id("hex")}.0`, bsvFee: 0n })).rejects.toThrow(/No such position/);
  });

  it("validatorTerms: amm.pool.terms on /call — this skein's validator, its fees (read-only)", async () => {
    connect();
    expect(await validatorTerms()).toEqual({ validator: { identityKey: SKEIN, live: true }, isThisExchange: true, fees: { lpBps: 30, validatorBps: 5, commissionBps: 0 } });
    expect(inst.calls).toEqual([{ fn: "amm.pool.terms", args: {} }]);
  });

  it("deployPosition: delivered to this skein's validator at its terms; refused without its peer, without the token, or short of the deposit and the claim's unit", async () => {
    await expect(deployPosition({ tokenId: TOKEN, tokens: 1n, sats: 1n })).rejects.toThrow(/Connect a wallet/);
    const deployRow = {
      outpoint: `${DEPLOY}.0`,
      satoshis: 1,
      lockingScript: tokenDeploy.outputs[0]!.lockingScript.toHex(),
      tags: ["bsv21:deploy"],
      customInstructions: JSON.stringify({ amt: "10000000", op: "deploy+mint", protocolID: P1SAT_PROTOCOL, keyID: "bsv21-deploy-TST-00" }),
    };
    connect([]);
    await expect(deployPosition({ tokenId: TOKEN, tokens: 0n, sats: 1n })).rejects.toThrow(/more than 0/);
    await expect(deployPosition({ tokenId: TOKEN, tokens: 5n, sats: 1_000n })).rejects.toThrow(/holds none/);
    connect([deployRow]);
    await expect(deployPosition({ tokenId: TOKEN, tokens: 10_000_000n, sats: 1_000n })).rejects.toThrow(/fewer than 10000001/);
    delete inst.terms.peerId;
    await expect(deployPosition({ tokenId: TOKEN, tokens: 5n, sats: 1_000n })).rejects.toThrow(/no peer ID/);
  });

  it("myTokens: the wallet's Mandala tokens with a balance, on this exchange (registered) and requested (by this wallet)", async () => {
    const deployRow = {
      outpoint: `${DEPLOY}.0`,
      satoshis: 1,
      lockingScript: tokenDeploy.outputs[0]!.lockingScript.toHex(),
      tags: ["bsv21:deploy"],
      customInstructions: JSON.stringify({ amt: "10000000", op: "deploy+mint", protocolID: P1SAT_PROTOCOL, keyID: "k" }),
    };
    connect([deployRow]);
    const ts = await myTokens();
    expect(ts).toHaveLength(1);
    expect(ts[0]).toMatchObject({ tokenId: TOKEN, balance: 10_000_000n, outputs: 1, onExchange: true, requested: false });
  });

  it("requestListing: a message {fn: request, args: {tokenId}} to <app>/requests, BRC-104-signed, the skein's identity the recipient", async () => {
    connect();
    let changed = 0;
    const off = onDataChange(() => changed++);
    await requestListing(OTHER);
    off();
    expect(changed).toBe(1);
    expect(inst.sent).toHaveLength(1);
    const m = inst.sent[0]!;
    expect(m.url).toBe("http://alice.localhost:8300/sendMessage");
    const msg = m.body.message as { recipient: Uint8Array; messageBox: string; body: Uint8Array };
    expect(Utils.toHex(Array.from(msg.recipient))).toBe(SKEIN);
    expect(msg.messageBox).toBe("amm/requests");
    expect(decode(msg.body)).toEqual({ fn: "request", args: { tokenId: OTHER } });
  });

  it("registerToken / deregisterToken: root's messages to <app>/register — the topic, its lookup and ls_amm (so the prices beat); then the lookup and the topic", async () => {
    connect();
    await registerToken(OTHER);
    await deregisterToken(OTHER);
    const bodies = inst.sent.map((s) => {
      const msg = s.body.message as { messageBox: string; body: Uint8Array };
      expect(msg.messageBox).toBe("amm/register");
      return decode(msg.body);
    });
    const topic = `tm_mandala_${OTHER}`;
    expect(bodies).toEqual([
      { fn: "register", args: { topic, program: "mandala-topic" } },
      { fn: "registerLookup", args: { service: `ls_mandala_${OTHER}`, program: "mandala-lookup", topics: [topic] } },
      { fn: "registerLookup", args: { service: "ls_amm", program: "amm-lookup" } },
      { fn: "deregisterLookup", args: { service: `ls_mandala_${OTHER}` } },
      { fn: "deregister", args: { topic } },
    ]);
  });

  it("discoveryTokens, registeredTokens, listingRequests: the token list less the registered, the registered, the requests newest first", async () => {
    expect(await discoveryTokens()).toEqual([{ tokenId: OTHER, sym: "OTH", dec: 2 }]);
    expect(await registeredTokens()).toEqual([{ tokenId: TOKEN, sym: "TST" }]);
    expect(await listingRequests()).toEqual([
      { tokenId: `${"ef".repeat(32)}_0`, sym: "efefefef", from: V2, at: 400 },
      { tokenId: OTHER, sym: "OTH", from: ME, at: 300 },
    ]);
  });

  it("isRoot: a stub (no grants read): any connected wallet", async () => {
    expect(await isRoot(ME)).toBe(true);
    expect(await isRoot(null)).toBe(false);
  });

  it("topic and lookup names are derived from the assetId (BRC-207: tm_mandala_<txid>_<vout>, `_0` included)", () => {
    const t = "cd".repeat(32);
    expect(topicOf(`${t}_0`)).toBe(`tm_mandala_${t}_0`);
    expect(lookupOf(`${t}_0`)).toBe(`ls_mandala_${t}_0`);
    expect(topicOf(`${t}_2`)).toBe(`tm_mandala_${t}_2`);
  });
});

describe("formats and routes", () => {
  it("formats amounts, sats, prices and changes", () => {
    expect(fmtAmount(120_450n, 2)).toBe("1,204.5");
    expect(fmtAmount(5_000n, 0)).toBe("5,000");
    expect(compactSats(1_240_000n)).toBe("1.24M");
    expect(compactSats(480_000n)).toBe("480k");
    expect(compactSats(80_000n)).toBe("80,000");
    expect(fmtPrice(1250)).toBe("1,250");
    expect(fmtPrice(411.96)).toBe("412.0");
    expect(fmtChange(0.018)).toBe("+1.8%");
    expect(fmtChange(-0.004)).toBe("−0.4%");
    expect(fmtChange(0)).toBe("0.0%");
    expect(parseInput("250,000", 0)).toBe(250_000n);
    expect(parseInput("1.5", 0)).toBeNull();
  });

  it("hash routes round-trip", () => {
    const id = `${"ef".repeat(32)}_0`;
    expect(parseRoute(routeHref({ page: "swap", tokenId: id }))).toEqual({ page: "swap", tokenId: id });
    expect(parseRoute("#/liquidity")).toEqual({ page: "liquidity" });
    expect(parseRoute("")).toEqual({ page: "landing" });
    expect(parseRoute("#/nope")).toEqual({ page: "landing" });
  });
});

describe("connectAction (0.9.1: the connect dialog listed nothing)", () => {
  it("auto-detects the wallet when no providers are configured", async () => {
    let opened = 0, connected = 0;
    expect(connectAction(0, () => { opened++; }, async () => { connected++; })).toBe("auto");
    expect(opened).toBe(0); expect(connected).toBe(1);
  });
  it("opens the dialog when providers are configured", () => {
    let opened = 0, connected = 0;
    expect(connectAction(2, () => { opened++; }, async () => { connected++; })).toBe("dialog");
    expect(opened).toBe(1); expect(connected).toBe(0);
  });
  it("swallows a failed auto-connect (the wallet shows its own error)", () => {
    expect(connectAction(0, () => {}, async () => { throw new Error("no wallet"); })).toBe("auto");
  });
});

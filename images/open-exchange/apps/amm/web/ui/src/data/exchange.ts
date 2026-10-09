/**
 * Open Exchange: every read and every action the pages make, in one typed
 * module (shruggr/skein#147; wired in skein-amm 0.9.0). The pages import from
 * here and nowhere else in the data layer.
 *
 * Where each comes from:
 *
 * - **Prices** (`hostedTokens`, `subscribePrices`): the AMM lookup's beats
 *   (skein-overlay 0.12.0, David Case 2026-10-09: "Pricing lives in the AMM
 *   LOOKUP's own beacon"): `GET <base>/.live/ls_amm-live`, each live skin's
 *   per-token, per-validator totals of its listed pools, combined here over
 *   the live validators (src/market/prices.ts); a token no beat reports
 *   falls back to this skein's own listing (`ls_amm`) and liveness. Polled
 *   every `REFRESH_MS` (the beats live in the host's liveness, not in the
 *   log: no event stream carries them).
 * - **Swap** (`quoteSwap`, `executeSwap`): the matching engine's plan over
 *   this skein's listed pools whose validator is live (src/market/plan.ts),
 *   each leg built, relayed and settled as before (src/market/swapAction.ts,
 *   swapFlow.ts; `amm.swap.submit` on `/call`).
 * - **Liquidity**: `myPositions` from the wallet's pool rows and the chain
 *   state by outpoint (src/lp/positions.ts: the pool followed to its current
 *   output, the claim spent = rescinded); `deployPosition` delivers the
 *   deploy to this skein's validator (src/lp/poolDeploy.ts, deployFlow.ts;
 *   `amm.pool.terms`, `amm.pool.submit`); `closePosition` closes it
 *   (src/lp/close.ts, `POST /submit`).
 * - **Your tokens**: the wallet's token rows (src/lp/wallet.ts,
 *   inventory.ts); `requestListing` a message to the box `<app>/requests`.
 * - **Settings** (root): the token list (`/mandala/tokens`) and the
 *   registered topics; root's messages to `<app>/register`; the holders'
 *   requests (`GET <base>/requests`). `isRoot` is a stub (no grants read).
 *
 * Ids (David, 2026-10-09): every token id is the BRC-207 assetId
 * `<txid>_<vout>`, `_0` included for a Mandala token (src/lib/tokenId.ts);
 * an outpoint is `<txid>.<vout>`. Amounts are bigints in base units; prices
 * are numbers: sats per whole token.
 *
 * The connected wallet (and its BRC-104 client) reach these functions
 * through `useSession` (`setExchangeContext`); tests set the context
 * themselves.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AuthFetch, Utils, type WalletInterface } from "@bsv/sdk";
import type { PoolState, Plan } from "@amm-poc/matching-engine";
import { useConnectDialog, useWallet } from "../wallet/AppWalletProvider";
import { outpointText, parseOutpoint, sameToken, sdkTokenId, tokenIdText } from "../lib/tokenId";
import { AMM_OVERLAY, FEE_RATE_SATS_PER_KB, REFRESH_MS, appName } from "../lib/config";
import { fetchLive, listTokenTopics, lookupPoolOutput, queryPools, type LiveAnswer, type SignedFetch, type TokenTopic } from "../lib/overlay";
import { readBeats, readRequests, readTokenList, sendMessage, type Beat, type ListedToken } from "../lib/skein";
import { liveSenders, pricesFromBeats, depthOf, type TokenPrice } from "../market/prices";
import { buildPlanRequest, goneFromLookup, quote as planQuote } from "../market/plan";
import { validatorStatus } from "../market/view";
import { callApp, readBytes, swapTerms, type AuthFetchLike } from "../market/relay";
import { pendingSwapPayouts, prepareSwap, selectExactTokenInputs, tokenInputsOf, type TokenInput } from "../market/swapAction";
import { relaySwap, type SwapOutcome } from "../market/swapFlow";
import { PendingPayoutStore } from "../wallet/pendingPayouts";
import { formatAmount } from "../lp/amounts";
import { loadWalletAssets } from "../lp/wallet";
import { buildInventory } from "../lp/inventory";
import { imageDataUrl } from "../lp/images";
import { poolableTokens, preparePoolDeploy, selectDepositInputs } from "../lp/poolDeploy";
import { relayPoolDeploy } from "../lp/deployFlow";
import { positionRowsOf, loadPosition, type LoadedPosition } from "../lp/positions";
import { completeClose, prepareClose, submitToOverlay } from "../lp/close";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A token id: the BRC-207 assetId `<txid>_<vout>`, `_0` included (src/lib/tokenId.ts). */
export type TokenId = string;

/** What a swap of 2% of the price costs: the sats a buy needs to move the marginal price up by `bps`. */
export interface Depth {
  bps: number;
  sats: bigint;
}

/** A token this overlay hosts (registered here), with its pools summed. */
export interface HostedToken {
  tokenId: TokenId;
  sym: string;
  dec: number;
  /** An image URL (a data: URL of the deploy's embedded icon, or an ORDFS URL). */
  icon?: string;
  /** Sats per whole token across the token's pools: what the next small swap pays. Null with no open pool. */
  marginalPrice: number | null;
  depth: Depth | null;
  /** Number of open pools. */
  pools: number;
  /** All pools summed. */
  reserves: { sats: bigint; tokens: bigint };
  /** Price change over 24 h, a fraction (0.018 = +1.8%). Absent when not known. */
  change24h?: number;
}

/** One open pool of a token, as a quote routes over it. */
export interface PoolView {
  /** `<txid>.<vout>` */
  outpoint: string;
  tokenId: TokenId;
  sats: bigint;
  tokens: bigint;
  validator: ValidatorRef;
}

export interface ValidatorRef {
  identityKey: string;
  live: boolean;
}

/** A price push from the host's subscription (skein#148). */
export interface PriceUpdate {
  tokenId: TokenId;
  marginalPrice: number | null;
  depth: Depth | null;
  pools: number;
  reserves: { sats: bigint; tokens: bigint };
  at: number;
}

/** "buy": pay sats, receive the token. "sell": pay the token, receive sats. */
export type Side = "buy" | "sell";

export interface QuoteRequest {
  tokenId: TokenId;
  side: Side;
  /** Base units of what is paid (sats on a buy, token base units on a sell). */
  amountIn: bigint;
  /** Max slippage against the quoted amount out, basis points. */
  maxSlippageBps: number;
  allowPartial: boolean;
}

export interface QuoteLeg {
  /** The pool, `<txid>.<vout>`. */
  poolOutpoint: string;
  amountIn: bigint;
  amountOut: bigint;
  /** Share of the amount in, basis points (the legs sum to 10000). */
  shareBps: number;
  /** The pool's reserves before the leg. */
  reserves: { sats: bigint; tokens: bigint };
  validator: ValidatorRef;
}

export interface Quote {
  request: QuoteRequest;
  legs: QuoteLeg[];
  amountOut: bigint;
  /** The least amount out the swap accepts: amountOut less max slippage. */
  minAmountOut: bigint;
  /** Sats per whole token this swap pays (fees included). */
  effectivePrice: number;
  /** Sats per whole token before the swap. */
  marginalPrice: number;
  /** |effective − marginal| / marginal, basis points. */
  impactBps: number;
  /** The validator's fees applied to every leg. */
  fees: Fees;
}

export interface LegResult {
  poolOutpoint: string;
  status: "filled" | "failed";
  txid?: string;
  error?: string;
}

export interface SwapResult {
  status: "filled" | "partial" | "failed";
  legs: LegResult[];
}

/** The validator's fees, basis points of the amount in. The LP accepts them; there is no fee input. */
export interface Fees {
  lpBps: number;
  validatorBps: number;
  /** The relay's commission (the pool's CommissionBps); 0: none. */
  commissionBps: number;
}

/** The validator a new position is deployed with, and its fees (read-only on the page). */
export interface ValidatorTerms {
  validator: ValidatorRef;
  /** "this exchange's" when the validator is this skein. */
  isThisExchange: boolean;
  fees: Fees;
}

/** One of the user's pools. A position is only deployed or closed (no add, no partial remove). */
export interface Position {
  /** The pool, `<txid>.<vout>`. */
  outpoint: string;
  tokenId: TokenId;
  sym: string;
  dec: number;
  icon?: string;
  sats: bigint;
  tokens: bigint;
  /** Fees the pool has earned the LP, when it can be told. */
  feesEarnedSats?: bigint;
  validator: ValidatorRef;
  /** The claim spent: the validator withdrew the listing (the pool no longer trades; close it). */
  rescinded: boolean;
}

export interface DeployRequest {
  tokenId: TokenId;
  /** Token base units. */
  tokens: bigint;
  sats: bigint;
}

export interface DeployResult {
  /** The new pool, `<txid>.<vout>`. */
  outpoint: string;
  txid: string;
}

export interface CloseRequest {
  outpoint: string;
  /** The miner fee left from the pool, sats. 0 = the fee is funded from another wallet input. */
  bsvFee: bigint;
}

export interface CloseResult {
  txid: string;
  /** Returned to the wallet. */
  sats: bigint;
  tokens: bigint;
}

/** One of the user's own Mandala tokens. */
export interface WalletToken {
  tokenId: TokenId;
  sym: string;
  dec: number;
  icon?: string;
  balance: bigint;
  /** How many wallet outputs hold it. */
  outputs: number;
  /** Registered on this exchange. */
  onExchange: boolean;
  /** The user asked this exchange to list it. */
  requested: boolean;
}

/** A token seen on the discovery topic (`tm_mandala`). */
export interface DiscoveryToken {
  tokenId: TokenId;
  sym: string;
  dec: number;
  icon?: string;
  /** When discovery first saw it, ms. */
  seenAt?: number;
}

/** A token registered on this exchange, as Settings lists it. */
export interface RegisteredToken {
  tokenId: TokenId;
  sym: string;
  icon?: string;
}

/** A holder's "Add to this exchange". */
export interface ListingRequest {
  tokenId: TokenId;
  sym: string;
  /** The requester's identity key. */
  from: string;
  at: number;
}

export interface Session {
  status: "disconnected" | "connecting" | "connected";
  identityKey: string | null;
  /** Opens the wallet connect dialog. */
  connect: () => void;
  disconnect: () => void;
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/** The Mandala deploy page the app carries (www/mandala/deploy/, skein-mandala). */
export const MANDALA_DEPLOY_HREF = "mandala/deploy/";
/** The skein's management site, at its own app path (skein#147). */
export const SITE_HREF = "/site/";

// ---------------------------------------------------------------------------
// The context: the instance and the connected wallet
// ---------------------------------------------------------------------------

type Signed = SignedFetch & AuthFetchLike;

interface ExchangeContext {
  /** The AMM app's base URL (src/lib/config.ts). */
  base: string;
  wallet: WalletInterface | null;
  /** The wallet's BRC-104 client. */
  af: Signed | null;
  identityKey: string | null;
  /** The pending payouts' store (localStorage). */
  payouts: PendingPayoutStore;
}

const context: ExchangeContext = { base: AMM_OVERLAY, wallet: null, af: null, identityKey: null, payouts: new PendingPayoutStore() };

/** Set what the functions below reach (the wallet and its client: `useSession`; a test: anything). */
export function setExchangeContext(c: Partial<ExchangeContext>): void {
  Object.assign(context, c);
}

function needWallet(): { wallet: WalletInterface; af: Signed } {
  if (!context.wallet || !context.af) throw new Error("Connect a wallet first");
  return { wallet: context.wallet, af: context.af };
}

const listeners = new Set<() => void>();
function emit(): void {
  for (const l of listeners) l();
}
/** Calls `fn` after any action changes data (swap, deploy, close, register…). Returns the unsubscribe. */
export function onDataChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The app's name (its boxes are `<app>/<box>`). */
function app(): string {
  return appName(context.base) ?? "amm";
}

/** The token list's metadata by token id (`/mandala/tokens`); empty when the read fails. */
async function tokenMeta(): Promise<Map<string, ListedToken>> {
  const m = new Map<string, ListedToken>();
  try {
    for (const t of await readTokenList(context.base)) {
      const id = parseOutpoint(t.tokenId.replace("_", "."));
      m.set(id ? tokenIdText(id) : t.tokenId, t);
    }
  } catch {
    /* no metadata: ids only */
  }
  return m;
}

function symOf(meta: Map<string, ListedToken>, tokenId: string): string {
  return meta.get(tokenId)?.sym ?? tokenId.slice(0, 8);
}

// ---------------------------------------------------------------------------
// Session and root
// ---------------------------------------------------------------------------

/**
 * What "Connect a wallet" does: the dialog when providers are configured,
 * otherwise the wallet's auto-detecting connect (an injected BRC-100 wallet
 * such as Yours). With no providers the dialog would list nothing (0.9.1).
 */
export function connectAction(providers: number, openDialog: () => void, connect: () => Promise<void>): "dialog" | "auto" {
  if (providers > 0) { openDialog(); return "dialog"; }
  void connect().catch(() => {});
  return "auto";
}

/** The connected wallet (@1sat/react `useWallet`, `useConnectDialog`); it also sets the context. */
export function useSession(): Session {
  const w = useWallet();
  const { openConnectDialog } = useConnectDialog();
  const status = w.status === "connected" && w.identityKey ? "connected" : w.status === "disconnected" ? "disconnected" : "connecting";
  const wallet = (w.wallet as WalletInterface | null | undefined) ?? null;
  const afRef = useRef<{ wallet: WalletInterface | null; af: Signed | null }>({ wallet: null, af: null });
  if (afRef.current.wallet !== wallet) afRef.current = { wallet, af: wallet ? (new AuthFetch(wallet) as unknown as Signed) : null };
  const connected = status === "connected";
  setExchangeContext({ wallet: connected ? wallet : null, af: connected ? afRef.current.af : null, identityKey: connected ? w.identityKey : null });
  // Connect as 0.8's <ConnectButton/> did: the wallet's own connect, which
  // auto-detects an injected BRC-100 wallet (Yours). The connect dialog lists
  // only `providers` configured on WalletProvider, and none are, so opening it
  // showed an empty "Choose how to connect." (0.9.1). The dialog is kept for
  // when providers are configured.
  const connect = useCallback(
    () => connectAction(w.availableProviders.length, openConnectDialog, w.connect),
    [w.availableProviders, w.connect, openConnectDialog],
  );
  return { status, identityKey: connected ? w.identityKey : null, connect, disconnect: w.disconnect };
}

/**
 * Whether this identity holds the role `root` on this skein.
 *
 * STUB (skein-amm 0.9.0): the skein has no read of a key's grants
 * (shruggr/skein#143), so every connected wallet is shown Settings; the
 * skein refuses a non-root's register messages (the role gate).
 */
export async function isRoot(identityKey: string | null): Promise<boolean> {
  return identityKey !== null;
}

// ---------------------------------------------------------------------------
// Landing: hosted tokens and live prices
// ---------------------------------------------------------------------------

/** The live validators of the topics `topics` and the `ls_amm` beats: their senders. */
async function liveFor(topics: TokenTopic[]): Promise<{ beats: Beat[]; live: Set<string> }> {
  const [beats, ...tokenBeats] = await Promise.all([
    readBeats(context.base, "ls_amm-live").catch(() => [] as Beat[]),
    ...topics.map((t) => readBeats(context.base, `${t.topic}-live`).catch(() => [] as Beat[])),
  ]);
  return { beats, live: liveSenders(beats, ...tokenBeats) };
}

/** This skein's own listing of a token, its live pools summed: the fallback when no beat reports the token. */
async function localPrice(t: TokenTopic, dec: number): Promise<TokenPrice> {
  const [pools, live] = await Promise.all([queryPools(context.af, context.base, t.tokenId), fetchLive(context.base, t.topic)]);
  const usable = pools.filter((p) => validatorStatus(p.validatorIdentityKey, live).live);
  const sats = usable.reduce((a, p) => a + p.bsvReserve, 0n);
  const tokens = usable.reduce((a, p) => a + p.tokenReserve, 0n);
  return {
    tokenId: t.tokenId,
    marginalPrice: tokens > 0n ? Number(sats) / (Number(tokens) / 10 ** dec) : null,
    depth: depthOf(sats),
    pools: usable.length,
    reserves: { sats, tokens },
    validators: [...new Set(usable.map((p) => p.validatorIdentityKey))],
  };
}

/** Every registered token's price: the beats first, this skein's listing for a token no beat reports. */
async function pricesNow(topics: TokenTopic[], meta: Map<string, ListedToken>): Promise<Map<string, TokenPrice>> {
  const { beats, live } = await liveFor(topics);
  const fromBeats = pricesFromBeats(beats, live, (id) => meta.get(id)?.dec ?? 0);
  const out = new Map<string, TokenPrice>();
  await Promise.all(
    topics.map(async (t) => {
      const b = fromBeats.get(t.tokenId);
      if (b && b.validators.length > 0) return out.set(t.tokenId, b);
      try {
        out.set(t.tokenId, await localPrice(t, meta.get(t.tokenId)?.dec ?? 0));
      } catch {
        out.set(t.tokenId, { tokenId: t.tokenId, marginalPrice: null, depth: null, pools: 0, reserves: { sats: 0n, tokens: 0n }, validators: [] });
      }
    }),
  );
  return out;
}

/** The tokens this overlay hosts (registered here: Mandala tokens at output 0), each priced. No wallet needed. */
export async function hostedTokens(): Promise<HostedToken[]> {
  const [topics, meta] = await Promise.all([listTokenTopics(context.base), tokenMeta()]);
  const native = topics.filter((t) => t.kind === "native");
  const prices = await pricesNow(native, meta);
  return native.map((t) => {
    const m = meta.get(t.tokenId);
    const p = prices.get(t.tokenId)!;
    return {
      tokenId: t.tokenId,
      sym: m?.sym ?? t.tokenId.slice(0, 8),
      dec: m?.dec ?? 0,
      ...(m?.icon ? { icon: m.icon } : {}),
      marginalPrice: p.marginalPrice,
      depth: p.depth,
      pools: p.pools,
      reserves: p.reserves,
    };
  });
}

/** Live prices: polls the beats every `REFRESH_MS` and calls `onUpdate` per registered token. Returns the unsubscribe. */
export function subscribePrices(onUpdate: (u: PriceUpdate) => void): () => void {
  let stopped = false;
  const tick = async () => {
    try {
      const [topics, meta] = await Promise.all([listTokenTopics(context.base), tokenMeta()]);
      const prices = await pricesNow(topics.filter((t) => t.kind === "native"), meta);
      if (stopped) return;
      for (const p of prices.values()) onUpdate({ tokenId: p.tokenId, marginalPrice: p.marginalPrice, depth: p.depth, pools: p.pools, reserves: p.reserves, at: Date.now() });
    } catch {
      /* the next tick */
    }
  };
  const timer = setInterval(() => void tick(), REFRESH_MS);
  const off = onDataChange(() => void tick());
  return () => {
    stopped = true;
    clearInterval(timer);
    off();
  };
}

/** The hosted tokens with live prices merged in: `hostedTokens()` once, then `subscribePrices()`. */
export function useHostedTokens(): { tokens: HostedToken[] | null; error: string | null; live: boolean; reload: () => void } {
  const r = useData(hostedTokens, []);
  const [prices, setPrices] = useState<Map<TokenId, PriceUpdate>>(new Map());
  const [live, setLive] = useState(false);
  useEffect(() => {
    setLive(true);
    const off = subscribePrices((u) => setPrices((m) => new Map(m).set(u.tokenId, u)));
    return () => {
      setLive(false);
      off();
    };
  }, []);
  const tokens = r.data?.map((t) => {
    const u = prices.get(t.tokenId);
    return u ? { ...t, marginalPrice: u.marginalPrice, depth: u.depth, pools: u.pools, reserves: u.reserves } : t;
  }) ?? null;
  return { tokens, error: r.error, live, reload: r.reload };
}

/** A token's listed pools on this skein, each with its validator's liveness. */
export async function tokenPools(tokenId: TokenId): Promise<PoolView[]> {
  const topic = `tm_mandala_${sdkTokenId(tokenId)}`;
  const [pools, live] = await Promise.all([queryPools(context.af, context.base, tokenId), fetchLive(context.base, topic)]);
  return pools.map((p) => ({
    outpoint: outpointText(p.outpoint),
    tokenId,
    sats: p.bsvReserve,
    tokens: p.tokenReserve,
    validator: { identityKey: p.validatorIdentityKey, live: validatorStatus(p.validatorIdentityKey, live).live },
  }));
}

// ---------------------------------------------------------------------------
// Swap
// ---------------------------------------------------------------------------

/** What a quote was planned from: kept for its execution. */
interface Planned {
  plan: Plan;
  pools: PoolState[];
  live: LiveAnswer;
  dec: number;
  sym: string;
}
const planned = new WeakMap<Quote, Planned>();

/** A quote for one token: the matching engine's plan over this skein's listed pools whose validator is live. */
export async function quoteSwap(req: QuoteRequest): Promise<Quote> {
  if (req.amountIn <= 0n) throw new Error("Enter an amount");
  const topic = `tm_mandala_${sdkTokenId(req.tokenId)}`;
  const [pools, live, meta] = await Promise.all([queryPools(context.af, context.base, req.tokenId), fetchLive(context.base, topic), tokenMeta()]);
  const dec = meta.get(req.tokenId)?.dec ?? 0;
  const buy = req.side === "buy";
  const r = buildPlanRequest(
    req.tokenId,
    { direction: buy ? "bsvToToken" : "tokenToBsv", amount: formatAmount(req.amountIn, buy ? 0 : dec), slippageBps: String(req.maxSlippageBps), allowPartial: req.allowPartial },
    pools,
    live,
    dec,
  );
  if (!r.ok) throw new Error(r.error);
  const { plan, view } = planQuote(r.request, live, dec);
  const used = view.legs.filter((l) => l.amountIn > 0n);
  if (used.length === 0 || view.totalOut === 0n) throw new Error("The amount is too small to receive anything");
  const usable = pools.filter((p) => validatorStatus(p.validatorIdentityKey, live).live);
  const sumSats = usable.reduce((a, p) => a + p.bsvReserve, 0n);
  const sumTokens = usable.reduce((a, p) => a + p.tokenReserve, 0n);
  const marginal = sumTokens > 0n ? Number(sumSats) / (Number(sumTokens) / 10 ** dec) : 0;
  const totalIn = used.reduce((a, l) => a + l.amountIn, 0n);
  const sats = buy ? totalIn : view.totalOut;
  const tokens = buy ? view.totalOut : totalIn;
  const effective = Number(sats) / (Number(tokens) / 10 ** dec);
  const first = used[0]!.pool;
  const q: Quote = {
    request: req,
    legs: used.map((l) => ({
      poolOutpoint: outpointText(l.outpoint),
      amountIn: l.amountIn,
      amountOut: l.amountOut,
      shareBps: Number((l.amountIn * 10_000n) / req.amountIn),
      reserves: { sats: l.pool.bsvReserve, tokens: l.pool.tokenReserve },
      validator: { identityKey: l.pool.validatorIdentityKey, live: l.validator.live },
    })),
    amountOut: view.totalOut,
    minAmountOut: view.minAmountOut,
    effectivePrice: effective,
    marginalPrice: marginal,
    impactBps: marginal ? Math.round((Math.abs(effective - marginal) / marginal) * 10_000) : 0,
    fees: { lpBps: Number(first.liquidityFeeBps), validatorBps: Number(first.validationFeeBps), commissionBps: Number(first.commissionBps ?? 0n) },
  };
  planned.set(q, { plan, pools, live, dec, sym: meta.get(req.tokenId)?.sym ?? "token" });
  return q;
}

/**
 * Runs a quoted swap with the connected wallet: one transaction per leg,
 * relayed to the leg's validator (`amm.swap.submit`), each payout kept as a
 * pending payout until the wallet takes it in. A planned pool gone from a
 * fresh lookup stops the swap unless partial fills are allowed.
 */
export async function executeSwap(quote: Quote): Promise<SwapResult> {
  const { wallet, af } = needWallet();
  const p = planned.get(quote);
  if (!p) throw new Error("Quote again: this quote was not planned here");
  const tokenId = quote.request.tokenId;
  const fresh = await queryPools(af, context.base, tokenId);
  const gone = goneFromLookup(p.plan, fresh);
  if (gone.length > 0 && !quote.request.allowPartial) throw new Error(`${gone.map(outpointText).join(", ")} ${gone.length === 1 ? "was" : "were"} spent since the quote: quote again`);
  const terms = await swapTerms(af, context.base);
  const direction = quote.request.side === "buy" ? "bsvToToken" : "tokenToBsv";
  let candidates: TokenInput[] = [];
  if (direction === "tokenToBsv") candidates = tokenInputsOf((await loadWalletAssets(wallet)).tokenRows, tokenId);
  const legs: LegResult[] = [];
  const running: Promise<void>[] = [];
  for (const leg of p.plan.legs) {
    const poolOutpoint = outpointText(leg.outpoint);
    if (gone.includes(leg.outpoint)) {
      legs.push({ poolOutpoint, status: "failed", error: "spent since the quote" });
      continue;
    }
    const pool = p.pools.find((x) => x.outpoint === leg.outpoint)!;
    const validator = validatorStatus(pool.validatorIdentityKey, p.live);
    if (!validator.live || !validator.peerId) {
      legs.push({ poolOutpoint, status: "failed", error: "the pool's validator is no longer live" });
      continue;
    }
    let tokenInputs: TokenInput[] | undefined;
    if (direction === "tokenToBsv") {
      const pick = selectExactTokenInputs(candidates, leg.amountIn);
      if (!pick) {
        legs.push({ poolOutpoint, status: "failed", error: `no set of your ${p.sym} outputs adds up to exactly ${formatAmount(leg.amountIn, p.dec)} (the pool takes no token change)` });
        continue;
      }
      tokenInputs = pick;
      candidates = candidates.filter((c) => !pick.includes(c));
    }
    const result: LegResult = { poolOutpoint, status: "failed" };
    legs.push(result);
    try {
      const poolOutput = await lookupPoolOutput(af, context.base, tokenId, leg.outpoint);
      const prepared = await prepareSwap({ wallet, tokenId, meta: { sym: p.sym, dec: p.dec }, direction, leg, pool, poolOutput, commissionPkh: terms.commissionPkh, tokenInputs, satsPerKb: FEE_RATE_SATS_PER_KB });
      const pending = pendingSwapPayouts(prepared, tokenId);
      for (const r of pending) context.payouts.save(r);
      running.push(
        relaySwap({ wallet, authFetch: af, base: context.base }, prepared, validator.peerId)
          .catch((e): SwapOutcome => ({ status: "unknown", reason: errText(e) }))
          .then((o) => {
            for (const r of pending) {
              if (o.status === "accepted") {
                if (o.completed.internalized) context.payouts.remove(r.id);
                else context.payouts.finalize(r.id, o.txid);
              } else if (o.status !== "unknown") context.payouts.remove(r.id);
            }
            if (o.status === "accepted") {
              result.status = "filled";
              result.txid = o.txid;
            } else result.error = o.status === "refused" ? `refused: ${o.reason}` : o.status === "unknown" ? `no answer yet: ${o.reason}` : o.status;
          }),
      );
    } catch (e) {
      result.error = errText(e);
    }
  }
  await Promise.all(running);
  emit();
  const filled = legs.filter((l) => l.status === "filled").length;
  return { status: filled === legs.length && legs.length > 0 ? "filled" : filled === 0 ? "failed" : "partial", legs };
}

/** The connected wallet's spendable sats (its default basket). */
export async function walletSats(): Promise<bigint> {
  const { wallet } = needWallet();
  const r = await wallet.listOutputs({ basket: "default", limit: 10_000 });
  return r.outputs.filter((o) => o.spendable !== false).reduce((a, o) => a + BigInt(o.satoshis), 0n);
}

// ---------------------------------------------------------------------------
// Liquidity
// ---------------------------------------------------------------------------

/** The positions last loaded, by the pool's current outpoint (`<txid>.<vout>`): what `closePosition` closes. */
const loaded = new Map<string, LoadedPosition>();

/** The connected wallet's open positions: its pool rows read from the chain state (src/lp/positions.ts). */
export async function myPositions(): Promise<Position[]> {
  const { wallet, af } = needWallet();
  const [assets, meta] = await Promise.all([loadWalletAssets(wallet), tokenMeta()]);
  const rows = positionRowsOf(assets.tokenRows);
  const out: Position[] = [];
  loaded.clear();
  const lives = new Map<string, Promise<LiveAnswer | null>>();
  for (const row of rows) {
    let pos: LoadedPosition;
    try {
      pos = await loadPosition(af, context.base, row);
    } catch {
      continue;
    }
    if (!pos.current || !pos.pool || pos.sats === undefined) continue;
    loaded.set(pos.current, pos);
    const topic = `tm_mandala_${sdkTokenId(row.tokenId)}`;
    if (!lives.has(topic)) lives.set(topic, fetchLive(context.base, topic).catch(() => null));
    const live = await lives.get(topic)!;
    const m = meta.get(row.tokenId);
    const identity = pos.pool.state.validatorIdentity;
    out.push({
      outpoint: pos.current,
      tokenId: row.tokenId,
      sym: m?.sym ?? row.sym ?? row.tokenId.slice(0, 8),
      dec: m?.dec ?? row.dec ?? 0,
      ...(m?.icon ? { icon: m.icon } : {}),
      sats: pos.sats,
      tokens: pos.pool.state.tokenReserve,
      validator: { identityKey: identity, live: live ? validatorStatus(identity, live).live : false },
      rescinded: pos.rescinded,
    });
  }
  return out;
}

interface RawTerms {
  validator: string;
  peerId?: string;
  fees: Fees;
}

/** `amm.pool.terms`: this skein's validator, its peer ID and its terms. */
async function rawTerms(): Promise<RawTerms> {
  const { af } = needWallet();
  const t = (await callApp(af, context.base, "amm.pool.terms", {})) as Record<string, unknown>;
  const bytes = readBytes(t.validator);
  const hex = bytes ? Utils.toHex(bytes) : "";
  if (!/^[0-9a-f]{66}$/.test(hex)) throw new Error("amm.pool.terms: no validator identity");
  return {
    validator: hex,
    ...(typeof t.peerId === "string" ? { peerId: t.peerId } : {}),
    fees: { lpBps: Number(t.lpFeeBps ?? 30), validatorBps: Number(t.validatorFeeBps ?? 5), commissionBps: Number(t.commissionBps ?? 0) },
  };
}

/** The validator a new position is deployed with (this skein), and its fees (read-only: the LP accepts them). */
export async function validatorTerms(): Promise<ValidatorTerms> {
  const t = await rawTerms();
  return { validator: { identityKey: t.validator, live: Boolean(t.peerId) }, isThisExchange: true, fees: t.fees };
}

/**
 * Deploys a new position: the deploy delivered to this skein's validator at
 * its terms (src/lp/poolDeploy.ts: SIGHASH_SINGLE pairs, one unit left for
 * the claim); accepted, the claimed deploy filed in the wallet.
 */
export async function deployPosition(req: DeployRequest): Promise<DeployResult> {
  const { wallet, af } = needWallet();
  if (req.tokens <= 0n || req.sats <= 0n) throw new Error("Both amounts must be more than 0");
  const [terms, assets, meta] = await Promise.all([rawTerms(), loadWalletAssets(wallet), tokenMeta()]);
  if (!terms.peerId) throw new Error("this skein's validator has no peer ID (no libp2p node): it cannot take a deploy");
  const m = meta.get(req.tokenId);
  const { tokens } = poolableTokens(assets.tokenRows, new Map(m ? [[req.tokenId, { sym: m.sym, dec: m.dec }]] : []));
  const token = tokens.find((t) => sameToken(t.tokenId, req.tokenId));
  if (!token) throw new Error("Your wallet holds none of that token as a Mandala output");
  const sel = selectDepositInputs(token.inputs, req.tokens);
  if (!sel) throw new Error(`Your wallet holds fewer than ${formatAmount(req.tokens + 1n, m?.dec ?? 0)} of that token (the deposit and the validator's one-unit claim)`);
  const prepared = await preparePoolDeploy({
    wallet,
    form: {
      tokenId: req.tokenId,
      inputs: sel.inputs,
      tokens: req.tokens,
      sats: req.sats,
      lpFeeBps: BigInt(terms.fees.lpBps),
      validatorFeeBps: BigInt(terms.fees.validatorBps),
      commissionBps: BigInt(terms.fees.commissionBps),
      validator: { identityKey: terms.validator, peerId: terms.peerId },
    },
    meta: { ...(m?.sym ? { sym: m.sym } : {}), ...(m?.dec !== undefined ? { dec: m.dec } : {}) },
    satsPerKb: FEE_RATE_SATS_PER_KB,
  });
  const o = await relayPoolDeploy({ wallet, authFetch: af, base: context.base }, prepared, terms.peerId);
  if (o.status !== "accepted") throw new Error(o.status === "refused" ? `refused: ${o.reason}` : "reason" in o ? o.reason : o.status);
  emit();
  return { outpoint: `${o.txid}.0`, txid: o.txid };
}

/**
 * Closes a position (src/lp/close.ts): everything in the pool returns to the
 * wallet, less `bsvFee` (the miner fee left from the pool; 0: funded from a
 * wallet output); submitted to this skein's overlay.
 */
export async function closePosition(req: CloseRequest): Promise<CloseResult> {
  const { wallet } = needWallet();
  let pos = loaded.get(req.outpoint);
  if (!pos) {
    await myPositions();
    pos = loaded.get(req.outpoint);
  }
  if (!pos || !pos.output) throw new Error("No such position");
  const meta = await tokenMeta();
  const m = meta.get(pos.row.tokenId);
  const prepared = await prepareClose({
    wallet,
    tokenId: pos.row.tokenId,
    meta: { ...(m?.sym ? { sym: m.sym } : {}), ...(m?.dec !== undefined ? { dec: m.dec } : {}) },
    poolOutput: pos.output,
    lpKey: pos.row.lpKey,
    bsvFee: req.bsvFee,
    satsPerKb: FEE_RATE_SATS_PER_KB,
  });
  await submitToOverlay(context.base, prepared.topic, prepared.beef);
  await completeClose(wallet, prepared, pos.row.deployOutpoint);
  loaded.delete(req.outpoint);
  emit();
  return { txid: prepared.txid, sats: prepared.sats, tokens: prepared.tokenAmount };
}

// ---------------------------------------------------------------------------
// Your tokens
// ---------------------------------------------------------------------------

/** The connected wallet's Mandala tokens with a balance, each marked on this exchange (registered) and requested. */
export async function myTokens(): Promise<WalletToken[]> {
  const { wallet } = needWallet();
  const [assets, topics, meta, requests] = await Promise.all([
    loadWalletAssets(wallet),
    listTokenTopics(context.base).catch(() => [] as TokenTopic[]),
    tokenMeta(),
    readRequests(context.base).catch(() => []),
  ]);
  const inv = buildInventory(assets.tokenRows, { txs: assets.txs });
  const registered = new Set(topics.map((t) => t.tokenId));
  const me = context.identityKey;
  const asked = new Set(requests.filter((r) => r.from === me).map((r) => r.tokenId));
  return inv.tokens
    .filter((t) => t.balance > 0n && t.encodings.includes("mandala"))
    .map((t) => {
      const m = meta.get(t.tokenId);
      const icon = m?.icon ?? (t.icon?.image ? imageDataUrl(t.icon.image) : undefined);
      return {
        tokenId: t.tokenId,
        sym: t.sym ?? m?.sym ?? t.tokenId.slice(0, 8),
        dec: t.dec ?? m?.dec ?? 0,
        ...(icon ? { icon } : {}),
        balance: t.balance,
        outputs: t.valueOutputs,
        onExchange: registered.has(t.tokenId),
        requested: asked.has(t.tokenId),
      };
    });
}

/** "Add to this exchange": a message `{fn: "request", args: {tokenId}}` to the box `<app>/requests` (anyone may send; recorded for root). */
export async function requestListing(tokenId: TokenId): Promise<void> {
  const { af } = needWallet();
  const t = await rawTerms();
  await sendMessage(af, context.base, t.validator, `${app()}/requests`, { fn: "request", args: { tokenId: sdkTokenId(tokenId) } });
  emit();
}

// ---------------------------------------------------------------------------
// Settings (root)
// ---------------------------------------------------------------------------

/** The tokens the discovery topic knows (`/mandala/tokens`) that this exchange does not serve yet. */
export async function discoveryTokens(): Promise<DiscoveryToken[]> {
  const [list, topics] = await Promise.all([readTokenList(context.base), listTokenTopics(context.base)]);
  const registered = new Set(topics.map((t) => t.tokenId));
  return list
    .map((t) => {
      const id = parseOutpoint(t.tokenId.replace("_", "."));
      return { ...t, tokenId: id ? tokenIdText(id) : t.tokenId };
    })
    .filter((t) => !registered.has(t.tokenId) && t.tokenId.endsWith("_0"))
    .map((t) => ({ tokenId: t.tokenId, sym: t.sym ?? t.tokenId.slice(0, 8), dec: t.dec ?? 0, ...(t.icon ? { icon: t.icon } : {}) }));
}

/** The tokens registered on this exchange (`listTopicManagers`). */
export async function registeredTokens(): Promise<RegisteredToken[]> {
  const [topics, meta] = await Promise.all([listTokenTopics(context.base), tokenMeta()]);
  return topics.map((t) => {
    const m = meta.get(t.tokenId);
    return { tokenId: t.tokenId, sym: symOf(meta, t.tokenId), ...(m?.icon ? { icon: m.icon } : {}) };
  });
}

/** The topic a token's pools are admitted under (BRC-207; skein-amm 0.8.0): derived, never typed. */
export function topicOf(tokenId: TokenId): string {
  return `tm_mandala_${sdkTokenId(tokenId)}`;
}

/** The lookup service of a token (BRC-207): derived, never typed. */
export function lookupOf(tokenId: TokenId): string {
  return `ls_mandala_${sdkTokenId(tokenId)}`;
}

/** The AMM lookup's service: registered so it beats its prices on `ls_amm-live` (skein-overlay 0.12: a registered lookup beats). */
export const AMM_LOOKUP = "ls_amm";

/**
 * Registers a token: root's messages to `<app>/register` — its topic
 * (`mandala-topic`), its lookup (`mandala-lookup`), and `ls_amm`
 * (`amm-lookup`, idempotent: the same again changes nothing) so the AMM
 * lookup's beat (the prices) is declared.
 */
export async function registerToken(tokenId: TokenId): Promise<void> {
  const { af } = needWallet();
  const me = (await rawTerms()).validator;
  const box = `${app()}/register`;
  const topic = topicOf(tokenId);
  await sendMessage(af, context.base, me, box, { fn: "register", args: { topic, program: "mandala-topic" } });
  await sendMessage(af, context.base, me, box, { fn: "registerLookup", args: { service: lookupOf(tokenId), program: "mandala-lookup", topics: [topic] } });
  await sendMessage(af, context.base, me, box, { fn: "registerLookup", args: { service: AMM_LOOKUP, program: "amm-lookup" } });
  emit();
}

/** Deregisters a token: its lookup, then its topic (root's messages to `<app>/register`). */
export async function deregisterToken(tokenId: TokenId): Promise<void> {
  const { af } = needWallet();
  const me = (await rawTerms()).validator;
  const box = `${app()}/register`;
  await sendMessage(af, context.base, me, box, { fn: "deregisterLookup", args: { service: lookupOf(tokenId) } });
  await sendMessage(af, context.base, me, box, { fn: "deregister", args: { topic: topicOf(tokenId) } });
  emit();
}

/** Holders' requests to list a token, newest first (`GET <base>/requests`: the ones not yet registered). */
export async function listingRequests(): Promise<ListingRequest[] | null> {
  const [rs, meta] = await Promise.all([readRequests(context.base), tokenMeta()]);
  return rs
    .map((r) => {
      const id = parseOutpoint(r.tokenId.replace("_", "."));
      const tokenId = id ? tokenIdText(id) : r.tokenId;
      return { tokenId, sym: symOf(meta, tokenId), from: r.from, at: r.at };
    })
    .sort((a, b) => b.at - a.at);
}

// ---------------------------------------------------------------------------
// Hooks over the functions above
// ---------------------------------------------------------------------------

export interface Data<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Runs `load` on mount, when `deps` change and after any action (`onDataChange`). */
export function useData<T>(load: () => Promise<T>, deps: unknown[], enabled = true): Data<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [n, setN] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const reload = useCallback(() => setN((x) => x + 1), []);
  useEffect(() => onDataChange(reload), [reload]);
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    loadRef.current().then(
      (d) => {
        if (!live) return;
        setData(d);
        setError(null);
        setLoading(false);
      },
      (e: unknown) => {
        if (!live) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [...deps, n, enabled]);
  return { data, error, loading, reload };
}

export const useMyPositions = (enabled: boolean) => useData(myPositions, [], enabled);
export const useMyTokens = (enabled: boolean) => useData(myTokens, [], enabled);
export const useValidatorTerms = () => useData(validatorTerms, []);
export const useWalletSats = (enabled: boolean) => useData(walletSats, [], enabled);
export const useDiscoveryTokens = (enabled: boolean) => useData(discoveryTokens, [], enabled);
export const useRegisteredTokens = (enabled: boolean) => useData(registeredTokens, [], enabled);
export const useListingRequests = (enabled: boolean) => useData(listingRequests, [], enabled);
export const useTokenPools = (tokenId: TokenId | undefined) =>
  useData(() => (tokenId ? tokenPools(tokenId) : Promise.resolve([])), [tokenId]);

/** Whether the session's key is root (`isRoot`), false while disconnected. */
export function useIsRoot(session: Session): boolean {
  const r = useData(() => isRoot(session.identityKey), [session.identityKey], session.status === "connected");
  return session.status === "connected" && r.data === true;
}

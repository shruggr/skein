/**
 * The swapper page (docs/notes.md "SDK and UI direction": the overlays the
 * site points at, their pools and current prices). Talks only to the
 * instance at `AMM_OVERLAY` and the connected BRC-100 wallet; broadcasts
 * nothing itself (the validator does).
 *
 *   market    topics → pools (lookup) → prices; per token, the validators live
 *             (`GET <base>/.live/tm_mandala_<txid>_0-live`, the runtime's liveness read:
 *             the beats within the window: `sender` the validator, `from` its peer ID)
 *   form      token, direction, amount, slippage → the engine's plan over the
 *             pools whose validator is live there (src/market/plan.ts `livePools`)
 *   swap      the relay's terms (amm.swap.terms: where the commission goes),
 *             then per leg: the funding (nosend) and the swap through the
 *             wallet (src/market/swapAction.ts), then the relay
 *             (amm.swap.submit / amm.swap.status, src/market/relay.ts, swapFlow.ts),
 *             naming the validator: its identity key and the peer ID from the read
 *   result    accepted → payout internalized, funding relinquished;
 *             refused / timeout → funding aborted, replanned from the refusal
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Direction, Plan } from "@amm-poc/matching-engine";
import { useWallet } from "../wallet/AppWalletProvider";
import { AMM_OVERLAY, FEE_RATE_SATS_PER_KB, REFRESH_MS } from "../lib/config";
import {
  LIVE_WINDOW_MS,
  fetchLiveByToken,
  listTokenTopics,
  lookupPoolOutput,
  queryPools,
  type LiveAnswer,
  type TokenTopic,
} from "../lib/overlay";
import { loadWalletAssets, type WalletAssets } from "../lp/wallet";
import { buildInventory } from "../lp/inventory";
import { formatAmount } from "../lp/amounts";
import { shortOutpoint, shortTokenId } from "../lib/tokenId";
import { Id } from "../components/Id";
import { buildMarketView, shortKey, validatorStatus, type MarketToken, type TokenMeta, type ValidatorStatus } from "../market/view";
import { ago } from "../lp/validators";
import { buildPlanRequest, goneFromLookup, quote, type PlanView } from "../market/plan";
import {
  abandonSwap,
  pendingSwapPayouts,
  prepareSwap,
  selectExactTokenInputs,
  tokenInputsOf,
  type PreparedSwap,
  type TokenInput,
} from "../market/swapAction";
import { checkAgain, relaySwap, type RelayContext, type SwapOutcome } from "../market/swapFlow";
import { swapTerms, type SwapTerms } from "../market/relay";
import { useAuthFetch } from "../wallet/authFetch";
import type { PoolState } from "@amm-poc/matching-engine";
import { Icon } from "./Tokens";
import { PendingPayoutStore } from "../wallet/pendingPayouts";

const payouts = new PendingPayoutStore();

type PoolsAnswer = Map<string, import("@amm-poc/matching-engine").PoolState[] | Error>;

type LegResult =
  | { outpoint: string; status: "not_built" | "error"; reason: string; validator: ValidatorStatus }
  | { outpoint: string; status: "relaying" | "done"; prepared: PreparedSwap; validator: ValidatorStatus; payoutIds: string[]; outcome?: SwapOutcome };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function LiveDot({ v }: { v: ValidatorStatus }) {
  const title = v.seen ? `last beat ${Math.round((v.ageMs ?? 0) / 1000)} s ago${v.peerId ? `, peer ${v.peerId}` : ""}` : "not in this instance's liveness read for the token";
  return <span className={`dot ${v.live ? "dot-live" : "dot-off"}`} title={title} aria-label={v.live ? "live" : "not live"} />;
}

function NotBuilt({ children }: { children: string }) {
  return (
    <p className="not-built">
      <strong>Not built.</strong> {children.replace(/^Not built: /, "")}
    </p>
  );
}

export function SwapPage() {
  const { wallet, status } = useWallet();
  const authFetch = useAuthFetch();
  const connected = status === "connected" && !!wallet;

  // --- the instance -------------------------------------------------------
  const [topics, setTopics] = useState<TokenTopic[]>([]);
  const [pools, setPools] = useState<PoolsAnswer>(new Map());
  // Per token: the validators live on its `-live` topic (the runtime's read), or the error reading it.
  const [live, setLive] = useState<Map<string, LiveAnswer | Error>>(new Map());
  const [instanceError, setInstanceError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const ts = await listTokenTopics(AMM_OVERLAY);
      const answers: PoolsAnswer = new Map();
      await Promise.all(
        ts.map(async (t) => {
          try {
            answers.set(t.tokenId, await queryPools(authFetch, AMM_OVERLAY, t.tokenId));
          } catch (e) {
            answers.set(t.tokenId, new Error(errText(e)));
          }
        }),
      );
      setTopics(ts);
      setPools(answers);
      setLive(await fetchLiveByToken(AMM_OVERLAY, ts));
      setInstanceError(null);
    } catch (e) {
      setInstanceError(errText(e));
    }
    setRefreshedAt(Date.now());
  }, [authFetch]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // --- the wallet: token metadata and token outputs -----------------------
  const [assets, setAssets] = useState<WalletAssets | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const loadAssets = useCallback(async () => {
    if (!wallet) return;
    try {
      setAssets(await loadWalletAssets(wallet));
      setWalletError(null);
    } catch (e) {
      setWalletError(errText(e));
    }
  }, [wallet]);
  useEffect(() => {
    if (connected) void loadAssets();
    else setAssets(null);
  }, [connected, loadAssets]);

  const meta = useMemo(() => {
    const m = new Map<string, TokenMeta>();
    if (!assets) return m;
    const inv = buildInventory(assets.tokenRows, { ordinalRows: assets.ordinalRows, txs: assets.txs });
    for (const t of inv.tokens) {
      if (!t.deployInWallet) continue;
      m.set(t.tokenId, { ...(t.sym !== undefined && { sym: t.sym }), ...(t.dec !== undefined && { dec: t.dec }), ...(t.icon && { icon: t.icon }) });
    }
    return m;
  }, [assets]);

  const market: MarketToken[] = useMemo(() => buildMarketView(topics, pools, live, meta), [topics, pools, live, meta]);

  // --- the form and the plan ----------------------------------------------
  const [selected, setSelected] = useState("");
  const [direction, setDirection] = useState<Direction>("bsvToToken");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState("100");
  const [allowPartial, setAllowPartial] = useState(true);

  useEffect(() => {
    if (!selected && market.length > 0) setSelected(market[0]!.topic.tokenId);
  }, [market, selected]);
  const token = market.find((t) => t.topic.tokenId === selected);
  const tokenLive = token?.live ?? null;
  const dec = token?.meta?.dec;
  // A refusal carries the pool's current state: it replaces the refused outpoint until the lookup catches up.
  const [refusedPools, setRefusedPools] = useState<Map<string, PoolState>>(new Map());
  const tokenPools = useMemo(() => {
    const listed = token?.pools.map((r) => r.pool) ?? [];
    return listed.map((p) => refusedPools.get(p.outpoint) ?? p);
  }, [token, refusedPools]);

  const planned = useMemo(() => {
    if (!token) return null;
    const req = buildPlanRequest(token.topic.tokenId, { direction, amount, slippageBps, allowPartial }, tokenPools, tokenLive, dec);
    if (!req.ok) return { error: req.error };
    try {
      return quote(req.request, tokenLive, dec);
    } catch (e) {
      return { error: errText(e) };
    }
  }, [token, direction, amount, slippageBps, allowPartial, tokenPools, tokenLive, dec]);
  const plan: Plan | null = planned && "plan" in planned ? planned.plan : null;
  const view: PlanView | null = planned && "view" in planned ? planned.view : null;

  // --- races: a planned pool gone from a fresh lookup ---------------------
  const lastPlan = useRef<{ service: string; plan: Plan } | null>(null);
  const [raceNote, setRaceNote] = useState<string | null>(null);
  const [legs, setLegs] = useState<LegResult[]>([]);
  useEffect(() => setRaceNote(null), [selected, direction, amount, slippageBps, allowPartial]);
  useEffect(() => {
    const prev = lastPlan.current;
    if (prev && token && prev.service === token.topic.tokenId) {
      const gone = goneFromLookup(prev.plan, tokenPools);
      if (gone.length > 0) {
        setRaceNote(
          `${gone.map(shortOutpoint).join(", ")} ${gone.length === 1 ? "is" : "are"} gone from the lookup (spent by another swap since the plan); replanned against ${tokenPools.length} pool(s).`,
        );
      }
    }
    lastPlan.current = plan && token ? { service: token.topic.tokenId, plan } : null;
  }, [plan, token, tokenPools]);

  // --- swap ----------------------------------------------------------------
  const [building, setBuilding] = useState(false);

  const relayCtx = (): RelayContext | null => (wallet && authFetch ? { wallet, authFetch, base: AMM_OVERLAY } : null);

  // The relay's terms: where the commission goes (read again before every swap).
  const [terms, setTerms] = useState<SwapTerms | null>(null);
  const [termsError, setTermsError] = useState<string | null>(null);
  const loadTerms = useCallback(async (): Promise<SwapTerms | null> => {
    if (!authFetch) return null;
    try {
      const t = await swapTerms(authFetch, AMM_OVERLAY);
      setTerms(t);
      setTermsError(null);
      return t;
    } catch (e) {
      setTermsError(errText(e));
      return null;
    }
  }, [authFetch]);
  useEffect(() => {
    if (connected) void loadTerms();
    else setTerms(null);
  }, [connected, loadTerms]);

  /** After the relay's outcome: pending payout bookkeeping, replan input. */
  function settled(l: Extract<LegResult, { prepared: PreparedSwap }>, o: SwapOutcome): LegResult {
    for (const id of l.payoutIds) {
      if (o.status === "accepted") {
        if (o.completed.internalized) payouts.remove(id);
        else payouts.finalize(id, o.txid);
      } else if (o.status !== "unknown") payouts.remove(id);
    }
    if (o.status === "refused" && o.pool) {
      const fresh = o.pool;
      setRefusedPools((m) => new Map(m).set(l.outpoint, fresh));
    }
    return { ...l, status: o.status === "unknown" ? "relaying" : "done", outcome: o };
  }

  function update(outpoint: string, next: LegResult) {
    setLegs((ls) => ls.map((x) => (x.outpoint === outpoint ? next : x)));
  }

  async function swap() {
    const ctx = relayCtx();
    if (!wallet || !ctx || !token || !plan) return;
    setBuilding(true);
    const results: LegResult[] = [];
    setLegs([]);
    const poolOf = (outpoint: string) => tokenPools.find((p) => p.outpoint === outpoint)!;
    // Before building: the relay names the commission address (or none: the taker's own key).
    const t = await loadTerms();
    if (!t) {
      setBuilding(false);
      return;
    }
    let candidates: TokenInput[] = [];
    if (direction === "tokenToBsv") {
      try {
        candidates = tokenInputsOf(assets?.tokenRows ?? [], token.topic.tokenId);
      } catch (e) {
        const reason = errText(e);
        setLegs(plan.legs.map((l) => ({ outpoint: l.outpoint, status: "not_built", reason, validator: validatorStatus(poolOf(l.outpoint).validatorIdentityKey, tokenLive) })));
        setBuilding(false);
        return;
      }
    }
    const running: Promise<void>[] = [];
    for (const leg of plan.legs) {
      const pool = poolOf(leg.outpoint);
      const validator = validatorStatus(pool.validatorIdentityKey, tokenLive);
      // The swap names the validator: the peer ID its beat carries (the relay dials it).
      const peerId = validator.live ? validator.peerId : undefined;
      if (!peerId) {
        results.push({ outpoint: leg.outpoint, status: "error", validator, reason: "the pool's validator is no longer in this token's liveness read: no peer to name; refresh and plan again" });
        setLegs([...results]);
        continue;
      }
      let tokenInputs: TokenInput[] | undefined;
      if (direction === "tokenToBsv") {
        const pick = selectExactTokenInputs(candidates, leg.amountIn);
        if (!pick) {
          results.push({
            outpoint: leg.outpoint,
            status: "not_built",
            validator,
            reason: `token split: no combination of your Mandala outputs of this token adds up to exactly ${formatAmount(leg.amountIn, dec ?? 0)} (held: ${candidates.map((c) => formatAmount(c.amount, dec ?? 0)).join(", ") || "none"}); the pool contract has no token change output, and the split transaction that would make an exact output is not built.`,
          });
          setLegs([...results]);
          continue;
        }
        tokenInputs = pick;
        candidates = candidates.filter((c) => !pick.includes(c));
      }
      try {
        const poolOutput = await lookupPoolOutput(authFetch, AMM_OVERLAY, token.topic.tokenId, leg.outpoint);
        const prepared = await prepareSwap({
          wallet,
          tokenId: token.topic.tokenId,
          meta: token.meta,
          direction,
          leg,
          pool,
          poolOutput,
          commissionPkh: t.commissionPkh,
          tokenInputs,
          satsPerKb: FEE_RATE_SATS_PER_KB,
        });
        // Durable before the swap leaves the page: the remittance is what lets the wallet spend the payout.
        const pending = pendingSwapPayouts(prepared, token.topic.tokenId);
        for (const r of pending) payouts.save(r);
        const l: Extract<LegResult, { prepared: PreparedSwap }> = { outpoint: leg.outpoint, status: "relaying", prepared, validator, payoutIds: pending.map((r) => r.id) };
        results.push(l);
        running.push(
          relaySwap(ctx, prepared, peerId)
            .catch((e): SwapOutcome => ({ status: "unknown", reason: errText(e) }))
            .then((o) => {
              const next = settled(l, o);
              // Later legs still being built re-render `results`: keep it current.
              results[results.indexOf(l)] = next;
              update(l.outpoint, next);
            }),
        );
      } catch (e) {
        results.push({ outpoint: leg.outpoint, status: "error", validator, reason: errText(e) });
      }
      setLegs([...results]);
    }
    setBuilding(false);
    await Promise.all(running);
    void loadAssets();
  }

  async function retry(l: Extract<LegResult, { prepared: PreparedSwap }>) {
    const ctx = relayCtx();
    const o = l.outcome;
    if (!ctx || !o || o.status !== "unknown" || !o.id) return;
    update(l.outpoint, settled(l, await checkAgain(ctx, l.prepared, o.id)));
  }

  async function abandon(l: Extract<LegResult, { prepared: PreparedSwap }>) {
    if (!wallet) return;
    try {
      await abandonSwap(wallet, l.prepared);
      update(l.outpoint, settled(l, { status: "failed", reason: "abandoned: the funding action was aborted" }));
    } catch (e) {
      update(l.outpoint, { ...l, outcome: { status: "unknown", reason: `abortAction: ${errText(e)}` } });
    }
  }

  // --- render --------------------------------------------------------------
  const unit = (bsv: boolean) => (bsv ? "sats" : token?.meta?.sym ?? (dec === undefined ? "base units" : "tokens"));
  const fmtIn = (x: bigint) => (direction === "bsvToToken" ? x.toString() : formatAmount(x, dec ?? 0));
  const fmtOut = (x: bigint) => (direction === "bsvToToken" ? formatAmount(x, dec ?? 0) : x.toString());

  return (
    <>
      <section>
        <div className="section-head">
          <h2>Market</h2>
          <button type="button" onClick={() => void refresh()}>Refresh</button>
        </div>
        <p>
          Overlay: <code>{AMM_OVERLAY}</code>
          <br />
          <small>
            Refreshes every {Math.round(REFRESH_MS / 1000)} s
            {refreshedAt && ` · last ${new Date(refreshedAt).toLocaleTimeString()}`}
            {` · validators live: a beat within ${Math.round(LIVE_WINDOW_MS / 1000)} s on the token's tm_mandala_<txid>_0-live`}
          </small>
        </p>
        {instanceError && <p className="bad">Instance: {instanceError}</p>}
        {!instanceError && market.length === 0 && <p><small>The instance serves no token topics.</small></p>}
        {market.map((t) => (
          <div key={t.topic.topic} className="market-token">
            <h3>
              <Icon icon={t.meta?.icon} /> {t.meta?.sym ?? "Token"} <Id value={t.topic.tokenId} kind="token" />
              {t.topic.kind === "legacy" && <small> (legacy BSV-21)</small>}
            </h3>
            {!t.meta && (
              <p>
                <small>
                  Symbol and decimals are shown for tokens whose deploy output the connected wallet holds; for other tokens, metadata
                  is a later lookup question. Amounts are in base units.
                </small>
              </p>
            )}
            <LiveLine t={t} />
            {t.error ? (
              <p className="bad">Lookup {t.topic.tokenId}: {t.error}</p>
            ) : t.pools.length === 0 ? (
              <p><small>No pools indexed for this token.</small></p>
            ) : (
              <div className="scroll">
                <table className="tokens">
                  <thead>
                    <tr>
                      <th>Pool</th>
                      <th className="num">Sats</th>
                      <th className="num">Tokens</th>
                      <th className="num">Fees LP / val. / comm.</th>
                      <th className="num">Price (sats per {t.pools[0]!.priceUnit})</th>
                      <th>Validator</th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.pools.map((r) => (
                      <tr key={r.pool.outpoint}>
                        <td><Id value={r.pool.outpoint} kind="outpoint" /></td>
                        <td className="num">{r.pool.bsvReserve.toString()}</td>
                        <td className="num">{formatAmount(r.pool.tokenReserve, t.meta?.dec ?? 0)}</td>
                        <td className="num">
                          {r.pool.liquidityFeeBps.toString()} / {r.pool.validationFeeBps.toString()} / {r.pool.commissionBps.toString()} bps
                        </td>
                        <td className="num">{r.price}</td>
                        <td>
                          <LiveDot v={r.validator} /> <code title={r.validator.identityKey}>{shortKey(r.validator.identityKey)}</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
      </section>

      <section>
        <h2>Swap</h2>
        <div className="form-row">
          <label>
            Token
            <select value={selected} onChange={(e) => setSelected(e.target.value)}>
              {market.map((t) => (
                <option key={t.topic.tokenId} value={t.topic.tokenId}>
                  {(t.meta?.sym ? `${t.meta.sym} · ` : "") + shortTokenId(t.topic.tokenId)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Direction
            <select value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
              <option value="bsvToToken">sats → {unit(false)}</option>
              <option value="tokenToBsv">{unit(false)} → sats</option>
            </select>
          </label>
        </div>
        <div className="form-row">
          <label>
            Amount in ({unit(direction === "bsvToToken")})
            <input value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value)} placeholder={direction === "bsvToToken" ? "satoshis" : "tokens"} />
          </label>
          <label>
            Max slippage (bps)
            <input value={slippageBps} inputMode="numeric" onChange={(e) => setSlippageBps(e.target.value)} />
          </label>
        </div>
        <label>
          <input type="checkbox" checked={allowPartial} onChange={(e) => setAllowPartial(e.target.checked)} />
          Split across several pools
        </label>
        <p>
          <small>
            Commission: each pool&apos;s own rate (CommissionBps, fixed at deploy), taken from the amount in, paid{" "}
            {!connected || !authFetch
              ? "where this instance's relay says (amm.swap.terms; connect a wallet to ask)"
              : termsError
                ? `— amm.swap.terms failed: ${termsError}`
                : !terms
                  ? "where this instance's relay says (asking amm.swap.terms…)"
                  : terms.commissionPkh
                    ? <>to the relay&apos;s address <code>{terms.commissionPkh}</code></>
                    : "to you: this relay names no commission address, so the commission goes to a key of your own wallet"}
          </small>
        </p>

        {raceNote && <p className="warn">{raceNote}</p>}
        {planned && "error" in planned && amount && <p className="bad">{planned.error}</p>}
        {view && (
          <>
            {view.legs.length === 0 ? (
              <p className="bad">No pool can fill this order{allowPartial ? "" : " in one swap within the slippage bound"}.</p>
            ) : (
              <div className="scroll">
                <table className="tokens">
                  <thead>
                    <tr>
                      <th>Pool</th>
                      <th className="num">In</th>
                      <th className="num">Out</th>
                      <th className="num">LP fee</th>
                      <th className="num">Validator fee</th>
                      <th className="num">Commission</th>
                      <th>Validator</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.legs.map((l) => (
                      <tr key={l.outpoint}>
                        <td><Id value={l.outpoint} kind="outpoint" /></td>
                        <td className="num">{fmtIn(l.amountIn)}</td>
                        <td className="num">{fmtOut(l.amountOut)}</td>
                        <td className="num">{fmtIn(l.lpFee)}</td>
                        <td className="num">{fmtIn(l.validatorFee)}</td>
                        <td className="num">{l.commission > 0n ? fmtIn(l.commission) : "—"}</td>
                        <td><LiveDot v={l.validator} /> <code title={l.validator.identityKey}>{shortKey(l.validator.identityKey)}</code></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p>
              Total: {fmtIn(view.totalIn)} {unit(direction === "bsvToToken")} → <strong>{fmtOut(view.totalOut)} {unit(direction !== "bsvToToken")}</strong>
              {view.unfilled > 0n && <span className="warn"> · {fmtIn(view.unfilled)} unfilled</span>}
              <br />
              <small>
                Effective price {view.effectivePrice} sats per {dec === undefined ? "base unit" : "token"} · mid {view.midPrice} · {Number(view.slippageVsMidBps) / 100}% below mid
                (fees included) · minimum out {fmtOut(view.minAmountOut)}
                {view.meetsSlippageBound ? "" : " · outside the slippage bound"}
                {` · fees LP ${fmtIn(view.lpFees)}, validator ${fmtIn(view.validatorFees)}, commission ${fmtIn(view.commissions)} ${unit(direction === "bsvToToken")}`}
              </small>
            </p>
            <p>
              <small>Only pools whose validator is live (a beat within {Math.round((tokenLive?.windowMs ?? LIVE_WINDOW_MS) / 1000)} s) are planned; each swap names its validator&apos;s peer for the relay to dial.</small>
            </p>
          </>
        )}

        <p>
          <small>Miner fee rate: {FEE_RATE_SATS_PER_KB} sats/kB (VITE_FEE_RATE), paid from the swap&apos;s exact funding output.</small>
        </p>
        <button
          type="button"
          onClick={() => void swap()}
          disabled={!connected || !authFetch || !view || view.legs.length === 0 || building || !view.meetsSlippageBound || legs.some((l) => l.status === "relaying")}
        >
          {building ? "Building…" : "Swap"}
        </button>
        {!connected && <p><small>Connect a wallet to swap; the plan needs none.</small></p>}
        {walletError && <p className="bad">Wallet: {walletError}</p>}
      </section>

      {legs.length > 0 && (
        <section>
          <h2>Swaps</h2>
          <p>
            <small>
              Per leg: a funding transaction the wallet signs and keeps unsent, and the swap spending it, both sent to the validator
              through this instance&apos;s relay (<code>amm.swap.submit</code>). The validator signs last and broadcasts both.
            </small>
          </p>
          {legs.map((l) => (
            <div key={l.outpoint} className="leg">
              <h3>
                Pool <Id value={l.outpoint} kind="outpoint" />
              </h3>
              <ValidatorLine v={l.validator} />
              {"prepared" in l ? (
                <LegStatus l={l} onRetry={() => void retry(l)} onAbandon={() => void abandon(l)} />
              ) : l.status === "not_built" ? (
                <NotBuilt>{l.reason}</NotBuilt>
              ) : (
                <p className="bad">{l.reason}</p>
              )}
            </div>
          ))}
        </section>
      )}
    </>
  );
}

/** A token's validators live: its liveness read (`GET <base>/.live/tm_mandala_<txid>_0-live`), newest first. */
function LiveLine({ t }: { t: MarketToken }) {
  if (t.liveError) return <p className="warn"><small>Liveness ({t.topic.topic}-live): {t.liveError}</small></p>;
  const l = t.live;
  if (!l) return null;
  if (!l.kept) return <p><small>This instance keeps no liveness for {t.topic.topic}-live: no validator is known live, so no pool can be planned.</small></p>;
  const live = l.validators.filter((v) => v.live);
  return (
    <p>
      <small>
        Validators live (a beat within {Math.round(l.windowMs / 1000)} s):{" "}
        {live.length === 0
          ? "none"
          : live.map((v, i) => (
              <span key={v.identityKey}>
                {i > 0 && ", "}
                <code title={`${v.identityKey}\npeer ${v.peerId}`}>{shortKey(v.identityKey)}</code> ({ago(v.ageMs)})
              </span>
            ))}
      </small>
    </p>
  );
}

function ValidatorLine({ v }: { v: ValidatorStatus }) {
  return (
    <p>
      Validator <LiveDot v={v} /> <code>{v.identityKey}</code>
      <br />
      <small>
        {v.seen ? `peer ${v.peerId || "?"} · ${v.live ? "live" : "not live"} (last beat ${Math.round((v.ageMs ?? 0) / 1000)} s ago)` : "not in this token's liveness read: peer unknown"}
      </small>
    </p>
  );
}

function LegStatus({ l, onRetry, onAbandon }: { l: Extract<LegResult, { prepared: PreparedSwap }>; onRetry: () => void; onAbandon: () => void }) {
  const p = l.prepared;
  const o = l.outcome;
  return (
    <>
      <p>
        <small>
          Funding <Id value={p.funding.txid} kind="txid" />: {p.funding.satoshis} sats ({p.funding.outputs} to the swap&apos;s outputs + {p.funding.fee} miner fee for{" "}
          {p.funding.size} bytes) · swap {p.swap.toBinary().length} bytes before the validator&apos;s signature
          {p.payout.kind === "brc29" && ` · payout ${p.payout.satoshis} sats as a BRC-29 payment (also under Pending payouts)`}
          {p.commission.to === "relay" && ` · commission ${p.commission.amount} to the relay (${p.commission.pkh})`}
          {p.commission.to === "own" && ` · commission ${p.commission.amount} to your own wallet${p.commission.payout?.kind === "brc29" ? " (BRC-29, also under Pending payouts)" : ""}`}
        </small>
      </p>
      {!o && <p>Waiting for the validator…</p>}
      {o?.status === "accepted" && (
        <p className={o.completed.errors.length ? "warn" : "ok"}>
          Accepted: <Id value={o.txid} kind="txid" />
          {o.completed.internalized ? ` · payout${p.commission.payout ? " and commission" : ""} in your wallet` : " · payout not internalized yet"}
          {o.completed.errors.map((e) => (
            <span key={e}><br /><small>{e}</small></span>
          ))}
        </p>
      )}
      {o?.status === "refused" && (
        <p className="bad">
          Refused: {o.reason}. The funding was released{o.pool ? "; the plan is recomputed from the pool's current state" : ""}.
        </p>
      )}
      {o?.status === "timeout" && <p className="bad">The validator did not answer in time. The funding was released.</p>}
      {o?.status === "failed" && <p className="bad">{o.reason}. The funding was released.</p>}
      {o?.status === "unknown" && (
        <>
          <p className="warn">
            No final answer: {o.reason}. The funding output stays held until {new Date(p.expires).toLocaleTimeString()}; the relay may still carry
            the swap.
          </p>
          {o.id && <button type="button" onClick={onRetry}>Check again</button>}
          <button type="button" onClick={onAbandon}>Abandon (abort the funding)</button>
        </>
      )}
    </>
  );
}

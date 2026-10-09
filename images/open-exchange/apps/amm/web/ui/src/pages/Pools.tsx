/**
 * The Pools page: pick a validator, create a pool from a token in the
 * wallet (nosend funding + page-built deploy, relayed to the validator by
 * the user's own skein: src/lp/poolDeploy.ts, src/lp/deployFlow.ts), and the
 * wallet's own pools with RemoveLiquidity (broadcast funding + page-built
 * remove, submitted to the overlay: src/lp/removeLiquidity.ts) and
 * AddLiquidity (nosend funding + page-built add, relayed to the validator:
 * src/lp/addLiquidity.ts, src/lp/liquidityRelay.ts). Every key
 * and signature comes from the connected BRC-100 wallet; the instance is
 * `AMM_OVERLAY`.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "../wallet/AppWalletProvider";
import { LiveTable } from "./LiveTable";
import { AMM_OVERLAY, FEE_RATE_SATS_PER_KB } from "../lib/config";
import { fetchLiveByToken, listTokenTopics, mergeLive, type LiveAnswer } from "../lib/overlay";
import { loadWalletAssets, type WalletAssets } from "../lp/wallet";
import { buildInventory } from "../lp/inventory";
import { formatAmount, parseAmount } from "../lp/amounts";
import { shortKey, marginalPrice } from "../market/view";
import { shortTokenId } from "../lib/tokenId";
import { Id } from "../components/Id";
import {
  ago,
  choiceFor,
  findLive,
  livenessOf,
  parsePickerInput,
  resolveHandle,
  type ValidatorChoice,
} from "../lp/validators";
import {
  DEFAULT_LP_FEE_BPS,
  DEFAULT_VALIDATOR_FEE_BPS,
  abandonPoolDeploy,
  deriveLpKey,
  planPoolDeploy,
  poolableTokens,
  preparePoolDeploy,
  selectDepositInputs,
  type PoolDeployPlan,
  type PreparedPoolDeploy,
} from "../lp/poolDeploy";
import { checkPoolDeployAgain, relayPoolDeploy, type DeployOutcome, type DeployRelayContext } from "../lp/deployFlow";
import { findMyPools, type MyPool } from "../lp/myPools";
import {
  completeRemoveLiquidity,
  pendingRemovePayout,
  prepareRemoveLiquidity,
  steakText,
  submitToOverlay,
  admittedOutput,
  awaitAdmitted,
  type CompletedRemove,
  type PreparedRemoveLiquidity,
} from "../lp/removeLiquidity";
import { TOKEN_SPLIT, abandonAddLiquidity, prepareAddLiquidity, satsAtRatio, selectAddTokenInputs, tokensAtRatio, type PreparedAddLiquidity } from "../lp/addLiquidity";
import { checkAddLiquidityAgain, relayAddLiquidity, type AddOutcome, type AddRelayContext } from "../lp/liquidityRelay";
import { tokenInputsOf } from "../market/swapAction";
import { useAuthFetch } from "../wallet/authFetch";
import { PendingPayoutStore } from "../wallet/pendingPayouts";

const payouts = new PendingPayoutStore();

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function CopyHex({ hex }: { hex: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" onClick={() => void navigator.clipboard.writeText(hex).then(() => setCopied(true))}>
      {copied ? "Copied" : "Copy hex"}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Validator picker
// ---------------------------------------------------------------------------

export function ValidatorPicker(props: { live: LiveAnswer | null; value: ValidatorChoice | null; onChange: (c: ValidatorChoice | null) => void }) {
  const { live, value, onChange } = props;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function use() {
    setError(null);
    const p = parsePickerInput(text);
    if (p.kind === "invalid") return setError(p.reason);
    if (p.kind === "key") return onChange(choiceFor(p.identityKey, live));
    setBusy(true);
    try {
      const r = await resolveHandle(p.name, p.domain);
      onChange(choiceFor(r.identityKey, live, r.handle));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const status = value ? livenessOf(value.identityKey, live) : null;
  return (
    <fieldset>
      <legend>Validator</legend>
      {live && live.validators.length > 0 ? (
        <LiveTable live={live} selected={value?.identityKey} onSelect={(k) => onChange(choiceFor(k, live))} />
      ) : (
        <p><small>No validator is live in this instance&apos;s liveness read ({AMM_OVERLAY}/.live/tm_mandala_&lt;txid&gt;_0-live, for the tokens it serves).</small></p>
      )}
      <div className="form-row">
        <label>
          Or a BRC-169 handle (name@domain) or an identity key
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="amm3@localhost:8400 or 03…" />
        </label>
        <button type="button" onClick={() => void use()} disabled={busy || !text.trim()}>
          {busy ? "Resolving…" : "Use"}
        </button>
      </div>
      {error && <p className="bad" role="alert">{error}</p>}
      {value && (
        <p>
          Chosen: <code>{value.identityKey}</code>
          {value.handle && <> ({value.handle})</>}
          <br />
          <small>
            <span className={`dot ${status === "live" ? "dot-live" : "dot-off"}`} /> {status}
            {value.peerId && <> · peer <code>{value.peerId}</code></>}
            {status === "not seen live" && " · not in this instance's liveness read: no peer ID to name, so the relay cannot be asked to reach it"}
          </small>
        </p>
      )}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Create pool
// ---------------------------------------------------------------------------

function CreatePool(props: { assets: WalletAssets; live: LiveAnswer | null; onSigned: () => void }) {
  const { wallet } = useWallet();
  const authFetch = useAuthFetch();
  const meta = useMemo(() => {
    const inv = buildInventory(props.assets.tokenRows);
    return new Map(inv.tokens.map((t) => [t.tokenId, { sym: t.sym, dec: t.dec }]));
  }, [props.assets]);
  const { tokens, hidden } = useMemo(() => poolableTokens(props.assets.tokenRows, meta), [props.assets, meta]);

  const [tokenId, setTokenId] = useState("");
  const [tokenAmount, setTokenAmount] = useState("");
  const [sats, setSats] = useState("");
  const [lpFee, setLpFee] = useState(String(DEFAULT_LP_FEE_BPS));
  const [valFee, setValFee] = useState(String(DEFAULT_VALIDATOR_FEE_BPS));
  const [commission, setCommission] = useState("0");
  const [validator, setValidator] = useState<ValidatorChoice | null>(null);
  const [lpPub, setLpPub] = useState<{ key: string; pub: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deploy, setDeploy] = useState<{ prepared: PreparedPoolDeploy; outcome?: DeployOutcome } | null>(null);

  useEffect(() => {
    if (!tokenId && tokens[0]) setTokenId(tokens[0].tokenId);
  }, [tokens, tokenId]);
  const token = tokens.find((t) => t.tokenId === tokenId);
  const dec = token?.dec ?? 0;

  type Form =
    | { error: string }
    | { tokensIn: bigint; sats: bigint; lpFeeBps: bigint; validatorFeeBps: bigint; commissionBps: bigint; sel: NonNullable<ReturnType<typeof selectDepositInputs>> };
  const form: Form = useMemo((): Form => {
    if (!token) return { error: "pick a token" };
    let tokensIn: bigint;
    try {
      tokensIn = parseAmount(tokenAmount, dec);
    } catch (e) {
      return { error: `token amount: ${errText(e)}` };
    }
    if (tokensIn <= 0n) return { error: "token amount must be positive" };
    if (!/^\d+$/.test(sats.trim()) || BigInt(sats.trim()) <= 0n) return { error: "sats must be a positive integer" };
    if (!/^\d+$/.test(lpFee.trim()) || !/^\d+$/.test(valFee.trim()) || !/^\d+$/.test(commission.trim())) return { error: "fees and commission are integer bps" };
    if (!validator) return { error: "choose a validator" };
    const sel = selectDepositInputs(token.inputs, tokensIn);
    if (!sel) return { error: `the wallet holds ${formatAmount(token.balance, dec)} ${token.sym ?? ""} in ${token.inputs.length} output(s), less than the deposit` };
    return { tokensIn, sats: BigInt(sats.trim()), lpFeeBps: BigInt(lpFee.trim()), validatorFeeBps: BigInt(valFee.trim()), commissionBps: BigInt(commission.trim()), sel };
  }, [token, tokenAmount, dec, sats, lpFee, valFee, commission, validator]);

  const first = "sel" in form ? form.sel.inputs[0] : undefined;
  const firstKey = first ? `${first.txid}_${first.vout}` : "";
  useEffect(() => {
    if (!wallet || !first) return;
    if (lpPub?.key === firstKey) return;
    let gone = false;
    deriveLpKey(wallet, first)
      .then((k) => !gone && setLpPub({ key: firstKey, pub: k.publicKey }))
      .catch((e) => !gone && setError(`LP key: ${errText(e)}`));
    return () => {
      gone = true;
    };
  }, [wallet, first, firstKey, lpPub]);

  const plan: PoolDeployPlan | string = useMemo(() => {
    if ("error" in form) return form.error as string;
    if (!lpPub || lpPub.key !== firstKey) return "deriving the LP key from the wallet…";
    try {
      return planPoolDeploy({
        tokenId,
        inputs: form.sel.inputs,
        tokens: form.tokensIn,
        sats: form.sats,
        lpFeeBps: form.lpFeeBps,
        validatorFeeBps: form.validatorFeeBps,
        commissionBps: form.commissionBps,
        lpPubKey: lpPub.pub,
        validator: validator!,
        dec: token?.dec,
      });
    } catch (e) {
      return errText(e);
    }
  }, [form, lpPub, firstKey, tokenId, validator, token]);

  const relayCtx = (): DeployRelayContext | null => (wallet && authFetch ? { wallet, authFetch, base: AMM_OVERLAY } : null);

  async function create() {
    const ctx = relayCtx();
    if (!ctx || typeof plan === "string" || "error" in form || !validator) return;
    // The deploy names the validator's peer (from the liveness read) for the relay to dial.
    const peerId = validator.peerId;
    if (!peerId) {
      setError("the chosen validator is not in this instance's liveness read: no peer ID to name for the relay");
      return;
    }
    setBusy(true);
    setError(null);
    let prepared: PreparedPoolDeploy;
    try {
      prepared = await preparePoolDeploy({
        wallet: ctx.wallet,
        form: { tokenId, inputs: form.sel.inputs, tokens: form.tokensIn, sats: form.sats, lpFeeBps: form.lpFeeBps, validatorFeeBps: form.validatorFeeBps, commissionBps: form.commissionBps, validator },
        meta: { sym: token?.sym, dec: token?.dec },
        satsPerKb: FEE_RATE_SATS_PER_KB,
      });
    } catch (e) {
      setError(errText(e));
      setBusy(false);
      return;
    }
    setDeploy({ prepared });
    const outcome = await relayPoolDeploy(ctx, prepared, peerId).catch((e): DeployOutcome => ({ status: "unknown", reason: errText(e) }));
    setDeploy({ prepared, outcome });
    setBusy(false);
    props.onSigned();
  }

  async function checkAgain() {
    const ctx = relayCtx();
    const o = deploy?.outcome;
    if (!ctx || !deploy || o?.status !== "unknown" || !o.id) return;
    setDeploy({ prepared: deploy.prepared, outcome: await checkPoolDeployAgain(ctx, deploy.prepared, o.id) });
    props.onSigned();
  }

  async function abandon() {
    if (!wallet || !deploy) return;
    try {
      await abandonPoolDeploy(wallet, deploy.prepared);
      setDeploy({ prepared: deploy.prepared, outcome: { status: "failed", reason: "abandoned: the funding action was aborted" } });
      props.onSigned();
    } catch (e) {
      setError(`abortAction: ${errText(e)}`);
    }
  }

  const finished = deploy?.outcome && deploy.outcome.status !== "unknown";

  return (
    <section className="panel">
      <h2>Create a pool</h2>
      {tokens.length === 0 ? (
        <p><small>No Mandala token outputs with a wallet key in this wallet&apos;s bsv21 basket.</small></p>
      ) : (
        <div className="form-row">
          <label>
            Token
            <select value={tokenId} onChange={(e) => setTokenId(e.target.value)}>
              {tokens.map((t) => (
                <option key={t.tokenId} value={t.tokenId}>
                  {(t.sym ?? shortTokenId(t.tokenId)) + ` — ${formatAmount(t.balance, t.dec ?? 0)} in ${t.inputs.length} output(s)`}
                </option>
              ))}
            </select>
          </label>
          <label>
            Tokens to deposit{token?.dec ? ` (units of 10^-${token.dec})` : token && token.dec === undefined ? " (base units)" : ""}
            <input value={tokenAmount} onChange={(e) => setTokenAmount(e.target.value)} inputMode="decimal" />
          </label>
          <label>
            Sats to deposit
            <input value={sats} onChange={(e) => setSats(e.target.value)} inputMode="numeric" />
          </label>
          <label>
            LP fee (bps)
            <input value={lpFee} onChange={(e) => setLpFee(e.target.value)} inputMode="numeric" />
          </label>
          <label>
            Validator fee (bps)
            <input value={valFee} onChange={(e) => setValFee(e.target.value)} inputMode="numeric" />
          </label>
          <label>
            Commission (bps)
            <input value={commission} onChange={(e) => setCommission(e.target.value)} inputMode="numeric" />
          </label>
        </div>
      )}
      {token && <p><small>Token id <Id value={token.tokenId} kind="token" /></small></p>}
      {hidden.length > 0 && (
        <p><small>Hidden: {hidden.length} legacy token(s) (BRC-161 deploys, 36-byte id or JSON form). The Pool contract hard-codes a 32-byte asset id, so only Mandala-native tokens can be pooled.</small></p>
      )}
      <p><small>Fees start at 30 / 5 bps (the fixture pool&apos;s). The commission (CommissionBps, fixed at deploy) is paid on every swap, in the input asset, to whoever relays it (the address the relay names, or the taker&apos;s own key on their own overlay); 0 means no commission output, and markets filter pools by it. The validator&apos;s own terms (its instance&apos;s minimum validator fee and maximum LP fee) are not exposed by the instance&apos;s routes; it refuses a deploy outside them.</small></p>

      <ValidatorPicker live={props.live} value={validator} onChange={setValidator} />

      {token && "sel" in form && (
        <p>
          <small>
            Token inputs:{" "}
            {form.sel.inputs.map((t, n) => (
              <span key={t.outpoint}>{n > 0 && ", "}<Id value={t.outpoint} kind="outpoint" /> ({formatAmount(t.amount, dec)})</span>
            ))}
            {form.sel.change > 0n ? ` · token change back to the wallet: ${formatAmount(form.sel.change, dec)}` : " · exact, no token change"}
          </small>
        </p>
      )}

      {typeof plan === "string" ? (
        <p><small>{plan}</small></p>
      ) : (
        <div className="leg">
          <p>
            Initial price: <strong>{plan.price}</strong> sats per {token?.dec !== undefined ? "token" : "base unit"}
          </p>
          <table className="tokens">
            <tbody>
              <tr><th>Asset id (wire order)</th><td><code>{plan.args.assetId}</code></td></tr>
              <tr><th>LP fee / validator fee</th><td>{plan.args.lpFeeBps.toString()} / {plan.args.validatorFeeBps.toString()} bps</td></tr>
              <tr><th>Commission</th><td>{plan.args.commissionBps.toString()} bps</td></tr>
              <tr><th>Token reserve</th><td>{plan.state.tokenReserve.toString()} base units</td></tr>
              <tr><th>BSV reserve</th><td>{plan.sats.toString()} sats</td></tr>
              <tr><th>LP key</th><td><code>{plan.state.lpPubKey}</code><br /><small>BRC-29 wallet key, keyID <code>{plan.lpKeyId}</code></small></td></tr>
              <tr><th>Validator key</th><td><code>{plan.state.validatorPubKey}</code><br /><small>anyone-child of the identity for <code>1-amm pool-{plan.validatorKeyId}</code> (the first deposit input)</small></td></tr>
              <tr><th>Validator identity</th><td><code>{plan.state.validatorIdentity}</code></td></tr>
              <tr><th>Pool script</th><td>{plan.lockingScript.length / 2} bytes, output 0, topic <Id value={plan.topic} kind="topic" /></td></tr>
            </tbody>
          </table>
          <button type="button" onClick={() => void create()} disabled={!wallet || !authFetch || busy || (!!deploy && !finished)}>
            {busy ? "Waiting for the wallet and the validator…" : "Create the pool"}
          </button>
          <small>
            {" "}
            The wallet funds the deploy with one exact output (nosend), every input is signed by the wallet, and your instance relays both to the
            validator, who consents and broadcasts them. Miner fee rate: {FEE_RATE_SATS_PER_KB} sats/kB (VITE_FEE_RATE).
          </small>
        </div>
      )}
      {error && <p className="bad" role="alert">{error}</p>}

      {deploy && <DeployStatus d={deploy} onCheckAgain={() => void checkAgain()} onAbandon={() => void abandon()} />}
    </section>
  );
}

function DeployStatus({ d, onCheckAgain, onAbandon }: { d: { prepared: PreparedPoolDeploy; outcome?: DeployOutcome }; onCheckAgain: () => void; onAbandon: () => void }) {
  const p = d.prepared;
  const o = d.outcome;
  return (
    <div className="leg">
      <p>
        <small>
          Funding <Id value={p.funding.txid} kind="txid" />: {p.funding.satoshis} sats ({p.funding.outputs} to the deploy&apos;s outputs beyond the token inputs + {p.funding.fee} miner
          fee for {p.funding.size} bytes) · deploy <Id value={p.txid} kind="txid" />, {p.deploy.toBinary().length} bytes, {p.deploy.inputs.length} inputs,{" "}
          {p.deploy.outputs.length} outputs{p.tokenChange && " (token change back to the wallet)"}
        </small>
      </p>
      <CopyHex hex={p.deploy.toHex()} />
      {!o && <p>Waiting for the validator…</p>}
      {o?.status === "accepted" && (
        <p className={o.completed.errors.length ? "warn" : "ok"}>
          Pool created: <Id value={o.completed.pool} kind="outpoint" />
          {o.completed.internalized ? " · filed in your wallet" : " · not filed in the wallet yet"}
          {o.completed.errors.map((e) => (
            <span key={e}><br /><small>{e}</small></span>
          ))}
        </p>
      )}
      {o?.status === "refused" && <p className="bad">Refused: {o.reason}. The funding was released.</p>}
      {o?.status === "timeout" && <p className="bad">The validator did not answer in time. The funding was released.</p>}
      {o?.status === "failed" && <p className="bad">{o.reason}. The funding was released.</p>}
      {o?.status === "unknown" && (
        <>
          <p className="warn">
            No final answer: {o.reason}. The funding output stays held until {new Date(p.expires).toLocaleTimeString()}; the relay may still carry the deploy.
          </p>
          {o.id && <button type="button" onClick={onCheckAgain}>Check again</button>}
          <button type="button" onClick={onAbandon}>Abandon (abort the funding)</button>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// My pools
// ---------------------------------------------------------------------------

function RemoveForm({ p, meta, onDone }: { p: MyPool; meta?: { sym?: string; dec?: number }; onDone: () => void }) {
  const { wallet } = useWallet();
  const authFetch = useAuthFetch();
  const [bsv, setBsv] = useState("");
  const [tok, setTok] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PreparedRemoveLiquidity | null>(null);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [completed, setCompleted] = useState<CompletedRemove | null>(null);
  const dec = meta?.dec ?? 0;

  /** Submit, then the wallet takes the withdrawals in; the pending payout record stays until it has. */
  async function submitAndComplete(s: PreparedRemoveLiquidity) {
    if (!wallet) return;
    const r = await submitToOverlay(AMM_OVERLAY, s.topic, s.beef);
    setSubmitted(`submitted: ${steakText(r)}`);
    const at = admittedOutput(s);
    if (at !== null) setSubmitted((await awaitAdmitted(authFetch, AMM_OVERLAY, s.txid, at)) ? `admitted (${steakText(r)})` : `submitted (${steakText(r)}), not admitted yet: the lookup does not show it`);
    const c = await completeRemoveLiquidity(wallet, s);
    setCompleted(c);
    const pending = pendingRemovePayout(s, p.topic.tokenId);
    if (pending && c.internalized) payouts.remove(pending.id);
    onDone();
  }

  async function remove() {
    if (!wallet) return;
    setBusy(true);
    setError(null);
    try {
      const removeBsv = bsv.trim() ? BigInt(bsv.trim()) : 0n;
      const removeTokens = tok.trim() ? parseAmount(tok, dec) : 0n;
      const s = await prepareRemoveLiquidity({ wallet, tokenId: p.topic.tokenId, meta, poolOutput: p.output, lpKey: p.lpKey, removeBsv, removeTokens, satsPerKb: FEE_RATE_SATS_PER_KB });
      // Durable before it is submitted: the remittance is what lets the wallet spend the withdrawal.
      const pending = pendingRemovePayout(s, p.topic.tokenId);
      if (pending) payouts.save(pending);
      setPrepared(s);
      await submitAndComplete(s);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitAgain() {
    if (!prepared) return;
    setBusy(true);
    setError(null);
    try {
      await submitAndComplete(prepared);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="leg">
      <div className="form-row">
        <label>
          Sats to remove
          <input value={bsv} onChange={(e) => setBsv(e.target.value)} inputMode="numeric" />
        </label>
        <label>
          Tokens to remove
          <input value={tok} onChange={(e) => setTok(e.target.value)} inputMode="decimal" />
        </label>
        <button
          type="button"
          onClick={() => {
            setBsv(p.state.bsvReserve.toString());
            setTok(formatAmount(p.state.tokenReserve, dec));
          }}
        >
          All (close)
        </button>
      </div>
      <button type="button" onClick={() => void remove()} disabled={!wallet || busy || !!prepared}>
        {busy && !prepared ? "Waiting for the wallet…" : "Remove liquidity"}
      </button>
      <small> LP-only (no validator): the wallet funds and broadcasts the miner fee at once, signs the pool input as LP, and the page submits the remove to the overlay.</small>
      {prepared && (
        <>
          <p>
            <small>
              Funding <Id value={prepared.funding.txid} kind="txid" /> (broadcast by the wallet): {prepared.funding.satoshis} sats ({prepared.funding.outputs} for Mandala outputs +{" "}
              {prepared.funding.fee} miner fee for {prepared.funding.size} bytes)
              <br />
              Remove <Id value={prepared.txid} kind="txid" />: {prepared.size} bytes{prepared.plan.closing ? " · closes the pool" : ""}
            </small>
          </p>
          <CopyHex hex={prepared.hex} />
          {!submitted && !busy && (
            <>
              <button type="button" onClick={() => void submitAgain()}>Submit again</button>
              <small> The funding output stays in 1sat-deposit (held until {new Date(prepared.expires).toLocaleTimeString()}, then sweepable) if the remove never lands.</small>
            </>
          )}
        </>
      )}
      {submitted && <p className="ok">Submitted ({prepared && <Id value={prepared.topic} kind="topic" />}): <code>{submitted}</code></p>}
      {completed && (
        <p className={completed.internalized && completed.errors.length === 0 ? "ok" : "warn"}>
          Withdrawals {completed.internalized ? "in your wallet" : "not internalized (a sats withdrawal stays under Pending payouts)"}
          {completed.errors.map((e) => (
            <span key={e}><br /><small>{e}</small></span>
          ))}
        </p>
      )}
      {error && <p className="bad" role="alert">{error}</p>}
    </div>
  );
}

function AddForm({ p, meta, tokenRows, peerId, onDone }: { p: MyPool; meta?: { sym?: string; dec?: number }; tokenRows: WalletAssets["tokenRows"]; peerId?: string; onDone: () => void }) {
  const { wallet } = useWallet();
  const authFetch = useAuthFetch();
  const [bsv, setBsv] = useState("");
  const [tok, setTok] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [add, setAdd] = useState<{ prepared: PreparedAddLiquidity; outcome?: AddOutcome } | null>(null);
  const dec = meta?.dec ?? 0;
  const sym = meta?.sym ?? "tokens";

  type Form = { error: string } | { addBsv: bigint; addTokens: bigint; inputs: NonNullable<ReturnType<typeof selectAddTokenInputs>> };
  const form: Form = useMemo((): Form => {
    let addBsv = 0n;
    let addTokens = 0n;
    if (bsv.trim()) {
      if (!/^\d+$/.test(bsv.trim())) return { error: "sats must be a whole number" };
      addBsv = BigInt(bsv.trim());
    }
    try {
      addTokens = tok.trim() ? parseAmount(tok, dec) : 0n;
    } catch (e) {
      return { error: `token amount: ${errText(e)}` };
    }
    if (addBsv + addTokens <= 0n) return { error: "enter sats and/or tokens to add" };
    const inputs = selectAddTokenInputs(tokenInputsOf(tokenRows, p.topic.tokenId), addTokens);
    if (!inputs) return { error: TOKEN_SPLIT };
    return { addBsv, addTokens, inputs };
  }, [bsv, tok, dec, tokenRows, p.topic.tokenId]);

  const after = "addBsv" in form ? { ...p.state, bsvReserve: p.state.bsvReserve + form.addBsv, tokenReserve: p.state.tokenReserve + form.addTokens } : null;
  const relayCtx = (): AddRelayContext | null => (wallet && authFetch ? { wallet, authFetch, base: AMM_OVERLAY } : null);

  async function submit() {
    const ctx = relayCtx();
    if (!ctx || !("addBsv" in form)) return;
    if (!peerId) {
      setError("the pool's validator is not in this instance's liveness read: no peer ID to name for the relay");
      return;
    }
    setBusy(true);
    setError(null);
    let prepared: PreparedAddLiquidity;
    try {
      prepared = await prepareAddLiquidity({
        wallet: ctx.wallet,
        tokenId: p.topic.tokenId,
        meta,
        poolOutput: p.output,
        lpKey: p.lpKey,
        addBsv: form.addBsv,
        addTokens: form.addTokens,
        tokenInputs: form.inputs,
        satsPerKb: FEE_RATE_SATS_PER_KB,
      });
    } catch (e) {
      setError(errText(e));
      setBusy(false);
      return;
    }
    setAdd({ prepared });
    const outcome = await relayAddLiquidity(ctx, prepared, peerId).catch((e): AddOutcome => ({ status: "unknown", reason: errText(e) }));
    setAdd({ prepared, outcome });
    setBusy(false);
    // Accepted: the pool moved; refused: the pool's state changed — reload "my pools" to replan from it.
    if (outcome.status !== "unknown") onDone();
  }

  async function checkAgain() {
    const ctx = relayCtx();
    const o = add?.outcome;
    if (!ctx || !add || o?.status !== "unknown" || !o.id) return;
    const outcome = await checkAddLiquidityAgain(ctx, add.prepared, o.id);
    setAdd({ prepared: add.prepared, outcome });
    if (outcome.status !== "unknown") onDone();
  }

  async function abandon() {
    if (!wallet || !add) return;
    try {
      await abandonAddLiquidity(wallet, add.prepared);
      setAdd({ prepared: add.prepared, outcome: { status: "failed", reason: "abandoned: the funding action was aborted" } });
    } catch (e) {
      setError(`abortAction: ${errText(e)}`);
    }
  }

  const finished = add?.outcome && add.outcome.status !== "unknown";
  const o = add?.outcome;
  return (
    <div className="leg">
      <div className="form-row">
        <label>
          Sats to add
          <input value={bsv} onChange={(e) => setBsv(e.target.value)} inputMode="numeric" />
        </label>
        <button type="button" onClick={() => bsv.trim() && /^\d+$/.test(bsv.trim()) && setTok(formatAmount(tokensAtRatio(p.state, BigInt(bsv.trim())), dec))}>
          Tokens at the current price
        </button>
        <label>
          Tokens to add
          <input value={tok} onChange={(e) => setTok(e.target.value)} inputMode="decimal" />
        </label>
        <button
          type="button"
          onClick={() => {
            try {
              if (tok.trim()) setBsv(satsAtRatio(p.state, parseAmount(tok, dec)).toString());
            } catch {
              /* the form shows the parse error */
            }
          }}
        >
          Sats at the current price
        </button>
      </div>
      <p>
        <small>
          The contract does not fix the ratio (you own the pool): any amounts go in. Price now {marginalPrice(p.state, meta?.dec)}
          {after && <> · after {marginalPrice(after, meta?.dec)} ({after.bsvReserve.toString()} sats · {formatAmount(after.tokenReserve, dec)} {sym})</>}
          {"inputs" in form && form.inputs.length > 0 && (
            <>
              {" "}· token inputs{" "}
              {form.inputs.map((t, n) => (
                <span key={t.outpoint}>{n > 0 && ", "}<Id value={t.outpoint} kind="outpoint" /></span>
              ))}{" "}
              (exact)
            </>
          )}
        </small>
      </p>
      {"error" in form && (bsv.trim() || tok.trim()) && <p><small>{form.error}</small></p>}
      <button type="button" onClick={() => void submit()} disabled={!wallet || !authFetch || busy || "error" in form || (!!add && !finished)}>
        {busy ? "Waiting for the wallet and the validator…" : "Add liquidity"}
      </button>
      <small>
        {" "}
        Needs the validator (tokens in): the wallet funds the deposit with one exact output (nosend), signs the pool input as LP and the funding and token
        inputs, and your instance relays both to the validator, who signs last and broadcasts them. Miner fee rate: {FEE_RATE_SATS_PER_KB} sats/kB.
      </small>
      {add && (
        <>
          <p>
            <small>
              Funding <Id value={add.prepared.funding.txid} kind="txid" />: {add.prepared.funding.satoshis} sats ({add.prepared.funding.outputs} beyond the token inputs&apos; sats +{" "}
              {add.prepared.funding.fee} miner fee for {add.prepared.funding.size} bytes) · add {add.prepared.tx.inputs.length} inputs, the pool continuation only · next LP key{" "}
              <code>{add.prepared.nextLpKey.keyID}</code>
            </small>
          </p>
          <CopyHex hex={add.prepared.tx.toHex()} />
          {!o && <p>Waiting for the validator…</p>}
          {o?.status === "accepted" && (
            <p className={o.completed.errors.length ? "warn" : "ok"}>
              Added: the pool is now <Id value={o.completed.pool} kind="outpoint" />
              {o.completed.internalized ? " · filed in your wallet" : " · not filed in the wallet yet"}
              {o.completed.errors.map((e) => (
                <span key={e}><br /><small>{e}</small></span>
              ))}
            </p>
          )}
          {o?.status === "refused" && (
            <p className="bad">
              Refused: {o.reason}. The funding was released.
              {o.pool && <> The pool is now <Id value={o.pool.outpoint} kind="outpoint" /> ({o.pool.bsvReserve.toString()} sats · {formatAmount(o.pool.tokenReserve, dec)} {sym}); my pools is reloaded to plan again.</>}
            </p>
          )}
          {o?.status === "timeout" && <p className="bad">The validator did not answer in time. The funding was released.</p>}
          {o?.status === "failed" && <p className="bad">{o.reason}. The funding was released.</p>}
          {o?.status === "unknown" && (
            <>
              <p className="warn">
                No final answer: {o.reason}. The funding output stays held until {new Date(add.prepared.expires).toLocaleTimeString()}; the relay may still carry the deposit.
              </p>
              {o.id && <button type="button" onClick={() => void checkAgain()}>Check again</button>}
              <button type="button" onClick={() => void abandon()}>Abandon (abort the funding)</button>
            </>
          )}
        </>
      )}
      {error && <p className="bad" role="alert">{error}</p>}
    </div>
  );
}

function MyPools(props: { assets: WalletAssets; live: LiveAnswer | null; refreshKey: number }) {
  const { wallet } = useWallet();
  const authFetch = useAuthFetch();
  const [pools, setPools] = useState<MyPool[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ outpoint: string; form: "add" | "remove" } | null>(null);
  const meta = useMemo(() => new Map(buildInventory(props.assets.tokenRows).tokens.map((t) => [t.tokenId, { sym: t.sym, dec: t.dec }])), [props.assets]);

  const load = useCallback(async () => {
    if (!wallet) return;
    setBusy(true);
    setError(null);
    try {
      const topics = await listTokenTopics(AMM_OVERLAY);
      const r = await findMyPools(authFetch, AMM_OVERLAY, wallet, topics, props.assets.tokenRows);
      setPools(r.pools);
      setWarnings(r.warnings);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }, [wallet, authFetch, props.assets]);

  useEffect(() => {
    void load();
  }, [load, props.refreshKey]);

  return (
    <section className="panel">
      <div className="section-head">
        <h2>My pools</h2>
        <button type="button" onClick={() => void load()} disabled={busy || !wallet}>
          {busy ? "Looking…" : "Refresh"}
        </button>
      </div>
      <p><small>Pools on {AMM_OVERLAY} whose LP key is one of this wallet&apos;s keys (or whose output is in its bsv21 basket as a pool).</small></p>
      {error && <p className="bad" role="alert">{error}</p>}
      {pools && pools.length === 0 && <p><small>None.</small></p>}
      {pools?.map((p) => {
        const m = meta.get(p.topic.tokenId);
        const v = findLive(p.state.validatorIdentityKey, props.live);
        return (
          <div key={p.state.outpoint} className="leg">
            <p>
              <strong>{m?.sym ?? <Id value={p.topic.tokenId} kind="token" />}</strong> · <Id value={p.state.outpoint} kind="outpoint" />
              <br />
              <small>
                {p.state.bsvReserve.toString()} sats · {formatAmount(p.state.tokenReserve, m?.dec ?? 0)} {m?.sym ?? "base units"} · price{" "}
                {marginalPrice(p.state, m?.dec)} · fees {p.state.liquidityFeeBps.toString()}/{p.state.validationFeeBps.toString()} bps · commission {p.pool.args.commissionBps.toString()} bps · validator{" "}
                <span className={`dot ${v?.live ? "dot-live" : "dot-off"}`} /> <code title={p.state.validatorIdentityKey}>{shortKey(p.state.validatorIdentityKey)}</code> · LP key{" "}
                <code>{p.lpKey.keyID}</code> ({p.via})
              </small>
            </p>
            {open?.outpoint === p.state.outpoint && open.form === "remove" && <RemoveForm p={p} meta={m} onDone={() => void load()} />}
            {open?.outpoint === p.state.outpoint && open.form === "add" && <AddForm p={p} meta={m} tokenRows={props.assets.tokenRows} peerId={v?.live ? v.peerId : undefined} onDone={() => void load()} />}
            {open?.outpoint !== p.state.outpoint && (
              <>
                <button type="button" onClick={() => setOpen({ outpoint: p.state.outpoint, form: "add" })}>Add liquidity</button>{" "}
                <button type="button" onClick={() => setOpen({ outpoint: p.state.outpoint, form: "remove" })}>Remove liquidity</button>
              </>
            )}
          </div>
        );
      })}
      {warnings.map((w) => <p key={w} className="warn"><small>{w}</small></p>)}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

export function PoolsSection() {
  const { wallet, status } = useWallet();
  const [assets, setAssets] = useState<WalletAssets | null>(null);
  const [live, setLive] = useState<LiveAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      // The validators live on any token the instance serves (each token's liveness read, merged).
      const reads = await fetchLiveByToken(AMM_OVERLAY, await listTokenTopics(AMM_OVERLAY));
      setLive(mergeLive([...reads.values()].filter((r): r is LiveAnswer => !(r instanceof Error))));
      const failed = [...reads.entries()].filter(([, r]) => r instanceof Error);
      if (failed.length) setError(`${AMM_OVERLAY}/.live: ${failed.map(([k, r]) => `${shortTokenId(k)}: ${(r as Error).message}`).join("; ")}`);
    } catch (e) {
      setError(`${AMM_OVERLAY}/.live: ${errText(e)}`);
    }
    if (wallet && status === "connected") {
      try {
        setAssets(await loadWalletAssets(wallet));
      } catch (e) {
        setError(errText(e));
      }
    } else setAssets(null);
  }, [wallet, status]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <>
      <section>
        <div className="section-head">
          <h2>Pools</h2>
          <button type="button" onClick={() => void refresh()}>Refresh</button>
        </div>
        <p><small>Overlay: <code>{AMM_OVERLAY}</code></small></p>
        {!wallet && <p>Connect your wallet to create a pool or see yours.</p>}
        {error && <p className="bad" role="alert">{error}</p>}
      </section>
      {assets && (
        <CreatePool
          assets={assets}
          live={live}
          onSigned={() => {
            void refresh();
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
      {assets && <MyPools assets={assets} live={live} refreshKey={refreshKey} />}
    </>
  );
}

/** Your tokens: the wallet's own Mandala tokens with balance, each on this exchange or with "Add to this exchange". */
import { useState } from "react";
import { MANDALA_DEPLOY_HREF, requestListing, useMyTokens, type Session, type WalletToken } from "../data/exchange";
import { fmtAmount } from "./format";
import { NeedWallet, Notice, TokenName } from "./bits";

function Status({ t }: { t: WalletToken }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (t.onExchange) return <span className="ok small">On this exchange</span>;
  if (t.requested) return <span className="muted small">Requested</span>;
  return (
    <span className="status-cell">
      <button
        type="button"
        className="btn btn-outline"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          requestListing(t.tokenId).catch((e: unknown) => {
            setError(e instanceof Error ? e.message : String(e));
            setBusy(false);
          });
        }}
        aria-label={`Add ${t.sym} to this exchange`}
      >
        {busy ? "Asking…" : "Add to this exchange"}
      </button>
      {error && <span className="bad small">{error}</span>}
    </span>
  );
}

export function YourTokens({ session }: { session: Session }) {
  const connected = session.status === "connected";
  const mine = useMyTokens(connected);
  return (
    <>
      <div className="title-row">
        <h1 className="page-title">Your tokens</h1>
        <a href={MANDALA_DEPLOY_HREF} className="link-strong">
          Deploy a new token
        </a>
      </div>
      <p className="lead lead-tight">Mandala tokens in your wallet. Add one to ask this exchange to list it.</p>
      {!connected ? (
        <NeedWallet session={session} what="your tokens" />
      ) : (
        <>
          {mine.error && <Notice kind="bad">Could not read your tokens: {mine.error}</Notice>}
          <section className="panel ttable" aria-label="Your tokens">
            <div className="ttable-head" aria-hidden="true">
              <span>Token</span>
              <span className="r">Balance</span>
              <span />
            </div>
            {mine.data === null ? (
              <p className="empty">Loading your tokens…</p>
            ) : mine.data.length === 0 ? (
              <p className="empty">Your wallet holds no Mandala tokens.</p>
            ) : (
              <ul className="ttable-rows">
                {mine.data.map((t) => (
                  <li key={t.tokenId} className="ttable-row">
                    <TokenName tokenId={t.tokenId} sym={t.sym} {...(t.icon ? { icon: t.icon } : {})} />
                    <span className="num r">
                      <span className="lbl">Balance </span>
                      {fmtAmount(t.balance, t.dec)}
                    </span>
                    <span className="r">
                      <Status t={t} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <p className="footnote">Listing is free for now. Root registers a requested token in Settings.</p>
        </>
      )}
    </>
  );
}

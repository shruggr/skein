/** The landing: the tokens this overlay hosts, open to everyone, with live prices and a symbol search. */
import { useState } from "react";
import type { HostedToken, Session } from "../data/exchange";
import { compactAmount, compactSats, fmtChange, fmtPrice, roughSats } from "./format";
import { TokenName } from "./bits";
import { routeHref } from "./route";

function ChangeLine({ change }: { change?: number }) {
  if (change === undefined) return null;
  const dir = change > 0.0005 ? "up" : change < -0.0005 ? "down" : "flat";
  return <span className={`change change-${dir}`}>{fmtChange(change)} 24h</span>;
}

function Row({ t }: { t: HostedToken }) {
  return (
    <li className="ltable-row">
      <span className="c-token">
        <TokenName tokenId={t.tokenId} sym={t.sym} {...(t.icon ? { icon: t.icon } : {})} />
      </span>
      <span className="c-price">
        <span className="lbl">Price</span>
        {t.marginalPrice === null ? (
          <span className="muted">No pools yet</span>
        ) : (
          <>
            <span className="num big">
              {fmtPrice(t.marginalPrice)} <span className="unit">sats</span>
            </span>
            <ChangeLine {...(t.change24h !== undefined ? { change: t.change24h } : {})} />
          </>
        )}
      </span>
      <span className="c-liq">
        <span className="lbl">Liquidity</span>
        <span className="num">
          {compactSats(t.reserves.sats)} sats · {compactAmount(t.reserves.tokens, t.dec)} {t.sym}
        </span>
        {t.depth && (
          <span className="sub">
            depth: ±{t.depth.bps / 100}% moves ~{roughSats(t.depth.sats)} sats
          </span>
        )}
      </span>
      <span className="c-pools">
        <span className="lbl">Pools</span>
        <span className="num">{t.pools}</span>
      </span>
      <span className="c-act">
        {t.pools > 0 ? (
          <a className="btn btn-outline" href={routeHref({ page: "swap", tokenId: t.tokenId })} aria-label={`Swap ${t.sym}`}>
            Swap
          </a>
        ) : null}
      </span>
    </li>
  );
}

export function Landing({ session, tokens, error }: { session: Session; tokens: HostedToken[] | null; error: string | null }) {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const shown = tokens?.filter((t) => t.sym.toLowerCase().includes(query)) ?? null;
  const connected = session.status === "connected";

  return (
    <>
      <section className="hero">
        <h1>Tokens traded here</h1>
        <p className="lead">
          Mandala tokens with open pools on this exchange. Prices come from the pools themselves and update as trades land.
          {connected ? " Pick a token to swap it." : " Connect a wallet to swap, provide liquidity or add your own token."}
        </p>
      </section>
      <div className="search">
        <label htmlFor="sym-search" className="sr-only">
          Search by symbol
        </label>
        <input id="sym-search" type="search" placeholder="Search by symbol" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
      </div>
      {error && <p className="notice notice-bad">Could not read the tokens: {error}</p>}
      <section className="panel ltable" aria-label="Tokens on this exchange">
        <div className="ltable-head" aria-hidden="true">
          <span>Token</span>
          <span className="r">Price</span>
          <span className="r">Liquidity</span>
          <span className="r">Pools</span>
          <span />
        </div>
        {shown === null ? (
          <p className="empty">Loading the tokens…</p>
        ) : shown.length === 0 ? (
          <p className="empty">{tokens && tokens.length > 0 ? `No token matches “${q.trim()}”.` : "This exchange hosts no tokens yet."}</p>
        ) : (
          <ul className="ltable-rows">
            {shown.map((t) => (
              <Row key={t.tokenId} t={t} />
            ))}
          </ul>
        )}
      </section>
      <p className="footnote">Price is the marginal price across a token&apos;s pools: what the next small swap pays.</p>
    </>
  );
}

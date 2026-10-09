/**
 * Open Exchange (shruggr/skein#147): the shell (header with the wordmark, nav
 * and wallet; footer) and five hash-routed pages. Landing is open to all;
 * after a wallet connects the nav shows Tokens, Swap, Liquidity and Your
 * tokens, plus Settings for root. All data comes from src/data/exchange.ts.
 *
 * The earlier tab pages (src/pages/*) are no longer in the shell; their files
 * stay for the overlay session.
 */
import { useEffect, useRef } from "react";
import { AppWalletProvider } from "./wallet/AppWalletProvider";
import { Id } from "./components/Id";
import { SITE_HREF, useHostedTokens, useIsRoot, useSession, type Session } from "./data/exchange";
import { routeHref, useRoute, type Page, type Route } from "./ox/route";
import { LiveDot } from "./ox/bits";
import { Landing } from "./ox/Landing";
import { SwapPage } from "./ox/Swap";
import { Liquidity } from "./ox/Liquidity";
import { YourTokens } from "./ox/YourTokens";
import { Settings } from "./ox/Settings";

const NAV: { page: Page; label: string; rootOnly?: boolean }[] = [
  { page: "landing", label: "Tokens" },
  { page: "swap", label: "Swap" },
  { page: "liquidity", label: "Liquidity" },
  { page: "tokens", label: "Your tokens" },
  { page: "settings", label: "Settings", rootOnly: true },
];

function Wallet({ session }: { session: Session }) {
  const ref = useRef<HTMLDetailsElement>(null);
  if (session.status !== "connected" || !session.identityKey) {
    return (
      <button type="button" className="btn btn-primary wallet-btn" onClick={session.connect} disabled={session.status === "connecting"}>
        {session.status === "connecting" ? "Connecting…" : "Connect a wallet"}
      </button>
    );
  }
  const key = session.identityKey;
  return (
    <details className="wallet-menu" ref={ref}>
      <summary className="wallet-pill" aria-label="Connected wallet">
        <span className="wallet-avatar" aria-hidden="true" />
        <span className="wallet-key">
          {key.slice(0, 6)}…{key.slice(-4)}
        </span>
      </summary>
      <div className="wallet-pop">
        <span className="small muted">Connected wallet</span>
        <Id value={key} kind="key" label="identity key" />
        <button
          type="button"
          className="btn btn-outline"
          onClick={() => {
            ref.current?.removeAttribute("open");
            session.disconnect();
          }}
        >
          Disconnect
        </button>
      </div>
    </details>
  );
}

function PageView({ route, session, root, hosted }: { route: Route; session: Session; root: boolean; hosted: ReturnType<typeof useHostedTokens> }) {
  switch (route.page) {
    case "swap":
      return <SwapPage session={session} {...(route.tokenId ? { tokenId: route.tokenId } : {})} tokens={hosted.tokens} />;
    case "liquidity":
      return <Liquidity session={session} hosted={hosted.tokens} />;
    case "tokens":
      return <YourTokens session={session} />;
    case "settings":
      return <Settings session={session} root={root} />;
    default:
      return <Landing session={session} tokens={hosted.tokens} error={hosted.error} />;
  }
}

function Shell() {
  const session = useSession();
  const root = useIsRoot(session);
  const route = useRoute();
  const hosted = useHostedTokens();
  const connected = session.status === "connected";
  const mainRef = useRef<HTMLElement>(null);
  const first = useRef(true);

  // On a route change: to the top, focus on the page.
  const at = routeHref(route);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    window.scrollTo(0, 0);
    mainRef.current?.focus({ preventScroll: true });
  }, [at]);

  const wide = route.page === "landing" || route.page === "swap" || route.page === "liquidity";

  return (
    <>
      <header className="top">
        <div className="wrap top-in">
          <a className="brand" href={routeHref({ page: "landing" })}>
            Open Exchange
          </a>
          {connected && (
            <nav className="nav" aria-label="Main">
              {NAV.filter((n) => !n.rootOnly || root).map((n) => (
                <a key={n.page} href={routeHref({ page: n.page } as Route)} aria-current={route.page === n.page ? "page" : undefined}>
                  {n.label}
                </a>
              ))}
            </nav>
          )}
          <div className="wallet">
            <Wallet session={session} />
          </div>
        </div>
      </header>
      <main ref={mainRef} tabIndex={-1} className={`wrap main ${wide ? "" : "main-narrow"}`}>
        <PageView route={route} session={session} root={root} hosted={hosted} />
      </main>
      <footer className="foot">
        <div className="wrap foot-in">
          <span>
            Runs on a skein · <a href={SITE_HREF}>manage it at /site/</a>
          </span>
          <span className="foot-live">
            <LiveDot live={hosted.live} label={hosted.live ? "prices live" : "prices paused"} />
          </span>
        </div>
      </footer>
    </>
  );
}

export function App() {
  return (
    <AppWalletProvider>
      <Shell />
    </AppWalletProvider>
  );
}

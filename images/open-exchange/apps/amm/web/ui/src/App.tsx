import { useState } from "react";
import { AppWalletProvider, ConnectButton, useWallet } from "./wallet/AppWalletProvider";
import { AMM_OVERLAY } from "./lib/config";
import { shortKey } from "./market/view";
import { TokensSection } from "./pages/Tokens";
import { PoolsSection } from "./pages/Pools";
import { SwapPage } from "./pages/Swap";
import { ValidatorPage } from "./pages/Validator";
import { PendingPayouts } from "./pages/PendingPayouts";

type Tab = "tokens" | "pools" | "swap" | "validator";

const TABS: { id: Tab; label: string }[] = [
  { id: "tokens", label: "Tokens" },
  { id: "pools", label: "Pools" },
  { id: "swap", label: "Swap" },
  { id: "validator", label: "Validator" },
];

function overlayOrigin(): string {
  try {
    return new URL(AMM_OVERLAY).host;
  } catch {
    return AMM_OVERLAY;
  }
}

function WalletLine() {
  const { identityKey, status } = useWallet();
  return (
    <small className="who">
      {status === "connected" && identityKey ? (
        <>wallet <code title={identityKey}>{shortKey(identityKey)}</code></>
      ) : (
        <>no wallet</>
      )}
      {" · "}overlay <code title={AMM_OVERLAY}>{overlayOrigin()}</code>
    </small>
  );
}

export function App() {
  const [tab, setTab] = useState<Tab>("swap");

  return (
    <AppWalletProvider>
      <header>
        <div>
          <h1>AMM PoC market</h1>
          <WalletLine />
        </div>
        <ConnectButton />
        <nav>
          {TABS.map((t) => (
            <button key={t.id} type="button" onClick={() => setTab(t.id)} aria-current={tab === t.id ? "page" : undefined}>
              {t.label}
            </button>
          ))}
          {/* The Mandala pages this app carries (www/mandala/, skein-mandala v0.6.0). */}
          <a href="mandala/deploy/">Deploy a token</a>
          <a href="mandala/tokens/">Token topics</a>
        </nav>
      </header>
      <main>
        <PendingPayouts />
        {tab === "tokens" && <TokensSection />}
        {tab === "pools" && <PoolsSection />}
        {tab === "swap" && <SwapPage />}
        {tab === "validator" && <ValidatorPage />}
      </main>
    </AppWalletProvider>
  );
}

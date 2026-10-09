/**
 * BRC-100 wallet wiring, from 1sat-sdk (@1sat/react / @1sat/connect) —
 * "Wallet wiring comes from 1sat-sdk ... do not write your own wallet
 * connect." `WalletProvider` + `ConnectDialogProvider` give every page
 * `useWallet()` (status, identityKey, the raw `WalletInterface`) and
 * `useConnectDialog()` / `<ConnectButton/>` for the connect UI.
 *
 * Grouped permissions (public/manifest.json, README "Permissions"): every
 * @1sat/connect connector calls `waitForAuthentication({})` before anything
 * else — `connectAutoDetect` (WalletClient "auto"), `buildConnector` (URL
 * providers), `connectSigmaWallet`, and the reconnect path through
 * `connectWallet` → `buildConnector` — then `getPublicKey({identityKey:
 * true})`. A wallet built on wallet-toolbox's WalletPermissionsManager runs
 * its grouped flow inside `waitForAuthentication` (fetch the manifest, drop
 * what is already granted, one prompt), so it comes first on every connect
 * and the page adds no call of its own.
 */
import type { ReactNode } from "react";
import { ConnectDialogProvider, WalletProvider } from "@1sat/react";

export function AppWalletProvider({ children }: { children: ReactNode }) {
  return (
    <WalletProvider autoDetect autoReconnect>
      <ConnectDialogProvider>{children}</ConnectDialogProvider>
    </WalletProvider>
  );
}

export { useWallet } from "@1sat/react";
export { ConnectButton } from "@1sat/react";
export { useConnectDialog } from "@1sat/react";

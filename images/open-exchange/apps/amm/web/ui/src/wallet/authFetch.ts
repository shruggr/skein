/**
 * The wallet-backed BRC-103/104 client: `@bsv/sdk`'s `AuthFetch` over the
 * connected BRC-100 wallet (from @1sat/react's `useWallet()`). Every
 * signature of the handshake and of each request is the wallet's; there is
 * no page key. One `AuthFetch` per wallet, so its sessions are reused.
 */
import { useMemo } from "react";
import { AuthFetch } from "@bsv/sdk";
import { useWallet } from "./AppWalletProvider";

export function useAuthFetch(): AuthFetch | null {
  const { wallet, status } = useWallet();
  return useMemo(() => (wallet && status === "connected" ? new AuthFetch(wallet) : null), [wallet, status]);
}

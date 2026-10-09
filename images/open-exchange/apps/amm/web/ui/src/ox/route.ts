/**
 * Hash routes, so every page has a deep link and the pages work under any
 * /<app>/ base (the build's base is "./"):
 *
 *   #/                 the landing (Tokens)
 *   #/swap             pick a token to swap
 *   #/swap/<tokenId>   swap one token
 *   #/liquidity        your positions, deploy a position
 *   #/tokens           your tokens
 *   #/settings         root's settings
 */
import { useEffect, useState } from "react";

export type Route =
  | { page: "landing" }
  | { page: "swap"; tokenId?: string }
  | { page: "liquidity" }
  | { page: "tokens" }
  | { page: "settings" };

export type Page = Route["page"];

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter((x) => x !== "").map(decodeURIComponent);
  switch (parts[0]) {
    case "swap":
      return parts[1] ? { page: "swap", tokenId: parts[1] } : { page: "swap" };
    case "liquidity":
      return { page: "liquidity" };
    case "tokens":
      return { page: "tokens" };
    case "settings":
      return { page: "settings" };
    default:
      return { page: "landing" };
  }
}

export function routeHref(r: Route): string {
  switch (r.page) {
    case "landing":
      return "#/";
    case "swap":
      return r.tokenId ? `#/swap/${encodeURIComponent(r.tokenId)}` : "#/swap";
    default:
      return `#/${r.page}`;
  }
}

function currentHash(): string {
  try {
    return location.hash;
  } catch {
    return "";
  }
}

export function useRoute(): Route {
  const [hash, setHash] = useState(currentHash);
  useEffect(() => {
    const on = () => setHash(currentHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return parseRoute(hash);
}

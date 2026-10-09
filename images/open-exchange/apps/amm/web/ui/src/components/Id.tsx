/**
 * A txid, token id, outpoint or topic on a page: shortened, whole on a click, with a
 * copy button that copies the whole value. David, 2026-10-08: "anytime we
 * show a token ID or a transaction ID anywhere in the site ever, it has to be
 * expandable so we can copy the whole thing or needs to have an explicit copy
 * button." As skein-mandala 0.7.4's `<Id>` (its pages in www/mandala/): each
 * txid shortened to its first and last 8; "copied" for 1.5 s, on a refused
 * clipboard "not copied" and the id shown whole; no alert. Outpoints show and
 * copy as `<txid>.<vout>`, token ids as `<txid>_<vout>` (src/lib/tokenId.ts).
 * Open Exchange: the shortened value is a button (toggles whole), the copy
 * button an icon with an accessible name; "copied" is announced (role=status).
 */
import { useState } from "react";
import { outpointText, parseTokenId, sdkTokenId, shortOutpoint, shortTokenId } from "../lib/tokenId";

/**
 * A topic is a name carrying a token's id (`tm_mandala_<txid>_<vout>`, `tm_mandala_<txid>_0` included).
 * A key is an identity or validator key (66 hex), shortened to its first and last 8.
 */
export type IdKind = "txid" | "token" | "outpoint" | "topic" | "key";

const KIND_LABEL: Record<IdKind, string> = { txid: "id", token: "token id", outpoint: "outpoint", topic: "topic", key: "key" };

/** The whole value as shown and copied. */
export function fullId(value: string, kind: IdKind): string {
  if (kind === "outpoint") return outpointText(value);
  if (kind === "token") return parseTokenId(value) ? sdkTokenId(value) : value; // any form → `<txid>_<vout>`
  return value;
}

/** The shortened value. */
export function shortId(value: string, kind: IdKind): string {
  if (kind === "outpoint") return shortOutpoint(value);
  if (kind === "topic") return value.replace(/[0-9a-fA-F]{64}/g, (h) => shortTokenId(h));
  if (kind === "token") return shortTokenId(fullId(value, kind));
  if (kind === "key") return value.length > 20 ? `${value.slice(0, 8)}…${value.slice(-8)}` : value;
  return shortTokenId(value); // a txid: its first and last 8
}

export function Id({ value, kind, label }: { value: string; kind: IdKind; label?: string }) {
  const [whole, setWhole] = useState(false);
  const [copied, setCopied] = useState<"" | "copied" | "not copied">("");
  const full = fullId(value, kind);
  const short = shortId(value, kind);
  const expandable = short !== full;
  const what = label ?? KIND_LABEL[kind];

  async function copy() {
    try {
      await navigator.clipboard.writeText(full);
      setCopied("copied");
    } catch {
      setCopied("not copied");
      setWhole(true);
    }
    setTimeout(() => setCopied(""), 1500);
  }

  return (
    <span className="id" data-whole={whole || !expandable ? "true" : undefined}>
      {expandable ? (
        <button
          type="button"
          className="id-text"
          aria-expanded={whole}
          aria-label={whole ? `${what} ${full}, shorten` : `${what} ${short}, show it whole`}
          title={whole ? "Shorten" : "Show it whole"}
          onClick={() => setWhole(!whole)}
        >
          <code>{whole ? full : short}</code>
        </button>
      ) : (
        <code className="id-text">{full}</code>
      )}
      <button type="button" className="id-copy" onClick={() => void copy()} aria-label={`Copy ${what}`} title={`Copy ${full}`}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M5 15V5a2 2 0 0 1 2-2h10" />
        </svg>
      </button>
      <span className="id-status" role="status">
        {copied}
      </span>
    </span>
  );
}

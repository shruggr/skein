/**
 * A txid, token id, outpoint or topic on a page: shortened, whole on a click, with a
 * copy button that copies the whole value. David, 2026-10-08: "anytime we
 * show a token ID or a transaction ID anywhere in the site ever, it has to be
 * expandable so we can copy the whole thing or needs to have an explicit copy
 * button." As skein-mandala 0.7.4's `<Id>` (its pages in www/mandala/): each
 * txid shortened to its first and last 8; "copied" for 1.5 s, on a refused
 * clipboard "not copied" and the id shown whole; no alert. Outpoints show and
 * copy as `<txid>.<vout>`, token ids as `<txid>_<vout>` (src/lib/tokenId.ts).
 */
import { useState } from "react";
import { outpointText, parseTokenId, sdkTokenId, shortOutpoint, shortTokenId } from "../lib/tokenId";

/** A topic is a name carrying a token's id (`tm_mandala_<txid>_<vout>`, `tm_mandala_<txid>_0` included). */
export type IdKind = "txid" | "token" | "outpoint" | "topic";

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
  return shortTokenId(value); // a txid: its first and last 8
}

export function Id({ value, kind }: { value: string; kind: IdKind }) {
  const [whole, setWhole] = useState(false);
  const [copied, setCopied] = useState<"" | "copied" | "not copied">("");
  const full = fullId(value, kind);
  const short = shortId(value, kind);
  const expandable = short !== full;

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
    <span className="id">
      <code
        title={expandable ? (whole ? "Click to shorten" : "Click to show it whole") : full}
        className={expandable ? "toggle" : undefined}
        onClick={expandable ? () => setWhole(!whole) : undefined}
      >
        {whole || !expandable ? full : short}
      </code>
      <button type="button" className="id-copy" onClick={() => void copy()} title={`Copy ${full}`}>
        {copied || "copy"}
      </button>
    </span>
  );
}

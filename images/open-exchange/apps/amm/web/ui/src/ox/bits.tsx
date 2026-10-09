/** Small shared pieces of the Open Exchange pages. */
import type { ReactNode } from "react";
import { Id } from "../components/Id";
import { type Session, type TokenId } from "../data/exchange";

const MARKS = ["#7A6A2E", "#5A66B0", "#3E6B5A", "#3F4F99", "#6B4E7A", "#4F6B7A"];

function markColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return MARKS[h % MARKS.length]!;
}

/** A token's icon, or its initial on a colour from its id. */
export function TokenMark({ tokenId, sym, icon, size = "md" }: { tokenId: TokenId; sym: string; icon?: string; size?: "sm" | "md" }) {
  return (
    <span className={`mark mark-${size}`} style={icon ? undefined : { background: markColor(tokenId) }} aria-hidden="true">
      {icon ? <img src={icon} alt="" /> : sym.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** Symbol over the token's id (expandable, with copy). */
export function TokenName({ tokenId, sym, icon, size }: { tokenId: TokenId; sym: string; icon?: string; size?: "sm" | "md" }) {
  return (
    <span className="token-name">
      <TokenMark tokenId={tokenId} sym={sym} {...(icon ? { icon } : {})} {...(size ? { size } : {})} />
      <span className="token-name-text">
        <span className="sym">{sym}</span>
        <Id value={tokenId} kind="token" label={`${sym} token id`} />
      </span>
    </span>
  );
}

/** A page that needs a wallet, shown while none is connected. */
export function NeedWallet({ session, what }: { session: Session; what: string }) {
  return (
    <section className="panel gate">
      <p>Connect a wallet to see {what}.</p>
      <button type="button" className="btn btn-primary" onClick={session.connect} disabled={session.status === "connecting"}>
        {session.status === "connecting" ? "Connecting…" : "Connect a wallet"}
      </button>
    </section>
  );
}

export function Notice({ kind, children }: { kind: "ok" | "bad" | "info"; children: ReactNode }) {
  return (
    <p className={`notice notice-${kind}`} role={kind === "bad" ? "alert" : "status"}>
      {children}
    </p>
  );
}

export function LiveDot({ live, label }: { live: boolean; label?: string }) {
  return (
    <span className="live">
      <span className={`dot ${live ? "dot-on" : "dot-off"}`} aria-hidden="true" />
      {label ?? (live ? "live" : "offline")}
    </span>
  );
}

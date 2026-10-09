/** Display formats for the Open Exchange pages: grouped amounts, compact sats, prices, percentages. */
import { formatAmount, parseAmount } from "../lp/amounts";

const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** Base units with `dec` places, the whole part grouped: `120450n, 2` → `1,204.5`. */
export function fmtAmount(base: bigint, dec = 0): string {
  const s = formatAmount(base, dec);
  const neg = s.startsWith("-");
  const [whole, frac] = (neg ? s.slice(1) : s).split(".");
  return (neg ? "−" : "") + group(whole!) + (frac ? `.${frac}` : "");
}

/** Sats grouped: `1820400n` → `1,820,400`. */
export function fmtSats(sats: bigint): string {
  return fmtAmount(sats, 0);
}

/** Sats compact for summaries: `1.24M`, `480k`, `80,000`. */
export function compactSats(sats: bigint): string {
  const n = Number(sats);
  if (n >= 1_000_000) return `${trim((n / 1_000_000).toPrecision(3))}M`;
  if (n >= 100_000) return `${Math.round(n / 1000)}k`;
  return fmtSats(sats);
}

/** Sats rounded for an estimate: `~19k`, `~149k`, `~796`. */
export function roughSats(sats: bigint): string {
  const n = Number(sats);
  if (n >= 1_000_000) return `${trim((n / 1_000_000).toPrecision(2))}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  return fmtSats(sats);
}

/** A whole-token amount compact: base units → `3,010` (no fraction above 1,000). */
export function compactAmount(base: bigint, dec: number): string {
  if (dec === 0) return fmtAmount(base, 0);
  const whole = base / 10n ** BigInt(dec);
  return whole >= 1000n ? fmtAmount(whole, 0) : fmtAmount(base, dec);
}

const trim = (s: string) => (s.includes(".") ? s.replace(/\.?0+$/, "") : s);

/** Sats per whole token: `1,250`, `412.0`, `37.0`, `4.25`, `0.0312`. */
export function fmtPrice(p: number): string {
  if (!Number.isFinite(p)) return "—";
  if (p >= 1000) return group(Math.round(p).toString());
  if (p >= 10) return p.toFixed(1);
  if (p >= 1) return p.toFixed(2);
  return p.toPrecision(3);
}

/** Basis points as a percentage: `80` → `0.80 %`. */
export function fmtBps(bps: number): string {
  return `${(bps / 100).toFixed(2)} %`;
}

/** A fraction as a signed change: `0.018` → `+1.8%`, `-0.004` → `−0.4%`, `0` → `0.0%`. */
export function fmtChange(f: number): string {
  const pct = (f * 100).toFixed(1);
  if (pct === "0.0" || pct === "-0.0") return "0.0%";
  return f > 0 ? `+${pct}%` : `−${pct.slice(1)}%`;
}

/** A typed amount (commas and spaces allowed) → base units; null when it is not an amount. */
export function parseInput(text: string, dec: number): bigint | null {
  const t = text.replace(/[,\s]/g, "");
  if (t === "") return null;
  try {
    return parseAmount(t, dec);
  } catch {
    return null;
  }
}

/** How long ago: `40 min`, `5 h`, `2 days`. */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}

/**
 * Token amounts are integers in base units; `dec` places shift them for display
 * (BRC-162 `dec`, 0-18). Pure string arithmetic on bigints, no floats.
 */

export const MAX_DECIMALS = 18;

function checkDec(dec: number): void {
  if (!Number.isInteger(dec) || dec < 0 || dec > MAX_DECIMALS) {
    throw new Error(`decimals must be an integer 0-${MAX_DECIMALS}`);
  }
}

/** `amount` base units as a decimal string with `dec` places, trailing zeros trimmed. */
export function formatAmount(amount: bigint, dec = 0): string {
  checkDec(dec);
  const neg = amount < 0n;
  const digits = (neg ? -amount : amount).toString();
  if (dec === 0) return (neg ? "-" : "") + digits;
  const padded = digits.padStart(dec + 1, "0");
  const whole = padded.slice(0, padded.length - dec);
  const frac = padded.slice(padded.length - dec).replace(/0+$/, "");
  return (neg ? "-" : "") + whole + (frac ? `.${frac}` : "");
}

/**
 * A decimal string entered in display units → base units. Throws on anything
 * that is not a non-negative number with at most `dec` fractional digits.
 */
export function parseAmount(text: string, dec = 0): bigint {
  checkDec(dec);
  const s = text.trim().replace(/_/g, "");
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) throw new Error(`not an amount: "${text}"`);
  const whole = m[1] || "0";
  const frac = m[2] ?? "";
  if (frac.length > dec) throw new Error(`at most ${dec} decimal place(s)`);
  return BigInt(whole + frac.padEnd(dec, "0"));
}

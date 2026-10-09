/**
 * BRC-162 (Mandala) prefix for the pool template, over 1sat-sdk's `Mandala`
 * (`@1sat/templates/mandala`, aliased to the local 1sat-sdk checkout; see
 * README.md, "Mandala from the local 1sat-sdk checkout"). One decoder: this
 * file only adapts `Mandala.decode` / `Mandala.value(...).prefix()` to the
 * byte-array shape `template.ts` works in.
 *
 *   <push id | OP_0> <push amount | OP_0> OP_2DROP [<push payload> OP_DROP] <lock>
 */
import { LockingScript, Script } from "@bsv/sdk";
import Mandala, { MANDALA_MAX_AMOUNT, type MandalaRole } from "@1sat/templates/mandala";

export { MANDALA_MAX_AMOUNT, type MandalaRole };

export interface MandalaPrefix {
  role: MandalaRole;
  /** Wire id bytes (32, or 36 for a legacy BRC-161 id), absent on a deploy. */
  idBytes?: Uint8Array;
  amount: bigint;
  payload?: Uint8Array;
  /** Byte length of the prefix (and payload), i.e. where the inner lock starts. */
  length: number;
}

/** The Mandala prefix at the start of `script`, or null when it has none (`Mandala.decode`). */
export function decodeMandala(script: Uint8Array | number[]): MandalaPrefix | null {
  const bytes = Array.from(script);
  const t = Mandala.decode(Script.fromBinary(bytes));
  if (!t) return null;
  return {
    role: t.role,
    idBytes: t.idBytes,
    amount: t.amount,
    payload: t.payload,
    length: bytes.length - t.lock.toBinary().length,
  };
}

/**
 * The value-output prefix `<push id> <push amount> OP_2DROP` with no payload,
 * as pool/Pool.runar.go's `tokenPrefix` writes it (`Mandala.value(...).prefix()`).
 * The pool's asset id is always the 32-byte form.
 */
export function mandalaValuePrefix(idBytes: Uint8Array | number[], amount: bigint): number[] {
  const id = Uint8Array.from(idBytes);
  if (id.length !== 32) throw new Error(`mandalaValuePrefix: the id must be 32 bytes, got ${id.length}`);
  if (amount <= 0n || amount > MANDALA_MAX_AMOUNT) {
    throw new Error("mandalaValuePrefix: amount must be between 1 and 2^64-1");
  }
  return Mandala.value(id, amount, { lock: new LockingScript() }).prefix().toBinary();
}

/**
 * The connected wallet's positions (skein-amm 0.9.0, David Case 2026-10-09):
 * the pool rows its deploys filed (`bsv21`, op `amm-pool`, the LP key and the
 * claim's vout in their customInstructions), each read from the CHAIN STATE
 * by outpoint — `GET <base>/spends` (amm-p2p reads.zig, the chain app's
 * `spent` as the overlay reads it):
 *
 *   - the pool followed from the deploy's output to its current output
 *     (each swap's continuation), or closed;
 *   - the claim (`<deploy txid>.<claimVout>`) spent: the validator rescinded
 *     the listing — the page asks the LP to Close.
 *
 * The listing (`ls_amm`) answers listed pools only, so the current output's
 * BEEF comes from the token's Mandala lookup (`ls_mandala {txid,
 * outputIndex}`, skein-mandala: an unspent admitted output with its BEEF).
 */
import { Transaction, type WalletProtocol } from "@bsv/sdk";
import { PoolTemplate, type Pool } from "../pool";
import { lookup, parseOutputList, type LookupOutput, type SignedFetch } from "../lib/overlay";
import { readSpend, type Spend } from "../lib/skein";
import { parseOutpoint, tokenIdText } from "../lib/tokenId";
import { isPoolRow, type BasketRow } from "./poolDeploy";

/** The wallet key that is a pool's LpPubKey (a BRC-29 key to self, or a pre-BRC-29 1Sat key). */
export interface LpKeyRef {
  protocolID: WalletProtocol;
  keyID: string;
  counterparty: string;
}

/** A pool row of the wallet: the deploy's pool output as filed. */
export interface PositionRow {
  /** The deploy's pool output, `<txid>.<vout>`. */
  deployOutpoint: string;
  /** `<txid>_<vout>` */
  tokenId: string;
  sym?: string;
  dec?: number;
  lpKey: LpKeyRef;
  /** The claim's output index in the deploy (filed at completion); null for a pool filed before 0.9.0. */
  claimVout: number | null;
  validatorIdentity?: string;
}

/** The wallet's pool rows (`isPoolRow`). */
export function positionRowsOf(rows: BasketRow[]): PositionRow[] {
  const out: PositionRow[] = [];
  for (const r of rows) {
    if (!isPoolRow(r)) continue;
    const op = parseOutpoint(r.outpoint);
    if (!op) continue;
    try {
      const ci = JSON.parse(r.customInstructions ?? "{}") as {
        id?: string;
        sym?: string;
        dec?: string | number;
        protocolID?: WalletProtocol;
        keyID?: string;
        counterparty?: string;
        amm?: { claimVout?: number; validatorIdentity?: string };
      };
      if (!Array.isArray(ci.protocolID) || typeof ci.keyID !== "string" || typeof ci.id !== "string") continue;
      const tid = parseOutpoint(ci.id.replace("_", "."));
      out.push({
        deployOutpoint: `${op.txid}.${op.vout}`,
        tokenId: tid ? tokenIdText(tid) : ci.id,
        ...(ci.sym ? { sym: ci.sym } : {}),
        ...(ci.dec !== undefined ? { dec: Number(ci.dec) } : {}),
        lpKey: { protocolID: ci.protocolID, keyID: ci.keyID, counterparty: typeof ci.counterparty === "string" ? ci.counterparty : "self" },
        claimVout: typeof ci.amm?.claimVout === "number" ? ci.amm.claimVout : null,
        ...(typeof ci.amm?.validatorIdentity === "string" ? { validatorIdentity: ci.amm.validatorIdentity } : {}),
      });
    } catch {
      /* skip */
    }
  }
  return out;
}

/** An unspent Mandala output with its BEEF: `ls_mandala {txid, outputIndex}`. */
export async function mandalaOutput(af: SignedFetch | null, base: string, outpoint: string): Promise<LookupOutput> {
  const op = parseOutpoint(outpoint);
  if (!op) throw new Error(`not an outpoint: ${outpoint}`);
  const outs = parseOutputList(await lookup(af, base, "ls_mandala", { txid: op.txid, outputIndex: op.vout }));
  const o = outs.find((x) => x.outputIndex === op.vout) ?? outs[0];
  if (!o) throw new Error(`ls_mandala: no unspent output ${outpoint}`);
  return o;
}

export interface LoadedPosition {
  row: PositionRow;
  /** The pool's current output (`<txid>.<vout>`); null when closed. */
  current: string | null;
  closed: boolean;
  /** The claim spent: the validator rescinded the listing. */
  rescinded: boolean;
  /** The current output, decoded, with its BEEF (absent when closed or not found). */
  output?: LookupOutput;
  pool?: Pool;
  sats?: bigint;
}

/** One row read from the chain state (and, when live, its current output). */
export async function loadPosition(
  af: SignedFetch | null,
  base: string,
  row: PositionRow,
  spendOf: (outpoint: string) => Promise<Spend> = (o) => readSpend(base, o),
  outputOf: (outpoint: string) => Promise<LookupOutput> = (o) => mandalaOutput(af, base, o),
): Promise<LoadedPosition> {
  const s = await spendOf(row.deployOutpoint);
  const deployTxid = row.deployOutpoint.split(".")[0]!;
  const rescinded = row.claimVout !== null && Boolean((await spendOf(`${deployTxid}.${row.claimVout}`)).spentBy);
  const current = s.closed ? null : (s.current ?? (s.spentBy ? null : row.deployOutpoint));
  const out: LoadedPosition = { row, current, closed: s.closed, rescinded };
  if (!current) return out;
  const output = await outputOf(current);
  const tx = Transaction.fromAtomicBEEF(output.beef);
  const o = tx.outputs[output.outputIndex];
  const pool = o ? PoolTemplate.decode(o.lockingScript) : null;
  if (!pool || !o) return out;
  return { ...out, output, pool, sats: BigInt(o.satoshis ?? 0) };
}

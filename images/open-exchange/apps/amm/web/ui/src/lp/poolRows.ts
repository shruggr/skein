/**
 * How this page files a pool output it holds as LP in the `bsv21` basket:
 * tags `bsv21:<tokenId>` + `amm-pool`, customInstructions `op: "amm-pool"`
 * and no `amt` (src/lp/poolDeploy.ts). Such a row is not a token balance and
 * not a token input: its script starts with a Mandala value prefix, but the
 * lock behind it is the Pool contract, not P2PKH.
 */
export const POOL_TAG = "amm-pool";
export const POOL_OP = "amm-pool";

export function isPoolRow(row: { tags?: string[]; customInstructions?: string }): boolean {
  if (row.tags?.includes(POOL_TAG)) return true;
  try {
    return JSON.parse(row.customInstructions ?? "{}").op === POOL_OP;
  } catch {
    return false;
  }
}

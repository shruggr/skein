/**
 * The wallet reads behind the LP page (BRC-100 `listOutputs`, the connected
 * wallet from @1sat/react's `useWallet()`). Nothing here talks to an overlay.
 *
 * Where token outputs live: 1sat-sdk files a Mandala token's outputs
 * (deploy, receive, send change) in the token's own basket
 * `mandala <txid> <vout>`, and labels their actions `mandala` and
 * `mandala <txid> <vout>` (1sat-sdk actions/src/mandala/deploy.ts). This
 * page's own filings (pool rows, swap/deploy token change) and legacy
 * BRC-161 tokens are in `bsv21`. Every read of a user's token outputs reads
 * both.
 */
import { BSV21_BASKET, BSV21_DEPLOY_TAG, ORDINALS_BASKET } from "@1sat/types";
import { Beef, type ListOutputsArgs, type Transaction, type WalletInterface, type WalletOutput } from "@bsv/sdk";
import { parseTokenId } from "../lib/tokenId";

/** BRC-100's largest `limit`. */
const LIMIT = 10000;

/** 1sat-sdk's action label on every Mandala token action (`MANDALA_LABEL`, @1sat/types after 0.0.49). */
export const MANDALA_LABEL = "mandala";
const MANDALA_NAME = /^mandala ([0-9a-f]{64}) (0|[1-9]\d*)$/;

/** A Mandala token's basket `mandala <txid> <vout>` (1sat-sdk `mandalaTokenBasket`), from any token id form (`<txid>` is vout 0). */
export function mandalaBasket(tokenId: string): string {
  const r = parseTokenId(tokenId);
  if (!r) throw new Error(`not a token id (<txid>, <txid>_<vout> or <txid>.<vout>): ${tokenId}`);
  return `mandala ${r.txid} ${r.vout}`;
}

/** The Mandala token baskets the wallet tracks, from its `mandala`-labelled actions' per-token labels. */
export async function mandalaBaskets(wallet: WalletInterface): Promise<string[]> {
  const r = await wallet.listActions({ labels: [MANDALA_LABEL], includeLabels: true, limit: LIMIT });
  const out = new Set<string>();
  for (const a of r.actions) for (const l of a.labels ?? []) if (MANDALA_NAME.test(l)) out.add(l);
  return [...out];
}

/**
 * The source transactions of a token's outputs, for a spend's BEEF: the
 * token's own basket (`mandala <txid> <vout>`) and `bsv21` (`bsv21Query`,
 * the page's own filings), merged. Null when neither answers a BEEF.
 */
export async function tokenSourceBeef(
  wallet: WalletInterface,
  tokenId: string,
  bsv21Query: Omit<ListOutputsArgs, "basket" | "include" | "limit">,
): Promise<Beef | null> {
  const [own, bsv21] = await Promise.all([
    wallet.listOutputs({ basket: mandalaBasket(tokenId), include: "entire transactions", limit: LIMIT }),
    wallet.listOutputs({ basket: BSV21_BASKET, ...bsv21Query, include: "entire transactions", limit: LIMIT }),
  ]);
  let beef: Beef | null = null;
  for (const r of [own, bsv21]) {
    if (!r.BEEF) continue;
    const b = Beef.fromBinary(Array.from(r.BEEF));
    if (!beef) beef = b;
    else beef.mergeBeef(b);
  }
  return beef;
}

export interface WalletAssets {
  /** The token rows: every `mandala <txid> <vout>` basket and `bsv21`, with locking scripts, tags and customInstructions. */
  tokenRows: WalletOutput[];
  /** Ordinals basket (`1sat`), with locking scripts and tags. */
  ordinalRows: WalletOutput[];
  /** Deploy transactions (and their BEEF ancestors) by txid, for icons by vout. */
  txs: Map<string, Transaction>;
  /** Reads that failed without failing the page (e.g. no BEEF from the wallet). */
  warnings: string[];
}

export async function loadWalletAssets(wallet: WalletInterface): Promise<WalletAssets> {
  const warnings: string[] = [];
  const [tokens, ordinals] = await Promise.all([
    wallet.listOutputs({
      basket: BSV21_BASKET,
      include: "locking scripts",
      includeTags: true,
      includeCustomInstructions: true,
      limit: LIMIT,
    }),
    wallet.listOutputs({
      basket: ORDINALS_BASKET,
      include: "locking scripts",
      includeTags: true,
      includeCustomInstructions: true,
      limit: LIMIT,
    }),
  ]);

  // Icons stored as a vout point into the deploy transaction; the deploy
  // outputs are tagged `bsv21:deploy` (1sat-sdk's deploy filing), so ask for
  // just those with their transactions.
  const txs = new Map<string, Transaction>();
  try {
    const deploys = await wallet.listOutputs({
      basket: BSV21_BASKET,
      tags: [BSV21_DEPLOY_TAG],
      include: "entire transactions",
      limit: LIMIT,
    });
    if (deploys.outputs.length > 0 && deploys.BEEF) {
      const beef = Beef.fromBinary(Array.from(deploys.BEEF));
      for (const btx of beef.txs) if (btx.tx) txs.set(btx.txid, btx.tx);
    }
  } catch (err) {
    warnings.push(`deploy transactions: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Mandala tokens 1sat-sdk filed: their own baskets.
  const tokenRows = [...tokens.outputs];
  try {
    const baskets = await mandalaBaskets(wallet);
    const lists = await Promise.all(
      baskets.map((basket) =>
        wallet.listOutputs({ basket, include: "locking scripts", includeTags: true, includeCustomInstructions: true, limit: LIMIT }),
      ),
    );
    for (const l of lists) tokenRows.push(...l.outputs);
  } catch (err) {
    warnings.push(`Mandala token baskets: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { tokenRows, ordinalRows: ordinals.outputs, txs, warnings };
}

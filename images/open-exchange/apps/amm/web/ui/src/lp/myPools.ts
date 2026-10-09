/**
 * "My pools": the instance's pools whose LP key is one of this wallet's.
 *
 * The lookup's `{}` answer has no keys, so each pool's output is fetched with
 * `{outpoint, beef: true}` and decoded (`PoolTemplate.decode`). A pool is
 * ours when:
 *  - its outpoint is a row in the wallet's `bsv21` basket filed as a pool
 *    (`op: "amm-pool"`), or
 *  - its LpPubKey is a wallet key: either a keyID recorded in such a row's
 *    customInstructions (still listed even after a taker spent the output),
 *    or the LP key for an input-0 outpoint along the pool's history in the
 *    BEEF (the LP key is keyed by input 0 of the transaction that set it:
 *    the deposit's first input at deploy, the spent pool on RemoveLiquidity;
 *    swaps keep it), re-derived with `getPublicKey` — the BRC-29 LP key
 *    (`lpKeyId`) and the pre-BRC-29 one (`P1SAT_PROTOCOL`, `legacyLpKeyId`).
 */
import { P1SAT_PROTOCOL } from "@1sat/actions";
import { Transaction, type WalletInterface, type WalletProtocol } from "@bsv/sdk";
import type { PoolState } from "@amm-poc/matching-engine";
import { PoolTemplate, type Pool } from "../pool";
import { lookupPoolOutput, queryPools, type LookupOutput, type SignedFetch, type TokenTopic } from "../lib/overlay";
import { LP_KEY_PROTOCOL, isPoolRow, legacyLpKeyId, lpKeyId, type BasketRow } from "./poolDeploy";
import { outpointText } from "../lib/tokenId";

export interface LpKeyRef {
  protocolID: WalletProtocol;
  keyID: string;
  counterparty: string;
}

export interface MyPool {
  topic: TokenTopic;
  state: PoolState;
  pool: Pool;
  output: LookupOutput;
  /** The wallet key that is this pool's current LpPubKey. */
  lpKey: LpKeyRef;
  /** How it was matched. */
  via: "basket" | "recorded key" | "history";
}

/** The pool rows of the `bsv21` basket: outpoint (`txid_vout`) → the LP key recorded with it. */
export function poolRowsOf(rows: BasketRow[]): Map<string, LpKeyRef> {
  const out = new Map<string, LpKeyRef>();
  for (const r of rows) {
    if (!isPoolRow(r)) continue;
    try {
      const ci = JSON.parse(r.customInstructions ?? "{}");
      if (!Array.isArray(ci.protocolID) || typeof ci.keyID !== "string") continue;
      out.set(r.outpoint.replace(".", "_"), { protocolID: ci.protocolID, keyID: ci.keyID, counterparty: typeof ci.counterparty === "string" ? ci.counterparty : "self" });
    } catch {
      /* skip */
    }
  }
  return out;
}

/** The input-0 outpoints (`txid_vout`) of a pool output's transaction and of each input-0 ancestor the BEEF holds, newest first. */
export function historyOutpoints(tx: Transaction, maxHops = 16): string[] {
  const ids: string[] = [];
  let t: Transaction | undefined = tx;
  for (let hop = 0; t && hop < maxHops; hop++) {
    const in0: Transaction["inputs"][number] | undefined = t.inputs[0];
    if (!in0) break;
    const txid = in0.sourceTXID ?? in0.sourceTransaction?.id("hex");
    if (!txid) break;
    ids.push(`${txid}_${in0.sourceOutputIndex}`);
    t = in0.sourceTransaction;
  }
  return ids;
}

/** The candidate LP keys along that history: the BRC-29 one and the pre-BRC-29 one per outpoint. */
export function historyKeys(tx: Transaction, maxHops = 16): LpKeyRef[] {
  return historyOutpoints(tx, maxHops).flatMap((op) => [
    { protocolID: LP_KEY_PROTOCOL, keyID: lpKeyId(op), counterparty: "self" },
    { protocolID: P1SAT_PROTOCOL as WalletProtocol, keyID: legacyLpKeyId(op), counterparty: "self" },
  ]);
}

/** Pure matching: which wallet key (if any) is `pool`'s LpPubKey. `keys` maps public key hex → its ref. */
export function matchPool(
  outpoint: string,
  pool: Pool,
  basket: Map<string, LpKeyRef>,
  keys: Map<string, LpKeyRef & { source: "recorded key" | "history" }>,
): { lpKey: LpKeyRef; via: MyPool["via"] } | null {
  const row = basket.get(outpoint);
  const k = keys.get(pool.state.lpPubKey);
  if (row && (!k || k.keyID === row.keyID)) return { lpKey: row, via: "basket" };
  if (k) return { lpKey: { protocolID: k.protocolID, keyID: k.keyID, counterparty: k.counterparty }, via: k.source };
  return null;
}

/** Every pool on the instance for `topics` whose LP key is the wallet's. */
export async function findMyPools(
  af: SignedFetch | null,
  base: string,
  wallet: WalletInterface,
  topics: TokenTopic[],
  bsv21Rows: BasketRow[],
): Promise<{ pools: MyPool[]; warnings: string[] }> {
  const warnings: string[] = [];
  const basket = poolRowsOf(bsv21Rows);
  const keys = new Map<string, LpKeyRef & { source: "recorded key" | "history" }>();
  const derived = new Set<string>();
  const derive = async (ref: LpKeyRef, source: "recorded key" | "history") => {
    const tag = `${JSON.stringify(ref.protocolID)}|${ref.keyID}|${ref.counterparty}`;
    if (derived.has(tag)) return;
    derived.add(tag);
    const { publicKey } = await wallet.getPublicKey({ protocolID: ref.protocolID, keyID: ref.keyID, counterparty: ref.counterparty, forSelf: true });
    if (!keys.has(publicKey)) keys.set(publicKey, { ...ref, source });
  };
  for (const ref of basket.values()) await derive(ref, "recorded key");

  const pools: MyPool[] = [];
  for (const topic of topics.filter((t) => t.kind === "native")) {
    let states: PoolState[];
    try {
      states = await queryPools(af, base, topic.tokenId, {});
    } catch (err) {
      warnings.push(`${topic.tokenId}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const state of states) {
      try {
        const output = await lookupPoolOutput(af, base, topic.tokenId, state.outpoint);
        const tx = Transaction.fromAtomicBEEF(output.beef);
        const pool = PoolTemplate.decode(tx.outputs[output.outputIndex]!.lockingScript);
        if (!pool) continue;
        let m = matchPool(state.outpoint, pool, basket, keys);
        if (!m) {
          for (const ref of historyKeys(tx)) await derive(ref, "history");
          m = matchPool(state.outpoint, pool, basket, keys);
        }
        if (m) pools.push({ topic, state, pool, output, lpKey: m.lpKey, via: m.via });
      } catch (err) {
        warnings.push(`${outpointText(state.outpoint)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return { pools, warnings };
}

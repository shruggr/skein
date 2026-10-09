/**
 * Pending payouts: every BRC-29 payout output the page has built and the
 * wallet has not yet internalized, kept durably in the browser so the final
 * step (`internalizeAction`) can run later — after a reload, or for a swap
 * once the validator returns the signed transaction. The wallet derives the
 * output's private key from exactly the remittance stored here.
 *
 * Where the remittance lives at each step:
 *   1. built: in the createAction call (the output's customInstructions, so
 *      the wallet's own record of the action carries it) and here, written
 *      the moment the transaction is built (key `txid:vout`);
 *   2. final: unchanged here (a swap's record is re-keyed to the final txid
 *      when it is found);
 *   3. internalized: in the wallet (`internalizeAction` with
 *      `paymentRemittance`); the record here is cleared only after that
 *      call succeeds.
 *
 * Storage: `localStorage["amm-poc.pending-payouts.v1"]`, one JSON object
 * `{[txid:vout]: PendingPayout}`; every access is guarded (private windows,
 * blocked storage), and tests pass their own `KV`.
 */
import { Beef, type WalletInterface } from "@bsv/sdk";
import { lookupPoolOutput, queryPools, type SignedFetch } from "../lib/overlay";
import { internalizePayout, type PaymentRemittance } from "./brc29";

export const PENDING_PAYOUTS_KEY = "amm-poc.pending-payouts.v1";

export interface PendingPayout {
  /** `txid:vout` */
  id: string;
  kind: "swap" | "remove-liquidity";
  txid: string;
  vout: number;
  satoshis: number;
  /** P2PKH to the BRC-29 key, hex: how the final transaction is recognised when its txid is not known yet. */
  lockingScript: string;
  remittance: PaymentRemittance;
  /**
   * false while the txid is provisional: a swap is built with the
   * validator's signature slot empty and the wallet's inputs unsigned, so its
   * txid changes once they are in.
   */
  final: boolean;
  /** The pool's token id (`<txid>_<vout>`): the `ls_amm` query that finds the transaction's BEEF names it. */
  tokenId: string;
  /** The pool output the transaction creates (`txid_0`), when it has one (not a closing RemoveLiquidity). */
  poolOutpoint?: string;
  /** The wallet's action reference (abortAction releases a swap that is discarded). */
  reference?: string;
  description: string;
  createdAt: number;
}

/** The subset of Storage the store needs. */
export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultKV(): KV | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export class PendingPayoutStore {
  constructor(private readonly kv: KV | null = defaultKV()) {}

  private read(): Record<string, PendingPayout> {
    try {
      const raw = this.kv?.getItem(PENDING_PAYOUTS_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? (parsed as Record<string, PendingPayout>) : {};
    } catch {
      return {};
    }
  }

  private write(all: Record<string, PendingPayout>): boolean {
    try {
      if (!this.kv) return false;
      this.kv.setItem(PENDING_PAYOUTS_KEY, JSON.stringify(all));
      notify();
      return true;
    } catch {
      return false;
    }
  }

  /** Whether the browser can keep records at all (false: private window / blocked storage). */
  get durable(): boolean {
    return this.kv !== null;
  }

  list(): PendingPayout[] {
    return Object.values(this.read()).sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): PendingPayout | undefined {
    return this.read()[id];
  }

  /** Returns false when the record could not be stored. */
  save(p: PendingPayout): boolean {
    const all = this.read();
    all[p.id] = p;
    return this.write(all);
  }

  remove(id: string): void {
    const all = this.read();
    if (!(id in all)) return;
    delete all[id];
    this.write(all);
  }

  /** Re-key a provisional record to the final txid. */
  finalize(id: string, txid: string): PendingPayout | undefined {
    const all = this.read();
    const p = all[id];
    if (!p) return undefined;
    delete all[id];
    const next: PendingPayout = { ...p, id: payoutId(txid, p.vout), txid, final: true };
    all[next.id] = next;
    this.write(all);
    return next;
  }
}

export function payoutId(txid: string, vout: number): string {
  return `${txid}:${vout}`;
}

// Subscribers (the panel) hear every write in this tab; other tabs get the `storage` event.
const listeners = new Set<() => void>();
function notify() {
  for (const l of listeners) l();
}
export function onPendingPayoutsChange(fn: () => void): () => void {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key === PENDING_PAYOUTS_KEY) fn();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(fn);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

// ---------------------------------------------------------------------------
// Finding the final transaction on the instance
// ---------------------------------------------------------------------------

/** The output pays the record's script and amount. */
function pays(tx: { outputs: { satoshis?: number; lockingScript: { toHex(): string } }[] }, p: PendingPayout): boolean {
  const o = tx.outputs[p.vout];
  return !!o && o.satoshis === p.satoshis && o.lockingScript.toHex() === p.lockingScript;
}

/** In a BEEF: the transaction (by txid when final, else by the payout script) as AtomicBEEF. */
function findIn(beefBytes: number[], p: PendingPayout): { txid: string; beef: number[] } | null {
  const beef = Beef.fromBinary(beefBytes);
  for (const btx of beef.txs) {
    const tx = btx.tx;
    if (!tx) continue;
    if (p.final ? btx.txid === p.txid && pays(tx, p) : pays(tx, p)) return { txid: btx.txid, beef: beef.toBinaryAtomic(btx.txid) };
  }
  return null;
}

/**
 * The final transaction's AtomicBEEF from the instance's lookup:
 *  1. `{outpoint: poolOutpoint, beef: true}` — the pool output the
 *     transaction created (or its newest continuation, whose BEEF carries the
 *     transaction as an ancestor), when the record names one and is final;
 *  2. otherwise every live pool of the token (`{}`), each with `{outpoint,
 *     beef: true}`, searched for a transaction paying the record's script
 *     and amount at `vout` (a swap's final txid is not known in advance; the
 *     BRC-29 key is fresh, so the script identifies it).
 * Null when the instance has no such transaction (not final yet, or no
 * longer in any live pool's BEEF).
 */
export async function findPayoutBeef(af: SignedFetch | null, base: string, p: PendingPayout): Promise<{ txid: string; beef: number[] } | null> {
  if (p.final && p.poolOutpoint) {
    try {
      const out = await lookupPoolOutput(af, base, p.tokenId, p.poolOutpoint);
      const hit = findIn(out.beef, p);
      if (hit) return hit;
    } catch {
      /* fall through to the scan */
    }
  }
  const pools = await queryPools(af, base, p.tokenId, {});
  for (const pool of pools) {
    try {
      const out = await lookupPoolOutput(af, base, p.tokenId, pool.outpoint);
      const hit = findIn(out.beef, p);
      if (hit) return hit;
    } catch {
      /* next pool */
    }
  }
  return null;
}

/**
 * Internalize one recorded payout with `atomicBeef` (the final transaction).
 * Clears the record only after the wallet accepted it. A swap record found
 * under a different (final) txid is re-keyed first.
 */
export async function internalizePending(
  wallet: WalletInterface,
  store: PendingPayoutStore,
  p: PendingPayout,
  found: { txid: string; beef: number[] },
): Promise<{ accepted: boolean; txid: string }> {
  let rec = p;
  if (found.txid !== p.txid || !p.final) rec = store.finalize(p.id, found.txid) ?? { ...p, id: payoutId(found.txid, p.vout), txid: found.txid, final: true };
  const r = await internalizePayout(wallet, found.beef, { outputIndex: rec.vout, remittance: rec.remittance }, rec.description);
  if (r.accepted) store.remove(rec.id);
  return { accepted: r.accepted, txid: found.txid };
}

/** "Internalize now": find the final transaction on the instance, then internalize. */
export async function internalizeNow(wallet: WalletInterface, store: PendingPayoutStore, af: SignedFetch | null, base: string, p: PendingPayout): Promise<{ accepted: boolean; txid: string }> {
  const found = await findPayoutBeef(af, base, p);
  if (!found) {
    throw new Error(
      p.final
        ? `the instance's lookup has no transaction ${p.txid.slice(0, 16)}… paying this output (not admitted yet, or no longer in a live pool's BEEF)`
        : "the final transaction is not on the instance yet: the validator has not returned the signed swap yet",
    );
  }
  return internalizePending(wallet, store, p, found);
}

/** The AtomicBEEF bytes' txid (for the immediate path, where the page holds the final transaction). */
export function atomicTxid(atomicBeef: number[]): string {
  const b = Beef.fromBinary(atomicBeef);
  if (!b.atomicTxid) throw new Error("not AtomicBEEF");
  return b.atomicTxid;
}


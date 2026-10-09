/**
 * A prepared swap through the relay to its end (pure over the wallet and
 * AuthFetch, tested with fakes):
 *
 *   submit (amm.swap.submit) → poll amm.swap.status while pending →
 *     accepted: completeSwap (internalizeAction + relinquishOutput)
 *     refused / timeout: abandonSwap (abortAction of the funding)
 *     an error answer to submit (nothing recorded): abandonSwap
 *     no answer (network failure, the relay's transport `failed`, or still
 *       pending past expiry + grace):
 *       left alone — the relay may still carry it; "Check again" resumes
 *       polling, "Abandon" aborts the funding.
 */
import type { WalletInterface } from "@bsv/sdk";
import type { PoolState } from "@amm-poc/matching-engine";
import { RelayError, awaitSwap, submitSwap, swapStatus, type AuthFetchLike, type SwapRecord } from "./relay";
import { abandonSwap, completeSwap, type CompletedSwap, type PreparedSwap } from "./swapAction";

/** How long past the swap's expiry the page keeps polling. */
export const STATUS_GRACE_MS = 30_000;

export type SwapOutcome =
  | { status: "accepted"; id: string; txid: string; completed: CompletedSwap }
  | { status: "refused"; id: string; reason: string; pool?: PoolState }
  | { status: "timeout"; id: string }
  | { status: "failed"; reason: string }
  | { status: "unknown"; id?: string; reason: string };

export interface RelayContext {
  wallet: WalletInterface;
  authFetch: AuthFetchLike;
  /** `VITE_AMM_OVERLAY` */
  base: string;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onRecord?: (r: SwapRecord) => void;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** `peerId`: the chosen validator's libp2p peer ID, from the token's liveness read (the relay dials it). */
export async function relaySwap(c: RelayContext, p: PreparedSwap, peerId: string): Promise<SwapOutcome> {
  let first: SwapRecord;
  try {
    first = await submitSwap(c.authFetch, c.base, {
      funding: p.funding.atomicBeef,
      swap: p.swap.toBinary(),
      pool: p.pool,
      validator: p.validator,
      peerId,
      expires: p.expires,
    });
  } catch (err) {
    if (err instanceof RelayError) {
      // The relay answered with an error: it recorded nothing and sent nothing on.
      await abandonSwap(c.wallet, p);
      return { status: "failed", reason: `amm.swap.submit: ${err.message}` };
    }
    return { status: "unknown", reason: `amm.swap.submit: ${errText(err)}` };
  }
  c.onRecord?.(first);
  return settle(c, p, first);
}

/** Polls a record to its end and acts on it (also "Check again" for an unknown one). */
export async function settle(c: RelayContext, p: PreparedSwap, record: SwapRecord): Promise<SwapOutcome> {
  let r: SwapRecord;
  try {
    r = await awaitSwap(c.authFetch, c.base, record, { until: p.expires + STATUS_GRACE_MS, intervalMs: c.intervalMs, now: c.now, sleep: c.sleep, onRecord: c.onRecord });
  } catch (err) {
    return { status: "unknown", id: record.id, reason: `amm.swap.status: ${errText(err)}` };
  }
  switch (r.status) {
    case "pending":
      return { status: "unknown", id: r.id, reason: "still pending past the swap's expiry" };
    case "accepted":
      return { status: "accepted", id: r.id, txid: r.txid, completed: await completeSwap(c.wallet, p, r.tx, r.txid) };
    case "refused":
      await abandonSwap(c.wallet, p);
      return r.pool ? { status: "refused", id: r.id, reason: r.reason, pool: r.pool } : { status: "refused", id: r.id, reason: r.reason };
    case "timeout":
      await abandonSwap(c.wallet, p);
      return { status: "timeout", id: r.id };
    case "failed":
      return { status: "unknown", id: r.id, reason: `the relay could not reach the validator (${r.reason})` };
  }
}

/** "Check again" for an unknown outcome with a record id. */
export async function checkAgain(c: RelayContext, p: PreparedSwap, id: string): Promise<SwapOutcome> {
  let r: SwapRecord;
  try {
    r = await swapStatus(c.authFetch, c.base, id);
  } catch (err) {
    return { status: "unknown", id, reason: `amm.swap.status: ${errText(err)}` };
  }
  return settle(c, p, r);
}

/**
 * AddLiquidity through the user's own skein (as the swap: src/market/relay.ts,
 * docs/notes.md "Marketplace relay"). Two functions on the AMM app's box,
 * hosted by programs/amm-p2p (not provided yet; this is the shape the page
 * codes against):
 *
 *   amm.liquidity.submit  (writes)  {funding, add, pool, validator, peerId, expires} → the record
 *   amm.liquidity.status  (reads)   {id} → the record
 *
 *   funding    bytes: the funding transaction as the wallet's AtomicBEEF
 *   add        bytes: the add as AtomicBEEF (the funding and the token
 *              inputs' sources with it), every input signed but the pool
 *              input's validator slot (`OP_0`)
 *   pool       text `<txid>_<vout>`; validator bytes(33); expires unix ms
 *   peerId     text: the validator's libp2p peer ID, from the liveness read
 *
 * The record is the swap's (`parseSwapRecord`): `{id, status: pending |
 * accepted | refused | timeout | failed, tx?, txid?, reason?, detail?,
 * poolState?}`; accepted carries the validator-signed add. Transport and
 * bytes: `callApp` over the wallet's AuthFetch, DAG-JSON bytes.
 *
 * The flow (as src/market/swapFlow.ts):
 *   submit → poll amm.liquidity.status while pending →
 *     accepted: completeAddLiquidity (internalizeAction + relinquishOutput)
 *     refused / timeout: abandonAddLiquidity (abortAction of the funding);
 *       a refusal's pool state is returned for replanning
 *     an error answer to submit (nothing recorded): abandonAddLiquidity
 *     no answer (network, the relay's `failed`, pending past expiry +
 *       grace): left alone — "Check again" / "Abandon".
 */
import { Utils, type WalletInterface } from "@bsv/sdk";
import type { PoolState } from "@amm-poc/matching-engine";
import { RelayError, callApp, dagBytes, parseSwapRecord, type AuthFetchLike, type SwapRecord } from "../market/relay";
import { STATUS_GRACE_MS } from "../market/swapFlow";
import { abandonAddLiquidity, completeAddLiquidity, type CompletedAddLiquidity, type PreparedAddLiquidity } from "./addLiquidity";

export const LIQUIDITY_SUBMIT_FN = "amm.liquidity.submit";
export const LIQUIDITY_STATUS_FN = "amm.liquidity.status";

export interface LiquiditySubmit {
  funding: number[];
  add: number[];
  pool: string;
  validator: string;
  /** The validator's libp2p peer ID (text): what the relay dials. */
  peerId: string;
  expires: number;
}

export function liquiditySubmitBody(s: LiquiditySubmit): { fn: string; args: Record<string, unknown> } {
  return {
    fn: LIQUIDITY_SUBMIT_FN,
    args: { funding: dagBytes(s.funding), add: dagBytes(s.add), pool: s.pool, validator: dagBytes(Utils.toArray(s.validator, "hex")), peerId: s.peerId, expires: s.expires },
  };
}

export async function submitAddLiquidity(af: AuthFetchLike, base: string, s: LiquiditySubmit): Promise<SwapRecord> {
  const { fn, args } = liquiditySubmitBody(s);
  return parseSwapRecord(await callApp(af, base, fn, args));
}

export async function addLiquidityStatus(af: AuthFetchLike, base: string, id: string): Promise<SwapRecord> {
  return parseSwapRecord(await callApp(af, base, LIQUIDITY_STATUS_FN, { id }));
}

export type AddOutcome =
  | { status: "accepted"; id: string; txid: string; completed: CompletedAddLiquidity }
  | { status: "refused"; id: string; reason: string; pool?: PoolState }
  | { status: "timeout"; id: string }
  | { status: "failed"; reason: string }
  | { status: "unknown"; id?: string; reason: string };

export interface AddRelayContext {
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

/** `peerId`: the pool's validator's libp2p peer ID, from the liveness read (the relay dials it). */
export async function relayAddLiquidity(c: AddRelayContext, p: PreparedAddLiquidity, peerId: string): Promise<AddOutcome> {
  let first: SwapRecord;
  try {
    first = await submitAddLiquidity(c.authFetch, c.base, { funding: p.funding.atomicBeef, add: p.atomicBeef, pool: p.pool, validator: p.validator, peerId, expires: p.expires });
  } catch (err) {
    if (err instanceof RelayError) {
      // The relay answered with an error: it recorded nothing and sent nothing on.
      await abandonAddLiquidity(c.wallet, p);
      return { status: "failed", reason: `${LIQUIDITY_SUBMIT_FN}: ${err.message}` };
    }
    return { status: "unknown", reason: `${LIQUIDITY_SUBMIT_FN}: ${errText(err)}` };
  }
  c.onRecord?.(first);
  return settleAddLiquidity(c, p, first);
}

/** Polls a record to its end and acts on it. */
export async function settleAddLiquidity(c: AddRelayContext, p: PreparedAddLiquidity, record: SwapRecord): Promise<AddOutcome> {
  const now = c.now ?? Date.now;
  const sleep = c.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let r = record;
  try {
    while (r.status === "pending" && now() < p.expires + STATUS_GRACE_MS) {
      await sleep(c.intervalMs ?? 1000);
      r = await addLiquidityStatus(c.authFetch, c.base, r.id);
      c.onRecord?.(r);
    }
  } catch (err) {
    return { status: "unknown", id: r.id, reason: `${LIQUIDITY_STATUS_FN}: ${errText(err)}` };
  }
  switch (r.status) {
    case "pending":
      return { status: "unknown", id: r.id, reason: "still pending past the deposit's expiry" };
    case "accepted":
      return { status: "accepted", id: r.id, txid: r.txid, completed: await completeAddLiquidity(c.wallet, p, r.tx, r.txid) };
    case "refused":
      await abandonAddLiquidity(c.wallet, p);
      return r.pool ? { status: "refused", id: r.id, reason: r.reason, pool: r.pool } : { status: "refused", id: r.id, reason: r.reason };
    case "timeout":
      await abandonAddLiquidity(c.wallet, p);
      return { status: "timeout", id: r.id };
    case "failed":
      return { status: "unknown", id: r.id, reason: `the relay could not reach the validator (${r.reason})` };
  }
}

/** "Check again" for an unknown outcome with a record id. */
export async function checkAddLiquidityAgain(c: AddRelayContext, p: PreparedAddLiquidity, id: string): Promise<AddOutcome> {
  let r: SwapRecord;
  try {
    r = await addLiquidityStatus(c.authFetch, c.base, id);
  } catch (err) {
    return { status: "unknown", id, reason: `${LIQUIDITY_STATUS_FN}: ${errText(err)}` };
  }
  return settleAddLiquidity(c, p, r);
}

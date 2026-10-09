/**
 * A prepared pool deploy through the relay to its end (as src/market/swapFlow.ts):
 *
 *   submit (amm.pool.submit) → poll amm.pool.status while pending →
 *     accepted: completePoolDeploy (internalizeAction + relinquishOutput)
 *     refused / timeout: abandonPoolDeploy (abortAction of the funding)
 *     an error answer to submit (nothing recorded): abandonPoolDeploy
 *     no answer (network failure, the relay's transport `failed`, or still
 *       pending past expiry + grace): left alone — "Check again" resumes
 *       polling, "Abandon" aborts the funding.
 */
import type { WalletInterface } from "@bsv/sdk";
import { RelayError, type AuthFetchLike } from "../market/relay";
import { STATUS_GRACE_MS } from "../market/swapFlow";
import { abandonPoolDeploy, completePoolDeploy, type CompletedPoolDeploy, type PreparedPoolDeploy } from "./poolDeploy";
import { poolDeployStatus, submitPoolDeploy, type PoolRecord } from "./poolRelay";

export type DeployOutcome =
  | { status: "accepted"; id: string; txid: string; completed: CompletedPoolDeploy }
  | { status: "refused"; id: string; reason: string }
  | { status: "timeout"; id: string }
  | { status: "failed"; reason: string }
  | { status: "unknown"; id?: string; reason: string };

export interface DeployRelayContext {
  wallet: WalletInterface;
  authFetch: AuthFetchLike;
  /** `VITE_AMM_OVERLAY` */
  base: string;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onRecord?: (r: PoolRecord) => void;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** `peerId`: the chosen validator's libp2p peer ID, from the liveness read (the relay dials it). */
export async function relayPoolDeploy(c: DeployRelayContext, p: PreparedPoolDeploy, peerId: string): Promise<DeployOutcome> {
  let first: PoolRecord;
  try {
    first = await submitPoolDeploy(c.authFetch, c.base, { funding: p.funding.atomicBeef, deploy: p.atomicBeef, validator: p.validator, peerId, expires: p.expires });
  } catch (err) {
    if (err instanceof RelayError) {
      // The relay answered with an error: it recorded nothing and sent nothing on.
      await abandonPoolDeploy(c.wallet, p);
      return { status: "failed", reason: `amm.pool.submit: ${err.message}` };
    }
    return { status: "unknown", reason: `amm.pool.submit: ${errText(err)}` };
  }
  c.onRecord?.(first);
  return settlePoolDeploy(c, p, first);
}

/** Polls a record to its end and acts on it. */
export async function settlePoolDeploy(c: DeployRelayContext, p: PreparedPoolDeploy, record: PoolRecord): Promise<DeployOutcome> {
  const now = c.now ?? Date.now;
  const sleep = c.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let r = record;
  try {
    while (r.status === "pending" && now() < p.expires + STATUS_GRACE_MS) {
      await sleep(c.intervalMs ?? 1000);
      r = await poolDeployStatus(c.authFetch, c.base, r.id);
      c.onRecord?.(r);
    }
  } catch (err) {
    return { status: "unknown", id: r.id, reason: `amm.pool.status: ${errText(err)}` };
  }
  switch (r.status) {
    case "pending":
      return { status: "unknown", id: r.id, reason: "still pending past the deploy's expiry" };
    case "accepted":
      return { status: "accepted", id: r.id, txid: p.txid, completed: await completePoolDeploy(c.wallet, p, r.tx, r.txid) };
    case "refused":
      await abandonPoolDeploy(c.wallet, p);
      return { status: "refused", id: r.id, reason: r.reason };
    case "timeout":
      await abandonPoolDeploy(c.wallet, p);
      return { status: "timeout", id: r.id };
    case "failed":
      return { status: "unknown", id: r.id, reason: `the relay could not reach the validator (${r.reason})` };
  }
}

/** "Check again" for an unknown outcome with a record id. */
export async function checkPoolDeployAgain(c: DeployRelayContext, p: PreparedPoolDeploy, id: string): Promise<DeployOutcome> {
  let r: PoolRecord;
  try {
    r = await poolDeployStatus(c.authFetch, c.base, id);
  } catch (err) {
    return { status: "unknown", id, reason: `amm.pool.status: ${errText(err)}` };
  }
  return settlePoolDeploy(c, p, r);
}

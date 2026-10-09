/**
 * The pool deploy through the user's own skein (as the swap: src/market/relay.ts,
 * docs/notes.md "Marketplace relay"). Two functions on the AMM app's box,
 * hosted by programs/amm-p2p (the Zig side is not built yet; this is the
 * shape the page codes against):
 *
 *   amm.pool.submit  (writes)  {funding, deploy, validator, peerId, expires} → the record
 *   amm.pool.status  (reads)   {id} → the record
 *
 *   funding    bytes: the funding transaction as the wallet's AtomicBEEF
 *              (its ancestry with it), as `amm.swap.submit`'s
 *   deploy     bytes: the deploy as AtomicBEEF, every input signed; its
 *              ancestry is the funding transaction and the token inputs'
 *              source transactions (the validator's topic check needs the
 *              token inputs, which no overlay may hold yet)
 *   validator  bytes(33): the identity named in the pool (ValidatorIdentity)
 *   peerId     text: the validator's libp2p peer ID, from the liveness read
 *              (`GET <base>/.live/tm_mandala_<txid>_0-live`): what the relay dials
 *   expires    unix ms after which the relay gives up (the funding's hold lapses)
 *
 * The relay checks the pair (the deploy spends the funding output; output 0
 * is a pool whose ValidatorIdentity is `validator`), records it (`pending`),
 * dials the validator's `deploy` call, and on consent the validator
 * broadcasts both. The record is the swap's:
 *
 *   {id, status: "pending" | "accepted" | "refused" | "timeout" | "failed",
 *    tx?, txid?           accepted: the deploy as broadcast (ours: the
 *                         validator does not sign a deploy)
 *    reason?, detail?}    refused / timeout / failed
 *
 * "failed" is the relay's transport failure: no answer, not a refusal.
 * Transport and bytes: `callApp` over the wallet's AuthFetch, DAG-JSON
 * bytes (`{"/": {"bytes": "<base64, unpadded>"}}`).
 */
import { Utils } from "@bsv/sdk";
import { callApp, dagBytes, readBytes, type AuthFetchLike } from "../market/relay";

export const POOL_SUBMIT_FN = "amm.pool.submit";
export const POOL_STATUS_FN = "amm.pool.status";

export interface PoolSubmit {
  /** The funding transaction as AtomicBEEF. */
  funding: number[];
  /** The deploy as AtomicBEEF, every input signed. */
  deploy: number[];
  /** The pool's validator identity key (hex; sent as 33 bytes). */
  validator: string;
  /** The validator's libp2p peer ID (text): what the relay dials. */
  peerId: string;
  expires: number;
}

export type PoolRecord =
  | { id: string; status: "pending" }
  | { id: string; status: "accepted"; tx?: number[]; txid?: string }
  | { id: string; status: "refused"; reason: string }
  | { id: string; status: "timeout" }
  | { id: string; status: "failed"; reason: string };

export function poolSubmitBody(s: PoolSubmit): { fn: string; args: Record<string, unknown> } {
  return {
    fn: POOL_SUBMIT_FN,
    args: { funding: dagBytes(s.funding), deploy: dagBytes(s.deploy), validator: dagBytes(Utils.toArray(s.validator, "hex")), peerId: s.peerId, expires: s.expires },
  };
}

const why = (r: Record<string, unknown>, dflt: string) =>
  (typeof r.reason === "string" ? r.reason : dflt) + (typeof r.detail === "string" && r.detail ? `: ${r.detail}` : "");

export function parsePoolRecord(x: unknown): PoolRecord {
  const r = x as Record<string, unknown> | null;
  const id = r?.id;
  if (!r || typeof id !== "string") throw new Error(`relay: not a deploy record: ${JSON.stringify(x)?.slice(0, 200)}`);
  switch (r.status) {
    case "pending":
    case "timeout":
      return { id, status: r.status };
    case "failed":
      return { id, status: "failed", reason: why(r, "failed") };
    case "refused":
      return { id, status: "refused", reason: why(r, "refused") };
    case "accepted": {
      const tx = r.tx === undefined || r.tx === null ? undefined : readBytes(r.tx);
      if (tx === null) throw new Error("relay: accepted with an unreadable tx");
      return { id, status: "accepted", ...(tx ? { tx } : {}), ...(typeof r.txid === "string" ? { txid: r.txid } : {}) };
    }
    default:
      throw new Error(`relay: unknown deploy status ${JSON.stringify(r.status)}`);
  }
}

export async function submitPoolDeploy(af: AuthFetchLike, base: string, s: PoolSubmit): Promise<PoolRecord> {
  const { fn, args } = poolSubmitBody(s);
  return parsePoolRecord(await callApp(af, base, fn, args));
}

export async function poolDeployStatus(af: AuthFetchLike, base: string, id: string): Promise<PoolRecord> {
  return parsePoolRecord(await callApp(af, base, POOL_STATUS_FN, { id }));
}

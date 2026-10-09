/**
 * The marketplace relay (docs/notes.md, "Marketplace relay"): the user's own
 * skein instance takes the funding and swap transactions and carries them to
 * the pool's validator, so the browser needs no libp2p. Two functions on the
 * AMM app's box, hosted by programs/amm-p2p:
 *
 *   amm.swap.terms   (reads)   {} → {commissionPkh: bytes(20) | null}
 *   amm.swap.submit  (writes)  {funding, swap, pool, validator, peerId, expires} → the record
 *   amm.swap.status  (reads)   {id} → the record
 *
 *   commissionPkh  the address the relay takes the pool's commission at
 *              (Swap's `commissionPkh`); null when the instance has none
 *              configured, in which case a pool with a nonzero
 *              CommissionBps pays the commission to the taker's own key
 *              (src/market/swapAction.ts, "the commission")
 *
 *   funding    bytes: the funding transaction as the wallet's AtomicBEEF (its
 *              ancestry with it: the validator's overlay verifies the unproven
 *              funding against parents in the BEEF)
 *   swap       bytes: the raw swap, the validator's slot `OP_0`
 *   pool       text `<txid>_<vout>`; validator bytes(33); expires unix ms
 *   peerId     text: the validator's libp2p peer ID, from the token's liveness
 *              read (`GET <base>/.live/tm_mandala_<txid>_0-live`, the beat's body): the
 *              relay dials it (or, when it is the relay's own node, hands the
 *              swap to its own validator program); it looks at no liveness
 *
 * record (programs/amm-p2p relay.zig `Record.answer`; id = sha256 of the swap, hex):
 *   {id, status: "pending" | "accepted" | "refused" | "timeout" | "failed", pool, expires, …,
 *    tx?, txid?            accepted: the validator's signed swap
 *    reason?, detail?,     refused / timeout / failed
 *    poolState?}           refused: the pool's current state (the validator's)
 * "failed" is the relay's transport failure (retryable by submitting again):
 * the validator may or may not have the swap, so the page treats it as no
 * answer, not as a refusal.
 *
 * Transport: the app's `/call` route (skein docs/APPS.md §4): `POST
 * <VITE_AMM_OVERLAY>/call`, JSON body `{fn, args}`, answer `{fn, result}`
 * (200) or `{fn, error: {code, message}}` (400 bad-request / bad-args, 403
 * not-admitted, 404 unknown-fn, 409 read-only, 500 failed). The route is
 * BRC-104 authenticated: the caller must be admitted to the app's box, so
 * both calls go through the wallet-backed AuthFetch (src/wallet/authFetch.ts).
 *
 * Bytes in `args` are DAG-JSON bytes (`{"/": {"bytes": "<base64, unpadded>"}}`),
 * how skein reads JSON bodies (docs/MESSAGES.md "The messagebox"); answers are
 * read as DAG-JSON bytes, hex or a byte array.
 */
import { Utils } from "@bsv/sdk";
import type { PoolState } from "@amm-poc/matching-engine";

export const SWAP_SUBMIT_FN = "amm.swap.submit";
export const SWAP_STATUS_FN = "amm.swap.status";
export const SWAP_TERMS_FN = "amm.swap.terms";

/** The relay's terms: where it takes the commission (hash160 hex), or null when it names none. */
export interface SwapTerms {
  commissionPkh: string | null;
}

/** What the relay needs of `AuthFetch` (and what the tests fake). */
export interface AuthFetchLike {
  fetch(url: string, config?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<Pick<Response, "status" | "text">>;
}

export interface SwapSubmit {
  /** The funding transaction as AtomicBEEF (the swap's unproven parent, with its ancestry). */
  funding: number[];
  /** Raw swap transaction, the validator's slot empty. */
  swap: number[];
  /** The pool outpoint the swap spends, `<txid>_<vout>`. */
  pool: string;
  /** The pool's validator identity key (hex; sent as 33 bytes). */
  validator: string;
  /** The validator's libp2p peer ID (text), as the liveness read gave it: what the relay dials. */
  peerId: string;
  /** Unix ms after which the relay gives up (and the funding's hold lapses). */
  expires: number;
}

export type SwapRecord =
  | { id: string; status: "pending" }
  | { id: string; status: "accepted"; tx: number[]; txid: string }
  | { id: string; status: "refused"; reason: string; pool?: PoolState }
  | { id: string; status: "timeout" }
  | { id: string; status: "failed"; reason: string };

export class RelayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
  ) {
    super(`${code}: ${message}`);
    this.name = "RelayError";
  }
}

export function dagBytes(bytes: number[]): { "/": { bytes: string } } {
  return { "/": { bytes: Utils.toBase64(bytes).replace(/=+$/, "") } };
}

/** DAG-JSON bytes, hex, or a byte array → bytes; null otherwise. */
export function readBytes(x: unknown): number[] | null {
  if (Array.isArray(x) && x.every((b) => Number.isInteger(b) && b >= 0 && b < 256)) return x as number[];
  if (typeof x === "string" && /^([0-9a-f]{2})+$/i.test(x)) return Utils.toArray(x, "hex");
  const b = (x as { "/"?: { bytes?: unknown } } | null)?.["/"]?.bytes;
  if (typeof b === "string") {
    const padded = b + "=".repeat((4 - (b.length % 4)) % 4);
    return Utils.toArray(padded, "base64");
  }
  return null;
}

export function callUrl(base: string): string {
  return `${base.replace(/\/+$/, "")}/call`;
}

export function submitBody(s: SwapSubmit): { fn: string; args: Record<string, unknown> } {
  return {
    fn: SWAP_SUBMIT_FN,
    args: { funding: dagBytes(s.funding), swap: dagBytes(s.swap), pool: s.pool, validator: dagBytes(Utils.toArray(s.validator, "hex")), peerId: s.peerId, expires: s.expires },
  };
}

/** One `{fn, args}` call on the app's `/call` route. Throws `RelayError` on an error answer. */
export async function callApp(af: AuthFetchLike, base: string, fn: string, args: unknown): Promise<unknown> {
  const res = await af.fetch(callUrl(base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fn, args }),
  });
  const text = await res.text();
  let answer: { fn?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } } | null = null;
  try {
    answer = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (res.status === 200 && answer && "result" in answer) return answer.result;
  const e = answer?.error;
  throw new RelayError(
    typeof e?.code === "string" ? e.code : `HTTP ${res.status}`,
    typeof e?.message === "string" ? e.message : text.slice(0, 200),
    res.status,
  );
}

/**
 * A refusal's pool, as the validator writes it (messages.zig poolValue:
 * `lpFeeBps`, `validatorFeeBps`, `validatorIdentity`) or as the lookup does
 * (the engine's names), into the engine's PoolState. A closed pool, or one
 * missing a field, is undefined: nothing left to re-price.
 */
export function toPoolState(raw: unknown): PoolState | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const p = raw as Record<string, unknown>;
  if (p.closed) return undefined;
  const num = (...ks: string[]) => ks.map((k) => p[k]).find((v) => typeof v === "number" || typeof v === "string");
  const outpoint = p.outpoint;
  const bsv = num("bsvReserve");
  const tokens = num("tokenReserve");
  const lp = num("liquidityFeeBps", "lpFeeBps");
  const val = num("validationFeeBps", "validatorFeeBps");
  const comm = num("commissionBps");
  const rawId = p.validatorIdentityKey ?? p.validatorIdentity;
  const idBytes = typeof rawId === "string" ? null : readBytes(rawId);
  const identity = typeof rawId === "string" ? rawId : idBytes?.length === 33 ? Utils.toHex(idBytes) : undefined;
  if (typeof outpoint !== "string" || bsv === undefined || tokens === undefined || lp === undefined || val === undefined || typeof identity !== "string") {
    return undefined;
  }
  return {
    outpoint,
    bsvReserve: BigInt(bsv as number),
    tokenReserve: BigInt(tokens as number),
    liquidityFeeBps: BigInt(lp as number),
    validationFeeBps: BigInt(val as number),
    commissionBps: BigInt((comm ?? 0) as number),
    validatorIdentityKey: identity,
  };
}

export function parseSwapRecord(x: unknown): SwapRecord {
  const r = x as Record<string, unknown> | null;
  const id = r?.id ?? r?.swapId;
  const status = r?.status ?? r?.state;
  if (!r || typeof id !== "string") throw new Error(`relay: not a swap record: ${JSON.stringify(x)?.slice(0, 200)}`);
  switch (status) {
    case "pending":
    case "timeout":
      return { id, status };
    case "failed":
      return { id, status, reason: (typeof r.reason === "string" ? r.reason : "failed") + (typeof r.detail === "string" && r.detail ? `: ${r.detail}` : "") };
    case "accepted": {
      const tx = readBytes(r.tx);
      if (!tx || typeof r.txid !== "string") throw new Error("relay: accepted without tx / txid");
      return { id, status, tx, txid: r.txid };
    }
    case "refused": {
      const pool = toPoolState(r.poolState ?? (typeof r.pool === "object" ? r.pool : undefined));
      const reason = (typeof r.reason === "string" ? r.reason : "refused") + (typeof r.detail === "string" && r.detail ? `: ${r.detail}` : "");
      return pool ? { id, status, reason, pool } : { id, status, reason };
    }
    default:
      throw new Error(`relay: unknown swap status ${JSON.stringify(status)}`);
  }
}

/** `amm.swap.terms`'s answer: `commissionPkh` as DAG-JSON bytes (or hex, or a byte array) of 20 bytes, or null / absent. */
export function parseSwapTerms(x: unknown): SwapTerms {
  const r = x as Record<string, unknown> | null;
  if (!r || typeof r !== "object") throw new Error(`relay: not swap terms: ${JSON.stringify(x)?.slice(0, 200)}`);
  if (r.commissionPkh === null || r.commissionPkh === undefined) return { commissionPkh: null };
  const b = readBytes(r.commissionPkh);
  if (!b || b.length !== 20) throw new Error("relay: commissionPkh is not 20 bytes");
  return { commissionPkh: Utils.toHex(b) };
}

export async function swapTerms(af: AuthFetchLike, base: string): Promise<SwapTerms> {
  return parseSwapTerms(await callApp(af, base, SWAP_TERMS_FN, {}));
}

export async function submitSwap(af: AuthFetchLike, base: string, s: SwapSubmit): Promise<SwapRecord> {
  const { fn, args } = submitBody(s);
  return parseSwapRecord(await callApp(af, base, fn, args));
}

export async function swapStatus(af: AuthFetchLike, base: string, id: string): Promise<SwapRecord> {
  return parseSwapRecord(await callApp(af, base, SWAP_STATUS_FN, { id }));
}

export interface AwaitOptions {
  intervalMs?: number;
  /** Stop polling at this unix ms; a record still pending then is returned as is. */
  until: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onRecord?: (r: SwapRecord) => void;
}

/** Polls `amm.swap.status` while the record is pending, up to `until`. */
export async function awaitSwap(af: AuthFetchLike, base: string, first: SwapRecord, o: AwaitOptions): Promise<SwapRecord> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let r = first;
  while (r.status === "pending" && now() < o.until) {
    await sleep(o.intervalMs ?? 1000);
    r = await swapStatus(af, base, r.id);
    o.onRecord?.(r);
  }
  return r;
}

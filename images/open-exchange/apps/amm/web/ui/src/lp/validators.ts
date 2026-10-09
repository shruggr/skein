/**
 * The validator picker's model (pure, plus plain fetches for BRC-169):
 *
 * - the validators live in the instance's liveness read (`GET <base>/.live/tm_mandala_<txid>_0-live`);
 * - a BRC-169 handle, resolved in the page as skein's docs/MESSAGES.md
 *   "BRC-169 is discovery" describes: `GET <origin>/manifest.json` →
 *   `metanet.handles.resolve` (default `/.well-known/metanet-handles/resolve`)
 *   → `GET <resolve>?handle=<name>@<host>` → `{identityKey, messagebox, …}`;
 * - a raw identity key.
 *
 * A resolved or typed key is matched against the live list; an unmatched key
 * can still be chosen ("not seen live"). The choice is `{identityKey, peerId?,
 * handle?}`.
 */
import { PublicKey } from "@bsv/sdk";
import type { LiveAnswer, LiveValidator } from "../lib/overlay";

export interface ValidatorChoice {
  /** Compressed, lowercase hex. */
  identityKey: string;
  /** libp2p peer ID, when the instance has seen the key heartbeat. */
  peerId?: string;
  /** `name@domain`, when chosen by handle. */
  handle?: string;
}

export const DEFAULT_RESOLVE_PATH = "/.well-known/metanet-handles/resolve";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Pick<Response, "ok" | "status" | "json" | "text">>;

/** A 33-byte compressed public key in hex, normalized; null otherwise. */
export function parseIdentityKey(text: string): string | null {
  const t = text.trim().toLowerCase();
  if (!/^0[23][0-9a-f]{64}$/.test(t)) return null;
  try {
    return PublicKey.fromString(t).toString();
  } catch {
    return null;
  }
}

export type PickerInput =
  | { kind: "key"; identityKey: string }
  | { kind: "handle"; name: string; domain: string }
  | { kind: "invalid"; reason: string };

/** What the text field holds: an identity key, a `name@domain[:port]` handle, or neither. */
export function parsePickerInput(text: string): PickerInput {
  const t = text.trim();
  if (!t) return { kind: "invalid", reason: "enter a handle (name@domain) or an identity key" };
  const key = parseIdentityKey(t);
  if (key) return { kind: "key", identityKey: key };
  const m = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+(?::\d{1,5})?)$/.exec(t);
  if (m) return { kind: "handle", name: m[1]!, domain: m[2]!.toLowerCase() };
  return { kind: "invalid", reason: "not a handle (name@domain) or a compressed identity key (66 hex)" };
}

/** `https://<domain>`, except plain http for local development hosts (localhost, *.localhost, 127.0.0.1). */
export function originOf(domain: string): string {
  const host = domain.replace(/:\d+$/, "");
  const local = host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]";
  return `${local ? "http" : "https"}://${domain}`;
}

export interface ResolvedHandle {
  /** `name@domain` as entered. */
  handle: string;
  identityKey: string;
  messagebox?: string;
  /** The resolve endpoint the manifest named. */
  resolveUrl: string;
  /** The rest of the answer, as received. */
  raw: Record<string, unknown>;
}

export class HandleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandleError";
  }
}

async function getJson(fetchFn: FetchLike, url: string): Promise<unknown> {
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchFn(url, { headers: { accept: "application/json" } });
  } catch (err) {
    throw new HandleError(`GET ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      /* none */
    }
    throw new HandleError(`GET ${url}: ${res.status}${detail ? ` ${detail}` : ""}`);
  }
  try {
    return await res.json();
  } catch {
    throw new HandleError(`GET ${url}: not JSON`);
  }
}

/**
 * BRC-169 discovery for `name@domain`: the domain's manifest, its resolve
 * endpoint, the handle's answer. The query names the handle as
 * `<name>@<host>` (the port, if any, is part of where the domain is served,
 * not of the handle; skein's router answers `amm2` and `amm2@localhost`).
 */
export async function resolveHandle(name: string, domain: string, fetchFn: FetchLike = fetch): Promise<ResolvedHandle> {
  const origin = originOf(domain);
  const manifest = (await getJson(fetchFn, `${origin}/manifest.json`)) as { metanet?: { handles?: { resolve?: unknown } } } | null;
  const declared = manifest?.metanet?.handles?.resolve;
  const resolveUrl = new URL(typeof declared === "string" && declared ? declared : DEFAULT_RESOLVE_PATH, `${origin}/`).toString();
  const host = domain.replace(/:\d+$/, "");
  const url = `${resolveUrl}${resolveUrl.includes("?") ? "&" : "?"}handle=${encodeURIComponent(`${name}@${host}`)}`;
  const answer = (await getJson(fetchFn, url)) as Record<string, unknown> | null;
  if (!answer || typeof answer !== "object") throw new HandleError(`${name}@${domain}: empty answer`);
  const identityKey = typeof answer.identityKey === "string" ? parseIdentityKey(answer.identityKey) : null;
  if (!identityKey) throw new HandleError(`${name}@${domain}: the answer has no valid identityKey`);
  if (typeof answer.handle === "string" && answer.handle.split("@")[0]!.toLowerCase() !== name.toLowerCase()) {
    throw new HandleError(`${name}@${domain}: the resolver answered for ${answer.handle}`);
  }
  return {
    handle: `${name}@${domain}`,
    identityKey,
    ...(typeof answer.messagebox === "string" ? { messagebox: answer.messagebox } : {}),
    resolveUrl,
    raw: answer,
  };
}

/** The live entry for `identityKey`, if the instance has seen it at all. */
export function findLive(identityKey: string, live: LiveAnswer | null): LiveValidator | undefined {
  const k = identityKey.toLowerCase();
  return live?.validators.find((v) => v.identityKey === k);
}

/** A choice for `identityKey`, with the peer ID when the live list knows it. */
export function choiceFor(identityKey: string, live: LiveAnswer | null, handle?: string): ValidatorChoice {
  const v = findLive(identityKey, live);
  return {
    identityKey: identityKey.toLowerCase(),
    ...(v?.peerId ? { peerId: v.peerId } : {}),
    ...(handle ? { handle } : {}),
  };
}

/** "live", "offline" (seen, heartbeat older than the threshold) or "not seen live". */
export function livenessOf(identityKey: string, live: LiveAnswer | null): "live" | "offline" | "not seen live" {
  const v = findLive(identityKey, live);
  return !v ? "not seen live" : v.live ? "live" : "offline";
}

/** "7 s ago", "3 min ago", ... */
export function ago(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))} s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  return `${Math.round(ms / 3_600_000)} h ago`;
}

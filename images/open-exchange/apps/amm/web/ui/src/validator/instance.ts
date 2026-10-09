/**
 * The Validator page's view of "this instance" (pure, plus plain fetches):
 *
 * - origin: the origin of `VITE_AMM_OVERLAY` (the instance answers its own
 *   routes, the messagebox and `/.well-known/auth` there);
 * - handle: the first label of the origin's host (`amm2.localhost:8300` →
 *   `amm2` at `localhost:8300`), or the `/@<handle>/` dev prefix;
 * - identity key: the router's BRC-169 answer for that handle
 *   (src/lp/validators.ts `resolveHandle`: `/manifest.json` → resolve);
 * - peer ID and liveness: what the OTHER node's liveness read reports for
 *   that identity (`GET <peer>/.live/tm_mandala_<txid>_0-live`, for each token topic
 *   this instance serves, merged: the peer keeps it when it is a market for
 *   the token).
 *
 * And the pools this instance serves as a validator: the lookup's pools whose
 * `validatorIdentityKey` is this instance's identity.
 */
import type { PoolState } from "@amm-poc/matching-engine";
import type { LiveAnswer, LiveValidator, TokenTopic } from "../lib/overlay";
import { LIVE_WINDOW_MS, liveTopicOf, liveUrl, mergeLive, noLiveness, parseLiveBeats } from "../lib/overlay";
import { findLive, resolveHandle, type FetchLike, type ResolvedHandle } from "../lp/validators";

export interface InstanceAddress {
  /** `http://amm2.localhost:8300` */
  origin: string;
  /** `amm2`, when the origin names one. */
  name?: string;
  /** `localhost:8300`: where the handle's router answers BRC-169. */
  domain?: string;
}

/** The instance's origin and handle from its AMM base URL (`http://amm2.localhost:8300/amm`). */
export function instanceAddress(base: string): InstanceAddress {
  const u = new URL(base);
  const origin = u.origin;
  // Dev form: http://<host>:<port>/@<handle>/…
  const at = /^\/@([A-Za-z0-9._-]+)(?:\/|$)/.exec(u.pathname);
  if (at) return { origin: `${origin}/@${at[1]}`, name: at[1]!, domain: u.host };
  const labels = u.hostname.split(".");
  const ip = /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) || u.hostname.startsWith("[");
  if (labels.length < 2 || ip) return { origin };
  return { origin, name: labels[0]!, domain: labels.slice(1).join(".") + (u.port ? `:${u.port}` : "") };
}

/** `amm3.localhost:8400` for `http://amm3.localhost:8400/amm`. */
export function hostLabel(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}

export interface PeerView {
  /** The peer's AMM base. */
  base: string;
  /** `amm3.localhost:8400` */
  label: string;
  /** The peer's liveness reads for our token topics, merged (null when they could not be read). */
  live: LiveAnswer | null;
  /** The peer's entry for our identity, if it has heard our heartbeat. */
  entry?: LiveValidator;
  error?: string;
}

export interface ThisInstance {
  address: InstanceAddress;
  /** `amm2@localhost:8300` when known. */
  handle?: string;
  resolved?: ResolvedHandle;
  /** Why the identity is unknown. */
  resolveError?: string;
  identityKey?: string;
  /** From the peer's live list; absent until a peer sees us. */
  peerId?: string;
  peer?: PeerView;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The peer's liveness read (`GET <base>/.live/tm_mandala_<txid>_0-live`) for each token topic, merged; 404 is none kept. */
async function getLive(base: string, topics: string[], fetchFn: FetchLike, now: number): Promise<LiveAnswer> {
  const answers = await Promise.all(
    topics.map(async (topic) => {
      const url = liveUrl(base, liveTopicOf(topic));
      const res = await fetchFn(url, { headers: { accept: "application/json" } });
      if (res.status === 404) return noLiveness(now);
      if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
      return parseLiveBeats(await res.json(), now, LIVE_WINDOW_MS);
    }),
  );
  return mergeLive(answers, now);
}

/**
 * Reads what "this instance" is: handle → identity (BRC-169), then the
 * peer's liveness reads of `topics` (the token topics this instance serves)
 * for that identity's peer ID and last beat. `peerBase` "" skips the peer.
 */
export async function loadThisInstance(base: string, peerBase: string, topics: string[], fetchFn: FetchLike = fetch, now: number = Date.now()): Promise<ThisInstance> {
  const address = instanceAddress(base);
  const out: ThisInstance = { address };
  if (address.name && address.domain) {
    out.handle = `${address.name}@${address.domain}`;
    try {
      out.resolved = await resolveHandle(address.name, address.domain, fetchFn);
      out.identityKey = out.resolved.identityKey;
    } catch (e) {
      out.resolveError = errText(e);
    }
  } else {
    out.resolveError = `the origin ${address.origin} names no handle (expected <handle>.<domain> or /@<handle>/)`;
  }
  if (peerBase) {
    const peer: PeerView = { base: peerBase, label: hostLabel(peerBase), live: null };
    try {
      peer.live = await getLive(peerBase, topics, fetchFn, now);
      const entry = out.identityKey ? findLive(out.identityKey, peer.live) : undefined;
      if (entry) {
        peer.entry = entry;
        if (entry.peerId) out.peerId = entry.peerId;
      }
    } catch (e) {
      peer.error = errText(e);
    }
    out.peer = peer;
  }
  return out;
}

/** The liveness line: "last heartbeat seen by amm3.localhost:8400: 12 s ago (live)", or why not. */
export function livenessLine(t: ThisInstance, ago: (ms: number) => string): string {
  const p = t.peer;
  if (!p) return "no peer configured (VITE_AMM_PEER_OVERLAY): liveness unknown";
  if (p.error) return `could not read ${p.label}'s liveness: ${p.error}`;
  if (!t.identityKey) return "unknown: this instance's identity key is unknown";
  if (!p.entry) return p.live && !p.live.kept ? `${p.label} keeps no liveness for this instance's tokens` : `${p.label} has no beat from this identity within its window`;
  return `last beat seen by ${p.label}: ${ago(p.entry.ageMs)} (${p.entry.live ? "live" : "offline"})`;
}

export interface ServedPool {
  topic: TokenTopic;
  pool: PoolState;
}

/**
 * The pools whose validator identity is `identityKey`, across the token
 * topics, from each topic's lookup answer (an Error answer is skipped and
 * reported by the caller).
 */
export function poolsServedBy(
  identityKey: string,
  topics: TokenTopic[],
  pools: Map<string, PoolState[] | Error>,
): ServedPool[] {
  const k = identityKey.toLowerCase();
  const out: ServedPool[] = [];
  for (const topic of topics) {
    const answer = pools.get(topic.tokenId);
    if (!answer || answer instanceof Error) continue;
    for (const pool of answer) if (pool.validatorIdentityKey.toLowerCase() === k) out.push({ topic, pool });
  }
  return out;
}

/**
 * The skein's own doors the Open Exchange pages use beside the AMM's routes
 * (skein-amm 0.9.0):
 *
 * - **A message to a box** (`sendMessage`): the BRC-104-signed `POST
 *   <instance>/sendMessage`, BRC-231 CBOR `{message: {recipient, messageBox,
 *   body}}` — what `skein send`, skein-mandala's Token topics page and any
 *   BRC-100 wallet send (skein docs/MESSAGES.md "The messagebox"). `body` is
 *   dag-cbor. The instance is the AMM base's origin (or its `/@<handle>`
 *   prefix); the recipient its identity key. Root's register messages
 *   (`amm/register`) and a holder's listing request (`amm/requests`).
 * - **The reads** (no signature; nothing logged): `GET <base>/requests` (the
 *   holders' listing requests), `GET <base>/spends?outpoint=` (the chain
 *   state of an outpoint), `GET <base>/mandala/tokens` (the token list), and
 *   the liveness read `GET <base>/.live/<topic>` (each sender's latest beat:
 *   a lookup service's beat body is its own, skein-overlay 0.12.0).
 */
import { encode, decode } from "cbor2";
import { Utils } from "@bsv/sdk";
import { liveUrl } from "./overlay";
import { appName } from "./config";

export interface SignedPost {
  fetch(url: string, config?: { method?: string; headers?: Record<string, string>; body?: unknown }): Promise<Response>;
}

/** The instance's base under which `/sendMessage` lives: the AMM base without its app segment. */
export function instanceBase(base: string): string {
  const name = appName(base);
  return name ? base.replace(new RegExp(`/${name}/?$`), "") : base;
}

/** dag-cbor (CDE: canonical key order, shortest forms) of a plain value. */
export function dagCbor(v: unknown): Uint8Array {
  return encode(v, { cde: true });
}

/**
 * A message from the connected wallet's key to the instance's `box` (`<app>/<box>`): its id. The
 * instance's identity is `recipient` (hex).
 */
export async function sendMessage(af: SignedPost, base: string, recipient: string, box: string, body: unknown): Promise<string> {
  const url = `${instanceBase(base)}/sendMessage`;
  const res = await af.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/cbor" },
    body: dagCbor({ message: { recipient: Uint8Array.from(Utils.toArray(recipient, "hex") as number[]), messageBox: box, body: dagCbor(body) } }),
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  let v: Record<string, unknown> = {};
  try {
    v = decode(bytes) as Record<string, unknown>;
  } catch {
    v = { description: new TextDecoder().decode(bytes) };
  }
  if (res.status !== 200) throw new Error(`sendMessage ${box}: HTTP ${res.status} ${String(v.code ?? "")} ${String(v.description ?? "")}`.trim());
  return String(v.id ?? v.messageId ?? "");
}

async function getJson(url: string, fetchFn: typeof fetch = fetch): Promise<unknown> {
  const res = await fetchFn(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** A holder's listing request, as `GET <base>/requests` answers it. */
export interface WireRequest {
  tokenId: string;
  /** The requester's identity key, hex. */
  from: string;
  at: number;
}

export async function readRequests(base: string, fetchFn: typeof fetch = fetch): Promise<WireRequest[]> {
  const a = await getJson(`${base}/requests`, fetchFn);
  return Array.isArray(a) ? (a as WireRequest[]).filter((r) => typeof r.tokenId === "string") : [];
}

/** The chain state of an outpoint (amm-p2p reads.zig `spendOf`). */
export interface Spend {
  /** `<txid>.<vout>` */
  outpoint: string;
  spentBy?: string;
  /** Followed from a pool output: its current output, `<txid>.<vout>` (absent: closed, or not a pool). */
  current?: string;
  hops: number;
  closed: boolean;
}

export async function readSpend(base: string, outpoint: string, fetchFn: typeof fetch = fetch): Promise<Spend> {
  return (await getJson(`${base}/spends?outpoint=${encodeURIComponent(outpoint)}`, fetchFn)) as Spend;
}

/** A token of the list (`GET <base>/mandala/tokens`, skein-mandala): its id, topic and metadata. */
export interface ListedToken {
  tokenId: string;
  topic: string;
  sym?: string;
  dec?: number;
  icon?: string;
}

export async function readTokenList(base: string, fetchFn: typeof fetch = fetch): Promise<ListedToken[]> {
  const a = await getJson(`${base}/mandala/tokens?limit=1000`, fetchFn);
  const list = Array.isArray(a) ? a : a && typeof a === "object" && Array.isArray((a as { tokens?: unknown }).tokens) ? (a as { tokens: unknown[] }).tokens : [];
  return (list as Record<string, unknown>[])
    .filter((t) => typeof t.tokenId === "string")
    .map((t) => ({
      tokenId: String(t.tokenId),
      topic: typeof t.topic === "string" ? t.topic : `tm_mandala_${String(t.tokenId)}`,
      ...(typeof t.sym === "string" ? { sym: t.sym } : {}),
      ...(typeof t.dec === "number" ? { dec: t.dec } : typeof t.dec === "string" && /^\d+$/.test(t.dec) ? { dec: Number(t.dec) } : {}),
      ...(typeof t.icon === "string" ? { icon: t.icon } : {}),
    }));
}

/** One sender's latest beat on a liveness topic: its identity, when, and its body (bytes). */
export interface Beat {
  sender: string;
  at: number;
  body: Uint8Array;
  from: string;
}

/** `GET <base>/.live/<topic>`: the beats within the window, newest first; [] when the skein keeps no liveness for it (404). */
export async function readBeats(base: string, topic: string, fetchFn: typeof fetch = fetch): Promise<Beat[]> {
  const res = await fetchFn(liveUrl(base, topic), { headers: { accept: "application/json" } });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GET ${topic}: ${res.status}`);
  const a = await res.json();
  return (Array.isArray(a) ? (a as Record<string, unknown>[]) : [])
    .filter((x) => typeof x.sender === "string")
    .map((x) => ({
      sender: String(x.sender).toLowerCase(),
      at: typeof x.at === "number" ? x.at : 0,
      body: typeof x.body === "string" ? Uint8Array.from(Utils.toArray(x.body, "base64") as number[]) : new Uint8Array(),
      from: typeof x.from === "string" ? x.from : "",
    }));
}

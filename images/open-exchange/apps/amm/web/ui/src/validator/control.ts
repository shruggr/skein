/**
 * Root's reads of this instance as a validator, over HTTP, signed by the
 * connected BRC-100 wallet through `@bsv/sdk`'s `AuthFetch` (BRC-103
 * handshake at `<origin>/.well-known/auth`, every request BRC-104-signed):
 * the explorer (`GET <origin>/explore…`, gated by root, shruggr/skein#143;
 * others get 403) — the genesis (log entry 0, `{kind: "genesis", identity,
 * defaults, …}`) for the instance's identity, and the installed
 * app record (`<app>/app`) for the policy: `config.amm.ammValidator` and the
 * engine's two roles, market and validator (skein-amm 0.6.0, shruggr/skein#120).
 * The roles are root's switch (0.6.2, skein-overlay 0.9.2; David,
 * 2026-10-07: "this shouldn't have been a config in the manifest. This
 * should be a setting that the user is configuring"): read as the engine
 * reads them, the switch kept in the registered set's record (`<app>/topics`:
 * `market?: {window} | {off: true}`, `validator?: {every} | {off: true}`)
 * over the app record's `config.overlay.market {window}` /
 * `config.overlay.validator {every}` (`withSwitches`).
 *
 * Nothing is sent from here: the switches are on the Token topics page, mandala/tokens/ (the
 * engine's `market` / `validator` message to `<app>/register`).
 */

/** What the page needs of `AuthFetch` (and what the tests fake). */
export interface AuthFetchLike {
  fetch(
    url: string,
    config?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<Pick<Response, "status" | "text">>;
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// The explorer (root only): the genesis, its identity and defaults
// ---------------------------------------------------------------------------

export interface ValidatorPolicy {
  minValidatorFeeBps?: number;
  maxLpFeeBps?: number;
  /** The market's liveness window (ms; the switch, else `config.overlay.market.window`): this instance is a market; absent, it is not. */
  marketWindowMs?: number;
  /** The validator's beat (ms; the switch, else `config.overlay.validator.every`): this instance is a validator; absent, it is not. */
  validatorEveryMs?: number;
}

export interface GenesisRead {
  ok: boolean;
  status: number;
  /** The genesis's identity key (hex), when read. */
  identity?: string;
  policy?: ValidatorPolicy;
  /** Why it could not be read. */
  error?: string;
}

/** DAG-JSON bytes `{"/": {"bytes": "<base64, unpadded>"}}` → hex. */
export function dagBytesHex(v: unknown): string | undefined {
  const b = (v as { "/"?: { bytes?: unknown } } | null)?.["/"]?.bytes;
  if (typeof b !== "string") return typeof v === "string" && /^[0-9a-f]+$/i.test(v) ? v.toLowerCase() : undefined;
  const s = b.replace(/-/g, "+").replace(/_/g, "/");
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  try {
    const bin = atob(padded);
    let hex = "";
    for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, "0");
    return hex;
  } catch {
    return undefined;
  }
}

/** A DAG-JSON link's CID, else undefined. */
function linkOf(v: unknown): string | undefined {
  const l = (v as { "/"?: unknown } | null)?.["/"];
  return typeof l === "string" ? l : undefined;
}

/** A genesis default: a JSON string (as the genesis keeps `ammValidator`) or an object. */
function jsonDefault(v: unknown): Record<string, unknown> | undefined {
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v) as unknown;
      return p && typeof p === "object" ? (p as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }
  return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

const num = (v: unknown) => (typeof v === "number" ? v : undefined);

/**
 * The policy from a genesis record's `defaults` (JSON strings: `ammValidator`,
 * `overlayMarket`, `overlayValidator`), or from an installed app record's
 * `config` (`{kind: "app", config: {amm: {ammValidator}, overlay: {market?:
 * {window}, validator?: {every}}}}`), which the programs read first.
 */
export function policyOf(rec: Record<string, unknown>): ValidatorPolicy {
  const config = rec.kind === "app" ? ((rec.config ?? {}) as Record<string, unknown>) : undefined;
  const d = (rec.defaults ?? {}) as Record<string, unknown>;
  const amm = (config ? config.amm ?? {} : d) as Record<string, unknown>;
  const ov = (config ? config.overlay ?? {} : {}) as Record<string, unknown>;
  const v = jsonDefault(amm.ammValidator) ?? {};
  const market = jsonDefault(config ? ov.market : d.overlayMarket);
  const validator = jsonDefault(config ? ov.validator : d.overlayValidator);
  const out: ValidatorPolicy = {};
  const set = <K extends keyof ValidatorPolicy>(k: K, x: ValidatorPolicy[K] | undefined) => {
    if (x !== undefined) out[k] = x;
  };
  set("minValidatorFeeBps", num(v.minValidatorFeeBps));
  set("maxLpFeeBps", num(v.maxLpFeeBps));
  set("marketWindowMs", num(market?.window));
  set("validatorEveryMs", num(validator?.every));
  return out;
}

function isGenesis(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "genesis";
}

/**
 * Reads the genesis through the explorer as the connected wallet:
 * `GET <instance>/explore/log?before=1&limit=1` (log entry 0, with its record
 * as DAG-JSON); a record that only links the genesis is followed through
 * `GET <instance>/explore/record/<cid>` (at most two hops). A 403 is the
 * explorer's gate refusing a caller that does not hold root (shruggr/skein#143).
 */
export async function readGenesis(authFetch: AuthFetchLike, instanceUrl: string): Promise<GenesisRead> {
  const base = instanceUrl.replace(/\/+$/, "");
  const get = async (path: string) => {
    const res = await authFetch.fetch(`${base}${path}`, { method: "GET" });
    return { status: res.status, body: parseBody(await res.text()) };
  };
  const first = await get("/explore/log?before=1&limit=1");
  if (first.status !== 200) {
    const b = (first.body ?? {}) as Record<string, unknown>;
    const why =
      first.status === 403
        ? "refused (403): the explorer answers root only, and the connected wallet does not hold root on this instance"
        : `HTTP ${first.status}${typeof b.description === "string" ? `: ${b.description}` : ""}`;
    return { ok: false, status: first.status, error: why };
  }
  const entries = ((first.body as { entries?: unknown[] } | null)?.entries ?? []) as Record<string, unknown>[];
  let candidate: unknown = entries.find((e) => e.n === 0) ?? entries[0];
  for (let hop = 0; hop < 3 && candidate; hop++) {
    const c = candidate as Record<string, unknown>;
    const found = [c, c.record, c.genesis].find(isGenesis);
    if (found) {
      const identity = dagBytesHex(found.identity);
      return {
        ok: true,
        status: 200,
        ...(identity ? { identity } : {}),
        policy: policyOf(found),
      };
    }
    const rec = c.record as Record<string, unknown> | undefined;
    const link = linkOf(c.genesis) ?? linkOf(rec?.genesis) ?? (rec === undefined ? linkOf(c.entry) : undefined);
    if (!link) break;
    const r = await get(`/explore/record/${link}`);
    if (r.status !== 200) return { ok: false, status: r.status, error: `explore/record/${link}: HTTP ${r.status}` };
    candidate = { record: r.body };
  }
  return { ok: false, status: 200, error: "the explorer answered, but log entry 0 is not a genesis record this page recognizes" };
}

/**
 * The installed app's policy through the explorer (root's read): the
 * head `<app>/app` (`GET <instance>/explore/head/<app>/app` → `{tree: <the
 * app record's CID>}`), then the record (`/explore/record/<cid>`), its
 * `config.amm`. Undefined when the head or the record cannot be read.
 */
export async function readAppPolicy(authFetch: AuthFetchLike, instanceUrl: string, app: string): Promise<ValidatorPolicy | undefined> {
  const base = instanceUrl.replace(/\/+$/, "");
  const get = async (path: string) => {
    const res = await authFetch.fetch(`${base}${path}`, { method: "GET" });
    return res.status === 200 ? parseBody(await res.text()) : undefined;
  };
  const headRecord = async (name: string) => {
    const cid = linkOf(((await get(`/explore/head/${name}`)) as { tree?: unknown } | undefined)?.tree);
    return cid ? await get(`/explore/record/${cid}`) : undefined;
  };
  const rec = await headRecord(`${app}/app`);
  if (!rec || typeof rec !== "object" || (rec as { kind?: unknown }).kind !== "app") return undefined;
  return withSwitches(policyOf(rec as Record<string, unknown>), await headRecord(`${app}/topics`));
}

/**
 * The roles in effect (skein-overlay 0.9.2, `topics.effective`): root's
 * switch kept in the registered set's record `<app>/topics` (`market: {window}
 * | {off: true}`, `validator: {every} | {off: true}`) over the policy's
 * `config.overlay` values; a role never switched keeps the manifest's.
 */
export function withSwitches(policy: ValidatorPolicy, topicsRecord: unknown): ValidatorPolicy {
  const r = (topicsRecord ?? {}) as Record<string, unknown>;
  if (r.kind !== "overlay-topics") return policy;
  const out: ValidatorPolicy = { ...policy };
  for (const [role, field, key] of [["market", "window", "marketWindowMs"], ["validator", "every", "validatorEveryMs"]] as const) {
    const sw = r[role] as Record<string, unknown> | undefined;
    if (!sw || typeof sw !== "object") continue;
    const ms = num(sw[field]);
    if (sw.off === true || ms === undefined) delete out[key];
    else out[key] = ms;
  }
  return out;
}

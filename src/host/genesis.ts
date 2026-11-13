// The genesis on the host's side (skein next, SPEC.md section 3; kernel-zig log.zig is
// authoritative): the record a new instance's log starts with, and its entry.
//
//   entry    {kind: "log", prev: null, n: 0, time, genesis: <cid>}   — the one entry the host writes;
//            every other the kernel appends at COMMIT
//   genesis  {kind: "genesis", identity: bytes(33), handle, domain, routes: [<row>],
//             grants?: {<role>: [bytes(33)]}, calls?: {<app>: {<app>: [<name>] | "*"}},
//             services?: {<app>: ["signer"]}, defaults?: {<name>: text}, tree?: <git tree>,
//             heads?: {<head>: <record cid>}}
//
// One loader (SPEC 8): everything about the starting point comes from a tree (boot.ts): its
// etc/routes.json rows (the kernel's operation rows and an image's claim row among them), its
// etc/config.json defaults and grants, the apps its etc/apps.json installs at birth (their records
// pre-filled, their rows, heads and call permissions here). The host brings the instance's own facts
// (identity, handle, domain), the host's defaults (fuel, the network), and — the image's builder's
// call (SPEC 3: who builds the image decides what the starting table holds) — the grants it adds:
// root for an instance born owned, the `chain.status` role for its status service key.

import type { CID } from "multiformats/cid";
import { rowKey, rowProblem, type DispatchRow } from "../runtime/dispatch.ts";
import { DEFAULTS, nextEntry } from "../runtime/log.ts";
import type { Stamp } from "../runtime/syscalls.ts";
import { now as clockNow } from "./clock.ts";
import type { KernelSurface as Kernel } from "./kernel.ts";

export const keyBytes = (hex: string): Uint8Array => {
  if (!/^0[23][0-9a-f]{64}$/.test(hex)) throw new TypeError(`not an identity key: ${hex}`);
  return Uint8Array.from(Buffer.from(hex, "hex"));
};
export const keyHex = (k: unknown): string => k instanceof Uint8Array ? Buffer.from(k).toString("hex") : String(k);

/** What the host brings to a genesis: the instance's own facts, the host's defaults, the grants it adds. */
export interface GenesisConfig {
  identity: string;
  handle: string;
  domain: string;
  /**
   * The grants the host adds at birth, by role (hex keys): `root` for an instance born owned (an
   * owner at birth: no claim row), `chain.status` for the host's status service key. Over a tree's
   * etc/config.json `grants`.
   */
  grants?: Record<string, string[]>;
  /** The host's defaults: what a tree's config leaves unset. */
  defaults?: Record<string, string>;
  /** Explicit host overrides (dev: SKEIN_FUEL_PER_STEP) that win even over a tree's config; `warn` says so when they do. */
  overrides?: Record<string, string>;
  warn?(line: string): void;
  /**
   * The network the whole host runs on (SKEIN_NETWORK: `main` | `test` | `regtest`), written as
   * `defaults.walletNetwork` at the host's fill-ins level (a tree's config and `overrides` win).
   */
  network?: string;
  /** An installed app's config at birth, by app name, merged over its manifest's `config`. */
  appConfig?: Record<string, Record<string, unknown>>;
}

/** A system tree's config (etc/config.json): the defaults, and the starting grants ({<role>: [<hex key>]}). */
export interface ConfigSpec {
  defaults?: Record<string, string>;
  grants?: Record<string, string[]>;
}

/** A system resolved for one instance: what its genesis says besides who it is. */
export interface System {
  /** The starting rows. */
  routes: DispatchRow[];
  defaults: Record<string, string>;
  grants: Record<string, string[]>;
  /** The system tree (a git tree CID): `main` starts there. */
  tree?: CID;
  /** The heads an image's installed apps set (`<app>/app`), name → record CID. */
  heads?: Record<string, CID>;
  /** Call permissions written at birth: per caller, per callee, the names ("*": any). */
  calls?: Record<string, Record<string, string[]>>;
  /** Kernel services held at birth, per caller. */
  services?: Record<string, string[]>;
}

/** The config fields gone (skein next), refused with why. */
const CONFIG_GONE: Record<string, string> = {
  feeds: "gone (SPEC 8): an instance declares no header source; the host's one header intake sends every instance the chain pointer event",
  jobs: "gone: no schedules",
  peers: "gone (SPEC 3): no address book",
  names: "gone (SPEC 3): no names",
  collect: "gone",
  owner: "gone: root is a grant (`grants: {root: [<key>]}`) or the claim's",
  libp2p: "gone (SPEC 8): gossip is the host's; an app's subscribe and beacon events say what the instance serves",
  scopes: "gone (SPEC 3): an app writes only under its own name",
  roles: "gone (SPEC 3): roles live on the rows",
};

/** A tree's config checked (etc/config.json). */
export function checkConfig(config: unknown): ConfigSpec {
  if (config === undefined) return {};
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("etc/config.json: not a map");
  const c = config as Record<string, unknown>;
  for (const [k, why] of Object.entries(CONFIG_GONE)) if (c[k] !== undefined) throw new Error(`etc/config.json: \`${k}\` ${why}`);
  const extra = Object.keys(c).filter((k) => k !== "defaults" && k !== "grants");
  if (extra.length) throw new Error(`etc/config.json: ${extra.join(", ")}: not a field (defaults, grants)`);
  if (c.defaults !== undefined && (!c.defaults || typeof c.defaults !== "object" || Object.values(c.defaults).some((v) => typeof v !== "string"))) throw new Error("etc/config.json: defaults is {<name>: <text>}");
  if (c.grants !== undefined && (!c.grants || typeof c.grants !== "object" || Object.values(c.grants).some((v) => !Array.isArray(v) || v.some((k) => typeof k !== "string" || !/^0[23][0-9a-f]{64}$/.test(k))))) throw new Error("etc/config.json: grants is {<role>: [<identity key, hex>]}");
  return c as ConfigSpec;
}

/** The rows a tree names (etc/routes.json), each checked as the kernel will (dispatch.ts rowProblem); a key twice is refused. */
export function rowsOf(specs: unknown): DispatchRow[] {
  if (!Array.isArray(specs)) throw new Error("etc/routes.json: not a list");
  const seen = new Set<string>();
  const out: DispatchRow[] = [];
  for (const [i, r] of specs.entries()) {
    const why = rowProblem(r);
    if (why) throw new Error(`etc/routes.json[${i}]: ${why}`);
    const k = rowKey(r as DispatchRow);
    if (seen.has(k)) throw new Error(`etc/routes.json[${i}]: ${k} twice`);
    seen.add(k);
    out.push(r as DispatchRow);
  }
  return out;
}

/** Whether a row is the kernel's claim row. */
export const isClaimRow = (r: DispatchRow): boolean => r.handler === "kernel.claim";

/** Resolve a system for one instance: the tree's rows and config, the host's defaults and grants. */
export function resolveSystem(c: GenesisConfig, config: ConfigSpec, routes: DispatchRow[], tree?: CID): System {
  const grants: Record<string, string[]> = {};
  for (const [role, keys] of [...Object.entries(config.grants ?? {}), ...Object.entries(c.grants ?? {})]) grants[role] = [...new Set([...(grants[role] ?? []), ...keys])].sort();
  return { routes: [...routes], defaults: mergeDefaults(c, config.defaults ?? {}), grants, ...(tree ? { tree } : {}) };
}

/** DEFAULTS < the host's fill-ins (its network) < the tree's config < explicit overrides (warned when they replace a tree value). */
function mergeDefaults(c: GenesisConfig, tree: Record<string, string>): Record<string, string> {
  for (const [k, v] of Object.entries(c.overrides ?? {})) {
    if (tree[k] !== undefined && tree[k] !== v) c.warn?.(`host override: ${k} = ${v} replaces the system tree's ${k} = ${tree[k]}`);
  }
  return { ...DEFAULTS, ...(c.network ? { walletNetwork: c.network } : {}), ...c.defaults, ...tree, ...c.overrides };
}

/** The genesis record: who the instance is, and its system. */
export function genesisRecord(c: Pick<GenesisConfig, "identity" | "handle" | "domain">, s: System): Record<string, unknown> {
  const grants = Object.fromEntries(Object.entries(s.grants).filter(([, ks]) => ks.length).map(([r, ks]) => [r, ks.map(keyBytes)]));
  return {
    kind: "genesis", identity: keyBytes(c.identity), handle: c.handle, domain: c.domain, routes: s.routes,
    ...(Object.keys(grants).length ? { grants } : {}),
    ...(s.calls && Object.keys(s.calls).length ? { calls: s.calls } : {}), ...(s.services && Object.keys(s.services).length ? { services: s.services } : {}),
    defaults: s.defaults, ...(s.tree ? { tree: s.tree } : {}), ...(s.heads && Object.keys(s.heads).length ? { heads: s.heads } : {}),
  };
}

/** Write a genesis over `s` into an empty store through its kernel; the entry's CID. */
export async function writeSystemGenesis(k: Kernel, c: GenesisConfig, s: System, time: Stamp = clockNow()): Promise<CID> {
  const g = await k.store.put(genesisRecord(c, s) as never);
  return await k.store.log.append(await nextEntry(k.store, { genesis: g }, time) as never);
}

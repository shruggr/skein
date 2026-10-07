// The host's configuration file and the operator's key.
//
// `$SKEIN_HOME/host.env` holds the host's settings: every `SKEIN_*` line
// (`KEY=value`, `export KEY=value`, quotes stripped, `#` comments). The
// environment wins over the file. It configures the commands (`skein-host`,
// `skein`) and, through them, how `skein-host run` builds the host skein the
// first time; once the host skein exists, a change to host.env does not
// reach into it.
//
// The operator's key (`SKEIN_OPERATOR_KEY`, a path, default
// `$SKEIN_HOME/operator.key`): the key that owns the host skein and that the
// client `skein` signs with. A plain file, one line, hex (or WIF), mode
// 0600: if present it is used, if not it is created.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PrivateKey } from "@bsv/sdk";

export type Vars = Record<string, string | undefined>;

/** The host's home: SKEIN_HOME, default ~/.skein. */
export const homeOf = (vars: Vars) => vars.SKEIN_HOME || join(vars.HOME ?? ".", ".skein");

export const HOST_ENV = "host.env";
export const OPERATOR_KEY = "operator.key";

/** The `SKEIN_*` settings of a host.env file (empty when there is none). */
export function readHostEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?(SKEIN_[A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    const q = /^(["'])(.*)\1$/.exec(v);
    if (q) v = q[2]!;
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]!] = v;
  }
  return out;
}

/**
 * The variables the commands see: host.env's `SKEIN_*` settings under the environment's (the environment
 * wins). SKEIN_HOME comes from the environment (it says where host.env is).
 */
export function withHostEnv(vars: Vars): Vars {
  const file = readHostEnv(join(homeOf(vars), HOST_ENV));
  const out: Vars = { ...vars };
  for (const [k, v] of Object.entries(file)) if (out[k] === undefined || out[k] === "") out[k] = v;
  return out;
}

/** Where the operator's key is: SKEIN_OPERATOR_KEY, default $SKEIN_HOME/operator.key. */
export const operatorKeyPath = (vars: Vars) => vars.SKEIN_OPERATOR_KEY || join(homeOf(vars), OPERATOR_KEY);

/** A key file's key: one line, hex (64) or WIF. */
export function parseKey(text: string, where: string): PrivateKey {
  const s = text.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return PrivateKey.fromHex(s.toLowerCase());
  try { return PrivateKey.fromWif(s); } catch { throw new Error(`${where}: not a private key (64 hex digits, or WIF)`); }
}

/**
 * The operator's key: the file at SKEIN_OPERATOR_KEY (default $SKEIN_HOME/operator.key) if present, else,
 * with `create`, a new key written there (hex, mode 0600). `made` says it was created now.
 */
export function operatorKey(vars: Vars, o: { create?: boolean } = {}): { key: PrivateKey; path: string; made: boolean } {
  const path = operatorKeyPath(vars);
  if (existsSync(path)) return { key: parseKey(readFileSync(path, "utf8"), path), path, made: false };
  if (!o.create) throw new Error(`no operator key at ${path} (SKEIN_OPERATOR_KEY): \`skein-host run\` makes it, or put the key there (hex or WIF, mode 0600)`);
  const key = PrivateKey.fromRandom();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${key.toHex()}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { key, path, made: true };
}

/** The identity key (hex) of a private key. */
export const identityOf = (key: PrivateKey): string => key.toPublicKey().toString();

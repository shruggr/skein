// Where things live at run time. Config is src/config.ts's business.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { openStore, type SqliteStore } from "./sqlite.ts";
import { loadConfig } from "./config.ts";
import { connectWallet, type WalletInterface } from "./wallet.ts";

export const DEFAULT_PORT = 4322;

/** Skein's own directory: the db, the execution service's work dirs, the dev wallet key. */
export const skeinHome = () => process.env.SKEIN_HOME || join(homedir(), ".skein");

export const dbPath = () => process.env.SKEIN_DB || join(skeinHome(), "skein.db");

export function openDefaultStore(path = dbPath()): SqliteStore {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  return openStore(path);
}

export function portFrom(flag?: string): number {
  const p = Number(flag ?? process.env.SKEIN_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(p) || p < 0 || p > 65535) throw new Error(`bad port: ${flag ?? process.env.SKEIN_PORT}`);
  return p;
}

/** Where bash runs when a command names no tree (in place, as v1 did). */
export const workDir = () => process.env.SKEIN_CWD || homedir();

/** The wallet config.json names, else the dev key file (shared by the daemon and the CLI). */
export function openWallet(): Promise<WalletInterface> {
  return connectWallet(loadConfig().wallet ?? { kind: "dev", keyFile: join(skeinHome(), "dev-wallet.key") });
}

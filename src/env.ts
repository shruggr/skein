// Where things live at run time. Config is src/config.ts's business.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { openStore, type SqliteStore } from "./sqlite.ts";

export const DEFAULT_PORT = 4322;

export const dbPath = () => process.env.SKEIN_DB || join(homedir(), ".skein", "skein.db");

export function openDefaultStore(path = dbPath()): SqliteStore {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  return openStore(path);
}

export function portFrom(flag?: string): number {
  const p = Number(flag ?? process.env.SKEIN_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(p) || p < 0 || p > 65535) throw new Error(`bad port: ${flag ?? process.env.SKEIN_PORT}`);
  return p;
}

/** Where bash runs for threads the daemon starts. */
export const workDir = () => process.env.SKEIN_CWD || homedir();

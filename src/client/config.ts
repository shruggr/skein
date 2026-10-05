// Where the client finds things on David's machine. Everything is a file under
// ~/.skein (or $SKEIN_HOME) written by scripts/host/*.sh; env vars override.
// No key is ever read here: the client signs through the owner's wallet-api.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ClientConfig {
  home: string;
  /** Owner (David) wallet-api: `1sat serve wallet-api` on its own port. */
  walletUrl: string;
  originator: string;
  /** The instance's own URL (its front door): http://<handle>.localhost:8100 or http://127.0.0.1:8100/@<handle>. */
  instanceUrl: string;
  /** David's mailbox: the mailbox instance his instances deliver to (#40). */
  mailboxUrl: string;
  instance: { identityKey: string; handle: string; domain: string };
  /** Local client state: sent envelope cids. */
  stateDir: string;
}

function read(file: string): string | undefined {
  try { return readFileSync(file, "utf8").trim() || undefined; } catch { return undefined; }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ClientConfig {
  const home = env.SKEIN_HOME ?? join(homedir(), ".skein");
  const identityKey = env.SKEIN_INSTANCE_IDENTITY ?? read(join(home, "instance.identity"));
  if (!identityKey) throw new Error(`no instance identity: write \`skein-host identity <handle>\` to ${join(home, "instance.identity")}, or set SKEIN_INSTANCE_IDENTITY`);
  const [handle, domain] = (env.SKEIN_INSTANCE_HANDLE ?? "skein@localhost").split("@");
  const host = (env.SKEIN_HOST_URL ?? "http://127.0.0.1:8100").replace(/\/+$/, "");
  return {
    home,
    walletUrl: env.SKEIN_OWNER_WALLET ?? "http://127.0.0.1:3322",
    originator: env.SKEIN_ORIGINATOR ?? "skein-client",
    instanceUrl: env.SKEIN_INSTANCE_URL ?? `${host}/@${handle}`,
    mailboxUrl: env.SKEIN_MAILBOX_URL ?? read(join(home, "mailbox.url")) ?? `${host}/@${env.SKEIN_MAILBOX_HANDLE ?? "david"}`,
    instance: { identityKey, handle: handle!, domain: domain ?? "localhost" },
    stateDir: join(home, "client"),
  };
}

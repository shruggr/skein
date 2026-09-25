// The admin/client stand-in: signs messages as `admin` (or `david`) and sends
// them to the runtime over its socket, like any peer. A real client signs with
// David's own wallet; these identities are derived from the runtime's wallet
// because that is what this machine has.

import type { CID } from "multiformats/cid";
import type { Message } from "../runtime/records.ts";
import { connectPeer, socketPath, type Connection } from "../peers/connection.ts";
import { signerFor, type KeyWallet } from "../wallet.ts";

export type As = "admin" | "david";

export async function connectAs(wallet: KeyWallet, as: As = "admin", path = socketPath()): Promise<Connection> {
  return connectPeer(await signerFor(wallet, as), path);
}

export interface RunResult { message: Message; entry: CID; result: Message }

/**
 * Send `{ kind: "run", cmd, tree, cwd? }` (the default subscriptions route it
 * to the shell program) and wait for the runtime's `result` message that
 * replies to it.
 */
export async function run(conn: Connection, o: { cmd: string; tree: CID; cwd?: string; env?: Record<string, string> }): Promise<RunResult> {
  let sent: CID | undefined;
  const early: Message[] = [];
  let hit: ((m: Message) => void) | undefined;
  conn.onMessage((m) => {
    const b = m.body as { kind?: unknown } | null;
    if (b?.kind !== "result") return;
    if (!sent) { early.push(m); return; }
    if (m.refs.some((r) => r.rel === "replies-to" && String(r.to) === String(sent))) hit?.(m);
  });
  const got = new Promise<Message>((resolve) => { hit = resolve; });
  const { message, cid, entry } = await conn.send({ kind: "run", cmd: o.cmd, tree: o.tree, cwd: o.cwd, env: o.env });
  sent = cid;
  for (const m of early) if (m.refs.some((r) => r.rel === "replies-to" && String(r.to) === String(cid))) hit?.(m);
  return { message, entry, result: await got };
}

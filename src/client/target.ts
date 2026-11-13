// Where the operator's requests go (skein next, SPEC.md section 2). Signing is the client's own
// (raw.ts signRequest, the `signed` scheme, with the operator's key: hostenv.ts operatorKey); the
// request is handed to the running host on this machine over its control socket
// ($SKEIN_HOME/host.sock, op `message`: Router.messageLocal — CHECK then COMMIT, the answer back):
//
//   --instance <handle>   an instance on this host machine: its row in $SKEIN_HOME/host.db, its store
//                         read read-only (the plan's view)
//
// (An instance elsewhere takes the same signed requests over HTTP at its origin, or a BRC-104 session;
// the client's remote target read the instance through the explorer, which is not rebuilt in this cut.)

import { existsSync } from "node:fs";
import { join } from "node:path";
import * as dagCbor from "@ipld/dag-cbor";
import type { WalletInterface } from "@bsv/sdk";
import { storeSpec, type IndexStore } from "../runtime/index-store.ts";
import { openStoreFile, storeExists } from "../host/stores.ts";
import { CONTROL_SOCKET, controlRequest } from "../host/control.ts";
import { homeOf, type Vars } from "../host/hostenv.ts";
import { HostDb } from "../host/instances.ts";
import { instanceView } from "../host/install.ts";
import type { InstanceView } from "../host/plan.ts";
import { requestPayload, signRequest } from "./raw.ts";

/** A request's answer as the host returned it: its entry, and the handler's (or the kernel operation's) answer. */
export interface Sent { entry: string; status: number; body: Uint8Array }

export interface Target {
  /** Where the requests go, for the operator's eyes. */
  where: string;
  /** The instance's identity key (hex). */
  identity: string;
  /** A fresh view of the instance (plan.ts InstanceView). */
  view(): Promise<InstanceView>;
  /** One request from the operator: `path`, `body` a record value (dag-cbor). Throws on a refusal. */
  send(path: string, body: unknown): Promise<Sent>;
  close(): Promise<void>;
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

/** An instance on this host machine (`--instance <handle>`): host.db's row, its store read-only, the control socket. */
export function localTarget(vars: Vars, handle: string, wallet: WalletInterface): Target {
  const home = homeOf(vars);
  const dbPath = join(home, "host.db");
  if (!existsSync(dbPath)) throw new Error(`--instance ${handle}: no host here (${dbPath}; SKEIN_HOME)`);
  const db = new HostDb(dbPath, { readOnly: true });
  const row = db.get(handle);
  db.close();
  if (!row) throw new Error(`--instance ${handle}: no such instance on this host`);
  if (!row.identity) throw new Error(`--instance ${handle}: it has no identity yet (never booted)`);
  const sock = join(home, CONTROL_SOCKET);
  const opened: Array<{ close(): void }> = [];
  const open = (): IndexStore => {
    if (!storeExists(storeSpec(row))) throw new Error(`${handle}: no store at ${storeSpec(row)} yet`);
    const s = openStoreFile(storeSpec(row), { readOnly: true }) as unknown as IndexStore & { close(): void };
    opened.push(s);
    return s;
  };
  return {
    where: `${handle} (this host)`,
    identity: row.identity,
    view: async () => await instanceView(open()),
    send: async (path, body) => {
      const r = await signRequest(wallet, { recipient: row.identity!, payload: requestPayload("POST", path, body) });
      const a = await controlRequest(sock, { op: "message", handle, request: b64(dagCbor.encode(r)) }, 600_000);
      if (!a) throw new Error(`no host answers on ${sock}: start it (skein-host run)`);
      if (!a.ok) throw new Error(a.error);
      return { entry: a.entry, status: a.status, body: Buffer.from(a.body, "base64") };
    },
    close: async () => { for (const s of opened.splice(0)) s.close(); },
  };
}

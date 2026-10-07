// Where the operator's messages go (#142). Signing is the client's own
// (raw.ts signMessage, with the operator's key: hostenv.ts operatorKey);
// delivery is only a question of which host the message is going to:
//
//   --instance <handle>   an instance on this host machine: its row in
//                         $SKEIN_HOME/host.db, its store read read-only (the
//                         plan's view, a thread's answer), each message signed
//                         here and handed to the running host over its control
//                         socket ($SKEIN_HOME/host.sock, op `message`: appended
//                         as a signed `local` request, the path a forwarded
//                         claim takes)
//   <origin>              an instance anywhere: one BRC-104 session (@bsv/sdk's
//                         Peer/AuthFetch, raw.ts RawBox) carries the messages
//                         (dag-cbor bodies) and the explorer's reads
//
// No other process is started: no wallet command, no handshake per message.

import { existsSync } from "node:fs";
import { join } from "node:path";
import * as dagCbor from "@ipld/dag-cbor";
import * as dagJson from "@ipld/dag-json";
import type { CID } from "multiformats/cid";
import type { WalletInterface } from "@bsv/sdk";
import { encode } from "../runtime/cid.ts";
import { openStoreFile } from "../runtime/index-store.ts";
import type { IndexStore } from "../runtime/index-store.ts";
import { CONTROL_SOCKET, controlRequest } from "../host/control.ts";
import { homeOf, type Vars } from "../host/hostenv.ts";
import { HostDb } from "../host/instances.ts";
import { instanceView } from "../host/install.ts";
import type { InstanceView } from "../host/plan.ts";
import { explorerView, type ExplorerRead } from "./admin.ts";
import { RawBox, signMessage } from "./raw.ts";

/** A thread at rest: its last update. */
export interface ThreadEnd { state: string; result?: { stdout?: Uint8Array; [k: string]: unknown }; error?: unknown }

export interface Target {
  /** Where the messages go, for the operator's eyes. */
  where: string;
  /** The instance's identity key (hex). */
  identity: string;
  /** A fresh view of the instance (plan.ts InstanceView). */
  view(): Promise<InstanceView>;
  /** One message from the operator into `box`, `body` a record value: its id (the message record's CID). */
  send(box: string, body: unknown): Promise<CID>;
  /** The claim (#127): the operator's message in box `claim` (on the host: naming no recipient, as a forwarded claim). */
  claim(body: Record<string, unknown>): Promise<CID>;
  /** The thread the message `id` launched, once it comes to rest. */
  answer(id: CID, timeoutMs?: number): Promise<ThreadEnd>;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

/** Poll `look` (500 ms, doubling to 5 s) until it answers, or fail past `timeoutMs`. */
async function until<T>(what: string, look: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (let wait = 250; ; wait = Math.min(wait * 2, 5000)) {
    const v = await look();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`${what}: no answer in ${Math.round(timeoutMs / 1000)} s`);
    await sleep(wait);
  }
}

const atRest = (u: ThreadEnd | undefined) => !!u && (u.state === "finished" || u.state === "errored");

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
  const openOnce = (): IndexStore & { close(): void } => {
    if (!existsSync(row.store)) throw new Error(`${handle}: no store at ${row.store} yet`);
    return openStoreFile(row.store, { readOnly: true }) as unknown as IndexStore & { close(): void };
  };
  // A view's store stays open while the view is used (until close).
  const open = (): IndexStore => { const s = openOnce(); opened.push(s); return s; };
  const deliver = async (m: { message: Record<string, unknown>; body: Uint8Array }): Promise<CID> => {
    const a = await controlRequest(sock, { op: "message", handle, message: b64(dagCbor.encode(m.message)), body: b64(m.body) }, 600_000);
    if (!a) throw new Error(`no host answers on ${sock}: start it (skein-host run)`);
    if (!a.ok) throw new Error(a.error);
    return encode(m.message as never).cid;
  };
  return {
    where: `${handle} (this host)`,
    identity: row.identity,
    view: async () => await instanceView(open()),
    send: async (box, body) => await deliver(await signMessage(wallet, { recipient: row.identity!, box, body: dagCbor.encode(body) })),
    claim: async (body) => await deliver(await signMessage(wallet, { box: "claim", body: dagCbor.encode(body) })),
    answer: (id, timeoutMs = 300_000) => until(`the thread of ${id}`, async () => {
      const s = openOnce();
      try {
        for (const e of await s.edges.refsTo(id)) {
          if (e.rel !== "launched-by" || !e.from) continue;
          const u = await s.get(await s.chains.tip(e.from)).catch(() => undefined) as unknown as ThreadEnd | undefined;
          if (atRest(u)) return u;
        }
        return undefined;
      } finally { s.close(); }
    }, timeoutMs),
    close: async () => { for (const s of opened.splice(0)) s.close(); },
  };
}

/** An instance at `origin`: one BRC-104 session for its messages and its explorer's reads (the operator's, as its owner). */
export async function remoteTarget(origin: string, wallet: WalletInterface): Promise<Target> {
  const url = origin.replace(/\/+$/, "");
  const box = new RawBox(wallet, url);
  const get = async (path: string) => {
    await box.ready();
    return await box.af.fetch(`${url}${path}`, { method: "GET" });
  };
  const read: ExplorerRead = async (path) => {
    const r = await get(`/explore${path}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (r.status === 404) return undefined;
    if (r.status !== 200) throw new Error(`GET ${url}/explore${path}: ${r.status} ${new TextDecoder().decode(bytes).slice(0, 200)}${r.status === 403 ? " (the explorer is the owner's: is the operator's key this instance's owner?)" : ""}`);
    return dagJson.decode(bytes);
  };
  // Who answers: the session's peer (the instance's identity), learnt on the first signed request.
  const first = await get("/explore");
  await first.arrayBuffer();
  const identity = box.peerIdentity() ?? first.headers.get("x-bsv-auth-identity-key") ?? "";
  if (!/^0[23][0-9a-f]{64}$/.test(identity)) throw new Error(`${url}: no BRC-104 identity answered (is it a skein's origin?)`);
  return {
    where: url,
    identity,
    view: async () => await explorerView(read),
    send: async (b, body) => (await box.send(identity, b, body)).id,
    claim: async (body) => (await box.send(identity, "claim", body)).id,
    answer: (id, timeoutMs = 300_000) => until(`the thread of ${id}`, async () => {
      const e = await read(`/edges/${id}?rel=launched-by`) as { edges?: Array<{ from: CID | string }> } | undefined;
      for (const edge of e?.edges ?? []) {
        const t = await read(`/thread/${edge.from}`) as { updates?: Array<{ record?: ThreadEnd }> } | undefined;
        const last = t?.updates?.at(-1)?.record;
        if (atRest(last)) return last;
      }
      return undefined;
    }, timeoutMs),
    close: async () => {},
  };
}

/** A step's answer as the program wrote it to stdout (dag-cbor, else DAG-JSON). */
export function stdoutOf(u: ThreadEnd): Record<string, unknown> | undefined {
  const b = u.result?.stdout;
  if (!(b instanceof Uint8Array) || !b.length) return undefined;
  try { return dagCbor.decode(b) as Record<string, unknown>; } catch { /* not dag-cbor */ }
  try { return dagJson.decode(b) as Record<string, unknown>; } catch { return undefined; }
}

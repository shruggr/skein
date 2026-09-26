// Test helpers shared across directories. Not part of the runtime.

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

import { readFile } from "node:fs/promises";
import { MODULES, loadShellModules } from "./runtime/programs.ts";
import type { Modules } from "./runtime/shell.ts";
import type { Blocks } from "./runtime/store.ts";

const WASM = new URL("../wasm/", import.meta.url);

/** Put the shell's wasm modules into a store, as skein-dev install does. */
export async function installWasm(store: Pick<Blocks, "putBlock">): Promise<void> {
  for (const [name, cid] of Object.entries(MODULES)) await store.putBlock(cid, await readFile(new URL(`${name}.wasm`, WASM)));
}

/** The shell's modules compiled from wasm/, for tests that run the shell without a store. */
export async function wasmModules(): Promise<Modules> {
  const bytes = new Map<string, Uint8Array>();
  for (const [name, cid] of Object.entries(MODULES)) bytes.set(cid.toString(), await readFile(new URL(`${name}.wasm`, WASM)));
  return loadShellModules({ bytes: async (c) => bytes.get(c.toString())! });
}

// ---------------------------------------------------------------- a messagebox and an instance, in process

import { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { open, seal, verify, type Envelope } from "./envelope.ts";
import { Edge, type Listed, type MessageBox } from "./runtime/inbox.ts";
import { ensureGenesis, type InstanceConfig } from "./runtime/log.ts";
import { memoryStore } from "./runtime/memory.ts";
import { Runtime } from "./runtime/scheduler.ts";
import type { Store } from "./runtime/store.ts";
import type { Stamp } from "./runtime/syscalls.ts";
import { ephemeralWallet, type WalletInterface } from "./wallet.ts";
import { chunk } from "./client/bundle.ts";
import { hashDir } from "./client/client.ts";

/** An in-process BRC-33 messagebox: sendMessage / listMessages / acknowledgeMessage, per identity. */
export function messageBoxHub() {
  const boxes = new Map<string, Listed[]>();
  let n = 0;
  const key = (recipient: string, box: string) => `${recipient} ${box}`;
  const deliver = (recipient: string, box: string, m: Omit<Listed, "messageId" | "created_at">) => {
    const q = boxes.get(key(recipient, box)) ?? [];
    n++;
    q.push({ ...m, messageId: `m${n}`, created_at: String(n).padStart(8, "0") });
    boxes.set(key(recipient, box), q);
  };
  return {
    as(identity: string): MessageBox {
      return {
        list: async (box) => [...(boxes.get(key(identity, box)) ?? [])],
        ack: async (ids) => {
          for (const [k, q] of boxes) if (k.startsWith(`${identity} `)) boxes.set(k, q.filter((m) => !ids.includes(m.messageId)));
        },
        send: async ({ recipient, box, body }) => deliver(recipient, box, { sender: identity, body: JSON.stringify(body) }),
      };
    },
    /** Put a message in a box as if `sender` had authenticated (tests of forged senders). */
    inject: deliver,
    pending: (recipient: string, box: string) => [...(boxes.get(key(recipient, box)) ?? [])],
  };
}
export type Hub = ReturnType<typeof messageBoxHub>;

export const T0: Stamp = [1_790_000_000, 250_000_000];
export const iso = (s: Stamp) => new Date(s[0] * 1000 + Math.floor(s[1] / 1e6)).toISOString();

/** A settable clock for admission stamps. */
export function scriptClock(start: Stamp = T0) {
  let now: Stamp = start;
  return { now: () => now, set(s: Stamp) { now = s; } };
}

export interface Instance {
  store: Store;
  rt: Runtime;
  edge: Edge;
  hub: Hub;
  clock: ReturnType<typeof scriptClock>;
  instanceKey: PrivateKey;
  wallet: WalletInterface;
  identity: string;
  /** The host: its wallet signs every log entry; its identity is the genesis's `host`. */
  host: { key: PrivateKey; wallet: WalletInterface; identity: string };
  owner: { key: PrivateKey; wallet: WalletInterface; identity: string };
  lines: string[];
}

/**
 * A memory-store instance with the modules installed, a genesis stamped T0
 * routing `owner`'s run/objects boxes, a runtime and its edge on `hub`.
 * Keys are passed in so a second instance (a restart) can reuse them. The
 * host wallet is ephemeral, like the instance's.
 */
export async function instance(o: {
  hub?: Hub; store?: Store; instanceKey?: PrivateKey; ownerKey?: PrivateKey; hostKey?: PrivateKey; clock?: ReturnType<typeof scriptClock>;
  config?: Partial<InstanceConfig>; start?: boolean; freshnessMs?: number;
} = {}): Promise<Instance> {
  const instanceKey = o.instanceKey ?? PrivateKey.fromRandom();
  const ownerKey = o.ownerKey ?? PrivateKey.fromRandom();
  const hostKey = o.hostKey ?? PrivateKey.fromRandom();
  const wallet = ephemeralWallet(instanceKey);
  const owner = { key: ownerKey, wallet: ephemeralWallet(ownerKey), identity: ownerKey.toPublicKey().toString() };
  const host = { key: hostKey, wallet: ephemeralWallet(hostKey), identity: hostKey.toPublicKey().toString() };
  const hub = o.hub ?? messageBoxHub();
  const clock = o.clock ?? scriptClock();
  let store = o.store;
  if (!store) {
    store = memoryStore();
    await installWasm(store);
    await ensureGenesis(store, wallet, host.wallet, { owner: owner.identity, ...o.config }, T0);
  }
  const lines: string[] = [];
  const rt = new Runtime({ store, wallet, host: host.wallet, now: clock.now, log: (l) => lines.push(l) });
  const edge = new Edge({ runtime: rt, wallet, box: hub.as(instanceKey.toPublicKey().toString()), now: clock.now, freshnessMs: o.freshnessMs, log: (l) => lines.push(l) });
  rt.outbox = edge;
  if (o.start !== false) await rt.start();
  return { store, rt, edge, hub, clock, instanceKey, wallet, identity: instanceKey.toPublicKey().toString(), host, owner, lines };
}

/** The owner's client: seal `body` (dag-cbor of a value, or bytes) to the instance and deliver it into `box`. */
export async function send(i: Instance, box: string, body: unknown, created = iso(i.clock.now())): Promise<Envelope> {
  const bytes = body instanceof Uint8Array ? body : dagCbor.encode(body);
  const env = await seal(i.owner.wallet, { recipient: { identityKey: i.identity, handle: "skein", domain: "localhost" }, body: bytes, created });
  await i.hub.as(i.owner.identity).send({ recipient: i.identity, box, body: env });
  return env;
}

/** A directory as the client sends it: {root, bundles of ≤ 1 MiB, the last naming the root}. */
export async function bundlesOf(dir: string, limit?: number): Promise<{ root: CID; bundles: Uint8Array[]; records: number }> {
  const { root, records } = await hashDir(dir);
  // Blobs, then trees, the root tree last (as the client sends them).
  const rank = (r: { cid: CID; bytes: Uint8Array }) => (r.cid.equals(root) ? 2 : Buffer.from(r.bytes.subarray(0, 5)).toString() === "tree " ? 1 : 0);
  records.sort((a, b) => rank(a) - rank(b));
  return { root, bundles: [...chunk(records, limit, root)], records: records.length };
}

/** The owner reads its `results` box: verified, opened, decoded. */
export async function results(i: Instance): Promise<Array<{ env: Envelope; body: Record<string, unknown> }>> {
  const out: Array<{ env: Envelope; body: Record<string, unknown> }> = [];
  for (const m of i.hub.pending(i.owner.identity, "results")) {
    const env = JSON.parse(m.body as string) as Envelope;
    if (!verify(env)) throw new Error("result envelope does not verify");
    out.push({ env, body: dagCbor.decode((await open(i.owner.wallet, env)).body) as Record<string, unknown> });
  }
  return out;
}

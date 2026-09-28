// Test helpers shared across directories. Not part of the runtime.

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

import { readFile } from "node:fs/promises";
import { FILES, MODULES, loadShellModules } from "./runtime/programs.ts";
import type { Modules } from "./runtime/shell.ts";
import type { Blocks } from "./runtime/store.ts";

const WASM = new URL("../wasm/", import.meta.url);

/** Put the shell's wasm modules into a store, as skein-dev install does. */
export async function installWasm(store: Pick<Blocks, "putBlock">): Promise<void> {
  for (const [name, cid] of Object.entries(MODULES)) await store.putBlock(cid, await readFile(new URL(`${name}.wasm`, WASM)));
  for (const [name, cid] of Object.entries(FILES)) await store.putBlock(cid, await readFile(new URL(name, WASM)));
}

/** The shell's modules compiled from wasm/, for tests that run the shell without a store. */
export async function wasmModules(): Promise<Modules> {
  const bytes = new Map<string, Uint8Array>();
  for (const [name, cid] of Object.entries(MODULES)) bytes.set(cid.toString(), await readFile(new URL(`${name}.wasm`, WASM)));
  for (const [name, cid] of Object.entries(FILES)) bytes.set(cid.toString(), await readFile(new URL(name, WASM)));
  return loadShellModules({ bytes: async (c) => bytes.get(c.toString())! });
}

// ---------------------------------------------------------------- a messagebox and an instance, in process

import { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { open, seal, verify, type Envelope } from "./envelope.ts";
import { ensureGenesis } from "./host/entry.ts";
import { Delivery, type Listed, type MessageBox } from "./host/messagebox.ts";
import { Tick } from "./host/tick.ts";
import type { InstanceConfig } from "./runtime/log.ts";
import { memoryStore } from "./runtime/memory.ts";
import { Runtime } from "./runtime/scheduler.ts";
import type { Store } from "./runtime/store.ts";
import type { Stamp } from "./runtime/syscalls.ts";
import { ephemeralWallet, type WalletInterface } from "./wallet.ts";
import { dirBundles } from "./client/client.ts";

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

/**
 * The hub, but a send for which `fail` returns an error throws it instead of
 * delivering (a messagebox refusing, or down). `sent` counts every send tried,
 * by recipient.
 */
export function faultyHub(hub: Hub, fail: (m: { sender: string; recipient: string; box: string }) => Error | undefined) {
  const sent = new Map<string, number>();
  return {
    ...hub,
    sent,
    as(identity: string): MessageBox {
      const b = hub.as(identity);
      return {
        ...b,
        send: async (m) => {
          sent.set(m.recipient, (sent.get(m.recipient) ?? 0) + 1);
          const e = fail({ sender: identity, recipient: m.recipient, box: m.box });
          if (e) throw e;
          return b.send(m);
        },
      };
    },
  };
}

/** @bsv/message-box-client's refusal for a recipient with no account on the messagebox. */
export const noAccount = () => new Error("Message Box send failed with HTTP 403 (ERR_ACCOUNT_REQUIRED).");

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
  /** The message provider: the in-process hub, polled by hand. */
  delivery: Delivery;
  /** The tick provider: fired by hand (no timers). */
  tick: Tick;
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
 * routing `owner`'s run/objects boxes, a runtime, and its providers: message
 * delivery on `hub` and the tick, both on the script clock, both signing with
 * the host wallet. Keys are passed in so a second instance (a restart) can
 * reuse them. The host wallet is ephemeral, like the instance's.
 */
export async function instance(o: {
  hub?: Hub; store?: Store; instanceKey?: PrivateKey; ownerKey?: PrivateKey; hostKey?: PrivateKey; clock?: ReturnType<typeof scriptClock>;
  config?: Partial<InstanceConfig>; start?: boolean;
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
  const rt = new Runtime({ store, wallet, log: (l) => lines.push(l) });
  const delivery = new Delivery({ runtime: rt, wallet, host: host.wallet, box: hub.as(instanceKey.toPublicKey().toString()), now: clock.now, log: (l) => lines.push(l) });
  const tick = new Tick({ runtime: rt, host: host.wallet, now: clock.now, log: (l) => lines.push(l) });
  rt.outbox = delivery;
  if (o.start !== false) await rt.start();
  return { store, rt, delivery, tick, hub, clock, instanceKey, wallet, identity: instanceKey.toPublicKey().toString(), host, owner, lines };
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
  return dirBundles(dir, { limit });
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

// ---------------------------------------------------------------- a BRC-169 domain host, on 127.0.0.1

import { createServer } from "node:http";

/** BRC-169 Appendix A: lkup.net's certifier key, deggen's identity key and handle certificate (A.3), which verify. */
export const LKUP = {
  certifier: "0371f0ec5992a9d38e09fe528e367890969c66eaebdb01b4d35a2fc0d61251b3f9",
  deggen: "0359c5f3bfe249f6c0ca99d0e9cc1517da51a511f3d04f18e47a5d7ae55f04008c",
  certificate: {
    type: "XgCFdUfxEcI+3xtDjsIuSAjMl5EwzCUjsQc45ds1lC8=",
    serialNumber: "JMNxKTvlkhOO88EJZRgnpTKL78dC1XwxQ9REUysjy08=",
    subject: "0359c5f3bfe249f6c0ca99d0e9cc1517da51a511f3d04f18e47a5d7ae55f04008c",
    certifier: "0371f0ec5992a9d38e09fe528e367890969c66eaebdb01b4d35a2fc0d61251b3f9",
    revocationOutpoint: { txid: "2b09f724127b5213ead87842deade00ef6cb1a834c951d1612e162f5891fb3cb", vout: 0 },
    fields: { domain: "bGt1cC5uZXQ=", handle: "ZGVnZ2Vu" },
    signature: "30450221008becb25058954be7cf6f8c46d3a0411a85a9aed55ef90466651fc75374e2bdcf02205a232796a1c2dd0bd7096428a5e6fb766eee404f441a93a261986486ba3b553c",
  },
};

/** A.4: the resolution response for deggen@lkup.net. */
export const deggenResolution = (): Record<string, unknown> => ({
  metanetHandles: "1.0", handle: "deggen", domain: "lkup.net", identityKey: LKUP.deggen,
  certificate: LKUP.certificate, messagebox: "https://messagebox.lkup.net", ttl: 3600, revoked: false,
});

/**
 * A domain's host: `/manifest.json` with `metanet.trust.publicKey` = `certifier`
 * and, unless `handles` is false, `metanet.handles` naming its resolve
 * endpoint, which answers `answers[handle]` (404 handle-not-found otherwise).
 * `asked` lists every path requested.
 */
export async function brc169Host(o: { certifier?: string; handles?: boolean; answers: Record<string, Record<string, unknown>> }): Promise<{ origin: string; asked: string[]; close(): Promise<void> }> {
  const asked: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    asked.push(`${url.pathname}${url.search}`);
    const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/manifest.json") {
      return json(200, { name: "test", metanet: {
        trust: { name: "test", publicKey: o.certifier ?? LKUP.certifier },
        ...(o.handles === false ? {} : { handles: { version: "1.0", resolve: `http://127.0.0.1:${(server.address() as { port: number }).port}/resolve` } }),
      } });
    }
    if (url.pathname === "/resolve") {
      const a = o.answers[url.searchParams.get("handle") ?? ""];
      return a ? json(200, a) : json(404, { metanetHandles: "1.0", error: { code: "handle-not-found", message: "no such handle" } });
    }
    json(404, { error: "not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { origin: `http://127.0.0.1:${port}`, asked, close: () => new Promise((r) => server.close(() => r())) };
}

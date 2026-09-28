// The Zig kernel's peers: what src/host/main.ts wires around the TS runtime —
// the host wallet (signs every log entry), the instance wallet, the messagebox
// delivery and its outcomes, the tick, the host's resolver — unchanged
// (src/host), run in one process that `skein-kernel serve` starts. They reach
// the kernel through `RemoteRuntime`, the surface they use on the TS Runtime
// (admit, boxes, sleepersDue/onSleep, idle, outbox, store.log), carried as
// length-prefixed dag-cbor frames on stdin/stdout. The kernel asks this
// process for the instance wallet's answers to programs' wire frames and for
// handle resolutions. Everything else this process says goes to the kernel,
// which prints it: stdout here is the pipe.

import { existsSync } from "node:fs";
import { WalletWireProcessor, type WalletInterface } from "@bsv/sdk";
import type { CID } from "multiformats/cid";
import { decode, encode } from "../../src/runtime/cid.ts";
import { rootIdentity } from "../../src/runtime/identity.ts";
import { DEFAULTS, short, type LogEntry } from "../../src/runtime/log.ts";
import type { Genesis } from "../../src/runtime/records.ts";
import type { Outbound, Runtime } from "../../src/runtime/scheduler.ts";
import { NotFound, Rejected, type Store } from "../../src/runtime/store.ts";
import type { Ms } from "../../src/runtime/types.ts";
import { ensureGenesis } from "../../src/host/entry.ts";
import { configFor, hostResolver } from "../../src/host/host.ts";
import { HostDb } from "../../src/host/instances.ts";
import { Delivery, messageBoxClient, type MessageBox } from "../../src/host/messagebox.ts";
import { Tick } from "../../src/host/tick.ts";
import { connectWallet, ephemeralWallet } from "../../src/wallet.ts";

// ---------------------------------------------------------------- frames

type Frame = Record<string, unknown>;
let nextId = 1;
const waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
const out = process.stdout;

function write(v: Frame): void {
  const body = encode(v).bytes;
  const h = Buffer.alloc(4);
  h.writeUInt32BE(body.length);
  out.write(Buffer.concat([h, body]));
}

function call(op: string, v?: unknown): Promise<unknown> {
  const id = nextId++;
  write({ id, op, v });
  return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
}

const say = (line: string) => write({ op: "say", v: line });

let buf = Buffer.alloc(0);
process.stdin.on("data", (d: Buffer) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4) {
    const n = buf.readUInt32BE(0);
    if (buf.length < 4 + n) break;
    const f = decode<Frame>(buf.subarray(4, 4 + n));
    buf = buf.subarray(4 + n);
    void onFrame(f);
  }
});
process.stdin.on("end", () => process.exit(0)); // the kernel is gone

async function onFrame(f: Frame): Promise<void> {
  if (typeof f.re === "number") {
    const w = waiting.get(f.re);
    if (!w) return;
    waiting.delete(f.re);
    if (typeof f.rejected === "string") w.reject(new Rejected(f.rejected as Rejected["reason"], String(f.error)));
    else if (typeof f.error === "string") w.reject(new Error(f.error));
    else w.resolve(f.ok);
    return;
  }
  const answer = (ok: unknown) => write({ re: f.id, ok });
  const fail = (e: unknown) => write({ re: f.id, error: (e as Error).message ?? String(e) });
  try {
    switch (f.op) {
      case "wallet": return answer(Uint8Array.from(await wire!.transmitToWallet([...(f.v as Uint8Array)])));
      case "resolve": {
        const { handle, domain } = f.v as { handle: string; domain: string };
        let r: Record<string, unknown>;
        try { r = await resolve(handle, domain); } catch (e) { r = { identityKey: "", error: (e as Error).message }; }
        return answer(decode(encode(r).bytes)); // dag-cbor as the TS runtime records it (undefined dropped)
      }
      case "send": await runtime.outbox?.send(f.v as Outbound); return;
      case "sleepers": runtime.sleepers = f.v as Array<{ thread: CID; until: Ms }>; return;
      case "onSleep": runtime.onSleep?.(undefined as never, 0); return;
      case "stop": await stop(); return;
    }
  } catch (e) {
    if (f.id !== undefined) fail(e);
    else say(`peer: ${f.op}: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------- the runtime, remote

/** The store surface the providers use (entry.ts nextEntry/ensureGenesis, messagebox.ts). */
const store = {
  async get(cid: CID) { const v = await call("get", cid); if (v === null || v === undefined) throw new NotFound(cid.toString()); return v; },
  async put(value: unknown) { return await call("put", value) as CID; },
  log: {
    async tip() { return (await call("tip") as CID | null) ?? undefined; },
    async byEnvelope(envelope: CID) { return (await call("byEnvelope", envelope) as CID | null) ?? undefined; },
    async append(entry: LogEntry) { return await call("append", entry) as CID; },
  },
} as unknown as Store;

const runtime = {
  store,
  outbox: undefined as { send(o: Outbound): void | Promise<void> } | undefined,
  onSleep: undefined as ((thread: CID, until: Ms) => void) | undefined,
  sleepers: [] as Array<{ thread: CID; until: Ms }>,
  sleepersDue() { return this.sleepers; },
  async boxes() { return await call("boxes") as string[]; },
  async admit(entry: LogEntry, records: { envelope?: object; body?: Uint8Array } = {}) { return await call("admit", { entry, envelope: records.envelope, body: records.body }) as CID; },
  async idle() { await call("idle"); },
  async start() { await call("start"); },
  async tip() { return this.store.log.tip(); },
};

// ---------------------------------------------------------------- main.ts, as a peer

const env = process.env;
const home = env.SKEIN_HOME || `${env.HOME}/.skein`;
const ephemeral = env.SKEIN_WALLET === "ephemeral";
const named = (s: string) => { const [handle, domain = "localhost"] = s.split("@"); return { handle, domain }; };
const { handle, domain } = named(env.SKEIN_HANDLE || "skein@localhost");
const hostDbPath = env.SKEIN_HOST_DB || `${home}/host.db`;
const hostDb = existsSync(hostDbPath) ? new HostDb(hostDbPath, { readOnly: true }) : undefined;
const resolve = hostResolver((h, d) => hostDb?.identityOf(h, d), env.SKEIN_MESSAGEBOX);
const originator = env.SKEIN_WALLET_ORIGINATOR || "skein";
let wire: WalletWireProcessor | undefined;
let tick: Tick | undefined;
let delivery: Delivery | undefined;
let onStop: (() => void) | undefined;

async function stop(): Promise<void> {
  await tick?.stop();
  await delivery?.stop();
  hostDb?.close();
  onStop?.();
  process.exit(0);
}

/** What a test drives the peer with instead of the environment's wallets and messagebox. */
export interface PeerOptions {
  host?: WalletInterface;
  wallet?: WalletInterface;
  box?: (wallet: WalletInterface) => MessageBox;
  pollMs?: number;
  /** Called once the kernel is running, with the instance's identity. */
  running?: (identity: string) => void | Promise<void>;
  stopped?: () => void;
}

/** main.ts's startInstance, with the kernel behind RemoteRuntime. */
export async function runPeer(o: PeerOptions = {}): Promise<void> {
 onStop = o.stopped;
 try {
  const host = o.host ?? (ephemeral ? ephemeralWallet() : await connectWallet({ kind: "remote", url: env.SKEIN_HOST_WALLET_URL || "http://127.0.0.1:3324", originator: "skein-host" }));
  const wallet: WalletInterface = o.wallet ?? (ephemeral ? ephemeralWallet() : await connectWallet({ kind: "remote", url: env.SKEIN_WALLET_URL || "http://127.0.0.1:3321", originator }));
  wire = new WalletWireProcessor(wallet);
  const identity = await rootIdentity(wallet);
  const recorded = env.SKEIN_IDENTITY || null;
  if (recorded && recorded !== identity) throw new Error(`wallet ${env.SKEIN_WALLET_URL} is ${short(identity)}, not the recorded identity ${short(recorded)}`);
  if (!(await store.log.tip())) {
    const owner = env.SKEIN_OWNER;
    if (!owner) throw new Error("an empty store needs the owner's identity key (SKEIN_OWNER) for its genesis");
    const config = configFor({ handle, domain }, {
      owner, infer: env.SKEIN_INFER, ownerHandle: named(env.SKEIN_OWNER_HANDLE || "david@localhost"), inferHandle: named(env.SKEIN_INFER_HANDLE || "infer@localhost"),
    });
    // The one limit on a step's fuel (issue #5), for a new genesis only; default DEFAULTS.fuelPerStep.
    if (env.SKEIN_FUEL_PER_STEP) config.defaults = { ...DEFAULTS, fuelPerStep: env.SKEIN_FUEL_PER_STEP };
    const g = await ensureGenesis(store, wallet, host, config);
    say(`genesis ${g.entry}`);
  }
  const g = await call("genesis") as Genesis;
  const hostKey = await rootIdentity(host);
  if (g.host !== hostKey) throw new Error(`the host wallet (${short(hostKey)}) is not this instance's host (${short(g.host)}): its entries would not verify`);
  if (g.identity !== identity) throw new Error(`the wallet (${short(identity)}) is not this instance's identity (${short(g.identity)})`);

  tick = new Tick({ runtime: runtime as unknown as Runtime, host, log: say });
  tick.start();
  if (o.box || env.SKEIN_MESSAGEBOX) {
    delivery = new Delivery({
      runtime: runtime as unknown as Runtime, wallet, host, box: o.box ? o.box(wallet) : messageBoxClient(wallet, env.SKEIN_MESSAGEBOX!, originator), log: say,
      retry: {
        ...(env.SKEIN_SEND_ATTEMPTS ? { attempts: Number(env.SKEIN_SEND_ATTEMPTS) } : {}),
        ...(env.SKEIN_SEND_BACKOFF_MS ? { backoffMs: Number(env.SKEIN_SEND_BACKOFF_MS) } : {}),
      },
    });
    runtime.outbox = delivery;
  } else {
    say("no messagebox (SKEIN_MESSAGEBOX): nothing will be delivered");
  }
  await runtime.start();
  const poll = o.pollMs ?? Number(env.SKEIN_POLL_MS || 1000);
  if (delivery && poll > 0) delivery.start(poll);
  say(`${g.identity} (${g.handle}@${g.domain}) · owner ${short(g.owner)}${g.peers?.infer ? ` · infer ${short(g.peers.infer)}` : ""} · boxes ${(await runtime.boxes()).join(",")} · state ${(await runtime.tip())?.toString()}`);
  write({ op: "running", v: identity });
  await o.running?.(identity);
 } catch (e) {
  write({ op: "fatal", v: `${handle}@${domain}: ${(e as Error).message}` });
 }
}

/** For tests: the runtime surface the providers see. */
export const remote = runtime;
export { say };

if (import.meta.main) await runPeer();

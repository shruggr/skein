// A test host: a router over a temporary host.db and SKEIN_HOME, every instance a set of one SQLite
// database (the wasm kernel; `rocks`: a RocksDB database run by the `skein-kernel host` process),
// each instance's key its own (the signer's stand-in). The owner's key signs root's requests (the
// `signed` scheme: src/client/raw.ts signRequest), handed in as the client's are (Router.messageLocal).

import { existsSync, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { requestPayload, signRequest } from "../client/raw.ts";
import { planInstallApp } from "../client/admin.ts";
import { ephemeralWallet } from "../wallet.ts";
import { imageSource, WASM_DIR, wasmDirObjects } from "./boot.ts";
import { HostDb } from "./instances.ts";
import { instanceView, readApp } from "./install.ts";
import { openStoreFile } from "./stores.ts";
import { storeSpec } from "../runtime/index-store.ts";
import { Router } from "./router.ts";
import { Signer } from "./signer.ts";
import type { Answer } from "./kernel.ts";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
/** The default image (images/default): the kernel's operation rows and the claim row. */
export const DEFAULT_IMAGE_DIR = join(ROOT, "images/default");
/** The host's test app (programs/test/next-app: the kernel's test program, kernel-zig/test/call/next.wasm, as an app). */
export const NEXT_APP = join(ROOT, "programs/test/next-app");

/**
 * A system tree for a test (SPEC 8: an instance starts from a tree): the default image's rows with `routes`
 * added after them, `config` as etc/config.json, `apps` as etc/apps.json's install list (directories), and
 * `files` (path → bytes or text). Written under `dir`.
 */
export async function imageTree(dir: string, o: { routes?: unknown[]; config?: Record<string, unknown>; apps?: string[]; appRoutes?: unknown[]; files?: Record<string, Uint8Array | string> } = {}): Promise<string> {
  await fs.mkdir(join(dir, "etc"), { recursive: true });
  const rows = JSON.parse(await fs.readFile(join(DEFAULT_IMAGE_DIR, "etc/routes.json"), "utf8")) as unknown[];
  await fs.writeFile(join(dir, "etc/routes.json"), JSON.stringify([...rows, ...(o.routes ?? [])]));
  await fs.writeFile(join(dir, "etc/config.json"), JSON.stringify(o.config ?? {}));
  if (o.apps || o.appRoutes) await fs.writeFile(join(dir, "etc/apps.json"), JSON.stringify({ install: o.apps ?? [], ...(o.appRoutes ? { routes: o.appRoutes } : {}) }));
  for (const [p, b] of Object.entries(o.files ?? {})) { await fs.mkdir(join(dir, p, ".."), { recursive: true }); await fs.writeFile(join(dir, p), b); }
  return dir;
}

export const until = async <T>(what: string, f: () => Promise<T | undefined> | T | undefined, ms = 30_000): Promise<T> => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    const v = await f();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out: ${what}`);
};

/** A host with instances, each instance's key its own (the signer's stand-in). */
export async function testHost(t: { after(f: () => unknown): void }, o: { idleMs?: number; ownerKey?: PrivateKey; genesis?: Router["o"]["genesis"]; now?: Router["o"]["now"]; arc?: Router["o"]["arc"]; arcRetry?: Router["o"]["arcRetry"]; arcFetch?: Router["o"]["arcFetch"]; teranode?: Router["o"]["teranode"]; headersUrl?: string; rocks?: boolean; sqlite?: boolean; libp2p?: boolean; network?: string; reuse?: { home: string; keyOf(handle: string): PrivateKey } } = {}) {
  // `reuse` — a second host over the first's home and keys (a restart: the first's router stopped first).
  const home = o.reuse?.home ?? await fs.mkdtemp(join(tmpdir(), "skein-router-"));
  const storeOf = () => (o.rocks ? `rocksdb:${join(home, "store-rocksdb")}` : `sqlite:${join(home, "store.sqlite")}`);
  if (!o.reuse) t.after(() => fs.rm(home, { recursive: true, force: true }));
  const db = new HostDb(join(home, "host.db"));
  const keys = new Map<string, PrivateKey>();
  const keyOf = (h: string) => { if (o.reuse) return o.reuse.keyOf(h); let k = keys.get(h); if (!k) { k = PrivateKey.fromRandom(); keys.set(h, k); } return k; };
  const ownerKey = o.ownerKey ?? PrivateKey.fromRandom();
  const owner = ephemeralWallet(ownerKey), ownerId = ownerKey.toPublicKey().toString();
  const lines: string[] = [];
  const providerMaster = PrivateKey.fromRandom();
  const peerKeys = new Map<string, PrivateKey>();
  const router = new Router({
    db, walletFor: (row) => ephemeralWallet(keyOf(row.handle)), home,
    idleMs: o.idleMs ?? 0, genesis: o.genesis, now: o.now, ledgerMs: 60_000, kernel: { env: { SKEIN_HOME: home } },
    ...(o.network ? { network: o.network } : {}),
    ...(o.arc ? { arc: o.arc } : {}), ...(o.arcRetry ? { arcRetry: o.arcRetry } : {}), ...(o.arcFetch ? { arcFetch: o.arcFetch } : {}),
    ...(o.teranode ? { teranode: o.teranode } : {}),
    ...(o.headersUrl ? { headersUrl: o.headersUrl } : {}),
    ...(o.rocks ? { rocksStore: join(home, "store-rocksdb") } : { sqliteStore: join(home, "store.sqlite") }),
    ...(o.libp2p ? { peerKeyFor: (h: string) => { let k = peerKeys.get(h); if (!k) peerKeys.set(h, (k = PrivateKey.fromRandom())); return k; } } : {}),
    providerKeyFor: (name) => new Signer(providerMaster).providerKey(name),
    log: (s, l) => { lines.push(`[${s}] ${l}`); if (process.env.VERBOSE) console.log(`[${s}] ${l}`); },
  });
  t.after(async () => { await router.stop(); db.close(); });
  await router.listen(0);
  const base = `http://127.0.0.1:${router.port}`;
  const h = {
    home, db, router, base, owner, ownerKey, ownerId, lines, keyOf,
    /** An instance's row and its store booted from an image (default: images/default) born owned by the owner (root in its genesis). Its identity (hex). */
    async instance(handle: string, dir = DEFAULT_IMAGE_DIR) {
      db.add(handle, { store: storeOf(), identity: keyOf(handle).toPublicKey().toString() });
      await router.bootRow(handle, await imageSource(dir), { owner: ownerId });
      return keyOf(handle).toPublicKey().toString();
    },
    /** An instance booted from an image (default: images/default) with no owner: its claim row from anyone. */
    async image(handle: string, dir = DEFAULT_IMAGE_DIR) {
      db.add(handle, { store: storeOf(), identity: keyOf(handle).toPublicKey().toString() });
      return await router.bootRow(handle, await imageSource(dir));
    },
    /** A request signed by `key` (default the owner's) to `handle` (the `signed` scheme), handed in (Router.messageLocal): {entry, answer}. */
    async request(handle: string, method: string, path: string, body?: unknown, key: PrivateKey = ownerKey) {
      const id = db.get(handle)?.identity ?? (await router.hydrate(handle)).identity;
      const r = await signRequest(ephemeralWallet(key), { recipient: id, payload: requestPayload(method, path, body) });
      return await router.messageLocal(handle, r);
    },
    /** The app in `dir` installed into `handle` as root (the owner): planned (planInstallApp) over its store, each request signed by the owner and handed in. The plan. */
    async install(handle: string, dir: string, config?: Record<string, unknown>) {
      await router.hydrate(handle);
      const st = openStoreFile(storeSpec(db.get(handle)!), { readOnly: true });
      let plan;
      try { plan = await planInstallApp(await readApp(dir), await instanceView(st as never), { config, modules: wasmDirObjects(WASM_DIR) }); } finally { st.close(); }
      for (const r of plan.requests) await h.request(handle, "POST", r.path, r.body);
      await router.settled();
      return plan;
    },
    origin: (handle: string) => router.originOf(handle),
    storeSize(handle: string) { const p = db.get(handle)!.store; return statSync(p).size + (existsSync(`${p}-wal`) ? statSync(`${p}-wal`).size : 0); },
    async entries(handle: string) { const k = (await router.hydrate(handle)).kernel; return (await k.store.get((await k.store.log.tip())!) as unknown as { n: number }).n + 1; },
  };
  return h;
}

/** An answer's body decoded (dag-cbor, else JSON, else text). */
export function bodyOf(a: Answer | { body: Uint8Array }): unknown {
  try { return dagCbor.decode(a.body); } catch { /* not dag-cbor */ }
  const t = new TextDecoder().decode(a.body);
  try { return JSON.parse(t); } catch { return t; }
}

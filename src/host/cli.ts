#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// `skein-host`: the host's management database (instances.ts, $SKEIN_HOME/host.db)
// and the router (router.ts) that serves every enabled row.
//   skein-host run                    the host: the router, every enabled instance hydrated once
//   skein-host grant <key> --instance <handle> [--role root|<app>.<role>] [--remove]   a grant: the operator's request
//   skein-host add <handle> --image <default | dir> | --boot <dir|tree-cid> [--from store] | --packet <file>  [--domain d] …
//   skein-host add <handle> [--domain d] [--derive] [--identity hex] [--tree cid] [--knows a,b|*] [--disabled]   (an existing row)
//   skein-host knows <handle> [a,b | --all | --none]
//   skein-host list                   handle, status, identity, store, tree, libp2p peer ID
//   skein-host identity <handle> [--peer]   an instance's identity key (from the master secret); --peer: its libp2p peer ID
//   skein-host ledger [handle]        the fuel ledger: what reads and refusals cost
//   skein-host enable|disable|remove <handle>
//   skein-host roster [--for <handle>]
//   skein-host pack <handle|dir|tree-cid> <out> [--from store] [--tree cid] [--checkpoint] [--form ordfs|git] [--no-index] [--mined roots.json]
//   skein-host chain [handle]          the host chain's tip — height, hash, record
// `add --image/--boot/--packet` runs the loader (boot.ts, #4) on the new row's empty store: its objects
// pre-filled, its genesis from the tree (or a checkpoint restored). An image (`default`: images/default; a
// directory with etc/routes.json: a complete image; one without: merged over the default image, #152) carries
// the claim row: the first claim's sender owns it (`skein claim --instance <handle>`).
// Nothing here writes into a running instance on its own: installing an app, a row, a directory into `main`
// are root's requests (the client `skein`, signed with the operator's key, over the control socket).
// Settings: $SKEIN_HOME/host.env (every `SKEIN_*` line; the environment wins: hostenv.ts):
//   SKEIN_HOME            default ~/.skein; host.db, master.key, operator.key and host.env live here
//   SKEIN_OPERATOR_KEY    the operator's key file (the client's signer), default $SKEIN_HOME/operator.key
//   SKEIN_MASTER_KEY      the master secret (hex), else SKEIN_MASTER_KEY_FILE, else $SKEIN_HOME/master.key (made if absent)
//   SKEIN_KEY_FILE        #160: one-key mode — the ONE key every instance signs with (a file, read and never made), or
//                         SKEIN_KEY (hex); refused beside SKEIN_MASTER_KEY(_FILE); a create claimed by the host's key (#162)
//   SKEIN_IMAGES_DIR      #162: where a create's image by name is (<dir>/<name>), default $SKEIN_HOME/images
//   SKEIN_ROUTER_PORT     the router, default 8100: an instance at http://<handle>.localhost:8100 (or /@<handle>)
//   SKEIN_ROOT_INSTANCE   the instance served at / of a hostname that is no instance's; it may take the router's own first label
//   SKEIN_ROUTER_BIND     the addresses the router listens on, a comma list (default 127.0.0.1,::1)
//   SKEIN_ROUTER_ORIGIN   the router's own public origin, default http://127.0.0.1:{port}
//   SKEIN_INSTANCE_ORIGIN an instance's origin template, default http://{handle}.localhost:{port}
//   SKEIN_NETWORK         the network the whole host runs on: main | test | regtest, default main; every genesis the
//                         host makes has it as defaults.walletNetwork (the chain app's network)
//   SKEIN_IDLE_MS         stop a kernel this long after its last work (ms); default 0: never
//   SKEIN_FUEL_PER_STEP   a new genesis's fuelPerStep
//   SKEIN_HOST_PORT       the host page (/) and roster (/roster.json) on 127.0.0.1, default 4600
//   SKEIN_KERNEL_BIN      the kernel binary (the RocksDB host process), default kernel-zig/zig-out/bin/skein-kernel
//   SKEIN_STORE_ROCKSDB   #158: the host's RocksDB database (a directory), run by ONE `skein-kernel host` process
//   SKEIN_STORE_SQLITE    the host's ONE SQLite database (a file), run by the wasm kernel this process loads; the
//                         default when SKEIN_STORE_ROCKSDB is not set: $SKEIN_HOME/store.sqlite (the one-process-per-instance
//                         serve mode is gone: SPEC 5)
//   SKEIN_ARC_URL         the host's Arcade (arc.ts): broadcasts, its status subscription (proofs as events; a REJECTED
//                         as the status service's signed request); `off`: none. SKEIN_ARC_TOKEN, SKEIN_ARC_EVENTS_URL,
//                         SKEIN_ARC_CALLBACK_URL as before
//   SKEIN_HEADERS_URL     an SSE stream of block headers into the host's one header intake (headers-source.ts)
//   SKEIN_TERANODE        `off` turns the host's Teranode headers tracker off (teranode.ts); SKEIN_TERANODE_BOOTSTRAP,
//                         SKEIN_HEADERS_HUB as before

import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { CID } from "multiformats/cid";
import { CID as CIDClass, decode as decodeCbor, parse as parseCid } from "../runtime/cid.ts";
import { headTree, MAIN } from "../runtime/heads.ts";
import { anyOf, DEFAULT_IMAGE, dirSource, imageSource, isOverlayImage, MemBlocks, namedImageSource, packetSource, storeObjects, WASM_DIR, wasmDirObjects, type BootSource, type Objects } from "./boot.ts";
import { KERNEL_BIN } from "./kernel.ts";
import type { Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { short } from "../runtime/log.ts";
import { isRocks, refuseLmdb, storeSpec } from "../runtime/index-store.ts";
import { openStoreFile, readHostChain, storeBlocks, storeExists } from "./stores.ts";
import { spawnSync } from "node:child_process";
import { connect } from "node:net";
import type { Store } from "../runtime/store.ts";
import { oneKeySetting, signerOf } from "./signer.ts";
import { CONTROL_SOCKET, controlRequest } from "./control.ts";
import { homeOf as homeOfVars, identityOf, operatorKey, withHostEnv } from "./hostenv.ts";
import { hostArcConfig } from "./arc.ts";
import { lineWriter } from "./stamp.ts";
import { hostP2PConfig, peerIdOf } from "./p2p.ts";
import { DEFAULT_HUBS, TERANODE_BOOTSTRAP } from "./teranode.ts";
import { hostDomain, Router, type RouterOptions } from "./router.ts";
import { HostDb, knowsColumn, knowsOf, pathOnly, type InstanceRow, type RowFields } from "./instances.ts";
import { deployedIdentity, hostPage, parseIdentity, roster, rosterFor, serveRoster, type HostRow, type IdentityFields } from "./roster.ts";

export interface Env {
  vars: Record<string, string | undefined>;
  out(line: string): void;
  err(line: string): void;
  /** Tests: a row's store, instead of opening its file read-only. */
  store?(row: InstanceRow): Store | undefined;
}

const USAGE = `usage:
  skein-host run                                          the host: the router on :8100 (instances at <handle>.localhost:8100), a kernel per
                                                          instance on demand; host page and roster on :4600
  skein-host grant <key> --instance <handle> [--role root|<app>.<role>] [--remove] [--dry-run]
                                                          a grant (root by default): the operator's request, to the running host
  skein-host add <handle> --image <default | dir> [--domain d]   a new instance from an image: no owner, a claim row (claim it: skein claim)
  skein-host add <handle> --boot <dir | tree-cid [--from store]>              … from a system tree (docs/BOOTSTRAP.md)
  skein-host add <handle> --packet <file> [--scope cid] [--proofs roots.json]  … from a packet: a system tree, or a checkpoint to restore
  skein-host add <handle> [--domain d] [--derive] [--identity hex] [--tree cid] [--knows a,b|*] [--disabled]   an existing row's fields
  skein-host knows <handle> [a,b | --all | --none]        which agents its ROSTER.md lists; no list: print them
  skein-host list                                         handle, status, identity, key, store, tree, libp2p peer ID
  skein-host identity <handle> [--peer]                   an instance's identity key; --peer: its libp2p peer ID (#51)
  skein-host ledger [handle]                              the fuel ledger: calls and fuel per instance, caller, op
  skein-host enable|disable|remove <handle>
  skein-host roster                                       the front end's roster JSON
  skein-host roster --for <handle>                        that agent's ROSTER.md
  skein-host pack <handle|dir|tree-cid> <out> [--from store] [--tree cid] [--checkpoint] [--form ordfs|git] [--no-index] [--mined roots.json]
  skein-host chain [handle]                               the host chain's tip (height, hash, record)
settings: $SKEIN_HOME/host.env (every SKEIN_* line; the environment wins). Root's requests (installing an app, rows,
grants, a directory into main) are the client's: \`skein install|routes|grant|… --instance <handle>\``;

export const homeOf = homeOfVars;

export async function main(argv: string[], given: Env): Promise<number> {
  const [cmd, ...rest] = argv;
  const env: Env = { ...given, vars: withHostEnv(given.vars) }; // #142: host.env's SKEIN_* under the environment
  const home = homeOf(env.vars);
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") { env.out(USAGE); return cmd ? 0 : 2; }
  try { hostNetwork(env.vars); } catch (e) { env.err(`skein-host: ${(e as Error).message}`); return 2; }
  mkdirSync(home, { recursive: true });
  const db = new HostDb(join(home, "host.db"));
  try {
    switch (cmd) {
      case "add": {
        const { values: v, positionals: [handle] } = parseArgs({
          args: rest, allowPositionals: true,
          options: {
            domain: { type: "string" }, identity: { type: "string" }, derive: { type: "boolean" }, store: { type: "string" }, tree: { type: "string" }, knows: { type: "string" }, disabled: { type: "boolean" },
            boot: { type: "string" }, from: { type: "string" }, packet: { type: "string" }, scope: { type: "string" }, proofs: { type: "string" }, image: { type: "string" },
          },
        });
        if (!handle) { env.err(USAGE); return 2; }
        const f: RowFields = { domain: v.domain, identity: v.identity, store: v.store, tree: v.tree, status: v.disabled ? "disabled" : undefined };
        if (v.knows !== undefined) f.knows = knowsColumn(handles(v.knows));
        if (!db.get(handle)) {
          const sqlite = sqliteStoreOf(env.vars, home);
          f.store ??= sqlite ? `sqlite:${sqlite}` : `rocksdb:${resolve(env.vars.SKEIN_STORE_ROCKSDB!)}`; // #158, the settled split; no serve mode (SPEC 5)
          f.domain ??= hostDomain(env.vars.SKEIN_ROUTER_ORIGIN ?? "http://127.0.0.1"); // the host's domain (H4), as the router's
        }
        // The identity is the signer's (#18): derived from the master secret, key ID = the handle.
        if (f.identity === undefined && (v.derive || !db.get(handle)?.identity)) f.identity = signerOf(env.vars, home).identity(handle);
        if ([v.boot, v.packet, v.image].filter((x) => x !== undefined).length > 1) { env.err("skein-host add: one of --boot, --packet, --image"); return 2; }
        if (v.image !== undefined && isOutpoint(v.image)) { env.err(`skein-host add --image ${v.image}: an image by outpoint is read through the ORDFS app, which is not built yet; give a directory or a tree CID`); return 2; }
        // One loader (SPEC 8): a new instance starts from a tree; with no source there is no genesis to write.
        if (!db.get(handle) && !v.boot && !v.packet && v.image === undefined) { env.err(`skein-host add ${handle}: a new instance starts from a tree: give --image, --boot or --packet`); return 2; }
        const r = db.add(handle, f);
        env.out(`${r.handle}@${r.domain} ${r.status} · store ${r.store}${r.identity ? ` · ${short(r.identity)}` : ""}`);
        if (v.boot || v.packet || v.image !== undefined) {
          // The loader (#4): pre-fill the new store and write its genesis from the tree (or restore a checkpoint).
          // A one-shot (#61): the router it boots through is closed before `add` returns, so the process exits.
          const router = new Router({ ...routerOptions(db, env), idleMs: 0 });
          try {
            // `default`: the default image (images/default; skein next: it carries no chain part).
            // `host`: images/host merged over it (#142), unclaimed.
            // A directory with no bin/ (#152: an app repository's image/, etc/apps.json alone): merged over the
            // default image as images/host is. A directory with bin/: a complete image.
            const overlay = v.image !== undefined && existsSync(v.image) && statSync(v.image).isDirectory() && isOverlayImage(v.image) ? resolve(v.image) : undefined;
            const src = v.image === "default" ? await namedImageSource({ image: v.image })
              : overlay ? await namedImageSource({ overlay })
              : await bootSourceOf(v.image !== undefined ? { boot: v.image, from: v.from } : v, r);
            const b = await router.bootRow(handle, src);
            env.out(b.state ? `${handle}: restored checkpoint ${b.state} (${b.objects} blocks)` : `${handle}: booted from ${v.image !== undefined ? "the image " : ""}${b.tree} · ${b.objects} objects pre-filled${b.apps?.length ? ` · apps ${b.apps.map((x) => `${x.name} ${x.version}`).join(", ")}` : ""} · genesis ${b.entry} · no owner: claim it (skein claim --instance ${handle})`);
          } catch (e) {
            env.err(`skein-host add ${handle}: ${(e as Error).message}`);
            return 1;
          } finally {
            await router.close();
          }
        }
        return 0;
      }
      case "grant":
        return await grantCmd(db, rest, env);
      case "identity": {
        // The signer's key (signer.ts) for an instance: the BRC-104 identity its front door answers as.
        const [handle, flag, ...more] = rest;
        if (!handle || more.length || (flag !== undefined && flag !== "--peer")) { env.err(USAGE); return 2; }
        const signer = signerOf(env.vars, home);
        // The libp2p peer ID (#51): the identity multihash of the peer key, a child of the instance's root key (#129: key ID libp2p:<handle>, self).
        env.out(flag ? peerIdOf(signer.peerKey(handle)).toString() : signer.identity(handle));
        return 0;
      }
      case "ledger":
        for (const l of db.ledger(rest[0])) env.out([l.instance, l.caller || "-", l.op, String(l.calls), String(l.fuel), l.updated_at].join("\t"));
        return 0;
      case "list": {
        const door = frontDoorKeys(env.vars, home);
        const peer = peerIds(env.vars, home);
        for (const r of db.list()) env.out([`${r.handle}@${r.domain}`, r.status, r.identity ?? "-", door(r), r.store, r.tree ?? "-", peer(r)].join("\t"));
        return 0;
      }
      case "enable": case "disable": case "remove": {
        const [handle] = rest;
        if (!handle) { env.err(USAGE); return 2; }
        const ok = cmd === "remove" ? db.remove(handle) : db.setStatus(handle, cmd === "enable" ? "enabled" : "disabled");
        if (!ok) { env.err(`skein-host ${cmd}: no instance ${handle}`); return 1; }
        env.out(`${handle}: ${cmd === "remove" ? "removed (its store and wallet are untouched)" : `${cmd}d`}`);
        return 0;
      }
      case "run":
        return await run(db, rest, env);
      case "knows":
        return knowsCmd(db, rest, env);
      case "roster":
        return await rosterCmd(db, rest, env);
      case "pack":
        return await packCmd(db, rest, env);
      case "chain": {
        // #156: the host chain's tip (a RocksDB host's: one per host; a serve instance's: in its own store).
        const [handle] = rest;
        const row = handle ? db.get(handle) : undefined;
        if (handle && !row) { env.err(`skein-host chain: no instance ${handle}`); return 1; }
        const sqlite = sqliteStoreOf(env.vars, homeOf(env.vars));
        const spec = row ? storeSpec(row) : sqlite ? `sqlite:${sqlite}#host/chain` : env.vars.SKEIN_STORE_ROCKSDB ? `rocksdb:${resolve(env.vars.SKEIN_STORE_ROCKSDB)}#host/chain` : undefined;
        if (!spec) { env.err("skein-host chain: a handle (its own store's host chain), or SKEIN_STORE_ROCKSDB (the host's)"); return 2; }
        const c = readHostChain(spec);
        env.out(c ? `${c.height}\t${c.hash}\t${c.root.toString()}` : "no host chain");
        return 0;
      }
      default:
        env.err(USAGE);
        return 2;
    }
  } finally {
    if (cmd !== "run") db.close(); // run keeps it (and closes it on a signal)
  }
}

/** The network the whole host runs on (SKEIN_NETWORK, default main): a network fact, written as every genesis's `defaults.walletNetwork`. */
export const NETWORKS = ["main", "test", "regtest"] as const;
export function hostNetwork(v: Env["vars"]): string {
  const n = v.SKEIN_NETWORK || "main";
  if (!(NETWORKS as readonly string[]).includes(n)) throw new Error(`SKEIN_NETWORK is main, test or regtest (default main), not ${JSON.stringify(n)}`);
  return n;
}

const handles = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

/**
 * The key each row's front door signs its BRC-104 sessions with (#40): the
 * signer's, derived from the master secret with key ID = the handle — for an
 * instance, before the row was ever hydrated.
 * The master secret is only read here, never made: with none, "-".
 */
function frontDoorKeys(vars: Env["vars"], home: string): (row: InstanceRow) => string {
  const file = vars.SKEIN_MASTER_KEY_FILE || join(home, "master.key");
  if (!oneKeySetting(vars) && !vars.SKEIN_MASTER_KEY && !existsSync(file)) return () => "-";
  const signer = signerOf(vars, home);
  return (row) => signer.identity(row.handle);
}

/** Each row's libp2p peer ID (#51): derived from the instance's root key (#129: key ID libp2p:<handle>, self), whether or not it runs a node; "-" with no master secret. */
function peerIds(vars: Env["vars"], home: string): (row: InstanceRow) => string {
  const file = vars.SKEIN_MASTER_KEY_FILE || join(home, "master.key");
  if (!oneKeySetting(vars) && !vars.SKEIN_MASTER_KEY && !existsSync(file)) return () => "-";
  const signer = signerOf(vars, home);
  return (row) => peerIdOf(signer.peerKey(row.handle)).toString();
}

function knowsCmd(db: HostDb, rest: string[], env: Env): number {
  const { values: v, positionals: [handle, list, ...more] } = parseArgs({ args: rest, allowPositionals: true, options: { all: { type: "boolean" }, none: { type: "boolean" } } });
  if (!handle || more.length || [list !== undefined, v.all, v.none].filter(Boolean).length > 1) { env.err(USAGE); return 2; }
  if (!db.get(handle)) { env.err(`skein-host knows: no instance ${handle}`); return 1; }
  if (list !== undefined || v.all || v.none) {
    const k = v.all ? "all" : v.none ? [] : handles(list!);
    for (const h of k === "all" ? [] : k) if (h !== "*" && !db.get(h)) env.err(`skein-host knows: no instance ${h} (yet): kept, listed once it exists`);
    db.setKnows(handle, k);
  }
  const k = knowsOf(db.get(handle)!);
  env.out(`${handle} knows ${k === "all" ? "everyone" : k.length ? k.join(", ") : "nobody"}`);
  return 0;
}

/**
 * An instance's origin here (router.ts originOf): its front door, its
 * messagebox — SKEIN_INSTANCE_ORIGIN (default http://{handle}.localhost:{port})
 * on SKEIN_ROUTER_PORT (default 8100).
 */
export function originOf(vars: Env["vars"], handle: string): string {
  // #161: a path-only handle (a token id): /@<handle> on the router's own origin.
  if (pathOnly(handle)) return `${(vars.SKEIN_ROUTER_ORIGIN || "http://127.0.0.1:{port}").replace("{port}", vars.SKEIN_ROUTER_PORT || "8100").replace(/\/+$/, "")}/@${handle}`;
  return (vars.SKEIN_INSTANCE_ORIGIN || "http://{handle}.localhost:{port}").replace("{handle}", handle).replace("{port}", vars.SKEIN_ROUTER_PORT || "8100");
}

/**
 * `skein-host grant <key> --instance <handle> [--role <role>] [--remove] [--dry-run]`: the kernel's `grant`
 * operation — root (or `<app>.<role>`) to the key — in the instance: the operator's request
 * (src/client/admin.ts planGrant), signed with its key and handed to the running host over its control socket.
 */
async function grantCmd(db: HostDb, rest: string[], env: Env): Promise<number> {
  const { values: v, positionals: [key, ...more] } = parseArgs({ args: rest, allowPositionals: true, options: { role: { type: "string" }, remove: { type: "boolean" }, instance: { type: "string" }, "dry-run": { type: "boolean" } } });
  if (!key || more.length || !v.instance) { env.err(USAGE); return 2; }
  void db;
  const { planGrant } = await import("../client/admin.ts");
  const { localTarget } = await import("../client/target.ts");
  const { keyWallet } = await import("../wallet.ts");
  let t: import("../client/target.ts").Target | undefined;
  try {
    t = localTarget(env.vars, v.instance, keyWallet(operatorKey(env.vars).key));
    const p = await planGrant(await t.view(), key, { ...(v.role ? { role: v.role } : {}), ...(v.remove ? { remove: true } : {}) });
    for (const l of p.prompt) env.out(l);
    if (v["dry-run"]) return 0;
    for (const r of p.requests) await t.send(r.path, r.body);
    env.out(`${v.instance}: ${p.requests.length ? `${v.role ?? "root"} ${v.remove ? "revoked from" : "granted to"}` : "nothing to change for"} ${short(key)}`);
    return 0;
  } catch (e) {
    env.err(`skein-host grant: ${(e as Error).message}`);
    return 1;
  } finally {
    await t?.close();
  }
}

/** An outpoint as an image is named on chain: `<txid>_<vout>` (or `.`/`:`). */
const isOutpoint = (s: string) => /^[0-9a-f]{64}[_.:][0-9]+$/.test(s);

/** The URL of a router answering for this host (its /manifest.json), if one does. */
async function routerAt(vars: Env["vars"]): Promise<string | undefined> {
  const base = (vars.SKEIN_HOST_URL || `http://127.0.0.1:${vars.SKEIN_ROUTER_PORT || 8100}`).replace(/\/+$/, "");
  try {
    const r = await fetch(`${base}/manifest.json`, { signal: AbortSignal.timeout(2000) });
    const m = await r.json() as { metanet?: unknown };
    return r.ok && m?.metanet ? base : undefined;
  } catch { return undefined; } // nothing answering there (or not a router): the command runs its own
}

/**
 * IDENTITY.md's fields per row, for ROSTER.md: from `pending` (the directory
 * about to be deployed into that row), else the row's deployed tree in its
 * store, else (not admitted yet) its `source` directory; else empty.
 */
function identities(env: Env, pending: Map<string, string> = new Map()): (row: InstanceRow) => Promise<IdentityFields> {
  const seen = new Map<string, IdentityFields>();
  const fromDir = (dir: string): IdentityFields | undefined => {
    const p = join(dir, "IDENTITY.md");
    return existsSync(p) ? parseIdentity(readFileSync(p, "utf8")) : undefined;
  };
  return async (row) => {
    let f = seen.get(row.handle);
    if (f) return f;
    const dir = pending.get(row.handle);
    if (dir) f = fromDir(dir);
    else {
      const s = openRow(row, env);
      try { f = await deployedIdentity(row, s.blocks); } finally { await s.close?.(); }
      if (!f && row.source) f = fromDir(row.source);
    }
    f ??= { displayName: "", description: "" };
    seen.set(row.handle, f);
    return f;
  };
}

async function rosterCmd(db: HostDb, rest: string[], env: Env): Promise<number> {
  const { values: v, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { for: { type: "string" } } });
  if (positionals.length) { env.err(USAGE); return 2; }
  const rows = db.list("enabled");
  if (v.for !== undefined) {
    const row = db.get(v.for);
    if (!row) { env.err(`skein-host roster: no instance ${v.for}`); return 1; }
    const text = await rosterFor(row, rows, identities(env));
    if (text) env.out(text.trimEnd());
    else env.err(`${row.handle} knows nobody: no ROSTER.md`);
    return 0;
  }
  env.out(JSON.stringify(await roster(rows, async (row) => openRow(row, env), () => false), null, 2));
  return 0;
}

/** A row's store to read while something else may be writing it: read-only, if it exists. */
function openRow(row: InstanceRow, env: Env): { blocks?: Store; close?(): Promise<void> } {
  const given = env.store?.(row);
  if (given) return { blocks: given };
  if (!storeExists(storeSpec(row))) return {};
  const s = openStoreFile(storeSpec(row), { readOnly: true });
  return { blocks: s, close: () => s.close() };
}

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");

export interface RunOptions {
  /** The router's options beyond what the environment gives (tests, an application host). */
  router?: Partial<RouterOptions>;
}

export interface Host {
  router: Router;
  /** The messagebox (router) port and the host page's. */
  messagebox?: number;
  server?: Server;
  port?: number;
  stop(): Promise<void>;
}

/**
 * The signer (#18, signer.ts): every instance's wallet is a ProtoWallet over a
 * key derived from the router's master secret (key ID = the handle); the
 * router's BRC-104 identity is another child of it, and so are its providers'
 * keys (#70: the HTTP proxy, the waker, the libp2p node, the status provider,
 * the instance manager, and the certifier, #113: its key the certifier key, BRC-169's trust anchor).
 */
function wallets(v: Env["vars"], home: string): Pick<RouterOptions, "walletFor" | "peerKeyFor" | "providerKeyFor" | "claimer" | "hostPeerKey"> {
  const signer = signerOf(v, home); // #160: one-key mode (SKEIN_KEY_FILE / SKEIN_KEY), else the master key's
  return {
    walletFor: (row) => signer.wallet(row.handle), peerKeyFor: (handle) => signer.peerKey(handle), providerKeyFor: (name) => signer.providerKey(name),
    hostPeerKey: signer.hostPeerKey(), // #156: the host node's (the tracker rides it; a one-key host's instances share it)
    // #162: a one-key host claims the instances it creates with its own key.
    ...(signer.shared ? { claimer: signer.wallet("") } : {}),
  };
}

/** The router's options from the environment (`run`, and `add --boot/--packet`, which boots through it). */
function routerOptions(db: HostDb, env: Env): RouterOptions {
  const v = env.vars;
  const home = homeOf(v);
  return {
    db, ...wallets(v, home),
    fuelPerStep: v.SKEIN_FUEL_PER_STEP, idleMs: v.SKEIN_IDLE_MS !== undefined ? Number(v.SKEIN_IDLE_MS) : undefined, home,
    origin: v.SKEIN_ROUTER_ORIGIN, instanceOrigin: v.SKEIN_INSTANCE_ORIGIN, port: Number(v.SKEIN_ROUTER_PORT ?? 8100),
    network: hostNetwork(v),
    kernel: { command: v.SKEIN_KERNEL_BIN, env: { SKEIN_HOME: home } },
    ...(v.SKEIN_STORE_ROCKSDB ? { rocksStore: resolve(v.SKEIN_STORE_ROCKSDB) } : {}), // #158
    ...((s) => (s ? { sqliteStore: s } : {}))(sqliteStoreOf(v, home)), // the settled split: the wasm kernel
    ...(v.SKEIN_ROOT_INSTANCE ? { rootInstance: v.SKEIN_ROOT_INSTANCE } : {}),
    ...(v.SKEIN_HEADERS_URL ? { headersUrl: v.SKEIN_HEADERS_URL } : {}),
    imagesDir: resolve(v.SKEIN_IMAGES_DIR || join(home, "images")),
    libp2p: hostP2PConfig(v, home),
    arc: hostArcConfig(v, home, { made: (f) => env.out(`skein-host: the host's Arcade callback token made and kept in ${f} (SKEIN_ARC_TOKEN)`) }),
    log: (source, line) => env.out(`[${source}] ${line}`),
  };
}

/**
 * #156: the host's Teranode headers tracker (`skein-host run`): on unless SKEIN_TERANODE=off, where the
 * network has bootstrap peers or SKEIN_TERANODE_BOOTSTRAP names some, or a hub is known for the first sync.
 */
export function teranodeOptions(v: Record<string, string | undefined>, home: string): Pick<RouterOptions, "teranode"> {
  if ((v.SKEIN_TERANODE ?? "").toLowerCase() === "off") return {};
  const net = hostNetwork(v);
  const named = (v.SKEIN_TERANODE_BOOTSTRAP ?? "").split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
  const bootstrap = [...new Set([...(TERANODE_BOOTSTRAP[net] ?? []), ...named])]; // #156: the network's and the named ones
  const hub = (v.SKEIN_HEADERS_HUB || DEFAULT_HUBS[net])?.replace(/\/+$/, "");
  if (!bootstrap.length && !hub) return {};
  return { teranode: { bootstrap, ...(hub ? { hub } : {}), peersFile: join(home, "teranode-peers.json") } };
}

// ---------------------------------------------------------------- bootstrap (#4)

/** The default image (#89): one genesis for everyone, no owner in it, a claim row (boot.ts). */
export { DEFAULT_IMAGE };

/** The source `add --boot/--packet` names (boot.ts): a directory, a tree CID in a store, or a packet file. */
async function bootSourceOf(v: { boot?: string; from?: string; packet?: string; scope?: string; proofs?: string }, row: InstanceRow): Promise<BootSource> {
  if (v.packet) {
    const { rootsTracker } = await import("./packet.ts");
    return packetSource(new Uint8Array(readFileSync(v.packet)), {
      scope: v.scope ? parseCid(v.scope) : undefined,
      chainTracker: v.proofs ? rootsTracker(JSON.parse(readFileSync(v.proofs, "utf8"))) : undefined,
    });
  }
  const spec = v.boot!;
  if (existsSync(spec) && statSync(spec).isDirectory()) return await imageSource(resolve(spec));
  const root = parseCid(spec);
  const path = v.from ?? storeSpec(row);
  if (!storeExists(path)) throw new Error(`--boot ${spec}: no store at ${path} to read the tree from (--from)`);
  const s = openStoreFile(path, { readOnly: true });
  // The objects are read now: the row's own store is about to be written by its kernel.
  const blocks = new MemBlocks();
  const { closure } = await import("./packet.ts");
  const src = storeObjects(s);
  const c = await closure(root, (x) => src.get(x));
  s.close();
  for (const b of c.blocks) await blocks.putBlock(b.cid, b.bytes);
  return { kind: "tree", root, objects: anyOf(blocks, wasmDirObjects(WASM_DIR)) };
}

/** An index node or a state record (#30): history a checkpoint leaves behind (dump.zig isIndexBlock). */
function isIndexBlock(cid: CID, bytes: Uint8Array): boolean {
  if (cid.code !== 0x71) return false;
  let v: unknown;
  try { v = decodeCbor(bytes); } catch { return false; } // not dag-cbor: not an index block
  if (v && typeof v === "object" && !Array.isArray(v)) return (v as { kind?: unknown }).kind === "skein-state";
  if (!Array.isArray(v) || v.length !== 2 || !Array.isArray(v[1]) || (v[0] !== null && !CIDClass.asCID(v[0]))) return false;
  return v[1].length > 0 && v[1].every((e: unknown) => Array.isArray(e) && e.length === 3 && e[0] instanceof Uint8Array && (e[2] === null || !!CIDClass.asCID(e[2])));
}

/** Every block of a store except the index's (nodes and state records): a checkpoint's extras candidates. A file, or a set's members. */
function looseRecords(spec: string): Array<{ cid: CID; bytes: Uint8Array }> {
  const out: Array<{ cid: CID; bytes: Uint8Array }> = [];
  for (const { cid, bytes } of storeBlocks(spec)) if (!isIndexBlock(cid, bytes)) out.push({ cid, bytes });
  return out;
}

/** `skein-host pack <handle|dir|tree-cid> <out>`: a packet (packet.ts) of a system tree or, with --checkpoint, a whole instance. */
async function packCmd(db: HostDb, rest: string[], env: Env): Promise<number> {
  const { values: v, positionals: [what, out, ...more] } = parseArgs({
    args: rest, allowPositionals: true,
    options: { from: { type: "string" }, checkpoint: { type: "boolean" }, form: { type: "string" }, "no-index": { type: "boolean" }, mined: { type: "string" }, tree: { type: "string" } },
  });
  if (!what || !out || more.length || (v.form !== undefined && v.form !== "ordfs" && v.form !== "git")) { env.err(USAGE); return 2; }
  const { writePacket } = await import("./packet.ts");
  let scope: CID, objects: Objects, close = () => {}, extras: Array<{ cid: CID; bytes: Uint8Array }> | undefined;
  const row = db.get(what);
  if (row) {
    if (!storeExists(storeSpec(row))) { env.err(`skein-host pack: ${row.handle} has no store yet`); return 1; }
    const s = openStoreFile(storeSpec(row), { readOnly: true }) as ReturnType<typeof openStoreFile> & { state?(): { cid: CID } };
    close = () => s.close();
    objects = anyOf(storeObjects(s), wasmDirObjects(WASM_DIR));
    if (v.checkpoint) {
      if (!s.state) { env.err(`skein-host pack: ${row.handle}'s store predates the state record (#30)`); close(); return 1; }
      scope = s.state().cid;
      extras = looseRecords(storeSpec(row));
    } else if (v.tree) scope = parseCid(v.tree);
    else {
      // The system tree it booted from, else its `main`.
      const tip = await s.log.tip();
      let first = tip ? await s.get(tip) as Record<string, unknown> : undefined;
      while (first && first.prev) first = await s.get(first.prev as CID) as Record<string, unknown>;
      const g = first?.genesis ? await s.get(first.genesis as CID) as { tree?: CID } : undefined;
      const main = await headTree(s, MAIN);
      const t = g?.tree ?? main;
      if (!t) { env.err(`skein-host pack: ${row.handle} has no system tree and no main (--tree, or --checkpoint)`); close(); return 1; }
      scope = t;
    }
  } else if (existsSync(what) && statSync(what).isDirectory()) {
    const d = await dirSource(resolve(what));
    scope = d.root;
    objects = anyOf(d.objects, wasmDirObjects(WASM_DIR));
  } else {
    scope = parseCid(what);
    if (!v.from) { env.err("skein-host pack <tree-cid>: --from <store.db> (where the objects are)"); return 2; }
    const s = openStoreFile(v.from, { readOnly: true });
    close = () => s.close();
    objects = anyOf(storeObjects(s), wasmDirObjects(WASM_DIR));
  }
  try {
    const w = await writePacket(scope, objects, { form: v.form as "ordfs" | "git" | undefined, noIndex: v["no-index"], mined: v.mined !== undefined, extras });
    writeFileSync(out, w.bytes);
    if (v.mined) writeFileSync(v.mined, `${JSON.stringify(w.roots, null, 2)}\n`);
    env.out(`${out}: scope ${scope} · ${w.objects} objects in ${w.txids.length} transaction(s) (synthetic, not broadcast) · ${w.bytes.length} bytes${v.mined ? ` · header roots in ${v.mined}` : ""}`);
    return 0;
  } catch (e) {
    env.err(`skein-host pack: ${(e as Error).message}`);
    return 1;
  } finally { close(); }
}

/**
 * `skein-host run`: the router (router.ts) on SKEIN_ROUTER_PORT (default
 * 8100, the messagebox URL clients already use), every enabled row hydrated
 * once at start (stopped only past SKEIN_IDLE_MS), and the host page and roster on
 * SKEIN_HOST_PORT. A skein's explorer is its own (`/explore`, its owner's),
 * read by the management site (shruggr/skein-site, #92).
 */
export async function runHost(db: HostDb, env: Env, o: RunOptions = {}): Promise<Host> {
  const v = env.vars;
  const home = homeOf(v);
  const router = new Router({ ...routerOptions(db, env), ...teranodeOptions(v, home), ...o.router });
  const mport = Number(v.SKEIN_ROUTER_PORT ?? 8100);
  const binds = (v.SKEIN_ROUTER_BIND ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const mserver = await router.listen(mport, binds.length ? binds : undefined).then((s) => s, (e: Error) => { env.err(`skein-host: router: ${e.message}`); return undefined; });
  // The control socket (#60, #142): the client's signed messages reach this router's kernels through it.
  const sock = join(home, CONTROL_SOCKET);
  await router.listenControl(sock).then(() => env.out(`skein-host: control socket at ${sock}`), (e: Error) => env.err(`skein-host: control socket: ${e.message}`));
  const messagebox = mserver ? (mserver.address() as { port: number }).port : undefined;
  if (messagebox !== undefined) env.out(`skein-host: router at http://127.0.0.1:${messagebox} · an instance at ${router.originOf("<handle>")} (or /@<handle>)`);
  env.out(`skein-host: network ${router.o.network} (SKEIN_NETWORK): every new genesis's defaults.walletNetwork, the chain app's network`);
  if (router.arc) env.out(`skein-host: broadcaster: broadcast events → Arcade ${router.o.arc!.url}; proofs (events) and rejections (the status service's requests) from ${router.arc.eventsUrl()}${router.o.arc!.callbackUrl ? ` and webhooks at /arc/callback (${router.o.arc!.callbackUrl})` : ""}`);
  else env.out(`skein-host: no Arcade (SKEIN_ARC_URL ${(v.SKEIN_ARC_URL ?? "").toLowerCase() === "off" ? "off" : `unset, and network ${hostNetwork(v)} has none`}): a broadcast event is dropped`);
  await router.start();
  const enabled = db.list("enabled");
  env.out(`skein-host: routing for ${enabled.length} enabled instances (${enabled.map((r) => r.handle).join(", ") || "none"})`);
  const live = (row: InstanceRow) => router.loaded.has(row.handle);
  const port = Number(v.SKEIN_HOST_PORT || 4600);
  const page = async () => hostPage(db.list("enabled").map((r): HostRow => {
    const l = router.loaded.get(r.handle);
    return {
      handle: r.handle, domain: r.domain, identity: r.identity ?? "", status: l ? "live" : "idle",
      store: r.store, tree: r.tree ?? "", pid: l?.kernel.pid, restarts: 0, origin: router.originOf(r.handle),
    };
  }), { router: messagebox !== undefined ? `http://127.0.0.1:${messagebox}` : undefined, originOf: (h) => router.originOf(h) });
  const server = await serveRoster(port, () => roster(db.list("enabled"), async (row) => openRow(row, env), live), "127.0.0.1", page)
    .then((s) => { env.out(`skein-host: host page at http://127.0.0.1:${(s.address() as { port: number }).port}/ · roster at /roster.json`); return s; }, (e: Error) => { env.err(`skein-host: host server: ${e.message}`); return undefined; });
  return {
    router, messagebox, server, port: server ? (server.address() as { port: number }).port : undefined,
    async stop() {
      server?.close();
      await router.close();
    },
  };
}

/** `skein-host run`: runHost until SIGINT/SIGTERM, then stop every kernel and exit. */
async function run(db: HostDb, rest: string[], env: Env): Promise<number> {
  const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
  if (positionals.length) { env.err(USAGE); db.close(); return 2; }
  const host = await runHost(db, env);
  let stopping = false;
  const stop = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    env.out(`${sig}: stopping`);
    await host.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
  return 0;
}

if (import.meta.main) {
  // 0.9.1: `run`'s every line carries a wall-clock stamp (stamp.ts); the other commands' output as it is.
  const line = lineWriter(process.argv[2] === "run");
  process.exitCode = await main(process.argv.slice(2), { vars: process.env, out: (l) => process.stdout.write(`${line(l)}\n`), err: (l) => process.stderr.write(`${line(l)}\n`) });
}

/** SKEIN_STORE named the host's LMDB environment (#96): LMDB is no longer supported, so a set SKEIN_STORE is refused. */
export function refuseLmdbEnv(v: Record<string, string | undefined>): void {
  if (v.SKEIN_STORE) throw new Error(`SKEIN_STORE=${v.SKEIN_STORE}: LMDB is no longer supported`);
}

/**
 * The host's SQLite database for new instances (the settled split, 2026-10-31): SKEIN_STORE_SQLITE, else
 * $SKEIN_HOME/store.sqlite unless SKEIN_STORE_ROCKSDB names the RocksDB database (SPEC 5: no store file per
 * instance).
 */
export function sqliteStoreOf(v: Record<string, string | undefined>, home: string): string | undefined {
  refuseLmdbEnv(v);
  if (v.SKEIN_STORE_SQLITE) return resolve(v.SKEIN_STORE_SQLITE);
  if (v.SKEIN_STORE_ROCKSDB) return undefined;
  return join(home, "store.sqlite");
}

#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// `skein-host`: the host's management database (instances.ts, $SKEIN_HOME/host.db)
// and the router (router.ts, #33) that serves every enabled row.
//   skein-host add <handle> [--domain d] [--derive] [--identity hex] [--store path] [--tree cid] [--knows a,b|*] [--disabled]
//   skein-host knows <handle> [a,b | --all | --none]
//   skein-host list
//   skein-host identity [handle]      the router's BRC-104 identity key, or an instance's (both from the master secret)
//   skein-host mailboxes              the mailboxes kept here for other identities, and which instance keeps each
//   skein-host enable|disable|remove <handle>
//   skein-host run
//   skein-host deploy <handle> <dir> [--only glob,glob]   |   skein-host deploy --all [--only glob,glob]
//   skein-host roster [--for <handle> | --deploy]
//   skein-host subscribe <handle> add|remove [--sender key] <box> <handler-name-or-cid>
// `add` inserts, or updates the given fields of an existing row. A new row's
// identity is the oracle's (oracle.ts, #18): derived from the router's master
// secret with key ID = the handle, no wallet process; `--derive` sets it again
// on an existing row (its store must then be a new one: re-genesis). `deploy`
// sends a directory into an instance through its `objects` box as the owner
// (deploy.ts) and records its root as the row's `tree` (and the directory as
// its `source`, which `--all` deploys again), with the row's generated
// ROSTER.md at the tree's root (#27: the rows it `knows`; `knows` sets them).
// `roster` prints the front end's roster (roster.ts), which `run` also serves
// at /roster.json; `roster --for h` prints h's ROSTER.md; `roster --deploy`
// sends every enabled row whose ROSTER.md changed its deployed tree (from the
// instance's store) with the new one. `subscribe` changes an instance's
// subscriptions (#3) by a `subscribe` message as the owner, as `deploy` sends
// (a new instance's genesis carries only the seed: the owner's boxes and
// `chat` from anyone). `run` is the router: the BRC-33 messagebox (BRC-104
// auth) on SKEIN_ROUTER_PORT, a `skein-kernel serve` per instance started on
// demand and stopped when idle, the waker, the oracle; plus one read-only
// explorer per enabled row and the host page. It reads (bin/skein-host fills
// it from $SKEIN_HOME):
//   SKEIN_HOME            default ~/.skein; host.db and master.key live here
//   SKEIN_MASTER_KEY      the master secret (hex), else SKEIN_MASTER_KEY_FILE, else $SKEIN_HOME/master.key (made if absent)
//   SKEIN_ROUTER_PORT     the messagebox (the router), default 8100: http://127.0.0.1:8100/messagebox
//   SKEIN_IDLE_MS         stop a kernel this long after its last work, default 300000; 0 never
//   SKEIN_MAILBOX_HOST    the instance that keeps registered mailboxes, default the first enabled row
//   SKEIN_OWNER           a new instance's owner;   SKEIN_OWNER_HANDLE its genesis name, default david@localhost
//   SKEIN_INFER           a new instance's peers.infer;   SKEIN_INFER_HANDLE its genesis name, default infer@localhost
//   SKEIN_FUEL_PER_STEP   a new genesis's fuelPerStep
//   SKEIN_HOST_PORT       the host page (/) and roster (/roster.json) on 127.0.0.1, default 4600
//   SKEIN_EXPLORE_BASE_PORT  row i's explorer (skein-explore) listens on base + i (i: its place among the enabled rows);
//                         default 4610; "off" starts none
//   SKEIN_KERNEL_BIN      the kernel binary, default kernel-zig/zig-out/bin/skein-kernel
// `deploy` and `subscribe` read SKEIN_MESSAGEBOX, SKEIN_OWNER (checked against the wallet),
// and signs through the owner's wallet as bin/skein does:
//   SKEIN_OWNER_WALLET    default http://127.0.0.1:3322;   SKEIN_ORIGINATOR default skein-client

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { short } from "../runtime/log.ts";
import { openStoreFile } from "../runtime/index-store.ts";
import { rootIdentity } from "../runtime/identity.ts";
import type { Store } from "../runtime/store.ts";
import { remoteWallet, type WalletInterface } from "../wallet.ts";
import { masterKey, Oracle } from "./oracle.ts";
import { subscribeBody } from "../client/client.ts";
import { DEFAULT_ONLY, deploy, deployFiles, subscribeRow, type Deployed } from "./deploy.ts";
import { Supervisor, type Supervised } from "./supervisor.ts";
import { Router, type RouterOptions } from "./router.ts";
import { HostDb, knowsColumn, knowsOf, type InstanceRow, type RowFields } from "./instances.ts";
import { messageBoxClient, type MessageBox } from "./messagebox.ts";
import { deployedIdentity, hostPage, parseIdentity, roster, rosterFor, serveRoster, type HostRow, type IdentityFields } from "./roster.ts";

export interface Env {
  vars: Record<string, string | undefined>;
  out(line: string): void;
  err(line: string): void;
  /** Tests: the owner's wallet and messagebox session `deploy` uses instead of SKEIN_OWNER_WALLET / SKEIN_MESSAGEBOX. */
  owner?: { wallet: WalletInterface; box: MessageBox };
  /** Tests: a row's store, instead of opening its file read-only. */
  store?(row: InstanceRow): Store | undefined;
}

const USAGE = `usage:
  skein-host add <handle> [--domain d] [--derive] [--identity hex] [--store path] [--tree cid] [--knows a,b|*] [--disabled]
  skein-host knows <handle> [a,b | --all | --none]        which agents its ROSTER.md lists; no list: print them
  skein-host list
  skein-host identity [handle]                            the router's identity key (BRC-104), or an instance's
  skein-host mailboxes                                    mailboxes kept for other identities (registered), and their keepers
  skein-host enable|disable|remove <handle>
  skein-host run                                          the router: the messagebox on :8100, a kernel per instance on demand; host page and roster on :4600
  skein-host deploy <handle> <dir> [--only glob,glob]     default --only ${DEFAULT_ONLY.join(",")}
  skein-host deploy --all [--only glob,glob]              every enabled row, from its last deployed directory
  skein-host roster                                       the front end's roster JSON
  skein-host roster --for <handle>                        that agent's ROSTER.md
  skein-host roster --deploy                              redeploy every enabled row whose ROSTER.md changed
  skein-host subscribe <handle> add|remove [--sender key] <box> <handler-name-or-cid>`;

export const homeOf = (vars: Env["vars"]) => vars.SKEIN_HOME || join(vars.HOME ?? ".", ".skein");

export async function main(argv: string[], env: Env): Promise<number> {
  const [cmd, ...rest] = argv;
  const home = homeOf(env.vars);
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") { env.out(USAGE); return cmd ? 0 : 2; }
  mkdirSync(home, { recursive: true });
  const db = new HostDb(join(home, "host.db"));
  try {
    switch (cmd) {
      case "add": {
        const { values: v, positionals: [handle] } = parseArgs({
          args: rest, allowPositionals: true,
          options: { domain: { type: "string" }, identity: { type: "string" }, derive: { type: "boolean" }, "wallet-url": { type: "string" }, originator: { type: "string" }, store: { type: "string" }, tree: { type: "string" }, knows: { type: "string" }, disabled: { type: "boolean" } },
        });
        if (!handle) { env.err(USAGE); return 2; }
        const f: RowFields = { domain: v.domain, identity: v.identity, wallet_url: v["wallet-url"], wallet_originator: v.originator, store: v.store, tree: v.tree, status: v.disabled ? "disabled" : undefined };
        if (v.knows !== undefined) f.knows = knowsColumn(handles(v.knows));
        if (!db.get(handle)) f.store ??= join(home, "instances", handle, "runtime.db");
        // The identity is the oracle's (#18): derived from the master secret, key ID = the handle.
        if (f.identity === undefined && (v.derive || !db.get(handle)?.identity)) f.identity = new Oracle(masterKey(env.vars, home)).identity(handle);
        const r = db.add(handle, f);
        env.out(`${r.handle}@${r.domain} ${r.status} · store ${r.store}${r.wallet_url ? ` · wallet ${r.wallet_url}` : ""}${r.identity ? ` · ${short(r.identity)}` : ""}`);
        return 0;
      }
      case "identity": {
        // The oracle's keys (oracle.ts): the router's BRC-104 identity, or an instance's.
        const [handle] = rest;
        const oracle = new Oracle(masterKey(env.vars, home));
        env.out(handle ? oracle.identity(handle) : (await oracle.routerWallet().getPublicKey({ identityKey: true })).publicKey);
        return 0;
      }
      case "mailboxes":
        for (const m of db.mailboxes()) env.out([`${m.handle}@${m.domain}`, m.identity, m.instance].join("\t"));
        return 0;
      case "list":
        for (const r of db.list()) env.out([`${r.handle}@${r.domain}`, r.status, r.identity ?? "-", r.wallet_url ?? "-", r.store, r.tree ?? "-"].join("\t"));
        return 0;
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
      case "deploy":
        return await deployCmd(db, rest, env);
      case "knows":
        return knowsCmd(db, rest, env);
      case "roster":
        return await rosterCmd(db, rest, env);
      case "subscribe":
        return await subscribeCmd(db, rest, env);
      default:
        env.err(USAGE);
        return 2;
    }
  } finally {
    if (cmd !== "run") db.close(); // run keeps it (and closes it on a signal)
  }
}

const handles = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

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

async function subscribeCmd(db: HostDb, rest: string[], env: Env): Promise<number> {
  const { values: v, positionals: [handle, op, box, handler, ...more] } = parseArgs({ args: rest, allowPositionals: true, options: { sender: { type: "string" } } });
  if (!handler || more.length || (op !== "add" && op !== "remove")) { env.err(USAGE); return 2; }
  const row = db.get(handle!);
  if (!row) { env.err(`skein-host subscribe: no instance ${handle}`); return 1; }
  const owner = await ownerOf(env, "skein-host subscribe");
  if (typeof owner === "number") return owner;
  const s = openRow(row, env);
  try {
    await subscribeRow({ row, owner: owner.wallet, box: owner.box, store: s.blocks }, subscribeBody({ op, sender: v.sender, box: box!, handler }));
    env.out(`${row.handle}: subscribe ${op} (${v.sender ? short(v.sender) : "anyone"}, ${box}) → ${handler} sent`);
    return 0;
  } catch (e) {
    env.err(`${row.handle}: ${(e as Error).message}`);
    return 1;
  } finally {
    await s.close?.();
  }
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
  const { values: v, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { for: { type: "string" }, deploy: { type: "boolean" } } });
  if (positionals.length || (v.for !== undefined && v.deploy)) { env.err(USAGE); return 2; }
  const rows = db.list("enabled");
  if (v.for !== undefined) {
    const row = db.get(v.for);
    if (!row) { env.err(`skein-host roster: no instance ${v.for}`); return 1; }
    const text = await rosterFor(row, rows, identities(env));
    if (text) env.out(text.trimEnd());
    else env.err(`${row.handle} knows nobody: no ROSTER.md`);
    return 0;
  }
  if (!v.deploy) {
    env.out(JSON.stringify(await roster(rows, async (row) => openRow(row, env), () => false), null, 2));
    return 0;
  }
  const owner = await ownerOf(env, "skein-host roster");
  if (typeof owner === "number") return owner;
  const fields = identities(env);
  let failed = 0;
  for (const row of rows) {
    if (!row.tree) { env.out(`${row.handle}: never deployed; skipped`); continue; }
    const s = openRow(row, env);
    try {
      if (!s.blocks) throw new Error(`no store at ${row.store}: deploy the directory instead`);
      const r = await deployFiles({ row, owner: owner.wallet, box: owner.box, store: s.blocks, files: { "ROSTER.md": (await rosterFor(row, rows, fields)) ?? null } });
      db.add(row.handle, { tree: r.root });
      env.out(deployedLine(row, r));
    } catch (e) {
      failed++;
      env.err(`${row.handle}: ${(e as Error).message}`);
    } finally {
      await s.close?.();
    }
  }
  return failed ? 1 : 0;
}

const deployedLine = (row: InstanceRow, r: Deployed) => r.unchanged
  ? `${row.handle}: unchanged ${r.root}`
  : `${row.handle}: deployed ${r.root} · ${r.records} objects in ${r.bundles} envelope(s) to objects${r.head ? " · head main" : ""}`;

/** The owner's wallet and messagebox session (env.owner in tests), checked against SKEIN_OWNER; else an exit code. */
async function ownerOf(env: Env, cmd: string): Promise<{ wallet: WalletInterface; box: MessageBox } | number> {
  let owner = env.owner;
  if (!owner) {
    const mb = env.vars.SKEIN_MESSAGEBOX;
    if (!mb) { env.err(`${cmd}: SKEIN_MESSAGEBOX is not set (bin/skein-host reads messagebox.url)`); return 1; }
    const wallet = remoteWallet(env.vars.SKEIN_OWNER_WALLET || "http://127.0.0.1:3322", env.vars.SKEIN_ORIGINATOR || "skein-client");
    owner = { wallet, box: messageBoxClient(wallet, mb, env.vars.SKEIN_ORIGINATOR || "skein-client") };
  }
  const me = await rootIdentity(owner.wallet);
  if (env.vars.SKEIN_OWNER && env.vars.SKEIN_OWNER !== me) {
    env.err(`${cmd}: the owner wallet is ${short(me)}, not SKEIN_OWNER ${short(env.vars.SKEIN_OWNER)}: instances would not admit what it signs`);
    return 1;
  }
  return owner;
}

/** A row's store to read while something else may be writing it: read-only, if it exists. */
function openRow(row: InstanceRow, env: Env): { blocks?: Store; close?(): Promise<void> } {
  const given = env.store?.(row);
  if (given) return { blocks: given };
  if (!existsSync(row.store)) return {};
  const s = openStoreFile(row.store, { readOnly: true });
  return { blocks: s, close: () => s.close() };
}

async function deployCmd(db: HostDb, rest: string[], env: Env): Promise<number> {
  const { values: v, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { all: { type: "boolean" }, only: { type: "string" } } });
  const only = v.only !== undefined ? v.only.split(",").map((x) => x.trim()).filter(Boolean) : undefined;
  let jobs: Array<{ row: InstanceRow; dir: string }>;
  if (v.all) {
    if (positionals.length) { env.err(USAGE); return 2; }
    jobs = [];
    for (const row of db.list("enabled")) {
      if (row.source) jobs.push({ row, dir: row.source });
      else env.out(`${row.handle}: never deployed (no source directory); skipped`);
    }
  } else {
    const [handle, dir] = positionals;
    if (!handle || !dir || positionals.length > 2) { env.err(USAGE); return 2; }
    const row = db.get(handle);
    if (!row) { env.err(`skein-host deploy: no instance ${handle}`); return 1; }
    jobs = [{ row, dir: resolve(dir) }];
  }
  if (!jobs.length) return 0;
  const owner = await ownerOf(env, "skein-host deploy");
  if (typeof owner === "number") return owner;
  // Every ROSTER.md from the IDENTITY.md about to go in, for the rows deployed now.
  const rows = db.list("enabled");
  const fields = identities(env, new Map(jobs.map((j) => [j.row.handle, j.dir])));
  let failed = 0;
  for (const { row, dir } of jobs) {
    const s = openRow(row, env);
    try {
      const files = { "ROSTER.md": (await rosterFor(row, rows, fields)) ?? null };
      const r = await deploy({ row, dir, only, owner: owner.wallet, box: owner.box, store: s.blocks, files });
      db.add(row.handle, { tree: r.root, source: dir });
      env.out(deployedLine(row, r));
    } catch (e) {
      failed++;
      env.err(`${row.handle}: ${(e as Error).message}`);
    } finally {
      await s.close?.();
    }
  }
  return failed ? 1 : 0;
}

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");

export interface RunOptions {
  /** The explorer command: default bin/skein-explore. Tests pass stubs. */
  explore?: { command: string; args?: string[] };
  killAfterMs?: number;
  /** The router's options beyond what the environment gives (tests). */
  router?: Partial<RouterOptions>;
}

export interface Host {
  router: Router;
  supervisor: Supervisor;
  /** handle → its explorer process. */
  explorers: Map<string, { port: number; s: Supervised }>;
  /** The messagebox (router) port and the host page's. */
  messagebox?: number;
  server?: Server;
  port?: number;
  stop(): Promise<void>;
}

/**
 * The oracle (#18, oracle.ts): every instance's wallet is a ProtoWallet over a
 * key derived from the router's master secret (key ID = the handle); the
 * router's BRC-104 identity is another child of it.
 */
function wallets(v: Env["vars"], home: string): Pick<RouterOptions, "walletFor" | "authWallet"> {
  const oracle = new Oracle(masterKey(v, home));
  return { walletFor: (row) => oracle.wallet(row.handle), authWallet: oracle.routerWallet() };
}

/**
 * `skein-host run`: the router (router.ts) on SKEIN_ROUTER_PORT (default
 * 8100, the messagebox URL clients already use), every enabled row hydrated
 * once at start (then stopped when idle), one read-only `skein-explore` per
 * enabled row, and the host page and roster on SKEIN_HOST_PORT.
 */
export async function runHost(db: HostDb, env: Env, o: RunOptions = {}): Promise<Host> {
  const v = env.vars;
  const home = homeOf(v);
  const named = (s: string | undefined, d: string) => { const [handle, domain = "localhost"] = (s || d).split("@"); return { handle: handle!, domain }; };
  const router = new Router({
    db, ...wallets(v, home),
    owner: v.SKEIN_OWNER, infer: v.SKEIN_INFER, ownerHandle: named(v.SKEIN_OWNER_HANDLE, "david@localhost"), inferHandle: named(v.SKEIN_INFER_HANDLE, "infer@localhost"),
    fuelPerStep: v.SKEIN_FUEL_PER_STEP, idleMs: v.SKEIN_IDLE_MS !== undefined ? Number(v.SKEIN_IDLE_MS) : undefined, mailboxHost: v.SKEIN_MAILBOX_HOST,
    kernel: { env: { SKEIN_HOME: home } },
    log: (source, line) => env.out(`[${source}] ${line}`),
    ...o.router,
  });
  const supervisor = new Supervisor({ out: env.out, err: env.err, killAfterMs: o.killAfterMs });
  const explorers = new Map<string, { port: number; s: Supervised }>();
  const enabled = db.list("enabled");
  const mport = Number(v.SKEIN_ROUTER_PORT ?? 8100);
  const mserver = await router.listen(mport).then((s) => s, (e: Error) => { env.err(`skein-host: messagebox: ${e.message}`); return undefined; });
  const messagebox = mserver ? (mserver.address() as { port: number }).port : undefined;
  if (messagebox !== undefined) env.out(`skein-host: messagebox at http://127.0.0.1:${messagebox}/messagebox`);
  await router.start();
  env.out(`skein-host: routing for ${enabled.length} enabled instances (${enabled.map((r) => r.handle).join(", ") || "none"})`);
  const base = v.SKEIN_EXPLORE_BASE_PORT === "off" ? undefined : Number(v.SKEIN_EXPLORE_BASE_PORT || 4610);
  const explore = o.explore ?? { command: join(ROOT, "bin/skein-explore") };
  if (base !== undefined) enabled.forEach((row, i) => {
    const port = base + i;
    explorers.set(row.handle, { port, s: supervisor.add({ name: `${row.handle} explore`, command: explore.command, args: [...(explore.args ?? []), String(port)], env: { ...v, SKEIN_DB: row.store } }) });
  });
  const live = (row: InstanceRow) => router.loaded.has(row.handle);
  const port = Number(v.SKEIN_HOST_PORT || 4600);
  const routerId = await router.o.authWallet.getPublicKey({ identityKey: true }).then((r) => r.publicKey, () => undefined);
  const page = async () => hostPage(db.list("enabled").map((r): HostRow => {
    const l = router.loaded.get(r.handle), x = explorers.get(r.handle);
    return {
      handle: r.handle, domain: r.domain, identity: r.identity ?? "", status: l ? "live" : "idle",
      store: r.store, tree: r.tree ?? "", pid: l?.kernel.proc.pid, restarts: 0, explorer: x ? `http://127.0.0.1:${x.port}/` : undefined,
      wake: router.deadlines.get(r.handle),
    };
  }), { messagebox: messagebox !== undefined ? `http://127.0.0.1:${messagebox}/messagebox` : undefined, router: routerId, mailboxes: db.mailboxes() });
  const server = await serveRoster(port, () => roster(db.list("enabled"), async (row) => openRow(row, env), live), "127.0.0.1", page)
    .then((s) => { env.out(`skein-host: host page at http://127.0.0.1:${(s.address() as { port: number }).port}/ · roster at /roster.json`); return s; }, (e: Error) => { env.err(`skein-host: host server: ${e.message}`); return undefined; });
  return {
    router, supervisor, explorers, messagebox, server, port: server ? (server.address() as { port: number }).port : undefined,
    async stop() {
      server?.close();
      await Promise.all([router.stop(), supervisor.stop()]);
    },
  };
}

/** `skein-host run`: runHost until SIGINT/SIGTERM, then stop every kernel and explorer and exit. */
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
  process.exitCode = await main(process.argv.slice(2), { vars: process.env, out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) });
}

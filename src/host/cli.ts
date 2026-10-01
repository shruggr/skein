#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// `skein-host`: the host's management database (instances.ts, $SKEIN_HOME/host.db)
// and the router (router.ts, #33) that serves every enabled row.
//   skein-host add <handle> [--domain d] [--derive] [--identity hex] [--store path] [--tree cid] [--knows a,b|*] [--disabled]
//   skein-host add <handle> --mailbox --owner <hex>   a mailbox instance (#40) for an identity outside the host
//   skein-host knows <handle> [a,b | --all | --none]
//   skein-host list                   handle, kind, status, identity, front-door key, wallet|owner, store, tree, libp2p peer ID
//   skein-host identity <handle> [--peer]   an instance's identity key (from the master secret); --peer: its libp2p peer ID
//   skein-host mailboxes              the mailbox instances: handle, whose (owner), front-door key, status, store
//   skein-host ledger [handle]        the fuel ledger: what callers' calls (the front doors' reads) cost
//   skein-host enable|disable|remove <handle>
//   skein-host run
//   skein-host deploy <handle> <dir> [--only glob,glob]   |   skein-host deploy --all [--only glob,glob]
//   skein-host roster [--for <handle> | --deploy]
//   skein-host dispatch <handle> add|remove [--sender key] <box> <handler-name-or-cid>
//   skein-host peers <handle> add <key> <address> [--transport mailbox|libp2p|local] [--role r] [--handle h@d] | remove <key> | list
//   skein-host event <handle> <box> [json]
//   skein-host install <repo-url[#rev] | dir> --instance <handle> [--approve-all | --dry-run]
//   skein-host uninstall <app> --instance <handle> [--approve-all]
//   skein-host add <handle> --boot <dir|tree-cid> [--from store.db] | --packet <file> [--scope cid] [--proofs roots.json]
//   skein-host system <dir>
//   skein-host pack <handle|dir|tree-cid> <out> [--from store.db] [--tree cid] [--checkpoint] [--form ordfs|git] [--no-index] [--mined roots.json]
// `add --boot/--packet` runs the loader (boot.ts, #4) on the new row's empty
// store: its objects pre-filled, its genesis from the system tree (or a
// checkpoint restored). `system` writes the stock system as such a tree;
// `pack` writes a packet (packet.ts: synthetic transactions, never broadcast).
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
// instance's store) with the new one. `dispatch` changes a mailbox row of an
// instance's dispatch table (#77) by a message to its `dispatch` box as the
// owner, a kernel operation, as `deploy` sends (a new instance's genesis
// carries only the table's seed: the admin rows and the owner's boxes). `peers` writes an instance's address book (#40: key →
// messagebox URL, handle optional; where it delivers to a key) by messages to
// its `peers` box as the owner, the admin's configuration; `list` reads it
// from the store. `deploy` and `roster --deploy` also write every other
// enabled agent's key and origin into each row's address book that way (the
// roster is a configuration act; ROSTER.md carries the names for the model).
// Nothing registers itself anywhere: a key in no address book is "no route".
// `event` (#60, #69) sends one message from the host's cron provider into a
// box of an instance now, as a tick due now would be (cron.ts): the JSON
// object given, its kind "cron" unless it names one, `due` now; the instance
// takes it by its dispatch row for that box (from the cron provider, or from
// anyone). A store has one kernel: while `run` is up the event goes over its
// control socket ($SKEIN_HOME/host.sock, control.ts) and the running router
// sends it; with the host down, through a router of its own, closed
// afterwards. A router that answers at SKEIN_HOST_URL / SKEIN_ROUTER_PORT
// with no control socket here is refused.
// `install` (#72, #76, #77; install.ts, docs/APPS.md §3) is the owner's client for
// an app: the tree (a directory, or a git URL cloned) and its etc/app.json
// checked, the requests derived and shown (the permission prompt: heads,
// its dispatch rows: boxes and their senders, http paths under /<app>/, libp2p topics; start, requires, provides),
// then — approved (`--approve-all`, or "y" at a terminal) — sent as the owner:
// objects, head (the app record at <app>/app), dispatch per row, start.
// `uninstall` sends the app's stop, then removes its dispatch rows;
// the head is left. Both speak to the row's front door as `deploy` does.
// `run` is the router (#40: a reverse proxy — each
// instance is an HTTP server, its front door, at http://<handle>.localhost:<port>
// or /@<handle>) on SKEIN_ROUTER_PORT, a `skein-kernel serve` per instance
// started on demand and stopped when idle, the providers (the waker, the cron
// provider among them), the oracle, the fuel ledger; plus one read-only
// explorer per enabled row and the host page. It
// reads (bin/skein-host fills it from $SKEIN_HOME):
//   SKEIN_HOME            default ~/.skein; host.db and master.key live here
//   SKEIN_MASTER_KEY      the master secret (hex), else SKEIN_MASTER_KEY_FILE, else $SKEIN_HOME/master.key (made if absent)
//   SKEIN_ROUTER_PORT     the router, default 8100: an instance at http://<handle>.localhost:8100 (or /@<handle>)
//   SKEIN_INSTANCE_ORIGIN an instance's origin template, default http://{handle}.localhost:{port}
//   SKEIN_OWNER_MESSAGEBOX the owner's messagebox URL for new geneses, default its mailbox instance here
//   SKEIN_IDLE_MS         stop a kernel this long after its last work (ms); default 0: never (#40)
//   SKEIN_OWNER           a new instance's owner;   SKEIN_OWNER_HANDLE its genesis name, default david@localhost
//   SKEIN_INFER           a new instance's peers.infer;   SKEIN_INFER_HANDLE its genesis name, default infer@localhost
//   SKEIN_FUEL_PER_STEP   a new genesis's fuelPerStep
//   SKEIN_HOST_PORT       the host page (/) and roster (/roster.json) on 127.0.0.1, default 4600
//   SKEIN_EXPLORE_BASE_PORT  row i's explorer (skein-explore) listens on base + i (i: its place among the enabled rows);
//                         default 4610; "off" starts none
//   SKEIN_KERNEL_BIN      the kernel binary, default kernel-zig/zig-out/bin/skein-kernel
//   SKEIN_ARC_URL         the host's Arcade (#58, #65, arc.ts): where the instances' broadcast events go (a durable
//                         queue), one status subscription, the instances' status provider; SKEIN_ARC_TOKEN its one callback token (required with it);
//                         SKEIN_ARC_EVENTS_URL its SSE service (default <url>/events); SKEIN_ARC_CALLBACK_URL where Arcade
//                         posts webhooks (this router's /arc/callback as Arcade reaches it; unset: SSE only).
//                         Also read from $SKEIN_HOME/host.env (SKEIN_ARC_* lines)
// `deploy`, `dispatch` and `peers` speak raw BRC-33 to the row's front door, at SKEIN_HOST_URL
// (default http://127.0.0.1:8100) /@<handle>, as the owner — SKEIN_OWNER (checked against the wallet):
//   SKEIN_OWNER_WALLET    default http://127.0.0.1:3322;   SKEIN_ORIGINATOR default skein-client

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { CID } from "multiformats/cid";
import { CID as CIDClass, decode as decodeCbor, parse as parseCid } from "../runtime/cid.ts";
import { DatabaseSync } from "node:sqlite";
import { headTree, MAIN } from "../runtime/heads.ts";
import { anyOf, dirSource, MemBlocks, packetSource, stockSystemFiles, storeObjects, wasmDirObjects, type BootSource, type Objects } from "./boot.ts";
import { Kernel } from "./kernel.ts";
import type { Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { short } from "../runtime/log.ts";
import { openStoreFile } from "../runtime/index-store.ts";
import { rootIdentity } from "../runtime/identity.ts";
import type { Store } from "../runtime/store.ts";
import { remoteWallet, type WalletInterface } from "../wallet.ts";
import { masterKey, Oracle } from "./oracle.ts";
import { CONTROL_SOCKET, controlRequest } from "./control.ts";
import { hostArcConfig } from "./arc.ts";
import { hostP2PConfig, peerIdOf } from "./p2p.ts";
import { dispatchBody } from "../client/client.ts";
import { addressBook, DEFAULT_ONLY, deploy, deployFiles, dispatchRow, writeAddresses, type AddressEntry, type Deployed } from "./deploy.ts";
import { Supervisor, type Supervised } from "./supervisor.ts";
import { noOwnerMessagebox, Router, type RouterOptions } from "./router.ts";
import { HostDb, knowsColumn, knowsOf, type InstanceRow, type RowFields } from "./instances.ts";
import { RawBox } from "../client/raw.ts";
import type { Outbox } from "./deploy.ts";
import { deployedIdentity, hostPage, parseIdentity, roster, rosterFor, serveRoster, type HostRow, type IdentityFields } from "./roster.ts";

export interface Env {
  vars: Record<string, string | undefined>;
  out(line: string): void;
  err(line: string): void;
  /** Tests: the owner's wallet and its sessions with the rows `deploy` uses instead of SKEIN_OWNER_WALLET / SKEIN_HOST_URL. */
  owner?: { wallet: WalletInterface; box(row: InstanceRow): Outbox };
  /** Tests: a row's store, instead of opening its file read-only. */
  store?(row: InstanceRow): Store | undefined;
}

const USAGE = `usage:
  skein-host add <handle> [--domain d] [--derive] [--identity hex] [--store path] [--tree cid] [--knows a,b|*] [--disabled]
  skein-host add <handle> --mailbox --owner <hex>         a mailbox instance for an identity outside the host (#40)
  skein-host knows <handle> [a,b | --all | --none]        which agents its ROSTER.md lists; no list: print them
  skein-host list                                         handle, kind, status, identity, front-door key, wallet|owner, store, tree, libp2p peer ID
  skein-host identity <handle> [--peer]                   an instance's identity key; --peer: its libp2p peer ID (#51)
  skein-host mailboxes                                    the mailbox instances: handle, owner, front-door key, status, store
  skein-host ledger [handle]                              the fuel ledger: calls and fuel per instance, caller, op
  skein-host enable|disable|remove <handle>
  skein-host run                                          the router on :8100 (instances at <handle>.localhost:8100), a kernel per instance on demand; host page and roster on :4600
  skein-host deploy <handle> <dir> [--only glob,glob]     default --only ${DEFAULT_ONLY.join(",")}
  skein-host deploy --all [--only glob,glob]              every enabled row, from its last deployed directory
  skein-host roster                                       the front end's roster JSON
  skein-host roster --for <handle>                        that agent's ROSTER.md
  skein-host roster --deploy                              redeploy every enabled row whose ROSTER.md changed
  skein-host dispatch <handle> add|remove [--sender key] <box> <handler-name-or-cid>   a mailbox row of the dispatch table (#77): (sender, box) → handler
  skein-host peers <handle> add <key> <address> [--transport mailbox|libp2p|local] [--role r] [--handle h@d]   an address-book entry (#70): how the agent reaches <key> (mailbox: a URL; libp2p: a peer ID or topic:<name>; local: a provider)
  skein-host peers <handle> remove <key>
  skein-host peers <handle> list                          its address book: key, transport, address, role, handle, source
  skein-host install <repo-url[#rev] | dir> --instance <handle> [--approve-all | --dry-run]   an app (docs/APPS.md): check, show what it asks for, send as the owner
  skein-host uninstall <app> --instance <handle> [--approve-all]                          its stop, then its dispatch rows removed (the heads are left)
  skein-host event <handle> <box> [json]                  a message from the cron provider into <box> now, as a tick due now ({...json, kind: "cron" unless named, due: now}); through the running router's control socket, else a router of its own
  skein-host add <handle> --boot <dir | tree-cid [--from store.db]>          boot a new instance from a system tree (docs/BOOTSTRAP.md)
  skein-host add <handle> --packet <file> [--scope cid] [--proofs roots.json]   … from a packet: a system tree, or a checkpoint to restore
  skein-host system <dir>                                 write the stock system (what code genesis has) as a system tree
  skein-host pack <handle|dir|tree-cid> <out> [--from store.db] [--tree cid] [--checkpoint] [--form ordfs|git] [--no-index] [--mined roots.json]`;

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
          options: {
            domain: { type: "string" }, identity: { type: "string" }, derive: { type: "boolean" }, "wallet-url": { type: "string" }, originator: { type: "string" }, store: { type: "string" }, tree: { type: "string" }, knows: { type: "string" }, disabled: { type: "boolean" },
            boot: { type: "string" }, from: { type: "string" }, packet: { type: "string" }, scope: { type: "string" }, proofs: { type: "string" },
            mailbox: { type: "boolean" }, owner: { type: "string" },
          },
        });
        if (!handle) { env.err(USAGE); return 2; }
        const f: RowFields = { domain: v.domain, identity: v.identity, wallet_url: v["wallet-url"], wallet_originator: v.originator, store: v.store, tree: v.tree, status: v.disabled ? "disabled" : undefined };
        if (v.knows !== undefined) f.knows = knowsColumn(handles(v.knows));
        if (v.mailbox) {
          // A mailbox instance (#40): the front door and the messagebox, keeping mail for --owner.
          if (!v.owner || !/^0[23][0-9a-f]{64}$/.test(v.owner)) { env.err("skein-host add --mailbox: --owner <identity key, hex>"); return 2; }
          const other = db.mailboxOf(v.owner);
          if (other && other.handle !== handle) { env.err(`skein-host add --mailbox: ${short(v.owner)} already has a mailbox instance, ${other.handle}`); return 1; }
          f.kind = "mailbox";
          f.owner = v.owner;
        } else if (v.owner) { env.err("skein-host add: --owner goes with --mailbox"); return 2; }
        if (!db.get(handle)) f.store ??= join(home, "instances", handle, "runtime.db");
        // The identity is the oracle's (#18): derived from the master secret, key ID = the handle.
        if (f.identity === undefined && (v.derive || !db.get(handle)?.identity)) f.identity = new Oracle(masterKey(env.vars, home)).identity(handle);
        if (v.boot && v.packet) { env.err("skein-host add: --boot or --packet, not both"); return 2; }
        const r = db.add(handle, f);
        env.out(`${r.handle}@${r.domain} ${r.status} · store ${r.store}${r.wallet_url ? ` · wallet ${r.wallet_url}` : ""}${r.identity ? ` · ${short(r.identity)}` : ""}`);
        if (v.boot || v.packet) {
          // The loader (#4): pre-fill the new store and write its genesis from the tree (or restore a checkpoint).
          // A one-shot (#61): the router it boots through is closed before `add` returns, so the process exits.
          const router = new Router({ ...routerOptions(db, env), idleMs: 0 });
          try {
            const src = await bootSourceOf(v, r);
            const b = await router.bootRow(handle, src);
            env.out(b.state ? `${handle}: restored checkpoint ${b.state} (${b.objects} blocks)` : `${handle}: booted from ${b.tree} · ${b.objects} objects pre-filled · programs ${b.programs.join(", ")} · genesis ${b.entry}`);
          } catch (e) {
            env.err(`skein-host add ${handle}: ${(e as Error).message}`);
            return 1;
          } finally {
            await router.close();
          }
        }
        return 0;
      }
      case "identity": {
        // The oracle's key (oracle.ts) for an instance: the BRC-104 identity its front door answers as.
        const [handle, flag, ...more] = rest;
        if (!handle || more.length || (flag !== undefined && flag !== "--peer")) { env.err(USAGE); return 2; }
        const oracle = new Oracle(masterKey(env.vars, home));
        // The libp2p peer ID (#51): the identity multihash of the peer key, a child of the master with key ID libp2p:<handle>.
        env.out(flag ? peerIdOf(oracle.peerKey(handle)).toString() : oracle.identity(handle));
        return 0;
      }
      case "mailboxes": {
        const door = frontDoorKeys(env.vars, home);
        for (const r of db.list().filter((x) => x.kind === "mailbox")) env.out([`${r.handle}@${r.domain}`, r.owner ?? "-", door(r), r.status, r.store].join("\t"));
        return 0;
      }
      case "ledger":
        for (const l of db.ledger(rest[0])) env.out([l.instance, l.caller || "-", l.op, String(l.calls), String(l.fuel), l.updated_at].join("\t"));
        return 0;
      case "list": {
        const door = frontDoorKeys(env.vars, home);
        const peer = peerIds(env.vars, home);
        for (const r of db.list()) env.out([`${r.handle}@${r.domain}`, r.kind ?? "agent", r.status, r.identity ?? "-", door(r), r.kind === "mailbox" ? `owner ${r.owner}` : r.wallet_url ?? "-", r.store, r.tree ?? "-", peer(r)].join("\t"));
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
      case "deploy":
        return await deployCmd(db, rest, env);
      case "knows":
        return knowsCmd(db, rest, env);
      case "roster":
        return await rosterCmd(db, rest, env);
      case "dispatch":
        return await dispatchCmd(db, rest, env);
      case "peers":
        return await peersCmd(db, rest, env);
      case "event":
        return await eventCmd(db, rest, env);
      case "install":
        return await installCmd(db, rest, env);
      case "uninstall":
        return await uninstallCmd(db, rest, env);
      case "system":
        return await systemCmd(rest, env);
      case "pack":
        return await packCmd(db, rest, env);
      default:
        env.err(USAGE);
        return 2;
    }
  } finally {
    if (cmd !== "run") db.close(); // run keeps it (and closes it on a signal)
  }
}

const handles = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

/**
 * The key each row's front door signs its BRC-104 sessions with (#40): the
 * oracle's, derived from the master secret with key ID = the handle — for an
 * agent and a mailbox instance alike, and before the row was ever hydrated.
 * The master secret is only read here, never made: with none, "-".
 */
function frontDoorKeys(vars: Env["vars"], home: string): (row: InstanceRow) => string {
  const file = vars.SKEIN_MASTER_KEY_FILE || join(home, "master.key");
  if (!vars.SKEIN_MASTER_KEY && !existsSync(file)) return () => "-";
  const oracle = new Oracle(masterKey(vars, home));
  return (row) => oracle.identity(row.handle);
}

/** Each row's libp2p peer ID (#51): derived from the master secret (key ID libp2p:<handle>), whether or not it runs a node; "-" with no master secret. */
function peerIds(vars: Env["vars"], home: string): (row: InstanceRow) => string {
  const file = vars.SKEIN_MASTER_KEY_FILE || join(home, "master.key");
  if (!vars.SKEIN_MASTER_KEY && !existsSync(file)) return () => "-";
  const oracle = new Oracle(masterKey(vars, home));
  return (row) => peerIdOf(oracle.peerKey(row.handle)).toString();
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

async function dispatchCmd(db: HostDb, rest: string[], env: Env): Promise<number> {
  const { values: v, positionals: [handle, op, box, handler, ...more] } = parseArgs({ args: rest, allowPositionals: true, options: { sender: { type: "string" } } });
  if (!handler || more.length || (op !== "add" && op !== "remove")) { env.err(USAGE); return 2; }
  const row = db.get(handle!);
  if (!row) { env.err(`skein-host dispatch: no instance ${handle}`); return 1; }
  const owner = await ownerOf(env, "skein-host dispatch");
  if (typeof owner === "number") return owner;
  const s = openRow(row, env);
  try {
    await dispatchRow({ row, owner: owner.wallet, box: owner.box(row), store: s.blocks }, dispatchBody({ op, sender: v.sender, box: box!, handler }, await genesisPrograms(s.blocks)));
    env.out(`${row.handle}: dispatch ${op} (mailbox ${box}, ${v.sender ? short(v.sender) : "anyone"}) → ${handler} sent`);
    return 0;
  } catch (e) {
    env.err(`${row.handle}: ${(e as Error).message}`);
    return 1;
  } finally {
    await s.close?.();
  }
}

/**
 * An instance's origin here (router.ts originOf): its front door, its
 * messagebox — SKEIN_INSTANCE_ORIGIN (default http://{handle}.localhost:{port})
 * on SKEIN_ROUTER_PORT (default 8100).
 */
export function originOf(vars: Env["vars"], handle: string): string {
  return (vars.SKEIN_INSTANCE_ORIGIN || "http://{handle}.localhost:{port}").replace("{handle}", handle).replace("{port}", vars.SKEIN_ROUTER_PORT || "8100");
}

/** The other enabled agents, as `row`'s address book should have them: key, origin, handle. */
function agentAddresses(row: InstanceRow, rows: InstanceRow[], vars: Env["vars"]): Array<{ op: "add" } & AddressEntry> {
  return rows.filter((r) => r.handle !== row.handle && r.kind !== "mailbox" && r.identity).map((r) => ({ op: "add" as const, key: r.identity!, transport: "mailbox" as const, address: originOf(vars, r.handle), handle: r.handle, domain: r.domain }));
}

/** Write the other agents into `row`'s address book (unchanged entries are not sent); a line saying what was sent, if anything. */
async function syncAgents(row: InstanceRow, rows: InstanceRow[], owner: { wallet: WalletInterface; box(row: InstanceRow): Outbox }, store: Store | undefined, env: Env): Promise<void> {
  const want = agentAddresses(row, rows, env.vars);
  if (!want.length) return;
  const r = await writeAddresses({ row, owner: owner.wallet, box: owner.box(row), store }, want);
  const sent = want.filter((_, i) => r[i] === "sent").map((w) => w.handle);
  if (sent.length) env.out(`${row.handle}: address book: ${sent.join(", ")} written`);
}

async function peersCmd(db: HostDb, rest: string[], env: Env): Promise<number> {
  const { values: v, positionals: [handle, op, key, url, ...more] } = parseArgs({ args: rest, allowPositionals: true, options: { handle: { type: "string" }, transport: { type: "string" }, role: { type: "string" } } });
  const shape = op === "list" ? !key : op === "remove" ? !!key && !url : op === "add" ? !!key && !!url : false;
  if (!handle || more.length || !shape || ((v.handle !== undefined || v.transport !== undefined || v.role !== undefined) && op !== "add")) { env.err(USAGE); return 2; }
  const transport = (v.transport ?? "mailbox") as AddressEntry["transport"];
  if (!["mailbox", "libp2p", "local"].includes(transport)) { env.err(`skein-host peers: --transport is mailbox, libp2p or local`); return 2; }
  const row = db.get(handle);
  if (!row) { env.err(`skein-host peers: no instance ${handle}`); return 1; }
  if (row.kind === "mailbox") { env.err(`skein-host peers: ${handle} is a mailbox instance: it keeps mail, it sends nothing`); return 1; }
  const s = openRow(row, env);
  try {
    if (op === "list") {
      for (const e of await addressBook(s.blocks)) env.out([e.key, e.transport, e.address, e.role ?? "-", e.handle ? `${e.handle}@${e.domain ?? ""}` : "-", e.source ?? "-"].join("\t"));
      return 0;
    }
    if (!/^0[23][0-9a-f]{64}$/.test(key!)) { env.err(`skein-host peers: ${key} is not an identity key (hex)`); return 2; }
    if (op === "add" && transport === "mailbox" && !/^https?:\/\/[^/]/.test(url!)) { env.err(`skein-host peers: ${url} is not an http(s) URL`); return 2; }
    let named: { handle?: string; domain?: string } = {};
    if (v.handle !== undefined) {
      const at = v.handle.replace(/^@/, "").lastIndexOf("@");
      const h = v.handle.replace(/^@/, "");
      named = at > 0 ? { handle: h.slice(0, at), domain: h.slice(at + 1) } : { handle: h, domain: row.domain };
      if (!named.handle || !named.domain) { env.err(`skein-host peers: --handle ${v.handle}: want handle@domain`); return 2; }
    }
    const owner = await ownerOf(env, "skein-host peers");
    if (typeof owner === "number") return owner;
    const change = op === "add" ? { op: "add" as const, key: key!, transport, address: url!, ...(v.role ? { role: v.role } : {}), ...named } : { op: "remove" as const, key: key! };
    const [r] = await writeAddresses({ row, owner: owner.wallet, box: owner.box(row), store: s.blocks }, [change]);
    env.out(`${row.handle}: peers ${op} ${short(key!)}${op === "add" ? ` → ${url}${named.handle ? ` (@${named.handle}@${named.domain})` : ""}` : ""}: ${r === "sent" ? "sent" : "unchanged (the address book has it so already)"}`);
    return 0;
  } catch (e) {
    env.err(`${row.handle}: ${(e as Error).message}`);
    return 1;
  } finally {
    await s.close?.();
  }
}

/**
 * `skein-host event <handle> <box> [json]` (#60, #69): one message from the
 * host's cron provider into `box` now — what a tick due now is
 * (Router.cronEvent: signed by the provider, appended as a `local` request).
 * While `skein-host run` is up, its kernel holds the instance's store, so the
 * event goes to that router over its control socket ($SKEIN_HOME/host.sock)
 * and it sends it. Otherwise it goes through a router of this command's own, a
 * one-shot's (no ticks, #61's close): the steps it starts run before that
 * router is closed. A router answering for the host on HTTP with no control
 * socket here (another SKEIN_HOME, or a router from before the socket) is
 * refused: a second kernel must not write the store.
 */
async function eventCmd(db: HostDb, rest: string[], env: Env): Promise<number> {
  const [handle, box, json, ...more] = rest;
  if (!handle || !box || more.length) { env.err(USAGE); return 2; }
  const row = db.get(handle);
  if (!row) { env.err(`skein-host event: no instance ${handle}`); return 1; }
  if (row.status !== "enabled") { env.err(`skein-host event: ${handle} is disabled`); return 1; }
  let given: unknown = {};
  if (json !== undefined) {
    try { given = JSON.parse(json); } catch (e) { env.err(`skein-host event: the event is not JSON: ${(e as Error).message}`); return 2; }
  }
  if (!given || typeof given !== "object" || Array.isArray(given)) { env.err("skein-host event: the event is a JSON object"); return 2; }
  const event = given as Record<string, unknown>;
  const kind = String(event.kind ?? "cron");
  // The running router, over its control socket: it admits with the kernel it holds.
  const sock = join(homeOf(env.vars), CONTROL_SOCKET);
  let answer;
  try {
    answer = await controlRequest(sock, { op: "event", handle, box, event });
  } catch (e) {
    env.err(`skein-host event ${handle}: the router's control socket: ${(e as Error).message}`);
    return 1;
  }
  if (answer) {
    if (!answer.ok) { env.err(`skein-host event ${handle}: ${answer.error}`); return 1; }
    env.out(`${handle}: ${kind} from the cron provider into ${box} as ${answer.entry} (by the running router)`);
    return 0;
  }
  const running = await routerAt(env.vars);
  if (running) {
    env.err(`skein-host event: a router serves this host at ${running}, but no control socket answers at ${sock} (another SKEIN_HOME, or a router started before the socket): its kernel holds ${handle}'s store, and a second one must not write it. Run this with the router's SKEIN_HOME, or restart the router`);
    return 1;
  }
  const router = new Router({ ...routerOptions(db, env), idleMs: 0, cron: false });
  try {
    const e = await router.cronEvent(handle, box, event);
    await router.settled();
    env.out(`${handle}: ${kind} from the cron provider into ${box} as ${e}`);
    return 0;
  } catch (e) {
    env.err(`skein-host event ${handle}: ${(e as Error).message}`);
    return 1;
  } finally {
    await router.close();
  }
}

/** The owner's yes: `--approve-all`, else "y" at a terminal; refused when neither can be had. */
async function approved(v: { "approve-all"?: boolean }, env: Env, what: string): Promise<boolean> {
  if (v["approve-all"]) return true;
  if (!process.stdin.isTTY || env.owner) { env.err(`${what}: not approved (--approve-all, or run it at a terminal to answer the prompt)`); return false; }
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await rl.question(`${what}? [y/N] `)).trim()); } finally { rl.close(); }
}

/** `skein-host install <repo-url | dir> --instance <handle>` (#72, #76): install.ts. */
async function installCmd(db: HostDb, rest: string[], env: Env): Promise<number> {
  const { values: v, positionals: [spec, ...more] } = parseArgs({ args: rest, allowPositionals: true, options: { instance: { type: "string" }, "approve-all": { type: "boolean" }, "dry-run": { type: "boolean" } } });
  if (!spec || more.length || !v.instance) { env.err(USAGE); return 2; }
  const row = db.get(v.instance);
  if (!row) { env.err(`skein-host install: no instance ${v.instance}`); return 1; }
  if (row.kind === "mailbox") { env.err(`skein-host install: ${row.handle} is a mailbox instance`); return 1; }
  const s = openRow(row, env);
  try {
    if (!s.blocks) throw new Error(`no store at ${row.store} yet (run the instance once)`);
    const { fetchApp, readApp, instanceView, planInstall, describe, sendInstall } = await import("./install.ts");
    const tree = await readApp(fetchApp(spec));
    const plan = await planInstall(tree, await instanceView(s.blocks), { modules: wasmDirObjects(WASM_DIR) });
    for (const l of describe(plan)) env.out(l);
    if (v["dry-run"]) return 0;
    if (!(await approved(v, env, `install ${plan.app} into ${row.handle}`))) return 1;
    const owner = await ownerOf(env, "skein-host install");
    if (typeof owner === "number") return owner;
    const box = owner.box(row);
    const r = await sendInstall(plan, (b, body) => box.send(row.identity!, b, body));
    env.out(`${row.handle}: ${plan.app} ${plan.version} ${plan.upgrade ? "upgraded" : "installed"}: ${r.messages} messages sent as the owner · head ${plan.app}/app → ${plan.recordCid}`);
    return 0;
  } catch (e) {
    env.err(`skein-host install: ${(e as Error).message}`);
    return 1;
  } finally {
    await s.close?.();
  }
}

/** `skein-host uninstall <app> --instance <handle>` (#72, #76, #77): stop, then its dispatch rows removed. */
async function uninstallCmd(db: HostDb, rest: string[], env: Env): Promise<number> {
  const { values: v, positionals: [app, ...more] } = parseArgs({ args: rest, allowPositionals: true, options: { instance: { type: "string" }, "approve-all": { type: "boolean" } } });
  if (!app || more.length || !v.instance) { env.err(USAGE); return 2; }
  const row = db.get(v.instance);
  if (!row) { env.err(`skein-host uninstall: no instance ${v.instance}`); return 1; }
  const s = openRow(row, env);
  try {
    if (!s.blocks) throw new Error(`no store at ${row.store}`);
    const { instanceView, planUninstall, sendUninstall } = await import("./install.ts");
    const p = await planUninstall(app, await instanceView(s.blocks));
    env.out(`uninstall ${app} ${p.record.version}${p.stop ? ` · stop ${JSON.stringify(p.stop)}` : ""} · dispatch remove ×${p.rows.length} · head ${app}/app left`);
    if (!(await approved(v, env, `uninstall ${app} from ${row.handle}`))) return 1;
    const owner = await ownerOf(env, "skein-host uninstall");
    if (typeof owner === "number") return owner;
    const box = owner.box(row);
    const r = await sendUninstall(p, (b, body) => box.send(row.identity!, b, body));
    env.out(`${row.handle}: ${app} uninstalled: ${r.messages} messages sent as the owner`);
    return 0;
  } catch (e) {
    env.err(`skein-host uninstall: ${(e as Error).message}`);
    return 1;
  } finally {
    await s.close?.();
  }
}

/** The URL of a router answering for this host (its /manifest.json), if one does. */
async function routerAt(vars: Env["vars"]): Promise<string | undefined> {
  const base = (vars.SKEIN_HOST_URL || `http://127.0.0.1:${vars.SKEIN_ROUTER_PORT || 8100}`).replace(/\/+$/, "");
  try {
    const r = await fetch(`${base}/manifest.json`, { signal: AbortSignal.timeout(2000) });
    const m = await r.json() as { metanet?: unknown };
    return r.ok && m?.metanet ? base : undefined;
  } catch { return undefined; }
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
    if (row.kind === "mailbox") continue;
    const s = openRow(row, env);
    try {
      // The address book first (the other agents' keys and origins): it needs no tree.
      await syncAgents(row, rows, owner, s.blocks, env);
      if (!row.tree) { env.out(`${row.handle}: never deployed; ROSTER.md skipped`); continue; }
      if (!s.blocks) throw new Error(`no store at ${row.store}: deploy the directory instead`);
      const r = await deployFiles({ row, owner: owner.wallet, box: owner.box(row), store: s.blocks, files: { "ROSTER.md": (await rosterFor(row, rows, fields)) ?? null } });
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
  : `${row.handle}: deployed ${r.root} · ${r.records} objects in ${r.bundles} message(s) to objects${r.head ? " · head main" : ""}`;

/** The owner's wallet and its sessions with the rows' front doors (env.owner in tests), checked against SKEIN_OWNER; else an exit code. */
async function ownerOf(env: Env, cmd: string): Promise<{ wallet: WalletInterface; box(row: InstanceRow): Outbox } | number> {
  let owner = env.owner;
  if (!owner) {
    const host = (env.vars.SKEIN_HOST_URL || `http://127.0.0.1:${env.vars.SKEIN_ROUTER_PORT || 8100}`).replace(/\/+$/, "");
    const wallet = remoteWallet(env.vars.SKEIN_OWNER_WALLET || "http://127.0.0.1:3322", env.vars.SKEIN_ORIGINATOR || "skein-client");
    owner = { wallet, box: (row) => new RawBox(wallet, `${host}/@${row.handle}`, { originator: env.vars.SKEIN_ORIGINATOR || "skein-client" }) };
    void cmd;
  }
  const me = await rootIdentity(owner.wallet);
  if (env.vars.SKEIN_OWNER && env.vars.SKEIN_OWNER !== me) {
    env.err(`${cmd}: the owner wallet is ${short(me)}, not SKEIN_OWNER ${short(env.vars.SKEIN_OWNER)}: instances would not admit what it signs`);
    return 1;
  }
  return owner;
}

/** An agent whose store's genesis names no owner messagebox: the warning (router.ts noOwnerMessagebox); else undefined. */
async function ownerMessageboxWarning(row: InstanceRow, store: Store | undefined): Promise<string | undefined> {
  if (row.kind === "mailbox" || !store) return undefined;
  try {
    for await (const { entry } of store.log.entries(0)) {
      const g = (entry as { genesis?: CID }).genesis;
      return g ? noOwnerMessagebox(await store.get(g) as Record<string, unknown>) : undefined;
    }
  } catch { /* a store this build cannot read: the router says so at hydration */ }
  return undefined;
}

/** The programs a store's genesis names (name → program record CID): what `dispatch` resolves a handler name against. */
async function genesisPrograms(store: Store | undefined): Promise<Record<string, CID>> {
  if (!store) return {};
  for await (const { entry } of store.log.entries(0)) {
    const g = (entry as { genesis?: CID }).genesis;
    const programs = g ? (await store.get(g) as Record<string, unknown>).programs : undefined;
    return programs && typeof programs === "object" ? programs as Record<string, CID> : {};
  }
  return {};
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
      await syncAgents(row, rows, owner, s.blocks, env);
      const r = await deploy({ row, dir, only, owner: owner.wallet, box: owner.box(row), store: s.blocks, files });
      db.add(row.handle, { tree: r.root, source: dir });
      env.out(deployedLine(row, r));
      const w = await ownerMessageboxWarning(row, s.blocks);
      if (w) env.err(`${row.handle}: ${w}`);
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
 * router's BRC-104 identity is another child of it, and so are its providers'
 * keys (#70: the HTTP proxy, the waker, the cron provider, the libp2p node, the status provider).
 */
function wallets(v: Env["vars"], home: string): Pick<RouterOptions, "walletFor" | "peerKeyFor" | "providerKeyFor"> {
  const oracle = new Oracle(masterKey(v, home));
  return { walletFor: (row) => oracle.wallet(row.handle), peerKeyFor: (handle) => oracle.peerKey(handle), providerKeyFor: (name) => oracle.providerKey(name) };
}

/** The router's options from the environment (`run`, and `add --boot/--packet`, which boots through it). */
function routerOptions(db: HostDb, env: Env): RouterOptions {
  const v = env.vars;
  const home = homeOf(v);
  const named = (s: string | undefined, d: string) => { const [handle, domain = "localhost"] = (s || d).split("@"); return { handle: handle!, domain }; };
  return {
    db, ...wallets(v, home),
    owner: v.SKEIN_OWNER, infer: v.SKEIN_INFER, ownerHandle: named(v.SKEIN_OWNER_HANDLE, "david@localhost"), inferHandle: named(v.SKEIN_INFER_HANDLE, "infer@localhost"),
    fuelPerStep: v.SKEIN_FUEL_PER_STEP, idleMs: v.SKEIN_IDLE_MS !== undefined ? Number(v.SKEIN_IDLE_MS) : undefined, home,
    instanceOrigin: v.SKEIN_INSTANCE_ORIGIN, ownerMessagebox: v.SKEIN_OWNER_MESSAGEBOX, port: Number(v.SKEIN_ROUTER_PORT ?? 8100),
    kernel: { command: v.SKEIN_KERNEL_BIN, env: { SKEIN_HOME: home } },
    libp2p: hostP2PConfig(v, home),
    arc: hostArcConfig(v, home),
    log: (source, line) => env.out(`[${source}] ${line}`),
  };
}

// ---------------------------------------------------------------- bootstrap (#4)

const WASM_DIR = join(ROOT, "wasm");

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
  if (existsSync(spec) && statSync(spec).isDirectory()) {
    const d = await dirSource(resolve(spec));
    return { kind: "tree", root: d.root, objects: anyOf(d.objects, wasmDirObjects(WASM_DIR)) };
  }
  const root = parseCid(spec);
  const path = v.from ?? row.store;
  if (!existsSync(path)) throw new Error(`--boot ${spec}: no store at ${path} to read the tree from (--from)`);
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

/** `skein-host system <dir>`: the stock system (what code genesis writes) as a system tree to start from. */
async function systemCmd(rest: string[], env: Env): Promise<number> {
  const [dir, ...more] = rest;
  if (!dir || more.length) { env.err(USAGE); return 2; }
  const tmp = mkdtempSync(join(tmpdir(), "skein-system-"));
  const k = new Kernel({ db: join(tmp, "k.db"), handle: "system", domain: "localhost", command: env.vars.SKEIN_KERNEL_BIN, env: { SKEIN_HOME: tmp } });
  try {
    const files = await stockSystemFiles(k);
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), text);
    }
    env.out(`${dir}: ${Object.keys(files).length} files (${Object.keys(files).filter((f) => f.endsWith(".cid")).length} programs, etc/config.json, etc/dispatch.json)`);
    return 0;
  } finally {
    await k.stop(5000);
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** An index node or a state record (#30): history a checkpoint leaves behind (dump.zig isIndexBlock). */
function isIndexBlock(cid: CID, bytes: Uint8Array): boolean {
  if (cid.code !== 0x71) return false;
  let v: unknown;
  try { v = decodeCbor(bytes); } catch { return false; }
  if (v && typeof v === "object" && !Array.isArray(v)) return (v as { kind?: unknown }).kind === "skein-state";
  if (!Array.isArray(v) || v.length !== 2 || !Array.isArray(v[1]) || (v[0] !== null && !CIDClass.asCID(v[0]))) return false;
  return v[1].length > 0 && v[1].every((e: unknown) => Array.isArray(e) && e.length === 3 && e[0] instanceof Uint8Array && (e[2] === null || !!CIDClass.asCID(e[2])));
}

/** Every block of a store file except the index's (nodes and state records): a checkpoint's extras candidates. */
function looseRecords(path: string): Array<{ cid: CID; bytes: Uint8Array }> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const out: Array<{ cid: CID; bytes: Uint8Array }> = [];
    for (const r of db.prepare("SELECT cid, bytes FROM blocks").all() as Array<{ cid: Uint8Array; bytes: Uint8Array }>) {
      const cid = CIDClass.decode(new Uint8Array(r.cid));
      const bytes = new Uint8Array(r.bytes);
      if (!isIndexBlock(cid, bytes)) out.push({ cid, bytes });
    }
    return out;
  } finally { db.close(); }
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
    if (!existsSync(row.store)) { env.err(`skein-host pack: ${row.handle} has no store yet`); return 1; }
    const s = openStoreFile(row.store, { readOnly: true }) as ReturnType<typeof openStoreFile> & { state?(): { cid: CID } };
    close = () => s.close();
    objects = anyOf(storeObjects(s), wasmDirObjects(WASM_DIR));
    if (v.checkpoint) {
      if (!s.state) { env.err(`skein-host pack: ${row.handle}'s store predates the state record (#30)`); close(); return 1; }
      scope = s.state().cid;
      extras = looseRecords(row.store);
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
 * once at start (then stopped when idle), one read-only `skein-explore` per
 * enabled row, and the host page and roster on SKEIN_HOST_PORT.
 */
export async function runHost(db: HostDb, env: Env, o: RunOptions = {}): Promise<Host> {
  const v = env.vars;
  const home = homeOf(v);
  const router = new Router({ ...routerOptions(db, env), ...o.router });
  const supervisor = new Supervisor({ out: env.out, err: env.err, killAfterMs: o.killAfterMs });
  const explorers = new Map<string, { port: number; s: Supervised }>();
  const enabled = db.list("enabled");
  const mport = Number(v.SKEIN_ROUTER_PORT ?? 8100);
  const mserver = await router.listen(mport).then((s) => s, (e: Error) => { env.err(`skein-host: router: ${e.message}`); return undefined; });
  // The control socket (#60): `skein-host event` reaches this router's kernels through it.
  const sock = join(home, CONTROL_SOCKET);
  await router.listenControl(sock).then(() => env.out(`skein-host: control socket at ${sock}`), (e: Error) => env.err(`skein-host: control socket: ${e.message}`));
  const messagebox = mserver ? (mserver.address() as { port: number }).port : undefined;
  if (messagebox !== undefined) env.out(`skein-host: router at http://127.0.0.1:${messagebox} · an instance at ${router.originOf("<handle>")} (or /@<handle>)`);
  const omb = router.ownerMessagebox();
  if (omb) env.out(`skein-host: the owner's messagebox for new geneses: ${omb}`);
  else if (v.SKEIN_OWNER) env.err(`skein-host: WARNING: the owner ${short(v.SKEIN_OWNER)} has no mailbox instance here and SKEIN_OWNER_MESSAGEBOX is unset: a new agent's genesis names no owner messagebox, and its answers cannot be delivered (scripts/host/up.sh makes the mailbox first)`);
  if (router.arc) env.out(`skein-host: broadcaster: broadcast events → Arcade ${router.o.arc!.url}; proofs and statuses (the status provider) from ${router.arc.eventsUrl()}${router.o.arc!.callbackUrl ? ` and webhooks at /arc/callback (${router.o.arc!.callbackUrl})` : ""}`);
  else env.out("skein-host: no Arcade (SKEIN_ARC_URL): a broadcast event is dropped; a new genesis names no status provider");
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
  const page = async () => hostPage(db.list("enabled").map((r): HostRow => {
    const l = router.loaded.get(r.handle), x = explorers.get(r.handle);
    return {
      handle: r.handle, domain: r.domain, identity: r.identity ?? "", status: l ? "live" : "idle",
      store: r.store, tree: r.tree ?? "", pid: l?.kernel.proc.pid, restarts: 0, explorer: x ? `http://127.0.0.1:${x.port}/` : undefined,
      wake: router.nextWake(r.handle),
    };
  }), { router: messagebox !== undefined ? `http://127.0.0.1:${messagebox}` : undefined, originOf: (h) => router.originOf(h), mailboxes: db.list("enabled").filter((r) => r.kind === "mailbox") });
  const server = await serveRoster(port, () => roster(db.list("enabled"), async (row) => openRow(row, env), live), "127.0.0.1", page)
    .then((s) => { env.out(`skein-host: host page at http://127.0.0.1:${(s.address() as { port: number }).port}/ · roster at /roster.json`); return s; }, (e: Error) => { env.err(`skein-host: host server: ${e.message}`); return undefined; });
  return {
    router, supervisor, explorers, messagebox, server, port: server ? (server.address() as { port: number }).port : undefined,
    async stop() {
      server?.close();
      await Promise.all([router.close(), supervisor.stop()]);
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

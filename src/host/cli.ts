#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// `skein-host`: the host's management database (instances.ts, $SKEIN_HOME/host.db)
// and the router (router.ts, #33) that serves every enabled row.
//   skein-host init [--owner <hex>] [--handle host]   the host skein (#90): the operator's own instance
//   skein-host add <handle> [--domain d] [--derive] [--identity hex] [--store path] [--tree cid] [--knows a,b|*] [--disabled]
//   skein-host add <handle> --mailbox --owner <hex> [--domain d]   a mailbox instance (#40) for an identity outside the
//                                     host: Router.createInstance with image `mailbox`, the instance manager's own create (#113)
//   skein-host knows <handle> [a,b | --all | --none]
//   skein-host list                   handle, kind, status, identity, front-door key, wallet|owner, store, tree, libp2p peer ID
//   skein-host identity <handle> [--peer]   an instance's identity key (from the master secret); --peer: its libp2p peer ID
//   skein-host mailboxes              the mailbox instances: handle, whose (owner), front-door key, status, store
//   skein-host ledger [handle]        the fuel ledger: what callers' calls (the front doors' reads) cost
//   skein-host enable|disable|remove <handle>
//   skein-host run
//   skein-host roster [--for <handle>]
//   skein-host peers <handle> list    its address book, read from its store
//   skein-host import-handles         the host.db mailbox instances the host skein's onboarding app has no record
//                                     of (#113), each with the request that adopts it — for the owner's wallet to send
//   skein-host event <handle> <box> [json]
//   skein-host add <handle> --boot <dir|tree-cid> [--from store.db] | --packet <file> [--scope cid] [--proofs roots.json]
//   skein-host add <handle> --image <default | dir | tree-cid [--from store.db] | outpoint>
//   skein-host system <dir>
//   skein-host pack <handle|dir|tree-cid> <out> [--from store.db] [--tree cid] [--checkpoint] [--form ordfs|git] [--no-index] [--mined roots.json]
// `add --boot/--packet` runs the loader (boot.ts, #4) on the new row's empty
// store: its objects pre-filled, its genesis from the system tree (or a
// checkpoint restored). `system` writes the stock system as such a tree;
// `pack` writes a packet (packet.ts: synthetic transactions, never broadcast).
// `add --image` (#89) boots the new row from an image: a system tree whose
// genesis names no owner and carries the claim row (`default`: the repo's
// images/default, the default image; an outpoint is refused until the ORDFS
// app exists). Its claim row admits anyone: the first claim's sender owns it
// (#127) — the owner claims it from a wallet (`skein plan claim --recipient
// <its identity> --out claim`, then `skein send <its origin> claim`); the host
// holds no owner's key and sends no claim.
// `init` (#90) creates the host skein: the operator's own instance, from the
// default image — Router.createInstance, as the instance manager's `create`
// — with the instance manager in its address book (no other instance's book
// names it), and recorded in host.db as the host skein. It is a bare image
// (#127: no signed claim to forward): the operator (`--owner`, else
// SKEIN_OWNER, the key it is for) claims it from a wallet as above, the first
// thing once the router runs. Once; a second `init` says which instance it
// is. The operator, as the owner, then installs the onboarding app into it
// from a wallet (#124: `skein
// plan install https://github.com/shruggr/skein-onboard#v0.3.0 --origin
// <the host skein's origin> --config '{"onboard": {"domain": "<the handle
// domain>"}}' --out plan` and `skein send <origin> plan`, or the management
// page). The onboarding app is the host's BRC-169 server (#113): registrations,
// the handle certificates (through the certifier provider), resolve, search,
// the manifest — the router maps its own origin's requests onto it.
// `add` inserts, or updates the given fields of an existing row. A new row's
// identity is the signer's (signer.ts, #18): derived from the router's master
// secret with key ID = the handle, no wallet process; `--derive` sets it again
// on an existing row (its store must then be a new one: re-genesis).
// `roster` prints the front end's roster (roster.ts), which `run` also serves
// at /roster.json; `roster --for h` prints h's ROSTER.md (#27: the rows it
// `knows`; `knows` sets them). `peers <handle> list` reads an instance's
// address book from its store. Nothing here writes into an instance as its
// owner (#124): installing an app, a dispatch row, an address-book entry, a
// directory into `main` are the owner's messages, built by `skein plan` (or
// the management page) and sent by the owner's wallet to the instance's
// /sendMessage. Nothing registers itself anywhere: a key in no address book
// is "no route".
// `event` (#60, #69) sends one message from the host's cron provider into a
// box of an instance now, as a tick due now would be (cron.ts): the JSON
// object given, its kind "cron" unless it names one, `due` now; the instance
// takes it by its dispatch row for that box (from the cron provider, or from
// anyone). A store has one kernel: while `run` is up the event goes over its
// control socket ($SKEIN_HOME/host.sock, control.ts) and the running router
// sends it; with the host down, through a router of its own, closed
// afterwards. A router that answers at SKEIN_HOST_URL / SKEIN_ROUTER_PORT
// with no control socket here is refused.
// `run` is the router (#40: a reverse proxy — each
// instance is an HTTP server, its front door, at http://<handle>.localhost:<port>
// or /@<handle>) on SKEIN_ROUTER_PORT, a `skein-kernel serve` per instance
// (every enabled row's started at start, any other on demand; stopped only
// past SKEIN_IDLE_MS, which is unset by default), the providers (the waker, the cron
// provider among them), the signer, the fuel ledger; plus the host page. It
// reads (bin/skein-host fills it from $SKEIN_HOME):
//   SKEIN_HOME            default ~/.skein; host.db and master.key live here
//   SKEIN_MASTER_KEY      the master secret (hex), else SKEIN_MASTER_KEY_FILE, else $SKEIN_HOME/master.key (made if absent)
//   SKEIN_ROUTER_PORT     the router, default 8100: an instance at http://<handle>.localhost:8100 (or /@<handle>)
//   SKEIN_ROUTER_ORIGIN   the router's own public origin, default http://127.0.0.1:{port}: where BRC-169 discovery is
//                         answered (the host skein's onboarding app, #113), and the geneses' resolveOrigin. The manifest's
//                         URLs, the handle domain, the host's name, note and icon and the ORDFS route are the onboarding
//                         app's config (config.onboard: domain, origin, name, note, icon, ordfs), written at install
//   SKEIN_INSTANCE_ORIGIN an instance's origin template, default http://{handle}.localhost:{port}
//   SKEIN_OWNER_MESSAGEBOX the owner's messagebox URL for new geneses, default its mailbox instance here
//   SKEIN_IDLE_MS         stop a kernel this long after its last work (ms); default 0: never (#40)
//   SKEIN_ANSWER_WAIT_MS  how long the front door holds a request waiting on its thread's answer (ms) before 503 +
//                         Retry-After; default 120000 (two minutes; frontdoor.ts)
//   SKEIN_OWNER           a new instance's owner;   SKEIN_OWNER_HANDLE its genesis name, default david@localhost
//   SKEIN_INFER           a new instance's peers.infer;   SKEIN_INFER_HANDLE its genesis name, default infer@localhost
//   SKEIN_FUEL_PER_STEP   a new genesis's fuelPerStep
//   SKEIN_HOST_PORT       the host page (/) and roster (/roster.json) on 127.0.0.1, default 4600
//   SKEIN_KERNEL_BIN      the kernel binary, default kernel-zig/zig-out/bin/skein-kernel
//   SKEIN_ARC_URL         the host's Arcade (#58, #65, arc.ts): where the instances' broadcast events go (a durable
//                         queue), one status subscription, the instances' status provider; SKEIN_ARC_TOKEN its one callback token (required with it);
//                         SKEIN_ARC_EVENTS_URL its SSE service (default <url>/events); SKEIN_ARC_CALLBACK_URL where Arcade
//                         posts webhooks (this router's /arc/callback as Arcade reaches it; unset: SSE only).
//                         Also read from $SKEIN_HOME/host.env (SKEIN_ARC_* lines)
//   SKEIN_HEADERS_URL     the host's headers feed (#102, feeds.ts): an SSE stream of block headers (hex, or chaintracks'
//                         JSON: Arcade's http://127.0.0.1:8083/chaintracks/v2/tip/stream) that every enabled instance
//                         whose dispatch table takes events in box `chain` (the chain app's row) is subscribed to

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { CID } from "multiformats/cid";
import { CID as CIDClass, decode as decodeCbor, parse as parseCid } from "../runtime/cid.ts";
import { DatabaseSync } from "node:sqlite";
import { headTree, MAIN } from "../runtime/heads.ts";
import { anyOf, DEFAULT_IMAGE, dirSource, MemBlocks, packetSource, stockSystemFiles, storeObjects, WASM_DIR, wasmDirObjects, type BootSource, type Objects } from "./boot.ts";
import { Kernel } from "./kernel.ts";
import type { Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { short } from "../runtime/log.ts";
import { openStoreFile } from "../runtime/index-store.ts";
import type { Store } from "../runtime/store.ts";
import { masterKey, Signer } from "./signer.ts";
import { CONTROL_SOCKET, controlRequest } from "./control.ts";
import { hostArcConfig } from "./arc.ts";
import { hostP2PConfig, peerIdOf } from "./p2p.ts";
import { addressBook } from "./deploy.ts";
import { hostDomain, Router, type RouterOptions } from "./router.ts";
import { HostDb, knowsColumn, knowsOf, type InstanceRow, type RowFields } from "./instances.ts";
import { deployedIdentity, hostPage, parseIdentity, roster, rosterFor, serveRoster, type HostRow, type IdentityFields } from "./roster.ts";

export interface Env {
  vars: Record<string, string | undefined>;
  out(line: string): void;
  err(line: string): void;
  /** Tests: a row's store, instead of opening its file read-only. */
  store?(row: InstanceRow): Store | undefined;
}

const USAGE = `usage:
  skein-host init [--owner <hex>] [--handle host]          the host skein (#90): the operator's instance, from the default image, for --owner (default SKEIN_OWNER) to claim from a wallet (skein plan claim); once
  skein-host add <handle> [--domain d] [--derive] [--identity hex] [--store path] [--tree cid] [--knows a,b|*] [--disabled]
  skein-host add <handle> --mailbox --owner <hex> [--domain d]   a mailbox instance for an identity outside the host (#40): the instance manager's create (#113)
  skein-host knows <handle> [a,b | --all | --none]        which agents its ROSTER.md lists; no list: print them
  skein-host list                                         handle, kind, status, identity, front-door key, wallet|owner, store, tree, libp2p peer ID
  skein-host identity <handle> [--peer]                   an instance's identity key; --peer: its libp2p peer ID (#51)
  skein-host mailboxes                                    the mailbox instances: handle, owner, front-door key, status, store
  skein-host ledger [handle]                              the fuel ledger: calls and fuel per instance, caller, op
  skein-host enable|disable|remove <handle>
  skein-host run                                          the router on :8100 (instances at <handle>.localhost:8100), a kernel per instance on demand; host page and roster on :4600
  skein-host roster                                       the front end's roster JSON
  skein-host roster --for <handle>                        that agent's ROSTER.md
  skein-host peers <handle> list                          its address book, from its store: key, transport, address, role, handle, source
  skein-host import-handles                               the mailbox instances in host.db the host skein's onboarding app has no record of (#113), each with
                                                          the owner's request that adopts it (onboard.adopt): \`1sat authfetch POST <origin>/onboard/call --body '…'\`
  skein-host event <handle> <box> [json]                  a message from the cron provider into <box> now, as a tick due now ({...json, kind: "cron" unless named, due: now}); through the running router's control socket, else a router of its own
  skein-host add <handle> --boot <dir | tree-cid [--from store.db]>          boot a new instance from a system tree (docs/BOOTSTRAP.md)
  skein-host add <handle> --packet <file> [--scope cid] [--proofs roots.json]   … from a packet: a system tree, or a checkpoint to restore
  skein-host add <handle> --image <default | dir | tree-cid [--from store.db] | outpoint>   a new instance from an image: no owner, a claim row from anyone (#89; claim it: skein plan claim)
  skein-host system <dir>                                 write the stock system (what code genesis has) as a system tree
  skein-host pack <handle|dir|tree-cid> <out> [--from store.db] [--tree cid] [--checkpoint] [--form ordfs|git] [--no-index] [--mined roots.json]
the owner's messages (installing an app, dispatch rows, the address book, a directory into main) are built by
\`skein plan\` and sent by the owner's wallet to the instance's /sendMessage (#124; scripts/host/README.md)`;

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
            domain: { type: "string" }, identity: { type: "string" }, derive: { type: "boolean" }, store: { type: "string" }, tree: { type: "string" }, knows: { type: "string" }, disabled: { type: "boolean" },
            boot: { type: "string" }, from: { type: "string" }, packet: { type: "string" }, scope: { type: "string" }, proofs: { type: "string" }, image: { type: "string" },
            mailbox: { type: "boolean" }, owner: { type: "string" },
          },
        });
        if (!handle) { env.err(USAGE); return 2; }
        const f: RowFields = { domain: v.domain, identity: v.identity, store: v.store, tree: v.tree, status: v.disabled ? "disabled" : undefined };
        if (v.knows !== undefined) f.knows = knowsColumn(handles(v.knows));
        if (v.mailbox) {
          // A mailbox instance (#40): the front door and the messagebox, keeping mail for --owner. #113: the instance
          // manager's own create (image `mailbox`), through a router of this command's own — the one creation path.
          if (!v.owner || !/^0[23][0-9a-f]{64}$/.test(v.owner)) { env.err("skein-host add --mailbox: --owner <identity key, hex>"); return 2; }
          if ([v.boot, v.packet, v.image, v.identity, v.store, v.tree].some((x) => x !== undefined) || v.derive) { env.err("skein-host add --mailbox: only --owner and --domain"); return 2; }
          return await mailboxCmd(db, handle, v.owner, v.domain, env);
        } else if (v.owner) { env.err("skein-host add: --owner goes with --mailbox"); return 2; }
        if (!db.get(handle)) {
          f.store ??= join(home, "instances", handle, "runtime.db");
          f.domain ??= hostDomain(env.vars.SKEIN_ROUTER_ORIGIN ?? "http://127.0.0.1"); // the host's domain (H4), as the router's
        }
        // The identity is the signer's (#18): derived from the master secret, key ID = the handle.
        if (f.identity === undefined && (v.derive || !db.get(handle)?.identity)) f.identity = new Signer(masterKey(env.vars, home)).identity(handle);
        if ([v.boot, v.packet, v.image].filter((x) => x !== undefined).length > 1) { env.err("skein-host add: one of --boot, --packet, --image"); return 2; }
        if (v.image !== undefined && isOutpoint(v.image)) { env.err(`skein-host add --image ${v.image}: an image by outpoint is read through the ORDFS app, which is not built yet; give a directory or a tree CID`); return 2; }
        const r = db.add(handle, f);
        env.out(`${r.handle}@${r.domain} ${r.status} · store ${r.store}${r.identity ? ` · ${short(r.identity)}` : ""}`);
        if (v.boot || v.packet || v.image !== undefined) {
          // The loader (#4): pre-fill the new store and write its genesis from the tree (or restore a checkpoint).
          // A one-shot (#61): the router it boots through is closed before `add` returns, so the process exits.
          const router = new Router({ ...routerOptions(db, env), idleMs: 0 });
          try {
            const src = await bootSourceOf(v.image !== undefined ? { boot: v.image === "default" ? DEFAULT_IMAGE : v.image, from: v.from } : v, r);
            const b = await router.bootRow(handle, src, { image: v.image !== undefined });
            env.out(b.state ? `${handle}: restored checkpoint ${b.state} (${b.objects} blocks)` : `${handle}: booted from ${v.image !== undefined ? "the image " : ""}${b.tree} · ${b.objects} objects pre-filled · programs ${b.programs.join(", ")} · genesis ${b.entry}${v.image !== undefined ? " · no owner: claim it from your wallet (skein plan claim, skein send)" : ""}`);
          } catch (e) {
            env.err(`skein-host add ${handle}: ${(e as Error).message}`);
            return 1;
          } finally {
            await router.close();
          }
        }
        return 0;
      }
      case "init":
        return await initCmd(db, rest, env);
      case "identity": {
        // The signer's key (signer.ts) for an instance: the BRC-104 identity its front door answers as.
        const [handle, flag, ...more] = rest;
        if (!handle || more.length || (flag !== undefined && flag !== "--peer")) { env.err(USAGE); return 2; }
        const signer = new Signer(masterKey(env.vars, home));
        // The libp2p peer ID (#51): the identity multihash of the peer key, a child of the master with key ID libp2p:<handle>.
        env.out(flag ? peerIdOf(signer.peerKey(handle)).toString() : signer.identity(handle));
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
        const host = db.setting("host_skein");
        for (const r of db.list()) env.out([`${r.handle}@${r.domain}`, r.handle === host ? "host" : r.kind ?? "agent", r.status, r.identity ?? "-", door(r), r.kind === "mailbox" ? `owner ${r.owner}` : "-", r.store, r.tree ?? "-", peer(r)].join("\t"));
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
      case "peers":
        return await peersCmd(db, rest, env);
      case "event":
        return await eventCmd(db, rest, env);
      case "import-handles":
        return await importHandlesCmd(db, rest, env);
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
 * signer's, derived from the master secret with key ID = the handle — for an
 * agent and a mailbox instance alike, and before the row was ever hydrated.
 * The master secret is only read here, never made: with none, "-".
 */
function frontDoorKeys(vars: Env["vars"], home: string): (row: InstanceRow) => string {
  const file = vars.SKEIN_MASTER_KEY_FILE || join(home, "master.key");
  if (!vars.SKEIN_MASTER_KEY && !existsSync(file)) return () => "-";
  const signer = new Signer(masterKey(vars, home));
  return (row) => signer.identity(row.handle);
}

/** Each row's libp2p peer ID (#51): derived from the master secret (key ID libp2p:<handle>), whether or not it runs a node; "-" with no master secret. */
function peerIds(vars: Env["vars"], home: string): (row: InstanceRow) => string {
  const file = vars.SKEIN_MASTER_KEY_FILE || join(home, "master.key");
  if (!vars.SKEIN_MASTER_KEY && !existsSync(file)) return () => "-";
  const signer = new Signer(masterKey(vars, home));
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
  return (vars.SKEIN_INSTANCE_ORIGIN || "http://{handle}.localhost:{port}").replace("{handle}", handle).replace("{port}", vars.SKEIN_ROUTER_PORT || "8100");
}

/** `skein-host peers <handle> list`: the instance's address book, read from its store (#124: writing it is the owner's `peers` messages, `skein plan peers`). */
async function peersCmd(db: HostDb, rest: string[], env: Env): Promise<number> {
  const [handle, op, ...more] = rest;
  if (!handle || more.length || op !== "list") { env.err(USAGE); return 2; }
  const row = db.get(handle);
  if (!row) { env.err(`skein-host peers: no instance ${handle}`); return 1; }
  if (row.kind === "mailbox") { env.err(`skein-host peers: ${handle} is a mailbox instance: it keeps mail, it sends nothing`); return 1; }
  const s = openRow(row, env);
  try {
    for (const e of await addressBook(s.blocks)) env.out([e.key, e.transport, e.address, e.role ?? "-", e.handle ? `${e.handle}@${e.domain ?? ""}` : "-", e.source ?? "-"].join("\t"));
    return 0;
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

/**
 * `skein-host init [--owner <hex>] [--handle host]` (#90): the host skein —
 * Router.createInstance with `host`, through a router of this command's own
 * (closed afterwards), unpublished until that router is closed: a running
 * router serves only enabled rows, so it hydrates the host skein on its first
 * request, after this process has let go of the store. Once: a second `init`
 * prints which instance is the host skein.
 */
async function initCmd(db: HostDb, rest: string[], env: Env): Promise<number> {
  const { values: v, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { owner: { type: "string" }, handle: { type: "string" } } });
  if (positionals.length) { env.err(USAGE); return 2; }
  const had = db.hostSkein();
  if (had) {
    if (v.handle !== undefined && v.handle !== had.handle) { env.err(`skein-host init: the host skein is ${had.handle} already`); return 1; }
    env.out(`the host skein: ${had.handle}@${had.domain} (${had.identity ? short(had.identity) : "-"}) ${had.status}`);
    return 0;
  }
  const owner = v.owner ?? env.vars.SKEIN_OWNER;
  if (!owner || !/^0[23][0-9a-f]{64}$/.test(owner)) { env.err("skein-host init: the operator's identity key: --owner <hex>, or SKEIN_OWNER"); return 2; }
  const handle = v.handle ?? "host";
  const router = new Router({ ...routerOptions(db, env), idleMs: 0, cron: false });
  let c: { handle: string; identity: string; url: string };
  try {
    c = await router.createInstance(handle, owner, { host: true, publish: false });
  } catch (e) {
    env.err(`skein-host init: ${(e as Error).message}`);
    return 1;
  } finally {
    await router.close();
  }
  db.setStatus(handle, "enabled");
  env.out(`${c.handle}: the host skein (${short(c.identity)}), from the default image, for ${short(owner)} to claim · at ${c.url} · the instance manager in its address book`);
  env.out(`next, as the owner (#127; the router running), first: skein plan claim --recipient ${c.identity} --out claim, then skein send ${c.url} claim (its claim row admits anyone until then: the first claim's sender owns it)`);
  env.out(`then (#124): skein plan install https://github.com/shruggr/skein-onboard#v0.3.0 --origin ${c.url} --config '{"onboard": {"domain": "<the handle domain>", "origin": "<the router's origin>"}}' --out plan, then skein send ${c.url} plan (the onboarding app: registration and BRC-169)`);
  return 0;
}

/**
 * `skein-host add <handle> --mailbox --owner <hex> [--domain d]` (#40, #113):
 * Router.createInstance with image `mailbox` — what the instance manager does
 * for the onboarding app's registrations — through a router of this
 * command's own. The same owner and handle again: kept (printed).
 */
async function mailboxCmd(db: HostDb, handle: string, owner: string, domain: string | undefined, env: Env): Promise<number> {
  const router = new Router({ ...routerOptions(db, env), idleMs: 0, cron: false });
  try {
    const c = await router.createInstance(handle, owner, { image: "mailbox", ...(domain ? { domain } : {}) });
    const r = db.get(handle)!;
    env.out(`${r.handle}@${r.domain} ${r.status} · store ${r.store} · ${short(c.identity)} · mailbox instance for ${short(owner)} at ${c.url}`);
    return 0;
  } catch (e) {
    env.err(`skein-host add --mailbox: ${(e as Error).message}`);
    return 1;
  } finally {
    await router.close();
  }
}

/** An outpoint as an image is named on chain: `<txid>_<vout>` (or `.`/`:`). */
const isOutpoint = (s: string) => /^[0-9a-f]{64}[_.:][0-9]+$/.test(s);

/**
 * `skein-host import-handles` (#113): the mailbox instances host.db has and
 * the host skein's onboarding app does not (a registration before the app
 * took them; its public resolve says), each printed with the request that
 * adopts it: `{fn: "onboard.adopt", args: {handle, owner}}` POSTed to the
 * host skein's /onboard/call on the owner's session — the owner's wallet
 * sends it (#124: `1sat authfetch POST <origin>/onboard/call --body '…'`).
 * The app asks the instance manager (which answers for the existing row, at
 * the app's domain), issues the certificate and records it, so the handle
 * resolves. The running router serves the host skein.
 */
async function importHandlesCmd(db: HostDb, rest: string[], env: Env): Promise<number> {
  if (rest.length) { env.err(USAGE); return 2; }
  const host = db.hostSkein();
  if (!host) { env.err("skein-host import-handles: no host skein (skein-host init)"); return 1; }
  const local = `${(env.vars.SKEIN_HOST_URL || `http://127.0.0.1:${env.vars.SKEIN_ROUTER_PORT || 8100}`).replace(/\/+$/, "")}/@${host.handle}`;
  const origin = originOf(env.vars, host.handle);
  let n = 0;
  for (const r of db.list().filter((x) => x.kind === "mailbox" && x.owner)) {
    const known = await fetch(`${local}/onboard/resolve?handle=${encodeURIComponent(r.handle)}`).then((x) => x.json() as Promise<{ identityKey?: string }>).catch(() => ({ identityKey: undefined }));
    if (known.identityKey === r.owner) continue;
    n++;
    env.out(`1sat authfetch POST ${origin}/onboard/call --body '${JSON.stringify({ fn: "onboard.adopt", args: { handle: r.handle, owner: r.owner } })}'`);
  }
  env.err(n ? `${n} mailbox instance${n === 1 ? "" : "s"} to adopt: the owner's wallet sends each line above` : "every mailbox instance is recorded");
  return 0;
}

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
  if (!existsSync(row.store)) return {};
  const s = openStoreFile(row.store, { readOnly: true });
  return { blocks: s, close: () => s.close() };
}

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");

export interface RunOptions {
  /** The router's options beyond what the environment gives (tests). */
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
 * keys (#70: the HTTP proxy, the waker, the cron provider, the libp2p node, the status provider,
 * the instance manager, and the certifier, #113: its key the certifier key, BRC-169's trust anchor).
 */
function wallets(v: Env["vars"], home: string): Pick<RouterOptions, "walletFor" | "peerKeyFor" | "providerKeyFor"> {
  const signer = new Signer(masterKey(v, home));
  return { walletFor: (row) => signer.wallet(row.handle), peerKeyFor: (handle) => signer.peerKey(handle), providerKeyFor: (name) => signer.providerKey(name) };
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
    origin: v.SKEIN_ROUTER_ORIGIN, instanceOrigin: v.SKEIN_INSTANCE_ORIGIN, ownerMessagebox: v.SKEIN_OWNER_MESSAGEBOX, port: Number(v.SKEIN_ROUTER_PORT ?? 8100),
    kernel: { command: v.SKEIN_KERNEL_BIN, env: { SKEIN_HOME: home } },
    libp2p: hostP2PConfig(v, home),
    headersFeed: v.SKEIN_HEADERS_URL || undefined,
    arc: hostArcConfig(v, home),
    log: (source, line) => env.out(`[${source}] ${line}`),
  };
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
  try { v = decodeCbor(bytes); } catch { return false; } // not dag-cbor: not an index block
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
 * once at start (stopped only past SKEIN_IDLE_MS), and the host page and roster on
 * SKEIN_HOST_PORT. A skein's explorer is its own (`/explore`, its owner's),
 * read by the management site (shruggr/skein-site, #92).
 */
export async function runHost(db: HostDb, env: Env, o: RunOptions = {}): Promise<Host> {
  const v = env.vars;
  const home = homeOf(v);
  const router = new Router({ ...routerOptions(db, env), ...o.router });
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
  const hs = db.hostSkein();
  env.out(hs ? `skein-host: the host skein is ${hs.handle} (${hs.identity ? short(hs.identity) : "-"}) at ${router.originOf(hs.handle)}: the instance manager takes its messages only` : "skein-host: no host skein (skein-host init): the instance manager acts for nobody");
  const live = (row: InstanceRow) => router.loaded.has(row.handle);
  const port = Number(v.SKEIN_HOST_PORT || 4600);
  const page = async () => hostPage(db.list("enabled").map((r): HostRow => {
    const l = router.loaded.get(r.handle);
    return {
      handle: r.handle, domain: r.domain, identity: r.identity ?? "", status: l ? "live" : "idle",
      store: r.store, tree: r.tree ?? "", pid: l?.kernel.proc.pid, restarts: 0, origin: router.originOf(r.handle),
      wake: router.nextWake(r.handle),
    };
  }), { router: messagebox !== undefined ? `http://127.0.0.1:${messagebox}` : undefined, originOf: (h) => router.originOf(h), mailboxes: db.list("enabled").filter((r) => r.kind === "mailbox") });
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
  process.exitCode = await main(process.argv.slice(2), { vars: process.env, out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) });
}

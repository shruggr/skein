#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// `skein-runtime`: the runtime process (docs/ARCH.md). One instance, one store
// file, its wallets, and its providers — run by hand, or as one child of
// `skein-host run` (supervisor.ts), which starts one of these per host.db row
// with the row in its environment. It reads only its environment
// (bin/skein-runtime fills it from ~/.skein):
//   SKEIN_HOME            default ~/.skein
//   SKEIN_DB              the store file, default $SKEIN_HOME/runtime.db
//   SKEIN_WALLET          "remote" (default) or "ephemeral" (throwaway keys for the instance and the host; nothing they sign survives)
//   SKEIN_WALLET_URL      the instance's BRC-100 endpoint, default http://127.0.0.1:3321 (`1sat serve wallet-api`)
//   SKEIN_WALLET_ORIGINATOR  its origin, default "skein"
//   SKEIN_IDENTITY        the identity the wallet must be (a host.db row's recorded one); unset: not checked
//   SKEIN_HOST_WALLET_URL the host's BRC-100 endpoint, default http://127.0.0.1:3324, origin "skein-host": signs every
//                         log entry (the host's word that a message arrived, a deadline came, an emit was delivered or failed)
//   SKEIN_OWNER           the owner's identity key (a new instance's genesis routes its `run`/`objects`/`head`/`chat`/`subscribe` boxes)
//   SKEIN_OWNER_HANDLE    the owner's handle (a new genesis's `names`: outbound envelopes call it that), default david@localhost
//   SKEIN_INFER           the inference peer's identity key (a new instance's genesis `peers.infer`)
//   SKEIN_INFER_HANDLE    its handle (a new genesis's `names`), default infer@localhost
//   SKEIN_HANDLE          the instance's handle, default skein@localhost
//   SKEIN_MESSAGEBOX      the messagebox host, e.g. http://127.0.0.1:8100/messagebox
//   SKEIN_HOST_DB         the host's management database, read only: handles its rows answer for the resolver
//                         (host.ts hostResolver); default $SKEIN_HOME/host.db if it exists
//   SKEIN_POLL_MS         how often to collect the boxes, default 1000
//   SKEIN_SEND_ATTEMPTS   sends of an emit that fails transiently before it is reported failed, default 8
//   SKEIN_SEND_BACKOFF_MS the first retry's delay, doubling (at most 60 s), default 1000
//
// This file is the kernel configuration: it opens the store (installing the
// pinned modules), connects the wallets (../wallet.ts), and wires the
// instance's interfaces to providers through startInstance (host.ts) —
// message delivery, outbound messages and their outcomes to the messagebox
// (messagebox.ts), wakes to the tick (tick.ts), handles to the host's
// resolver. A new store's genesis is the host's (configFor): the owner's
// boxes, then `chat` from anyone. The runtime (src/runtime) is the machine; it
// only admits the entries they deliver and hands them its emits.
//
// Once running it prints `skein runtime <identity> (<handle>@<domain>) …`,
// the line the supervisor waits for. It stops on SIGINT/SIGTERM, and when its
// supervisor's IPC channel closes (the supervisor is gone).

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { install } from "../dev/cli.ts";
import { openStore } from "../runtime/sqlite.ts";
import { connectWallet, ephemeralWallet } from "../wallet.ts";
import { hostResolver, startInstance } from "./host.ts";
import { HostDb, type InstanceRow } from "./instances.ts";
import { messageBoxClient } from "./messagebox.ts";

const env = process.env;
const home = env.SKEIN_HOME || `${env.HOME}/.skein`;
const dbPath = env.SKEIN_DB || `${home}/runtime.db`;
const say = (line: string) => process.stdout.write(`${line}\n`);
const die = (msg: string): never => { process.stderr.write(`skein-runtime: ${msg}\n`); process.exit(1); };

const ephemeral = env.SKEIN_WALLET === "ephemeral";
const named = (s: string) => { const [handle, domain = "localhost"] = s.split("@"); return { handle, domain }; };
const { handle, domain } = named(env.SKEIN_HANDLE || "skein@localhost");
const row: InstanceRow = {
  handle, domain, identity: env.SKEIN_IDENTITY || null,
  wallet_url: env.SKEIN_WALLET_URL || "http://127.0.0.1:3321", wallet_originator: env.SKEIN_WALLET_ORIGINATOR || "skein",
  store: dbPath, tree: null, source: null, knows: null, status: "enabled", created_at: "",
};

const hostDbPath = env.SKEIN_HOST_DB || `${home}/host.db`;
const hostDb = existsSync(hostDbPath) ? new HostDb(hostDbPath, { readOnly: true }) : undefined;
const host = ephemeral ? ephemeralWallet() : await connectWallet({ kind: "remote", url: env.SKEIN_HOST_WALLET_URL || "http://127.0.0.1:3324", originator: "skein-host" });
if (!env.SKEIN_MESSAGEBOX) say("SKEIN_MESSAGEBOX unset: no message provider; nothing will be delivered");

const running = await startInstance(row, {
  host, owner: env.SKEIN_OWNER, infer: env.SKEIN_INFER,
  ownerHandle: named(env.SKEIN_OWNER_HANDLE || "david@localhost"), inferHandle: named(env.SKEIN_INFER_HANDLE || "infer@localhost"),
  wallet: async (r) => ephemeral ? ephemeralWallet() : connectWallet({ kind: "remote", url: r.wallet_url!, originator: r.wallet_originator }),
  store: async (r) => {
    mkdirSync(dirname(r.store), { recursive: true });
    const s = openStore(r.store);
    for (const l of await install(s)) say(`installed ${l}`);
    return s;
  },
  box: env.SKEIN_MESSAGEBOX ? (r, wallet) => messageBoxClient(wallet, env.SKEIN_MESSAGEBOX!, r.wallet_originator) : undefined,
  resolve: hostResolver((h, d) => hostDb?.identityOf(h, d), env.SKEIN_MESSAGEBOX),
  pollMs: Number(env.SKEIN_POLL_MS || 1000),
  retry: {
    ...(env.SKEIN_SEND_ATTEMPTS ? { attempts: Number(env.SKEIN_SEND_ATTEMPTS) } : {}),
    ...(env.SKEIN_SEND_BACKOFF_MS ? { backoffMs: Number(env.SKEIN_SEND_BACKOFF_MS) } : {}),
  },
  log: (_, line) => say(line),
}).catch((e: Error) => die(`${handle}@${domain}: ${e.message}`));

say(`skein runtime ${running.identity} (${handle}@${domain}) · pid ${process.pid} · db ${dbPath}${hostDb ? ` · rows ${hostDbPath}` : ""}`);

let stopping = false;
const stop = async (why: string) => {
  if (stopping) return;
  stopping = true;
  say(`${why}: stopping`);
  await running.stop();
  hostDb?.close();
  process.exit(0); // the messagebox client's sockets would keep the process alive
};
process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));
if (process.connected) process.once("disconnect", () => void stop("supervisor gone"));

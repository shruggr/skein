#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// `skein-host`: the host's management database (instances.ts, $SKEIN_HOME/host.db)
// and the one process that runs every enabled row (host.ts).
//   skein-host add <handle> [--domain d] [--identity hex] [--wallet-url url] [--originator o] [--store path] [--tree cid] [--disabled]
//   skein-host list
//   skein-host enable|disable|remove <handle>
//   skein-host run
// `add` inserts, or updates the given fields of an existing row. `run` reads
// its environment like skein-runtime (bin/skein-host fills it from $SKEIN_HOME):
//   SKEIN_HOME            default ~/.skein; host.db lives here
//   SKEIN_WALLET          "remote" (default) or "ephemeral" (throwaway keys for every instance and the host)
//   SKEIN_HOST_WALLET_URL the host wallet, default http://127.0.0.1:3324, origin "skein-host": signs every entry of every instance
//   SKEIN_OWNER           a new instance's owner;   SKEIN_OWNER_HANDLE default david@localhost
//   SKEIN_INFER           a new instance's peers.infer;   SKEIN_INFER_HANDLE default infer@localhost
//   SKEIN_MESSAGEBOX      the messagebox host;   SKEIN_POLL_MS default 1000

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { install } from "../dev/cli.ts";
import { short } from "../runtime/log.ts";
import { openStore } from "../runtime/sqlite.ts";
import { connectWallet, ephemeralWallet } from "../wallet.ts";
import { hostResolver, startInstance, type Running } from "./host.ts";
import { HostDb, type RowFields } from "./instances.ts";
import { messageBoxClient } from "./messagebox.ts";

export interface Env {
  vars: Record<string, string | undefined>;
  out(line: string): void;
  err(line: string): void;
}

const USAGE = `usage:
  skein-host add <handle> [--domain d] [--identity hex] [--wallet-url url] [--originator o] [--store path] [--tree cid] [--disabled]
  skein-host list
  skein-host enable|disable|remove <handle>
  skein-host run`;

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
          options: { domain: { type: "string" }, identity: { type: "string" }, "wallet-url": { type: "string" }, originator: { type: "string" }, store: { type: "string" }, tree: { type: "string" }, disabled: { type: "boolean" } },
        });
        if (!handle) { env.err(USAGE); return 2; }
        const f: RowFields = { domain: v.domain, identity: v.identity, wallet_url: v["wallet-url"], wallet_originator: v.originator, store: v.store, tree: v.tree, status: v.disabled ? "disabled" : undefined };
        if (!db.get(handle)) f.store ??= join(home, "instances", handle, "runtime.db");
        const r = db.add(handle, f);
        env.out(`${r.handle}@${r.domain} ${r.status} · store ${r.store}${r.wallet_url ? ` · wallet ${r.wallet_url}` : ""}${r.identity ? ` · ${short(r.identity)}` : ""}`);
        return 0;
      }
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
        return await run(db, env);
      default:
        env.err(USAGE);
        return 2;
    }
  } finally {
    if (cmd !== "run") db.close(); // run keeps it (and closes it on a signal)
  }
}

/** Start every enabled row; stop them all on SIGINT/SIGTERM. A row that fails to start is logged and skipped. */
async function run(db: HostDb, env: Env): Promise<number> {
  const v = env.vars;
  const ephemeral = v.SKEIN_WALLET === "ephemeral";
  const host = ephemeral ? ephemeralWallet() : await connectWallet({ kind: "remote", url: v.SKEIN_HOST_WALLET_URL || "http://127.0.0.1:3324", originator: "skein-host" });
  const named = (s: string) => { const [handle, domain = "localhost"] = s.split("@"); return { handle, domain }; };
  const log = (handle: string, line: string) => env.out(`[${handle}] ${line}`);
  const resolve = hostResolver((h, d) => db.identityOf(h, d), v.SKEIN_MESSAGEBOX);
  const running: Running[] = [];
  for (const row of db.list("enabled")) {
    try {
      const r = await startInstance(row, {
        host, owner: v.SKEIN_OWNER, infer: v.SKEIN_INFER,
        ownerHandle: named(v.SKEIN_OWNER_HANDLE || "david@localhost"), inferHandle: named(v.SKEIN_INFER_HANDLE || "infer@localhost"),
        wallet: async (row) => {
          if (ephemeral) return ephemeralWallet();
          if (!row.wallet_url) throw new Error("no wallet_url (skein-host add --wallet-url)");
          return connectWallet({ kind: "remote", url: row.wallet_url, originator: row.wallet_originator });
        },
        store: async (row) => {
          mkdirSync(dirname(row.store), { recursive: true });
          const s = openStore(row.store);
          for (const l of await install(s)) log(row.handle, `installed ${l}`);
          return s;
        },
        box: v.SKEIN_MESSAGEBOX ? (row, wallet) => messageBoxClient(wallet, v.SKEIN_MESSAGEBOX!, row.wallet_originator) : undefined,
        resolve,
        pollMs: Number(v.SKEIN_POLL_MS || 1000),
        log,
      });
      if (!row.identity && !ephemeral) db.add(row.handle, { identity: r.identity });
      if (row.tree) log(row.handle, `tree ${row.tree} recorded; booting main from it is #4, not done yet`);
      running.push(r);
    } catch (e) {
      log(row.handle, `not started: ${(e as Error).message}`);
    }
  }
  env.out(`skein-host: ${running.length} of ${db.list("enabled").length} enabled instances running (${running.map((r) => r.row.handle).join(", ") || "none"})`);
  if (!running.length) { db.close(); return 1; }
  const stop = async (sig: string) => {
    env.out(`${sig}: stopping`);
    for (const r of running) await r.stop().catch((e) => log(r.row.handle, `stop: ${(e as Error).message}`));
    db.close();
    process.exit(0); // the messagebox clients' sockets would keep the process alive (as in main.ts)
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), { vars: process.env, out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) });
}

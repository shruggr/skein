#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// `skein-runtime`: the runtime process (docs/ARCH.md). One instance, one store
// file, its wallets, and its providers. It reads only its environment
// (bin/skein-runtime fills it from ~/.skein):
//   SKEIN_HOME            default ~/.skein
//   SKEIN_DB              the store file, default $SKEIN_HOME/runtime.db
//   SKEIN_WALLET          "remote" (default) or "ephemeral" (throwaway keys for the instance and the host; nothing they sign survives)
//   SKEIN_WALLET_URL      the instance's BRC-100 endpoint, default http://127.0.0.1:3321 (`1sat serve wallet-api`), origin "skein"
//   SKEIN_HOST_WALLET_URL the host's BRC-100 endpoint, default http://127.0.0.1:3324, origin "skein-host": signs every
//                         log entry (the host's word that a message arrived, or a deadline came, at the stamped time)
//   SKEIN_OWNER           the owner's identity key (a new instance's genesis routes its `run`/`objects` boxes)
//   SKEIN_OWNER_HANDLE    the owner's handle (a new genesis's `names`: outbound envelopes call it that), default david@localhost
//   SKEIN_INFER           the inference peer's identity key (a new instance's genesis `peers.infer`)
//   SKEIN_INFER_HANDLE    its handle (a new genesis's `names`), default infer@localhost
//   SKEIN_HANDLE          the instance's handle, default skein@localhost
//   SKEIN_MESSAGEBOX      the messagebox host, e.g. http://127.0.0.1:8100/messagebox
//   SKEIN_POLL_MS         how often to collect the boxes, default 1000
//
// This file is the kernel configuration: it opens the store, connects the
// wallets (../wallet.ts), and wires the instance's interfaces to providers —
// message delivery and outbound messages to the messagebox (messagebox.ts),
// wakes to the tick (tick.ts). The runtime (src/runtime) is the machine; it
// only admits the entries they deliver and hands them its emits.

import { connectWallet, ephemeralWallet } from "../wallet.ts";
import { genesisOf, short } from "../runtime/log.ts";
import { Runtime } from "../runtime/scheduler.ts";
import { openStore } from "../runtime/sqlite.ts";
import { ensureGenesis } from "./entry.ts";
import { Delivery, messageBoxClient } from "./messagebox.ts";
import { Tick } from "./tick.ts";

const env = process.env;
const home = env.SKEIN_HOME || `${env.HOME}/.skein`;
const dbPath = env.SKEIN_DB || `${home}/runtime.db`;
const say = (line: string) => process.stdout.write(`${line}\n`);
const die = (msg: string): never => { process.stderr.write(`skein-runtime: ${msg}\n`); process.exit(1); };

const ephemeral = env.SKEIN_WALLET === "ephemeral";
const wallet = ephemeral ? ephemeralWallet() : await connectWallet({ kind: "remote", url: env.SKEIN_WALLET_URL, originator: "skein" });
const host = ephemeral ? ephemeralWallet() : await connectWallet({ kind: "remote", url: env.SKEIN_HOST_WALLET_URL || "http://127.0.0.1:3324", originator: "skein-host" });
const [user, domain = "localhost"] = (env.SKEIN_HANDLE || "skein@localhost").split("@");
const store = openStore(dbPath); // SQLite creates the file; the directory must exist (bin/skein-runtime makes it)

if (!(await store.log.tip())) {
  if (!env.SKEIN_OWNER) die("an empty store needs SKEIN_OWNER (the owner's identity key) for its genesis");
  const named = (s: string) => { const [handle, domain = "localhost"] = s.split("@"); return { handle, domain }; };
  const names = { [env.SKEIN_OWNER!]: named(env.SKEIN_OWNER_HANDLE || "david@localhost"), ...(env.SKEIN_INFER ? { [env.SKEIN_INFER]: named(env.SKEIN_INFER_HANDLE || "infer@localhost") } : {}) };
  const g = await ensureGenesis(store, wallet, host, { owner: env.SKEIN_OWNER!, handle: user, domain, peers: env.SKEIN_INFER ? { infer: env.SKEIN_INFER } : undefined, names });
  say(`genesis ${g.entry}`);
}

const g = await genesisOf(store);
const { publicKey: hostKey } = await host.getPublicKey({ identityKey: true });
if (hostKey !== g.host) die(`the host wallet (${hostKey}) is not this instance's host (${g.host}): its entries would not verify`);

const runtime = new Runtime({ store, wallet, log: say });

// Wakes: the tick provider, watching the runtime's sleepers from before it starts.
const tick = new Tick({ runtime, host, log: say });
tick.start();

// Messages in and out: the messagebox provider, as the instance's identity.
let delivery: Delivery | undefined;
if (env.SKEIN_MESSAGEBOX) {
  delivery = new Delivery({ runtime, wallet, host, box: messageBoxClient(wallet, env.SKEIN_MESSAGEBOX), log: say });
  runtime.outbox = delivery;
} else {
  say("SKEIN_MESSAGEBOX unset: no message provider; nothing will be delivered");
}

await runtime.start();
delivery?.start(Number(env.SKEIN_POLL_MS || 1000));
say(`skein runtime ${g.identity} (${g.handle}@${g.domain}) · host ${short(g.host)} · owner ${short(g.owner)}${g.peers?.infer ? ` · infer ${short(g.peers.infer)}` : " · no infer peer"} · db ${dbPath} · boxes ${(await runtime.boxes()).join(",")} · state ${(await runtime.tip())?.toString()}`);

const stop = async (sig: string) => {
  say(`${sig}: stopping`);
  await tick.stop();
  await delivery?.stop();
  await runtime.stop();
  await store.close();
  process.exit(0);
};
process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

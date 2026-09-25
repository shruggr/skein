#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// `skein-runtime`: the runtime process (docs/ARCH.md). One instance, one store
// file, one wallet, one messagebox edge. It reads only its environment
// (bin/skein-runtime fills it from ~/.skein):
//   SKEIN_HOME            default ~/.skein
//   SKEIN_DB              the store file, default $SKEIN_HOME/runtime.db
//   SKEIN_WALLET          "remote" (default) or "ephemeral" (throwaway key; nothing it signs survives)
//   SKEIN_WALLET_URL      the instance's BRC-100 endpoint, default http://127.0.0.1:3321 (`1sat serve wallet-api`), origin "skein"
//   SKEIN_INSTANCE_WIF    the instance's root key (the one its wallet was started with); the edge derives
//                         message keys from it (inbox.ts). Required with a remote wallet.
//   SKEIN_OWNER           the owner's identity key (a new instance's genesis routes its `run`/`objects` boxes)
//   SKEIN_OWNER_HANDLE    the owner's handle for outbound envelopes, default david@localhost
//   SKEIN_HANDLE          the instance's handle, default skein@localhost
//   SKEIN_MESSAGEBOX      the messagebox host, e.g. http://127.0.0.1:8100/messagebox
//   SKEIN_POLL_MS         how often to collect the boxes, default 1000
//   SKEIN_FRESHNESS_MS    accept envelopes created within ± this of now, default 600000
//
// The wallet connection (../wallet.ts) and the messagebox edge (inbox.ts) are
// the runtime's edges; everything else here is inside the machine.

import { PrivateKey } from "@bsv/sdk";
import { connectWallet, ephemeralWallet } from "../wallet.ts";
import { Edge, messageBoxClient } from "./inbox.ts";
import { ensureGenesis, now, short, stampMs } from "./log.ts";
import { Runtime } from "./scheduler.ts";
import { openStore } from "./sqlite.ts";
import type { CID } from "multiformats/cid";

const env = process.env;
const home = env.SKEIN_HOME || `${env.HOME}/.skein`;
const dbPath = env.SKEIN_DB || `${home}/runtime.db`;
const say = (line: string) => process.stdout.write(`${line}\n`);
const die = (msg: string): never => { process.stderr.write(`skein-runtime: ${msg}\n`); process.exit(1); };

const ephemeral = env.SKEIN_WALLET === "ephemeral";
const rootKey = ephemeral ? PrivateKey.fromRandom()
  : env.SKEIN_INSTANCE_WIF ? PrivateKey.fromWif(env.SKEIN_INSTANCE_WIF)
  : die("SKEIN_INSTANCE_WIF is not set: the edge derives each envelope's message key from the instance's root key (bin/skein-runtime reads it from ~/.skein/dev-wallet.env)");
const wallet = ephemeral ? ephemeralWallet(rootKey) : await connectWallet({ kind: "remote", url: env.SKEIN_WALLET_URL, originator: "skein" });
const [user, domain = "localhost"] = (env.SKEIN_HANDLE || "skein@localhost").split("@");
const store = openStore(dbPath); // SQLite creates the file; the directory must exist (bin/skein-runtime makes it)

if (!(await store.log.tip())) {
  if (!env.SKEIN_OWNER) die("an empty store needs SKEIN_OWNER (the owner's identity key) for its genesis");
  const g = await ensureGenesis(store, wallet, { owner: env.SKEIN_OWNER!, handle: user, domain });
  say(`genesis ${g.entry}`);
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const runtime = new Runtime({
  store, wallet, log: say,
  // Sleepers see time pass only through a wake entry: write one at each deadline.
  onSleep: (thread: CID, until: number) => {
    clearTimeout(timers.get(thread.toString()));
    timers.set(thread.toString(), setTimeout(() => {
      timers.delete(thread.toString());
      runtime.wake(thread).catch((e) => say(`wake ${short(thread)}: ${(e as Error).message}`));
    }, Math.max(0, until - stampMs(now())) + 1));
  },
});
await runtime.start();
const g = runtime.genesis!;

const [ownerUser, ownerDomain = "localhost"] = (env.SKEIN_OWNER_HANDLE || "david@localhost").split("@");
let edge: Edge | undefined;
if (env.SKEIN_MESSAGEBOX) {
  edge = new Edge({
    runtime, wallet, rootKey,
    box: messageBoxClient(wallet, env.SKEIN_MESSAGEBOX),
    freshnessMs: env.SKEIN_FRESHNESS_MS ? Number(env.SKEIN_FRESHNESS_MS) : undefined,
    handles: { [g.owner]: { handle: ownerUser, domain: ownerDomain } },
    log: say,
  });
  await edge.check().catch((e) => die((e as Error).message));
  runtime.outbox = edge;
  edge.start(Number(env.SKEIN_POLL_MS || 1000));
} else {
  say("SKEIN_MESSAGEBOX unset: no edge; nothing will be admitted");
}
say(`skein runtime ${g.identity} (${g.handle}@${g.domain}) · owner ${short(g.owner)} · db ${dbPath} · boxes ${(await runtime.boxes()).join(",")} · state ${(await runtime.tip())?.toString()}`);

const stop = async (sig: string) => {
  say(`${sig}: stopping`);
  for (const t of timers.values()) clearTimeout(t);
  await edge?.stop();
  await runtime.stop();
  await store.close();
  process.exit(0);
};
process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

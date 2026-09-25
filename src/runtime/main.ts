#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// `skein`: the runtime process (docs/ARCH.md). One instance, one store file,
// one wallet, one socket. It reads only its environment:
//   SKEIN_HOME      default ~/.skein
//   SKEIN_DB        the store file, default $SKEIN_HOME/runtime.db
//   SKEIN_SOCKET    default $SKEIN_HOME/runtime.sock
//   SKEIN_WALLET    "remote" (default) or "ephemeral" (throwaway key; nothing it signs survives)
//   SKEIN_WALLET_URL  the BRC-100 endpoint, default http://127.0.0.1:3321 (`1sat serve wallet-api`), origin "skein"
//   SKEIN_TICK_MS   how often to admit a tick while a thread sleeps, default 1000
//
// The wallet connection is the runtime's one edge besides messages, and the one
// import from outside src/runtime (../wallet.ts, which reaches wallet-api over
// HTTP). Everything else here is inside the machine.

import { connectWallet } from "../wallet.ts";
import { ensureGenesis, NAMES, short } from "./log.ts";
import { signerFor } from "./identity.ts";
import { signMessage } from "./records.ts";
import { Runtime } from "./scheduler.ts";
import { openStore } from "./sqlite.ts";
import { Transport } from "./transport.ts";

const env = process.env;
const home = env.SKEIN_HOME || `${env.HOME}/.skein`;
const dbPath = env.SKEIN_DB || `${home}/runtime.db`;
const sockPath = env.SKEIN_SOCKET || `${home}/runtime.sock`;

const say = (line: string) => process.stdout.write(`${line}\n`);

const wallet = await connectWallet(env.SKEIN_WALLET === "ephemeral" ? { kind: "ephemeral" } : { kind: "remote", url: env.SKEIN_WALLET_URL, originator: "skein" });
const store = openStore(dbPath); // SQLite creates the file; the directory must exist (bin/skein makes it)
const g = await ensureGenesis(store, wallet);
if (g.created) say(`genesis: ${g.entries.length} admin messages; state ${short(g.entries.at(-1)!)}`);

const runtime = new Runtime({ store, wallet, log: say });
const transport = new Transport({
  get identity() { return runtime.identity; },
  admit: (m) => runtime.admit(m),
  nextSeq: (id) => runtime.nextSeq(id),
  nameOf: (id) => runtime.nameOf(id),
  log: say,
});
runtime.outbox = transport;
await runtime.start();
await transport.listen(sockPath);

// Sleepers see time pass only when an entry is admitted. While any thread
// sleeps, admit a tick (signed by the `timer` identity) at most once a second
// so a quiet runtime still wakes them. The timer lives here, not in the
// scheduler: it is an input source like any peer, and replay reads the ticks
// back from the log.
const timer = await signerFor(wallet, NAMES.timer);
let ticking = false;
const ticker = setInterval(async () => {
  if (ticking || runtime.sleeping === 0) return;
  ticking = true;
  try {
    const seq = await runtime.nextSeq(timer.identity);
    await runtime.admit(await signMessage(timer, { seq, at: 0, body: { kind: "tick" } }));
  } catch (e) {
    say(`tick: ${(e as Error).message}`);
  } finally {
    ticking = false;
  }
}, Number(env.SKEIN_TICK_MS || 1000));
say(`skein runtime ${runtime.identity} · db ${dbPath} · socket ${sockPath} · state ${(await runtime.tip())?.toString() ?? "(empty)"}`);

const stop = async (sig: string) => {
  say(`${sig}: stopping`);
  clearInterval(ticker);
  await transport.close();
  await runtime.stop();
  await store.close();
  process.exit(0);
};
process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

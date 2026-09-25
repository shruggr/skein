#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// The clock peer: the first thing outside the runtime (docs/ARCH.md, "Everything
// outside is a peer"). It answers
//   { kind: "time", state }   with { kind: "time", time: Date.now(), state }
//   { kind: "random", state } with { kind: "random", seed: <32 random bytes>, state }
// each a message signed by its identity with a `replies-to` ref to the
// request. The runtime records the reply in its log, so the value is fixed
// forever and replay reads it back instead of asking again.
//
// This is the only place in the repo that reads the wall clock or
// crypto.randomBytes for machine inputs.
//
// Identity: `signerFor(wallet, "clock")`, derived from the same wallet as the
// runtime because that is what this machine has. In production the clock is a
// separate wallet (another key, possibly another machine) and the instance is
// told its identity with an admin `bind` message.

import { randomBytes } from "node:crypto";
import { encode, isCID } from "../runtime/cid.ts";
import type { Message } from "../runtime/records.ts";
import { connectWallet, signerFor, type KeyWallet } from "../wallet.ts";
import { connectPeer, socketPath, type Connection } from "./connection.ts";

export interface ClockOptions {
  wallet: KeyWallet;
  path?: string;
  /** Test hooks: what "now" and "random" are. Default: the wall clock and the OS CSPRNG. */
  now?: () => number;
  seed?: () => Uint8Array;
  log?: (line: string) => void;
}

export async function startClock(o: ClockOptions): Promise<Connection> {
  const signer = await signerFor(o.wallet, "clock");
  const conn = await connectPeer(signer, o.path ?? socketPath());
  const now = o.now ?? (() => Date.now());
  const seed = o.seed ?? (() => new Uint8Array(randomBytes(32)));
  const say = o.log ?? (() => {});
  // Answers go out one at a time so seqs are allocated in order.
  let chain = Promise.resolve();
  conn.onMessage((m: Message) => {
    chain = chain.then(() => answer(m)).catch((e) => say(`clock: ${(e as Error).message}`));
  });
  async function answer(m: Message) {
    const b = m.body as { kind?: unknown; state?: unknown } | null;
    if (!b || !isCID(b.state)) return;
    const refs = [{ to: encode(m).cid, rel: "replies-to" }];
    if (b.kind === "time") {
      const time = now();
      await conn.send({ kind: "time", time, state: b.state }, { to: m.from, refs });
      say(`time ${time} for state …${b.state.toString().slice(-8)}`);
    } else if (b.kind === "random") {
      await conn.send({ kind: "random", seed: seed(), state: b.state }, { to: m.from, refs });
      say(`seed for state …${b.state.toString().slice(-8)}`);
    }
  }
  return conn;
}

if (import.meta.main) {
  const wallet = await connectWallet(process.env.SKEIN_WALLET === "ephemeral" ? { kind: "ephemeral" } : { kind: "remote", url: process.env.SKEIN_WALLET_URL, originator: "skein" });
  const conn = await startClock({ wallet, log: (l) => console.log(l) });
  console.log(`clock ${conn.identity.slice(0, 16)}… connected to runtime ${conn.runtime.slice(0, 16)}… at ${socketPath()}`);
  process.once("SIGINT", () => conn.close());
  process.once("SIGTERM", () => conn.close());
  await conn.closed;
  console.log("clock: disconnected");
}

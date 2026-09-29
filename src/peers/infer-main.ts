#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// `skein-infer`: the inference peer process (infer.ts). Its environment
// (bin/skein-infer fills it from ~/.skein):
//   SKEIN_INFER_WALLET_URL  its BRC-100 wallet, default http://127.0.0.1:3323 (`1sat serve wallet-api`), origin "skein-infer"
//   SKEIN_MAILBOX_URL       its mailbox instance (#40), e.g. http://infer.localhost:8100 or http://127.0.0.1:8100/@infer
//   SKEIN_INFER_PEERS       its address book (#40): {"<identity key hex>": "<messagebox URL>", …}, default
//                           $SKEIN_HOME/infer-peers.json (scripts/host/up.sh writes every agent's); read again
//                           when it changes. A request from a key not in it has nowhere to go: dropped, one line.
//   SKEIN_INFER_PROVIDERS   the provider map file, default $SKEIN_HOME/infer.json
//   SKEIN_INFER_HANDLE      its handle, default infer@localhost
//   SKEIN_INFER_CACHE       its conversation graph on disk (issue #12), default $SKEIN_HOME/infer-cache;
//                           "" keeps it in memory only
//   SKEIN_INFER_NODES       how many nodes it holds in memory, default 50000
//   SKEIN_POLL_MS           default 1000

import { readFileSync, statSync } from "node:fs";
import { RawBox } from "../client/raw.ts";
import { connectWallet } from "../wallet.ts";
import { InferPeer, NodeGraph, type Provider } from "./infer.ts";

const env = process.env;
const home = env.SKEIN_HOME || `${env.HOME}/.skein`;
const say = (line: string) => process.stdout.write(`${line}\n`);
const die = (msg: string): never => { process.stderr.write(`skein-infer: ${msg}\n`); process.exit(1); };

const providersFile = env.SKEIN_INFER_PROVIDERS || `${home}/infer.json`;
let providers: Record<string, Provider>;
try { providers = JSON.parse(readFileSync(providersFile, "utf8")); } catch (e) { die(`${providersFile}: ${(e as Error).message}`); }
if (!env.SKEIN_MAILBOX_URL) die("SKEIN_MAILBOX_URL is not set (its mailbox instance: skein-host add infer --mailbox --owner <its key>)");
const wallet = await connectWallet({ kind: "remote", url: env.SKEIN_INFER_WALLET_URL || "http://127.0.0.1:3323", originator: "skein-infer" });
const { publicKey } = await wallet.getPublicKey({ identityKey: true });
const cache = env.SKEIN_INFER_CACHE ?? `${home}/infer-cache`;
const graph = new NodeGraph({ dir: cache || undefined, max: env.SKEIN_INFER_NODES ? Number(env.SKEIN_INFER_NODES) : undefined });
const peersFile = env.SKEIN_INFER_PEERS || `${home}/infer-peers.json`;
let book: { mtime: number; peers: Record<string, string> } = { mtime: -1, peers: {} };
/** The address book, read again when the file changed (the admin edits it; up.sh rewrites it). */
const addressOf = (key: string): string | undefined => {
  let mtime = 0;
  try { mtime = statSync(peersFile).mtimeMs; } catch { /* none: an empty book */ }
  if (mtime !== book.mtime) {
    try { book = { mtime, peers: mtime ? JSON.parse(readFileSync(peersFile, "utf8")) as Record<string, string> : {} }; } catch (e) { say(`${peersFile}: ${(e as Error).message}`); book = { mtime, peers: {} }; }
  }
  const url = book.peers[key];
  return typeof url === "string" && url ? url : undefined;
};
const outboxes = new Map<string, RawBox>();
const peer = new InferPeer({
  graph, wallet, providers: providers!, handle: env.SKEIN_INFER_HANDLE, log: say,
  raw: {
    inbox: new RawBox(wallet, env.SKEIN_MAILBOX_URL!, { originator: "skein-infer" }),
    outbox: (url) => { let b = outboxes.get(url); if (!b) { b = new RawBox(wallet, url, { originator: "skein-infer" }); outboxes.set(url, b); } return b; },
    addressOf,
  },
});
peer.start(Number(env.SKEIN_POLL_MS || 1000));
say(`skein-infer ${publicKey} · providers ${Object.keys(providers!).join(",")} · mailbox ${env.SKEIN_MAILBOX_URL} · graph ${cache || "in memory"} · address book ${peersFile}`);

const stop = async (sig: string) => { say(`${sig}: stopping`); await peer.stop(); process.exit(0); };
process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

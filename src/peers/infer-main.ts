#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// `skein-infer`: the inference peer process (infer.ts). Its environment
// (bin/skein-infer fills it from ~/.skein):
//   SKEIN_INFER_WALLET_URL  its BRC-100 wallet, default http://127.0.0.1:3323 (`1sat serve wallet-api`), origin "skein-infer"
//   SKEIN_MESSAGEBOX        the messagebox host, e.g. http://127.0.0.1:8100/messagebox
//   SKEIN_INFER_PROVIDERS   the provider map file, default $SKEIN_HOME/infer.json
//   SKEIN_INFER_HANDLE      its handle, default infer@localhost
//   SKEIN_INFER_CACHE       its conversation graph on disk (issue #12), default $SKEIN_HOME/infer-cache;
//                           "" keeps it in memory only
//   SKEIN_INFER_NODES       how many nodes it holds in memory, default 50000
//   SKEIN_POLL_MS           default 1000

import { readFileSync } from "node:fs";
import { messageBoxClient } from "../host/messagebox.ts";
import { connectWallet } from "../wallet.ts";
import { InferPeer, NodeGraph, type Provider } from "./infer.ts";

const env = process.env;
const home = env.SKEIN_HOME || `${env.HOME}/.skein`;
const say = (line: string) => process.stdout.write(`${line}\n`);
const die = (msg: string): never => { process.stderr.write(`skein-infer: ${msg}\n`); process.exit(1); };

const providersFile = env.SKEIN_INFER_PROVIDERS || `${home}/infer.json`;
let providers: Record<string, Provider>;
try { providers = JSON.parse(readFileSync(providersFile, "utf8")); } catch (e) { die(`${providersFile}: ${(e as Error).message}`); }
if (!env.SKEIN_MESSAGEBOX) die("SKEIN_MESSAGEBOX is not set");
const wallet = await connectWallet({ kind: "remote", url: env.SKEIN_INFER_WALLET_URL || "http://127.0.0.1:3323", originator: "skein-infer" });
const { publicKey } = await wallet.getPublicKey({ identityKey: true });
const cache = env.SKEIN_INFER_CACHE ?? `${home}/infer-cache`;
const graph = new NodeGraph({ dir: cache || undefined, max: env.SKEIN_INFER_NODES ? Number(env.SKEIN_INFER_NODES) : undefined });
const peer = new InferPeer({ graph, wallet, box: messageBoxClient(wallet, env.SKEIN_MESSAGEBOX!, "skein-infer"), providers: providers!, handle: env.SKEIN_INFER_HANDLE, log: say });
peer.start(Number(env.SKEIN_POLL_MS || 1000));
say(`skein-infer ${publicKey} · providers ${Object.keys(providers!).join(",")} · messagebox ${env.SKEIN_MESSAGEBOX} · graph ${cache || "in memory"}`);

const stop = async (sig: string) => { say(`${sig}: stopping`); await peer.stop(); process.exit(0); };
process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

// A test host (#40): a router over a temporary host.db and SKEIN_HOME, agents
// and mailbox instances with keys of their own (the oracle's stand-in).

import { existsSync, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKey } from "@bsv/sdk";
import { dirBundles } from "../client/client.ts";
import { RawBox } from "../client/raw.ts";
import { InferPeer } from "../peers/infer.ts";
import { ephemeralWallet } from "../wallet.ts";
import { HostDb } from "./instances.ts";
import { Router } from "./router.ts";

export const until = async <T>(what: string, f: () => Promise<T | undefined> | T | undefined, ms = 30_000): Promise<T> => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    const v = await f();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out: ${what}`);
};

/** A host with agents and mailbox instances, each instance's key its own (the oracle's stand-in). */
export async function testHost(t: { after(f: () => unknown): void }, o: { idleMs?: number; http?: Router["o"]["http"]; infer?: string; ownerMessagebox?: string; ownerKey?: PrivateKey; genesis?: Router["o"]["genesis"] } = {}) {
  const home = await fs.mkdtemp(join(tmpdir(), "skein-router-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const db = new HostDb(join(home, "host.db"));
  const keys = new Map<string, PrivateKey>();
  const keyOf = (h: string) => { let k = keys.get(h); if (!k) { k = PrivateKey.fromRandom(); keys.set(h, k); } return k; };
  const ownerKey = o.ownerKey ?? PrivateKey.fromRandom();
  const owner = ephemeralWallet(ownerKey), ownerId = ownerKey.toPublicKey().toString();
  const lines: string[] = [];
  const router = new Router({
    db, walletFor: (row) => ephemeralWallet(keyOf(row.handle)), owner: ownerId, infer: o.infer, home,
    idleMs: o.idleMs ?? 0, http: o.http, ownerMessagebox: o.ownerMessagebox, genesis: o.genesis, ledgerMs: 60_000, kernel: { env: { SKEIN_HOME: home } },
    log: (s, l) => { lines.push(`[${s}] ${l}`); if (process.env.VERBOSE) console.log(`[${s}] ${l}`); },
  });
  t.after(async () => { await router.stop(); db.close(); });
  await router.listen(0);
  const base = `http://127.0.0.1:${router.port}`;
  const h = {
    home, db, router, base, owner, ownerKey, ownerId, lines, keyOf,
    /** An agent row (its genesis at first hydration: the owner's mailbox must exist first to be named in it). */
    agent(handle: string) { db.add(handle, { store: join(home, "instances", handle, "runtime.db"), identity: keyOf(handle).toPublicKey().toString() }); return keyOf(handle).toPublicKey().toString(); },
    mailbox(handle: string, whose: string) { router.addMailbox(handle, whose); db.add(handle, { identity: keyOf(handle).toPublicKey().toString() }); },
    origin: (handle: string) => router.originOf(handle),
    storeSize(handle: string) { const p = db.get(handle)!.store; return statSync(p).size + (existsSync(`${p}-wal`) ? statSync(`${p}-wal`).size : 0); },
    async entries(handle: string) { const k = (await router.hydrate(handle)).kernel; return (await k.store.get((await k.store.log.tip())!) as unknown as { n: number }).n + 1; },
  };
  return h;
}


/**
 * A small world on a test host (the explorer's and the store reader's tests):
 * the owner's mailbox, the inference peer's, and agent `alpha`; `dir`
 * imported into alpha (objects → `main`); a chat whose turn makes one bash
 * tool call (`ls | head -3`) and answers "README and **src**." into the
 * owner's mailbox. The peer answers from a script, over its raw transport.
 */
export async function chatWorld(t: { after(f: () => unknown): void }, dir: string) {
  const inferKey = PrivateKey.fromRandom(), inferId = inferKey.toPublicKey().toString();
  const h = await testHost(t, { infer: inferId });
  h.mailbox("david", h.ownerId);
  h.mailbox("infer", inferId);
  const alpha = h.agent("alpha");
  await h.router.start();
  const reply = (message: Record<string, unknown>) => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", ...message } }], usage: { prompt_tokens: 10, completion_tokens: 5 }, model: "qwen38" }), { status: 200 });
  const script = [
    reply({ content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "bash", arguments: JSON.stringify({ cmd: "ls | head -3" }) } }] }),
    reply({ content: "README and **src**." }),
  ];
  const w = ephemeralWallet(inferKey);
  const peer = new InferPeer({
    wallet: w, providers: { ripper: { baseUrl: "http://ripper.test/v1" } }, log: (l) => h.lines.push(`[infer] ${l}`),
    fetch: (async () => script.shift() ?? new Response("no more", { status: 500 })) as unknown as typeof fetch,
    raw: {
      inbox: new RawBox(w, `${h.base}/@infer`),
      outbox: (url) => new RawBox(w, url),
      addressOf: (k) => { const r = h.db.list().find((x) => x.identity === k && x.kind !== "mailbox"); return r && h.origin(r.handle); },
    },
  });
  const owner = new RawBox(h.owner, `${h.base}/@alpha`);
  const { root, bundles } = await dirBundles(dir);
  for (const b of bundles) await owner.send(alpha, "objects", b);
  const chat = (await owner.send(alpha, "chat", { text: "What is here?" })).id;
  const mine = new RawBox(h.owner, `${h.base}/@david`);
  await until("alpha's answer", async () => {
    await peer.poll();
    return (await mine.list("chat")).find((m) => (m.value as { text?: string }).text === "README and **src**.");
  }, 60_000);
  await h.router.settled();
  return { h, alpha, root, chat, store: h.db.get("alpha")!.store };
}

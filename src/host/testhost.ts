// A test host (#40): a router over a temporary host.db and SKEIN_HOME, agents
// and mailbox instances with keys of their own (the oracle's stand-in).

import { existsSync, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import type { Store } from "../runtime/store.ts";
import { dirBundles } from "../client/client.ts";
import { RawBox } from "../client/raw.ts";
import { InferPeer } from "../peers/infer.ts";
import { ephemeralWallet } from "../wallet.ts";
import { CHAT_APP, installApps, SHELL_APP, type PinnedApp } from "../testapps.ts";
import { anyOf, dirSource, wasmDirObjects } from "./boot.ts";
import { HostDb } from "./instances.ts";
import { Router } from "./router.ts";
import { Oracle } from "./oracle.ts";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../..");

export const until =async <T>(what: string, f: () => Promise<T | undefined> | T | undefined, ms = 30_000): Promise<T> => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    const v = await f();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out: ${what}`);
};

/**
 * The messages an instance took in, in log order (#68): a mail entry of its
 * own (a host that admits one directly), or a message a request's thread
 * routed — the `admit` of the front door's answer on that thread's updates.
 */
export async function messagesIn(store: Store): Promise<Array<Record<string, unknown>>> {
  const byInput = new Map<string, CID>();
  for await (const t of store.edges.query({ kind: "thread" })) {
    const o = await store.get(t) as { args?: { request?: CID }; input?: CID };
    if (o.args?.request && o.input) byInput.set(o.input.toString(), t);
  }
  const out: Array<Record<string, unknown>> = [];
  for await (const { cid, entry } of store.log.entries(1)) {
    const mail = (entry as { mail?: CID }).mail;
    if (mail) { out.push(await store.get(mail) as Record<string, unknown>); continue; }
    const t = byInput.get(cid.toString());
    if (!t) continue;
    for await (const u of store.chains.history(t)) {
      if (u.equals(t)) continue;
      const up = await store.get(u) as { result?: { stdout?: Uint8Array } };
      if (!up.result?.stdout?.length) continue;
      let a: { admit?: Array<{ mail?: Record<string, unknown> }> };
      try { a = dagCbor.decode(up.result.stdout) as typeof a; } catch { continue; }
      for (const x of a.admit ?? []) if (x.mail) out.push(x.mail);
    }
  }
  return out;
}

/** A host with agents and mailbox instances, each instance's key its own (the oracle's stand-in). */
export async function testHost(t: { after(f: () => unknown): void }, o: { idleMs?: number; http?: Router["o"]["http"]; infer?: string; ownerMessagebox?: string; ownerKey?: PrivateKey; genesis?: Router["o"]["genesis"]; now?: Router["o"]["now"]; arc?: Router["o"]["arc"]; arcRetry?: Router["o"]["arcRetry"] } = {}) {
  const home = await fs.mkdtemp(join(tmpdir(), "skein-router-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const db = new HostDb(join(home, "host.db"));
  const keys = new Map<string, PrivateKey>();
  const keyOf = (h: string) => { let k = keys.get(h); if (!k) { k = PrivateKey.fromRandom(); keys.set(h, k); } return k; };
  const ownerKey = o.ownerKey ?? PrivateKey.fromRandom();
  const owner = ephemeralWallet(ownerKey), ownerId = ownerKey.toPublicKey().toString();
  const lines: string[] = [];
  const providerMaster = PrivateKey.fromRandom();
  const router = new Router({
    db, walletFor: (row) => ephemeralWallet(keyOf(row.handle)), owner: ownerId, infer: o.infer, home,
    idleMs: o.idleMs ?? 0, http: o.http, ownerMessagebox: o.ownerMessagebox, genesis: o.genesis, now: o.now, ledgerMs: 60_000, kernel: { env: { SKEIN_HOME: home } },
    // A broadcaster (#58, #65): its Arcade, and so a `status` provider.
    ...(o.arc ? { arc: o.arc } : {}), ...(o.arcRetry ? { arcRetry: o.arcRetry } : {}),
    // The host's providers (#70) under keys of its own, as `skein-host run` derives them.
    providerKeyFor: (name) => new Oracle(providerMaster).providerKey(name),
    log: (s, l) => { lines.push(`[${s}] ${l}`); if (process.env.VERBOSE) console.log(`[${s}] ${l}`); },
  });
  t.after(async () => { await router.stop(); db.close(); });
  await router.listen(0);
  const base = `http://127.0.0.1:${router.port}`;
  const h = {
    home, db, router, base, owner, ownerKey, ownerId, lines, keyOf,
    /** An agent row (its genesis at first hydration: the owner's mailbox must exist first to be named in it). */
    agent(handle: string) { db.add(handle, { store: join(home, "instances", handle, "runtime.db"), identity: keyOf(handle).toPublicKey().toString() }); return keyOf(handle).toPublicKey().toString(); },
    /**
     * An instance booted from an image (#89; default: the default image,
     * images/default): no owner in its genesis, the claim row. Claim it with
     * `router.claim(handle, ownerId)` (or `skein-host claim`).
     */
    async image(handle: string, dir = join(ROOT, "images/default")) {
      db.add(handle, { store: join(home, "instances", handle, "runtime.db"), identity: keyOf(handle).toPublicKey().toString() });
      const d = await dirSource(dir);
      return await router.bootRow(handle, { kind: "tree", root: d.root, objects: anyOf(d.objects, wasmDirObjects(join(ROOT, "wasm"))) }, { image: true });
    },
    mailbox(handle: string, whose: string) { router.addMailbox(handle, whose); db.add(handle, { identity: keyOf(handle).toPublicKey().toString() }); },
    origin: (handle: string) => router.originOf(handle),
    storeSize(handle: string) { const p = db.get(handle)!.store; return statSync(p).size + (existsSync(`${p}-wal`) ? statSync(`${p}-wal`).size : 0); },
    /**
     * Install apps into an instance as the owner (#83: a genesis has no shell,
     * no `run`, no `chat`): by default the shell app and the chat app, through
     * `skein-host install` (src/testapps.ts). Hydrates the instance first.
     */
    async install(handle: string, apps: PinnedApp[] = [SHELL_APP, CHAT_APP]) {
      await router.hydrate(handle);
      await installApps({ home, port: router.port, owner, settled: () => router.settled() }, handle, apps);
    },
    async entries(handle: string) { const k = (await router.hydrate(handle)).kernel; return (await k.store.get((await k.store.log.tip())!) as unknown as { n: number }).n + 1; },
  };
  return h;
}


/**
 * A small world on a test host (the explorer's and the store reader's tests):
 * the owner's mailbox, the inference peer's, and agent `alpha` with the shell
 * app and the chat app installed (#83); `dir` imported into alpha (objects →
 * `main`); a chat whose turn makes one bash
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
  await h.install("alpha");
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

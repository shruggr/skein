// A test host (#40): a router over a temporary host.db and SKEIN_HOME,
// instances with keys of their own (the signer's stand-in). With no host
// skein its own origin's BRC-169 requests are answered by a fixture over
// host.db (fake-discovery.ts); `hostSkein()` makes the real one (#113): the host
// skein with the onboarding app and the messagebox app installed, which then
// answers them. A key outside the host (the owner, the inference peer, a
// caller) reads its mail as any wallet does: registered as a handle at a host
// skein — a second test host's (`inbox`: host B, so this host keeps its own
// fake discovery) — at the messagebox URL its handle resolves to; this host's
// fake discovery answers that handle with that URL, as a registrar answers a
// handle whose messagebox is elsewhere.

import { existsSync, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthFetch, PrivateKey, ProtoWallet, Utils } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import type { Store } from "../runtime/store.ts";
import { dirBundles } from "../client/client.ts";
import { RawBox, signClaim } from "../client/raw.ts";
import { InferPeer } from "../peers/infer.ts";
import { ephemeralWallet } from "../wallet.ts";
import { CHAT_APP, installApps, ONBOARD_APP, SHELL_APP, type PinnedApp } from "../testapps.ts";
import { fakeDiscovery } from "./fake-discovery.ts";
import { imageSource } from "./boot.ts";
import { HostDb } from "./instances.ts";
import { fetchHttp, REGISTER_PROTOCOL, Router, type SignedClaim } from "./router.ts";
import { Signer } from "./signer.ts";

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
      try { a = dagCbor.decode(up.result.stdout) as typeof a; } catch { continue; } // stdout that is not dag-cbor admitted nothing
      for (const x of a.admit ?? []) if (x.mail) out.push(x.mail);
    }
  }
  return out;
}

/** What a test needs of host B (testHost's `inboxHost`): its router and rows, its entries, its registrations. */
export interface InboxHost { base: string; db: HostDb; router: Router; origin(handle: string): string; entries(handle: string): Promise<number>; register(key: PrivateKey, handle: string): Promise<string> }

/** A host with instances, each instance's key its own (the signer's stand-in). */
export async function testHost(t: { after(f: () => unknown): void }, o: { idleMs?: number; http?: Router["o"]["http"]; infer?: string; ownerMessagebox?: string; ownerKey?: PrivateKey; genesis?: Router["o"]["genesis"]; now?: Router["o"]["now"]; arc?: Router["o"]["arc"]; arcRetry?: Router["o"]["arcRetry"]; headersFeed?: string; teranode?: Router["o"]["teranode"]; billing?: Router["o"]["billing"]; lmdb?: boolean; rocks?: boolean; sqlite?: boolean; reuse?: { home: string; keyOf(handle: string): PrivateKey } } = {}) {
  // #156: `reuse` — a second host over the first's home and keys (a restart: the first's router stopped first).
  const home = o.reuse?.home ?? await fs.mkdtemp(join(tmpdir(), "skein-router-"));
  // #96: o.lmdb — every instance a set of one LMDB environment, <home>/store (host.db `lmdb:<dir>`), else a file each.
  // #158: o.rocks — every instance a set of one RocksDB database, <home>/store-rocksdb, run by one `skein-kernel host` process.
  // The settled split: o.sqlite (or SKEIN_TEST_STORE=sqlite) — every instance a set of one SQLite database, <home>/store.sqlite, on the wasm kernel.
  const sqlite = o.sqlite ?? process.env.SKEIN_TEST_STORE === "sqlite";
  const storeOf = (handle: string) => (sqlite ? `sqlite:${join(home, "store.sqlite")}` : o.rocks ? `rocksdb:${join(home, "store-rocksdb")}` : o.lmdb ? `lmdb:${join(home, "store")}` : join(home, "instances", handle, "runtime.db"));
  if (!o.reuse) t.after(() => fs.rm(home, { recursive: true, force: true }));
  const db = new HostDb(join(home, "host.db"));
  const keys = new Map<string, PrivateKey>();
  const keyOf = (h: string) => { if (o.reuse) return o.reuse.keyOf(h); let k = keys.get(h); if (!k) { k = PrivateKey.fromRandom(); keys.set(h, k); } return k; };
  const ownerKey = o.ownerKey ?? PrivateKey.fromRandom();
  const owner = ephemeralWallet(ownerKey), ownerId = ownerKey.toPublicKey().toString();
  const lines: string[] = [];
  const providerMaster = PrivateKey.fromRandom();
  // The hosted inboxes (inbox): host B, made on first use; the handles this host's fake discovery answers with B's messagebox.
  let b: InboxHost | undefined;
  const elsewhere = new Map<string, { identityKey: string; messagebox: string }>();
  // This host's http beyond its own (the router's default, SKEIN_HTTP), and host B's URLs for real: deliveries to the hosted inboxes.
  const http = o.http ?? (async (req: Parameters<NonNullable<Router["o"]["http"]>>[0]) => {
    let toB = false;
    try { toB = !!b && new URL(req.url).port === String(b.router.port); } catch { /* not a URL: not B's */ }
    if (toB || process.env.SKEIN_HTTP === "fetch") return await fetchHttp(req);
    throw new Error(`this host answers no http beyond its own (${req.url})`);
  });
  const router = new Router({
    db, walletFor: (row) => ephemeralWallet(keyOf(row.handle)), owner: ownerId, infer: o.infer, home,
    idleMs: o.idleMs ?? 0, http, ownerMessagebox: o.ownerMessagebox, genesis: o.genesis, now: o.now, ledgerMs: 60_000, kernel: { env: { SKEIN_HOME: home } },
    // A broadcaster (#58, #65): its Arcade, and so a `status` provider.
    ...(o.arc ? { arc: o.arc } : {}), ...(o.arcRetry ? { arcRetry: o.arcRetry } : {}),
    // The host's headers feed (#102).
    ...(o.headersFeed ? { headersFeed: o.headersFeed } : {}),
    // #156: the Teranode headers tracker (a fake mesh and hub in the tests).
    ...(o.teranode ? { teranode: o.teranode } : {}),
    // #130: what the host bills (billing.ts); none: it bills no one.
    ...(o.billing ? { billing: o.billing } : {}),
    ...(o.lmdb ? { lmdbStore: join(home, "store") } : {}),
    ...(o.rocks ? { rocksStore: join(home, "store-rocksdb") } : {}),
    // The settled split: the wasm kernel over the host's one SQLite database (SKEIN_TEST_STORE=sqlite: every test host so).
    ...(sqlite ? { sqliteStore: join(home, "store.sqlite") } : {}),
    // #113: with no host skein, discovery over host.db (a fixture); hostSkein() makes the real server.
    discovery: fakeDiscovery(db, () => router, elsewhere),
    // The host's providers (#70) under keys of its own, as `skein-host run` derives them.
    providerKeyFor: (name) => new Signer(providerMaster).providerKey(name),
    log: (s, l) => { lines.push(`[${s}] ${l}`); if (process.env.VERBOSE) console.log(`[${s}] ${l}`); },
  });
  t.after(async () => { await router.stop(); db.close(); });
  await router.listen(0);
  const base = `http://127.0.0.1:${router.port}`;
  const h = {
    home, db, router, base, owner, ownerKey, ownerId, lines, keyOf,
    /**
     * An instance's row, its
     * genesis at first hydration (the owner's mailbox must exist first to be
     * named in it). Its identity key (hex).
     */
    instance(handle: string) { db.add(handle, { store: storeOf(handle), identity: keyOf(handle).toPublicKey().toString() }); return keyOf(handle).toPublicKey().toString(); },
    /** The same as `instance`, by its old name (for tests written before the rename). */
    agent(handle: string) { return h.instance(handle); },
    /**
     * An instance booted from an image (#89; default: the default image,
     * images/default): no owner in its genesis, the claim row from anyone.
     * Claim it with a message from the owner's wallet in box `claim`
     * (src/testapps.ts sendPlan of planClaim, #127): its sender owns it.
     */
    async image(handle: string, dir = join(ROOT, "images/default")) {
      db.add(handle, { store: storeOf(handle), identity: keyOf(handle).toPublicKey().toString() });
      return await router.bootRow(handle, await imageSource(dir), { image: true });
    },
    /**
     * The host skein (#90, #113, #142): `host` from the host image (the
     * default image with the onboarding app), its genesis naming the owner
     * (the operator's key here), the instance manager and the certifier in
     * its address book; the onboarding app's config at birth over its
     * manifest's (default: domain `localhost`, origin this router's). Its own
     * origin's BRC-169 requests are then the app's.
     */
    async hostSkein(config: Record<string, unknown> = {}) {
      const c = await router.createInstance("host", ownerId, { host: true, appConfig: { onboard: { onboard: { domain: "localhost", origin: base, messagebox: `${router.originOf("host")}/messagebox`, ...config } } } });
      await router.hydrate("host");
      await router.settled();
      return c;
    },
    /**
     * `key` registered as `handle` at this host's host skein (made if it is not yet: hostSkein) — the
     * registration a wallet makes (POST /account/register over its session, signed over `register
     * <handle>@localhost`) — and its messagebox URL, what the handle resolves to (the host skein's
     * messagebox app, `<host skein>/messagebox`).
     */
    async register(key: PrivateKey, handle: string): Promise<string> {
      if (!db.hostSkein()) await h.hostSkein();
      const { signature } = await new ProtoWallet(key).createSignature({ protocolID: REGISTER_PROTOCOL, keyID: handle, counterparty: "anyone", data: Utils.toArray(`register ${handle}@localhost`, "utf8") });
      const r = await new AuthFetch(ephemeralWallet(key)).fetch(`${base}/account/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: handle, identityKey: key.toPublicKey().toString(), signature: Utils.toHex(signature) }) });
      const a = await r.json() as { messagebox?: string; error?: string };
      if (r.status !== 200 || !a.messagebox) throw new Error(`register ${handle}: HTTP ${r.status} ${a.error ?? ""}`);
      return a.messagebox;
    },
    /** Host B (a second test host, the same store kind), the hosted inboxes' — made on first use. */
    async inboxHost(): Promise<InboxHost> {
      b ??= await testHost(t, { sqlite, ...(o.rocks ? { rocks: true } : {}), ...(o.lmdb ? { lmdb: true } : {}) });
      return b;
    },
    /**
     * A key's hosted inbox: `key` registered as `handle` at host B's host skein (B.register), this
     * host's fake discovery answering `handle` with that messagebox URL (the handle's messagebox is
     * elsewhere). Its URL; read it with RawBox there.
     */
    async inbox(key: PrivateKey, handle: string): Promise<string> {
      const url = await (await h.inboxHost()).register(key, handle);
      elsewhere.set(handle, { identityKey: key.toPublicKey().toString(), messagebox: url });
      return url;
    },
    /**
     * The owner's hosted inbox (`inbox` with the owner's key, as `handle`), and the owner's messagebox
     * setting (the router's `ownerMessagebox`, SKEIN_OWNER_MESSAGEBOX's) set to it — before any
     * instance's genesis names it. Its URL.
     */
    async ownerInbox(handle = "david"): Promise<string> {
      const url = await h.inbox(ownerKey, handle);
      router.o.ownerMessagebox = url;
      return url;
    },
    origin: (handle: string) => router.originOf(handle),
    storeSize(handle: string) { const p = db.get(handle)!.store; return statSync(p).size + (existsSync(`${p}-wal`) ? statSync(`${p}-wal`).size : 0); },
    /**
     * Install apps into an instance as the owner (#83: a genesis has no shell,
     * no `run`, no `chat`): by default the shell app and the chat app, through
     * the owner's messages (src/testapps.ts installApps, #124). Hydrates the instance first.
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
 * the owner's inbox, the inference peer's (hosted in the host skein), and instance `alpha` with the shell
 * app and the chat app installed (#83); `dir` imported into alpha (objects →
 * `main`); a chat whose turn makes one bash
 * tool call (`ls | head -3`) and answers "README and **src**." into the
 * owner's mailbox. The peer answers from a script, over its raw transport.
 */
export async function chatWorld(t: { after(f: () => unknown): void }, dir: string, o: { sqlite?: boolean } = {}) {
  const inferKey = PrivateKey.fromRandom(), inferId = inferKey.toPublicKey().toString();
  const h = await testHost(t, { infer: inferId, ...o });
  const mailbox = await h.ownerInbox();
  const inferBox = await h.inbox(inferKey, "infer");
  const alpha = h.instance("alpha");
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
      inbox: new RawBox(w, inferBox),
      outbox: (url) => new RawBox(w, url),
      addressOf: (k) => { const r = h.db.list().find((x) => x.identity === k); return r && h.origin(r.handle); },
    },
  });
  const owner = new RawBox(h.owner, `${h.base}/@alpha`);
  const { root, bundles } = await dirBundles(dir);
  for (const b of bundles) await owner.send(alpha, "objects", b);
  const chat = (await owner.send(alpha, "chat", { text: "What is here?" })).id;
  const mine = new RawBox(h.owner, mailbox);
  await until("alpha's answer", async () => {
    await peer.poll();
    return (await mine.list("chat")).find((m) => (m.value as { text?: string }).text === "README and **src**.");
  }, 60_000);
  await h.router.settled();
  return { h, alpha, root, chat, store: h.db.get("alpha")!.store };
}

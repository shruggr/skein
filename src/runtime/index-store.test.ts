// The store format of issue #30 read from TypeScript (index-store.ts): the
// Merkle search tree (canonical, ordered), and a whole instance — written by
// the TS runtime, converted to the new format — read back through the index:
// every Store question, every explorer page and the skein-dev commands answer
// as they do over the TS runtime's own file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";
import { encode } from "./cid.ts";
import { InferPeer } from "../peers/infer.ts";
import { ensureGenesis } from "../host/entry.ts";
import { stampMs } from "./log.ts";
import { openStore, type SqliteStore } from "./sqlite.ts";
import { buildTree, cat, compare, be64, hasStatePointer, openStoreFile, Trees, writeIndexFile } from "./index-store.ts";
import { bundlesOf, installWasm, instance, send, T0 } from "../testkit.ts";
import { ephemeralWallet } from "../wallet.ts";
import { render } from "../dev/explore/server.ts";
import { load } from "../dev/explore/view.ts";
import { replay } from "../dev/cli.ts";

test("mst: lookups, ordered ranges and prefixes; one tree per set whatever the order", () => {
  const pairs: Array<[Uint8Array, unknown]> = [];
  for (let i = 0; i < 3000; i++) pairs.push([cat(be64(i * 7919 % 3001), Uint8Array.of(i & 3)), i]);
  const blocks = new Map<string, Uint8Array>();
  const a = buildTree(pairs);
  for (const b of a.blocks) blocks.set(b.cid.toString(), b.bytes);
  const shuffled = [...pairs].sort(() => Math.random() - 0.5);
  assert.ok(buildTree(shuffled).root!.equals(a.root!));
  assert.ok(a.blocks.length > 50, `fan-out ~32: ${a.blocks.length} nodes`);
  const t = new Trees((c) => blocks.get(c.toString()));
  for (const [k, v] of pairs.slice(0, 200)) assert.equal(t.lookup(a.root, k), v);
  assert.equal(t.lookup(a.root, Uint8Array.of(1, 2, 3)), undefined);
  const all = [...t.range(a.root)];
  assert.equal(all.length, 3000);
  for (let i = 1; i < all.length; i++) assert.ok(compare(all[i - 1][0], all[i][0]) < 0);
  const mid = [...t.range(a.root, be64(1000), be64(2000))];
  assert.deepEqual(mid.map(([k]) => k), all.map(([k]) => k).filter((k) => compare(k, be64(1000)) >= 0 && compare(k, be64(2000)) < 0));
  assert.ok(mid.length > 990);
  assert.equal([...t.prefixed(a.root, be64(5))].length, 1);
  assert.equal(buildTree([]).root, null);
});

type Json = Record<string, unknown>;
const answer = (message: Json) => ({ choices: [{ message: { role: "assistant", ...message } }], usage: { prompt_tokens: 10, completion_tokens: 5 }, model: "qwen38" });
const toolCall = (id: string, cmd: string) => ({ id, type: "function", function: { name: "bash", arguments: JSON.stringify({ cmd }) } });

/** An instance on a SQLite file (the TS runtime's format): a directory imported, a chat turn with a bash call. */
async function instanceFile(dir: string): Promise<{ path: string; chat: ReturnType<typeof encode>["cid"] }> {
  const path = join(dir, "ts.db");
  await fs.mkdir(join(dir, "tree/src"), { recursive: true });
  await fs.writeFile(join(dir, "tree/src/a.txt"), "alpha\n");
  await fs.writeFile(join(dir, "tree/README"), "hello\n");
  const store = openStore(path);
  const instanceKey = PrivateKey.fromRandom(), ownerKey = PrivateKey.fromRandom(), hostKey = PrivateKey.fromRandom(), inferKey = PrivateKey.fromRandom();
  await installWasm(store);
  await ensureGenesis(store, ephemeralWallet(instanceKey), ephemeralWallet(hostKey), { owner: ownerKey.toPublicKey().toString(), peers: { infer: inferKey.toPublicKey().toString() } }, T0);
  const i = await instance({ store, instanceKey, ownerKey, hostKey });
  const answers = [answer({ content: "", tool_calls: [toolCall("call-1", "ls | head -3")] }), answer({ content: "README and **src**." })];
  const peer = new InferPeer({
    wallet: ephemeralWallet(inferKey), box: i.hub.as(inferKey.toPublicKey().toString()), log: () => {},
    providers: { ripper: { baseUrl: "http://ripper.test/v1", apiKey: "k" } }, now: () => stampMs(i.clock.now()),
    fetch: (async () => new Response(JSON.stringify(answers.shift()), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
  });
  const settle = async () => { await i.delivery.poll(); await i.rt.idle(); };
  const { bundles } = await bundlesOf(join(dir, "tree"));
  for (const b of bundles) await send(i, "objects", b);
  await settle();
  const { signedPart } = await import("../envelope.ts");
  const chat = encode(signedPart(await send(i, "chat", { text: "What is here?" }))).cid;
  await settle();
  await peer.poll(); await settle();
  await peer.poll(); await settle();
  await i.rt.stop();
  await store.close();
  return { path, chat };
}

async function collect<T>(it: AsyncIterable<T>): Promise<string[]> {
  const out: string[] = [];
  for await (const x of it) out.push(String(x));
  return out;
}

test("index store: the Store, every explorer page and skein-dev answer as over the TS runtime's file", async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), "skein-index-store-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { path, chat } = await instanceFile(dir);
  const newPath = join(dir, "new.db");
  await writeIndexFile(path, newPath);
  assert.ok(hasStatePointer(newPath) && !hasStatePointer(path));

  const old = openStoreFile(path, { readOnly: true });
  const ix = openStoreFile(newPath, { readOnly: true });
  t.after(async () => { await old.close(); await ix.close(); });
  assert.ok("state" in ix && !("state" in old), "each file gets its own reader");

  // The Store questions.
  const same = async (what: string, f: (s: SqliteStore) => Promise<unknown>) => assert.deepEqual(JSON.stringify(await f(ix)), JSON.stringify(await f(old)), what);
  await same("log", async (s) => (await collect((async function* () { for await (const e of s.log.entries()) yield e.cid; })())));
  await same("log from 3", async (s) => (await collect((async function* () { for await (const e of s.log.entries(3)) yield e.cid; })())));
  await same("tip", (s) => s.log.tip());
  await same("cursor", (s) => s.live.cursor.get());
  const entry = await old.log.byEnvelope(chat);
  assert.ok(entry);
  await same("byEnvelope", (s) => s.log.byEnvelope(chat));
  for (const f of [{}, { kind: "thread" as const }, { kind: "head" as const }, { kind: "thread" as const, orderBy: "tipAt" as const }, { kind: "thread" as const, state: ["waiting" as const] }, { kind: "thread" as const, parentless: true, limit: 2 }]) {
    await same(`query ${JSON.stringify(f)}`, (s) => collect(s.edges.query(f)));
  }
  await same("resting", (s) => collect(s.live.resting()));
  await same("due", (s) => collect(s.live.due(Number.MAX_SAFE_INTEGER)));
  const threads = await collect(old.edges.query({ kind: "thread" }));
  assert.ok(threads.length >= 3);
  for (const th of threads) {
    const c = (await old.findByPrefix(th))[0];
    await same(`history ${th}`, (s) => collect(s.chains.history(c)));
    await same(`tip ${th}`, (s) => s.chains.tip(c));
    await same(`refsFrom ${th}`, (s) => s.edges.refsFrom(c));
    await same(`refsTo ${th}`, (s) => s.edges.refsTo(c));
    await same(`waitersOn ${th}`, (s) => collect(s.live.waitersOn(c)));
    const last = (await collect(old.chains.history(c))).at(-1)!;
    await same(`originOf ${th}`, async (s) => s.chains.originOf((await old.findByPrefix(th))[0]).then(async (o) => [o, await s.chains.originOf(await import("./cid.ts").then((m) => m.parse(last)))]));
  }
  await same("awaiting", async (s) => {
    const out: string[][] = [];
    for (const th of threads) {
      const tip = (await old.get(await old.chains.tip((await old.findByPrefix(th))[0]))) as unknown as Json;
      for (const e of (tip.awaits as ReturnType<typeof encode>["cid"][] | undefined) ?? []) out.push(await collect(s.live.awaiting(e)));
    }
    return out;
  });
  await same("findByPrefix", async (s) => (await s.findByPrefix("")).map(String).sort());
  await assert.rejects(ix.chains.append((await ix.findByPrefix(""))[0], { at: 1 }), /readonly/);

  // Every explorer page.
  const w = await load(old);
  const pages = ["/", "/log", "/log?before=3", "/s", "/threads", "/threads?program=shell", "/threads?state=waiting", "/h/main", "/nope", `/e/${entry}`, "/e/0"];
  for (const th of w.threads) pages.push(`/t/${th.cid}`, `/t/${th.cid}?frag=1`, `/t/${th.cid}?tip=1`, `/r/${th.cid}`, `/t/${th.cid.toString().slice(-10)}`);
  for (const { cid } of w.log) pages.push(`/e/${cid}`, `/r/${cid}`);
  for (const th of w.threads) for (const { cid } of th.updates) pages.push(`/r/${cid}`);
  for (const p of pages) {
    const a = await render(old, new URL(p, "http://x")), b = await render(ix, new URL(p, "http://x"));
    assert.equal(b.status, a.status, `${p}: status`);
    assert.equal(b.body, a.body, `${p}: body`);
  }
  assert.equal((await render(ix, new URL("/", "http://x"))).status, 200);

  // skein-dev over the file, and its replay against the index store.
  const outs: string[] = [];
  assert.equal(await replay(ix, { out: (l) => outs.push(l), err: (l) => outs.push(`! ${l}`), write: () => {} }), 0, outs.join("\n"));
  const bin = fileURLToPath(new URL("../../bin/skein-dev", import.meta.url));
  const dev = (db: string, ...args: string[]) => spawnSync(bin, args, { env: { ...process.env, SKEIN_DB: db }, encoding: "utf8" });
  for (const args of [["log"], ["ls"], ["show", threads[0].slice(-12)], ["refs", threads[0].slice(-12)], ["replay"]]) {
    const a = dev(path, ...args), b = dev(newPath, ...args);
    assert.equal(b.status, 0, `skein-dev ${args.join(" ")}: ${b.stderr}`);
    assert.equal(b.stdout, a.stdout, `skein-dev ${args.join(" ")}`);
  }
  const rb = dev(newPath, "rebuild");
  assert.notEqual(rb.status, 0);
  assert.match(rb.stderr, /Zig kernel/);
});

// The store format of issue #30 read from TypeScript (index-store.ts): the
// Merkle search tree (canonical, ordered), and a whole instance written by
// the Zig kernel through a router (testhost.ts: an instance from the default
// image, a directory imported by the owner's messages) read back through
// the index: the maps derived here are the kernel's, root for root; the Store
// questions answer; skein-dev reads the file; writes are refused.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CID } from "multiformats/cid";
import { KERNEL_BIN } from "../host/kernel.ts";
import { dirBundles } from "../client/client.ts";
import { RawBox } from "../client/raw.ts";
import { testHost } from "../host/testhost.ts";
import { collect } from "../testkit.ts";
import { fmt } from "./cid.ts";
import { buildTree, cat, compare, be64, derive, MAPS, openStoreFile, Trees } from "./index-store.ts";

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

type IndexStore = ReturnType<typeof openStoreFile> & { state(): { cid: CID; log: CID | null; cursor: number; roots: Record<string, CID | null> } };

test("index store: a store the kernel wrote — every map derived here is the kernel's; the Store answers; skein-dev reads it; writes refused", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), "skein-index-store-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(join(dir, "tree/src"), { recursive: true });
  await fs.writeFile(join(dir, "tree/src/a.txt"), "alpha\n");
  await fs.writeFile(join(dir, "tree/README"), "hello\n");
  // A store FILE (what skein-dev and SKEIN_DB read): an instance from the default image (one loader, SPEC 8),
  // the directory imported by the owner's messages (objects, then head main) through its front door.
  const h = await testHost(t, { sqlite: false });
  const alpha = await h.instance("alpha");
  await h.router.start();
  const owner = new RawBox(h.owner, `${h.base}/@alpha`);
  const { root, bundles } = await dirBundles(join(dir, "tree"));
  for (const b of bundles) await owner.send(alpha, "objects", b);
  await owner.send(alpha, "head", { name: "main", tree: root });
  await h.router.settled();
  const w = { store: h.db.get("alpha")!.store };

  const ix = openStoreFile(w.store, { readOnly: true }) as IndexStore;
  t.after(() => ix.close());
  assert.ok("state" in ix, "a file with the state pointer gets the index reader");
  const blocksOnly = openStoreFile(join(dir, "blocks.db"));
  assert.ok(!("state" in blocksOnly), "any other file gets sqlite.ts's");
  await blocksOnly.close();

  // The derivation (index.zig's, done here): the same root for every map.
  const st = ix.state();
  const d = await derive(ix);
  for (const m of MAPS) assert.equal(String(buildTree(d.pairs[m]).root), String(st.roots[m]), `map ${m}`);

  // The Store questions.
  const log = await collect(ix.log.entries());
  assert.ok(log[0]!.entry.genesis, "entry 0 is the genesis");
  // #68: every package a transport carried in is an entry — the handshake and the owner's messages, each an HTTP request.
  assert.ok(log.slice(1).every((e) => String((e.entry as unknown as { transport?: string }).transport) === "http"), "every other entry is a package as received: an HTTP request");
  assert.ok(log.length >= 4, `the genesis, the handshake, the import and the head (${log.length})`);
  assert.equal(fmt((await ix.log.tip())!), fmt(st.log!));
  assert.equal(fmt(log.at(-1)!.cid), fmt(st.log!));
  assert.equal(await ix.live.cursor.get(), log.length, "every entry processed");
  assert.deepEqual((await collect(ix.log.entries(3))).map((e) => fmt(e.cid)), log.slice(3).map((e) => fmt(e.cid)));
  const all = await collect(ix.edges.query({ kind: "thread" }));
  const isRequest = async (th: CID) => !!((await ix.get(th)) as { args?: { request?: unknown } }).args?.request;
  const requests = (await Promise.all(all.map(isRequest))).filter(Boolean).length;
  assert.equal(requests, log.length - 1, "one front-door thread per request");
  for (const th of all) {
    const history = await collect(ix.chains.history(th));
    assert.ok(history[0]!.equals(th) && history.at(-1)!.equals(await ix.chains.tip(th)), "a chain runs from its origin to its tip");
    assert.ok((await ix.chains.originOf(history.at(-1)!)).equals(th));
  }
  assert.equal((await collect(ix.edges.query({ kind: "thread", state: ["waiting"] }))).length, 0, "nothing waits");
  assert.ok((await ix.findByPrefix("")).length > 0);
  await assert.rejects(ix.chains.append(all[0]!, { at: 1 }), /readonly/);
  const one = all[0]!;

  // skein-dev over the file.
  const bin = fileURLToPath(new URL("../../bin/skein-dev", import.meta.url));
  const dev = (...args: string[]) => spawnSync(bin, args, { env: { ...process.env, SKEIN_DB: w.store }, encoding: "utf8" });
  const l = dev("log");
  assert.equal(l.status, 0, l.stderr);
  assert.match(l.stdout, new RegExp(`^state ${fmt(st.log!)} · processed ${log.length}/${log.length}$`, "m"));
  const ls = dev("ls");
  assert.equal(ls.status, 0, ls.stderr);
  assert.equal(ls.stdout.trim().split("\n").length, Math.min(20, all.length), "every thread, the requests' too, up to the limit");
  const show = dev("show", fmt(one).slice(-12));
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /"kind": "thread"/);
  const refs = dev("refs", fmt(one).slice(-12));
  assert.equal(refs.status, 0, refs.stderr);
  assert.equal(dev("replay").status, 2, "no replay here: it is the kernel's (skein-kernel replay)");
});

// The system tree (#4, docs/BOOTSTRAP.md; skein next, SPEC 3 and 8) as the loader reads it, and the
// genesis it resolves to — without a kernel where it can; through the router where the kernel matters.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKey } from "@bsv/sdk";
import type { CID } from "multiformats/cid";
import { encode } from "../runtime/cid.ts";
import * as dagCbor from "@ipld/dag-cbor";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { hostNetwork, main } from "./cli.ts";
import { HostDb } from "./instances.ts";
import { Router } from "./router.ts";
import { Signer } from "./signer.ts";
import { checkImageApps, dirSource, imageSource, installAtBirth, isOverlayImage, namedImageSource, readSystemTree } from "./boot.ts";
import { appIgnore, readApp } from "./install.ts";
import { planInstall } from "./plan.ts";
import { genesisRecord, resolveSystem } from "./genesis.ts";
import { rowKey } from "../runtime/dispatch.ts";
import { NEXT_APP } from "./testhost.ts";

const key = () => PrivateKey.fromRandom().toPublicKey().toString();
const DEFAULT = join(import.meta.dirname, "../../images/default");

async function tree(t: { after(f: () => unknown): void }, files: Record<string, string | Uint8Array>) {
  const dir = await fs.mkdtemp(join(tmpdir(), "skein-system-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [p, c] of Object.entries(files)) {
    await fs.mkdir(join(dir, p, ".."), { recursive: true });
    await fs.writeFile(join(dir, p), c);
  }
  return dirSource(dir);
}

test("system tree (SPEC 3): etc/routes.json rows and etc/config.json {defaults, grants} resolve into a genesis — identity, handle, domain, routes, grants, defaults, tree; no programs, scopes, roles, peers", async (t) => {
  const g0 = key();
  const { root, objects } = await tree(t, {
    "etc/routes.json": JSON.stringify([{ kind: "request", path: "/kernel/route", role: "root", handler: "kernel.route" }, { kind: "request", path: "/kernel/claim", role: "user", handler: "kernel.claim" }]),
    "etc/config.json": JSON.stringify({ defaults: { fuelPerStep: "5" }, grants: { "x.y": [g0] } }),
    "SOUL.md": "hi\n",
  });
  const s = await readSystemTree(objects, root);
  const owner = key();
  const c = { identity: key(), handle: "a", domain: "localhost", grants: { root: [owner] }, defaults: { fuelPerStep: "9" } };
  const g = genesisRecord(c, resolveSystem(c, s.config, s.routes, root)) as Record<string, any>;
  assert.ok(g.tree.equals(root));
  assert.equal(g.defaults.fuelPerStep, "5", "the tree's config wins over the host's defaults");
  const warned: string[] = [];
  const o = { ...c, overrides: { fuelPerStep: "7" }, warn: (l: string) => warned.push(l) };
  assert.equal((genesisRecord(o, resolveSystem(o, s.config, s.routes, root)) as Record<string, any>).defaults.fuelPerStep, "7", "an explicit override wins");
  assert.match(warned[0]!, /replaces the system tree's fuelPerStep = 5/);
  assert.deepEqual(Object.keys(g.grants).sort(), ["root", "x.y"]);
  assert.equal(Buffer.from(g.grants.root[0]).toString("hex"), owner);
  assert.equal(Buffer.from(g.grants["x.y"][0]).toString("hex"), g0);
  assert.deepEqual(g.routes.map(rowKey), ["path /kernel/route", "path /kernel/claim"]);
  for (const k of ["programs", "scopes", "roles", "peers", "names", "collect", "dispatch", "addressBook", "root", "owner"]) assert.equal(g[k], undefined, `no ${k}`);
});

test("the default image: the kernel's operation rows (root's) and the claim row (user); no apps", async () => {
  const src = await imageSource(DEFAULT);
  const s = await readSystemTree(src.objects, src.root);
  assert.equal(s.apps, undefined, "no etc/apps.json");
  assert.deepEqual(s.routes.map((r) => [r.path, r.role, r.handler]), [
    ["/kernel/objects", "root", "kernel.objects"], ["/kernel/head", "root", "kernel.head"], ["/kernel/route", "root", "kernel.route"],
    ["/kernel/grant", "root", "kernel.grant"], ["/kernel/claim", "user", "kernel.claim"],
  ]);
  assert.equal(isOverlayImage(DEFAULT), false, "etc/routes.json: a complete image");
});

test("system tree: refusals — no rows, bin/ (programs come in apps), the old row form, a bad row, a config field gone", async (t) => {
  const none = await tree(t, { "SOUL.md": "x" });
  await assert.rejects(readSystemTree(none.objects, none.root), /routes\.json: missing/);
  const bin = await tree(t, { "bin/x.wasm": "x", "etc/routes.json": "[]" });
  await assert.rejects(readSystemTree(bin.objects, bin.root), /bin\/: gone/);
  const old = await tree(t, { "etc/dispatch.json": "[]", "etc/routes.json": "[]" });
  await assert.rejects(readSystemTree(old.objects, old.root), /etc\/dispatch\.json: the old form is gone/);
  const bad = await tree(t, { "etc/routes.json": JSON.stringify([{ kind: "request", path: "/x", handler: "a.f" }]) });
  await assert.rejects(readSystemTree(bad.objects, bad.root), /role: every request and read row names its role/);
  for (const k of ["feeds", "peers", "libp2p", "roles", "scopes"]) {
    const c = await tree(t, { "etc/routes.json": "[]", "etc/config.json": JSON.stringify({ [k]: {} }) });
    await assert.rejects(readSystemTree(c.objects, c.root), new RegExp(`\`${k}\``), k);
  }
});

/** A copy of the test app (programs/test/next-app) named `name`, at `dir`. */
async function nextApp(dir: string, name: string): Promise<void> {
  await fs.cp(NEXT_APP, dir, { recursive: true });
  const m = JSON.parse(await fs.readFile(join(dir, "etc/app.json"), "utf8")) as { routes: Array<Record<string, unknown>> } & Record<string, unknown>;
  // The rows under the app's own name.
  const re = (x: unknown) => typeof x === "string" ? x.replace(/^(\/?)next([./]|$)/, `$1${name}$2`) : x;
  m.routes = m.routes.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Array.isArray(v) ? v.map(re) : re(v)])));
  await fs.writeFile(join(dir, "etc/app.json"), `${JSON.stringify({ ...m, name }, null, 2)}\n`);
}

test("#152: an image's apps — a directory of the image, one beside it, a tarball by {url, hash} — each installed at birth as the install's requests would: its objects put, its record, rows and head; root's own row", async (t) => {
  const work = await fs.mkdtemp(join(tmpdir(), "skein-img-"));
  const server = createServer(async (req, res) => {
    try { res.end(await fs.readFile(join(work, req.url!.slice(1)))); } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => { server.close(); await fs.rm(work, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const image = join(work, "image");
  await fs.cp(DEFAULT, image, { recursive: true });
  await nextApp(join(image, "apps/one"), "one");
  await nextApp(join(work, "two"), "two");
  await nextApp(join(work, "three"), "three");
  assert.equal(spawnSync("tar", ["-czf", join(work, "three.tgz"), "-C", work, "three"]).status, 0);
  const three = (await dirSource(join(work, "three"), { ignore: appIgnore })).root;
  const hash = Buffer.from(three.multihash.digest).toString("hex");
  const tarball = { url: `${base}/three.tgz`, hash };
  const own = { kind: "request", path: "/ping", role: "user", handler: "one.main.handle" };
  await fs.writeFile(join(image, "etc/apps.json"), JSON.stringify({ install: ["apps/one", "../two", tarball], routes: [own] }));

  const src = await imageSource(image);
  assert.deepEqual(Object.keys(src.apps ?? {}), ["../two"], "the directory beside the image is read with it");
  const s = await readSystemTree(src.objects, src.root);
  assert.deepEqual(Object.keys(s.appTrees ?? {}), ["apps/one"]);
  const identity = key();
  const c = { identity, handle: "a", domain: "localhost" };
  const sys = resolveSystem(c, s.config, s.routes, src.root);
  const kept = new Map<string, Uint8Array>();
  const target = { hasBlock: async (cid: CID) => kept.has(cid.toString()), putBlock: async (cid: CID, b: Uint8Array) => { kept.set(cid.toString(), b); } };
  const born = await installAtBirth(target, src.objects, s, sys, c, src.apps);
  assert.deepEqual(born.apps.map((a) => `${a.name} ${a.version}`), ["one 0.1.0", "two 0.1.0", "three 0.1.0"]);
  assert.deepEqual(Object.keys(born.heads).sort(), ["one/app", "three/app", "two/app"]);
  const get = (cid: CID) => dagCbor.decode(kept.get(cid.toString())!) as Record<string, any>;
  assert.ok(get(born.heads["three/app"]!).tree.equals(three), "the tarball's app record names its tree, the hash");
  const keys = born.rows.map(rowKey);
  assert.ok(keys.includes("path /three/user") && keys.includes("event three/event"), keys.join(", "));
  assert.equal(born.rows.at(-1)!.path, "/ping", "root's own row after the apps");
  assert.equal(born.rows.find((r) => r.path === "/two/admin")!.role, "two.admin", "a declared role → <app>.<role>");
  // The same app record as an install by requests over the instance: the same CID, the same rows byte for byte.
  const view = { store: { has: async () => false, get: async () => { throw new Error("none"); }, bytes: async () => { throw new Error("none"); }, putBlock: async () => {} } as never, identity, heads: [], dispatch: [...sys.routes] };
  const viaRequests = await planInstall(await readApp(join(image, "apps/one")), view, { modules: src.objects });
  assert.ok(viaRequests.recordCid.equals(born.heads["one/app"]!));
  assert.deepEqual(viaRequests.rows.map((r) => encode(r.row as never).cid.toString()), born.rows.filter((r) => r.handler.startsWith("one.") && r.path !== "/ping").map((r) => encode(r as never).cid.toString()));

  // Refusals.
  const fresh = { hasBlock: async () => false, putBlock: async () => {} };
  const wrong = { ...s, apps: { install: [{ url: tarball.url, hash: "00".repeat(20) }] } };
  await assert.rejects(installAtBirth(fresh, src.objects, wrong, sys, c), /three\.tgz: its tree is [0-9a-f]{40}, not 0{40}/);
  const gone = { ...s, apps: { install: [{ url: `${base}/none.tgz`, hash }] } };
  await assert.rejects(installAtBirth(fresh, src.objects, gone, sys, c), /none\.tgz: 404/);
  const taken = { ...s, apps: { install: ["apps/one"], routes: [{ kind: "request", path: "/one/user", role: "user", handler: "one.main.handle" }] } };
  await assert.rejects(installAtBirth(fresh, src.objects, taken as never, sys, c, src.apps), /another row has it/);
  assert.throws(() => checkImageApps({ install: [{ url: tarball.url } as never] }), /want \{install:/);
  assert.throws(() => checkImageApps({ install: ["apps/one", "apps/one/"] }), /apps\/one listed twice/);
});

test("#152: an image directory with no etc/routes.json (an app repository's image/) is merged over the default image; one with it is complete", async (t) => {
  const work = await fs.mkdtemp(join(tmpdir(), "skein-overlay-"));
  t.after(() => fs.rm(work, { recursive: true, force: true }));
  const repo = join(work, "one");
  await nextApp(repo, "one");
  const image = join(repo, "image");
  await fs.mkdir(join(image, "etc"), { recursive: true });
  await fs.writeFile(join(image, "etc/apps.json"), JSON.stringify({ install: [".."] }));
  assert.equal(isOverlayImage(image), true);
  const src = await namedImageSource({ overlay: image });
  const s = await readSystemTree(src.objects, src.root);
  const def = await imageSource(DEFAULT);
  assert.deepEqual(s.routes, (await readSystemTree(def.objects, def.root)).routes, "the default image's rows, the claim row among them");
  assert.deepEqual(s.apps, { install: [".."] });
  const conf = join(work, "conf");
  await fs.mkdir(join(conf, "etc"), { recursive: true });
  await fs.writeFile(join(conf, "etc/config.json"), JSON.stringify({ defaults: { walletNetwork: "regtest" } }));
  await assert.rejects(namedImageSource({ overlay: conf }), /images: etc\/config\.json is in both images/);
});

test("SKEIN_NETWORK: the whole host's network, every genesis's defaults.walletNetwork (default main) under a tree's own; any other value refuses to start", async (t) => {
  assert.equal(hostNetwork({}), "main");
  assert.equal(hostNetwork({ SKEIN_NETWORK: "test" }), "test");
  assert.throws(() => hostNetwork({ SKEIN_NETWORK: "testnet" }), /SKEIN_NETWORK is main, test or regtest/);
  const home = await fs.mkdtemp(join(tmpdir(), "skein-net-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const err: string[] = [];
  assert.equal(await main(["list"], { vars: { HOME: home, SKEIN_HOME: home, SKEIN_NETWORK: "testnet" }, out: () => {}, err: (l) => err.push(l) }), 2);
  assert.deepEqual(err, ['skein-host: SKEIN_NETWORK is main, test or regtest (default main), not "testnet"']);
  const plain = await tree(t, { "etc/routes.json": "[]" });
  const own = await tree(t, { "etc/routes.json": "[]", "etc/config.json": JSON.stringify({ defaults: { walletNetwork: "regtest" } }) });
  const ps = await readSystemTree(plain.objects, plain.root), os = await readSystemTree(own.objects, own.root);
  const db = new HostDb(join(home, "net.db"));
  const signer = new Signer(PrivateKey.fromRandom());
  const routers: Router[] = [];
  t.after(async () => { for (const r of routers) await r.close(); db.close(); });
  const router = (vars: Record<string, string>) => { const r = new Router({ db, walletFor: (row) => signer.wallet(row.handle), home, idleMs: 0, network: hostNetwork(vars) }); routers.push(r); return r; };
  const row = { handle: "a", domain: "localhost" };
  const net = (c: Parameters<typeof resolveSystem>[0], s = ps) => (genesisRecord(c, resolveSystem(c, s.config, s.routes)) as Record<string, any>).defaults.walletNetwork;
  assert.equal(net(router({}).imageConfig(row, key())), "main");
  const test_ = router({ SKEIN_NETWORK: "test" });
  assert.equal(net(test_.imageConfig(row, key())), "test");
  assert.equal(net(test_.imageConfig(row, key()), os), "regtest", "a tree's defaults.walletNetwork wins over the host's network");
  // The host's grants: its status service key holds chain.status; an owner at birth holds root.
  const c = test_.imageConfig(row, key(), key());
  assert.deepEqual(Object.keys(c.grants!).sort(), ["chain.status", "root"]);
  assert.equal(c.grants!["chain.status"]![0], test_.statusKey());
});

test("skein next (SPEC 8, one loader): an empty store is no instance; skein-host add of a new row with no tree is refused; add --image boots an unclaimed instance", async (t) => {
  const home = await fs.mkdtemp(join(tmpdir(), "skein-one-loader-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const db = new HostDb(join(home, "host.db"));
  const signer = new Signer(PrivateKey.fromRandom());
  const r = new Router({ db, walletFor: (row) => signer.wallet(row.handle), home, idleMs: 0, sqliteStore: join(home, "store.sqlite"), kernel: { env: { SKEIN_HOME: home } } });
  t.after(async () => { await r.close(); db.close(); });
  db.add("empty", { store: `sqlite:${join(home, "store.sqlite")}` });
  await assert.rejects(r.hydrate("empty"), /its store is empty: an instance starts from a tree/);
  assert.equal(r.loaded.size, 0);
  await r.bootRow("empty", await imageSource());
  assert.ok((await r.hydrate("empty")).identity);
  db.add("file", { store: join(home, "instances/file/runtime.db") });
  await assert.rejects(r.hydrate("file"), /serve mode .* is gone/, "SPEC 5: no store file per instance");

  const cli = join(home, "cli");
  const err: string[] = [], out: string[] = [];
  const env = { vars: { HOME: home, SKEIN_HOME: cli, SKEIN_MASTER_KEY: "33".repeat(32) }, out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
  assert.equal(await main(["add", "bare"], env), 2);
  assert.match(err.at(-1)!, /a new instance starts from a tree: give --image, --boot or --packet/);
  assert.equal(await main(["add", "ox", "--image", "open-exchange"], env), 1, "no such image");
  assert.equal(await main(["add", "plain", "--image", "default"], env), 0, err.join("\n"));
  assert.match(out.join("\n"), /plain: booted from the image .* no owner: claim it/);
});

// The system tree (#4, docs/BOOTSTRAP.md) as the loader reads it, and the
// genesis it resolves to — without a kernel (kernel-zig/equiv/boot.ts runs
// the loader end to end through the router).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKey } from "@bsv/sdk";
import { CID } from "multiformats/cid";
import { encode } from "../runtime/cid.ts";
import * as dagCbor from "@ipld/dag-cbor";
import { hostNetwork, main } from "./cli.ts";
import { HostDb } from "./instances.ts";
import { KERNEL_BIN } from "./kernel.ts";
import { Router } from "./router.ts";
import { Signer } from "./signer.ts";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { anyOf, checkImageApps, dirSource, imageSource, installAtBirth, isOverlayImage, MemBlocks, mergeImages, overlayImage, rawCid, readSystemTree, wasmDirObjects } from "./boot.ts";
import { ImageChain } from "./image-chain.ts";
import { appIgnore, readApp } from "./install.ts";
import { planInstall } from "./plan.ts";
import { codeSystem, genesisRecord, keyHex, resolveSystem } from "./genesis.ts";
import { WALLET } from "../runtime/programs.ts";

const MODULE = Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
const key = () => PrivateKey.fromRandom().toPublicKey().toString();

async function tree(t: { after(f: () => unknown): void }, files: Record<string, string | Uint8Array>) {
  const dir = await fs.mkdtemp(join(tmpdir(), "skein-system-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [p, c] of Object.entries(files)) {
    await fs.mkdir(join(dir, p, ".."), { recursive: true });
    await fs.writeFile(join(dir, p), c);
  }
  return dirSource(dir);
}

test("system tree: bin/ programs (.wasm bytes, .cid, .json), config and routes resolve into a genesis — the admin routes first, root named, no sender (#143)", async (t) => {
  const pinned = CID.parse("bafkreif57vlek2v7lbfa5y43txx7svtlseanithrjxjldqveknwvt3vfwm");
  const infer = key();
  const { root, objects } = await tree(t, {
    "bin/echo.wasm": MODULE,
    "bin/echo.json": JSON.stringify({ services: ["outcomes"], description: "echoes" }),
    "bin/run-handler.cid": `${pinned}\n`,
    "etc/config.json": JSON.stringify({ defaults: { model: "m", fuelPerStep: "5" }, peers: { infer: "$infer" }, collect: ["x"], roles: { root: ["echo.private"] } }),
    "etc/dispatch.json": JSON.stringify([{ address: "run", program: "run-handler" }, { address: "chat", program: "echo", fn: "chat" }, { transport: "event", address: "feed", program: "echo" }]),
    "SOUL.md": "hi\n",
  });
  const s = await readSystemTree(objects, root);
  assert.deepEqual(s.programs.map((p) => p.name), ["echo", "run-handler"]);
  assert.ok(s.modules.find((m) => m.name === "echo")!.cid.equals(rawCid(MODULE)));
  assert.equal(s.modules.find((m) => m.name === "run-handler")!.bytes, undefined, "a .cid module's bytes come from the kernel or the packet");
  assert.deepEqual(s.programs[0]!.record.services, ["outcomes"]);
  const programs = Object.fromEntries(s.programs.map((p) => [p.name, encode(p.record).cid]));
  const rootKey = key();
  const c = { identity: key(), root: [rootKey], handle: "a", domain: "localhost", infer, defaults: { fuelPerStep: "9" } };
  const g = genesisRecord(c, resolveSystem(c, programs, s.config, root, s.dispatch)) as Record<string, any>;
  assert.ok(g.tree.equals(root));
  assert.deepEqual(g.defaults.model, "m");
  assert.equal(g.defaults.fuelPerStep, "5", "the tree's config wins over the host's defaults");
  const warned: string[] = [];
  const o = { ...c, overrides: { fuelPerStep: "7" }, warn: (l: string) => warned.push(l) };
  assert.equal((genesisRecord(o, resolveSystem(o, programs, s.config, root, s.dispatch)) as Record<string, any>).defaults.fuelPerStep, "7", "an explicit override wins");
  assert.match(warned[0]!, /replaces the system tree's fuelPerStep = 5/);
  const fill = { ...c, defaults: { walletNetwork: "test" } };
  assert.equal((genesisRecord(fill, resolveSystem(fill, programs, s.config, root, s.dispatch)) as Record<string, any>).defaults.walletNetwork, "test", "the host fills what the tree leaves unset");
  assert.equal(keyHex(g.peers.infer), infer);
  assert.deepEqual(g.root.map(keyHex), [rootKey], "#143: root, the initial root holders");
  assert.equal(g.owner, undefined, "#143: no owner");
  assert.deepEqual(g.roles, { root: ["frontdoor.explore", "echo.private"] }, "the tree's roles beside the stock ones");
  const boxes = g.dispatch.filter((r: { transport: string; program: unknown }) => r.transport !== "http" && r.program !== "kernel");
  assert.deepEqual(boxes.map((r: { transport: string; address: string; fn?: string }) => [r.transport, r.address, r.fn]), [["mailbox", "run", undefined], ["mailbox", "chat", "chat"], ["event", "feed", undefined]]);
  assert.ok(boxes[1].program.equals(programs.echo));
  assert.ok(g.dispatch.every((r: Record<string, unknown>) => r.sender === undefined), "#143: no route names a sender");
  assert.deepEqual(g.dispatch.slice(0, 5).map((r: { address: string; program: unknown; fn?: string }) => [r.address, r.program, r.fn]), [["objects", "kernel", "objects"], ["head", "kernel", "head"], ["dispatch", "kernel", "dispatch"], ["peers", "kernel", "peers"], ["grant", "kernel", "grant"]], "the admin routes first (#77, #143: grant among them; root's)");
  assert.deepEqual(g.scopes.frontdoor, ["frontdoor/"], "the stock scopes");
  assert.deepEqual(g.collect, ["x"]);
});

test("an image (#89): the default image resolves into a genesis with no root, the admin routes, the claim route; the explorer root's", async (t) => {
  void t;
  const { root, objects } = await dirSource(join(import.meta.dirname, "../../images/default"));
  const s = await readSystemTree(anyOf(objects, wasmDirObjects(join(import.meta.dirname, "../../wasm"))), root);
  assert.deepEqual(s.programs.map((p) => p.name), ["frontdoor", "messagebox", "wallet"], "#116, #130: the wallet is core, in the image");
  assert.equal(s.apps, undefined, "#152: no etc/apps.json — the image carries no apps");
  assert.equal(encode(s.programs.find((p) => p.name === "wallet")!.record).cid.toString(), encode(WALLET).cid.toString(), "the image's wallet record is WALLET (bin/wallet.json)");
  const programs = Object.fromEntries(s.programs.map((p) => [p.name, encode(p.record).cid]));
  const c = { identity: key(), handle: "a", domain: "localhost" };
  const g = genesisRecord(c, resolveSystem(c, programs, s.config, root, s.dispatch)) as Record<string, any>;
  assert.equal(g.root, undefined, "no root in it");
  assert.deepEqual(g.dispatch.filter((r: { program: unknown }) => r.program === "kernel").map((r: { address: string }) => r.address), ["objects", "head", "dispatch", "peers", "grant", "claim"], "the admin routes (root's: none holds it yet) and the claim route");
  assert.deepEqual(g.names, [], "no names");
  assert.equal(g.reads, undefined, "#143: no reads");
  assert.deepEqual(g.roles, { root: ["frontdoor.explore"] }, "the explorer is root's");
  const explorer = g.dispatch.find((r: { address: string }) => r.address === "/explore");
  assert.deepEqual([explorer.prefix, explorer.filters, explorer.fn], [true, ["kernel.brc104"], "explore"], "the explorer route: behind kernel.brc104, gated by root");
  const http = (g.dispatch as Array<{ transport: string; address: string }>).filter((r) => r.transport === "http").map((r) => r.address);
  assert.ok(!http.some((a) => a === "/" || a === "/site" || a === "/manifest.json"), `#125: no site and no static in the image's own routes (${http.join(", ")})`);
  assert.ok(http.every((a) => /^\/(messagebox\/)?(sendMessage|listMessages|acknowledgeMessage)$/.test(a) || ["/explore", "/.well-known/auth"].includes(a)), "the image's http routes: the handshake, the messagebox's and the explorer");
  // The image names the kernel's pinned front door and messagebox: the tree's .cid files are the wasm/ modules'.
  for (const n of ["frontdoor", "messagebox", "wallet"]) assert.ok(s.modules.find((m) => m.name === n)!.bytes, `bin/${n}.cid names the module in wasm/ (scripts/pin-programs.sh keeps it current)`);
});

test("system tree: refusals — no routes, the forms before #77/#115, a sender, a bad .cid, a handler that is no program, $infer on a host without one, $owner", async (t) => {
  const none = await tree(t, { "bin/x.wasm": MODULE });
  await assert.rejects(readSystemTree(none.objects, none.root), /dispatch\.json: missing/);
  const old = await tree(t, { "bin/x.wasm": MODULE, "etc/subscriptions.json": "[]" });
  await assert.rejects(readSystemTree(old.objects, old.root), /the form before #77\/#115 is gone \(#143/);
  const bad = await tree(t, { "bin/x.cid": "nope", "etc/dispatch.json": "[]" });
  await assert.rejects(readSystemTree(bad.objects, bad.root), /not a CID/);
  const notWasm = await tree(t, { "bin/x.wasm": "text", "etc/dispatch.json": "[]" });
  await assert.rejects(readSystemTree(notWasm.objects, notWasm.root), /not a wasm module/);
  const component = Uint8Array.from([0, 0x61, 0x73, 0x6d, 0x0d, 0, 1, 0]);
  const comp = await tree(t, { "bin/c.wasm": component, "etc/dispatch.json": "[]" });
  assert.ok((await readSystemTree(comp.objects, comp.root)).modules[0]!.cid.equals(rawCid(component)), "a component in bin/ is a module like any other");
  const c = { identity: key(), root: [key()], handle: "a", domain: "localhost" };
  assert.throws(() => resolveSystem(c, {}, {}, undefined, [{ address: "run", sender: "*", program: "x" }]), /`sender` is gone \(#143/);
  assert.throws(() => resolveSystem(c, {}, {}, undefined, [{ transport: "mailbox", address: "x", filters: ["site.get"] }]), /only an http read route/);
  assert.throws(() => resolveSystem(c, {}, { peers: { infer: "$infer" } }), /no inference peer/);
  assert.throws(() => resolveSystem(c, {}, { peers: { me: "$owner" } }), /\$owner: gone \(#143/);
  // A route to a program the system lacks is left out.
  assert.equal(resolveSystem(c, {}, {}, undefined, [{ address: "run", program: "missing" }]).dispatch.filter((r) => r.address === "run").length, 0);
});

/** A copy of the test app (programs/test/app-demo) named `name`, at `dir`, with no start or stop message. */
async function demoApp(dir: string, name: string): Promise<void> {
  await fs.cp(join(import.meta.dirname, "../../programs/test/app-demo"), dir, { recursive: true, filter: (p) => !/(zig-out|\.zig-cache|zig-pkg)$/.test(p) });
  const m = JSON.parse(await fs.readFile(join(dir, "etc/app.json"), "utf8")) as Record<string, unknown>;
  delete m.start; delete m.stop;
  await fs.writeFile(join(dir, "etc/app.json"), `${JSON.stringify({ ...m, name }, null, 2)}\n`);
}

test("#152: an image's apps — a directory of the image, a directory beside it, a tarball by {url, hash} — each a directory install: its objects put, the app record and routes a message install writes, root's own route", async (t) => {
  const work = await fs.mkdtemp(join(tmpdir(), "skein-img-"));
  const server = createServer(async (req, res) => {
    try { res.end(await fs.readFile(join(work, req.url!.slice(1)))); } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => { server.close(); await fs.rm(work, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const image = join(work, "image");
  await fs.cp(join(import.meta.dirname, "../../images/default"), image, { recursive: true });
  await demoApp(join(image, "apps/one"), "one");
  await demoApp(join(work, "two"), "two");
  await demoApp(join(work, "three"), "three");
  assert.equal(spawnSync("tar", ["-czf", join(work, "three.tgz"), "-C", work, "three"]).status, 0);
  const three = (await dirSource(join(work, "three"), { ignore: appIgnore })).root;
  const hash = Buffer.from(three.multihash.digest).toString("hex");
  const tarball = { url: `${base}/three.tgz`, hash };
  await fs.writeFile(join(image, "etc/apps.json"), JSON.stringify({ install: ["apps/one", "../two", tarball], routes: [{ transport: "http", address: "/", prefix: true, filters: ["kernel.brc104"], program: "one.demo", fn: "call" }] }));

  const src = await imageSource(image);
  assert.deepEqual(Object.keys(src.apps ?? {}), ["../two"], "the directory beside the image is read with it");
  const s = await readSystemTree(src.objects, src.root);
  assert.deepEqual(Object.keys(s.appTrees ?? {}), ["apps/one"], "the directory of the image is in its tree");
  const programs = Object.fromEntries(s.programs.map((p) => [p.name, encode(p.record).cid]));
  const identity = key();
  const c = { identity, handle: "a", domain: "localhost" };
  const sys = resolveSystem(c, programs, s.config, src.root, s.dispatch);
  const kept = new Map<string, Uint8Array>();
  const target = { hasBlock: async (cid: CID) => kept.has(cid.toString()), putBlock: async (cid: CID, b: Uint8Array) => { kept.set(cid.toString(), b); } };
  const born = await installAtBirth(target, src.objects, s, sys, c, src.apps);
  assert.deepEqual(born.apps.map((a) => `${a.name} ${a.version}`), ["one 0.1.0", "two 0.1.0", "three 0.1.0"]);
  assert.deepEqual(Object.keys(born.heads).sort(), ["one/app", "three/app", "two/app"]);
  const get = (cid: CID) => dagCbor.decode(kept.get(cid.toString())!) as Record<string, any>;
  assert.ok(get(born.heads["three/app"]!).tree.equals(three), "the tarball's app record names its tree, the hash");
  for (const n of ["two", "three"]) assert.ok(kept.has(get(born.heads[`${n}/app`]!).tree.toString()), `${n}'s tree is put (it is not in the image's)`);
  const rows = born.rows as Array<Record<string, any>>;
  assert.deepEqual(rows.filter((r) => r.app === "three").map(showRow), ["three mailbox three", "three mailbox three/tick", "three http /three/call [kernel.brc104] .call"]);
  assert.deepEqual(rows.filter((r) => r.app === undefined).map(showRow), ["root http / prefix [kernel.brc104] .call"], "root's own route after the apps");
  // The same app record as `skein install <dir>` over the instance: the same CID, the same routes byte for byte.
  const view = { store: { has: async () => false, get: async () => { throw new Error("none"); }, bytes: async () => { throw new Error("none"); }, putBlock: async () => {} } as never, identity, programs: sys.programs, addressBook: [], heads: [], dispatch: [...sys.dispatch] };
  const viaMessages = await planInstall(await readApp(join(image, "apps/one")), view, { modules: src.objects });
  assert.ok(viaMessages.recordCid.equals(born.heads["one/app"]!), "the image's one/app is the message install's app record");
  assert.deepEqual(viaMessages.rows.map((r) => encode(r.row as never).cid.toString()), rows.filter((r) => r.app === "one").map((r) => encode(r as never).cid.toString()), "the same routes, byte for byte");
  const g = genesisRecord(c, { ...sys, dispatch: [...sys.dispatch, ...born.rows], heads: born.heads }) as Record<string, any>;
  assert.ok(g.heads["three/app"].equals(born.heads["three/app"]), "the genesis carries the heads");

  // Refusals.
  const fresh = { hasBlock: async () => false, putBlock: async () => {} };
  const wrong = { ...s, apps: { install: [{ url: tarball.url, hash: "00".repeat(20) }] } };
  await assert.rejects(installAtBirth(fresh, src.objects, wrong, sys, c), /three\.tgz: its tree is [0-9a-f]{40}, not 0{40}/, "a tarball whose tree is not its hash");
  const gone = { ...s, apps: { install: [{ url: `${base}/none.tgz`, hash }] } };
  await assert.rejects(installAtBirth(fresh, src.objects, gone, sys, c), /none\.tgz: 404/);
  const scanned = await dirSource(image);
  await assert.rejects(installAtBirth(fresh, scanned.objects, await readSystemTree(anyOf(scanned.objects, src.objects), scanned.root), sys, c), /\.\.\/two is not a directory of the image/, "a directory beside an image read from its tree alone");
  await demoApp(join(work, "four"), "four");
  await fs.writeFile(join(work, "four/etc/app.json"), (await fs.readFile(join(work, "four/etc/app.json"), "utf8")).replace('"name"', '"start": {"body": {"kind": "go"}}, "name"'));
  await fs.writeFile(join(image, "etc/apps.json"), JSON.stringify({ install: ["../four"] }));
  const withStart = await imageSource(image);
  await assert.rejects(installAtBirth(fresh, withStart.objects, await readSystemTree(withStart.objects, withStart.root), sys, c, withStart.apps), /four: its start message is root's/);
  assert.throws(() => checkImageApps({ install: [{ url: tarball.url } as never] }), /want \{install:/);
  assert.throws(() => checkImageApps({ install: ["apps/one", "apps/one/"] }), /apps\/one listed twice/);
});

test("SKEIN_NETWORK: the whole host's network, every genesis's defaults.walletNetwork (default main) under a tree's own; any other value refuses to start", async (t) => {
  assert.equal(hostNetwork({}), "main", "unset: main");
  assert.equal(hostNetwork({ SKEIN_NETWORK: "test" }), "test");
  assert.throws(() => hostNetwork({ SKEIN_NETWORK: "testnet" }), /SKEIN_NETWORK is main, test or regtest/);
  const home = await fs.mkdtemp(join(tmpdir(), "skein-net-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const err: string[] = [];
  assert.equal(await main(["list"], { vars: { HOME: home, SKEIN_HOME: home, SKEIN_NETWORK: "testnet" }, out: () => {}, err: (l) => err.push(l) }), 2, "skein-host refuses to start");
  assert.deepEqual(err, ['skein-host: SKEIN_NETWORK is main, test or regtest (default main), not "testnet"']);

  const { root, objects } = await tree(t, { "bin/echo.wasm": MODULE, "etc/dispatch.json": JSON.stringify([{ address: "chat", program: "echo" }]) });
  const own = await tree(t, { "bin/echo.wasm": MODULE, "etc/config.json": JSON.stringify({ defaults: { walletNetwork: "regtest" } }), "etc/dispatch.json": JSON.stringify([{ address: "chat", program: "echo" }]) });
  const plain = await readSystemTree(objects, root), pinned = await readSystemTree(own.objects, own.root);
  const programs = Object.fromEntries(plain.programs.map((p) => [p.name, encode(p.record).cid]));
  const db = new HostDb(join(home, "net.db"));
  const signer = new Signer(PrivateKey.fromRandom());
  const routers: Router[] = [];
  t.after(async () => { for (const r of routers) await r.close(); db.close(); });
  const router = (vars: Record<string, string>) => {
    const r = new Router({ db, walletFor: (row) => signer.wallet(row.handle), owner: key(), home, idleMs: 0, cron: false, network: hostNetwork(vars) });
    routers.push(r);
    return r;
  };
  const row = { handle: "a", domain: "localhost" };
  const net = (c: Parameters<typeof resolveSystem>[0], s = plain, r = root) => (genesisRecord(c, resolveSystem(c, programs, s.config, r, s.dispatch)) as Record<string, any>).defaults.walletNetwork;
  const main_ = router({});
  assert.equal(net(main_.genesisConfig(row, key(), false)), "main", "unset: main in the genesis record");
  const test_ = router({ SKEIN_NETWORK: "test" });
  assert.equal(net(test_.genesisConfig(row, key(), false)), "test", "an agent's genesis");
  assert.equal(net(test_.imageConfig(row, key())), "test", "an image's genesis (the host skein, an instance the manager makes)");
  assert.equal((genesisRecord(test_.genesisConfig(row, key()), codeSystem(test_.genesisConfig(row, key()), programs)) as Record<string, any>).defaults.walletNetwork, "test", "code genesis");
  const mailbox = test_.genesisConfig({ ...row, kind: "mailbox", owner: key() }, key());
  assert.equal((genesisRecord(mailbox, codeSystem(mailbox, { frontdoor: programs.echo!, messagebox: programs.echo! })) as Record<string, any>).defaults.walletNetwork, "test", "a mailbox instance's genesis");
  assert.equal(net(test_.imageConfig(row, key()), pinned, own.root), "regtest", "a tree's defaults.walletNetwork wins over the host's network");
  const warned: string[] = [];
  assert.equal(net({ ...test_.imageConfig(row, key()), overrides: { walletNetwork: "main" }, warn: (l) => warned.push(l) }, pinned, own.root), "main", "an explicit override wins over the tree");
  assert.match(warned[0]!, /replaces the system tree's walletNetwork = regtest/);
});

test("#142, #152: the host image (images/host over images/default) names skein-onboard v0.4.0 by tarball, and nothing else", async () => {
  const base = await imageSource(join(import.meta.dirname, "../../images/default"));
  const own = await imageSource(join(import.meta.dirname, "../../images/host"));
  const merged = new MemBlocks();
  const src = anyOf(merged, base.objects, own.objects);
  const s = await readSystemTree(src, await mergeImages(src, base.root, own.root, merged));
  assert.deepEqual(s.apps?.install, [{ url: "https://github.com/shruggr/skein-onboard/archive/refs/tags/v0.4.0.tar.gz", hash: "ba29f99adb0d2d1849aa7f0cf72ceeefde88c5ae" }]);
  assert.equal(s.apps?.routes, undefined, "no root route");
});

test("#152: an image directory with no bin/ (an app repository's image/, etc/apps.json alone) is merged over the default image, as the host image is; one with bin/ is complete; the merge's refusals stand", async (t) => {
  const work = await fs.mkdtemp(join(tmpdir(), "skein-overlay-"));
  t.after(() => fs.rm(work, { recursive: true, force: true }));
  const DEFAULT = join(import.meta.dirname, "../../images/default");
  const route = { transport: "http", address: "/", prefix: true, filters: ["kernel.brc104"], program: "one.demo", fn: "call" };
  // An app repository whose image/ holds only etc/apps.json: install `..` and one root route.
  const repo = join(work, "one");
  await demoApp(repo, "one");
  const image = join(repo, "image");
  await fs.mkdir(join(image, "etc"), { recursive: true });
  await fs.writeFile(join(image, "etc/apps.json"), JSON.stringify({ install: [".."], routes: [route] }));
  assert.equal(isOverlayImage(image), true, "no bin/: an overlay");
  assert.equal(isOverlayImage(DEFAULT), false, "the default image is complete");
  await assert.rejects(imageSource(image).then((x) => readSystemTree(x.objects, x.root)), /etc\/dispatch\.json: missing/, "alone it is no system tree");

  // The loader's path (skein-host add --image <dir>): the host's image source, merged over the default image.
  const db = new HostDb(join(work, "host.db"));
  t.after(() => db.close());
  const chain = new ImageChain({ db });
  const src = await chain.source({ overlay: image });
  assert.equal(src.kind, "tree");
  if (src.kind !== "tree") return;
  assert.deepEqual(Object.keys(src.apps ?? {}), [".."], "the app beside the image is read with it");
  const s = await readSystemTree(src.objects, src.root);
  assert.deepEqual(s.programs.map((p) => p.name), ["frontdoor", "messagebox", "wallet"], "the default image's programs");
  const def = await imageSource(DEFAULT);
  assert.deepEqual(s.dispatch, (await readSystemTree(def.objects, def.root)).dispatch, "the default image's routes, the claim route among them");
  assert.ok(s.dispatch.some((r) => r.program === "kernel" && r.address === "claim"), "the claim route");
  assert.deepEqual(s.apps, { install: [".."], routes: [route] });
  const programs = Object.fromEntries(s.programs.map((p) => [p.name, encode(p.record).cid]));
  const c = { identity: key(), handle: "a", domain: "localhost" };
  const sys = resolveSystem(c, programs, s.config, src.root, s.dispatch);
  const kept = new Map<string, Uint8Array>();
  const target = { hasBlock: async (cid: CID) => kept.has(cid.toString()), putBlock: async (cid: CID, b: Uint8Array) => { kept.set(cid.toString(), b); } };
  const born = await installAtBirth(target, src.objects, s, sys, c, src.apps);
  assert.deepEqual(born.apps.map((a) => `${a.name} ${a.version}`), ["one 0.1.0"], "the app installed at birth");
  assert.deepEqual((born.rows as Array<Record<string, any>>).filter((r) => r.app === undefined).map(showRow), ["root http / prefix [kernel.brc104] .call"], "root's own route");
  assert.ok((genesisRecord(c, { ...sys, dispatch: [...sys.dispatch, ...born.rows], heads: born.heads }) as Record<string, any>).dispatch.some((r: { program: unknown; address: unknown }) => r.program === "kernel" && r.address === "claim"), "the genesis keeps the claim route");
  assert.ok((await chain.source({ overlay: image }) as { root: CID }).root.equals(src.root), "the same tree again");

  // A directory with bin/ is a complete image: not merged.
  const whole = join(work, "whole");
  await fs.mkdir(join(whole, "bin"), { recursive: true });
  await fs.mkdir(join(whole, "etc"), { recursive: true });
  await fs.writeFile(join(whole, "bin/echo.wasm"), MODULE);
  await fs.writeFile(join(whole, "etc/dispatch.json"), JSON.stringify([{ address: "chat", program: "echo" }]));
  assert.equal(isOverlayImage(whole), false);
  const w = await imageSource(whole);
  const ws = await readSystemTree(w.objects, w.root);
  assert.deepEqual([ws.programs.map((p) => p.name), ws.dispatch.length], [["echo"], 1], "its own programs and routes alone");

  // Refusals: an app in both lists; any other path in both, unless the same blob (etc/config.json included).
  const base = await overlayImage(await imageDir_(DEFAULT), image);
  const again = join(work, "again");
  await fs.mkdir(join(again, "etc"), { recursive: true });
  await fs.writeFile(join(again, "etc/apps.json"), JSON.stringify({ install: [".."] }));
  await assert.rejects(overlayImage(base, again), /etc\/apps\.json: \.\. installed by both images/);
  const conf = join(work, "conf");
  await fs.mkdir(join(conf, "etc"), { recursive: true });
  await fs.writeFile(join(conf, "etc/config.json"), JSON.stringify({ defaults: { walletNetwork: "regtest" } }));
  await assert.rejects(chain.source({ overlay: conf }), /images: etc\/config\.json is in both images/, "the default image's config is not replaced");
  await fs.copyFile(join(DEFAULT, "etc/config.json"), join(conf, "etc/config.json"));
  assert.ok(await chain.source({ overlay: join(work, "conf/") }), "the same blob is no collision");
});

/** imageSource's static part, as overlayImage takes it. */
const imageDir_ = async (dir: string) => { const x = await imageSource(dir); return { root: x.root, objects: x.objects, apps: x.apps ?? {} }; };

const showRow = (r: Record<string, any>) => `${r.app ?? "root"} ${r.transport} ${r.address}${r.prefix ? " prefix" : ""}${r.filters ? ` [${r.filters.join(",")}]` : ""}${r.fn ? ` .${r.fn}` : ""}`;

test("#152: skein-host add <handle> --image takes default, host or a directory — host boots unclaimed with the onboarding app; another name is refused", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  const home = await fs.mkdtemp(join(tmpdir(), "skein-img-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const vars = { HOME: home, SKEIN_HOME: home, SKEIN_MASTER_KEY: "66".repeat(32), SKEIN_OWNER: PrivateKey.fromRandom().toPublicKey().toString(), PATH: process.env.PATH };
  const out: string[] = [], err: string[] = [];
  const env = { vars, out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
  assert.equal(await main(["add", "ox", "--image", "open-exchange"], env), 1, "open-exchange is no image name here");
  assert.equal(await main(["add", "plain", "--image", "default"], env), 0, err.join("\n"));
  assert.equal(await main(["add", "hosted", "--image", "host"], env), 0, err.join("\n"));
  assert.match(out.join("\n"), /hosted: booted from the image .* no owner: claim it/);
  const db = new HostDb(join(home, "host.db"));
  const signer = new Signer(PrivateKey.fromHex(vars.SKEIN_MASTER_KEY));
  const router = new Router({ db, walletFor: (row) => signer.wallet(row.handle), home, idleMs: 0, kernel: { env: { SKEIN_HOME: home } } });
  t.after(async () => { await router.close(); db.close(); });
  const plain = (await (await router.hydrate("plain")).kernel.dispatch()).rows as Array<Record<string, any>>;
  assert.deepEqual(plain.filter((r) => r.app), [], "#152: the default image installs no app");
  const k = (await router.hydrate("hosted")).kernel;
  const rows = (await k.dispatch()).rows as Array<Record<string, any>>;
  assert.deepEqual([...new Set(rows.filter((r) => r.app).map((r) => r.app))], ["onboard"], "the onboarding app, installed at birth");
  assert.ok(rows.some((r) => r.program === "kernel" && r.address === "claim"), "unclaimed: the claim route");
  assert.equal((await k.store.get(await k.call("head", "onboard/app") as CID) as unknown as { version: string }).version, "0.4.0");
});

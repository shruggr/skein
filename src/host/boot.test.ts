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
import { anyOf, dirSource, installAtBirth, rawCid, readSystemTree, wasmDirObjects } from "./boot.ts";
import { readApp } from "./install.ts";
import { planInstall } from "./plan.ts";
import { genesisRecord, keyHex, resolveSystem } from "./genesis.ts";
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

test("#141, #143: the default image installs chain, git and site at birth — the records, routes and heads a message install writes, root's read route at /", async () => {
  const image = join(import.meta.dirname, "../../images/default");
  const { root, objects } = await dirSource(image);
  const src = anyOf(objects, wasmDirObjects(join(import.meta.dirname, "../../wasm")));
  const s = await readSystemTree(src, root);
  assert.deepEqual(s.apps?.install, ["apps/chain", "apps/git", "apps/site"]);
  const programs = Object.fromEntries(s.programs.map((p) => [p.name, encode(p.record).cid]));
  const identity = key();
  const c = { identity, handle: "a", domain: "localhost" };
  const sys = resolveSystem(c, programs, s.config, root, s.dispatch);
  const kept = new Map<string, Uint8Array>();
  const target = { hasBlock: async (cid: CID) => kept.has(cid.toString()) || !!(await src.get(cid)), putBlock: async (cid: CID, b: Uint8Array) => { kept.set(cid.toString(), b); } };
  const born = await installAtBirth(target, src, s, sys, c);
  assert.deepEqual(born.apps.map((a) => `${a.name} ${a.version}`), ["chain 0.5.0", "git 0.2.0", "site 0.10.0"]);
  assert.deepEqual(Object.keys(born.heads).sort(), ["chain/app", "git/app", "site/app"], "#143: no reads head");
  const get = (cid: CID) => dagCbor.decode(kept.get(cid.toString())!) as Record<string, any>;
  for (const n of ["chain", "git", "site"]) assert.equal(get(born.heads[`${n}/app`]!).kind, "app", `${n}/app is its app record, in the store`);
  // The routes: each app's with its `app`, then root's own (no app).
  const rows = born.rows as Array<Record<string, any>>;
  assert.deepEqual(rows.map((r) => `${r.app ?? "root"} ${r.transport} ${r.address}${r.prefix ? " prefix" : ""}${r.filters ? ` [${r.filters.join(",")}]` : ""}${r.fn ? ` .${r.fn}` : ""}`), [
    "chain event chain", "chain mailbox chain [kernel.beef]", "chain mailbox chain/status",
    "git mailbox git .call",
    "site http /site/ prefix [site.get]",
    "root http / prefix [site.get]",
  ]);
  assert.ok(rows.every((r) => r.sender === undefined), "#143: no sender");
  const site = get(born.heads["site/app"]!);
  assert.deepEqual([site.filters, site.routes.length], [{ get: "site.get" }, 1], "the site's record: its filter declared, its read route");
  assert.equal(rows.find((r) => r.address === "/site/")!.program, undefined, "a read route: no program");
  assert.deepEqual(get(born.heads["git/app"]!).roles, { root: ["call"] }, "git's call is root's (#143: what $owner was)");
  // The same app record as `skein install <dir>` over the instance: same CID, the same routes byte for byte.
  const view = { store: { has: async () => false, get: async () => { throw new Error("none"); }, bytes: async () => { throw new Error("none"); }, putBlock: async () => {} } as never, identity, programs: sys.programs, addressBook: [], heads: [], dispatch: [...sys.dispatch] };
  const viaMessages = await planInstall(await readApp(join(image, "apps/chain")), view, { modules: src });
  assert.ok(viaMessages.recordCid.equals(born.heads["chain/app"]!), "the image's chain/app is the message install's app record");
  assert.deepEqual(viaMessages.rows.map((r) => encode(r.row as never).cid.toString()), rows.filter((r) => r.app === "chain").map((r) => encode(r as never).cid.toString()), "the same routes, byte for byte");
  // The genesis carries the heads.
  const g = genesisRecord(c, { ...sys, dispatch: [...sys.dispatch, ...born.rows], heads: born.heads }) as Record<string, any>;
  assert.ok(g.heads["chain/app"].equals(born.heads["chain/app"]));
});

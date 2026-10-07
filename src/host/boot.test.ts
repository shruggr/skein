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
import { genesisRecord, keyHex, resolveReads, resolveSystem } from "./genesis.ts";
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

test("system tree: bin/ programs (.wasm bytes, .cid, .json), config and subscriptions (the form before #77) resolve into a genesis of dispatch rows", async (t) => {
  const pinned = CID.parse("bafkreif57vlek2v7lbfa5y43txx7svtlseanithrjxjldqveknwvt3vfwm");
  const infer = key();
  const { root, objects } = await tree(t, {
    "bin/echo.wasm": MODULE,
    "bin/echo.json": JSON.stringify({ services: ["outcomes"], description: "echoes" }),
    "bin/run-handler.cid": `${pinned}\n`,
    "etc/config.json": JSON.stringify({ defaults: { model: "m", fuelPerStep: "5" }, peers: { infer: "$infer" }, collect: ["x"] }),
    "etc/subscriptions.json": JSON.stringify([{ sender: "$owner", box: "run", handler: "run-handler" }, { box: "chat", handler: "echo" }]),
    "SOUL.md": "hi\n",
  });
  const s = await readSystemTree(objects, root);
  assert.deepEqual(s.programs.map((p) => p.name), ["echo", "run-handler"]);
  assert.ok(s.modules.find((m) => m.name === "echo")!.cid.equals(rawCid(MODULE)));
  assert.equal(s.modules.find((m) => m.name === "run-handler")!.bytes, undefined, "a .cid module's bytes come from the kernel or the packet");
  assert.deepEqual(s.programs[0]!.record.services, ["outcomes"]);
  const programs = Object.fromEntries(s.programs.map((p) => [p.name, encode(p.record).cid]));
  const c = { identity: key(), owner: key(), handle: "a", domain: "localhost", infer, defaults: { fuelPerStep: "9" } };
  const g = genesisRecord(c, resolveSystem(c, programs, s.subscriptions ?? [], s.config, root)) as Record<string, any>;
  assert.ok(g.tree.equals(root));
  assert.deepEqual(g.defaults.model, "m");
  assert.equal(g.defaults.fuelPerStep, "5", "the tree's config wins over the host's defaults");
  const warned: string[] = [];
  const o = { ...c, overrides: { fuelPerStep: "7" }, warn: (l: string) => warned.push(l) };
  assert.equal((genesisRecord(o, resolveSystem(o, programs, s.subscriptions ?? [], s.config, root)) as Record<string, any>).defaults.fuelPerStep, "7", "an explicit override wins");
  assert.match(warned[0]!, /replaces the system tree's fuelPerStep = 5/);
  const fill = { ...c, defaults: { walletNetwork: "test" } };
  assert.equal((genesisRecord(fill, resolveSystem(fill, programs, s.subscriptions ?? [], s.config, root)) as Record<string, any>).defaults.walletNetwork, "test", "the host fills what the tree leaves unset");
  assert.equal(keyHex(g.peers.infer), infer);
  const boxes = g.dispatch.filter((r: { transport: string; program: unknown }) => r.transport === "mailbox" && r.program !== "kernel");
  assert.equal(keyHex(boxes[0].sender), c.owner);
  assert.equal(boxes[1].sender, "*");
  assert.ok(boxes[1].program.equals(programs.echo));
  assert.ok(!g.dispatch.some((r: { transport: string }) => r.transport === "http"), "the stock http rows name programs this tree lacks: dropped");
  assert.deepEqual(g.dispatch.slice(0, 4).map((r: { address: string; program: unknown; fn?: string }) => [r.address, r.program, r.fn]), [["objects", "kernel", "objects"], ["head", "kernel", "head"], ["dispatch", "kernel", "dispatch"], ["peers", "kernel", "peers"]], "the owner's admin rows first (#77)");
  assert.equal(keyHex(g.dispatch[0].sender), c.owner);
  assert.deepEqual(g.scopes.frontdoor, ["frontdoor/"], "the stock scopes");
  assert.deepEqual(g.collect, ["x"]);
});

test("an image (#89): the default image resolves into a genesis with no owner, no admin rows, the claim row first", async (t) => {
  void t;
  const { root, objects } = await dirSource(join(import.meta.dirname, "../../images/default"));
  const s = await readSystemTree(anyOf(objects, wasmDirObjects(join(import.meta.dirname, "../../wasm"))), root);
  assert.deepEqual(s.programs.map((p) => p.name), ["frontdoor", "messagebox", "wallet"], "#116, #130: the wallet is core, in the image");
  assert.equal(encode(s.programs.find((p) => p.name === "wallet")!.record).cid.toString(), encode(WALLET).cid.toString(), "the image's wallet record is WALLET (bin/wallet.json)");
  const programs = Object.fromEntries(s.programs.map((p) => [p.name, encode(p.record).cid]));
  const c = { identity: key(), handle: "a", domain: "localhost" };
  const g = genesisRecord(c, resolveSystem(c, programs, [], s.config, root, s.routes, s.reads, s.dispatch)) as Record<string, any>;
  assert.equal(g.owner, undefined, "no owner in it");
  assert.deepEqual(g.dispatch.filter((r: { program: unknown }) => r.program === "kernel"), [{ transport: "mailbox", address: "claim", sender: "*", program: "kernel", fn: "claim" }], "the one kernel row: the claim row, from anyone");
  assert.deepEqual(g.names, [], "no names");
  assert.equal(g.reads, undefined, "#115: no reads table: a read permission is the row's sender");
  assert.ok(!g.dispatch.some((r: { address: string }) => r.address === "/explore"), "#121: no explorer row in an image — every sender is a key, and the claim writes the owner's");
  assert.ok(!g.dispatch.some((r: { sender: unknown }) => r.sender === "owner"), "#121: no `owner` symbol");
  // A tree that still writes etc/reads.json (the form before #115): folded into the rows that name the op.
  const old = genesisRecord(c, resolveSystem(c, programs, [], s.config, root, [{ prefix: "/old", program: "frontdoor", fn: "explore", read: "explore" }], [{ owner: true, op: "explore" }, { caller: key(), op: "*" }], []));
  const olds = (old.dispatch as Array<{ address: string; sender: unknown; read?: string }>).filter((r) => r.address === "/old");
  assert.equal(olds.length, 1, "one row per read that allows the op; #121: `owner: true` in an image is nobody's until the claim");
  assert.ok(olds[0]!.sender instanceof Uint8Array);
  assert.ok(olds.every((r) => r.read === undefined));
  // With an owner, `owner: true` is the owner's key.
  const ownerKey = key();
  const co = { ...c, owner: ownerKey };
  const owned = genesisRecord(co, resolveSystem(co, programs, [], s.config, root, [{ prefix: "/old", program: "frontdoor", fn: "explore", read: "explore" }], [{ owner: true, op: "explore" }], []));
  const ownedRows = (owned.dispatch as Array<{ address: string; sender: unknown }>).filter((r) => r.address === "/old");
  assert.equal(ownedRows.length, 1);
  assert.equal(Buffer.from(ownedRows[0]!.sender as Uint8Array).toString("hex"), ownerKey, "#121: the owner's real key");
  const http = (g.dispatch as Array<{ transport: string; address: string }>).filter((r) => r.transport === "http").map((r) => r.address);
  assert.ok(!http.some((a) => a === "/" || a === "/site" || a === "/manifest.json"), `#125: no site and no static in the image: nothing at /, /site or /manifest.json (${http.join(", ")})`);
  assert.ok(http.every((a) => /^\/(messagebox\/)?(sendMessage|listMessages|acknowledgeMessage)$/.test(a) || a === "/wallet/fund"), "the image's http rows are the messagebox's and (#130) the wallet's funding row");
  const fund = (g.dispatch as Array<{ address: string; sender: unknown; program: CID; fn?: string; filter?: string }>).find((r) => r.address === "/wallet/fund")!;
  assert.deepEqual([fund.sender, fund.program.toString(), fund.fn, fund.filter], ["session", programs.wallet!.toString(), "fund", "beef"], "#130, #135: the funding row — a message route (the host's signed session), the wallet's fund, the door's beef filter");
  assert.throws(() => resolveReads({}, [{ owner: true, caller: "$owner", op: "explore" }] as never), /owner: true names no caller/);
  // The image names the kernel's pinned front door and messagebox: the tree's .cid files are the wasm/ modules'.
  for (const n of ["frontdoor", "messagebox", "wallet"]) assert.ok(s.modules.find((m) => m.name === n)!.bytes, `bin/${n}.cid names the module in wasm/ (scripts/pin-programs.sh keeps it current)`);
  assert.throws(() => resolveSystem(c, programs, [{ sender: "$owner", box: "x", handler: "messagebox" }]), /an image names no owner/);
});

test("system tree: refusals — no dispatch rows, a bad .cid, a handler that is no program, $infer on a host without one", async (t) => {
  const none = await tree(t, { "bin/x.wasm": MODULE });
  await assert.rejects(readSystemTree(none.objects, none.root), /dispatch\.json: missing/);
  const bad = await tree(t, { "bin/x.cid": "nope", "etc/subscriptions.json": "[]" });
  await assert.rejects(readSystemTree(bad.objects, bad.root), /not a CID/);
  const notWasm = await tree(t, { "bin/x.wasm": "text", "etc/subscriptions.json": "[]" });
  await assert.rejects(readSystemTree(notWasm.objects, notWasm.root), /not a wasm module/);
  const component = Uint8Array.from([0, 0x61, 0x73, 0x6d, 0x0d, 0, 1, 0]);
  const comp = await tree(t, { "bin/c.wasm": component, "etc/subscriptions.json": "[]" });
  assert.ok((await readSystemTree(comp.objects, comp.root)).modules[0]!.cid.equals(rawCid(component)), "a component in bin/ is a module like any other");
  const c = { identity: key(), owner: key(), handle: "a", domain: "localhost" };
  assert.throws(() => resolveSystem(c, {}, [{ box: "run", handler: "missing" }]), /no such program/);
  assert.throws(() => resolveSystem(c, {}, [], { peers: { infer: "$infer" } }), /no inference peer/);
});

test("#141: the default image installs chain, git and site at birth — the records, rows and heads a message install writes, no row from $owner, the site read at /", async () => {
  const image = join(import.meta.dirname, "../../images/default");
  const { root, objects } = await dirSource(image);
  const src = anyOf(objects, wasmDirObjects(join(import.meta.dirname, "../../wasm")));
  const s = await readSystemTree(src, root);
  assert.deepEqual(s.apps?.install, ["apps/chain", "apps/git", "apps/site"]);
  const programs = Object.fromEntries(s.programs.map((p) => [p.name, encode(p.record).cid]));
  const identity = key();
  const c = { identity, handle: "a", domain: "localhost" };
  const sys = resolveSystem(c, programs, [], s.config, root, s.routes, s.reads, s.dispatch);
  const kept = new Map<string, Uint8Array>();
  const target = { hasBlock: async (cid: CID) => kept.has(cid.toString()) || !!(await src.get(cid)), putBlock: async (cid: CID, b: Uint8Array) => { kept.set(cid.toString(), b); } };
  const born = await installAtBirth(target, src, s, sys, c);
  assert.deepEqual(born.apps.map((a) => `${a.name} ${a.version}`), ["chain 0.4.0", "git 0.1.3", "site 0.7.7"]);
  assert.deepEqual(Object.keys(born.heads).sort(), ["chain/app", "git/app", "reads", "site/app"]);
  const get = (cid: CID) => dagCbor.decode(kept.get(cid.toString())!) as Record<string, any>;
  for (const n of ["chain", "git", "site"]) assert.equal(get(born.heads[`${n}/app`]!).kind, "app", `${n}/app is its app record, in the store`);
  // The rows: each with its app; none from the owner (an image has none: the owner adds them after the claim).
  const rows = born.rows as Array<Record<string, any>>;
  assert.ok(rows.every((r) => typeof r.app === "string"));
  assert.deepEqual(rows.map((r) => `${r.app} ${r.transport} ${r.address} ${r.sender instanceof Uint8Array ? keyHex(r.sender) === identity ? "$self" : "a key" : r.sender}`), ["chain mailbox chain event", "chain mailbox chain $self"], "chain's event row (the headers feed) and $self row; git's only row is the owner's; status left out (no provider here)");
  assert.ok(born.apps.find((a) => a.name === "git")!.notes.some((x) => /from \$owner: an image has no owner/.test(x)));
  // The reads: the site's own under /site/, and the owner's at / (no app: an upgrade of site leaves it).
  const reads = get(born.heads.reads!).reads as Array<Record<string, any>>;
  const site = get(born.heads["site/app"]!);
  assert.deepEqual(reads.map((r) => [r.address, r.prefix, r.fn, r.root, r.app, r.program.toString()]), [
    ["/site/", true, "get", "www", "site", site.programs.site.toString()],
    ["/", true, "get", "www", undefined, site.programs.site.toString()],
  ]);
  // The same app record as `skein plan install <dir>` over a claimed instance: same CID; its rows are these plus the owner's.
  const owner = key();
  const claimed = { store: { has: async () => false, get: async () => { throw new Error("none"); }, bytes: async () => { throw new Error("none"); }, putBlock: async () => {} } as never, owner, identity, programs: sys.programs, addressBook: [], heads: [], dispatch: [...sys.dispatch] };
  const viaMessages = await planInstall(await readApp(join(image, "apps/chain")), claimed, { modules: src });
  assert.ok(viaMessages.recordCid.equals(born.heads["chain/app"]!), "the image's chain/app is the message install's app record");
  assert.deepEqual(viaMessages.rows.filter((r) => keyHex(r.row.sender) !== owner).map((r) => encode(r.row as never).cid.toString()), rows.filter((r) => r.app === "chain").map((r) => encode(r as never).cid.toString()), "the same rows, byte for byte, but the owner's");
  assert.ok(viaMessages.rows.some((r) => keyHex(r.row.sender) === owner), "the message install adds the owner's row");
  // The genesis carries the heads.
  const g = genesisRecord(c, { ...sys, dispatch: [...sys.dispatch, ...born.rows], heads: born.heads }) as Record<string, any>;
  assert.ok(g.heads["chain/app"].equals(born.heads["chain/app"]));
});

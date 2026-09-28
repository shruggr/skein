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
import { dirSource, rawCid, readSystemTree } from "./boot.ts";
import { genesisRecord, keyHex, resolveSystem } from "./genesis.ts";

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

test("system tree: bin/ programs (.wasm bytes, .cid, .json), config and subscriptions resolve into a genesis", async (t) => {
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
  const g = genesisRecord(c, resolveSystem(c, programs, s.subscriptions, s.config, root)) as Record<string, any>;
  assert.ok(g.tree.equals(root));
  assert.deepEqual(g.defaults.model, "m");
  assert.equal(g.defaults.fuelPerStep, "5", "the tree's config wins over the host's defaults");
  const warned: string[] = [];
  const o = { ...c, overrides: { fuelPerStep: "7" }, warn: (l: string) => warned.push(l) };
  assert.equal((genesisRecord(o, resolveSystem(o, programs, s.subscriptions, s.config, root)) as Record<string, any>).defaults.fuelPerStep, "7", "an explicit override wins");
  assert.match(warned[0]!, /replaces the system tree's fuelPerStep = 5/);
  const fill = { ...c, defaults: { walletNetwork: "test" } };
  assert.equal((genesisRecord(fill, resolveSystem(fill, programs, s.subscriptions, s.config, root)) as Record<string, any>).defaults.walletNetwork, "test", "the host fills what the tree leaves unset");
  assert.equal(keyHex(g.peers.infer), infer);
  assert.equal(keyHex(g.subscriptions[0].match.sender), c.owner);
  assert.equal(g.subscriptions[1].match.sender, undefined);
  assert.ok(g.subscriptions[1].handler.equals(programs.echo));
  assert.deepEqual(g.collect, ["x"]);
});

test("system tree: refusals — no subscriptions, a bad .cid, a handler that is no program, $infer on a host without one", async (t) => {
  const none = await tree(t, { "bin/x.wasm": MODULE });
  await assert.rejects(readSystemTree(none.objects, none.root), /subscriptions\.json: missing/);
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

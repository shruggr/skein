// The explorer over a small instance written by the Zig kernel through a
// router (testhost.ts chatWorld): a directory imported (objects → `main`), a
// chat turn with one bash tool call (loop → shell → loop → the answer in the
// owner's mailbox), then every page rendered from the store file, opened
// read-only beside the live kernel.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encode } from "../../runtime/cid.ts";
import { headTree, MAIN } from "../../runtime/heads.ts";
import { openStoreFile } from "../../runtime/index-store.ts";
import { rawCid } from "../../runtime/programs.ts";
import { openStore } from "../../runtime/sqlite.ts";
import { KERNEL_BIN } from "../../host/kernel.ts";
import { chatWorld } from "../../host/testhost.ts";
import { render } from "./server.ts";
import { load } from "./view.ts";

const skip = !existsSync(KERNEL_BIN) && "kernel-zig not built";

async function world(t: { after(fn: () => unknown): void }) {
  const dir = await fs.mkdtemp(join(tmpdir(), "skein-explore-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(join(dir, "src"));
  await fs.writeFile(join(dir, "src/a.txt"), "alpha\n");
  await fs.writeFile(join(dir, "README"), "hello\n");
  const w = await chatWorld(t, dir);
  const store = openStoreFile(w.store, { readOnly: true });
  t.after(() => store.close());
  const get = async (path: string) => {
    const r = await render(store, new URL(path, "http://x"));
    return { ...r, text: r.body };
  };
  return { ...w, store, get };
}

test("explore: overview, log, entry, threads, the loop's conversation, the shell run, a tree, a head, the subscriptions chain", { skip }, async (t) => {
  const { store, root, get, h } = await world(t);
  assert.ok((await headTree(store, MAIN))?.equals(root), h.lines.join("\n"));

  const home = await get("/");
  assert.equal(home.status, 200);
  for (const s of ["alpha@localhost", "peer infer", "objects-handler", root.toString(), "subscriptions", "format 2"]) assert.ok(home.text.includes(s), `overview: ${s}`);
  assert.ok(home.text.includes(`href="/s"`), "the overview links the chain");

  const log = await get("/log");
  for (const s of ["genesis", "wake", "objects-handler", "loop", "shell", "launched"]) assert.ok(log.text.includes(s), `log: ${s}`);

  const e = await get("/e/0");
  assert.equal(e.status, 200);
  for (const s of ["log entry #0", "genesis", "entries are unsigned"]) assert.ok(e.text.includes(s), `entry: ${s}`);

  const threads = await get("/threads");
  for (const s of ["loop", "shell", "objects-handler", "ls | head -3"]) assert.ok(threads.text.includes(s), `threads: ${s}`);
  const shells = await get("/threads?program=shell");
  assert.ok(shells.text.includes("ls | head -3") && !shells.text.includes("objects-handler</td>"));

  const w = await load(store);
  const loop = w.threads.find((x) => x.program === "loop")!;
  const shell = w.threads.find((x) => x.program === "shell")!;
  const th = await get(`/t/${loop.cid}`);
  for (const s of ["What is here?", "tool call", "ls | head -3", "README", "<strong>src</strong>", "oracle call", "awaits a reply to"]) assert.ok(th.text.includes(s), `thread: ${s}`);
  const tip = JSON.parse((await get(`/t/${loop.cid}?tip=1`)).text);
  assert.equal(tip.state, "waiting");
  assert.ok(th.text.includes("setTimeout(poll"), "a waiting thread polls");
  assert.ok(!(await get(`/t/${loop.cid}?frag=1`)).text.includes("<html"), "the fragment is the body alone");

  const sh = await get(`/t/${shell.cid}`);
  for (const s of ["exit 0", "README", "launched by", "loop"]) assert.ok(sh.text.includes(s), `shell thread: ${s}`);

  const tree = await get(`/r/${root}`);
  for (const s of ["git tree", "README", "src/"]) assert.ok(tree.text.includes(s), `tree: ${s}`);
  assert.ok((await get(`/r/${root}?p=src/a.txt`)).text.includes("alpha"));
  assert.ok((await get(`/r/${root}?p=README`)).text.includes("hello"));

  const head = await get(`/h/${MAIN}`);
  assert.ok(head.text.includes(root.toString()) && head.text.includes("objects-handler"));

  const subs = await get("/s");
  for (const s of ["genesis seed", "subscribe-handler", "add", "owner"]) assert.ok(subs.text.includes(s), `subscriptions: ${s}`);

  const rec = await get(`/r/${loop.cid}`);
  assert.ok(rec.text.includes("thread view") && rec.text.includes("kind <b>thread</b>"));
  assert.equal((await get(`/r/${encode({ nothing: "here" }).cid}`)).status, 404);
  assert.equal((await get("/nope")).status, 404);
  assert.equal((await get("/t/not-a-cid")).status, 404);
});

test("explore: a store file opened read-only renders records and raw blocks (a wasm module, arbitrary bytes) and refuses writes", async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), "skein-explore-db-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const path = join(dir, "runtime.db");
  const rw = openStore(path);
  const cid = await rw.put({ kind: "note", text: "hi" });
  const module = Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), bytes = Uint8Array.from([0xff, 0x00, 0x01, 0x02, 0x80]);
  await rw.putBlock(rawCid(module), module);
  await rw.putBlock(rawCid(bytes), bytes);
  await rw.close();
  const ro = openStore(path, { readOnly: true });
  t.after(() => ro.close());
  const get = async (p: string) => { const r = await render(ro, new URL(p, "http://x")); return { status: r.status, text: r.body }; };
  const r = await get(`/r/${cid}`);
  assert.equal(r.status, 200);
  assert.ok(r.text.includes("kind <b>note</b>"));
  const wasm = await get(`/r/${rawCid(module)}`);
  assert.equal(wasm.status, 200);
  assert.ok(wasm.text.includes("a wasm module") && wasm.text.includes("00 61 73 6d"));
  const raw = await get(`/r/${rawCid(bytes)}`);
  assert.equal(raw.status, 200);
  assert.ok(raw.text.includes("5 bytes") && raw.text.includes("ff 00 01 02 80"));
  assert.equal((await get("/")).status, 200);
  await assert.rejects(ro.put({ kind: "note", text: "no" }), /readonly/);
});

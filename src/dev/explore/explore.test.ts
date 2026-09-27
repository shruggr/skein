// The explorer over a small instance, in process: a directory imported
// (objects → `main`), a chat turn with one bash tool call (loop → shell → loop
// → a chat reply), then every page rendered from the memory store.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKey } from "@bsv/sdk";
import { encode } from "../../runtime/cid.ts";
import { signedPart } from "../../envelope.ts";
import { InferPeer } from "../../peers/infer.ts";
import { headTree, MAIN } from "../../runtime/heads.ts";
import { stampMs } from "../../runtime/log.ts";
import { MODULES, rawCid } from "../../runtime/programs.ts";
import { bundlesOf, instance, send, type Instance } from "../../testkit.ts";
import { ephemeralWallet } from "../../wallet.ts";
import { openStore } from "../../runtime/sqlite.ts";
import { render } from "./server.ts";
import { load } from "./view.ts";

type Json = Record<string, unknown>;

const answer = (message: Json) => ({ choices: [{ message: { role: "assistant", ...message } }], usage: { prompt_tokens: 10, completion_tokens: 5 }, model: "qwen38" });
const toolCall = (id: string, cmd: string) => ({ id, type: "function", function: { name: "bash", arguments: JSON.stringify({ cmd }) } });

async function settle(i: Instance) { await i.delivery.poll(); await i.rt.idle(); }

async function world(t: { after(fn: () => Promise<void>): void }) {
  const dir = await fs.mkdtemp(join(tmpdir(), "skein-explore-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(join(dir, "src"));
  await fs.writeFile(join(dir, "src/a.txt"), "alpha\n");
  await fs.writeFile(join(dir, "README"), "hello\n");
  const inferKey = PrivateKey.fromRandom();
  const i = await instance({ config: { peers: { infer: inferKey.toPublicKey().toString() } } });
  const answers = [answer({ content: "", tool_calls: [toolCall("call-1", "ls | head -3")] }), answer({ content: "README and **src**." })];
  const peer = new InferPeer({
    wallet: ephemeralWallet(inferKey), box: i.hub.as(inferKey.toPublicKey().toString()), log: () => {},
    providers: { ripper: { baseUrl: "http://ripper.test/v1", apiKey: "k" } }, now: () => stampMs(i.clock.now()),
    fetch: (async () => new Response(JSON.stringify(answers.shift()), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
  });
  const { root, bundles } = await bundlesOf(dir);
  for (const b of bundles) await send(i, "objects", b);
  await settle(i);
  const chat = await send(i, "chat", { text: "What is here?", tree: root });
  await settle(i);
  await peer.poll(); await settle(i);
  await peer.poll(); await settle(i);
  const get = async (path: string) => {
    const r = await render(i.store, new URL(path, "http://x"));
    return { ...r, text: r.body };
  };
  return { i, root, chat: encode(signedPart(chat)).cid, get };
}

test("explore: overview, log, entry, threads, the loop's conversation, a tree, a head", async (t) => {
  const { i, root, chat, get } = await world(t);
  assert.ok((await headTree(i.store, MAIN))?.equals(root), i.lines.join("\n"));

  const home = await get("/");
  assert.equal(home.status, 200);
  for (const s of ["skein@localhost", "peer infer", "objects-handler", root.toString(), "subscription", "completions"]) assert.ok(home.text.includes(s), `overview: ${s}`);

  const log = await get("/log");
  for (const s of ["genesis", "objects", "chat", "completions", "owner", "infer", "launched"]) assert.ok(log.text.includes(s), `log: ${s}`);

  const entry = await i.store.log.byEnvelope(chat);
  const e = await get(`/e/${entry}`);
  for (const s of ["What is here?", "= body digest", "verifies", "subscription #3", "loop"]) assert.ok(e.text.includes(s), `entry: ${s}`);

  const threads = await get("/threads");
  for (const s of ["loop", "shell", "objects-handler", "ls | head -3"]) assert.ok(threads.text.includes(s), `threads: ${s}`);
  const shells = await get("/threads?program=shell");
  assert.ok(shells.text.includes("shell") && !shells.text.includes("objects-handler</td>"));

  const [loop] = (await load(i.store)).threads.filter((x) => x.program === "loop");
  const [shell] = (await load(i.store)).threads.filter((x) => x.program === "shell");
  const th = await get(`/t/${loop.cid}`);
  for (const s of ["What is here?", "tool call", "ls | head -3", "README", "<strong>src</strong>", "emitted → <b>chat</b>", "awaits a reply to", "attested call"]) assert.ok(th.text.includes(s), `thread: ${s}`);
  assert.ok(th.text.includes("setTimeout(poll"), "a waiting thread polls");
  const tip = JSON.parse((await get(`/t/${loop.cid}?tip=1`)).text);
  assert.equal(tip.state, "waiting");
  assert.ok(!(await get(`/t/${loop.cid}?frag=1`)).text.includes("<html"), "the fragment is the body alone");

  const sh = await get(`/t/${shell.cid}`);
  for (const s of ["exit 0", "README", "launched by", "loop"]) assert.ok(sh.text.includes(s), `shell thread: ${s}`);
  if (process.env.EXPLORE_DUMP) console.log(th.text, sh.text);

  const tree = await get(`/r/${root}`);
  for (const s of ["git tree", "README", "src/"]) assert.ok(tree.text.includes(s), `tree: ${s}`);
  assert.ok((await get(`/r/${root}?p=src/a.txt`)).text.includes("alpha"));
  assert.ok((await get(`/r/${root}?p=README`)).text.includes("hello"));

  const head = await get(`/h/${MAIN}`);
  assert.ok(head.text.includes(root.toString()) && head.text.includes("objects-handler"));

  const rec = await get(`/r/${loop.cid}`);
  assert.ok(rec.text.includes("thread view") && rec.text.includes("kind <b>thread</b>"));
});

test("explore: raw blocks render (a wasm module, arbitrary bytes); unknown CIDs and paths are 404", async (t) => {
  const { i, get } = await world(t);
  const wasm = await get(`/r/${MODULES.brush}`);
  assert.equal(wasm.status, 200);
  assert.ok(wasm.text.includes("a wasm module") && wasm.text.includes("00 61 73 6d"));
  const bytes = Uint8Array.from([0xff, 0x00, 0x01, 0x02, 0x80]);
  const cid = rawCid(bytes);
  await i.store.putBlock(cid, bytes);
  const raw = await get(`/r/${cid}`);
  assert.equal(raw.status, 200);
  assert.ok(raw.text.includes("5 bytes") && raw.text.includes("ff 00 01 02 80"));
  assert.equal((await get(`/r/${encode({ nothing: "here" }).cid}`)).status, 404);
  assert.equal((await get("/nope")).status, 404);
  assert.equal((await get("/t/not-a-cid")).status, 404);
});

test("explore: a store file opened read-only renders and refuses writes", async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), "skein-explore-db-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const path = join(dir, "runtime.db");
  const rw = openStore(path);
  const cid = await rw.put({ kind: "note", text: "hi" });
  await rw.close();
  const ro = openStore(path, { readOnly: true });
  t.after(() => ro.close());
  const r = await render(ro, new URL(`/r/${cid}`, "http://x"));
  assert.equal(r.status, 200);
  assert.ok(r.body.includes("kind <b>note</b>"));
  assert.equal((await render(ro, new URL("/", "http://x"))).status, 200);
  await assert.rejects(ro.put({ kind: "note", text: "no" }), /readonly/);
});

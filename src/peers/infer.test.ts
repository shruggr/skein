// The inference peer on its own: request mapping to an OpenAI-compatible
// endpoint (a fake fetch), response mapping, errors, and one request through a
// messagebox — opened with its wallet, answered in `completions` with replyTo.
// Then the infer protocol (#12): graph deltas, the missing-node reply, the
// cache on disk, model and thinking per request.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { open, seal, signedPart, verify, type Envelope } from "../envelope.ts";
import { encode } from "../runtime/cid.ts";
import { messageBoxHub } from "../testkit.ts";
import { ephemeralWallet } from "../wallet.ts";
import { InferPeer, NodeGraph } from "./infer.ts";

function fakeFetch(respond: (url: string, body: Record<string, unknown>, headers: Record<string, string>) => Response) {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const f = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
    const c = { url, body: JSON.parse(init.body), headers: init.headers };
    calls.push(c);
    return respond(c.url, c.body, c.headers);
  }) as unknown as typeof fetch;
  return { f, calls };
}

const ok = (message: Record<string, unknown>) => new Response(JSON.stringify({ choices: [{ message }], usage: { total_tokens: 7 } }), { status: 200 });

test("infer peer: provider/model split, auth, thinking, tools; content, reasoning and tool calls mapped back; nulls dropped", async () => {
  const { f, calls } = fakeFetch(() => ok({ role: "assistant", content: null, reasoning_content: "hmm", tool_calls: [{ id: "t1", type: "function", function: { name: "bash", arguments: "{\"cmd\":\"ls\"}" } }] }));
  const peer = new InferPeer({ wallet: ephemeralWallet(), box: messageBoxHub().as("x"), providers: { ripper: { baseUrl: "http://ripper:8001/v1/", apiKey: "vllm" } }, fetch: f });
  const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }];
  const r = await peer.complete({ model: "ripper/qwen38", messages: [{ role: "user", content: "hi" }], tools, thinking: "off" });
  assert.equal(calls[0].url, "http://ripper:8001/v1/chat/completions");
  assert.equal(calls[0].headers.authorization, "Bearer vllm");
  assert.equal(calls[0].body.model, "qwen38");
  assert.deepEqual(calls[0].body.chat_template_kwargs, { enable_thinking: false });
  assert.deepEqual(calls[0].body.tools, tools);
  assert.ok("message" in r);
  assert.deepEqual(r.message, { role: "assistant", reasoning: "hmm", tool_calls: [{ id: "t1", type: "function", function: { name: "bash", arguments: "{\"cmd\":\"ls\"}" } }] });
  assert.equal(r.model, "ripper/qwen38");
  assert.deepEqual(r.usage, { total_tokens: 7 });

  await peer.complete({ model: "ripper/qwen38", messages: [], thinking: "high" });
  assert.deepEqual([calls[1].body.chat_template_kwargs, calls[1].body.reasoning_effort, calls[1].body.tools], [{ enable_thinking: true }, "high", undefined]);
  assert.deepEqual(await peer.complete({ model: "nowhere/x", messages: [] }), { error: "no provider \"nowhere\" (known: ripper)" });
});

test("infer peer: an HTTP error becomes {error}", async () => {
  const { f } = fakeFetch(() => new Response("model not loaded", { status: 404 }));
  const peer = new InferPeer({ wallet: ephemeralWallet(), box: messageBoxHub().as("x"), providers: { ripper: { baseUrl: "http://r/v1" } }, fetch: f });
  assert.deepEqual(await peer.complete({ model: "ripper/q", messages: [] }), { error: "ripper: HTTP 404 model not loaded" });
});

test("infer peer: a sealed request in its `infer` box → a sealed completion in the sender's `completions`, replyTo the request's CID; acknowledged", async () => {
  const hub = messageBoxHub();
  const peerKey = PrivateKey.fromRandom(), instKey = PrivateKey.fromRandom();
  const peerId = peerKey.toPublicKey().toString(), instId = instKey.toPublicKey().toString();
  const inst = ephemeralWallet(instKey);
  const { f } = fakeFetch(() => ok({ role: "assistant", content: "hello" }));
  const peer = new InferPeer({ wallet: ephemeralWallet(peerKey), box: hub.as(peerId), providers: { ripper: { baseUrl: "http://r/v1" } }, fetch: f });
  const req = await seal(inst, { recipient: { identityKey: peerId, handle: "infer", domain: "localhost" }, sender: { handle: "skein", domain: "localhost" }, body: dagCbor.encode({ model: "ripper/qwen38", messages: [{ role: "user", content: "hi" }] }) });
  await hub.as(instId).send({ recipient: peerId, box: "infer", body: req });
  // Junk and a forged submitter are rejected (and acknowledged).
  hub.inject(peerId, "infer", { sender: instId, body: "\"not an envelope\"" });
  hub.inject(peerId, "infer", { sender: PrivateKey.fromRandom().toPublicKey().toString(), body: JSON.stringify(req) });
  assert.equal(await peer.poll(), 1);
  assert.equal(hub.pending(peerId, "infer").length, 0);
  const [m] = hub.pending(instId, "completions");
  assert.equal(m.sender, peerId);
  const env = JSON.parse(m.body as string) as Envelope;
  assert.ok(verify(env));
  assert.equal(env.recipient.handle, "skein");
  const body = dagCbor.decode((await open(inst, env)).body) as { replyTo: CID; message: { content: string }; model: string; ms: number };
  assert.ok(body.replyTo.equals(encode(signedPart(req)).cid), "replyTo is the request's id: its signed part's CID");
  assert.equal(body.message.content, "hello");
  assert.equal(body.model, "ripper/qwen38");
  assert.equal(typeof body.ms, "number");
});

// ---------------------------------------------------------------- the infer protocol (#12): graph deltas

/** A turn node as the loop keeps it, chained to `parent`. */
const node = (parent: CID | undefined, role: string, fields: Record<string, unknown>) => ({ kind: "turn" as const, ...(parent ? { parent } : {}), of: encode({ of: role, ...fields }).cid, role, ...fields });
const cid = (n: unknown) => encode(n).cid;

function chatPeer(o: { dir?: string; max?: number } = {}) {
  const { f, calls } = fakeFetch(() => ok({ role: "assistant", content: "ok" }));
  const graph = new NodeGraph(o);
  const peer = new InferPeer({ wallet: ephemeralWallet(), box: messageBoxHub().as("x"), providers: { ripper: { baseUrl: "http://r/v1" }, big: { baseUrl: "http://big/v1" } }, fetch: f, graph });
  return { peer, graph, calls };
}

test("infer protocol: the first request is the whole path; a delta names its parent and the peer rebuilds the whole chat from its graph; tool turns render as before; a fork names an earlier parent", async () => {
  const { peer, calls } = chatPeer();
  const sys = node(undefined, "system", { content: "Be brief." });
  const user = node(cid(sys), "user", { text: "ls?" });
  let r = await peer.answer("alice", { model: "ripper/q", nodes: [sys, user] });
  assert.ok("message" in r);
  assert.deepEqual(calls[0].body.messages, [{ role: "system", content: "Be brief." }, { role: "user", content: "ls?" }]);

  const call = { id: "c1", type: "function", function: { name: "bash", arguments: "{\"cmd\":\"ls\"}" } };
  const asst = node(cid(user), "assistant", { tool_calls: [call], model: "ripper/q", ms: 3 });
  const tool = node(cid(asst), "tool", { call: "c1", exitCode: 0, stdout: "README\n", stderr: "oops" });
  const msg = node(cid(tool), "tool", { call: "c2", to: "@bob@x", text: "4" });
  const err = node(cid(msg), "error", { error: "not for the model" });
  r = await peer.answer("alice", { model: "ripper/q", parent: cid(user), nodes: [asst, tool, msg, err] });
  assert.ok("message" in r);
  assert.deepEqual(calls[1].body.messages, [
    { role: "system", content: "Be brief." },
    { role: "user", content: "ls?" },
    { role: "assistant", content: "", tool_calls: [call] },
    { role: "tool", tool_call_id: "c1", content: "exit 0\nREADME\n\n[stderr]\noops" },
    { role: "tool", tool_call_id: "c2", content: "4" },
  ]);

  // Fork: name an earlier parent. The other branch is untouched.
  const alt = node(cid(sys), "user", { text: "something else" });
  await peer.answer("alice", { model: "ripper/q", parent: cid(sys), nodes: [alt] });
  assert.deepEqual(calls[2].body.messages, [{ role: "system", content: "Be brief." }, { role: "user", content: "something else" }]);
});

test("infer protocol: a parent the peer does not hold → {missing: [it]} and no engine call; another sender's nodes do not count; nodes that do not chain are an error", async () => {
  const { peer, calls } = chatPeer();
  const sys = node(undefined, "system", { content: "S" });
  const user = node(cid(sys), "user", { text: "hi" });
  await peer.answer("alice", { model: "ripper/q", nodes: [sys, user] });
  const next = node(cid(user), "user", { text: "again" });
  const r = await peer.answer("bob", { model: "ripper/q", parent: cid(user), nodes: [next] });
  assert.ok("missing" in r);
  assert.ok(r.missing[0].equals(cid(user)), "bob does not see alice's graph");
  assert.equal(calls.length, 1);
  // The resend: the whole path, no parent.
  assert.ok("message" in await peer.answer("bob", { model: "ripper/q", nodes: [sys, user, next] }));

  assert.deepEqual(await peer.answer("alice", { model: "ripper/q", parent: cid(sys), nodes: [next] }), { error: "infer: node 0 does not extend the named parent" });
  assert.deepEqual(await peer.answer("alice", { model: "ripper/q", nodes: [sys, next] }), { error: "infer: node 1 does not extend node 0" });
  assert.deepEqual(await peer.answer("alice", { model: "ripper/q", nodes: [] }), { error: "infer wants {model, thinking?, tools?, parent?, nodes}: no nodes" });
  assert.deepEqual(await peer.answer("alice", { model: "ripper/q", nodes: [{ kind: "nope", role: "user" } as never] }), { error: "infer: node 0 is not a turn" });
});

test("infer protocol: an evicted or restarted peer answers missing; with a cache directory it reads the graph back from disk", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "skein-infer-cache-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sys = node(undefined, "system", { content: "S" });
  const user = node(cid(sys), "user", { text: "hi" });
  const next = node(cid(user), "user", { text: "again" });

  // Memory only, and small: the least recently used node is evicted (the
  // walk to the root touched `user` before `sys`); the walk finds the gap.
  const small = chatPeer({ max: 2 });
  await small.peer.answer("alice", { model: "ripper/q", nodes: [sys, user] });
  const r = await small.peer.answer("alice", { model: "ripper/q", parent: cid(user), nodes: [next] });
  assert.ok("missing" in r && r.missing[0].equals(cid(user)), "evicted");

  // With a directory: a new process (a fresh graph over the same directory) holds it all.
  const a = chatPeer({ dir });
  await a.peer.answer("alice", { model: "ripper/q", nodes: [sys, user] });
  const b = chatPeer({ dir });
  assert.equal(b.graph.size, 0);
  assert.ok("message" in await b.peer.answer("alice", { model: "ripper/q", parent: cid(user), nodes: [next] }));
  assert.equal((b.calls[0].body.messages as unknown[]).length, 3);
  assert.deepEqual((await readdir(join(dir, "alice"))).sort(), [cid(sys), cid(user), cid(next)].map(String).sort());
  // A damaged file is a missing node.
  await writeFile(join(dir, "alice", cid(sys).toString()), dagCbor.encode({ kind: "turn", role: "system", content: "forged" }));
  const c = chatPeer({ dir });
  const m = await c.peer.answer("alice", { model: "ripper/q", parent: cid(next), nodes: [node(cid(next), "user", { text: "3" })] });
  assert.ok("missing" in m && m.missing[0].equals(cid(sys)));
});

test("infer protocol: model and thinking per request, mapped to the provider table", async () => {
  const { peer, calls } = chatPeer();
  const sys = node(undefined, "system", { content: "S" });
  await peer.answer("alice", { model: "big/huge", thinking: "medium", nodes: [sys] });
  assert.equal(calls[0].url, "http://big/v1/chat/completions");
  assert.deepEqual([calls[0].body.model, calls[0].body.reasoning_effort, calls[0].body.chat_template_kwargs], ["huge", "medium", { enable_thinking: true }]);
  await peer.answer("alice", { model: "ripper/q", thinking: "off", parent: cid(sys), nodes: [node(cid(sys), "user", { text: "x" })] });
  assert.equal(calls[1].url, "http://r/v1/chat/completions");
  assert.deepEqual([calls[1].body.model, calls[1].body.reasoning_effort, calls[1].body.chat_template_kwargs], ["q", undefined, { enable_thinking: false }]);
  await peer.answer("alice", { model: "ripper/q", nodes: [sys] });
  assert.deepEqual([calls[2].body.reasoning_effort, calls[2].body.chat_template_kwargs], [undefined, undefined], "no thinking: the engine's default");
  assert.deepEqual(await peer.answer("alice", { model: "ripper/q", thinking: "max" as never, nodes: [sys] }), { error: "thinking must be one of off, low, medium, high, not \"max\"" });
  assert.equal(calls.length, 3);
});

test("infer protocol: through the messagebox, a missing parent is a sealed {replyTo, missing} in `completions`", async () => {
  const hub = messageBoxHub();
  const peerKey = PrivateKey.fromRandom(), instKey = PrivateKey.fromRandom();
  const peerId = peerKey.toPublicKey().toString(), instId = instKey.toPublicKey().toString();
  const inst = ephemeralWallet(instKey);
  const { f, calls } = fakeFetch(() => ok({ role: "assistant", content: "hello" }));
  const peer = new InferPeer({ wallet: ephemeralWallet(peerKey), box: hub.as(peerId), providers: { ripper: { baseUrl: "http://r/v1" } }, fetch: f });
  const lost = cid({ lost: true });
  const req = await seal(inst, { recipient: { identityKey: peerId, handle: "infer", domain: "localhost" }, sender: { handle: "skein", domain: "localhost" }, body: dagCbor.encode({ model: "ripper/q", parent: lost, nodes: [node(lost, "user", { text: "hi" })] }) });
  await hub.as(instId).send({ recipient: peerId, box: "infer", body: req });
  assert.equal(await peer.poll(), 1);
  assert.equal(calls.length, 0);
  const [m] = hub.pending(instId, "completions");
  const body = dagCbor.decode((await open(inst, JSON.parse(m.body as string) as Envelope)).body) as { replyTo: CID; missing: CID[] };
  assert.ok(body.replyTo.equals(encode(signedPart(req)).cid));
  assert.equal(body.missing.length, 1);
  assert.ok(body.missing[0].equals(lost));
});

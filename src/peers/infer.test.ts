// The inference peer on its own: request mapping to an OpenAI-compatible
// endpoint (a fake fetch), response mapping, errors, and one request through a
// messagebox — opened with its wallet, answered in `completions` with replyTo.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { open, seal, signedPart, verify, type Envelope } from "../envelope.ts";
import { encode } from "../runtime/cid.ts";
import { messageBoxHub } from "../testkit.ts";
import { ephemeralWallet } from "../wallet.ts";
import { InferPeer } from "./infer.ts";

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

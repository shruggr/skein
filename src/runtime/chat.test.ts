// The chat step end to end, in process: David's `chat` → the loop program →
// `infer` to the inference peer (the real InferPeer over a scripted fetch) →
// a completion with a bash tool call → the shell → the tool result kept →
// a second `infer` → a plain answer → a `chat` reply to David, awaiting his
// reply → his reply (correlated by `replyTo`, not by subscription) → the next
// step. Then: stray replies, a restart mid-turn, replay with no wallet, and
// two instances talking on one thread each.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { open, seal, signedPart, verify, type Envelope } from "../envelope.ts";
import { InferPeer } from "../peers/infer.ts";
import { brc169Host, bundlesOf, collect, deggenResolution, faultyHub, installWasm, instance, iso, LKUP, messageBoxHub, noAccount, scriptClock, send, type Hub, type Instance } from "../testkit.ts";
import { render } from "../dev/explore/server.ts";
import { hostResolver } from "../host/host.ts";
import { ephemeralWallet } from "../wallet.ts";
import { encode, fmt } from "./cid.ts";
import { headTree, MAIN } from "./heads.ts";
import { copyLog, readLog, stampMs } from "./log.ts";
import { memoryStore } from "./memory.ts";
import { LOOP, PROGRAM_CIDS } from "./programs.ts";
import { Runtime, witnessFrom, type Outbound } from "./scheduler.ts";
import type { Store } from "./store.ts";
import type { ThreadUpdate } from "./types.ts";
import type { Attested, Emit } from "./records.ts";

type Json = Record<string, unknown>;

/** The loop's fixed system prompt, for a tree with no SOUL.md (programs/loop/main.go). */
const DEFAULT_PROMPT = "You are working with David through skein. Use the bash tool to run commands over the working tree; when you are done or need David, answer in plain text; keep answers short.";

/** A scripted OpenAI-compatible endpoint: answers in order, records each request body. */
function scripted(answers: Array<Json | { status: number; text: string }>) {
  const requests: Json[] = [];
  const f = (async (_url: string, init: { body: string }) => {
    requests.push(JSON.parse(init.body));
    const a = answers.shift();
    if (!a) return new Response("no more answers", { status: 500 });
    if ("status" in a && typeof a.status === "number") return new Response(String(a.text), { status: a.status });
    return new Response(JSON.stringify(a), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetch: f, requests };
}

const toolCall = (id: string, cmd: string) => ({ id, type: "function", function: { name: "bash", arguments: JSON.stringify({ cmd }) } });
const messageCall = (id: string, to: string, text: string) => ({ id, type: "function", function: { name: "message", arguments: JSON.stringify({ to, text }) } });
const answer = (message: Json) => ({ choices: [{ message: { role: "assistant", ...message } }], usage: { prompt_tokens: 10, completion_tokens: 5 }, model: "qwen38" });

async function setup(t: { after(fn: () => Promise<void>): void }, answers: Array<Json | { status: number; text: string }>, o: { hub?: Hub; files?: Record<string, string> } = {}) {
  const dir = await fs.mkdtemp(join(tmpdir(), "skein-chat-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(join(dir, "src"));
  await fs.writeFile(join(dir, "src/a.txt"), "alpha\n");
  await fs.writeFile(join(dir, "README"), "hello\n");
  for (const [name, text] of Object.entries(o.files ?? {})) await fs.writeFile(join(dir, name), text);
  const inferKey = PrivateKey.fromRandom();
  const inferId = inferKey.toPublicKey().toString();
  const i = await instance({ hub: o.hub, config: { peers: { infer: inferId } } });
  const api = scripted(answers);
  const peer = inferPeer(i, inferKey, api.fetch);
  const { root, bundles } = await bundlesOf(dir);
  for (const b of bundles) await send(i, "objects", b);
  await settle(i);
  return { i, dir, root, inferKey, inferId, peer, api };
}

function inferPeer(i: Instance, key: PrivateKey, f: typeof fetch) {
  const id = key.toPublicKey().toString();
  return new InferPeer({ log: (l) => i.lines.push(`peer: ${l}`), wallet: ephemeralWallet(key), box: i.hub.as(id), providers: { ripper: { baseUrl: "http://ripper.test/v1", apiKey: "k" } }, fetch: f, now: () => stampMs(i.clock.now()) });
}

async function settle(i: Instance) { await i.delivery.poll(); await i.rt.idle(); }

async function loops(store: Store): Promise<CID[]> {
  return collect(store.edges.query({ kind: "thread", program: PROGRAM_CIDS.loop }));
}
async function history(store: Store, th: CID): Promise<Array<ThreadUpdate & Json>> {
  const out: Array<ThreadUpdate & Json> = [];
  for await (const c of store.chains.history(th)) if (!c.equals(th)) out.push(await store.get(c) as ThreadUpdate & Json);
  return out;
}
const tipOf = async (store: Store, th: CID) => store.get<ThreadUpdate>(await store.chains.tip(th));

/** What David finds in his `chat` box (the instance's replies): verified, opened. */
async function answers(i: Instance): Promise<Array<{ env: Envelope; cid: CID; body: Json }>> {
  const out = [];
  for (const m of i.hub.pending(i.owner.identity, "chat")) {
    const env = JSON.parse(m.body as string) as Envelope;
    assert.ok(verify(env));
    out.push({ env, cid: encode(signedPart(env)).cid, body: dagCbor.decode((await open(i.owner.wallet, env)).body) as Json });
  }
  return out;
}

/** The `infer` bodies waiting in the peer's box (not yet answered), opened with the peer's key. */
async function inferBodies(i: Instance, key: PrivateKey): Promise<Json[]> {
  const out = [];
  for (const m of i.hub.pending(key.toPublicKey().toString(), "infer")) {
    const env = JSON.parse(m.body as string) as Envelope;
    out.push(dagCbor.decode((await open(ephemeralWallet(key), env)).body) as Json);
  }
  return out;
}

/** All records a thread kept (its turns, and notes beside them), in order. */
async function turns(store: Store, th: CID): Promise<Json[]> {
  const out: Json[] = [];
  for (const u of await history(store, th)) for (const r of (u.kept as CID[] | undefined) ?? []) out.push(await store.get(r) as Json);
  return out;
}

async function replayMatches(store: Store): Promise<Outbound[]> {
  const fresh = memoryStore();
  await installWasm(fresh);
  await copyLog(store, fresh);
  const sent: Outbound[] = [];
  const rt = new Runtime({ store: fresh, witness: await witnessFrom(store), outbox: { send: (o) => { sent.push(o); } } });
  await rt.start();
  await rt.idle();
  for (const o of await collect(store.edges.query({ kind: "thread" }))) {
    assert.ok((await fresh.chains.tip(o)).equals(await store.chains.tip(o)), `thread ${fmt(o)} replays to the same tip`);
  }
  await rt.stop();
  return sent;
}

test("chat: a turn — infer, a bash tool call in the shell, infer again, a chat reply to David awaiting him; his reply continues the same thread", async (t) => {
  const { i, root, inferId, peer, api } = await setup(t, [
    answer({ content: "", tool_calls: [toolCall("call-1", "ls | head -3")] }),
    answer({ content: "README and src.", reasoning_content: "short" }),
    answer({ content: "You're welcome." }),
  ]);
  const chat = await send(i, "chat", { text: "What is here?", tree: root });
  const chatCid = encode(signedPart(chat)).cid;
  await settle(i);

  // Step 1: the user turn kept, `infer` emitted to the peer, the thread awaits it.
  const [loop] = await loops(i.store);
  let tip = await tipOf(i.store, loop);
  assert.equal(tip.state, "waiting");
  assert.equal(tip.awaits?.length, 1);
  const [req1] = i.hub.pending(inferId, "infer");
  assert.ok(encode(signedPart(JSON.parse(req1.body as string))).cid.equals(tip.awaits![0]), "awaits names the signed infer envelope");

  // The peer answers with a tool call; the loop runs it in the shell, keeps the result, asks again.
  const n1 = await peer.poll();
  assert.equal(n1, 1, i.lines.join("\n"));
  assert.equal(i.hub.pending(inferId, "infer").length, 0);
  assert.equal(api.requests[0].model, "qwen38");
  assert.deepEqual(api.requests[0].chat_template_kwargs, { enable_thinking: false });
  assert.deepEqual((api.requests[0].messages as Json[]).map((m) => m.role), ["system", "user"]);
  assert.equal((api.requests[0].tools as Json[])[0].type, "function");
  await settle(i);
  assert.equal(await peer.poll(), 1, i.lines.join("\n"));
  const second = api.requests[1].messages as Json[];
  assert.deepEqual(second.map((m) => m.role), ["system", "user", "assistant", "tool"]);
  assert.equal(second[3].tool_call_id, "call-1");
  assert.equal(second[3].content, "exit 0\nREADME\nsrc\n");
  await settle(i);
  t.diagnostic(i.lines.join("\n"));

  // The answer: a `chat` to David — the text, the tree, the thread, replyTo his chat.
  const [s1] = await answers(i);
  assert.equal(s1.body.text, "README and src.");
  assert.ok((s1.body.thread as CID).equals(loop));
  assert.ok((s1.body.replyTo as CID).equals(chatCid));
  assert.ok((s1.body.tree as CID).equals(root));
  tip = await tipOf(i.store, loop);
  assert.equal(tip.state, "waiting");
  assert.ok(tip.awaits![0].equals(s1.cid), "resting on David's reply to the answer");

  const [sys, ...rs] = await turns(i.store, loop);
  assert.deepEqual([sys.role, sys.content], ["system", DEFAULT_PROMPT], "no SOUL.md: the fixed prompt, kept");
  assert.ok((sys.of as CID).equals(root));
  assert.deepEqual(rs.map((r) => r.role), ["user", "assistant", "tool", "assistant"]);
  assert.ok((rs[0].of as CID).equals(chatCid));
  assert.equal(rs[0].text, "What is here?");
  assert.equal((rs[1].tool_calls as Json[])[0].id, "call-1");
  assert.deepEqual([rs[2].call, rs[2].exitCode, rs[2].stdout, rs[2].stderr], ["call-1", 0, "README\nsrc\n", ""]);
  assert.equal(rs[3].reasoning, "short");
  const steps = await history(i.store, loop);
  assert.deepEqual(steps.map((u) => u.state), ["waiting", "waiting", "waiting", "waiting"]);
  assert.ok(steps[1].waitingOn && !steps[1].awaits, "the tool step waits on the shell, not a reply");

  // David replies to the answer: delivered to the same thread (no new loop), a new turn.
  const reply = await send(i, "chat", { text: "Thanks", replyTo: s1.cid });
  await settle(i);
  assert.equal((await loops(i.store)).length, 1, "the reply is not routed by subscription");
  assert.ok(i.lines.some((l) => l.includes(`reply to ${fmt(s1.cid).slice(-8)} → ${fmt(loop).slice(-8)}`)));
  const r2 = await turns(i.store, loop);
  assert.equal(r2.at(-1)!.role, "user");
  assert.ok((r2.at(-1)!.of as CID).equals(encode(signedPart(reply)).cid));
  await peer.poll();
  assert.equal((api.requests[2].messages as Json[]).length, 6, "system, user, assistant, tool, assistant, user");
  await settle(i);
  const all = await answers(i);
  assert.equal(all.length, 2);
  assert.equal(all[1].body.text, "You're welcome.");
  assert.ok((all[1].body.replyTo as CID).equals(encode(signedPart(reply)).cid), "the second answer replies to his reply");
  assert.ok((all[1].body.thread as CID).equals(loop));

  // Every entry the correlation used is signed; replay with no wallet reproduces every thread.
  await i.rt.stop();
  const sent = await replayMatches(i.store);
  assert.deepEqual(sent.map((o) => o.box), ["infer", "infer", "chat", "infer", "chat"]);
});

test("chat: a new conversation that names no tree starts from `main`; its work stays in the thread, main does not move", async (t) => {
  const { i, root, peer } = await setup(t, [
    answer({ content: "", tool_calls: [toolCall("c1", "cat README; echo z > new.txt")] }),
    answer({ content: "done" }),
  ]);
  assert.ok((await headTree(i.store, MAIN))!.equals(root), "the import set main");
  await send(i, "chat", { text: "read it" });
  await settle(i);
  await peer.poll();
  await settle(i);
  await peer.poll();
  await settle(i);
  const [loop] = await loops(i.store);
  const [, ...rs] = await turns(i.store, loop);
  assert.deepEqual(rs.map((r) => r.role), ["user", "assistant", "tool", "assistant"]);
  assert.ok((rs[0].tree as CID).equals(root), "the opening turn records main's tree");
  assert.equal(rs[2].stdout, "hello\n");
  const [s] = await answers(i);
  assert.ok(!(s.body.tree as CID).equals(root), "the conversation's tree moved on…");
  assert.ok((await headTree(i.store, MAIN))!.equals(root), "…main did not");
  await i.rt.stop();
  await replayMatches(i.store);
});

test("correlation: a replyTo nobody awaits, or from the wrong identity, is recorded only; the thread keeps waiting for the real one", async (t) => {
  const { i, root, inferId, peer } = await setup(t, [answer({ content: "done" })]);
  await send(i, "chat", { text: "hi", tree: root });
  await settle(i);
  const [loop] = await loops(i.store);
  const awaited = (await tipOf(i.store, loop)).awaits![0];

  // A chat naming nothing we sent: not a new conversation, not a reply — recorded.
  await send(i, "chat", { text: "stray", replyTo: encode({ nothing: 1 }).cid });
  // A stranger answering the infer the loop awaits: the sender is not the identity it was sealed to.
  const stranger = ephemeralWallet();
  const sk = (await stranger.getPublicKey({ identityKey: true })).publicKey;
  const forged = await seal(stranger, { recipient: { identityKey: i.identity, handle: "skein", domain: "localhost" }, body: dagCbor.encode({ replyTo: awaited, message: { role: "assistant", content: "forged" }, model: "x", ms: 1 }), created: iso(i.clock.now()) });
  await i.hub.as(sk).send({ recipient: i.identity, box: "completions", body: forged });
  // The owner answering it, which is also not whom it was sealed to.
  await send(i, "completions", { replyTo: awaited, error: "not you" });
  await settle(i);
  assert.equal((await loops(i.store)).length, 1);
  assert.equal(i.lines.filter((l) => l.includes("which no thread awaits from this sender; recorded, nothing runs")).length, 3);
  const log = await readLog(i.store);
  assert.deepEqual(log.slice(-3).map((x) => x.entry.box), ["chat", "completions", "completions"], "all three are in the log");
  let tip = await tipOf(i.store, loop);
  assert.ok(tip.awaits![0].equals(awaited), "still awaiting the real completion");

  // The real peer answers: woken.
  await peer.poll();
  await settle(i);
  tip = await tipOf(i.store, loop);
  const [s] = await answers(i);
  assert.equal(s.body.text, "done");
  assert.ok(tip.awaits![0].equals(s.cid));
  assert.equal(i.hub.pending(inferId, "infer").length, 0);
  await i.rt.stop();
  await replayMatches(i.store);
});

test("chat: an inference error is kept and answered to David; the thread awaits him", async (t) => {
  const { i, root, peer } = await setup(t, [{ status: 503, text: "overloaded" }]);
  await send(i, "chat", { text: "hi", tree: root });
  await settle(i);
  await peer.poll();
  await settle(i);
  const [loop] = await loops(i.store);
  const rs = await turns(i.store, loop);
  assert.deepEqual(rs.map((r) => r.role), ["system", "user", "error"]);
  assert.match(String(rs[2].error), /HTTP 503 overloaded/);
  const [s] = await answers(i);
  assert.match(String(s.body.text), /inference failed: .*503/);
  assert.ok((await tipOf(i.store, loop)).awaits![0].equals(s.cid));
  await i.rt.stop();
});

test("restart mid-turn: the runtime stops while the loop awaits the peer; a new runtime on the same store takes the completion; the peer restarted too, so it answers the next delta `missing` and the loop resends the whole conversation; replay needs no wallet", async (t) => {
  const { i, root, inferKey, peer, api } = await setup(t, [answer({ content: "", tool_calls: [toolCall("c1", "cat README")] }), answer({ content: "It says hello." })]);
  await send(i, "chat", { text: "read the readme", tree: root });
  await settle(i);
  await i.rt.stop();

  await peer.poll(); // the peer answers while the instance is down
  const b = await instance({ store: i.store, instanceKey: i.instanceKey, ownerKey: i.owner.key, hostKey: i.host.key, hub: i.hub, clock: i.clock });
  await settle(b);
  // A new peer process: nothing in memory, no cache. The delta names a parent it does not hold.
  const p2 = inferPeer(b, inferKey, (peer as unknown as { o: { fetch: typeof fetch } }).o.fetch);
  const [delta] = await inferBodies(b, inferKey);
  assert.deepEqual((delta.nodes as Json[]).map((n) => n.role), ["assistant", "tool"], "the delta: the completion's turn and the tool result");
  await p2.poll();
  assert.equal(api.requests.length, 1, "a missing node costs no engine call");
  await settle(b);
  const [loop] = await loops(b.store);
  const kept = await turns(b.store, loop);
  const note = kept.at(-1)!;
  assert.equal(note.kind, "missing");
  assert.ok((note.missing as CID[])[0].equals(delta.parent as CID), "the note names the node the peer lacked: the delta's parent");
  const [resend] = await inferBodies(b, inferKey);
  assert.equal(resend.parent, undefined, "the resend names no parent…");
  assert.deepEqual((resend.nodes as Json[]).map((n) => n.role), ["system", "user", "assistant", "tool"], "…and carries the whole conversation");
  await p2.poll();
  await settle(b);
  t.diagnostic(b.lines.join("\n"));
  const [s] = await answers(b);
  assert.equal(s.body.text, "It says hello.");
  assert.deepEqual((api.requests[1].messages as Json[]).map((m) => m.role), ["system", "user", "assistant", "tool"]);
  const rs = (await turns(b.store, loop)).filter((r) => r.kind === "turn");
  assert.deepEqual(rs.map((r) => r.role), ["system", "user", "assistant", "tool", "assistant"]);
  assert.equal(rs[3].stdout, "hello\n");
  await b.rt.stop();
  const sent = await replayMatches(b.store);
  assert.deepEqual(sent.map((o) => o.box), ["infer", "infer", "infer", "chat"], "the retry is an ordinary emit, replayed like the others");
});

// ---------------------------------------------------------------- the infer protocol (#12)

test("infer protocol: the first request carries the whole conversation; each later one only the turns since, naming the node they extend; every node chains to its parent by CID; the peer rebuilds the whole chat", async (t) => {
  const { i, root, inferKey, peer, api } = await setup(t, [
    answer({ content: "", tool_calls: [toolCall("c1", "ls")] }),
    answer({ content: "README and src." }),
    answer({ content: "Bye." }),
  ]);
  await send(i, "chat", { text: "what is here?", tree: root });
  await settle(i);
  const [first] = await inferBodies(i, inferKey);
  assert.equal(first.parent, undefined);
  assert.deepEqual((first.nodes as Json[]).map((n) => n.role), ["system", "user"]);
  assert.equal(first.model, "ripper/qwen38", "the genesis default");
  assert.equal(first.thinking, "off", "the genesis default");
  await peer.poll();
  await settle(i);
  const [second] = await inferBodies(i, inferKey);
  assert.deepEqual((second.nodes as Json[]).map((n) => n.role), ["assistant", "tool"]);
  const [loop] = await loops(i.store);
  const kept = await turns(i.store, loop);
  const cids = kept.map((r) => encode(r).cid);
  assert.ok((second.parent as CID).equals(cids[1]), "names the user turn: the last node of the first request");
  for (let n = 1; n < kept.length; n++) assert.ok((kept[n].parent as CID).equals(cids[n - 1]), `turn ${n} names turn ${n - 1}`);
  assert.equal(kept[0].parent, undefined, "the system turn is the root");
  await peer.poll();
  await settle(i);
  assert.deepEqual((api.requests[1].messages as Json[]).map((m) => m.role), ["system", "user", "assistant", "tool"], "the engine gets the whole chat");

  // The next user turn: the delta is the final answer and the new user turn.
  const [s] = await answers(i);
  await send(i, "chat", { text: "thanks", replyTo: s.cid });
  await settle(i);
  const [third] = await inferBodies(i, inferKey);
  assert.deepEqual((third.nodes as Json[]).map((n) => [n.role, n.text ?? n.content]), [["assistant", "README and src."], ["user", "thanks"]]);
  await peer.poll();
  assert.deepEqual((api.requests[2].messages as Json[]).map((m) => m.role), ["system", "user", "assistant", "tool", "assistant", "user"]);
  await settle(i);
  assert.equal((await answers(i)).at(-1)!.body.text, "Bye.");
  await i.rt.stop();
  await replayMatches(i.store);
});

test("infer protocol: model and thinking per request — from the chat that opened the turn, else the genesis defaults", async (t) => {
  const { i, root, inferKey, peer, api } = await setup(t, [answer({ content: "one" }), answer({ content: "two" })]);
  await send(i, "chat", { text: "think hard", tree: root, model: "ripper/big", thinking: "high" });
  await settle(i);
  const [first] = await inferBodies(i, inferKey);
  assert.deepEqual([first.model, first.thinking], ["ripper/big", "high"]);
  await peer.poll();
  assert.deepEqual([api.requests[0].model, api.requests[0].reasoning_effort, api.requests[0].chat_template_kwargs], ["big", "high", { enable_thinking: true }]);
  await settle(i);
  // The next chat names neither: back to the genesis defaults.
  const [s] = await answers(i);
  await send(i, "chat", { text: "and now?", replyTo: s.cid });
  await settle(i);
  const [second] = await inferBodies(i, inferKey);
  assert.deepEqual([second.model, second.thinking], ["ripper/qwen38", "off"]);
  await peer.poll();
  assert.deepEqual([api.requests[1].model, api.requests[1].reasoning_effort, api.requests[1].chat_template_kwargs], ["qwen38", undefined, { enable_thinking: false }]);
  const [loop] = await loops(i.store);
  const user = (await turns(i.store, loop)).find((r) => r.role === "user")!;
  assert.deepEqual([user.model, user.thinking], ["ripper/big", "high"], "the user turn keeps what the chat asked for");
  await settle(i);
  await i.rt.stop();
  await replayMatches(i.store);
});

test("infer protocol: `missing` again after the resend → an inference error answered to the opener (one retry only); `missing` to a first request, which carried everything, is an error at once", async (t) => {
  const { i, root, inferId, inferKey, peer } = await setup(t, [answer({ content: "", tool_calls: [toolCall("c1", "ls")] })]);
  await send(i, "chat", { text: "hi", tree: root });
  await settle(i);
  await peer.poll(); // a tool call; the loop runs it and sends the delta
  await settle(i);
  // A peer that has lost everything, for good: answer each request `missing` by hand.
  const reply = async () => {
    const [m] = i.hub.pending(inferId, "infer");
    const env = JSON.parse(m.body as string) as Envelope;
    await i.hub.as(inferId).ack([m.messageId]);
    const out = await seal(ephemeralWallet(inferKey), { recipient: { identityKey: i.identity, handle: "skein", domain: "localhost" }, body: dagCbor.encode({ replyTo: encode(signedPart(env)).cid, missing: [encode({ lost: 1 }).cid] }), created: iso(i.clock.now()) });
    await i.hub.as(inferId).send({ recipient: i.identity, box: "completions", body: out });
  };
  await reply();
  await settle(i);
  assert.equal(i.hub.pending(inferId, "infer").length, 1, "resent once");
  await reply();
  await settle(i);
  assert.equal(i.hub.pending(inferId, "infer").length, 0, "not twice");
  const [loop] = await loops(i.store);
  const kept = await turns(i.store, loop);
  assert.deepEqual(kept.map((r) => r.role ?? r.kind), ["system", "user", "assistant", "tool", "missing", "error"], i.lines.join("\n"));
  assert.match(String(kept[5].error), /missing 1 node\(s\) after the whole conversation was sent/);
  const [s] = await answers(i);
  assert.match(String(s.body.text), /^inference failed: the inference peer is missing/);

  // A new conversation: its first request carries everything, so `missing` is an error with no resend.
  await send(i, "chat", { text: "again" });
  await settle(i);
  await reply();
  await settle(i);
  assert.equal(i.hub.pending(inferId, "infer").length, 0, "no resend of a whole conversation");
  const second = (await loops(i.store)).find((l) => !l.equals(loop))!;
  assert.deepEqual((await turns(i.store, second)).map((r) => r.role ?? r.kind), ["system", "user", "error"]);
  await i.rt.stop();
  await replayMatches(i.store);
});

// ---------------------------------------------------------------- the prompt from the tree

test("prompt: a new conversation's system prompt is the tree's SOUL.md then IDENTITY.md, kept as a turn; continuing keeps it though the tree changes", async (t) => {
  const soul = "You are Martha, a careful archivist.\n";
  const identity = "name: Martha\nemoji: 📚\n";
  const { i, root, peer, api } = await setup(t, [
    answer({ content: "", tool_calls: [toolCall("c1", "echo 'You are someone else.' > SOUL.md; rm IDENTITY.md")] }),
    answer({ content: "Changed it." }),
    answer({ content: "Still Martha." }),
  ], { files: { "SOUL.md": soul, "IDENTITY.md": identity } });
  await send(i, "chat", { text: "who are you?" }); // no tree: main's
  await settle(i);
  await peer.poll();
  await settle(i);
  await peer.poll();
  await settle(i);
  const expected = "You are Martha, a careful archivist.\n\nname: Martha\nemoji: 📚\n";
  const sys = (n: number) => (api.requests[n].messages as Json[])[0];
  assert.deepEqual(sys(0), { role: "system", content: expected });
  assert.deepEqual(sys(1), { role: "system", content: expected });
  const [loop] = await loops(i.store);
  const [kept] = await turns(i.store, loop);
  assert.equal(kept.role, "system");
  assert.equal(kept.content, expected);
  assert.ok((kept.of as CID).equals(root), "the prompt names the tree it was read from");

  // David continues after the tree lost its SOUL.md: the conversation keeps its prompt.
  const [s1] = await answers(i);
  assert.ok(!(s1.body.tree as CID).equals(root));
  await send(i, "chat", { text: "and now?", replyTo: s1.cid });
  await settle(i);
  await peer.poll();
  await settle(i);
  assert.deepEqual(sys(2), { role: "system", content: expected });
  assert.equal((await turns(i.store, loop)).filter((r) => r.role === "system").length, 1);
  await i.rt.stop();
  await replayMatches(i.store);
});

test("prompt: a chat naming a tree without SOUL.md gets the fixed prompt (IDENTITY.md alone is appended to it)", async (t) => {
  const { i, peer, api } = await setup(t, [answer({ content: "hi" }), answer({ content: "hi" })], { files: { "SOUL.md": "Soul.\n" } });
  // A tree with only IDENTITY.md: the fixed prompt, then it.
  const other = await fs.mkdtemp(join(tmpdir(), "skein-chat-"));
  t.after(() => fs.rm(other, { recursive: true, force: true }));
  await fs.writeFile(join(other, "IDENTITY.md"), "name: Nobody\n");
  const { root: idOnly, bundles } = await bundlesOf(other);
  for (const b of bundles) await send(i, "objects", b);
  await settle(i);
  await send(i, "chat", { text: "hello", tree: idOnly });
  await settle(i);
  await peer.poll();
  assert.equal((api.requests[0].messages as Json[])[0].content, `${DEFAULT_PROMPT}\n\nname: Nobody\n`);
  // The main tree has SOUL.md; a new conversation from it uses it.
  await send(i, "chat", { text: "hello again" });
  await settle(i);
  await peer.poll();
  assert.equal((api.requests[1].messages as Json[])[0].content, "Soul.\n");
  await settle(i);
  await i.rt.stop();
  await replayMatches(i.store);
});

test("prompt: a tree with SOUL.md, IDENTITY.md and ROSTER.md gets all three, in that order", async (t) => {
  const roster = "## Colleagues\n\n- @kurt@localhost — Kurt: Account manager.\n";
  const { i, peer, api } = await setup(t, [answer({ content: "hi" })], { files: { "SOUL.md": "You are Martha.\n\n\n", "IDENTITY.md": "- Name: Martha\n", "ROSTER.md": roster } });
  await send(i, "chat", { text: "who do you know?" });
  await settle(i);
  await peer.poll();
  assert.equal((api.requests[0].messages as Json[])[0].content, `You are Martha.\n\n- Name: Martha\n\n${roster}`);
  await settle(i);
  await i.rt.stop();
  await replayMatches(i.store);
});

// ---------------------------------------------------------------- the message tool: two instances

/** An instance on a shared hub and clock with its own scripted inference peer; `chat` open to anyone when `open`. */
async function agent(hub: Hub, clock: ReturnType<typeof scriptClock>, handle: string, answers: Json[], open = false) {
  const inferKey = PrivateKey.fromRandom();
  const inferId = inferKey.toPublicKey().toString();
  const i = await instance({
    hub, clock,
    config: {
      handle, peers: { infer: inferId },
      ...(open ? { subscriptions: [{ match: { box: "chat" }, handler: PROGRAM_CIDS.loop }] } : {}),
    },
  });
  const api = scripted(answers);
  return { i, api, peer: inferPeer(i, inferKey, api.fetch) };
}

test("message: the model messages another instance by handle; the loop sends `chat`, rests on the reply, and the other agent's `chat` reply is the tool result; a second message continues that conversation", async (t) => {
  const hub = messageBoxHub();
  const clock = scriptClock();
  const alice = await agent(hub, clock, "alice", [
    answer({ content: "", tool_calls: [toolCall("c1", "echo checked"), messageCall("m1", "@bob@localhost", "What is 2+2?")] }),
    answer({ content: "", tool_calls: [messageCall("m2", "bob@localhost", "And 2+3?")] }),
    answer({ content: "Bob says 4 and 5." }),
  ]);
  const bob = await agent(hub, clock, "bob", [answer({ content: "4" }), answer({ content: "5" })], true);
  const directory: Record<string, string> = { "bob@localhost": bob.i.identity };
  alice.i.rt.resolver = { resolve: async (h, d) => directory[`${h}@${d}`] ? { identityKey: directory[`${h}@${d}`] } : Promise.reject(new Error("unknown handle")) };
  const both = async () => { await settle(alice.i); await settle(bob.i); await settle(alice.i); };

  await send(alice.i, "chat", { text: "ask bob" });
  await settle(alice.i);
  await alice.peer.poll(); // bash, then message
  await both();
  const [aloop] = await loops(alice.i.store);
  let tip = await tipOf(alice.i.store, aloop);
  assert.equal(tip.state, "waiting");
  assert.equal(hub.pending(bob.i.identity, "chat").length, 0, "bob's delivery collected the chat");
  const [bloop] = await loops(bob.i.store);
  assert.ok(bloop, alice.i.lines.concat(bob.i.lines).join("\n"));
  const bturns = await turns(bob.i.store, bloop);
  assert.deepEqual(bturns.map((r) => r.role), ["system", "user"]);
  assert.equal(bturns[0].content, DEFAULT_PROMPT, "bob has no main tree: the fixed prompt");
  assert.equal(bturns[1].text, "What is 2+2?");
  assert.equal(bturns[1].tree, undefined, "no tree crosses instances");
  const chatEnv = bturns[1].of as CID;
  assert.ok(tip.awaits![0].equals(chatEnv), "alice rests on the chat she sent bob");

  // Bob's model answers; bob replies to alice's chat (her `chat` box); it resumes her thread, not a new one.
  await bob.peer.poll();
  await both();
  await alice.peer.poll(); // her second infer: the answer is another message to bob
  assert.ok(alice.i.lines.some((l) => l.includes(" in chat from ") && l.includes(`reply to ${fmt(chatEnv).slice(-8)} → ${fmt(aloop).slice(-8)}`)), alice.i.lines.join("\n"));
  assert.equal((await loops(alice.i.store)).length, 1, "bob's reply in alice's `chat` box is matched before her chat subscription");
  const second = alice.api.requests[1].messages as Json[];
  assert.deepEqual(second.map((m) => m.role), ["system", "user", "assistant", "tool", "tool"]);
  assert.deepEqual([second[3].tool_call_id, second[3].content], ["c1", "exit 0\nchecked\n"]);
  assert.deepEqual([second[4].tool_call_id, second[4].content], ["m1", "4"]);
  const tools = (alice.api.requests[0].tools as Json[]).map((x) => (x.function as Json).name);
  assert.deepEqual(tools, ["bash", "message"]);

  // The second message to bob replies to his answer: his conversation continues (one thread).
  await both();
  await bob.peer.poll();
  await both();
  assert.equal((await loops(bob.i.store)).length, 1, "bob's thread continued, no new conversation");
  assert.deepEqual((await turns(bob.i.store, bloop)).map((r) => r.role), ["system", "user", "assistant", "user", "assistant"]);
  await alice.peer.poll();
  await settle(alice.i);
  const [final] = await answers(alice.i);
  assert.equal(final.body.text, "Bob says 4 and 5.");

  const aturns = await turns(alice.i.store, aloop);
  const results = aturns.filter((r) => r.role === "tool" && r.to);
  assert.deepEqual(results.map((r) => [r.call, r.to, r.text]), [["m1", "@bob@localhost", "4"], ["m2", "@bob@localhost", "5"]]);
  assert.ok((results[0].sent as CID).equals(chatEnv), "`sent` names the chat alice sent");
  const bobSent = (await history(bob.i.store, bloop)).filter((u) => u.awaits).map((u) => u.awaits![0]);
  assert.ok((results[0].of as CID).equals(bobSent[1]), "`of` names bob's reply");

  // Replay, both instances, no wallet: alice's resolve and seals come from the record.
  await alice.i.rt.stop();
  await bob.i.rt.stop();
  const aSent = await replayMatches(alice.i.store);
  assert.deepEqual(aSent.map((o) => o.box), ["infer", "chat", "infer", "chat", "infer", "chat"]);
  const bSent = await replayMatches(bob.i.store);
  assert.deepEqual(bSent.map((o) => o.box), ["infer", "chat", "infer", "chat"]);
});

test("message: a handle that does not resolve, or bad arguments, is an error result; the loop asks the model again; replay needs no resolver", async (t) => {
  const hub = messageBoxHub();
  const alice = await agent(hub, scriptClock(), "alice", [
    answer({ content: "", tool_calls: [messageCall("m1", "@nobody@localhost", "hi"), messageCall("m2", "nobody", "hi")] }),
    answer({ content: "Nobody is there." }),
  ]);
  alice.i.rt.resolver = { resolve: async () => { throw new Error("unknown handle"); } };
  await send(alice.i, "chat", { text: "ask nobody" });
  await settle(alice.i);
  await alice.peer.poll();
  await settle(alice.i);
  await alice.peer.poll();
  await settle(alice.i);
  assert.equal(alice.api.requests.length, 2, alice.i.lines.join("\n"));
  const msgs = alice.api.requests[1].messages as Json[];
  assert.deepEqual(msgs.slice(3).map((m) => [m.tool_call_id, m.content]), [
    ["m1", "error: resolve: nobody@localhost did not resolve to an identity key"],
    ["m2", "error: message: `to` must be a handle, @handle@domain, not \"nobody\""],
  ]);
  assert.ok(alice.i.lines.some((l) => l.includes("resolve nobody@localhost: unknown handle")));
  assert.equal((await answers(alice.i))[0].body.text, "Nobody is there.");
  await alice.i.rt.stop();
  await replayMatches(alice.i.store);
});

test("message: a handle resolved through BRC-169 (the domain's manifest and resolve endpoint); the whole response is recorded; replay serves it with no network", async (t) => {
  const host = await brc169Host({ answers: { deggen: deggenResolution() } });
  const alice = await agent(messageBoxHub(), scriptClock(), "alice", [
    answer({ content: "", tool_calls: [messageCall("m1", "@deggen@lkup.net", "hi")] }),
  ]);
  alice.i.rt.resolver = { resolve: hostResolver(() => undefined, host.origin) };
  await send(alice.i, "chat", { text: "ask deggen" });
  await settle(alice.i);
  await alice.peer.poll();
  await settle(alice.i);
  await host.close(); // the network is gone for good
  const [aloop] = await loops(alice.i.store);
  const tip = await tipOf(alice.i.store, aloop) as ThreadUpdate & { calls: CID[]; emits: CID[] };
  assert.equal(tip.state, "waiting", alice.i.lines.join("\n"));
  const emit = await alice.i.store.get<Emit>(tip.emits[0]);
  assert.equal(emit.to, LKUP.deggen, "sealed to the key the domain's resolve endpoint answered");
  assert.deepEqual(emit.envelope.recipient, { handle: "deggen", domain: "lkup.net" });
  const calls = await Promise.all(tip.calls.map((c) => alice.i.store.get<Attested>(c)));
  const res = calls.find((a) => a.op === "resolve")!;
  assert.equal(Buffer.from(res.request as Uint8Array).toString(), "deggen@lkup.net");
  const recorded = dagCbor.decode(res.result) as Json;
  assert.deepEqual({ ...recorded, checked: undefined, unchecked: undefined, via: undefined }, { ...deggenResolution(), checked: undefined, unchecked: undefined, via: undefined }, "the whole response is the recorded answer");
  assert.deepEqual([recorded.via, recorded.unchecked], ["brc169", ["revocation"]]);
  await alice.i.rt.stop();
  const sent = await replayMatches(alice.i.store); // no wallet, no resolver, no network
  assert.deepEqual(sent.map((o) => [o.box, o.to]), [["infer", alice.i.rt.genesis!.peers!.infer], ["chat", LKUP.deggen]], "the same sends, the chat to deggen's recorded key");
});

test("message: two agents alternate on one thread each — Kurt's `message` back to Martha replies to her chat and resumes her waiting step; her next message resumes his; three exchanges; Martha answers the user with a `chat` reply", async (t) => {
  const hub = messageBoxHub();
  const clock = scriptClock();
  const martha = await agent(hub, clock, "martha", [
    answer({ content: "", tool_calls: [messageCall("m1", "@kurt@localhost", "What does the blue one cost?")] }),
    answer({ content: "", tool_calls: [messageCall("m2", "@kurt@localhost", "The large one.")] }),
    answer({ content: "", tool_calls: [messageCall("m3", "@kurt@localhost", "Thanks. And the red one?")] }),
    answer({ content: "Blue is 5, red is 6." }),
    answer({ content: "You're welcome." }),
  ]);
  const kurt = await agent(hub, clock, "kurt", [
    answer({ content: "", tool_calls: [messageCall("k1", "@martha@localhost", "Which size?")] }),
    answer({ content: "The large blue one is 5." }),
    answer({ content: "Red is 6." }),
  ], true);
  const directory: Record<string, string> = { "kurt@localhost": kurt.i.identity, "martha@localhost": martha.i.identity };
  const resolver = { resolve: async (h: string, d: string) => directory[`${h}@${d}`] ? { identityKey: directory[`${h}@${d}`] } : Promise.reject(new Error("unknown handle")) };
  martha.i.rt.resolver = resolver;
  kurt.i.rt.resolver = resolver;
  const counts = async () => [(await loops(martha.i.store)).length, (await loops(kurt.i.store)).length];
  /** Deliver and step both sides until neither inference peer has anything to answer. */
  const drive = async () => {
    for (;;) {
      await settle(martha.i); await settle(kurt.i); await settle(martha.i);
      if (await martha.peer.poll() + await kurt.peer.poll() === 0) return;
    }
  };

  const u1 = await send(martha.i, "chat", { text: "ask kurt about the blue one" });
  const u1Cid = encode(signedPart(u1)).cid;
  await drive();
  t.diagnostic(martha.i.lines.concat(kurt.i.lines).join("\n"));
  assert.deepEqual(await counts(), [1, 1], "one thread per side across three exchanges");
  const [mloop] = await loops(martha.i.store);
  const [kloop] = await loops(kurt.i.store);

  // Martha's side: three messages, each answered by Kurt; his first answer was his own `message`.
  const mturns = await turns(martha.i.store, mloop);
  assert.deepEqual(mturns.map((r) => r.role), ["system", "user", "assistant", "tool", "assistant", "tool", "assistant", "tool", "assistant"]);
  const mres = mturns.filter((r) => r.role === "tool");
  assert.deepEqual(mres.map((r) => [r.call, r.to, r.text]), [
    ["m1", "@kurt@localhost", "Which size?"],
    ["m2", "@kurt@localhost", "The large blue one is 5."],
    ["m3", "@kurt@localhost", "Red is 6."],
  ]);

  // Kurt's side: Martha's chat opened it; his `message` to her got her next message as its result; her third message is a user turn.
  const kturns = await turns(kurt.i.store, kloop);
  assert.deepEqual(kturns.map((r) => r.role), ["system", "user", "assistant", "tool", "assistant", "user", "assistant"]);
  assert.deepEqual([kturns[3].call, kturns[3].to, kturns[3].text], ["k1", "@martha@localhost", "The large one."]);
  assert.equal(kturns[5].text, "Thanks. And the red one?");

  // The envelopes chain pairwise: every chat after the first replies to the other side's latest.
  const body = async (store: Store, env: CID) => {
    const e = await readLog(store).then((l) => l.find((x) => x.entry.envelope?.equals(env))!);
    return await store.get(e.entry.body!) as Json;
  };
  const m1 = kturns[1].of as CID, k1 = mres[0].of as CID, m2 = kturns[3].of as CID, k2 = mres[1].of as CID, m3 = kturns[5].of as CID, k3 = mres[2].of as CID;
  assert.equal((await body(kurt.i.store, m1)).replyTo, undefined, "Martha's first message starts a conversation");
  assert.ok(((await body(martha.i.store, k1)).replyTo as CID).equals(m1), "Kurt's `message` to Martha replies to her chat");
  assert.ok(((await body(kurt.i.store, m2)).replyTo as CID).equals(k1));
  assert.ok(((await body(martha.i.store, k2)).replyTo as CID).equals(m2), "Kurt's answer replies to her latest");
  assert.ok(((await body(kurt.i.store, m3)).replyTo as CID).equals(k2));
  assert.ok(((await body(martha.i.store, k3)).replyTo as CID).equals(m3));
  const boxes = (await readLog(martha.i.store)).filter((x) => x.entry.envelope).map((x) => x.entry.box);
  assert.deepEqual(boxes, ["chat", "completions", "chat", "completions", "chat", "completions", "chat", "completions"], "Kurt's replies arrive in Martha's `chat` box");

  // Martha's answer to the user: a `chat` reply to the user's chat; Kurt rests on a reply to his last answer.
  const [final] = await answers(martha.i);
  assert.equal(final.body.text, "Blue is 5, red is 6.");
  assert.ok((final.body.replyTo as CID).equals(u1Cid));
  assert.ok((final.body.thread as CID).equals(mloop));
  assert.equal(hub.pending(kurt.i.owner.identity, "chat").length, 0, "Kurt answered Martha, not his owner");
  const ktip = await tipOf(kurt.i.store, kloop);
  assert.equal(ktip.state, "waiting");

  // The user's next chat replies to it and resumes the same thread.
  await send(martha.i, "chat", { text: "thanks", replyTo: final.cid });
  await drive();
  assert.deepEqual(await counts(), [1, 1]);
  const again = await answers(martha.i);
  assert.equal(again.at(-1)!.body.text, "You're welcome.");
  assert.equal((await turns(martha.i.store, mloop)).at(-2)!.text, "thanks");

  // Replay, both stores, no wallet.
  await martha.i.rt.stop();
  await kurt.i.rt.stop();
  const mSent = await replayMatches(martha.i.store);
  assert.deepEqual(mSent.map((o) => o.box), ["infer", "chat", "infer", "chat", "infer", "chat", "infer", "chat", "infer", "chat"]);
  const kSent = await replayMatches(kurt.i.store);
  assert.deepEqual(kSent.map((o) => o.box), ["infer", "chat", "infer", "chat", "infer", "chat"]);
});

// ---------------------------------------------------------------- delivery outcomes (#10)

test("outcome: a `message` the messagebox refuses for good (403, no account) → one `failed` entry; the waiting step resumes with an error result; the model is asked again; nothing is sent again; replay reproduces it", async (t) => {
  const bob = PrivateKey.fromRandom().toPublicKey().toString();
  const hub = faultyHub(messageBoxHub(), (m) => m.recipient === bob ? noAccount() : undefined);
  const alice = await agent(hub, scriptClock(), "alice", [
    answer({ content: "", tool_calls: [messageCall("m1", "@bob@localhost", "hi bob")] }),
    answer({ content: "Bob cannot be reached." }),
  ]);
  alice.i.rt.resolver = { resolve: async () => ({ identityKey: bob }) };
  await send(alice.i, "chat", { text: "ask bob" });
  await settle(alice.i);
  await alice.peer.poll();
  await settle(alice.i);
  const [aloop] = await loops(alice.i.store);

  // One outcome for the chat to bob: failed, with the messagebox's reason; tried once, never again.
  const outcomes = (await readLog(alice.i.store)).filter(({ entry }) => entry.outcome);
  const failed = outcomes.filter(({ entry }) => entry.outcome!.status === "failed");
  assert.equal(failed.length, 1, alice.i.lines.join("\n"));
  const emit = await alice.i.store.get<Emit>(failed[0].entry.outcome!.emit);
  assert.deepEqual([emit.box, emit.to], ["chat", bob]);
  assert.match(failed[0].entry.outcome!.reason!, /HTTP 403 \(ERR_ACCOUNT_REQUIRED\)/);
  assert.equal(hub.sent.get(bob), 1);
  assert.equal(alice.i.delivery.pending, 0, "a permanent refusal is not queued");
  await settle(alice.i);
  assert.equal(hub.sent.get(bob), 1, "no retry after `failed`");

  // The loop took the failure as the message's result and asked the model again.
  await alice.peer.poll();
  assert.equal(alice.api.requests.length, 2, alice.i.lines.join("\n"));
  const msgs = alice.api.requests[1].messages as Json[];
  assert.deepEqual([msgs.at(-1)!.role, msgs.at(-1)!.tool_call_id], ["tool", "m1"]);
  assert.equal(msgs.at(-1)!.content, "error: could not deliver to @bob@localhost: Message Box send failed with HTTP 403 (ERR_ACCOUNT_REQUIRED).");
  const tool = (await turns(alice.i.store, aloop)).find((r) => r.role === "tool")!;
  assert.ok((tool.of as CID).equals(failed[0].cid), "the tool turn is of the outcome entry");
  const resumed = (await history(alice.i.store, aloop)).find((u) => u.input!.equals(failed[0].cid));
  assert.ok(resumed, "a step driven by the outcome entry");
  await settle(alice.i);
  assert.equal((await answers(alice.i))[0].body.text, "Bob cannot be reached.");
  assert.ok(outcomes.filter(({ entry }) => entry.outcome!.status === "delivered").length >= 1, "the infer went out: delivered");

  // The explorer shows it on the entry and in the log.
  const page = (await render(alice.i.store, new URL(`/e/${failed[0].cid}`, "http://x"))).body;
  assert.match(page, /outcome/);
  assert.match(page, /class="st failed"/);
  assert.match(page, /ERR_ACCOUNT_REQUIRED/);

  await alice.i.rt.stop();
  const sent = await replayMatches(alice.i.store);
  assert.deepEqual(sent.map((o) => o.box), ["infer", "chat", "infer", "chat"], "replay steps through the failure from the log alone");
});

test("outcome: the `infer` refused → an inference error answered to the opener; the answer refused → noted, and the thread ends", async (t) => {
  // The inference peer has no account: the loop answers the owner with the failure.
  const inferKey = PrivateKey.fromRandom();
  const inferId = inferKey.toPublicKey().toString();
  const a = await instance({ hub: faultyHub(messageBoxHub(), (m) => m.recipient === inferId ? noAccount() : undefined), config: { peers: { infer: inferId } } });
  await send(a, "chat", { text: "hi" });
  await settle(a);
  await settle(a);
  const [la] = await loops(a.store);
  const ra = await turns(a.store, la);
  assert.deepEqual(ra.map((r) => r.role), ["system", "user", "error"], a.lines.join("\n"));
  assert.match(String(ra[2].error), /^could not deliver to the inference peer: .*ERR_ACCOUNT_REQUIRED/);
  const [ans] = await answers(a);
  assert.match(String(ans.body.text), /^inference failed: could not deliver to the inference peer/);
  assert.equal((await tipOf(a.store, la)).state, "waiting", "the answer went out: the thread awaits the owner");

  // No inference peer, and the owner has no account: the answer fails; the thread notes it and finishes.
  let owner = "";
  const b = await instance({ hub: faultyHub(messageBoxHub(), (m) => m.recipient === owner ? noAccount() : undefined) });
  owner = b.owner.identity;
  await send(b, "chat", { text: "hi" });
  await settle(b);
  const [lb] = await loops(b.store);
  const rb = await turns(b.store, lb);
  assert.deepEqual(rb.map((r) => r.role), ["system", "user", "error"], b.lines.join("\n"));
  assert.match(String(rb[2].error), /^could not deliver the answer: .*ERR_ACCOUNT_REQUIRED/);
  const tip = await tipOf(b.store, lb);
  assert.equal(tip.state, "finished", "nothing left to wait for");
  assert.equal(tip.awaits, undefined);
  await a.rt.stop();
  await b.rt.stop();
  await replayMatches(a.store);
  await replayMatches(b.store);
});

test("outcome: a program that does not list \"outcomes\" among its services (a loop from before them) is not resumed by a failure; it keeps waiting", async (t) => {
  let owner = "";
  const i = await instance({ hub: faultyHub(messageBoxHub(), (m) => m.recipient === owner ? noAccount() : undefined) });
  owner = i.owner.identity;
  const old = { ...LOOP, services: ["infer"] };
  const handler = await i.store.put(old);
  await i.rt.idle();
  const { subscribe } = await import("./subscriptions.ts");
  await subscribe(i.store, { op: "add", box: "oldchat", handler }, { input: (await i.store.log.tip())!, at: 0 });
  await send(i, "oldchat", { text: "hi" });
  await settle(i);
  const [th] = await collect(i.store.edges.query({ kind: "thread", program: handler }));
  assert.ok(th, i.lines.join("\n"));
  const tip = await tipOf(i.store, th);
  assert.equal(tip.state, "waiting", "still waiting on the answer it could not deliver");
  assert.ok(i.lines.some((l) => /outcome failed .* loop does not take delivery failures/.test(l)), i.lines.join("\n"));
  assert.equal((await turns(i.store, th)).at(-1)!.role, "user", "no step ran on the failure");
  await i.rt.stop();
});

// The chat step end to end, in process: David's `chat` → the loop program →
// `infer` to the inference peer (the real InferPeer over a scripted fetch) →
// a completion with a bash tool call → the shell → the tool result kept →
// a second `infer` → a plain answer → `say` to David, awaiting his reply → his
// reply (correlated by `replyTo`, not by subscription) → the next step. Then:
// stray replies, a restart mid-turn, and replay with no wallet.

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
import { bundlesOf, collect, installWasm, instance, iso, send, type Hub, type Instance } from "../testkit.ts";
import { ephemeralWallet } from "../wallet.ts";
import { encode, fmt } from "./cid.ts";
import { headTree, MAIN } from "./heads.ts";
import { copyLog, readLog, stampMs } from "./log.ts";
import { memoryStore } from "./memory.ts";
import { PROGRAM_CIDS } from "./programs.ts";
import { Runtime, witnessFrom, type Outbound } from "./scheduler.ts";
import type { Store } from "./store.ts";
import type { ThreadUpdate } from "./types.ts";

type Json = Record<string, unknown>;

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
const answer = (message: Json) => ({ choices: [{ message: { role: "assistant", ...message } }], usage: { prompt_tokens: 10, completion_tokens: 5 }, model: "qwen38" });

async function setup(t: { after(fn: () => Promise<void>): void }, answers: Array<Json | { status: number; text: string }>, o: { hub?: Hub } = {}) {
  const dir = await fs.mkdtemp(join(tmpdir(), "skein-chat-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(join(dir, "src"));
  await fs.writeFile(join(dir, "src/a.txt"), "alpha\n");
  await fs.writeFile(join(dir, "README"), "hello\n");
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

async function settle(i: Instance) { await i.edge.poll(); await i.rt.idle(); }

async function loops(store: Store): Promise<CID[]> {
  return collect(store.edges.query({ kind: "thread", program: PROGRAM_CIDS.loop }));
}
async function history(store: Store, th: CID): Promise<Array<ThreadUpdate & Json>> {
  const out: Array<ThreadUpdate & Json> = [];
  for await (const c of store.chains.history(th)) if (!c.equals(th)) out.push(await store.get(c) as ThreadUpdate & Json);
  return out;
}
const tipOf = async (store: Store, th: CID) => store.get<ThreadUpdate>(await store.chains.tip(th));

/** What David finds in his `say` box: verified, opened. */
async function says(i: Instance): Promise<Array<{ env: Envelope; cid: CID; body: Json }>> {
  const out = [];
  for (const m of i.hub.pending(i.owner.identity, "say")) {
    const env = JSON.parse(m.body as string) as Envelope;
    assert.ok(verify(env));
    out.push({ env, cid: encode(signedPart(env)).cid, body: dagCbor.decode((await open(i.owner.wallet, env)).body) as Json });
  }
  return out;
}

/** All turns a thread kept, in order. */
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

test("chat: a turn — infer, a bash tool call in the shell, infer again, say to David awaiting him; his reply continues the same thread", async (t) => {
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

  // `say` to David: the answer, the tree, the thread, replyTo his chat.
  const [s1] = await says(i);
  assert.equal(s1.body.text, "README and src.");
  assert.ok((s1.body.thread as CID).equals(loop));
  assert.ok((s1.body.replyTo as CID).equals(chatCid));
  assert.ok((s1.body.tree as CID).equals(root));
  tip = await tipOf(i.store, loop);
  assert.equal(tip.state, "waiting");
  assert.ok(tip.awaits![0].equals(s1.cid), "resting on David's reply to the say");

  const rs = await turns(i.store, loop);
  assert.deepEqual(rs.map((r) => r.role), ["user", "assistant", "tool", "assistant"]);
  assert.ok((rs[0].of as CID).equals(chatCid));
  assert.equal(rs[0].text, "What is here?");
  assert.equal((rs[1].tool_calls as Json[])[0].id, "call-1");
  assert.deepEqual([rs[2].call, rs[2].exitCode, rs[2].stdout, rs[2].stderr], ["call-1", 0, "README\nsrc\n", ""]);
  assert.equal(rs[3].reasoning, "short");
  const steps = await history(i.store, loop);
  assert.deepEqual(steps.map((u) => u.state), ["waiting", "waiting", "waiting", "waiting"]);
  assert.ok(steps[1].waitingOn && !steps[1].awaits, "the tool step waits on the shell, not a reply");

  // David replies to the say: delivered to the same thread (no new loop), a new turn.
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
  const all = await says(i);
  assert.equal(all.length, 2);
  assert.equal(all[1].body.text, "You're welcome.");
  assert.ok((all[1].body.replyTo as CID).equals(encode(signedPart(reply)).cid), "the second say answers the reply");

  // Every entry the correlation used is signed; replay with no wallet reproduces every thread.
  await i.rt.stop();
  const sent = await replayMatches(i.store);
  assert.deepEqual(sent.map((o) => o.box), ["infer", "infer", "say", "infer", "say"]);
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
  const rs = await turns(i.store, loop);
  assert.deepEqual(rs.map((r) => r.role), ["user", "assistant", "tool", "assistant"]);
  assert.ok((rs[0].tree as CID).equals(root), "the opening turn records main's tree");
  assert.equal(rs[2].stdout, "hello\n");
  const [s] = await says(i);
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
  const [s] = await says(i);
  assert.equal(s.body.text, "done");
  assert.ok(tip.awaits![0].equals(s.cid));
  assert.equal(i.hub.pending(inferId, "infer").length, 0);
  await i.rt.stop();
  await replayMatches(i.store);
});

test("chat: an inference error is kept and said to David; the thread awaits him", async (t) => {
  const { i, root, peer } = await setup(t, [{ status: 503, text: "overloaded" }]);
  await send(i, "chat", { text: "hi", tree: root });
  await settle(i);
  await peer.poll();
  await settle(i);
  const [loop] = await loops(i.store);
  const rs = await turns(i.store, loop);
  assert.deepEqual(rs.map((r) => r.role), ["user", "error"]);
  assert.match(String(rs[1].error), /HTTP 503 overloaded/);
  const [s] = await says(i);
  assert.match(String(s.body.text), /inference failed: .*503/);
  assert.ok((await tipOf(i.store, loop)).awaits![0].equals(s.cid));
  await i.rt.stop();
});

test("restart mid-turn: the runtime stops while the loop awaits the peer; a new runtime on the same store takes the completion; replay needs no wallet", async (t) => {
  const { i, root, inferKey, peer } = await setup(t, [answer({ content: "", tool_calls: [toolCall("c1", "cat README")] }), answer({ content: "It says hello." })]);
  await send(i, "chat", { text: "read the readme", tree: root });
  await settle(i);
  await i.rt.stop();

  await peer.poll(); // the peer answers while the instance is down
  const b = await instance({ store: i.store, instanceKey: i.instanceKey, ownerKey: i.owner.key, hostKey: i.host.key, hub: i.hub, clock: i.clock });
  await settle(b);
  const p2 = inferPeer(b, inferKey, (peer as unknown as { o: { fetch: typeof fetch } }).o.fetch);
  await p2.poll();
  await settle(b);
  t.diagnostic(b.lines.join("\n"));
  const [s] = await says(b);
  assert.equal(s.body.text, "It says hello.");
  const [loop] = await loops(b.store);
  const rs = await turns(b.store, loop);
  assert.deepEqual(rs.map((r) => r.role), ["user", "assistant", "tool", "assistant"]);
  assert.equal(rs[2].stdout, "hello\n");
  await b.rt.stop();
  await replayMatches(b.store);
});

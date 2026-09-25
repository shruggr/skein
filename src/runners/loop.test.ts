import { test } from "node:test";
import assert from "node:assert/strict";
import type { CID } from "multiformats/cid";
import { memoryStore } from "../memory.ts";
import { Scheduler } from "../scheduler.ts";
import type { Store } from "../store.ts";
import type { NodeUpdate, ThreadOrigin } from "../types.ts";
import type { Config } from "../config.ts";
import { davidRunner, resolveDavid } from "./david.ts";
import { loopRunner, type LoopSpec } from "./loop.ts";
import { modelRunner, type ChatMessage } from "./model.ts";
import { shellRunner } from "./shell.ts";
import { emitsOf, field, nodesOf, nodeView, openNode, tipOf } from "./util.ts";
import { collect, delta, drive, fakeModel, openThread, toolCall, usage } from "../testkit.ts";

const config: Config = { providers: { fake: { baseUrl: "http://fake/v1", apiKey: "sekrit" } } };

const spec: LoopSpec = {
  system: "You are terse.",
  model: "fake/qwen38",
  thinking: "off",
  tools: ["bash", "say", "page"],
  prompt: "What does echo hi print?",
};

function setup(scripts: Parameters<typeof fakeModel>[0]) {
  const store = memoryStore();
  const fake = fakeModel(scripts);
  const lines: string[] = [];
  const sched = new Scheduler(store, [loopRunner(), modelRunner({ config, fetch: fake.fetch }), shellRunner(), davidRunner()], {
    log: (l) => lines.push(l),
  });
  return { store, fake, sched, lines };
}

const waitingDavid = (store: Store): Promise<CID[]> => collect(store.live.resting({ runner: "david", state: ["waiting"] }));
const runnerOf = async (store: Store, t: CID) => (await store.get<ThreadOrigin>(t)).runner;
const labels = (emits: Awaited<ReturnType<typeof nodeView>>["emits"]) =>
  emits.map((e) => `${e.type}${field(e, "label") ? `:${field(e, "label")}` : ""}`);

/** MODEL.md: rest closes the node — every step rests exactly once. */
async function assertOneRestEach(store: Store, nodes: CID[]) {
  for (const n of nodes) {
    let rests = 0;
    for await (const c of store.chains.history(n)) if (!c.equals(n) && (await store.get<NodeUpdate>(c)).rest) rests++;
    assert.equal(rests, 1, `node ${n} rested ${rests} times`);
  }
}

test("loop: bash tool call, then say, then David's reply starts the next step", async () => {
  const { store, fake, sched, lines } = setup([
    [delta({ reasoning_content: "use bash" }), ...toolCall("c1", "bash", { command: "echo hi" }), usage(50, 10)],
    [...toolCall("c2", "say", { text: "It prints hi." }), usage(80, 8)],
    [delta({ content: "Glad to help." }, "stop")],
  ]);
  const loop = await openThread(store, "loop", spec);
  await drive(sched, async () => (await waitingDavid(store)).length === 1);

  // step 1: launched model → launched shell → rests waiting on it
  const [s1, s2] = await nodesOf(store, loop);
  const v1 = await nodeView(store, s1);
  assert.deepEqual(labels(v1.emits), ["launched:model", "launched:bash"]);
  const shell = emitsOf(v1.emits, "launched")[1];
  assert.equal(await runnerOf(store, shell.thread), "shell");
  assert.equal(shell.call, "c1");
  assert.equal(v1.rest?.state, "waiting");
  assert.deepEqual(v1.rest?.waitingOn?.map(String), [String(shell.thread)]);
  assert.deepEqual((v1.origin.request as { messages: ChatMessage[] }).messages, [
    { role: "system", content: "You are terse." },
    { role: "user", content: "What does echo hi print?" },
  ]);

  // step 2 carries the tool result (request + emission before its model call), then says → david thread
  const v2 = await nodeView(store, s2);
  assert.deepEqual(v2.origin.prev.map(String), [String(s1)]);
  const r2 = v2.origin.request as { messages: ChatMessage[]; results: Array<{ call: string; thread: CID; ok: boolean }> };
  assert.deepEqual(r2.messages.slice(2), [
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"echo hi"}' } }] },
    { role: "tool", tool_call_id: "c1", content: "hi\n[exit 0]" },
  ]);
  assert.deepEqual(r2.results, [{ call: "c1", thread: shell.thread, ok: true }]);
  assert.deepEqual(fake.requests[1].body.messages, r2.messages);
  assert.deepEqual(labels(v2.emits), ["tool_result", "launched:model", "say", "launched:david"]);
  assert.deepEqual(v2.emits[0], { type: "tool_result", thread: shell.thread, ok: true, content: "hi\n[exit 0]", call: "c1" });
  assert.deepEqual(v2.emits[2], { type: "say", text: "It prints hi.", call: "c2" });
  assert.equal(v2.rest?.state, "finished");
  const [david] = await waitingDavid(store);
  assert.ok(emitsOf(v2.emits, "launched")[1].thread.equals(david));
  assert.deepEqual((await store.get<ThreadOrigin>(david)).spec, { say: "It prints hi." });
  assert.ok((await store.get<ThreadOrigin>(david)).launchedBy!.equals(s2));

  const lt = (await tipOf(store, loop))!;
  assert.equal(lt.state, "waiting");
  assert.deepEqual(lt.waitingOn!.map(String), [String(david)]);

  // Ticking while David is silent changes nothing.
  const before = String(await store.chains.tip(loop));
  await sched.tick();
  assert.equal(String(await store.chains.tip(loop)), before);

  // step 3: David replies; the loop resumes from the tip.
  const reply = await resolveDavid(store, david, { text: "Thanks." });
  await drive(sched, async () => (await waitingDavid(store)).length === 1 && (await nodesOf(store, loop)).length === 3);
  const s3 = (await nodesOf(store, loop))[2];
  const v3 = await nodeView(store, s3);
  assert.deepEqual(v3.origin.prev.map(String), [String(s2)]);
  assert.ok(v3.origin.refs.some((r) => r.rel === "about" && String(r.to) === String(reply)));
  const m3 = (v3.origin.request as { messages: ChatMessage[] }).messages;
  assert.deepEqual(m3.slice(-2), [
    { role: "tool", tool_call_id: "c2", content: "Delivered to David." },
    { role: "user", content: "Thanks." },
  ]);
  // Plain text with no tool calls ends the turn as a say.
  assert.deepEqual(v3.emits.map((e) => e.type), ["launched", "text", "launched"]);
  const [david2] = await waitingDavid(store);
  assert.deepEqual((await store.get<ThreadOrigin>(david2)).spec, { say: "Glad to help." });
  assert.equal(fake.requests.length, 3);
  assert.ok(lines.some((l) => /loop new → waiting/.test(l)));
  await assertOneRestEach(store, [s1, s2, s3]);
  // Endpoints and keys stay in config.
  for (const t of [loop, emitsOf(v1.emits, "launched")[0].thread]) assert.doesNotMatch(JSON.stringify(await store.get(t)), /sekrit|fake\/v1/);
});

test("loop: a subagent (launchedBy set) resolves to its caller, never to David", async () => {
  const { store, fake, sched } = setup([
    [...toolCall("c1", "bash", { command: "echo sub" })],
    [delta({ content: "It printed sub." }, "stop")],
  ]);
  // The caller: some other thread's step. Its runner isn't registered; only the edge matters.
  const caller = await openThread(store, "caller", {});
  const callerStep = await openNode(store, { thread: caller, prev: [], request: "delegate" });
  const loop = await openThread(store, "loop", { ...spec, prompt: "Run echo sub and report." }, callerStep);
  await drive(sched, async () => (await tipOf(store, loop))?.state === "finished");

  const [s1, s2] = await nodesOf(store, loop);
  const tip = (await tipOf(store, loop))!;
  assert.ok(tip.resolution!.equals(s2));
  const v2 = await nodeView(store, s2);
  assert.deepEqual(v2.emits.map((e) => e.type), ["tool_result", "launched", "text", "conclusion"]);
  assert.deepEqual(v2.emits.at(-1), { type: "conclusion", text: "It printed sub." });
  assert.equal(v2.rest?.state, "finished");
  assert.deepEqual(await collect(store.edges.query({ runner: "david" })), []);
  assert.equal(fake.requests.length, 2);
  await assertOneRestEach(store, [s1, s2]);
});

test("loop: a model thread that blows up is retried once, then the loop errors", async () => {
  const { store, fake, sched } = setup([new Response("down", { status: 502 }), new Response("still down", { status: 502 })]);
  const loop = await openThread(store, "loop", spec);
  await drive(sched, async () => (await tipOf(store, loop))?.state === "errored");
  const tip = (await tipOf(store, loop))!;
  assert.equal(tip.error?.kind, "blew-up");
  assert.match(tip.error!.message, /2 attempt/);
  assert.equal(fake.requests.length, 2);
  const [s1] = await nodesOf(store, loop);
  assert.deepEqual(labels((await nodeView(store, s1)).emits), ["launched:model", "launched:model"]);
  await assertOneRestEach(store, [s1]);
});

test("loop: unknown tools and failing commands come back as tool results, and the loop continues", async () => {
  const { store, fake, sched } = setup([
    [...toolCall("c1", "rm_rf", {}, 0), ...toolCall("c2", "bash", { command: "echo nope >&2; exit 2" }, 1)],
    [...toolCall("c3", "page", { markdown: "# Done", say: "See page." })],
  ]);
  const loop = await openThread(store, "loop", spec);
  await drive(sched, async () => (await waitingDavid(store)).length === 1);
  const m2 = fake.requests[1].body.messages as ChatMessage[];
  assert.deepEqual(m2.slice(-2), [
    { role: "tool", tool_call_id: "c1", content: "unknown tool: rm_rf" },
    { role: "tool", tool_call_id: "c2", content: "nope\n[exit 2]" },
  ]);
  const [david] = await waitingDavid(store);
  assert.deepEqual((await store.get<ThreadOrigin>(david)).spec, { say: "See page.", page: "# Done" });
  const [s1, s2] = await nodesOf(store, loop);
  const v2 = await nodeView(store, s2);
  assert.deepEqual(v2.emits.map((e) => e.type), ["tool_result", "tool_result", "launched", "say", "page", "launched"]);
  assert.deepEqual(emitsOf(v2.emits, "tool_result").map((e) => [e.call, e.ok]), [["c1", false], ["c2", false]]);
  await assertOneRestEach(store, [s1, s2]);
});

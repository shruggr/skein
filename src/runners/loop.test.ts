import { test } from "node:test";
import assert from "node:assert/strict";
import type { CID } from "multiformats/cid";
import { memoryStore } from "../memory.ts";
import { Scheduler } from "../scheduler.ts";
import type { Store } from "../store.ts";
import type { ThreadOrigin } from "../types.ts";
import { davidRunner, resolveDavid } from "./david.ts";
import { loopRunner, type LoopSpec } from "./loop.ts";
import { modelRunner, type ChatMessage } from "./model.ts";
import { shellRunner } from "./shell.ts";
import { field, nodesOf, nodeView, tipOf } from "./util.ts";
import { collect, delta, drive, fakeModel, openThread, toolCall, usage } from "../testkit.ts";

const spec: LoopSpec = {
  system: "You are terse.",
  model: { baseUrl: "http://fake/v1", model: "qwen38", thinking: "off" },
  tools: ["bash", "say", "page"],
  prompt: "What does echo hi print?",
};

async function waitingDavid(store: Store): Promise<CID[]> {
  return collect(store.live.resting({ runner: "david", state: ["waiting"] }));
}

const runnerOf = async (store: Store, t: CID) => (await store.get<ThreadOrigin>(t)).runner;

test("loop: bash tool call, then say, then David's reply starts the next step", async () => {
  const store = memoryStore();
  const fake = fakeModel([
    [delta({ reasoning_content: "use bash" }), ...toolCall("c1", "bash", { command: "echo hi" }), usage(50, 10)],
    [...toolCall("c2", "say", { text: "It prints hi." }), usage(80, 8)],
    [delta({ content: "Glad to help." }, "stop")],
  ]);
  const lines: string[] = [];
  const sched = new Scheduler(store, [
    loopRunner(),
    modelRunner({ fetch: fake.fetch }),
    shellRunner(),
    davidRunner(),
  ], { log: (l) => lines.push(l) });

  const loop = await openThread(store, "loop", spec);
  await drive(sched, async () => (await waitingDavid(store)).length === 1);

  // step 1: launched model → launched shell → tool_result
  const [s1, s2] = await nodesOf(store, loop);
  const v1 = await nodeView(store, s1);
  assert.deepEqual(v1.emits.map((e) => `${e.type}${field(e, "label") ? `:${field(e, "label")}` : ""}`), [
    "launched:model", "launched:bash", "tool_result",
  ]);
  assert.equal(await runnerOf(store, field(v1.emits[1], "thread") as CID), "shell");
  assert.equal(field(v1.emits[1], "call"), "c1");
  assert.deepEqual(v1.emits[2], { type: "tool_result", thread: field(v1.emits[1], "thread"), ok: true, content: "hi\n[exit 0]", call: "c1" });
  assert.equal(v1.rest?.state, "finished");
  assert.deepEqual((v1.origin.request as { messages: ChatMessage[] }).messages, [
    { role: "system", content: "You are terse." },
    { role: "user", content: "What does echo hi print?" },
  ]);

  // step 2: its request carries the tool result; it says, which launches a david thread
  const v2 = await nodeView(store, s2);
  assert.deepEqual(v2.origin.prev.map(String), [String(s1)]);
  const m2 = (v2.origin.request as { messages: ChatMessage[] }).messages;
  assert.deepEqual(m2.slice(2), [
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"echo hi"}' } }] },
    { role: "tool", tool_call_id: "c1", content: "hi\n[exit 0]" },
  ]);
  assert.deepEqual(fake.requests[1].body.messages, m2);
  assert.deepEqual(v2.emits.map((e) => e.type), ["launched", "say", "launched"]);
  assert.equal(field(v2.emits[1], "text"), "It prints hi.");
  const [david] = await waitingDavid(store);
  assert.ok((field(v2.emits[2], "thread") as CID).equals(david));
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
});

test("loop: a model thread that blows up is retried once, then the loop errors", async () => {
  const store = memoryStore();
  const fake = fakeModel([new Response("down", { status: 502 }), new Response("still down", { status: 502 })]);
  const sched = new Scheduler(store, [loopRunner(), modelRunner({ fetch: fake.fetch }), davidRunner()], { log: () => {} });
  const loop = await openThread(store, "loop", spec);
  await drive(sched, async () => (await tipOf(store, loop))?.state === "errored");
  const tip = (await tipOf(store, loop))!;
  assert.equal(tip.error?.kind, "blew-up");
  assert.match(tip.error!.message, /2 attempt/);
  assert.equal(fake.requests.length, 2);
  const [s1] = await nodesOf(store, loop);
  assert.deepEqual((await nodeView(store, s1)).emits.map((e) => field(e, "label")), ["model", "model"]);
});

test("loop: unknown tools and failing commands come back as tool results, and the loop continues", async () => {
  const store = memoryStore();
  const fake = fakeModel([
    [...toolCall("c1", "rm_rf", {}, 0), ...toolCall("c2", "bash", { command: "echo nope >&2; exit 2" }, 1)],
    [...toolCall("c3", "page", { markdown: "# Done", say: "See page." })],
  ]);
  const sched = new Scheduler(store, [loopRunner(), modelRunner({ fetch: fake.fetch }), shellRunner(), davidRunner()], { log: () => {} });
  const loop = await openThread(store, "loop", spec);
  await drive(sched, async () => (await waitingDavid(store)).length === 1);
  const m2 = fake.requests[1].body.messages as ChatMessage[];
  assert.deepEqual(m2.slice(-2), [
    { role: "tool", tool_call_id: "c1", content: "unknown tool: rm_rf" },
    { role: "tool", tool_call_id: "c2", content: "nope\n[exit 2]" },
  ]);
  const [david] = await waitingDavid(store);
  assert.deepEqual((await store.get<ThreadOrigin>(david)).spec, { say: "See page.", page: "# Done" });
  const s2 = (await nodesOf(store, loop))[1];
  assert.deepEqual((await nodeView(store, s2)).emits.map((e) => e.type), ["launched", "say", "page", "launched"]);
});

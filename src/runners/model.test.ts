import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryStore } from "../memory.ts";
import { Scheduler } from "../scheduler.ts";
import { modelRunner, type ModelSpec } from "./model.ts";
import { isSettled, nodeView, tipOf } from "./util.ts";
import { delta, drive, fakeModel, openThread, toolCall, usage } from "../testkit.ts";

const spec = (extra: Partial<ModelSpec> = {}): ModelSpec => ({
  baseUrl: "http://fake/v1/",
  model: "qwen38",
  apiKey: "k",
  messages: [{ role: "user", content: "hi" }],
  ...extra,
});

test("model: streams thinking and text, concludes with the assistant message", async () => {
  const store = memoryStore();
  const fake = fakeModel([[
    delta({ role: "assistant", content: "" }),
    delta({ reasoning_content: "let me " }),
    delta({ reasoning_content: "think" }),
    delta({ content: "Running " }),
    delta({ content: "it." }),
    ...toolCall("call_a", "bash", { command: "echo hi" }),
    usage(12, 34),
  ]]);
  const sched = new Scheduler(store, [modelRunner({ fetch: fake.fetch, flushMs: 60_000 })], { log: () => {} });
  const t = await openThread(store, "model", spec({ thinking: "off", tools: [{ type: "function", function: { name: "bash", parameters: {} } }] }));
  await drive(sched, async () => isSettled((await tipOf(store, t))?.state));

  const req = fake.requests[0];
  assert.equal(req.url, "http://fake/v1/chat/completions");
  assert.equal(req.headers.authorization, "Bearer k");
  assert.equal(req.body.stream, true);
  assert.deepEqual(req.body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(req.body.reasoning_effort, undefined);
  assert.equal(req.body.tools.length, 1);

  const tip = (await tipOf(store, t))!;
  assert.equal(tip.state, "finished");
  assert.match(tip.note!, /^qwen38 · 12 in \/ 34 out · \d+\.\ds$/);
  const v = await nodeView(store, tip.resolution!);
  assert.equal((v.origin.request as { apiKey?: string }).apiKey, undefined);
  assert.deepEqual(v.emits.slice(0, 2), [{ type: "thinking", text: "let me think" }, { type: "text", text: "Running it." }]);
  assert.deepEqual(JSON.parse((v.emits[2] as { text: string }).text), {
    role: "assistant",
    content: "Running it.",
    tool_calls: [{ id: "call_a", type: "function", function: { name: "bash", arguments: '{"command":"echo hi"}' } }],
  });
  assert.equal(v.rest?.state, "finished");
  assert.equal(await store.live.handles.get(t), undefined);
});

test("model: thinking level maps to reasoning_effort", async () => {
  const store = memoryStore();
  const fake = fakeModel([[delta({ content: "ok" }, "stop")]]);
  const sched = new Scheduler(store, [modelRunner({ fetch: fake.fetch })], { log: () => {} });
  const t = await openThread(store, "model", spec({ thinking: "high" }));
  await drive(sched, async () => isSettled((await tipOf(store, t))?.state));
  assert.equal(fake.requests[0].body.reasoning_effort, "high");
  assert.equal(fake.requests[0].body.chat_template_kwargs, undefined);
  assert.match((await tipOf(store, t))!.note!, /no usage/);
});

test("model: 4xx is cant-do, 5xx is blew-up", async () => {
  const store = memoryStore();
  const fake = fakeModel([new Response("bad", { status: 400 }), new Response("down", { status: 503 })]);
  const sched = new Scheduler(store, [modelRunner({ fetch: fake.fetch, maxConcurrent: 1 })], { log: () => {} });
  const a = await openThread(store, "model", spec());
  const b = await openThread(store, "model", spec({ model: "other" }));
  await drive(sched, async () => isSettled((await tipOf(store, a))?.state) && isSettled((await tipOf(store, b))?.state));
  assert.equal((await tipOf(store, a))!.error?.kind, "cant-do");
  assert.equal((await tipOf(store, b))!.error?.kind, "blew-up");
});

test("model: an in-flight request lost to a restart is errored blew-up", async () => {
  const store = memoryStore();
  const never = (async (_u: unknown, init?: RequestInit) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch;
  const first = new Scheduler(store, [modelRunner({ fetch: never, timeoutMs: 5_000 })], { log: () => {} });
  const t = await openThread(store, "model", spec());
  await first.tick();
  assert.equal((await tipOf(store, t))!.state, "running");
  assert.ok(await store.live.handles.get(t));

  const restarted = new Scheduler(store, [modelRunner({ fetch: never })], { log: () => {} });
  await restarted.tick();
  const tip = (await tipOf(store, t))!;
  assert.equal(tip.state, "errored");
  assert.equal(tip.error?.kind, "blew-up");
  assert.match(tip.error!.message, /lost/);
  assert.equal(await store.live.handles.get(t), undefined);
});

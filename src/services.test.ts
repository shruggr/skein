// Host services on their own: requests in the log, replies back through the runtime.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CID } from "multiformats/cid";
import type { Config } from "./config.ts";
import { speak, subscribe } from "./instance.ts";
import { REGISTRY } from "./programs/index.ts";
import { Out, serviceIdentity } from "./programs/sdk.ts";
import { program, type Message } from "./records.ts";
import { Runtime } from "./runtime.ts";
import { clockService } from "./services/clock.ts";
import { executionService } from "./services/execution.ts";
import { inferenceService } from "./services/inference.ts";
import type { Service } from "./services/types.ts";
import { collect, delta, fakeModel, instance, toolCall, usage, type Harness } from "./testkit.ts";
import { identityOf } from "./wallet.ts";

const config: Config = { providers: { fake: { baseUrl: "http://fake/v1/", apiKey: "sekrit" } } };

/** Send `body` to service `name` as "tester"; returns the request CID. */
async function ask(h: Harness, name: string, body: unknown): Promise<CID> {
  const { cid } = await speak(h.store, h.wallet, "tester", body, { to: await identityOf(h.wallet, name), runtime: h.rt });
  await h.rt.idle();
  return cid;
}

async function replyTo(h: Harness, req: CID): Promise<any> {
  const rs = (await h.store.edges.refsTo(req)).filter((r) => r.rel === "replies-to");
  assert.equal(rs.length, 1, `one reply to ${req}`);
  return (await h.store.get<Message>(rs[0].from)).body;
}

test("inference: streams thinking, text and tool calls into one inferred reply; endpoint and key stay host-side", async () => {
  const fake = fakeModel([[
    delta({ role: "assistant", content: "" }),
    delta({ reasoning_content: "let me " }),
    delta({ reasoning: "think" }),
    delta({ content: "Running " }),
    delta({ content: "it." }),
    ...toolCall("call_a", "bash", { cmd: "echo hi" }),
    usage(12, 34),
  ]]);
  const h = await instance([inferenceService({ config, fetch: fake.fetch })]);
  const req = await ask(h, "inference", { kind: "infer", model: "fake/qwen38", thinking: "off", messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "bash", parameters: {} } }] });

  const r = fake.requests[0];
  assert.equal(r.url, "http://fake/v1/chat/completions");
  assert.equal(r.headers.authorization, "Bearer sekrit");
  assert.equal(r.body.model, "qwen38");
  assert.deepEqual(r.body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(r.body.reasoning_effort, undefined);
  assert.equal(r.body.tools.length, 1);

  const body = await replyTo(h, req);
  assert.equal(body.kind, "inferred");
  assert.equal(body.thinking, "let me think");
  assert.equal(body.model, "fake/qwen38");
  assert.deepEqual(body.usage, { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 });
  assert.deepEqual(body.message, {
    role: "assistant", content: "Running it.",
    tool_calls: [{ id: "call_a", type: "function", function: { name: "bash", arguments: '{"cmd":"echo hi"}' } }],
  });
  for await (const { cid } of h.store.log()) assert.doesNotMatch(JSON.stringify(await h.store.get(cid)), /sekrit|fake\/v1/);
  assert.equal(await h.store.live.handles.get(req), undefined);
});

test("inference: config defaults fill model and thinking; unknown provider is cant-do; 4xx cant-do, 5xx blew-up", async () => {
  const fake = fakeModel([[delta({ content: "ok" }, "stop")], new Response("bad", { status: 400 }), new Response("down", { status: 503 })]);
  const h = await instance([inferenceService({ config: { ...config, defaults: { model: "fake/qwen38", thinking: "high" } }, fetch: fake.fetch })]);
  const msgs = [{ role: "user", content: "hi" }];
  const ok = await replyTo(h, await ask(h, "inference", { kind: "infer", messages: msgs }));
  assert.equal(fake.requests[0].body.reasoning_effort, "high");
  assert.equal(ok.model, "fake/qwen38");
  assert.equal(ok.message.content, "ok");

  const nowhere = await replyTo(h, await ask(h, "inference", { kind: "infer", model: "nowhere/x", messages: msgs }));
  assert.deepEqual([nowhere.kind, nowhere.error.kind], ["failed", "cant-do"]);
  assert.match(nowhere.error.message, /unknown provider "nowhere"/);
  assert.equal(fake.requests.length, 1);

  assert.equal((await replyTo(h, await ask(h, "inference", { kind: "infer", messages: msgs }))).error.kind, "cant-do");
  assert.equal((await replyTo(h, await ask(h, "inference", { kind: "infer", messages: msgs }))).error.kind, "blew-up");
});

test("recover: a request in flight when the host died is reported lost; one never started is run", async () => {
  const quiet: Service = { name: "execution", async handle() { /* the host dies before doing anything */ } };
  const h = await instance([quiet]);
  const started = await ask(h, "execution", { kind: "run", cmd: "true" });
  const never = await ask(h, "execution", { kind: "run", cmd: "echo late" });
  await h.store.live.handles.set(started, { pid: 2 ** 22 + 12345, startedAt: 0 }); // as if spawned, pid long gone
  assert.equal((await h.store.edges.refsTo(started)).length, 0);

  const restarted = new Runtime(h.store, { wallet: h.wallet, services: [executionService({ home: mkdtempSync(join(tmpdir(), "skein-svc-")), cwd: tmpdir() })], log: () => {} });
  await restarted.start(60_000);
  await restarted.idle();
  await restarted.stop();
  const lost = (await h.store.get<Message>((await h.store.edges.refsTo(started))[0].from)).body as any;
  assert.deepEqual([lost.kind, lost.error.kind], ["failed", "blew-up"]);
  assert.match(lost.error.message, /lost: pid/);
  const ran = (await h.store.get<Message>((await h.store.edges.refsTo(never))[0].from)).body as any;
  assert.deepEqual([ran.kind, ran.exitCode, ran.stdout], ["ran", 0, "late\n"]);
});

test("clock: a thread that sends a timer and waits on the clock wakes when it's due", async () => {
  let now = 1_000;
  const sleeper = program({ name: "sleeper", code: { ts: "sleeper-test" }, inputs: {}, services: ["clock"], description: "" });
  REGISTRY["sleeper-test"] = {
    async step({ thread, tip, message }, { wallet }) {
      const out = new Out();
      const clock = await serviceIdentity(wallet, "clock");
      if (!("state" in tip)) {
        out.send(clock, { kind: "timer", at: 5_000 });
        out.add(thread, { state: "waiting", waitingFrom: clock });
      } else if (message?.from === clock) {
        out.add(thread, { state: "finished", note: `woke at ${(message.body as { at: number }).at}` });
      }
      return out.done();
    },
  };
  const h = await instance([clockService({ now: () => now })]);
  const sid = await h.store.put(sleeper);
  await subscribe(h.store, h.wallet, { kind: "sleep" }, sid, { runtime: h.rt });
  await speak(h.store, h.wallet, "tester", { kind: "sleep" }, { runtime: h.rt });
  await h.rt.idle();
  const [t] = await collect(h.store.edges.query({ kind: "thread", program: sid }));
  await h.rt.tick();
  assert.equal((await h.tip(t))!.state, "waiting");
  now = 6_000;
  await h.rt.tick();
  await h.rt.idle();
  assert.equal((await h.tip(t))!.state, "finished", h.lines.join("\n"));
  assert.equal((await h.tip(t))!.note, "woke at 5000");
  delete REGISTRY["sleeper-test"];
});

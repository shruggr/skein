// Opt-in: one real loop turn against a live OpenAI-compatible server.
//   SKEIN_MODEL_URL=http://100.100.177.87:8001/v1 SKEIN_MODEL=qwen38 SKEIN_MODEL_KEY=vllm npm test
// The endpoint goes into a temp config file, as it would in ~/.skein/config.json; blocks only say "live/<model>".

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { memoryStore } from "./memory.ts";
import { Scheduler } from "./scheduler.ts";
import { davidRunner } from "./runners/david.ts";
import { loopRunner } from "./runners/loop.ts";
import { modelRunner } from "./runners/model.ts";
import { shellRunner } from "./runners/shell.ts";
import type { ThreadOrigin } from "./types.ts";
import { collect, drive, openThread } from "./testkit.ts";
import { field, nodesOf, nodeView } from "./runners/util.ts";

const url = process.env.SKEIN_MODEL_URL;

test("live: one loop turn runs `echo skein` via bash and says the output", { skip: !url && "SKEIN_MODEL_URL not set", timeout: 180_000 }, async () => {
  const path = join(mkdtempSync(join(tmpdir(), "skein-live-")), "config.json");
  writeFileSync(path, JSON.stringify({ providers: { live: { baseUrl: url, apiKey: process.env.SKEIN_MODEL_KEY ?? "vllm" } } }));
  const store = memoryStore();
  const lines: string[] = [];
  const sched = new Scheduler(store, [loopRunner(), modelRunner({ config: loadConfig(path) }), shellRunner(), davidRunner()], { log: (l) => lines.push(l) });
  const loop = await openThread(store, "loop", {
    system: "You are a terse assistant with a bash tool. Use tools to act; use `say` to answer David.",
    model: `live/${process.env.SKEIN_MODEL ?? "qwen38"}`,
    thinking: "off",
    tools: ["bash", "say"],
    prompt: "Run `echo skein` with bash, then say exactly what it printed.",
  });
  try {
    await drive(sched, async () => (await collect(store.live.resting({ runner: "david", state: ["waiting"] }))).length > 0, 170_000);
  } finally {
    if (process.env.SKEIN_LIVE_LOG) console.log(lines.join("\n"));
  }
  const [david] = await collect(store.live.resting({ runner: "david", state: ["waiting"] }));
  const said = (await store.get<ThreadOrigin>(david)).spec as { say?: string };
  assert.match(said.say ?? "", /skein/i);

  const emits = (await Promise.all((await nodesOf(store, loop)).map((s) => nodeView(store, s)))).flatMap((v) => v.emits);
  assert.ok(emits.some((e) => e.type === "tool_result" && /skein/.test(String(field(e, "content")))), "bash ran echo skein");
});

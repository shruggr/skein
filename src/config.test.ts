import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveModel } from "./config.ts";

test("config: the documented example loads and resolves", () => {
  const c = loadConfig(new URL("../docs/config.example.json", import.meta.url).pathname);
  assert.equal(c.defaults?.model, "ripper/qwen38");
  assert.deepEqual(resolveModel(c, c.defaults!.model!), {
    provider: "ripper", baseUrl: "http://100.100.177.87:8001/v1", apiKey: "vllm", model: "qwen38",
  });
});

test("config: $SKEIN_CONFIG, missing files, provider/model refs", () => {
  const dir = mkdtempSync(join(tmpdir(), "skein-config-"));
  const path = join(dir, "c.json");
  writeFileSync(path, JSON.stringify({ providers: { hf: { baseUrl: "http://h/v1" } } }));
  const saved = { cfg: process.env.SKEIN_CONFIG, home: process.env.HOME };
  try {
    process.env.SKEIN_CONFIG = path;
    const c = loadConfig();
    // Only the first "/" separates provider from model; model names may contain more.
    assert.deepEqual(resolveModel(c, "hf/Qwen/Qwen3-8B"), { provider: "hf", baseUrl: "http://h/v1", apiKey: undefined, model: "Qwen/Qwen3-8B" });
    assert.throws(() => resolveModel(c, "qwen38"), /provider\/model/);
    assert.throws(() => resolveModel(c, "nope/x"), /unknown provider "nope"/);

    process.env.SKEIN_CONFIG = join(dir, "missing.json");
    assert.throws(() => loadConfig(), /missing\.json/); // named explicitly: absence is an error

    delete process.env.SKEIN_CONFIG;
    process.env.HOME = dir; // no ~/.skein/config.json here: empty config
    assert.deepEqual(loadConfig(), { providers: {} });
  } finally {
    if (saved.cfg === undefined) delete process.env.SKEIN_CONFIG; else process.env.SKEIN_CONFIG = saved.cfg;
    process.env.HOME = saved.home;
  }
});

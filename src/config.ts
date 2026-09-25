// Local configuration: where models live and how to reach them. Specs and
// blocks name a model as "provider/model"; endpoints and keys are resolved
// here at run time so they never enter the record.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Thinking } from "./runners/model.ts";

export interface ProviderConfig {
  baseUrl: string;   // OpenAI-compatible, e.g. http://host:8001/v1
  apiKey?: string;
  models?: string[]; // offered to lenses; not enforced (servers may serve other names)
}

export interface Config {
  providers: Record<string, ProviderConfig>;
  defaults?: { model?: string; thinking?: Thinking };
}

export const defaultConfigPath = () => process.env.SKEIN_CONFIG ?? join(homedir(), ".skein", "config.json");

/** Read the config. A missing default file is an empty config; a missing explicit path is an error. */
export function loadConfig(path?: string): Config {
  const p = path ?? defaultConfigPath();
  let text: string;
  try {
    text = readFileSync(p, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" && !path && !process.env.SKEIN_CONFIG) return { providers: {} };
    throw new Error(`skein config ${p}: ${(e as Error).message}`);
  }
  const c = JSON.parse(text) as Partial<Config>;
  return { providers: c.providers ?? {}, defaults: c.defaults };
}

/** "ripper/qwen38" → endpoint, key, and the model name the server knows. Splits on the first "/" only. */
export function resolveModel(config: Config, ref: string): { provider: string; baseUrl: string; apiKey?: string; model: string } {
  const i = ref.indexOf("/");
  if (i <= 0 || i === ref.length - 1) throw new Error(`model must be "provider/model": ${ref}`);
  const provider = ref.slice(0, i);
  const p = config.providers[provider];
  if (!p?.baseUrl) throw new Error(`unknown provider "${provider}" (configure it in ${defaultConfigPath()})`);
  return { provider, baseUrl: p.baseUrl, apiKey: p.apiKey, model: ref.slice(i + 1) };
}

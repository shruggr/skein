// inference: model calls for the instance, over OpenAI-compatible streaming
// /chat/completions (v1's model runner, as a service).
//
//   request  { kind: "infer", model?: "provider/model", thinking?, messages, tools? }
//   reply    { kind: "inferred", message: <assistant ChatMessage with content + tool_calls>,
//              thinking?, usage?, model: "provider/model", ms, finish? }
//            or { kind: "failed", error: { kind: "cant-do" | "blew-up", message } }
//
// One reply, at the end: no progress messages. Streaming deltas as signed
// messages would put every token-batch in the log (and in replay) for a live
// view the UI doesn't have yet; the stream is still consumed incrementally.
// `provider` in the model name is a routing label resolved here from the
// host's config (config.ts); endpoints and keys never enter a record.

import { loadConfig, resolveModel, type Config } from "../config.ts";
import type { ChatMessage, Thinking, ToolCall, ToolDef, Usage } from "../chat.ts";
import { fmt } from "../cid.ts";
import { failed, type HostCtx, type Service } from "./types.ts";

export interface InferRequest { kind: "infer"; model?: string; thinking?: Thinking; messages: ChatMessage[]; tools?: ToolDef[] }

export interface InferenceOptions {
  config?: Config;      // default: loadConfig() per request, so edits apply without a restart
  fetch?: typeof fetch;
  maxConcurrent?: number;
  timeoutMs?: number;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function inferenceService(opts: InferenceOptions = {}): Service {
  const doFetch = opts.fetch ?? fetch;
  const max = opts.maxConcurrent ?? 4;
  const running = new Set<string>();
  let active = 0;
  const queue: Array<() => void> = [];

  const service: Service = {
    name: "inference",

    async handle(req, ctx) {
      const k = fmt(req.cid);
      if (running.has(k)) return;
      const b = req.msg.body as Partial<InferRequest> | null;
      let target: { ref: string; baseUrl: string; apiKey?: string; model: string; thinking?: Thinking };
      try {
        if (b?.kind !== "infer" || !Array.isArray(b.messages)) throw new Error("expected {kind: \"infer\", messages}");
        const config = opts.config ?? loadConfig();
        const ref = b.model ?? config.defaults?.model;
        if (!ref) throw new Error("no model in the request and no defaults.model in config");
        target = { ref, ...resolveModel(config, ref), thinking: b.thinking ?? config.defaults?.thinking };
      } catch (e) {
        await ctx.reply(failed("cant-do", `inference: ${(e as Error).message}`));
        return;
      }
      running.add(k);
      while (active >= max) await new Promise<void>((r) => queue.push(r));
      active++;
      await ctx.store.live.handles.set(req.cid, { startedAt: Date.now(), model: target.ref });
      try {
        await ctx.reply(await call(target, b as InferRequest).catch(errorBody));
      } finally {
        active--;
        queue.shift()?.();
        running.delete(k);
        await ctx.store.live.handles.clear(req.cid);
      }
    },

    async recover(ctx: HostCtx) {
      for await (const req of ctx.pending()) {
        if (running.has(fmt(req.cid))) continue;
        if (await ctx.store.live.handles.get(req.cid)) {
          // A request can't outlive the process that made it: lost, and retryable by whoever asked.
          await ctx.store.live.handles.clear(req.cid);
          await ctx.replyTo(req, failed("blew-up", "lost: request was in flight when the host restarted"));
        } else {
          ctx.redeliver(req);
        }
      }
    },
  };
  return service;

  async function call(target: { ref: string; baseUrl: string; apiKey?: string; model: string; thinking?: Thinking }, req: InferRequest) {
    const t0 = Date.now();
    const body: Record<string, unknown> = {
      model: target.model,
      messages: req.messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.tools?.length) body.tools = req.tools;
    if (target.thinking === "off") body.chat_template_kwargs = { enable_thinking: false }; // vLLM/Qwen: no reasoning_effort "none"
    else if (target.thinking) body.reasoning_effort = target.thinking;

    let content = "", thinking = "";
    const calls: ToolCall[] = [];
    let usage: Usage | undefined;
    let finish: string | undefined;

    const res = await doFetch(`${target.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        ...(target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 600_000),
    });
    if (!res.ok || !res.body) throw new HttpError(res.status, `HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);

    const onData = (data: string) => {
      if (data === "[DONE]") return;
      const chunk = JSON.parse(data);
      if (chunk.error) throw new Error(`stream error: ${JSON.stringify(chunk.error).slice(0, 500)}`);
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finish = choice.finish_reason;
      const d = choice.delta ?? {};
      const reasoning = d.reasoning_content ?? d.reasoning;
      if (reasoning) thinking += reasoning;
      if (d.content) content += d.content;
      for (const tc of d.tool_calls ?? []) {
        const i = tc.index ?? calls.length;
        const acc = (calls[i] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.function.name += tc.function.name;
        if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
      }
    };

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buf += value;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        if (line.startsWith("data:")) onData(line.slice(5).trim());
      }
      if (done) break;
    }
    if (buf.startsWith("data:")) onData(buf.slice(5).trim());

    const toolCalls = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}` }));
    const message: ChatMessage = { role: "assistant", content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
    return {
      kind: "inferred", message, ...(thinking ? { thinking } : {}), ...(usage ? { usage } : {}),
      model: target.ref, ms: Date.now() - t0, ...(finish ? { finish } : {}),
    };
  }
}

function errorBody(e: unknown) {
  // 4xx (bar timeouts/rate limits) means the request itself is wrong: retrying changes nothing.
  if (e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) return failed("cant-do", e.message);
  return failed("blew-up", (e as Error).message ?? String(e));
}

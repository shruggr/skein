// model: one OpenAI-compatible streaming /chat/completions call. Thinking and
// text are emitted as they stream (coalesced); the final assistant message is
// the `conclusion`, as JSON, so a caller can read tool_calls back exactly.

import { CID } from "multiformats/cid";
import type { ThreadOrigin } from "../types.ts";
import type { Runner, RunnerContext, Status } from "./types.ts";
import { compact, openNode } from "./util.ts";

export interface ToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
export interface ToolDef { type: "function"; function: { name: string; description?: string; parameters: Record<string, unknown> } }
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export type Thinking = "off" | "low" | "medium" | "high";

export interface ModelSpec {
  baseUrl: string;
  model: string;
  apiKey?: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  thinking?: Thinking;
}

export interface ModelOptions {
  fetch?: typeof fetch;
  maxConcurrent?: number;
  flushMs?: number;
  flushChars?: number;
  timeoutMs?: number;
}

interface Usage { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }

interface Flight {
  node: CID;
  done: boolean;
  status?: Status;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function modelRunner(opts: ModelOptions = {}): Runner {
  const doFetch = opts.fetch ?? fetch;
  const max = opts.maxConcurrent ?? 4;
  const flights = new Map<string, Flight>();

  return {
    kind: "model",

    async start(thread, ctx) {
      if (flights.has(thread.toString())) return;
      if ([...flights.values()].filter((f) => !f.done).length >= max) return;
      const spec = (await ctx.store.get<ThreadOrigin>(thread)).spec as ModelSpec;
      if (!spec?.baseUrl || !spec.model || !Array.isArray(spec.messages)) {
        return ctx.update(thread, { state: "errored", error: { kind: "cant-do", message: "model spec needs baseUrl, model, messages" } });
      }
      // The key stays out of the node: the request is what was asked, not how we authenticated.
      const node = await openNode(ctx.store, { thread, prev: [], request: compact({ model: spec.model, messages: spec.messages, tools: spec.tools, thinking: spec.thinking }) });
      const requestId = crypto.randomUUID();
      await ctx.store.live.handles.set(thread, { requestId, startedAt: Date.now(), node: node.toString() });
      await ctx.update(thread, { state: "running", note: `${spec.model} @ ${spec.baseUrl}` });
      const flight: Flight = { node, done: false };
      flights.set(thread.toString(), flight);
      call(spec, node, requestId, ctx)
        .then((s) => { flight.status = s; }, (e) => { flight.status = errorStatus(e); })
        .finally(() => { flight.done = true; ctx.wake(thread); });
    },

    async check(thread, ctx) {
      const k = thread.toString();
      const f = flights.get(k);
      if (f && !f.done) return { state: "running" };
      flights.delete(k);
      const h = await ctx.store.live.handles.get(thread);
      await ctx.store.live.handles.clear(thread);
      if (f) return f.status!;
      // A request can't outlive the process that made it: lost, and retryable by whoever waits.
      if (typeof h?.node === "string") await ctx.rest(CID.parse(h.node), { state: "errored" });
      return { state: "errored", error: { kind: "blew-up", message: "lost: request not in flight in this process" } };
    },
  };

  async function call(spec: ModelSpec, node: CID, requestId: string, ctx: RunnerContext): Promise<Status> {
    const t0 = Date.now();
    const body: Record<string, unknown> = {
      model: spec.model,
      messages: spec.messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (spec.tools?.length) body.tools = spec.tools;
    if (spec.thinking === "off") body.chat_template_kwargs = { enable_thinking: false }; // vLLM/Qwen: no reasoning_effort "none"
    else if (spec.thinking) body.reasoning_effort = spec.thinking;

    let writes: Promise<unknown> = Promise.resolve();
    const write = (fn: () => Promise<unknown>) => { writes = writes.then(fn); };
    let cur: { type: "thinking" | "text"; text: string } | undefined;
    let lastFlush = Date.now();
    const flush = () => {
      if (cur?.text) { const e = cur; write(() => ctx.emit(node, e)); }
      cur = undefined;
      lastFlush = Date.now();
    };
    const push = (type: "thinking" | "text", text: string) => {
      if (cur && cur.type !== type) flush();
      cur ??= { type, text: "" };
      cur.text += text;
      if (cur.text.length >= (opts.flushChars ?? 2000) || Date.now() - lastFlush >= (opts.flushMs ?? 250)) flush();
    };

    let content = "";
    const calls: ToolCall[] = [];
    let usage: Usage | undefined;
    let finish: string | undefined;

    try {
      const res = await doFetch(`${spec.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          "x-request-id": requestId,
          ...(spec.apiKey ? { authorization: `Bearer ${spec.apiKey}` } : {}),
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
        if (reasoning) push("thinking", reasoning);
        if (d.content) { content += d.content; push("text", d.content); }
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
    } catch (e) {
      flush();
      write(() => ctx.rest(node, { state: "errored" }));
      await writes;
      throw e;
    }

    flush();
    const toolCalls = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}` }));
    const message: ChatMessage = compact({ role: "assistant", content: content || null, tool_calls: toolCalls.length ? toolCalls : undefined });
    write(() => ctx.emit(node, { type: "conclusion", text: JSON.stringify(message) }));
    write(() => ctx.rest(node, { state: "finished" }));
    await writes;

    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const tokens = usage ? `${usage.prompt_tokens ?? "?"} in / ${usage.completion_tokens ?? "?"} out` : "no usage";
    return { state: "finished", resolution: node, note: `${spec.model} · ${tokens} · ${secs}s${finish && finish !== "stop" && finish !== "tool_calls" ? ` · ${finish}` : ""}` };
  }
}

function errorStatus(e: unknown): Status {
  // 4xx (bar timeouts/rate limits) means the request itself is wrong: retrying changes nothing.
  if (e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) {
    return { state: "errored", error: { kind: "cant-do", message: e.message } };
  }
  return { state: "errored", error: { kind: "blew-up", message: (e as Error).message ?? String(e) } };
}

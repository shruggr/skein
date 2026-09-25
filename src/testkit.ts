// Test helpers: an instance on a memory store, a scripted inference service,
// a scripted SSE fetch for the real one.

import type { CID } from "multiformats/cid";
import type { WalletInterface } from "@bsv/sdk";
import type { Store } from "./store.ts";
import type { ThreadOrigin, ThreadUpdate } from "./types.ts";
import type { ChatMessage, ToolCall as Call } from "./chat.ts";
import { compact, stamp, tipOf } from "./graph.ts";
import { memoryStore } from "./memory.ts";
import { initInstance, type Instance } from "./instance.ts";
import { Runtime } from "./runtime.ts";
import type { Service } from "./services/types.ts";
import { failed } from "./services/types.ts";
import { ephemeralWallet } from "./wallet.ts";

export interface Harness extends Instance {
  store: Store;
  wallet: WalletInterface;
  rt: Runtime;
  lines: string[];
  tip(thread: CID): Promise<ThreadUpdate | undefined>;
}

/** A fresh instance: memory store (unless given), ephemeral wallet, the given services, defaults written. */
export async function instance(services: Service[] = [], o: { store?: Store; wallet?: WalletInterface } = {}): Promise<Harness> {
  const store = o.store ?? memoryStore();
  const wallet = o.wallet ?? ephemeralWallet();
  const lines: string[] = [];
  const rt = new Runtime(store, { wallet, services, log: (l) => lines.push(l), names: ["david"] });
  const inst = await initInstance(store, wallet, { runtime: rt });
  return { ...inst, store, wallet, rt, lines, tip: (t) => tipOf(store, t) };
}

export type Reply = { content?: string; thinking?: string; calls?: Array<[id: string, name: string, args: object]> } | { fail: "cant-do" | "blew-up"; message: string };

/** An inference service that answers each infer request with the next scripted reply, recording the requests. */
export function scriptedInference(replies: Reply[]): Service & { requests: any[] } {
  const requests: any[] = [];
  return {
    name: "inference",
    requests,
    async handle(req, ctx) {
      requests.push(req.msg.body);
      const r = replies.shift();
      if (!r) { await ctx.reply(failed("cant-do", "no more scripted replies")); return; }
      if ("fail" in r) { await ctx.reply(failed(r.fail, r.message)); return; }
      const calls: Call[] = (r.calls ?? []).map(([id, name, args]) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } }));
      const message: ChatMessage = { role: "assistant", content: r.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) };
      await ctx.reply({ kind: "inferred", message, ...(r.thinking ? { thinking: r.thinking } : {}), model: "scripted/m", ms: 0 });
    },
  };
}

export function openThread(store: Store, runner: string, spec: unknown, launchedBy?: CID): Promise<CID> {
  return store.chains.open(compact({ kind: "thread", runner, spec, launchedBy, at: stamp() }) as ThreadOrigin);
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

// ---------------------------------------------------------------- fake model

type Chunk = Record<string, unknown>;

export const delta = (d: Record<string, unknown>, finish?: string): Chunk =>
  ({ choices: [{ index: 0, delta: d, finish_reason: finish ?? null }] });

export const usage = (p: number, c: number): Chunk => ({ choices: [], usage: { prompt_tokens: p, completion_tokens: c, total_tokens: p + c } });

/** A tool call streamed the way vLLM does: id+name first, arguments in fragments. */
export function toolCall(id: string, name: string, args: object, index = 0): Chunk[] {
  const a = JSON.stringify(args), mid = Math.floor(a.length / 2);
  return [
    delta({ tool_calls: [{ index, id, type: "function", function: { name, arguments: "" } }] }),
    delta({ tool_calls: [{ index, function: { arguments: a.slice(0, mid) } }] }),
    delta({ tool_calls: [{ index, function: { arguments: a.slice(mid) } }] }, "tool_calls"),
  ];
}

/** SSE body in awkward 7-byte pieces, to exercise line reassembly. */
export function sse(chunks: Chunk[]): Response {
  const bytes = new TextEncoder().encode(chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join("") + "data: [DONE]\n\n");
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
      c.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** A fetch that answers each /chat/completions call with the next script, recording request bodies. */
export function fakeModel(scripts: Array<Chunk[] | Response>) {
  const requests: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    const s = scripts.shift();
    if (!s) return new Response("no more scripted replies", { status: 500 });
    return s instanceof Response ? s : sse(s);
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

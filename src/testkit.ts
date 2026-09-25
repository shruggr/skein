// Test helpers: drive a scheduler to a condition; a scripted SSE fetch.

import type { CID } from "multiformats/cid";
import type { Store } from "./store.ts";
import type { Scheduler } from "./scheduler.ts";
import type { ThreadOrigin } from "./types.ts";
import { compact, stamp } from "./runners/util.ts";

export async function drive(s: Scheduler, until: () => Promise<boolean> | boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    await s.tick();
    if (await until()) return;
    if (Date.now() > end) throw new Error("drive: condition not reached");
    await new Promise((r) => setTimeout(r, 10));
  }
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

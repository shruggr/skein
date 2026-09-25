// The writes a person makes: start a thread, answer David's question. Shared by
// the CLI and the web API; waking the scheduler is the caller's job.

import type { CID } from "multiformats/cid";
import type { Store } from "./store.ts";
import type { ThreadOrigin } from "./types.ts";
import type { LoopSpec } from "./runners/loop.ts";
import type { Thinking } from "./runners/model.ts";
import { resolveDavid } from "./runners/david.ts";
import { compact, nonce, short, stamp } from "./runners/util.ts";
import { DEFAULT_SYSTEM, DEFAULT_TOOLS } from "./prompts.ts";
import { findWaitingDavid } from "./view.ts";

/** A request that can't be carried out as asked (bad input, nothing to reply to). Not a server fault. */
export class Refused extends Error {}

export const THINKING: Thinking[] = ["off", "low", "medium", "high"];

export interface NewThread { prompt: string; model?: string; thinking?: string; system?: string; tools?: string[] }

/** Open a parent-less loop thread. model/thinking left out fall back to config defaults at call time. */
export async function newThread(store: Store, o: NewThread): Promise<CID> {
  if (!o.prompt?.trim()) throw new Refused("a prompt is required");
  if (o.thinking && !THINKING.includes(o.thinking as Thinking)) throw new Refused(`thinking must be one of ${THINKING.join("|")}`);
  if (o.model && !/^[^/]+\/.+/.test(o.model)) throw new Refused(`model must be "provider/model": ${o.model}`);
  const spec: LoopSpec = compact({
    system: o.system ?? DEFAULT_SYSTEM,
    model: o.model || undefined,
    thinking: (o.thinking || undefined) as Thinking | undefined,
    tools: o.tools?.length ? o.tools : DEFAULT_TOOLS,
    prompt: o.prompt,
  });
  return store.chains.open({ kind: "thread", runner: "loop", spec, at: stamp(), nonce: nonce() } satisfies ThreadOrigin);
}

/** Resolve the david thread `cid` is (or its loop is) waiting on. Returns that david thread. */
export async function reply(store: Store, cid: CID, text: string): Promise<{ david: CID; node: CID }> {
  if (!text.trim()) throw new Refused("a reply needs text");
  const david = await findWaitingDavid(store, cid);
  if (!david) throw new Refused(`nothing from ${short(cid)} is waiting on David`);
  return { david, node: await resolveDavid(store, david, { text }) };
}

// david: a question or turn only David can resolve. The runner puts it in
// front of him (a node with say/page emissions) and rests waiting; nothing in
// the process can poll him, so resolution arrives from outside via resolveDavid.

import type { CID } from "multiformats/cid";
import type { Store } from "../store.ts";
import type { Ms, Ref, ThreadOrigin } from "../types.ts";
import type { Runner } from "./types.ts";
import { emit, isSettled, nodesOf, openNode, rest, statusOf, tipOf } from "./util.ts";

export interface DavidSpec {
  say?: string;
  page?: string;   // markdown
  prompt?: string; // what the reply box asks, if anything
  until?: Ms;      // a nudge: not shown until then
}

export function davidRunner(): Runner {
  return {
    kind: "david",

    async start(thread, ctx) {
      const spec = ((await ctx.store.get<ThreadOrigin>(thread)).spec ?? {}) as DavidSpec;
      const asked = (await nodesOf(ctx.store, thread)).length > 0;
      if (!asked && spec.until !== undefined && spec.until > Date.now()) {
        return ctx.update(thread, { state: "waiting", until: spec.until });
      }
      if (!asked) {
        const node = await openNode(ctx.store, { thread, prev: [], request: spec });
        if (spec.say) await ctx.emit(node, { type: "say", text: spec.say });
        if (spec.page) await ctx.emit(node, { type: "page", markdown: spec.page });
        await ctx.rest(node, { state: "waiting" });
      }
      // No waitingOn, no until: only resolveDavid moves this thread now.
      await ctx.update(thread, { state: "waiting" });
    },

    async check(thread, ctx) {
      const tip = await tipOf(ctx.store, thread);
      return tip ? statusOf(tip) : { state: "waiting" };
    },
  };
}

/** Hand David's reply in: a node (replies-to the thread) that becomes the thread's resolution. */
export async function resolveDavid(store: Store, thread: CID, reply: { text: string; refs?: Ref[] }): Promise<CID> {
  const origin = await store.get<ThreadOrigin>(thread);
  if (origin.kind !== "thread" || origin.runner !== "david") throw new Error(`not a david thread: ${thread}`);
  const tip = await tipOf(store, thread);
  if (isSettled(tip?.state)) throw new Error(`already ${tip!.state}: ${thread}`);
  const asked = (await nodesOf(store, thread)).at(-1);
  const node = await openNode(store, {
    thread,
    prev: asked ? [asked] : [],
    request: { reply: reply.text },
    refs: [{ to: thread, rel: "replies-to" }, ...(reply.refs ?? [])],
  });
  await emit(store, node, { type: "conclusion", text: reply.text });
  await rest(store, node, { state: "finished" });
  await store.chains.append(thread, { state: "finished", resolution: node });
  return node;
}

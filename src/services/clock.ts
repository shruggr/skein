// clock: timers. What v1's `until` becomes: a thread that wants to wake at a
// time sends a timer and waits for a message from the clock.
//
//   request  { kind: "timer", at: <ms> }
//   reply    { kind: "tick", at: <the requested time> }   (once `at` has passed, on a tick)
//
// Timers live in memory; `recover` re-reads unanswered ones from the log.

import { fmt } from "../cid.ts";
import { failed, type HostCtx, type Request, type Service } from "./types.ts";

export function clockService(opts: { now?: () => number } = {}): Service {
  const now = opts.now ?? Date.now;
  const timers = new Map<string, { req: Request; at: number }>();

  const fire = async (ctx: HostCtx) => {
    for (const [k, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at > now()) continue;
      timers.delete(k);
      await ctx.replyTo(t.req, { kind: "tick", at: t.at });
    }
  };

  return {
    name: "clock",
    async handle(req, ctx) {
      const b = req.msg.body as { kind?: unknown; at?: unknown } | null;
      if (b?.kind !== "timer" || typeof b.at !== "number") {
        await ctx.reply(failed("cant-do", "clock: expected {kind: \"timer\", at}"));
        return;
      }
      timers.set(fmt(req.cid), { req, at: b.at });
      if (b.at <= now()) await fire(ctx);
    },
    async recover(ctx) {
      for await (const req of ctx.pending()) {
        const b = req.msg.body as { kind?: unknown; at?: unknown } | null;
        if (b?.kind === "timer" && typeof b.at === "number") timers.set(fmt(req.cid), { req, at: b.at });
      }
      await fire(ctx);
    },
    tick: fire,
  };
}

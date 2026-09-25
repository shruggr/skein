// loop: the harness turn loop (docs/MODEL.md "Nodes and steps").
//
// Re-entry design. The loop holds no state but its chain. It never runs
// `running`: every call to start() reads the head step, performs whatever
// transitions the chain says are due, and leaves the thread `waiting` on the
// thread(s) it needs next (or finished/errored). The scheduler re-enters
// start() whenever everything in waitingOn has settled, so "the thread I waited
// on finished" is handled inside start(); check() only reports the tip.
// Each transition is idempotent against the step's own blocks (its request's
// results, a model launch, a tool launch per call id, one rest, one david
// launch), so a crash between writes resumes from the tip without redoing
// work already recorded. The remaining window is a launch opened but not yet
// emitted as `launched`: that thread is orphaned and the call relaunched.
//
// A step rests exactly once. Its life:
//   [tool_result… carried in from the previous step's tools] → launched model → (model settles) text/say/page →
//   bash calls:          launched shell… → rest waiting → (shells settle) next step carries their results
//   ends turn, top-level: launched david → rest finished → (David replies) next step carries his reply
//   ends turn, subagent:  conclusion → rest finished → thread finished, resolution = this step

import type { CID } from "multiformats/cid";
import type { Ref, ThreadOrigin } from "../types.ts";
import type { Runner, RunnerContext } from "./types.ts";
import type { ChatMessage, ModelSpec, Thinking, ToolCall, ToolDef } from "./model.ts";
import type { DavidSpec } from "./david.ts";
import { compact, conclusion, emitsOf, field, headNode, isSettled, nodesOf, nodeView, openNode, statusOf, tipOf, type NodeView } from "./util.ts";

export interface LoopSpec {
  system: string;
  model?: string;       // "provider/model"; the model runner falls back to config defaults
  thinking?: Thinking;
  tools: string[];      // registry names: "bash", "say", "page"
  prompt: string;       // the opening line: David's, or the caller's task for a subagent
}

export interface LoopOptions {
  maxModelAttempts?: number; // a model thread that blew up is relaunched until this many tries
  cwd?: string;              // bash working directory
  shellTimeoutMs?: number;
  maxToolChars?: number;     // tool output kept in the model's context; the full output stays in the shell node
}

/** A step's request: the model's full input, plus which tool results it carries (emitted before its model call). */
interface StepRequest {
  messages: ChatMessage[];
  results?: Array<{ call: string; thread: CID; ok: boolean }>;
}

export const TOOLS: Record<string, ToolDef> = {
  bash: {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command. Returns its combined stdout/stderr and exit code.",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  },
  say: {
    type: "function",
    function: {
      name: "say",
      description: "Say something to David, spoken aloud. Ends your turn; his reply comes back as the next user message.",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
  },
  page: {
    type: "function",
    function: {
      name: "page",
      description: "Show David a page of markdown, optionally with a spoken line. Ends your turn.",
      parameters: { type: "object", properties: { markdown: { type: "string" }, say: { type: "string" } }, required: ["markdown"] },
    },
  },
};

const DELIVERED = "Delivered to David.";

export function loopRunner(opts: LoopOptions = {}): Runner {
  const maxModel = opts.maxModelAttempts ?? 2;
  const maxChars = opts.maxToolChars ?? 16_000;

  return {
    kind: "loop",
    start: (thread, ctx) => advance(thread, ctx),
    async check(thread, ctx) {
      const tip = await tipOf(ctx.store, thread);
      return tip ? statusOf(tip) : { state: "waiting" };
    },
  };

  async function advance(thread: CID, ctx: RunnerContext): Promise<void> {
    const { store } = ctx;
    const origin = await store.get<ThreadOrigin>(thread);
    const spec = origin.spec as LoopSpec;
    const head = await headNode(store, thread);
    if (!head) {
      return beginStep(ctx, thread, spec, [], {
        messages: [{ role: "system", content: spec.system }, { role: "user", content: spec.prompt }],
      });
    }
    const step = await nodeView(store, head);
    const req = step.origin.request as StepRequest;
    const launches = emitsOf(step.emits, "launched");

    // 1. the model call (after any tool results this step carries)
    const models = launches.filter((l) => l.label === "model");
    const m = models.at(-1);
    if (!m) return runStep(ctx, thread, spec, head, req, step);
    const mTip = await tipOf(store, m.thread);
    if (!isSettled(mTip?.state)) return ctx.update(thread, { state: "waiting", waitingOn: [m.thread] });
    if (mTip!.state !== "finished" || !mTip!.resolution) {
      const err = mTip!.error;
      if (err?.kind !== "cant-do" && models.length < maxModel) return launchModel(ctx, thread, spec, head, req.messages);
      if (!step.rest) await ctx.rest(head, { state: "errored" });
      return ctx.update(thread, {
        state: "errored",
        error: { kind: err?.kind ?? "blew-up", message: `model call failed after ${models.length} attempt(s): ${err?.message ?? mTip!.state}` },
      });
    }
    const assistant = JSON.parse(conclusion(await nodeView(store, mTip!.resolution)) ?? "{}") as ChatMessage;

    // 2. what it said and asked for. Only emissions after this model launch count.
    const after = step.emits.slice(step.emits.indexOf(m) + 1);
    const has = (type: string, call?: string) => after.some((e) => e.type === type && (call === undefined || field(e, "call") === call));
    if (assistant.content && !has("text")) await ctx.emit(head, { type: "text", text: assistant.content });

    const calls = assistant.tool_calls ?? [];
    const results = new Map<string, { thread: CID; ok: boolean; content: string }>(); // call id → result for the next step
    const shells: Array<{ call: ToolCall; thread: CID }> = [];
    const speech = { say: [] as string[], page: [] as string[] };

    for (const call of calls) {
      const name = call.function.name;
      const args = parseArgs(call.function.arguments);
      const fail = (content: string) => results.set(call.id, { thread: m.thread, ok: false, content });
      if (!spec.tools.includes(name) || !TOOLS[name]) { fail(`unknown tool: ${name}`); continue; }
      if (!args) { fail(`invalid JSON arguments for ${name}: ${call.function.arguments}`); continue; }
      if (name === "bash") {
        if (typeof args.command !== "string") { fail("bash needs a command string"); continue; }
        const t = launches.find((x) => x.call === call.id && after.includes(x))?.thread ?? (await ctx.launch({
          runner: "shell",
          spec: compact({ cmd: args.command, cwd: opts.cwd, timeoutMs: opts.shellTimeoutMs }),
          tag: { label: "bash", call: call.id },
        }, head));
        shells.push({ call, thread: t });
      } else {
        // say / page: not threads. They become emissions and, if nothing else is pending, end the turn.
        const text = name === "say" ? str(args.text) : str(args.say);
        const markdown = name === "page" ? str(args.markdown) : undefined;
        if (text) speech.say.push(text);
        if (markdown) speech.page.push(markdown);
        if (text && !has("say", call.id)) await ctx.emit(head, { type: "say", text, call: call.id });
        if (markdown && !has("page", call.id)) await ctx.emit(head, { type: "page", markdown, call: call.id });
      }
    }

    // 3a. tools (or failed calls the model must hear about): wait, then the next step carries the results.
    if (shells.length || results.size) {
      const waitingOn = shells.map((s) => s.thread);
      if (!step.rest) await ctx.rest(head, waitingOn.length ? { state: "waiting", waitingOn } : { state: "finished" });
      for (const s of shells) {
        if (!isSettled((await tipOf(store, s.thread))?.state)) return ctx.update(thread, { state: "waiting", waitingOn });
      }
      for (const s of shells) results.set(s.call.id, { thread: s.thread, ...(await shellResult(ctx, s.thread, maxChars)) });
      const content = (c: ToolCall) => results.get(c.id)?.content ?? DELIVERED;
      return beginStep(ctx, thread, spec, [head], {
        messages: [...req.messages, assistant, ...calls.map((c): ChatMessage => ({ role: "tool", tool_call_id: c.id, content: content(c) }))],
        results: calls.filter((c) => results.has(c.id)).map((c) => ({ call: c.id, thread: results.get(c.id)!.thread, ok: results.get(c.id)!.ok })),
      });
    }

    // 3b. end of turn.
    if (origin.launchedBy) {
      // A subagent answers its caller, never David: the step is the resolution, its conclusion the answer.
      const final = speech.say.join("\n\n") || assistant.content || speech.page.join("\n\n---\n\n");
      if (!has("conclusion")) await ctx.emit(head, { type: "conclusion", text: final });
      if (!step.rest) await ctx.rest(head, { state: "finished" });
      return ctx.update(thread, { state: "finished", resolution: head });
    }
    let d = launches.find((x) => x.label === "david" && after.includes(x))?.thread;
    if (!d) {
      const say = speech.say.join("\n\n") || (speech.page.length ? undefined : assistant.content ?? "");
      const david: DavidSpec = compact({ say, page: speech.page.join("\n\n---\n\n") || undefined });
      d = await ctx.launch({ runner: "david", spec: david, tag: { label: "david" } }, head);
    }
    if (!step.rest) await ctx.rest(head, { state: "finished" });
    const dTip = await tipOf(store, d);
    if (!isSettled(dTip?.state)) return ctx.update(thread, { state: "waiting", waitingOn: [d] });
    if (dTip!.state !== "finished" || !dTip!.resolution) {
      // Dismissed rather than answered: the session is over, and this step is where it ended.
      return ctx.update(thread, { state: "finished", resolution: head });
    }
    const reply = conclusion(await nodeView(store, dTip!.resolution)) ?? "";
    const toolMsgs = calls.map((c): ChatMessage => ({ role: "tool", tool_call_id: c.id, content: DELIVERED }));
    return beginStep(ctx, thread, spec, [head], { messages: [...req.messages, assistant, ...toolMsgs, { role: "user", content: reply }] },
      [{ to: dTip!.resolution, rel: "about" }]);
  }

  async function beginStep(ctx: RunnerContext, thread: CID, spec: LoopSpec, prev: CID[], req: StepRequest, refs: Ref[] = []) {
    const head = await openNode(ctx.store, { thread, prev, request: compact(req), refs });
    return runStep(ctx, thread, spec, head, req);
  }

  /** Emit the tool results the step's request carries (any not yet emitted), then launch its model call. */
  async function runStep(ctx: RunnerContext, thread: CID, spec: LoopSpec, head: CID, req: StepRequest, view?: NodeView) {
    const done = new Set(emitsOf(view?.emits ?? [], "tool_result").map((e) => e.call));
    for (const r of req.results ?? []) {
      if (done.has(r.call)) continue;
      const content = req.messages.findLast((msg) => msg.role === "tool" && msg.tool_call_id === r.call)?.content ?? "";
      await ctx.emit(head, { type: "tool_result", thread: r.thread, ok: r.ok, content, call: r.call });
    }
    return launchModel(ctx, thread, spec, head, req.messages);
  }

  async function launchModel(ctx: RunnerContext, thread: CID, spec: LoopSpec, step: CID, messages: ChatMessage[]) {
    const tools = spec.tools.map((n) => TOOLS[n]).filter(Boolean);
    const model: ModelSpec = compact({ model: spec.model, thinking: spec.thinking, messages, tools: tools.length ? tools : undefined });
    const t = await ctx.launch({ runner: "model", spec: model, tag: { label: "model" } }, step);
    return ctx.update(thread, { state: "waiting", waitingOn: [t] });
  }
}

async function shellResult(ctx: RunnerContext, shell: CID, maxChars: number): Promise<{ ok: boolean; content: string }> {
  const tip = await tipOf(ctx.store, shell);
  const node = tip?.resolution ?? (await nodesOf(ctx.store, shell)).at(-1);
  const v: NodeView | undefined = node ? await nodeView(ctx.store, node) : undefined;
  const out = emitsOf(v?.emits ?? [], "text").map((e) => e.text).join("");
  const exit = emitsOf(v?.emits ?? [], "conclusion").at(-1)?.exitCode;
  const trail = tip?.state === "finished" ? `[exit ${exit ?? "?"}]` : `[${tip?.state}: ${tip?.error?.message ?? "no result"}]`;
  let body = out;
  if (body.length > maxChars) {
    const half = Math.floor(maxChars / 2);
    body = `${body.slice(0, half)}\n…[${body.length - maxChars} chars elided; full output in skein://${node}]…\n${body.slice(-half)}`;
  }
  return { ok: tip?.state === "finished" && exit === 0, content: `${body}${body && !body.endsWith("\n") ? "\n" : ""}${trail}` };
}

function parseArgs(s: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(s || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

// loop: the harness turn loop (docs/MODEL.md "Nodes and steps").
//
// Re-entry design. The loop holds no state but its chain. It never runs
// `running`: every call to start() reads the head step, performs whatever
// transitions the chain says are due, and leaves the thread `waiting` on the
// thread(s) it needs next (or finished/errored). The scheduler re-enters
// start() whenever everything in waitingOn has settled, so "the thread I waited
// on finished" is handled inside start(); check() only reports the tip.
// Each transition is idempotent against the step's emissions (a model
// launch, a tool launch per call id, a tool_result per call id, one david
// launch), so a crash between writes resumes from the tip without redoing
// work already recorded. The remaining window is a launch opened but not yet
// emitted as `launched`: that thread is orphaned and the call relaunched.
//
// A step's life: launched model → (model settles) text/say/page emissions →
//   bash calls:  launched shell… rest waiting → (shells settle) tool_result… rest finished → next step
//   otherwise:   launched david, rest finished → (David replies) next step with his reply

import type { CID } from "multiformats/cid";
import type { Ref, ThreadOrigin } from "../types.ts";
import type { Runner, RunnerContext } from "./types.ts";
import type { ChatMessage, ModelSpec, Thinking, ToolCall, ToolDef } from "./model.ts";
import type { DavidSpec } from "./david.ts";
import { compact, conclusion, field, headNode, isSettled, nodesOf, nodeView, openNode, statusOf, tipOf, type NodeView } from "./util.ts";

export interface LoopSpec {
  system: string;
  model: { baseUrl: string; model: string; apiKey?: string; thinking?: Thinking };
  tools: string[]; // registry names: "bash", "say", "page"
  prompt: string;  // David's opening line
}

export interface LoopOptions {
  maxModelAttempts?: number; // a model thread that blew up is relaunched until this many tries
  cwd?: string;              // bash working directory
  shellTimeoutMs?: number;
  maxToolChars?: number;     // tool output kept in the model's context; the full output stays in the shell node
}

interface StepRequest { messages: ChatMessage[] }

type Launched = { type: "launched"; thread: CID; label?: string; call?: string };
type ToolResult = { type: "tool_result"; thread: CID; ok: boolean; content: string; call?: string };

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
    const spec = (await store.get<ThreadOrigin>(thread)).spec as LoopSpec;
    const head = await headNode(store, thread);
    if (!head) {
      return beginStep(ctx, thread, spec, [], [
        { role: "system", content: spec.system },
        { role: "user", content: spec.prompt },
      ]);
    }
    const step = await nodeView(store, head);
    const { messages } = step.origin.request as StepRequest;
    const launches = step.emits.filter((e): e is Launched => e.type === "launched");

    // 1. the model call
    const models = launches.filter((l) => l.label === "model");
    const m = models.at(-1);
    if (!m) return launchModel(ctx, thread, spec, head, messages);
    const mTip = await tipOf(store, m.thread);
    if (!isSettled(mTip?.state)) return ctx.update(thread, { state: "waiting", waitingOn: [m.thread] });
    if (mTip!.state !== "finished" || !mTip!.resolution) {
      const err = mTip!.error;
      if (err?.kind !== "cant-do" && models.length < maxModel) return launchModel(ctx, thread, spec, head, messages);
      await ctx.rest(head, { state: "errored" });
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
    const results = new Map<string, { ok: boolean; content: string }>(); // call id → result for the next request
    for (const e of after) if (e.type === "tool_result" && field(e, "call")) results.set(String(field(e, "call")), e as ToolResult);
    const shells: Array<{ call: ToolCall; thread: CID }> = [];
    const speech = { say: [] as string[], page: [] as string[] };
    let ends = true; // a turn ends unless something produced a tool result the model must see

    for (const call of calls) {
      const name = call.function.name;
      const args = parseArgs(call.function.arguments);
      const fail = async (content: string) => {
        ends = false;
        if (!results.has(call.id)) {
          results.set(call.id, { ok: false, content });
          await ctx.emit(head, { type: "tool_result", thread: m.thread, ok: false, content, call: call.id });
        }
      };
      if (!spec.tools.includes(name) || !TOOLS[name]) { await fail(`unknown tool: ${name}`); continue; }
      if (!args) { await fail(`invalid JSON arguments for ${name}: ${call.function.arguments}`); continue; }
      if (name === "bash") {
        ends = false;
        if (typeof args.command !== "string") { await fail("bash needs a command string"); continue; }
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

    // 3a. tools: wait for them, then feed their results to the next step.
    if (!ends) {
      const pending = [];
      for (const s of shells) if (!isSettled((await tipOf(store, s.thread))?.state)) pending.push(s.thread);
      if (pending.length) {
        if (step.rest?.state !== "waiting") await ctx.rest(head, { state: "waiting", waitingOn: shells.map((s) => s.thread) });
        return ctx.update(thread, { state: "waiting", waitingOn: shells.map((s) => s.thread) });
      }
      for (const s of shells) {
        if (results.has(s.call.id)) continue;
        const r = await shellResult(ctx, s.thread, maxChars);
        results.set(s.call.id, r);
        await ctx.emit(head, { type: "tool_result", thread: s.thread, ok: r.ok, content: r.content, call: s.call.id });
      }
      const toolMsgs = calls.map((c): ChatMessage => ({ role: "tool", tool_call_id: c.id, content: results.get(c.id)?.content ?? DELIVERED }));
      await ctx.rest(head, { state: "finished" });
      return beginStep(ctx, thread, spec, [head], [...messages, assistant, ...toolMsgs]);
    }

    // 3b. end of turn: put it in front of David and wait for his reply.
    const d = launches.find((x) => x.label === "david" && after.includes(x));
    if (!d) {
      const say = speech.say.join("\n\n") || (speech.page.length ? undefined : assistant.content ?? "");
      const david: DavidSpec = compact({ say, page: speech.page.join("\n\n---\n\n") || undefined });
      const t = await ctx.launch({ runner: "david", spec: david, tag: { label: "david" } }, head);
      await ctx.rest(head, { state: "finished" });
      return ctx.update(thread, { state: "waiting", waitingOn: [t] });
    }
    const dTip = await tipOf(store, d.thread);
    if (!isSettled(dTip?.state)) return ctx.update(thread, { state: "waiting", waitingOn: [d.thread] });
    if (dTip!.state !== "finished" || !dTip!.resolution) {
      // Dismissed rather than answered: the session is over, and this step is where it ended.
      return ctx.update(thread, { state: "finished", resolution: head });
    }
    const reply = conclusion(await nodeView(store, dTip!.resolution)) ?? "";
    const toolMsgs = calls.map((c): ChatMessage => ({ role: "tool", tool_call_id: c.id, content: DELIVERED }));
    return beginStep(ctx, thread, spec, [head], [...messages, assistant, ...toolMsgs, { role: "user", content: reply }],
      [{ to: dTip!.resolution, rel: "about" }]);
  }

  async function beginStep(ctx: RunnerContext, thread: CID, spec: LoopSpec, prev: CID[], messages: ChatMessage[], refs: Ref[] = []) {
    const step = await openNode(ctx.store, { thread, prev, request: { messages } satisfies StepRequest, refs });
    return launchModel(ctx, thread, spec, step, messages);
  }

  async function launchModel(ctx: RunnerContext, thread: CID, spec: LoopSpec, step: CID, messages: ChatMessage[]) {
    const tools = spec.tools.map((n) => TOOLS[n]).filter(Boolean);
    const model: ModelSpec = compact({ ...spec.model, messages, tools: tools.length ? tools : undefined });
    const t = await ctx.launch({ runner: "model", spec: model, tag: { label: "model" } }, step);
    return ctx.update(thread, { state: "waiting", waitingOn: [t] });
  }
}

async function shellResult(ctx: RunnerContext, shell: CID, maxChars: number): Promise<{ ok: boolean; content: string }> {
  const tip = await tipOf(ctx.store, shell);
  const node = tip?.resolution ?? (await nodesOf(ctx.store, shell)).at(-1);
  const v: NodeView | undefined = node ? await nodeView(ctx.store, node) : undefined;
  const out = (v?.emits ?? []).filter((e) => e.type === "text").map((e) => String(field(e, "text"))).join("");
  const exit = field(v?.emits.findLast((e) => e.type === "conclusion"), "exitCode");
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

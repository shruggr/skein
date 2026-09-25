// loop: the turn loop as a step function (v1's runners/loop.ts, reshaped).
//
// The loop holds no state but its chain. Each step reads the head step node
// (via tip.head, walking back), does what the wake calls for, and leaves the
// thread at rest in exactly one shape. A step node's life:
//
//   open (request = the full model input) → sent (infer request) → rest waiting on inference
//   reply "inferred" → received, thinking, text, say/page, launched… (a thread per tool call)
//     tool calls:   rest waiting on those threads; each one that settles adds a tool_result;
//                   when none are pending the node rests finished and the next step opens
//     turn end, launched by a message: node rests finished; the thread waits for a message from
//                   that message's sender, whose next message opens the next step with its text
//     turn end, launched by a step (a subagent): conclusion, node rests finished, thread finished
//   reply "failed" → resent once (unless cant-do), then the node and thread error.
//
// One rest per node. Stale wakes (a reply to an older request, a second
// resolution of the same tool) produce nothing, so the runtime may re-deliver.

import type { CID } from "multiformats/cid";
import type { ChatMessage, Thinking, ToolDef, Usage } from "../chat.ts";
import { isCID } from "../cid.ts";
import type { Placeholder, ProgramContext, ProgramImpl } from "../program.ts";
import type { Message, Program } from "../records.ts";
import type { Emission, Ref, ThreadOrigin, ThreadUpdate } from "../types.ts";
import { DEFAULT_SYSTEM } from "../prompts.ts";
import { BASH_CID } from "./records.ts";
import { cidOf, compact, isObj, isSettled, isUpdate, nodeAt, NOTHING, Out, serviceIdentity, str, toolDef } from "./sdk.ts";

export interface LoopArgs {
  system?: string;
  model?: string;       // "provider/model"; absent = the inference service's default
  thinking?: Thinking;
  tools?: CID[];        // Program records; default [bash]
  tree?: CID;
  prompt?: string;
  text?: string;        // when launched by a prompt message, args is its body: {kind:"prompt", text}
}

/** A step node's request: the model's full input and the tree its tools run in. */
export interface StepRequest { messages: ChatMessage[]; tree?: CID }

/** Inference's reply bodies. */
export interface Inferred { kind: "inferred"; message: ChatMessage; thinking?: string; usage?: Usage; model?: string; ms?: number; finish?: string }
export interface Failed { kind: "failed"; error: { kind: "cant-do" | "blew-up"; message: string } }

export const SAY_PAGE: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "say",
      description: "Say something to David, spoken aloud. Ends your turn; his reply comes back as the next user message.",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
  },
  {
    type: "function",
    function: {
      name: "page",
      description: "Show David a page of markdown, optionally with a spoken line. Ends your turn.",
      parameters: { type: "object", properties: { markdown: { type: "string" }, say: { type: "string" } }, required: ["markdown"] },
    },
  },
];

const DELIVERED = "Delivered to David.";
const MAX_ATTEMPTS = 2;
const MAX_TOOL_CHARS = 16_000;

type E = Emission & Record<string, unknown>;

export const loop: ProgramImpl = {
  async step({ thread, tip, message, resolved }, { get, wallet }) {
    const origin = await get<ThreadOrigin>(thread);
    const args = (origin.args ?? {}) as LoopArgs;
    const inference = await serviceIdentity(wallet, "inference");
    const tools = await Promise.all((args.tools ?? [BASH_CID]).map(async (cid) => ({ cid, program: await get<Program>(cid) })));
    const launcher = await launcherOf(get, origin);
    const out = new Out();

    const sendInfer = (node: CID | Placeholder, messages: ChatMessage[]) => {
      const m = out.send(inference, compact({
        kind: "infer", model: args.model, thinking: args.thinking, messages,
        tools: [...tools.map((t) => toolDef(t.program)), ...SAY_PAGE],
      }));
      const head = out.add(node, { emit: { type: "sent", message: m, kind: "infer" } });
      out.add(thread, { state: "waiting", waitingFrom: inference, head });
    };
    const beginStep = (prev: CID[], req: StepRequest, refs: Ref[]) => {
      const node = out.open({ kind: "node", thread, prev, request: compact(req), refs });
      sendInfer(node, req.messages);
    };

    // A new thread: the first step.
    if (!isUpdate(tip)) {
      const prompt = str(args.prompt) ?? str(args.text) ?? "";
      beginStep([], { messages: [{ role: "system", content: args.system ?? DEFAULT_SYSTEM }, { role: "user", content: prompt }], tree: args.tree },
        origin.launchedBy ? [{ to: origin.launchedBy, rel: "about" }] : []);
      return out.done();
    }
    if (isSettled(tip.state) || !tip.head) return NOTHING;

    const step = await nodeAt(get, tip.head);
    const req = step.origin.request as StepRequest;
    const all: E[] = step.emits as E[]; // grows with what this step adds
    let head: CID | Placeholder = tip.head;
    const emit = (e: Record<string, unknown>) => { all.push(e as E); head = out.add(step.node, { emit: compact(e) }); };
    const sent = all.filter((e) => e.type === "sent");
    const received = all.find((e) => e.type === "received");
    const assistantOf = async (): Promise<ChatMessage> => ((await get<Message>(received!.message as CID)).body as Inferred).message;

    /** Close this step (unless closed) and open the next, carrying the tool results and any new user line. */
    const nextStep = (assistant: ChatMessage, user?: ChatMessage, refs: Ref[] = []) => {
      const results = new Map(all.filter((e) => e.type === "tool_result").map((e) => [e.call as string, e]));
      const toolMsgs = (assistant.tool_calls ?? []).map((c): ChatMessage => ({ role: "tool", tool_call_id: c.id, content: String(results.get(c.id)?.content ?? DELIVERED) }));
      const tree = [...results.values()].map((r) => r.tree).filter(isCID).at(-1) ?? req.tree;
      if (!step.rest) out.add(step.node, { rest: { state: "finished" } });
      beginStep([step.node], { messages: [...req.messages, assistant, ...toolMsgs, ...(user ? [user] : [])], tree }, refs);
    };

    // 1. inference answered.
    if (message && message.from === inference) {
      const last = sent.at(-1)?.message;
      const re = message.refs.find((r) => r.rel === "replies-to")?.to;
      if (tip.waitingFrom !== inference || received || !isCID(last) || !isCID(re) || !re.equals(last)) return NOTHING; // stale
      const body = message.body as Inferred | Failed;
      if (body.kind !== "inferred") {
        const err = isObj(body.error) ? body.error : { kind: "blew-up" as const, message: `unexpected reply ${String((body as { kind?: unknown }).kind)}` };
        if (err.kind !== "cant-do" && sent.length < MAX_ATTEMPTS) {
          sendInfer(step.node, req.messages);
          return out.done();
        }
        const h = out.add(step.node, { rest: { state: "errored" } });
        out.add(thread, { state: "errored", error: { kind: err.kind, message: `inference failed after ${sent.length} attempt(s): ${err.message}` }, head: h });
        return out.done();
      }

      const a = body.message;
      const usage = body.usage ? `${body.usage.prompt_tokens ?? "?"} in / ${body.usage.completion_tokens ?? "?"} out` : undefined;
      emit({ type: "received", message: cidOf(message), note: [body.model, usage, body.ms !== undefined ? `${(body.ms / 1000).toFixed(1)}s` : undefined].filter(Boolean).join(" · ") || undefined });
      if (body.thinking) emit({ type: "thinking", text: body.thinking });
      if (a.content) emit({ type: "text", text: a.content });

      const speech = { say: [] as string[], page: [] as string[] };
      const launched: Placeholder[] = [];
      let failed = 0;
      for (const call of a.tool_calls ?? []) {
        const name = call.function.name;
        const parsed = parseArgs(call.function.arguments);
        const fail = (content: string) => { failed++; emit({ type: "tool_result", ok: false, content, call: call.id }); };
        if (name === "say" || name === "page") {
          const text = str(parsed?.[name === "say" ? "text" : "say"]);
          const markdown = name === "page" ? str(parsed?.markdown) : undefined;
          if (text) { speech.say.push(text); emit({ type: "say", text, call: call.id }); }
          if (markdown) { speech.page.push(markdown); emit({ type: "page", markdown, call: call.id }); }
          continue;
        }
        const tool = tools.find((t) => t.program.name === name);
        if (!tool) { fail(`unknown tool: ${name}`); continue; }
        if (!parsed) { fail(`invalid JSON arguments for ${name}: ${call.function.arguments}`); continue; }
        const missing = requiredOf(tool.program).filter((k) => parsed[k] === undefined);
        if (missing.length) { fail(`${name} needs ${missing.join(", ")}`); continue; }
        const targs = hasInput(tool.program, "tree") && req.tree && parsed.tree === undefined ? { ...parsed, tree: req.tree } : parsed;
        const t = out.open({ kind: "thread", program: tool.cid, args: compact(targs), launchedBy: step.node, nonce: call.id });
        emit({ type: "launched", thread: t, label: name, call: call.id });
        launched.push(t);
      }

      if (launched.length) {
        out.add(thread, { state: "waiting", waitingOn: launched, head });
      } else if (failed) {
        nextStep(a); // the model must hear about the calls that failed
      } else if (launcher) {
        const h = out.add(step.node, { rest: { state: "finished" } });
        out.add(thread, { state: "waiting", waitingFrom: launcher, head: h });
      } else {
        const final = speech.say.join("\n\n") || a.content || speech.page.join("\n\n---\n\n");
        emit({ type: "conclusion", text: final ?? "" });
        const h = out.add(step.node, { rest: { state: "finished" } });
        out.add(thread, { state: "finished", resolution: step.node, head: h });
      }
      return out.done();
    }

    // 2. tool threads settled.
    if (resolved?.length) {
      if (tip.state !== "waiting" || !tip.waitingOn?.length || !received) return NOTHING;
      const launches = all.filter((e) => e.type === "launched" && isCID(e.thread));
      const done = (call: unknown) => all.some((e) => e.type === "tool_result" && e.call === call);
      let added = false;
      for (const r of resolved) {
        const u = await get<ThreadUpdate>(r);
        const l = launches.find((e) => (e.thread as CID).equals(u.origin));
        if (!l || done(l.call) || !isSettled(u.state)) continue;
        emit({ type: "tool_result", thread: u.origin, call: l.call, ...(await toolResult(get, u)) });
        added = true;
      }
      if (!added) return NOTHING;
      const pending = launches.filter((l) => !done(l.call)).map((l) => l.thread as CID);
      if (pending.length) out.add(thread, { state: "waiting", waitingOn: pending, head });
      else nextStep(await assistantOf());
      return out.done();
    }

    // 3. the person this turn ended in front of answered.
    if (message && launcher && message.from === launcher) {
      if (tip.state !== "waiting" || tip.waitingFrom !== launcher || !received) return NOTHING;
      const b = message.body;
      const text = isObj(b) && typeof b.text === "string" ? b.text : JSON.stringify(b);
      nextStep(await assistantOf(), { role: "user", content: text }, [{ to: cidOf(message), rel: "about" }]);
      return out.done();
    }
    return NOTHING;
  },
};

/** The identity to wait on at turn end: the sender of the launching message. A loop launched by a step has none. */
async function launcherOf(get: ProgramContext["get"], origin: ThreadOrigin): Promise<string | undefined> {
  if (!origin.launchedBy) return undefined;
  const b = await get<Message | { kind: string }>(origin.launchedBy);
  return b.kind === "message" ? (b as Message).from : undefined;
}

/** A settled tool thread as the model will read it: output, then [exit n] or what went wrong. */
async function toolResult(get: ProgramContext["get"], u: ThreadUpdate): Promise<{ ok: boolean; content: string; tree?: CID }> {
  const v = u.head ? await nodeAt(get, u.head) : undefined;
  const emits = (v?.emits ?? []) as E[];
  let body = emits.filter((e) => e.type === "text").map((e) => String(e.text)).join("");
  const concl = emits.filter((e) => e.type === "conclusion").at(-1);
  const exit = typeof concl?.exitCode === "number" ? concl.exitCode : undefined;
  if (!body && exit === undefined && typeof concl?.text === "string") body = concl.text;
  const trail = u.state !== "finished" ? `[${u.state}${u.error ? `: ${u.error.message}` : ""}]` : exit !== undefined ? `[exit ${exit}]` : "";
  if (body.length > MAX_TOOL_CHARS) {
    const half = Math.floor(MAX_TOOL_CHARS / 2);
    body = `${body.slice(0, half)}\n…[${body.length - MAX_TOOL_CHARS} chars elided; full output in skein://${v!.node}]…\n${body.slice(-half)}`;
  }
  const content = [body && !body.endsWith("\n") && trail ? `${body}\n` : body, trail].join("");
  return compact({ ok: u.state === "finished" && (exit === undefined || exit === 0), content, tree: isCID(concl?.tree) ? concl.tree : undefined });
}

function parseArgs(s: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(s || "{}");
    return isObj(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

const requiredOf = (p: Program) => ((p.inputs as { required?: string[] })?.required ?? []);
const hasInput = (p: Program, k: string) => !!(p.inputs as { properties?: Record<string, unknown> })?.properties?.[k];


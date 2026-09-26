// The inference peer (docs/ARCH.md, "Everything outside is a peer"): its own
// identity and wallet, a process of its own. It collects its `infer` box on
// the messagebox, verifies and opens each BRC-169 envelope with its wallet
// (open() checks the plaintext against the sender-signed contentHash), calls an
// OpenAI-compatible endpoint, and seals the completion back to the sender in
// `completions` with `replyTo` = the request's id, its signed part's CID (which
// is how the runtime delivers it to the loop thread awaiting it). It is the
// only thing in skein that fetches for inference.
//
//   infer        {model: "<provider>/<model>", messages, tools?, thinking?: "off"|"low"|"medium"|"high"}
//   completions  {replyTo, message: {role: "assistant", content?, reasoning?, tool_calls?}, usage?, model, ms}
//              | {replyTo, error}
//
// Providers come from ~/.skein/infer.json: {"ripper": {"baseUrl": "http://…/v1", "apiKey": "…"}}.

import type { WalletInterface } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { isEnvelope, isoTime, open, seal, signedPart, verify, type Envelope } from "../envelope.ts";
import { encode } from "../runtime/cid.ts";
import type { Listed, MessageBox } from "../host/messagebox.ts";

export interface Provider { baseUrl: string; apiKey?: string }

export interface InferRequest {
  model: string;
  messages: unknown[];
  tools?: unknown[];
  thinking?: "off" | "low" | "medium" | "high";
}

export type Completion =
  | { message: { role: "assistant"; content?: string; reasoning?: string; tool_calls?: unknown[] }; usage?: unknown; model: string; ms: number }
  | { error: string };

export interface InferOptions {
  wallet: WalletInterface;
  box: MessageBox;
  providers: Record<string, Provider>;
  /** Default: global fetch. Tests script it. */
  fetch?: typeof fetch;
  /** This peer's handle, for the envelopes it seals. Default infer@localhost. */
  handle?: string;
  domain?: string;
  /** Accept `created` within ± this of now. Default 10 minutes. */
  freshnessMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

const short = (s: string) => s.slice(-8);

export class InferPeer {
  private readonly o: InferOptions;
  private readonly say: (line: string) => void;
  private timer?: ReturnType<typeof setInterval>;
  private polling?: Promise<unknown>;

  constructor(o: InferOptions) {
    this.o = o;
    this.say = o.log ?? (() => {});
  }

  start(ms = 1000): void {
    const tick = () => { if (!this.polling) this.polling = this.poll().catch((e) => this.say(`infer: ${(e as Error).message}`)).finally(() => { this.polling = undefined; }); };
    tick();
    this.timer = setInterval(tick, ms);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.polling;
  }

  /** Collect the `infer` box once: answer each request, acknowledge it. Returns how many were answered. */
  async poll(): Promise<number> {
    let n = 0;
    for (const m of await this.o.box.list("infer")) {
      try {
        if (await this.handle(m)) n++;
      } catch (e) {
        this.say(`infer ${m.messageId}: ${(e as Error).message} (left unacknowledged)`);
        continue;
      }
      await this.o.box.ack([m.messageId]);
    }
    return n;
  }

  /** One request: screen, open, complete, reply. False if rejected (logged). */
  async handle(m: Listed): Promise<boolean> {
    const reject = (why: string) => { this.say(`infer ${m.messageId}: rejected: ${why}`); return false; };
    let env: unknown = m.body;
    try { for (let i = 0; i < 2 && typeof env === "string"; i++) env = JSON.parse(env); } catch { return reject("body is not JSON"); }
    if (!isEnvelope(env) || !verify(env)) return reject("not a verifiable BRC-169 envelope");
    if (m.sender !== undefined && m.sender !== env.sender.identityKey) return reject("messagebox sender is not envelope.sender");
    const now = (this.o.now ?? Date.now)();
    if (Math.abs(now - Date.parse(env.created)) > (this.o.freshnessMs ?? 10 * 60_000)) return reject(`created ${env.created} is not fresh`);
    const replyTo = encode(signedPart(env)).cid;
    let result: Completion;
    try {
      const req = dagCbor.decode((await open(this.o.wallet, env)).body) as InferRequest;
      result = await this.complete(req);
    } catch (e) {
      result = { error: (e as Error).message };
    }
    await this.reply(env, { replyTo, ...result });
    this.say(`infer ${short(replyTo.toString())} from ${short(env.sender.identityKey)}: ${"error" in result ? `error: ${result.error}` : `${result.model} ${result.ms} ms${result.message.tool_calls?.length ? ` · ${result.message.tool_calls.length} tool call(s)` : ""}`}`);
    return true;
  }

  /** Call the provider the model names ("<provider>/<model>"). */
  async complete(req: InferRequest): Promise<Completion> {
    if (typeof req?.model !== "string" || !Array.isArray(req.messages)) return { error: "infer wants {model, messages, tools?, thinking?}" };
    const slash = req.model.indexOf("/");
    const [name, model] = slash > 0 ? [req.model.slice(0, slash), req.model.slice(slash + 1)] : [req.model, req.model];
    const p = this.o.providers[name];
    if (!p) return { error: `no provider "${name}" (known: ${Object.keys(this.o.providers).join(", ") || "none"})` };
    const body: Record<string, unknown> = { model, messages: req.messages, stream: false };
    if (req.tools?.length) body.tools = req.tools;
    if (req.thinking === "off") body.chat_template_kwargs = { enable_thinking: false };
    else if (req.thinking) { body.chat_template_kwargs = { enable_thinking: true }; body.reasoning_effort = req.thinking; }
    const t0 = Date.now();
    const res = await (this.o.fetch ?? fetch)(`${p.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}) },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) return { error: `${name}: HTTP ${res.status} ${text.slice(0, 500)}` };
    const j = JSON.parse(text) as { choices?: Array<{ message?: Record<string, unknown> }>; usage?: unknown; model?: string };
    const msg = j.choices?.[0]?.message;
    if (!msg) return { error: `${name}: no choices in the response` };
    const reasoning = msg.reasoning_content ?? msg.reasoning;
    const calls = Array.isArray(msg.tool_calls) && msg.tool_calls.length ? msg.tool_calls : undefined;
    return clean({
      message: { role: "assistant", content: typeof msg.content === "string" ? msg.content : undefined, reasoning: typeof reasoning === "string" && reasoning ? reasoning : undefined, tool_calls: calls },
      usage: j.usage,
      model: req.model,
      ms: Date.now() - t0,
    }) as Completion;
  }

  private async reply(to: Envelope, body: object): Promise<void> {
    const [user, domain] = (this.o.handle ?? "infer@localhost").split("@");
    const out = await seal(this.o.wallet, {
      recipient: { identityKey: to.sender.identityKey, handle: to.sender.handle ?? to.sender.identityKey.slice(0, 16), domain: to.sender.domain ?? domain ?? "localhost" },
      sender: { handle: user, domain: this.o.domain ?? domain ?? "localhost" },
      body: dagCbor.encode(clean(body)),
      created: isoTime((this.o.now ?? Date.now)()),
    });
    await this.o.box.send({ recipient: to.sender.identityKey, box: "completions", body: out });
  }
}

/** Drop undefined and null members (dag-cbor has no undefined; the loop wants absent, not null). */
function clean(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined && x !== null) out[k] = clean(x);
    return out;
  }
  return v;
}

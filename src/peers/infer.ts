// The inference peer (docs/ARCH.md, "Everything outside is a peer"): its own
// identity and wallet, a process of its own. It collects its `infer` box on
// the messagebox, verifies and opens each BRC-169 envelope with its wallet
// (open() checks the plaintext against the sender-signed contentHash), calls an
// OpenAI-compatible endpoint, and seals the completion back to the sender in
// `completions` with `replyTo` = the request's id, its signed part's CID (which
// is how the runtime delivers it to the loop thread awaiting it). It is the
// only thing in skein that fetches for inference.
//
// It is stateful (issue #12; docs/MESSAGES.md, "The infer protocol"): it holds
// each sender's conversation graph — the loop's `turn` records, keyed by CID,
// each naming its `parent` — so a request carries only the nodes that are new
// since the last one and names the node they extend. The engine behind it is
// stateless: the peer walks the graph back from the newest node to the root
// and sends that whole path as OpenAI chat messages.
//
//   infer        {model: "<provider>/<model>", thinking?: "off"|"low"|"medium"|"high", tools?,
//                 parent?: <node cid>, nodes: [<turn>…]}
//   completions  {replyTo, message: {role: "assistant", content?, reasoning?, tool_calls?}, usage?, model, ms}
//              | {replyTo, missing: [<node cid>]}     (the peer does not hold that node: resend)
//              | {replyTo, error}
//
// (A request with `messages` and no `nodes` — a loop from before #12 — is
// passed through as it is.)
//
// Providers come from ~/.skein/infer.json: {"ripper": {"baseUrl": "http://…/v1", "apiKey": "…"}}.
//
// Two transports. Since #40 (`raw`): its mailbox is a mailbox instance at its
// own origin, and it speaks raw BRC-33 on BRC-104 sessions — it lists its
// `infer` box there (a request's id is its messageId: the record the instance
// keeps; the sender is the session's identity), and answers in the sender's
// `completions` at the sender's own messagebox. Where that is comes from its
// address book (key → messagebox URL), which its admin configures
// (skein-infer: SKEIN_INFER_PEERS; scripts/host/up.sh writes every agent's
// there). Nobody registers with it: a request from a key not in the address
// book has nowhere to go, and is dropped with one line saying so. The
// envelope transport (`box`): BRC-169 envelopes (§7.2, JSON) over any BRC-33
// messagebox, one listed message per request.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WalletInterface } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { isoTime, open, seal, type Envelope } from "../envelope.ts";
import { asEnvelope, inspect, isCborEnvelope, openCbor, sealCbor, wrapCbor, type AnyEnvelope } from "../envelope-cbor.ts";
import { encode } from "../runtime/cid.ts";
import type { Listed, MessageBox } from "../host/brc231.ts";
import type { Listed as RawListed } from "../client/raw.ts";

/** The raw transport (#40): its own mailbox, a session per peer messagebox, its address book. */
export interface RawTransport {
  /** Its mailbox instance (a RawBox). */
  inbox: { list(box: string): Promise<RawListed[]>; ack(ids: string[]): Promise<void> };
  /** A session with the messagebox at `url` (a RawBox). */
  outbox(url: string): { send(recipient: string, box: string, body: unknown): Promise<unknown> };
  /** Its address book (#40): the messagebox URL of the sender `key`, configured by its admin; undefined: no route. */
  addressOf(key: string): string | undefined;
}

export interface Provider { baseUrl: string; apiKey?: string }

export type Thinking = "off" | "low" | "medium" | "high";
const THINKING: readonly string[] = ["off", "low", "medium", "high"];

/** One engine call: the whole chat. */
export interface EngineRequest {
  model: string;
  messages: unknown[];
  tools?: unknown[];
  thinking?: Thinking;
}

/**
 * A conversation node: one of the loop's `turn` records (the loop: shruggr/skein-chat programs/loop), as
 * kept in the instance, so its CID here is its CID there. `parent` is the node
 * before it; the root (the system prompt) has none.
 */
export interface TurnNode {
  kind: "turn";
  parent?: CID;
  role: string;
  text?: string;
  content?: string;
  tool_calls?: unknown[];
  call?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
  [k: string]: unknown;
}

/** An `infer` body: the nodes new since the sender's last request, and the node they extend. */
export interface InferRequest {
  model: string;
  thinking?: Thinking;
  tools?: unknown[];
  /** The node `nodes[0]` extends; absent when the nodes start at the root. */
  parent?: CID;
  nodes?: TurnNode[];
  /** Before #12: the whole chat, passed through. */
  messages?: unknown[];
}

export type Completion =
  | { message: { role: "assistant"; content?: string; reasoning?: string; tool_calls?: unknown[] }; usage?: unknown; model: string; ms: number }
  | { missing: CID[] }
  | { error: string };

/**
 * The peer's side of the conversation graph: nodes by CID, per sender (one
 * sender's nodes never reach another's chat). In memory, the `max` most
 * recently used; with a `dir`, every node is also on disk as
 * `<dir>/<sender>/<cid>` (its dag-cbor bytes) and read back after a restart or
 * an eviction. Nothing prunes the directory.
 */
export class NodeGraph {
  private readonly mem = new Map<string, TurnNode>();
  private readonly o: { dir?: string; max?: number };
  constructor(o: { dir?: string; max?: number } = {}) {
    this.o = o;
    if (o.dir) mkdirSync(o.dir, { recursive: true });
  }

  get(sender: string, cid: CID): TurnNode | undefined {
    const k = `${sender}/${cid}`;
    const hit = this.mem.get(k);
    if (hit) { this.mem.delete(k); this.mem.set(k, hit); return hit; }
    if (!this.o.dir) return undefined;
    let bytes: Uint8Array;
    try { bytes = readFileSync(join(this.o.dir, sender, cid.toString())); } catch { return undefined; }
    const node = dagCbor.decode(bytes) as TurnNode;
    if (!encode(node).cid.equals(cid)) return undefined; // a damaged file is a missing node
    this.remember(k, node);
    return node;
  }

  put(sender: string, cid: CID, node: TurnNode, bytes: Uint8Array): void {
    const k = `${sender}/${cid}`;
    if (this.mem.has(k)) return;
    this.remember(k, node);
    if (this.o.dir) {
      const d = join(this.o.dir, sender);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, cid.toString()), bytes);
    }
  }

  /** Drop everything held in memory, as a restart would; the disk stays. */
  forget(): void { this.mem.clear(); }

  get size(): number { return this.mem.size; }

  private remember(k: string, node: TurnNode): void {
    this.mem.set(k, node);
    const max = this.o.max ?? 50_000;
    for (const old of this.mem.keys()) { if (this.mem.size <= max) break; this.mem.delete(old); }
  }
}

export interface InferOptions {
  wallet: WalletInterface;
  /** The envelope transport: BRC-169 envelopes over a BRC-33 messagebox. */
  box?: MessageBox;
  /** The raw transport (#40). */
  raw?: RawTransport;
  providers: Record<string, Provider>;
  /** The conversation graph. Default: in memory only. */
  graph?: NodeGraph;
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
  readonly graph: NodeGraph;
  private readonly say: (line: string) => void;
  private timer?: ReturnType<typeof setInterval>;
  private polling?: Promise<unknown>;

  constructor(o: InferOptions) {
    this.o = o;
    this.say = o.log ?? (() => {});
    this.graph = o.graph ?? new NodeGraph();
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
    if (this.o.raw) return this.pollRaw(this.o.raw);
    let n = 0;
    for (const m of await this.o.box!.list("infer")) {
      try {
        if (await this.handle(m)) n++;
      } catch (e) {
        this.say(`infer ${m.messageId}: ${(e as Error).message} (left unacknowledged)`);
        continue;
      }
      await this.o.box!.ack([m.messageId]);
    }
    return n;
  }

  /** The raw transport (#40): each request answered at the messagebox the address book names for its sender. */
  private async pollRaw(raw: RawTransport): Promise<number> {
    let n = 0;
    for (const m of await raw.inbox.list("infer")) {
      const url = raw.addressOf(m.sender);
      if (!url) {
        this.say(`infer ${short(m.messageId)} from ${short(m.sender)}: no route: ${m.sender} is not in the address book; dropped`);
        await raw.inbox.ack([m.messageId]);
        continue;
      }
      const replyTo = CID.parse(m.messageId);
      let result: Completion;
      try { result = await this.answer(m.sender, m.value as InferRequest); } catch (e) { result = { error: (e as Error).message }; }
      try {
        await raw.outbox(url).send(m.sender, "completions", clean({ replyTo, ...result }));
        n++;
      } catch (e) {
        this.say(`infer ${short(m.messageId)}: answer to ${url}: ${(e as Error).message} (left unacknowledged)`);
        continue;
      }
      this.say(`infer ${short(m.messageId)} from ${short(m.sender)}: ${"error" in result ? `error: ${result.error}` : "missing" in result ? `missing ${result.missing.map((c) => short(c.toString())).join(", ")}` : `${result.model} ${result.ms} ms`}`);
      await raw.inbox.ack([m.messageId]);
    }
    return n;
  }

  /** One request: screen, open, complete, reply. False if rejected (logged). */
  async handle(m: Listed): Promise<boolean> {
    const reject = (why: string) => { this.say(`infer ${m.messageId}: rejected: ${why}`); return false; };
    // Either envelope form (issue #33): §7.2 JSON, or §7.3 dag-cbor (BRC-231 bytes, or {"dag-cbor": base64} in a JSON listing).
    const env = asEnvelope(m.body);
    if (!env) return reject("not a BRC-169 envelope");
    let x: ReturnType<typeof inspect>;
    try { x = inspect(env); } catch (e) { return reject((e as Error).message); }
    if (!x.verified) return reject("not a verifiable BRC-169 envelope");
    if (m.sender !== undefined && m.sender !== x.sender) return reject("messagebox sender is not envelope.sender");
    const now = (this.o.now ?? Date.now)();
    if (Math.abs(now - Date.parse(env.created)) > (this.o.freshnessMs ?? 10 * 60_000)) return reject(`created ${env.created} is not fresh`);
    const replyTo = x.id;
    let result: Completion;
    try {
      const plain = isCborEnvelope(env) ? await openCbor(this.o.wallet, env) : await open(this.o.wallet, env as Envelope);
      const req = dagCbor.decode(plain.body) as InferRequest;
      result = await this.answer(x.sender, req);
    } catch (e) {
      result = { error: (e as Error).message };
    }
    await this.reply(env, x.sender, { replyTo, ...result });
    this.say(`infer ${short(replyTo.toString())} from ${short(x.sender)}: ${"error" in result ? `error: ${result.error}` : "missing" in result ? `missing ${result.missing.map((c) => short(c.toString())).join(", ")}` : `${result.model} ${result.ms} ms${result.message.tool_calls?.length ? ` · ${result.message.tool_calls.length} tool call(s)` : ""}`}`);
    return true;
  }

  /**
   * One request from `sender`: take its nodes into the graph, walk back from
   * the newest to the root, and complete the chat that path is. A node it
   * cannot find — the named parent, or an ancestor it no longer holds — is a
   * `missing` reply naming it, and no engine call.
   */
  async answer(sender: string, req: InferRequest): Promise<Completion> {
    const wants = "infer wants {model, thinking?, tools?, parent?, nodes}";
    if (typeof req?.model !== "string") return { error: wants };
    if (req.nodes === undefined && Array.isArray(req.messages)) return this.complete(req as EngineRequest);
    if (!Array.isArray(req.nodes) || req.nodes.length === 0) return { error: `${wants}: no nodes` };
    const parent = req.parent === undefined ? undefined : CID.asCID(req.parent) ?? undefined;
    if (req.parent !== undefined && !parent) return { error: "infer: parent is not a CID" };
    let prev = parent;
    const blocks: Array<{ node: TurnNode; cid: CID; bytes: Uint8Array }> = [];
    for (const [i, node] of req.nodes.entries()) {
      if (!node || typeof node !== "object" || node.kind !== "turn" || typeof node.role !== "string") return { error: `infer: node ${i} is not a turn` };
      const up = node.parent === undefined ? undefined : CID.asCID(node.parent) ?? undefined;
      if (!(up === prev || (up && prev && up.equals(prev)))) return { error: `infer: node ${i} does not extend ${i === 0 ? "the named parent" : `node ${i - 1}`}` };
      const b = encode(node);
      blocks.push({ node, ...b });
      prev = b.cid;
    }
    for (const b of blocks) this.graph.put(sender, b.cid, b.node, b.bytes);
    // The path to the newest node, root first. What is not held is missing.
    const path: TurnNode[] = [];
    for (let c: CID | undefined = prev; c; ) {
      const n = this.graph.get(sender, c);
      if (!n) return { missing: [c] };
      path.push(n);
      c = n.parent === undefined ? undefined : CID.asCID(n.parent) ?? undefined;
    }
    path.reverse();
    return this.complete({ model: req.model, thinking: req.thinking, tools: req.tools, messages: chat(path) });
  }

  /** Call the provider the model names ("<provider>/<model>") with the whole chat. */
  async complete(req: EngineRequest): Promise<Completion> {
    if (typeof req?.model !== "string" || !Array.isArray(req.messages)) return { error: "infer wants {model, messages, tools?, thinking?}" };
    if (req.thinking !== undefined && !THINKING.includes(req.thinking)) return { error: `thinking must be one of ${THINKING.join(", ")}, not ${JSON.stringify(req.thinking)}` };
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

  /** Answer in the form the request came in (a JSON-form request gets a JSON-form reply). */
  private async reply(to: AnyEnvelope, sender: string, body: object): Promise<void> {
    const [user, domain] = (this.o.handle ?? "infer@localhost").split("@");
    const args = {
      recipient: { identityKey: sender, handle: to.sender.handle ?? sender.slice(0, 16), domain: to.sender.domain ?? domain ?? "localhost" },
      sender: { handle: user, domain: this.o.domain ?? domain ?? "localhost" },
      body: dagCbor.encode(clean(body)),
      created: isoTime((this.o.now ?? Date.now)()),
    };
    const out = isCborEnvelope(to) ? wrapCbor(await sealCbor(this.o.wallet, args)) : await seal(this.o.wallet, args);
    await this.o.box!.send({ recipient: sender, box: "completions", body: out });
  }
}

/**
 * A path of turns as OpenAI chat messages: system, user, assistant and tool
 * turns in order; the others (errors) are the loop's records, not the model's.
 */
export function chat(path: TurnNode[]): unknown[] {
  const out: unknown[] = [];
  for (const t of path) {
    switch (t.role) {
      case "system": out.push({ role: "system", content: t.content ?? "" }); break;
      case "user": out.push({ role: "user", content: userText(t) }); break;
      case "assistant": out.push(clean({ role: "assistant", content: t.content ?? "", tool_calls: t.tool_calls?.length ? t.tool_calls : undefined })); break;
      case "tool": out.push({ role: "tool", tool_call_id: t.call ?? "", content: toolText(t) }); break;
    }
  }
  return out;
}

/** A user turn as the model reads it: the text, then the notes it made on presented pages (issue #19), each naming the page by CID. */
function userText(t: TurnNode): string {
  const notes = Array.isArray(t.annotations) ? t.annotations as Array<{ present?: unknown; block?: unknown; note?: unknown }> : [];
  if (!notes.length) return t.text ?? "";
  const lines = notes.map((a) => `- on ${CID.asCID(a.present)?.toString() ?? String(a.present)}${typeof a.block === "string" && a.block ? ` block ${a.block}` : ""}: ${String(a.note ?? "")}`);
  return `${t.text ?? ""}\n\n[annotations]\n${lines.join("\n")}`;
}

/** A tool turn as the model reads it: a message's answer (or what went wrong), or a shell's exit, stdout and stderr. */
function toolText(t: TurnNode): string {
  if (t.exitCode === undefined) return t.error ? `error: ${t.error}` : t.text ?? "";
  let s = `exit ${t.exitCode}\n${t.stdout ?? ""}`;
  if (t.stderr) s += `\n[stderr]\n${t.stderr}`;
  return s;
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

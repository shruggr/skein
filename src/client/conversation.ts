// Chat state on David's machine: the last `chat` reply the instance sent
// (~/.skein/client/conversation.json). `chat` continues from it by setting
// `replyTo` to that envelope's CID; `--new` (or no file) starts a fresh
// conversation. Both directions are box `chat`: David's chat to the instance,
// the instance's reply (`replyTo` set) to David (see src/client/README.md).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CID } from "multiformats/cid";

export interface Conversation {
  /** CID of the last `chat` reply received from the instance. */
  reply: string;
  thread?: string;
  tree?: string;
  at: string;
}

export interface ChatBody { text: string; tree?: CID; model?: string; replyTo?: CID }

/** The instance's `chat` reply: its answer at the end of a turn names its tree and thread; a mid-turn message to David may not. */
export interface ReplyBody { text: string; page?: string; tree?: CID; thread?: CID; replyTo: CID }

export const conversationFile = (stateDir: string) => join(stateDir, "conversation.json");

export function loadConversation(stateDir: string): Conversation | undefined {
  try {
    return asConversation(JSON.parse(readFileSync(conversationFile(stateDir), "utf8")));
  } catch { return undefined; }
}

/** A stored conversation, or undefined. Takes the older `say` field for `reply`. */
export function asConversation(x: unknown): Conversation | undefined {
  const c = x as (Partial<Conversation> & { say?: unknown }) | null;
  if (!c || typeof c !== "object") return undefined;
  const reply = typeof c.reply === "string" ? c.reply : typeof c.say === "string" ? c.say : undefined;
  if (reply === undefined) return undefined;
  const { say: _, ...rest } = c;
  return { ...rest, reply, at: typeof c.at === "string" ? c.at : "" } as Conversation;
}

export function saveConversation(stateDir: string, c: Conversation): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(conversationFile(stateDir), JSON.stringify(c, null, 2) + "\n");
}

/**
 * The `chat` body. Continuing (a conversation exists and not `fresh`): replyTo
 * is the last reply, and the tree defaults to that reply's tree. New: neither.
 */
export function chatBody(opts: { text: string; tree?: string; model?: string; fresh?: boolean }, conv?: Conversation): ChatBody {
  if (!opts.text.trim()) throw new Error("chat: empty text");
  const b: ChatBody = { text: opts.text };
  const cont = !opts.fresh && conv ? conv : undefined;
  const tree = opts.tree ?? cont?.tree;
  if (tree !== undefined) b.tree = CID.parse(tree);
  if (opts.model !== undefined) b.model = opts.model;
  if (cont) b.replyTo = CID.parse(cont.reply);
  return b;
}

const cidOf = (v: unknown): CID | undefined => CID.asCID(v) ?? undefined;

/** Check a decoded `chat` reply body; throws on a malformed one (or a chat that is not a reply). */
export function parseReply(body: Record<string, unknown> | undefined): ReplyBody {
  if (!body || typeof body.text !== "string") throw new Error("chat: no text");
  const replyTo = cidOf(body.replyTo);
  if (!replyTo) throw new Error("chat: not a reply (replyTo is not a CID)");
  const s: ReplyBody = { text: body.text, replyTo };
  if (body.thread !== undefined) {
    const thread = cidOf(body.thread);
    if (!thread) throw new Error("chat: thread is not a CID");
    s.thread = thread;
  }
  if (body.page !== undefined) {
    if (typeof body.page !== "string") throw new Error("chat: page is not a string");
    s.page = body.page;
  }
  if (body.tree !== undefined) {
    const tree = cidOf(body.tree);
    if (!tree) throw new Error("chat: tree is not a CID");
    s.tree = tree;
  }
  return s;
}

/**
 * Conversation state after receiving the reply envelope `cid`. A reply that
 * names no tree (a message mid-turn) keeps the tree of `prev`, the state before.
 */
export function conversationFrom(cid: string, r: ReplyBody, at = new Date().toISOString(), prev?: Conversation): Conversation {
  const tree = r.tree?.toString() ?? prev?.tree;
  const thread = r.thread?.toString() ?? prev?.thread;
  return { reply: cid, ...(thread && { thread }), ...(tree && { tree }), at };
}

export const short = (cid: string) => (cid.length > 16 ? `${cid.slice(0, 6)}…${cid.slice(-6)}` : cid);

// ---------------------------------------------------------------- talk REPL

export type ReplCmd =
  | { kind: "chat"; text: string }
  | { kind: "new" }
  | { kind: "tree"; cid: string }
  | { kind: "quit" }
  | { kind: "empty" }
  | { kind: "error"; message: string };

export function parseReplLine(line: string): ReplCmd {
  const t = line.trim();
  if (!t) return { kind: "empty" };
  if (!t.startsWith("/")) return { kind: "chat", text: t };
  const [cmd, ...args] = t.split(/\s+/);
  switch (cmd) {
    case "/new": return args.length ? { kind: "error", message: "/new takes no arguments" } : { kind: "new" };
    case "/quit": case "/exit": return { kind: "quit" };
    case "/tree": {
      if (args.length !== 1) return { kind: "error", message: "usage: /tree <cid>" };
      try { CID.parse(args[0]!); } catch { return { kind: "error", message: `not a CID: ${args[0]}` }; }
      return { kind: "tree", cid: args[0]! };
    }
    default: return { kind: "error", message: `unknown command ${cmd} (/new, /tree <cid>, /quit)` };
  }
}

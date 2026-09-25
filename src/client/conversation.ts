// Chat state on David's machine: the last `say` envelope the instance sent
// (~/.skein/client/conversation.json). `chat` continues from it by setting
// `replyTo` to that envelope's CID; `--new` (or no file) starts a fresh
// conversation. Message shapes: box `chat` david → instance, box `say`
// instance → david (see src/client/README.md).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CID } from "multiformats/cid";

export interface Conversation {
  /** CID of the last `say` envelope received. */
  say: string;
  thread?: string;
  tree?: string;
  at: string;
}

export interface ChatBody { text: string; tree?: CID; model?: string; replyTo?: CID }

export interface SayBody { text: string; page?: string; tree?: CID; thread: CID; replyTo: CID }

export const conversationFile = (stateDir: string) => join(stateDir, "conversation.json");

export function loadConversation(stateDir: string): Conversation | undefined {
  try {
    const c = JSON.parse(readFileSync(conversationFile(stateDir), "utf8")) as Conversation;
    return typeof c.say === "string" ? c : undefined;
  } catch { return undefined; }
}

export function saveConversation(stateDir: string, c: Conversation): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(conversationFile(stateDir), JSON.stringify(c, null, 2) + "\n");
}

/**
 * The `chat` body. Continuing (a conversation exists and not `fresh`): replyTo
 * is the last say, and the tree defaults to that say's tree. New: neither.
 */
export function chatBody(opts: { text: string; tree?: string; model?: string; fresh?: boolean }, conv?: Conversation): ChatBody {
  if (!opts.text.trim()) throw new Error("chat: empty text");
  const b: ChatBody = { text: opts.text };
  const cont = !opts.fresh && conv ? conv : undefined;
  const tree = opts.tree ?? cont?.tree;
  if (tree !== undefined) b.tree = CID.parse(tree);
  if (opts.model !== undefined) b.model = opts.model;
  if (cont) b.replyTo = CID.parse(cont.say);
  return b;
}

const cidOf = (v: unknown): CID | undefined => CID.asCID(v) ?? undefined;

/** Check a decoded `say` body; throws on a malformed one. */
export function parseSay(body: Record<string, unknown> | undefined): SayBody {
  if (!body || typeof body.text !== "string") throw new Error("say: no text");
  const thread = cidOf(body.thread), replyTo = cidOf(body.replyTo);
  if (!thread) throw new Error("say: thread is not a CID");
  if (!replyTo) throw new Error("say: replyTo is not a CID");
  const s: SayBody = { text: body.text, thread, replyTo };
  if (body.page !== undefined) {
    if (typeof body.page !== "string") throw new Error("say: page is not a string");
    s.page = body.page;
  }
  if (body.tree !== undefined) {
    const tree = cidOf(body.tree);
    if (!tree) throw new Error("say: tree is not a CID");
    s.tree = tree;
  }
  return s;
}

/** Conversation state after receiving the say envelope `cid`. */
export function conversationFrom(cid: string, say: SayBody, at = new Date().toISOString()): Conversation {
  return { say: cid, thread: say.thread.toString(), ...(say.tree && { tree: say.tree.toString() }), at };
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

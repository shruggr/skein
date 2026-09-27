// skein — David's client. Signs as David through his wallet-api, talks only to
// the messagebox. See scripts/host/README.md for the processes it expects.
//
//   skein whoami
//   skein import <dir>
//   skein run [--tree <cid>] [--cwd <path>] [--env K=V]... -- '<cmd>'
//   skein head <name> <tree-cid>
//   skein subscribe add|remove [--sender <identity-key>] <box> <handler-name-or-cid>
//   skein inbox [--wait] [--timeout <s>] [--no-ack] [--json]
//   skein chat "<text>" [--tree <cid>] [--model <m>] [--new] [--wait] [--timeout <s>]
//   skein talk [--tree <cid>] [--model <m>] [--new] [--timeout <s>]

import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "./config.ts";
import { BOX, SkeinClient, type Result } from "./client.ts";
import { parseReplLine, parseReply, short } from "./conversation.ts";

export type Command =
  | { cmd: "whoami" }
  | { cmd: "import"; dir: string }
  | { cmd: "run"; tree?: string; cwd?: string; env?: Record<string, string>; line: string }
  | { cmd: "head"; name: string; tree: string }
  | { cmd: "subscribe"; op: "add" | "remove"; sender?: string; box: string; handler: string }
  | { cmd: "inbox"; wait: boolean; timeout: number; ack: boolean; json: boolean }
  | { cmd: "chat"; text: string; tree?: string; model?: string; fresh: boolean; wait: boolean; timeout: number }
  | { cmd: "talk"; tree?: string; model?: string; fresh: boolean; timeout: number }
  | { cmd: "help" };

export const USAGE = `usage:
  skein whoami
  skein import <dir>
  skein run [--tree <cid>] [--cwd <path>] [--env K=V]... -- '<cmd>'
  skein head <name> <tree-cid>
  skein subscribe add|remove [--sender <identity-key>] <box> <handler-name-or-cid>
  skein inbox [--wait] [--timeout <seconds>] [--no-ack] [--json]
  skein chat "<text>" [--tree <cid>] [--model <m>] [--new] [--wait] [--timeout <seconds>]
  skein talk [--tree <cid>] [--model <m>] [--new] [--timeout <seconds>]`;

export const DEFAULT_TIMEOUT = 120;

function timeoutOf(cmd: string, v: string | undefined): number {
  const t = v === undefined ? DEFAULT_TIMEOUT : Number(v);
  if (!Number.isFinite(t) || t <= 0) throw new Error(`${cmd}: bad --timeout ${v}`);
  return t;
}

const convOptions = { tree: { type: "string" }, model: { type: "string" }, new: { type: "boolean" }, timeout: { type: "string" } } as const;

export function parseCli(argv: string[]): Command {
  const [sub, ...rest] = argv;
  switch (sub) {
    case undefined: case "help": case "-h": case "--help":
      return { cmd: "help" };
    case "whoami":
      parseArgs({ args: rest, options: {}, allowPositionals: false });
      return { cmd: "whoami" };
    case "import": {
      const { positionals } = parseArgs({ args: rest, options: {}, allowPositionals: true });
      if (positionals.length !== 1) throw new Error("import: expected exactly one <dir>");
      return { cmd: "import", dir: positionals[0]! };
    }
    case "run": {
      const dd = rest.indexOf("--");
      if (dd < 0) throw new Error("run: the command goes after `--`");
      const line = rest.slice(dd + 1).join(" ");
      if (!line.trim()) throw new Error("run: empty command");
      const { values, positionals } = parseArgs({
        args: rest.slice(0, dd),
        options: { tree: { type: "string" }, cwd: { type: "string" }, env: { type: "string", multiple: true } },
        allowPositionals: true,
      });
      if (positionals.length) throw new Error(`run: unexpected ${positionals.join(" ")} (the command goes after \`--\`)`);
      let env: Record<string, string> | undefined;
      for (const kv of values.env ?? []) {
        const i = kv.indexOf("=");
        if (i <= 0) throw new Error(`run: --env wants K=V, got ${kv}`);
        (env ??= {})[kv.slice(0, i)] = kv.slice(i + 1);
      }
      return { cmd: "run", line, ...(values.tree !== undefined && { tree: values.tree }), ...(values.cwd !== undefined && { cwd: values.cwd }), ...(env && { env }) };
    }
    case "head": {
      const { positionals } = parseArgs({ args: rest, options: {}, allowPositionals: true });
      if (positionals.length !== 2) throw new Error("head: expected <name> <tree-cid>");
      return { cmd: "head", name: positionals[0]!, tree: positionals[1]! };
    }
    case "subscribe": {
      const { values, positionals } = parseArgs({ args: rest, options: { sender: { type: "string" } }, allowPositionals: true });
      const [op, box, handler] = positionals;
      if (positionals.length !== 3 || (op !== "add" && op !== "remove")) throw new Error("subscribe: expected add|remove [--sender <identity-key>] <box> <handler>");
      return { cmd: "subscribe", op, box: box!, handler: handler!, ...(values.sender !== undefined && { sender: values.sender }) };
    }
    case "inbox": {
      const { values } = parseArgs({
        args: rest,
        options: { wait: { type: "boolean" }, timeout: { type: "string" }, "no-ack": { type: "boolean" }, json: { type: "boolean" } },
        allowPositionals: false,
      });
      return { cmd: "inbox", wait: !!values.wait, timeout: timeoutOf("inbox", values.timeout), ack: !values["no-ack"], json: !!values.json };
    }
    case "chat": {
      const { values, positionals } = parseArgs({ args: rest, options: { ...convOptions, wait: { type: "boolean" } }, allowPositionals: true });
      const text = positionals.join(" ");
      if (!text.trim()) throw new Error('chat: expected "<text>"');
      return {
        cmd: "chat", text, fresh: !!values.new, wait: !!values.wait, timeout: timeoutOf("chat", values.timeout),
        ...(values.tree !== undefined && { tree: values.tree }), ...(values.model !== undefined && { model: values.model }),
      };
    }
    case "talk": {
      const { values } = parseArgs({ args: rest, options: convOptions, allowPositionals: false });
      return {
        cmd: "talk", fresh: !!values.new, timeout: timeoutOf("talk", values.timeout),
        ...(values.tree !== undefined && { tree: values.tree }), ...(values.model !== undefined && { model: values.model }),
      };
    }
    default:
      throw new Error(`unknown command: ${sub}`);
  }
}

// ---------------------------------------------------------------- printing

function text(v: unknown): string {
  if (v instanceof Uint8Array) return new TextDecoder().decode(v);
  return v === undefined || v === null ? "" : String(v);
}

/** A `chat` reply as text: the text line, the page (markdown, as is), then tree/thread. */
export function formatReply(body: Record<string, unknown> | undefined): string {
  const s = parseReply(body);
  const out = [s.text];
  if (s.page) out.push("", s.page.replace(/\s+$/, ""), "");
  const ids = [s.tree && `tree ${short(s.tree.toString())}`, s.thread && `thread ${short(s.thread.toString())}`].filter(Boolean);
  if (ids.length) out.push(`  [${ids.join("  ")}]`);
  return out.join("\n");
}

function show(r: Result, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(r, (_k, v) => (v instanceof Uint8Array ? text(v) : v)));
    return;
  }
  const b = r.body ?? {};
  console.log(`— ${r.box} ${r.created ?? "?"} from ${r.sender.slice(0, 16)}… ${r.verified ? "verified" : "UNVERIFIED"} msg ${r.messageId.slice(0, 12)}`);
  if (r.error) { console.log(`  error: ${r.error}`); return; }
  if (r.box === BOX.chat && b.replyTo !== undefined) {
    try { console.log(formatReply(b)); return; } catch (e) { console.log(`  malformed reply: ${(e as Error).message}`); }
  }
  if (r.box === BOX.chat && typeof b.text === "string") { console.log(`  (new conversation) ${b.text}`); return; }
  if (b.replyTo !== undefined) console.log(`  replyTo:  ${text(b.replyTo)}`);
  if (b.exitCode !== undefined) console.log(`  exitCode: ${text(b.exitCode)}`);
  if (b.tree !== undefined) console.log(`  tree:     ${text(b.tree)}`);
  for (const k of ["stdout", "stderr"] as const) {
    const s = text(b[k]);
    if (s) console.log(`  ${k}:\n${s.replace(/^/gm, "    ").replace(/\s+$/, "")}`);
  }
  const other = Object.keys(b).filter((k) => !["replyTo", "exitCode", "tree", "stdout", "stderr"].includes(k));
  for (const k of other) console.log(`  ${k}: ${JSON.stringify(b[k], (_k, v) => (v instanceof Uint8Array ? text(v) : v))}`);
}

// ---------------------------------------------------------------- main

export async function main(argv: string[]): Promise<number> {
  const c = parseCli(argv);
  if (c.cmd === "help") { console.log(USAGE); return 0; }
  const cfg = loadConfig();
  const client = new SkeinClient(cfg);

  switch (c.cmd) {
    case "whoami": {
      console.log(`owner (you):  ${await client.identityKey()}  via ${cfg.walletUrl} as ${cfg.originator}`);
      console.log(`instance:     ${cfg.instance.identityKey}  ${cfg.instance.handle}@${cfg.instance.domain}`);
      console.log(`messagebox:   ${cfg.messageboxUrl}`);
      return 0;
    }
    case "import": {
      const r = await client.importDir(c.dir, (i, n, bytes) => process.stderr.write(`bundle ${i + 1}/${n} (${bytes} bytes)\n`));
      process.stderr.write(`${r.records} objects in ${r.bundles.length} envelope(s) to box objects\n`);
      console.log(r.root.toString());
      return 0;
    }
    case "run": {
      const s = await client.run({ tree: c.tree, cmd: c.line, cwd: c.cwd, env: c.env });
      console.log(s.cid);
      return 0;
    }
    case "head": {
      const s = await client.head(c.name, c.tree);
      console.log(s.cid);
      return 0;
    }
    case "subscribe": {
      const s = await client.subscribe(c);
      console.log(s.cid);
      return 0;
    }
    case "inbox": {
      if (!c.wait) { for (const r of await client.inbox({ ack: c.ack })) show(r, c.json); return 0; }
      const want = [];
      const chat = client.lastSent(BOX.chat), run = client.lastSent(BOX.run);
      if (chat) want.push({ box: BOX.chat, replyTo: chat.cid });
      if (run) want.push({ box: BOX.results, replyTo: run.cid });
      if (!want.length) throw new Error("inbox --wait: no chat or run sent from this machine yet (~/.skein/client/sent.jsonl)");
      return wait(client, want, c.timeout, (r) => show(r, c.json), c.ack);
    }
    case "chat": {
      const s = await client.chat(c);
      if (!c.wait) { console.log(s.cid); return 0; }
      process.stderr.write(`sent ${short(s.cid)}${s.replyTo ? ` (reply to ${short(s.replyTo)})` : " (new conversation)"}\n`);
      return wait(client, [{ box: BOX.chat, replyTo: s.cid }], c.timeout, (r) => show(r, false));
    }
    case "talk":
      return talk(client, c);
  }
}

async function wait(client: SkeinClient, want: { box: string; replyTo: string }[], timeout: number, onResult: (r: Result) => void, ack = true): Promise<number> {
  const hit = await client.waitFor(want, { timeoutMs: timeout * 1000, ack, onResult });
  if (hit) return 0;
  console.error(`no answer to ${want.map((w) => `${w.box}←${short(w.replyTo)}`).join(" or ")} within ${timeout}s`);
  return 1;
}

/** The REPL: each line is a chat continuing the last reply; waits for the reply to it. */
async function talk(client: SkeinClient, c: Extract<Command, { cmd: "talk" }>): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let fresh = c.fresh, tree = c.tree;
  console.log("talk: /new, /tree <cid>, /quit");
  try {
    for (;;) {
      let line: string;
      try { line = await rl.question("> "); } catch { return 0; } // stdin closed
      const cmd = parseReplLine(line);
      switch (cmd.kind) {
        case "empty": continue;
        case "quit": return 0;
        case "error": console.log(cmd.message); continue;
        case "new": fresh = true; tree = undefined; console.log("(new conversation)"); continue;
        case "tree": tree = cmd.cid; console.log(`(tree ${short(cmd.cid)} for the next message)`); continue;
        case "chat": {
          const s = await client.chat({ text: cmd.text, fresh, tree, model: c.model });
          fresh = false; tree = undefined; // after this, the reply's tree carries the conversation
          const hit = await client.waitFor([{ box: BOX.chat, replyTo: s.cid }], {
            timeoutMs: c.timeout * 1000,
            onResult: (r) => { if (r.box === BOX.chat && String(r.body?.replyTo) === s.cid && !r.error) console.log(formatReply(r.body)); else show(r, false); },
          });
          if (!hit) console.log(`(no answer within ${c.timeout}s; \`skein inbox\` picks it up later)`);
        }
      }
    }
  } finally {
    rl.close();
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e: Error) => {
    console.error(`skein: ${e.message}`);
    process.exit(1);
  });
}

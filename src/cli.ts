#!/usr/bin/env -S node --experimental-strip-types
// The skein CLI. Every command but `run` is its own short-lived process
// against the SQLite file; after a write it pokes the daemon (POST /wake) if
// one is listening, and otherwise leaves the work for the daemon's next tick.

import { readFileSync } from "node:fs";
import type { CID } from "multiformats/cid";
import type { WalletInterface } from "@bsv/sdk";
import { fmt, isCID } from "./cid.ts";
import type { Store } from "./store.ts";
import type { Ref, ThreadOrigin, ThreadState } from "./types.ts";
import { newThread, reply, THINKING } from "./actions.ts";
import { dbPath, openDefaultStore, openWallet, portFrom } from "./env.ts";
import { atRest, jsonify, listThreads, programName, short, threadOf, threadRow, threadView, resolveCid, oneLine, waitingOnPerson, Watcher, type EmitView, type LaunchView, type ThreadRow, type ThreadView, type WatchEvent } from "./view.ts";
import { nodeView } from "./graph.ts";
import { ago } from "./web/pages.ts";

// ---------------------------------------------------------------- args

type FlagKind = "string" | "boolean";
export interface Parsed { pos: string[]; opts: Record<string, string | boolean> }

/** --flag value, --flag=value, boolean --flag, -h, and `--` to end flags. Unknown flags are errors. */
export function parseArgs(argv: string[], flags: Record<string, FlagKind>): Parsed {
  const out: Parsed = { pos: [], opts: {} };
  const all: Record<string, FlagKind> = { help: "boolean", port: "string", ...flags };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { out.pos.push(...argv.slice(i + 1)); break; }
    if (a === "-h") { out.opts.help = true; continue; }
    if (!a.startsWith("--") || a === "--") { out.pos.push(a); continue; }
    const eq = a.indexOf("=");
    const name = a.slice(2, eq < 0 ? undefined : eq);
    const kind = all[name];
    if (!kind) throw new UsageError(`unknown flag --${name}`);
    if (kind === "boolean") {
      if (eq >= 0) throw new UsageError(`--${name} takes no value`);
      out.opts[name] = true;
    } else if (eq >= 0) {
      out.opts[name] = a.slice(eq + 1);
    } else {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`--${name} needs a value`);
      out.opts[name] = v;
    }
  }
  return out;
}

export class UsageError extends Error {}

// ---------------------------------------------------------------- environment

export interface Env {
  out(line: string): void;
  err(line: string): void;
  store(): Store;
  wallet(): Promise<WalletInterface>; // signs David's prompts (instance.ts)
  wake(thread?: CID): Promise<boolean>;
  port: number;
  now(): number;
  sleep(ms: number): Promise<void>;
  columns: number;
}

async function wakeDaemon(port: number, thread?: CID): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/wake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(thread ? { thread: fmt(thread) } : {}),
      signal: AbortSignal.timeout(1500),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- formatting

const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 8);
const indent = (text: string, pad: string) => text.replace(/\n$/, "").split("\n").map((l) => pad + l).join("\n");
const stateOf = (r: Pick<ThreadRow, "state" | "davidWaiting">) => (r.davidWaiting ? "waiting:you" : r.state);

function clip(text: string, lines: number): string {
  const ls = text.replace(/\n$/, "").split("\n");
  return ls.length <= lines ? ls.join("\n") : `${ls.slice(0, lines).join("\n")}\n… ${ls.length - lines} more lines`;
}

export function formatLs(rows: ThreadRow[], now = Date.now(), columns = 120): string {
  if (!rows.length) return "no threads";
  const head = ["CID", "RUNNER", "STATE", "AGE", "ACTIVE", "LABEL"];
  const cells = rows.map((r) => [short(r.cid), r.runner, stateOf(r), ago(r.at, now), ago(r.tipAt, now), r.label]);
  const w = head.slice(0, -1).map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const left = w.reduce((a, b) => a + b + 2, 0);
  const line = (c: string[]) => `${c.slice(0, -1).map((x, i) => x.padEnd(w[i])).join("  ")}  ${oneLine(c.at(-1), Math.max(20, columns - left))}`.trimEnd();
  return [line(head), ...cells.map(line)].join("\n");
}

function launchLine(r: LaunchView, thinking: boolean): string {
  const bits = [["shell", "bash", "loop"].includes(r.runner) ? r.label : r.runner, short(r.cid), r.state];
  if (r.note) bits.push(r.note);
  if (r.error) bits.push(r.error);
  if (r.thinking && !thinking) bits.push(`[thinking ${r.thinking.length} chars]`);
  let s = `↳ ${bits.join("  ")}`;
  if (r.thinking && thinking) s += `\n${indent(r.thinking, "    ┊ ")}`;
  if (r.reply !== undefined) s += `\n  David: ${r.reply}`;
  return s;
}

function formatEmit(e: EmitView, runner: string, thinking: boolean): string | undefined {
  const t = (k: string) => String(e[k] ?? "");
  switch (e.type) {
    case "thinking": return thinking ? `thinking:\n${indent(t("text"), "  ┊ ")}` : `thinking: ${t("text").length} chars`;
    case "text": return runner === "shell" || runner === "bash" ? indent(t("text"), "  ") : `text: ${indent(t("text"), "  ").trimStart()}`;
    case "say": return `say: ${t("text")}`;
    case "page": return `page:\n${indent(t("markdown"), "  │ ")}`;
    case "tool_result": return `result ${e.ok ? "ok" : "failed"}${e.call ? ` (${t("call")})` : ""}:\n${indent(clip(t("content"), 20), "  ")}`;
    case "conclusion": return runner === "model" ? `conclusion: ${oneLine(t("text"), 200)}` : `${runner === "david" ? "David" : "conclusion"}: ${t("text")}`;
    case "launched": return e.run ? launchLine(e.run, thinking) : `↳ ${t("thread")}`;
    case "sent": return `→ ${t("kind") || "message"} ${short(t("message"))}`;
    case "received": return `← ${short(t("message"))}${e.note ? `  ${t("note")}` : ""}`;
    default: return `${e.type}: ${oneLine(JSON.stringify(e), 200)}`;
  }
}

export function formatThread(v: ThreadView, o: { thinking?: boolean; now?: number } = {}): string {
  const now = o.now ?? Date.now();
  const spec = (v.spec ?? {}) as Record<string, unknown>;
  const lines = [
    `thread ${v.cid}`,
    `  ${v.runner} · ${stateOf(v)} · started ${new Date(v.at).toISOString()} (${ago(v.at, now)} ago)`,
    `  ${v.label}`,
  ];
  if (v.runner === "loop") lines.push(`  model ${spec.model ?? "(config default)"} · thinking ${spec.thinking ?? "(default)"} · tools ${(spec.tools as string[] | undefined)?.map(short).join(",") ?? "(default)"}`);
  if (v.program) lines.push(`  program ${v.runner} ${short(v.program)}`);
  if (v.launchedBy) lines.push(`  launched by node ${short(v.launchedBy)}${v.parent ? ` of thread ${short(v.parent)}` : ""}`);
  if (v.davidWaiting) lines.push(`  waiting on David: skein reply ${short(v.cid)} "…"`);
  else if (v.state === "waiting") {
    const w = v.history.at(-1)?.waitingFrom;
    if (w) lines.push(`  waiting on a message from ${w.slice(0, 12)}…`);
  }
  lines.push("", "states");
  for (const h of v.history) {
    const detail = [h.waitingOn?.length ? `on ${h.waitingOn.map(short).join(",")}` : "", h.waitingFrom ? `from ${h.waitingFrom.slice(0, 12)}…` : "", h.until ? `until ${new Date(h.until).toISOString()}` : "",
      h.resolution ? `→ ${short(h.resolution)}` : "", h.note ?? "", h.error ?? ""].filter(Boolean).join("  ");
    lines.push(`  ${String(h.seq).padStart(3)}  ${h.state.padEnd(9)} ${clock(h.at)}  ${detail}`.trimEnd());
  }
  if (!v.history.length) lines.push("  (not started)");
  v.nodes.forEach((n, i) => {
    lines.push("", `${v.runner === "loop" ? "step" : "node"} ${i + 1}  ${short(n.cid)}  ${clock(n.at)}`);
    if (n.asked) lines.push(indent(n.asked, "  "));
    for (const e of n.emits) {
      const s = formatEmit(e, v.runner, !!o.thinking);
      if (s) lines.push(indent(s, "  "));
    }
    if (n.rest) lines.push(`  rest ${n.rest.state}${n.rest.waitingOn?.length ? ` on ${n.rest.waitingOn.map(short).join(",")}` : ""}`);
  });
  return lines.join("\n");
}

async function formatNode(store: Store, cid: CID, thinking: boolean): Promise<string> {
  const v = await nodeView(store, cid);
  const runner = await programName(store, await store.get<ThreadOrigin>(v.origin.thread));
  const lines = [
    `node ${fmt(cid)}`,
    `  thread ${short(v.origin.thread)} (${runner})  at ${new Date(v.origin.at).toISOString()}`,
    `  prev ${v.origin.prev.map(short).join(",") || "(none)"}`,
  ];
  for (const r of v.origin.refs) lines.push(`  ref ${r.rel} ${isCID(r.to) ? short(r.to) : r.to}${r.locator ?? ""}`);
  lines.push("request", indent(clip(JSON.stringify(jsonify(v.origin.request), null, 2), 40), "  "), "emissions");
  for (const e of v.emits) {
    const ev = jsonify(e) as EmitView;
    if (e.type === "launched" && isCID(e.thread)) ev.run = await threadRow(store, e.thread);
    const s = formatEmit(ev, runner, thinking);
    if (s) lines.push(indent(s, "  "));
  }
  if (v.rest) lines.push(`rest ${v.rest.state}${v.rest.waitingOn?.length ? ` on ${v.rest.waitingOn.map(short).join(",")}` : ""}`);
  return lines.join("\n");
}

export async function formatShow(store: Store, cid: CID, o: { thinking?: boolean; now?: number } = {}): Promise<string> {
  const b = await store.get<{ kind?: unknown } & ThreadOrigin>(cid);
  if (b.kind === "thread") return formatThread(await threadView(store, cid), o);
  if (b.kind === "node") return formatNode(store, cid, !!o.thinking);
  return JSON.stringify(jsonify(b), null, 2);
}

/** One watch event as terminal lines, or undefined for events the rest of the stream already covers. */
export function formatEvent(ev: WatchEvent, o: { thinking?: boolean } = {}): string | undefined {
  const pad = "  ".repeat(ev.depth);
  const at = clock(ev.at);
  if (ev.update) {
    const u = ev.update;
    if (ev.runner === "loop" && u.state === "waiting") return undefined;
    if (ev.runner === "bash" && u.state === "waiting") return undefined;
    const detail = [u.note, u.error && `${u.error.kind}: ${u.error.message}`].filter(Boolean).join(" · ");
    return `${at} ${pad}${ev.runner} ${short(ev.thread)} → ${u.state}${detail ? `  ${detail}` : ""}`;
  }
  if (!ev.emit) return undefined;
  const e = jsonify(ev.emit) as EmitView;
  if (e.type === "thinking" && !o.thinking) return undefined;
  if (e.type === "sent" || e.type === "received") return undefined;
  if (ev.runner === "bash" && ev.depth > 0) return undefined; // its output returns as a tool_result
  if (e.type === "launched") return ev.label?.startsWith("$ ") ? `${at} ${pad}${ev.label}` : undefined;
  const s = formatEmit(e, ev.runner, !!o.thinking);
  if (s === undefined) return undefined;
  const [first, ...more] = s.split("\n");
  return [`${at} ${pad}${first}`, ...more.map((l) => pad + l)].join("\n");
}

// ---------------------------------------------------------------- commands

interface Command { usage: string; flags: Record<string, FlagKind>; run(a: Parsed, env: Env): Promise<number> }

const list = (v: unknown) => (typeof v === "string" ? v.split(",").map((x) => x.trim()).filter(Boolean) : undefined);
const optStr = (v: unknown) => (typeof v === "string" ? v : undefined);

async function need(env: Env, a: Parsed, what = "<cid-or-prefix>"): Promise<CID> {
  const s = a.pos[0];
  if (!s) throw new UsageError(`missing ${what}`);
  return resolveCid(env.store(), s);
}

async function poke(env: Env, thread?: CID) {
  if (!(await env.wake(thread))) env.err(`(no daemon on :${env.port}; it will pick this up when \`skein run\` is up)`);
}

async function watch(env: Env, root: CID, o: { thinking?: boolean; replay?: boolean; watcher?: Watcher }): Promise<number> {
  const store = env.store();
  const w = o.watcher ?? new Watcher(store, root);
  if (!o.watcher && !o.replay) {
    await w.poll();
    const v = await threadView(store, root);
    env.out(`${clock(env.now())} ${v.runner} ${short(root)} is ${stateOf(v)}: ${v.label}`);
  }
  for (;;) {
    const done = await atRest(store, root); // checked before the poll so the last events still print
    for (const ev of await w.poll()) {
      const s = formatEvent(ev, o);
      if (s) env.out(s);
    }
    if (done) break;
    await env.sleep(500);
  }
  const d = await waitingOnPerson(store, root);
  const v = await threadView(store, root);
  env.out(d ? `— your turn: skein reply ${short(root)} "…"` : `— ${v.runner} ${short(root)} ${v.state}`);
  return v.state === "errored" ? 1 : 0;
}

const COMMANDS: Record<string, Command> = {
  run: {
    usage: `skein run [--port 4322] [--host 127.0.0.1] [--tick 1000]
  Run the daemon: runtime + host services (inference, execution, clock) + web
  browser at http://<host>:<port>.
  Binds loopback by default; the web UI starts threads that run bash, so only
  widen --host onto a network you trust.`,
    flags: { port: "string", host: "string", tick: "string" },
    async run(a, env) {
      const { startDaemon } = await import("./daemon.ts");
      const store = env.store();
      const d = await startDaemon({ store, wallet: await env.wallet(), port: portFrom(optStr(a.opts.port)), host: optStr(a.opts.host), tickMs: Number(a.opts.tick ?? 1000), log: env.out });
      env.out(`skein daemon on ${d.url} · db ${dbPath()}`);
      await new Promise<void>((resolve) => {
        const stop = async (sig: string) => {
          env.out(`${sig}: stopping`);
          await d.close();
          await store.close();
          resolve();
        };
        process.once("SIGINT", () => void stop("SIGINT"));
        process.once("SIGTERM", () => void stop("SIGTERM"));
      });
      return 0;
    },
  },

  new: {
    usage: `skein new "<prompt>" [--model provider/model] [--thinking off|low|medium|high]
          [--system <file>] [--watch] [--thinking-log]
  Send David's prompt as a new session and print the loop thread's CID (it runs
  when the daemon processes the message). Model and thinking default to
  ~/.skein/config.json. --watch follows it until it's your turn.`,
    flags: { model: "string", thinking: "string", system: "string", watch: "boolean", "thinking-log": "boolean" },
    async run(a, env) {
      const prompt = a.pos.join(" ").trim();
      if (!prompt) throw new UsageError("missing <prompt>");
      const thinking = optStr(a.opts.thinking);
      if (thinking && !THINKING.includes(thinking as never)) throw new UsageError(`--thinking must be one of ${THINKING.join("|")}`);
      const system = optStr(a.opts.system) && readFileSync(a.opts.system as string, "utf8");
      const { thread: t } = await newThread(env.store(), await env.wallet(), { prompt, model: optStr(a.opts.model), thinking, system: system || undefined });
      env.out(fmt(t));
      await poke(env, t);
      if (!a.opts.watch) return 0;
      // The thread exists once the daemon has processed the prompt.
      while (!(await env.store().has(t))) await env.sleep(200);
      return watch(env, t, { thinking: !!a.opts["thinking-log"], replay: true });
    },
  },

  ls: {
    usage: `skein ls [--all] [--state s,...] [--runner r] [--limit 50]
  Threads, most recent activity first. Default: the ones you started (no parent).`,
    flags: { all: "boolean", state: "string", runner: "string", limit: "string" },
    async run(a, env) {
      const rows = await listThreads(env.store(), {
        all: !!a.opts.all, state: list(a.opts.state) as ThreadState[] | undefined, runner: optStr(a.opts.runner),
        limit: a.opts.limit ? Number(a.opts.limit) : undefined,
      });
      env.out(formatLs(rows, env.now(), env.columns));
      return 0;
    },
  },

  show: {
    usage: `skein show <cid-or-prefix> [--thinking]
  A thread (states, steps, emissions, launches), a node, or any block as JSON.`,
    flags: { thinking: "boolean" },
    async run(a, env) {
      env.out(await formatShow(env.store(), await need(env, a), { thinking: !!a.opts.thinking, now: env.now() }));
      return 0;
    },
  },

  reply: {
    usage: `skein reply <cid-or-prefix> "<text>" [--watch] [--thinking-log]
  Answer the session (or the thread of the step) that is waiting on you.`,
    flags: { watch: "boolean", "thinking-log": "boolean" },
    async run(a, env) {
      const cid = await need(env, a);
      const text = a.pos.slice(1).join(" ").trim();
      if (!text) throw new UsageError("missing <text>");
      const store = env.store();
      // Prime the watcher first so it reports only what the reply causes.
      const root = (await threadOf(store, cid)) ?? cid;
      const w = a.opts.watch ? new Watcher(store, root) : undefined;
      if (w) await w.poll();
      const r = await reply(store, await env.wallet(), cid, text);
      env.out(`replied to ${short(r.thread)} (${fmt(r.message)})`);
      await poke(env, r.thread);
      if (!w) return 0;
      // Wait for the daemon to take the reply before watching for rest again.
      const before = fmt(await store.chains.tip(root));
      while (fmt(await store.chains.tip(root)) === before) await env.sleep(200);
      return watch(env, root, { thinking: !!a.opts["thinking-log"], watcher: w });
    },
  },

  watch: {
    usage: `skein watch <cid-or-prefix> [--replay] [--thinking]
  Follow a thread and everything it launched until it's your turn or it settles.
  --replay prints what already happened first.`,
    flags: { replay: "boolean", thinking: "boolean" },
    async run(a, env) {
      return watch(env, await need(env, a), { thinking: !!a.opts.thinking, replay: !!a.opts.replay });
    },
  },

  refs: {
    usage: `skein refs <cid-or-prefix>
  Pointers out of the block's chain, and pointers into it.`,
    flags: {},
    async run(a, env) {
      const store = env.store();
      const cid = await need(env, a);
      const origin = await store.chains.originOf(cid).catch(() => cid);
      const show = (r: Ref, other: unknown) => `  ${r.rel.padEnd(11)} ${isCID(other) ? fmt(other) : String(other)}${r.locator ? ` ${r.locator}` : ""}`;
      env.out(`from ${fmt(origin)}${origin.equals(cid) ? "" : " (the chain's origin)"}`);
      for (const r of await store.edges.refsFrom(origin)) env.out(show(r, r.to));
      env.out(`to ${fmt(cid)}`);
      for (const r of await store.edges.refsTo(cid)) env.out(show(r, r.from));
      return 0;
    },
  },

  rebuild: {
    usage: `skein rebuild
  Drop and rebuild the index (tips, edges) from the blocks.`,
    flags: {},
    async run(_a, env) {
      await env.store().edges.rebuild();
      env.out("index rebuilt");
      return 0;
    },
  },
};

const HELP = `skein — a content-addressed graph of threads

  skein run                       the daemon: runtime + services + web UI on :4322
  skein new "<prompt>" [--watch]  start a thread with the model
  skein ls [--all]                list threads
  skein show <cid>                a thread, node, or any block
  skein reply <cid> "<text>"      answer the thread waiting on you
  skein watch <cid>               follow a thread until it's your turn
  skein refs <cid>                pointers out of / into a block
  skein rebuild                   rebuild the index from blocks

CIDs may be given whole, or as a prefix of a thread/node origin (the 12
characters \`ls\` shows, with or without "bafy"). \`skein <cmd> --help\` for flags.
Env: SKEIN_HOME (~/.skein), SKEIN_DB ($SKEIN_HOME/skein.db), SKEIN_PORT (4322),
SKEIN_CONFIG, SKEIN_CWD (where tree-less commands run).`;

export async function main(argv: string[], over: Partial<Env> = {}): Promise<number> {
  let store: Store | undefined;
  const port = portFrom(argv.find((a, i) => argv[i - 1] === "--port") ?? argv.find((a) => a.startsWith("--port="))?.slice(7));
  const env: Env = {
    out: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`${l}\n`),
    store: () => (store ??= openDefaultStore()),
    wallet: openWallet,
    wake: (t) => wakeDaemon(port, t),
    port,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    columns: process.stdout.columns || 120,
    ...over,
  };
  const [name, ...rest] = argv;
  if (!name || name === "--help" || name === "-h" || name === "help") {
    env.out(HELP);
    return name ? 0 : 1;
  }
  const cmd = COMMANDS[name];
  if (!cmd) { env.err(`unknown command: ${name}\n\n${HELP}`); return 2; }
  try {
    const a = parseArgs(rest, cmd.flags);
    if (a.opts.help) { env.out(cmd.usage); return 0; }
    return await cmd.run(a, env);
  } catch (e) {
    env.err(e instanceof UsageError ? `${e.message}\n\n${cmd.usage}` : `skein ${name}: ${(e as Error).message}`);
    return e instanceof UsageError ? 2 : 1;
  } finally {
    if (store && name !== "run" && !over.store) await store.close();
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));

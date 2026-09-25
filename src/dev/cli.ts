#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// `skein-dev`: the developer's tools. OUTSIDE the machine: this process reads
// the disk and opens the runtime's store file directly, which the runtime
// itself never lets anything do. Two roles:
//
//   - client stand-in: `scan` hashes a directory into tree objects and `install`
//     puts the wasm modules into the store file directly (a real client would
//     send them as messages); `run` signs a message as admin and sends it over
//     the runtime's socket like any peer.
//   - inspection: `ls`, `show`, `refs`, `log`, `tree ls`, `rebuild` read the store.
//
// `sh` runs the wasm shell here, in this process, with a fixed clock and seed:
// a debugging aid, not the machine.

import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CID } from "multiformats/cid";
import { fmt, isCID, parse } from "../runtime/cid.ts";
import { readLog } from "../runtime/log.ts";
import { loadShellModules, MODULES, rawCid } from "../runtime/programs.ts";
import { openStore, type SqliteStore } from "../runtime/sqlite.ts";
import { lookup, readTree } from "../runtime/tree.ts";
import type { Ref, ThreadOrigin, ThreadUpdate } from "../runtime/types.ts";
import { connectWallet } from "../wallet.ts";
import { skeinHome, socketPath } from "../peers/connection.ts";
import { connectAs, run, type As } from "./admin.ts";
import { scan } from "./scan.ts";

const dbPath = () => process.env.SKEIN_DB || join(skeinHome(), "runtime.db");
const WASM_DIR = fileURLToPath(new URL("../../wasm/", import.meta.url));

function openDefault(): SqliteStore {
  mkdirSync(dirname(dbPath()), { recursive: true });
  return openStore(dbPath());
}

// ---------------------------------------------------------------- args

type FlagKind = "string" | "boolean";
interface Parsed { pos: string[]; opts: Record<string, string | boolean> }
class UsageError extends Error {}

function parseArgs(argv: string[], flags: Record<string, FlagKind>): Parsed {
  const out: Parsed = { pos: [], opts: {} };
  const all: Record<string, FlagKind> = { help: "boolean", ...flags };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { out.pos.push(...argv.slice(i + 1)); break; }
    if (a === "-h") { out.opts.help = true; continue; }
    if (!a.startsWith("--")) { out.pos.push(a); continue; }
    const eq = a.indexOf("=");
    const name = a.slice(2, eq < 0 ? undefined : eq);
    const kind = all[name];
    if (!kind) throw new UsageError(`unknown flag --${name}`);
    if (kind === "boolean") { out.opts[name] = true; continue; }
    const v = eq >= 0 ? a.slice(eq + 1) : argv[++i];
    if (v === undefined) throw new UsageError(`--${name} needs a value`);
    out.opts[name] = v;
  }
  return out;
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const short = (c: CID | string) => c.toString().slice(-12);
const text = (b: unknown) => (b instanceof Uint8Array ? Buffer.from(b).toString("utf8") : String(b ?? ""));

function jsonify(v: unknown): unknown {
  if (isCID(v)) return { "/": fmt(v) };
  if (v instanceof Uint8Array) return v.length <= 64 ? { bytes: Buffer.from(v).toString("hex") } : { text: text(v) };
  if (Array.isArray(v)) return v.map(jsonify);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonify(x)]));
  return v;
}

/** Put the shell's wasm modules into the store under their pinned CIDs. */
export async function install(store: Pick<SqliteStore, "has" | "putBlock">): Promise<string[]> {
  const out: string[] = [];
  for (const [name, cid] of Object.entries(MODULES)) {
    if (await store.has(cid)) continue;
    const bytes = await readFile(join(WASM_DIR, `${name}.wasm`));
    if (!rawCid(bytes).equals(cid)) throw new Error(`wasm/${name}.wasm does not match the pinned ${fmt(cid)} (rebuilt? update src/runtime/programs.ts)`);
    await store.putBlock(cid, bytes);
    out.push(`${name} ${fmt(cid)}`);
  }
  return out;
}

async function resolveCid(store: SqliteStore, s: string): Promise<CID> {
  try { return parse(s); } catch { /* a prefix or suffix */ }
  const all = await store.findByPrefix("");
  const hits = all.filter((c) => fmt(c).startsWith(s) || fmt(c).startsWith(`bafy${s}`) || fmt(c).endsWith(s));
  if (hits.length !== 1) throw new Error(hits.length ? `ambiguous: ${s}` : `no thread matches ${s}`);
  return hits[0];
}

// ---------------------------------------------------------------- commands

interface Env { out(l: string): void; err(l: string): void; write(fd: 1 | 2, b: Uint8Array): void }
interface Command { usage: string; flags: Record<string, FlagKind>; run(a: Parsed, env: Env): Promise<number> }

async function withStore<T>(fn: (s: SqliteStore) => Promise<T>): Promise<T> {
  const store = openDefault();
  try { return await fn(store); } finally { await store.close(); }
}

const COMMANDS: Record<string, Command> = {
  scan: {
    usage: `skein-dev scan <dir>
  Hash a directory into git tree/blob objects in the store file; print the root
  tree CID. Also installs the wasm modules if the store lacks them.`,
    flags: {},
    async run(a, env) {
      if (!a.pos[0]) throw new UsageError("missing <dir>");
      await withStore(async (store) => {
        for (const l of await install(store)) env.err(`installed ${l}`);
        env.out(fmt(await scan(store, a.pos[0])));
      });
      return 0;
    },
  },

  install: {
    usage: `skein-dev install
  Put wasm/brush.wasm and wasm/coreutils.wasm into the store file under their
  pinned CIDs (the shell program's modules).`,
    flags: {},
    async run(_a, env) {
      const done = await withStore(install);
      env.out(done.length ? done.map((l) => `installed ${l}`).join("\n") : "modules already in the store");
      return 0;
    },
  },

  run: {
    usage: `skein-dev run --tree <cid> [--cwd /path] [--as admin|david] -- '<command>'
  Send { kind: "run", cmd, tree } to the runtime over its socket, signed as
  admin (default) or david, and print the result it sends back.`,
    flags: { tree: "string", cwd: "string", as: "string" },
    async run(a, env) {
      const tree = str(a.opts.tree);
      if (!tree) throw new UsageError("missing --tree <cid>");
      const cmd = a.pos.join(" ");
      if (!cmd.trim()) throw new UsageError("missing '<command>'");
      const conn = await connectAs(await devWallet(), (str(a.opts.as) ?? "admin") as As);
      try {
        const r = await run(conn, { cmd, tree: parse(tree), cwd: str(a.opts.cwd) });
        env.err(`admitted as log entry ${fmt(r.entry)}`);
        const b = r.result.body as { exitCode?: number; stdout?: Uint8Array; stderr?: Uint8Array; tree?: CID; error?: { kind: string; message: string } };
        if (b.error) { env.err(`${b.error.kind}: ${b.error.message}`); return 1; }
        env.write(1, b.stdout ?? new Uint8Array());
        env.write(2, b.stderr ?? new Uint8Array());
        env.err(`exit ${b.exitCode} · tree ${b.tree ? fmt(b.tree) : "?"}`);
        return b.exitCode ?? 1;
      } finally { conn.close(); }
    },
  },

  sh: {
    usage: `skein-dev sh --tree <cid> [--cwd /path] [--time <ms>] [--seed n] -- '<command>'
  Run the wasm shell in THIS process over a tree in the store file, with a fixed
  clock and seed. Outside the machine: nothing is logged. The resulting tree's
  CID goes to stderr as "tree <cid>".`,
    flags: { tree: "string", cwd: "string", time: "string", seed: "string" },
    async run(a, env) {
      const tree = str(a.opts.tree);
      if (!tree) throw new UsageError("missing --tree <cid>");
      const { runShell } = await import("../runtime/shell.ts");
      return withStore(async (store) => {
        await install(store);
        const r = await runShell(store, {
          tree: parse(tree), cmd: a.pos.join(" "), cwd: str(a.opts.cwd), modules: await loadShellModules(store),
          time: a.opts.time ? Number(a.opts.time) : undefined, seed: a.opts.seed ? Number(a.opts.seed) : undefined,
        });
        env.write(1, r.stdout);
        env.write(2, r.stderr);
        env.err(`tree ${fmt(r.tree)}`);
        return r.exitCode;
      });
    },
  },

  tree: {
    usage: `skein-dev tree ls <cid> [path]   list a tree's entries (mode, cid, name)`,
    flags: {},
    async run(a, env) {
      const [sub, arg, path = ""] = a.pos;
      if (sub !== "ls" || !arg) throw new UsageError("usage: tree ls <cid> [path]");
      await withStore(async (store) => {
        const leaf = await lookup(store, parse(arg), path);
        if (!leaf) throw new Error(`no such path: ${path}`);
        if (leaf.mode !== "40000") { env.out(`${leaf.mode.padStart(6, "0")} ${fmt(leaf.cid)}\t${path}`); return; }
        for (const e of await readTree(store, leaf.cid)) env.out(`${e.mode.padStart(6, "0")} ${fmt(e.cid)}\t${e.name}`);
      });
      return 0;
    },
  },

  log: {
    usage: `skein-dev log [--limit n]
  The input log: position, admission stamp, entry CID (the last is the state hash), sender, kind.`,
    flags: { limit: "string" },
    async run(a, env) {
      await withStore(async (store) => {
        const all = await readLog(store);
        const lim = a.opts.limit ? Number(a.opts.limit) : all.length;
        for (const { cid, entry, message } of all.slice(-lim)) {
          const b = message.body as { kind?: unknown } | null;
          const when = new Date(entry.time[0] * 1000 + Math.floor(entry.time[1] / 1e6)).toISOString();
          env.out(`${String(entry.n).padStart(4)}  ${when}  ${fmt(cid)}  ${message.from.slice(0, 12)}  ${String(b?.kind ?? "?")}`);
        }
        const tip = await store.log.tip();
        env.out(`state ${tip ? fmt(tip) : "(empty)"} · processed ${await store.live.cursor.get()}/${all.length}`);
      });
      return 0;
    },
  },

  ls: {
    usage: `skein-dev ls [--limit 20]   threads, newest first: cid, state, command`,
    flags: { limit: "string" },
    async run(a, env) {
      await withStore(async (store) => {
        for await (const t of store.edges.query({ kind: "thread", limit: Number(a.opts.limit ?? 20) })) {
          const o = await store.get<ThreadOrigin>(t);
          const tip = await store.chains.tip(t);
          const u = tip.equals(t) ? undefined : await store.get<ThreadUpdate>(tip);
          env.out(`${short(t)}  ${(u?.state ?? "new").padEnd(8)}  ${(o.args as { cmd?: string } | undefined)?.cmd ?? ""}`);
        }
      });
      return 0;
    },
  },

  show: {
    usage: `skein-dev show <cid-or-suffix>   a thread (origin and updates) or any record as JSON`,
    flags: {},
    async run(a, env) {
      if (!a.pos[0]) throw new UsageError("missing <cid>");
      await withStore(async (store) => {
        const cid = await resolveCid(store, a.pos[0]);
        const b = await store.get<ThreadOrigin>(cid);
        env.out(`${fmt(cid)}\n${JSON.stringify(jsonify(b), null, 2)}`);
        if (b.kind !== "thread") return;
        for await (const u of store.chains.history(cid)) {
          if (u.equals(cid)) continue;
          const x = await store.get<ThreadUpdate>(u);
          const res = x.result as { exitCode?: number; stdout?: Uint8Array; stderr?: Uint8Array; tree?: CID } | undefined;
          env.out(`#${x.seq} ${x.state}${x.waitingFrom ? ` from ${x.waitingFrom.slice(0, 12)}` : ""}  input …${x.input ? short(x.input) : "?"}  ${fmt(u)}`);
          if (res) env.out(`  exit ${res.exitCode} · tree ${res.tree ? fmt(res.tree) : "?"}\n  stdout: ${text(res.stdout).trimEnd().replace(/\n/g, "\n          ")}${res.stderr?.length ? `\n  stderr: ${text(res.stderr).trimEnd()}` : ""}`);
          if (x.error) env.out(`  ${x.error.kind}: ${x.error.message}`);
        }
      });
      return 0;
    },
  },

  refs: {
    usage: `skein-dev refs <cid-or-suffix>   pointers out of the record's chain, and into it`,
    flags: {},
    async run(a, env) {
      if (!a.pos[0]) throw new UsageError("missing <cid>");
      await withStore(async (store) => {
        const cid = await resolveCid(store, a.pos[0]);
        const origin = await store.chains.originOf(cid).catch(() => cid);
        const line = (r: Ref, other: unknown) => `  ${r.rel.padEnd(11)} ${isCID(other) ? fmt(other) : String(other)}${r.locator ? ` ${r.locator}` : ""}`;
        env.out(`from ${fmt(origin)}`);
        for (const r of await store.edges.refsFrom(origin)) env.out(line(r, r.to));
        env.out(`to ${fmt(cid)}`);
        for (const r of await store.edges.refsTo(cid)) env.out(line(r, r.from));
      });
      return 0;
    },
  },

  rebuild: {
    usage: `skein-dev rebuild   drop and rebuild the index (tips, edges) from the records; the log is kept`,
    flags: {},
    async run(_a, env) {
      await withStore((store) => store.edges.rebuild());
      env.out("index rebuilt");
      return 0;
    },
  },
};

function devWallet() {
  return connectWallet(process.env.SKEIN_WALLET === "ephemeral" ? { kind: "ephemeral" } : { kind: "remote", url: process.env.SKEIN_WALLET_URL, originator: "skein" });
}

const HELP = `skein-dev — developer tools, outside the machine

  skein-dev scan <dir>                     hash a directory into the store file; print its tree CID
  skein-dev install                        put the wasm modules into the store file
  skein-dev run --tree <cid> -- '<cmd>'    send a run message as admin; print the result
  skein-dev sh --tree <cid> -- '<cmd>'     run the wasm shell locally (fixed clock), not the machine
  skein-dev log | ls | show <cid> | refs <cid> | tree ls <cid> | rebuild

Env: SKEIN_HOME (~/.skein), SKEIN_DB ($SKEIN_HOME/runtime.db), SKEIN_SOCKET
($SKEIN_HOME/runtime.sock), SKEIN_WALLET (remote|ephemeral), SKEIN_WALLET_URL.`;

export async function main(argv: string[]): Promise<number> {
  const env: Env = {
    out: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`${l}\n`),
    write: (fd, b) => void (fd === 1 ? process.stdout : process.stderr).write(b),
  };
  const [name, ...rest] = argv;
  if (!name || name === "--help" || name === "-h" || name === "help") { env.out(HELP); return name ? 0 : 1; }
  const cmd = COMMANDS[name];
  if (!cmd) { env.err(`unknown command: ${name}\n\n${HELP}`); return 2; }
  try {
    const a = parseArgs(rest, cmd.flags);
    if (a.opts.help) { env.out(cmd.usage); return 0; }
    return await cmd.run(a, env);
  } catch (e) {
    env.err(e instanceof UsageError ? `${e.message}\n\n${cmd.usage}` : `skein-dev ${name}: ${(e as Error).message}`);
    return e instanceof UsageError ? 2 : 1;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
export { socketPath };

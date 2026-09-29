#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// `skein-dev`: the developer's tools. OUTSIDE the machine: this process reads
// the disk and opens an instance's store file directly, which the kernel
// itself never lets anything do.
//
//   - bootstrap: `install` puts the pinned wasm modules into the store file
//     (they exceed a message; docs/OPEN.md). Trees and commands come from the
//     client (bin/skein) through the messagebox.
//   - inspection: `log`, `ls`, `show`, `refs` read the store.
//
// Replay is the kernel's: `skein-kernel replay <source.db> <out.db>`.

import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CID } from "multiformats/cid";
import { fmt, isCID, parse } from "../runtime/cid.ts";
import { readLog } from "../runtime/log.ts";
import { FILES, MODULES, rawCid } from "../runtime/programs.ts";
import type { SqliteStore } from "../runtime/sqlite.ts";
import { openStoreFile } from "../runtime/index-store.ts";
import type { Ref, ThreadOrigin, ThreadUpdate } from "../runtime/types.ts";

const skeinHome = () => process.env.SKEIN_HOME || join(homedir(), ".skein");
export const dbPath = () => process.env.SKEIN_DB || join(skeinHome(), "runtime.db");
const WASM_DIR = fileURLToPath(new URL("../../wasm/", import.meta.url));

function openDefault(path?: string): SqliteStore {
  const p = path || dbPath();
  mkdirSync(dirname(p), { recursive: true });
  return openStoreFile(p);
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
  const all = [...Object.entries(MODULES).map(([n, c]) => [`${n}.wasm`, c] as const), ...Object.entries(FILES)];
  for (const [file, cid] of all) {
    const name = file.replace(/\.wasm$/, "");
    if (await store.has(cid)) continue;
    const bytes = await readFile(join(WASM_DIR, file));
    if (!rawCid(bytes).equals(cid)) throw new Error(`wasm/${file} does not match the pinned ${fmt(cid)} (rebuilt? update src/runtime/programs.ts)`);
    await store.putBlock(cid, bytes);
    out.push(`${name} ${fmt(cid)}`);
  }
  return out;
}

export async function resolveCid(store: Pick<SqliteStore, "findByPrefix">, s: string): Promise<CID> {
  try { return parse(s); } catch { /* a prefix or suffix */ }
  const all = await store.findByPrefix("");
  const hits = all.filter((c) => fmt(c).startsWith(s) || fmt(c).startsWith(`bafy${s}`) || fmt(c).endsWith(s));
  if (hits.length !== 1) throw new Error(hits.length ? `ambiguous: ${s}` : `no thread matches ${s}`);
  return hits[0];
}

// ---------------------------------------------------------------- commands

interface Env { out(l: string): void; err(l: string): void; write(fd: 1 | 2, b: Uint8Array): void }
interface Command { usage: string; flags: Record<string, FlagKind>; run(a: Parsed, env: Env): Promise<number> }

async function withStore<T>(fn: (s: SqliteStore) => Promise<T>, path?: string): Promise<T> {
  const store = openDefault(path);
  try { return await fn(store); } finally { await store.close(); }
}

const COMMANDS: Record<string, Command> = {
  install: {
    usage: `skein-dev install
  Put the pinned wasm modules (the shell's brush, coreutils and tools, the
  wallet) into the store file under their CIDs: the bootstrap side door
  (docs/OPEN.md); objects bigger than a message cannot arrive any other way yet.`,
    flags: {},
    async run(_a, env) {
      const done = await withStore(install);
      env.out(done.length ? done.map((l) => `installed ${l}`).join("\n") : "modules already in the store");
      return 0;
    },
  },

  log: {
    usage: `skein-dev log [--limit n]
  The input log: position, admission stamp, entry CID (the last is the state hash), and what it admits.`,
    flags: { limit: "string" },
    async run(a, env) {
      await withStore(async (store) => {
        const all = await readLog(store);
        const lim = a.opts.limit ? Number(a.opts.limit) : all.length;
        for (const { cid, entry } of all.slice(-lim)) {
          const when = new Date(entry.time[0] * 1000 + Math.floor(entry.time[1] / 1e6)).toISOString();
          const what = entry.genesis ? `genesis ${fmt(entry.genesis)}` : entry.envelope ? `${entry.box} envelope ${fmt(entry.envelope)}`
            : entry.outcome ? `outcome ${entry.outcome.status} emit ${fmt(entry.outcome.emit)}${entry.outcome.reason ? `: ${entry.outcome.reason}` : ""}` : `wake ${entry.wake ? fmt(entry.wake) : "?"}`;
          env.out(`${String(entry.n).padStart(4)}  ${when}  ${fmt(cid)}  ${what}`);
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

};

const HELP = `skein-dev — developer tools, outside the machine

  skein-dev install                        put the pinned wasm modules into the store file (bootstrap)
  skein-dev log | ls | show <cid> | refs <cid>

Trees and commands come from the client (bin/skein import / run) through the
instance's front door. Replay: skein-kernel replay <source.db> <out.db>. Env: SKEIN_HOME (~/.skein), SKEIN_DB ($SKEIN_HOME/runtime.db).`;

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

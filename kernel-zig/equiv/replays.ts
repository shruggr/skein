// Replay equivalence: for each instance store, replay its log with no wallet
// on the TypeScript runtime (equiv/replay.ts) and on the Zig kernel
// (`skein-kernel replay`), each into a fresh store, and compare what the two
// runtimes did and derived — not how they store it (issue #30: the Zig store
// is blocks and a state record; the TS store keeps SQLite tables):
//
//   - the log entries (n, CID, the envelope/emit each is unique by) and the
//     records: every block the TS store holds, and nothing else but index
//     nodes and state records in the Zig store;
//   - the runtime's log lines, the emits handed to the outbox, the log tip;
//   - the derived state, asked of the TS tables in SQL and of the Zig index
//     through `skein-kernel dump`: chains and their tips, every update's
//     position, threads, resting threads (in resume order), sleepers (by
//     deadline), awaits, edges, heads, the cursor;
//   - the state record: the TS store's tables imported into the index
//     (`skein-kernel dump ts.db`) give the same state CID as the Zig replay's
//     own — the index is a function of the log — and so does the index
//     TypeScript builds from them (src/runtime/index-store.ts);
//   - the explorer: every page rendered over the TS replay's file and over
//     the Zig replay's file (read through index-store.ts) is the same.
//
// Also reports how each replay compares with the source store itself (thread
// and head tips), and the index's cost per log entry.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/replays.ts [--keep] <store.db>…
//
// Sources are copied first (with their -wal), never opened in place.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { buildIndex, hasStatePointer, openStoreFile } from "../../src/runtime/index-store.ts";
import { openStore } from "../../src/runtime/sqlite.ts";
import { render } from "../../src/dev/explore/server.ts";
import { load } from "../../src/dev/explore/view.ts";

const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL ?? join(here, "../zig-out/bin/skein-kernel");
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const sources = args.filter((a) => a !== "--keep");

type Derived = {
  entries: unknown[]; chains: unknown[]; updates: unknown[]; threads: unknown[]; resting: unknown[];
  sleepers: unknown[]; awaits: unknown[]; edges: unknown[]; heads: unknown[]; cursor: number; blocks: string[];
};
/** Compared in order (the order is part of the answer); the rest as sets. */
const ORDERED = new Set(["entries", "threads", "resting", "sleepers"]);
const KEYS = ["entries", "chains", "updates", "threads", "resting", "sleepers", "awaits", "edges", "heads", "cursor", "blocks"] as const;

const fmt = (b: unknown) => (b == null ? null : CID.decode(b as Uint8Array).toString());

/** The same questions, asked of the TypeScript runtime's tables. */
function derivedTs(db: string): Derived {
  const d = new DatabaseSync(db, { readOnly: true });
  const all = (q: string) => d.prepare(q).all();
  const block = (c: Uint8Array) => dagCbor.decode<Record<string, unknown>>(d.prepare("SELECT bytes FROM blocks WHERE cid = ?").get(c)!.bytes as Uint8Array);
  const heads: unknown[] = [];
  for (const r of all("SELECT origin, tip FROM chains WHERE kind = 'head' AND tip <> origin")) {
    const name = block(r.origin as Uint8Array).name;
    const tree = CID.asCID(block(r.tip as Uint8Array).tree);
    if (typeof name === "string" && tree) heads.push([name, tree.toString()]);
  }
  const out: Derived = {
    entries: all("SELECT n, cid, envelope FROM entries ORDER BY n").map((r) => [r.n, fmt(r.cid), fmt(r.envelope)]),
    chains: all("SELECT origin, tip, seq, kind FROM chains").map((r) => [fmt(r.origin), fmt(r.tip), r.seq, r.kind]),
    updates: all("SELECT origin, seq, cid FROM updates").map((r) => [fmt(r.origin), r.seq, fmt(r.cid)]),
    threads: all("SELECT origin FROM chains WHERE kind = 'thread' ORDER BY at, origin").map((r) => fmt(r.origin)),
    resting: all("SELECT origin FROM chains WHERE kind = 'thread' AND (state IS NULL OR state <> 'finished') ORDER BY at, origin").map((r) => fmt(r.origin)),
    sleepers: all("SELECT until, origin FROM chains WHERE kind = 'thread' AND state = 'waiting' AND until IS NOT NULL ORDER BY until, origin").map((r) => [r.until, fmt(r.origin)]),
    awaits: all("SELECT j.value AS env, c.origin FROM chains c, json_each(c.awaits) j WHERE c.kind = 'thread' AND c.awaits IS NOT NULL").map((r) => [r.env, fmt(r.origin)]),
    edges: all("SELECT \"from\" AS f, seq, ord, \"to\" AS t, rel, locator FROM edges").map((r) => [fmt(r.f), r.seq, r.ord, r.t, r.rel, r.locator]),
    heads,
    cursor: (all("SELECT value FROM meta WHERE key = 'cursor'")[0]?.value as number | undefined) ?? 0,
    blocks: all("SELECT cid FROM blocks ORDER BY cid").map((r) => fmt(r.cid)!),
  };
  d.close();
  return out;
}

type Dump = Derived & { state: string; log: string | null; roots: Record<string, string | null>; indexBlocks: number };
function dump(db: string): Dump {
  const r = spawnSync(kernel, ["dump", db], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`skein-kernel dump ${db}: ${r.stderr}`);
  return JSON.parse(r.stdout.toString());
}

function tips(d: Dump): Map<string, string> {
  const m = new Map<string, string>();
  for (const [o, t, , kind] of d.chains as Array<[string, string, number, string | null]>) if (kind === "thread" || kind === "head") m.set(`${kind} ${o}`, t);
  return m;
}

function compare(what: string, x: unknown[], y: unknown[], ordered: boolean): string | undefined {
  const xs = x.map((r) => JSON.stringify(r)), ys = y.map((r) => JSON.stringify(r));
  if (ordered) {
    const i = xs.findIndex((r, k) => r !== ys[k]);
    if (i < 0 && xs.length === ys.length) return undefined;
    const k = i >= 0 ? i : Math.min(xs.length, ys.length);
    return `${what}: ${xs.length} vs ${ys.length}, first difference at ${k}\n    ts:  ${xs[k]}\n    zig: ${ys[k]}`;
  }
  const sx = new Set(xs), sy = new Set(ys);
  const onlyTs = xs.filter((r) => !sy.has(r)), onlyZig = ys.filter((r) => !sx.has(r));
  if (!onlyTs.length && !onlyZig.length && xs.length === ys.length) return undefined;
  return `${what}: ${xs.length} vs ${ys.length}, ${onlyTs.length} only in ts, ${onlyZig.length} only in zig${onlyTs.length ? `\n    ts:  ${onlyTs.slice(0, 3).join("\n         ")}` : ""}${onlyZig.length ? `\n    zig: ${onlyZig.slice(0, 3).join("\n         ")}` : ""}`;
}

/** Every explorer page over the two files; the first that differs, if any. */
async function explorerDiff(tsPath: string, zigPath: string): Promise<string | undefined> {
  const x = openStoreFile(tsPath, { readOnly: true }), y = openStoreFile(zigPath, { readOnly: true });
  try {
    if (!("state" in y)) return "explorer: the Zig store did not open through the index";
    const w = await load(x);
    const pages = ["/", "/log", "/s", "/threads", "/h/main"];
    for (const t of w.threads) pages.push(`/t/${t.cid}`, `/r/${t.cid}`, ...t.updates.map(({ cid }) => `/r/${cid}`));
    for (const { cid } of w.log) pages.push(`/e/${cid}`);
    for (const p of pages) {
      const a = await render(x, new URL(p, "http://x")), b = await render(y, new URL(p, "http://x"));
      if (a.status !== b.status || a.body !== b.body) return `explorer: ${p} differs (status ${a.status} vs ${b.status})`;
    }
    explorerPages += pages.length;
    return undefined;
  } finally { await x.close(); await y.close(); }
}
let explorerPages = 0;

let allSame = true;
for (const source of sources) {
  const work = mkdtempSync(join(tmpdir(), "skein-kz-replay-"));
  const src = join(work, "src.db");
  copyFileSync(source, src);
  if (existsSync(`${source}-wal`)) copyFileSync(`${source}-wal`, `${src}-wal`);
  { const d = new DatabaseSync(src); d.exec("PRAGMA wal_checkpoint(TRUNCATE)"); d.close(); }
  const tsDb = join(work, "ts.db"), zigDb = join(work, "zig.db");

  let t0 = Date.now();
  const ts = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replay.ts"), src, tsDb], { maxBuffer: 1 << 30 });
  const tsMs = Date.now() - t0;
  t0 = Date.now();
  const zg = spawnSync(kernel, ["replay", src, zigDb], { maxBuffer: 1 << 30 });
  const zigMs = Date.now() - t0;
  const name = `${basename(dirname(source))}/${basename(source)}`;
  if (ts.status !== 0 && zg.status !== 0) {
    const why = (s: Buffer) => s.toString().split("\n").find((l) => /Error|error:/.test(l))?.trim() ?? "";
    process.stdout.write(`${name}: both refuse it (ts: ${why(ts.stderr)} · zig: ${why(zg.stderr)})\n`);
    rmSync(work, { recursive: true, force: true });
    continue;
  }
  if (ts.status !== 0 || zg.status !== 0) {
    allSame = false;
    process.stdout.write(`${name}: FAILED to replay (ts exit ${ts.status}, zig exit ${zg.status})\n${ts.stderr}\n${zg.stderr}\n`);
    continue;
  }
  const tj = JSON.parse(ts.stdout.toString()), zj = JSON.parse(zg.stdout.toString());
  const a = derivedTs(tsDb), b = dump(zigDb);
  const diffs: string[] = [];
  for (const k of KEYS) {
    const d = k === "cursor" ? (a.cursor === b.cursor ? undefined : `cursor: ${a.cursor} vs ${b.cursor}`) : compare(k, a[k] as unknown[], b[k] as unknown[], ORDERED.has(k));
    if (d) diffs.push(d);
  }
  const lineDiff = tj.lines.findIndex((l: string, i: number) => l !== zj.lines[i]);
  if (lineDiff >= 0 || tj.lines.length !== zj.lines.length) {
    const i = lineDiff >= 0 ? lineDiff : Math.min(tj.lines.length, zj.lines.length);
    diffs.push(`log lines differ at ${i} (${tj.lines.length} vs ${zj.lines.length}):\n    ts:  ${tj.lines[i]}\n    zig: ${zj.lines[i]}`);
  }
  if (JSON.stringify(tj.sent) !== JSON.stringify(zj.sent)) diffs.push(`sent: ${JSON.stringify(tj.sent)} vs ${JSON.stringify(zj.sent)}`);
  if (tj.state !== zj.state || (b.log ?? "") !== zj.state) diffs.push(`log tip: ts ${tj.state} vs zig ${zj.state} (index: ${b.log})`);
  const imported = dump(tsDb);
  if (imported.state !== b.state) diffs.push(`state record: the TS tables imported give ${imported.state}, the Zig replay has ${b.state}`);
  { const ts = openStore(tsDb, { readOnly: true }); const built = (await buildIndex(ts)).state.toString(); await ts.close(); if (built !== b.state) diffs.push(`state record: TypeScript builds ${built} from the TS tables, the Zig replay has ${b.state}`); }
  const pageDiff = await explorerDiff(tsDb, zigDb);
  if (pageDiff) diffs.push(pageDiff);
  // A store the Zig kernel wrote itself (serve.ts): the explorer over it, as over the replay of its log.
  if (hasStatePointer(src) && dump(src).state === b.state) {
    const srcDiff = await explorerDiff(tsDb, src);
    if (srcDiff) diffs.push(`${srcDiff} (the source store)`);
  }
  if (zj.index.record !== b.state) diffs.push(`state record: the replay ended at ${zj.index.record}, the store holds ${b.state}`);

  const want = tips(dump(src)), got = tips(b);
  let match = 0;
  for (const [k, v] of want) if (got.get(k) === v) match++;

  const n = a.entries.length;
  const cost = `index ${(zj.index.nodes / Math.max(n, 1)).toFixed(1)} nodes/entry (${(zj.index.bytes / Math.max(n, 1) / 1024).toFixed(1)} KiB) + ${(zj.index.states / Math.max(n, 1)).toFixed(1)} states/entry`;
  const counts = `${n} entries, ${a.chains.length} chains, ${a.updates.length} updates, ${a.blocks.length} blocks + ${b.indexBlocks} index, ${tj.lines.length} lines, ${tj.sent.length} sent`;
  if (diffs.length) {
    allSame = false;
    process.stdout.write(`${name}: DIFFERENT (${counts}; ts ${tsMs} ms, zig ${zigMs} ms)\n  ${diffs.join("\n  ")}\n`);
  } else {
    process.stdout.write(`${name}: identical (${counts}; ${cost}; ts ${tsMs} ms, zig ${zigMs} ms) · vs the source: ${match}/${want.size} thread/head tips\n`);
  }
  if (keep) process.stdout.write(`  kept ${work}\n`); else rmSync(work, { recursive: true, force: true });
}
process.stdout.write(`explorer: ${explorerPages} pages identical over the TS and the Zig replays' files\n`);
process.exit(allSame ? 0 : 1);

// Replay equivalence: for each instance store, replay its log with no wallet
// on the TypeScript runtime (equiv/replay.ts) and on the Zig kernel
// (`skein-kernel replay`), each into a fresh store, and compare: every row of
// every table (blocks, chains, updates, edges, entries, meta), the runtime's
// log lines, the emits handed to the outbox, the state hash. Also reports how
// each replay compares with the source store itself (thread and head tips).
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

const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL ?? join(here, "../zig-out/bin/skein-kernel");
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const sources = args.filter((a) => a !== "--keep");

const TABLES: Array<[string, string]> = [
  ["blocks", "SELECT hex(cid), hex(bytes) FROM blocks ORDER BY cid"],
  ["chains", "SELECT hex(origin), hex(tip), seq, kind, hex(thread), hex(launched_by), at, state, until, waiting_on, tip_at, hex(program), waiting_from, awaits FROM chains ORDER BY origin"],
  ["updates", "SELECT hex(cid), hex(origin), seq FROM updates ORDER BY cid"],
  ["edges", "SELECT hex(\"from\"), seq, ord, \"to\", rel, locator FROM edges ORDER BY \"from\", seq, ord"],
  ["entries", "SELECT n, hex(cid), hex(envelope) FROM entries ORDER BY n"],
  ["meta", "SELECT key, value FROM meta ORDER BY key"],
];

function dump(db: string): Record<string, string[]> {
  const d = new DatabaseSync(db, { readOnly: true });
  const out: Record<string, string[]> = {};
  for (const [t, q] of TABLES) out[t] = d.prepare(q).all().map((r) => JSON.stringify(Object.values(r)));
  d.close();
  return out;
}

function tips(db: string): Map<string, string> {
  const d = new DatabaseSync(db, { readOnly: true });
  const m = new Map<string, string>();
  for (const r of d.prepare("SELECT hex(origin) o, hex(tip) t, kind FROM chains WHERE kind IN ('thread', 'head')").all()) m.set(`${r.kind} ${r.o}`, r.t as string);
  d.close();
  return m;
}

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
  const name = basename(source);
  if (ts.status !== 0 || zg.status !== 0) {
    allSame = false;
    process.stdout.write(`${name}: FAILED to replay (ts exit ${ts.status}, zig exit ${zg.status})\n${ts.stderr}\n${zg.stderr}\n`);
    continue;
  }
  const tj = JSON.parse(ts.stdout.toString()), zj = JSON.parse(zg.stdout.toString());
  const a = dump(tsDb), b = dump(zigDb);
  const diffs: string[] = [];
  for (const [t] of TABLES) {
    const x = a[t], y = b[t];
    const sx = new Set(x), sy = new Set(y);
    const onlyTs = x.filter((r) => !sy.has(r)), onlyZig = y.filter((r) => !sx.has(r));
    if (onlyTs.length || onlyZig.length || x.length !== y.length) diffs.push(`${t}: ${x.length} vs ${y.length} rows, ${onlyTs.length} only in ts, ${onlyZig.length} only in zig${onlyTs.length ? `\n    ts:  ${onlyTs.slice(0, 3).join("\n         ")}` : ""}${onlyZig.length ? `\n    zig: ${onlyZig.slice(0, 3).join("\n         ")}` : ""}`);
  }
  const lineDiff = tj.lines.findIndex((l: string, i: number) => l !== zj.lines[i]);
  if (lineDiff >= 0 || tj.lines.length !== zj.lines.length) {
    const i = lineDiff >= 0 ? lineDiff : Math.min(tj.lines.length, zj.lines.length);
    diffs.push(`log lines differ at ${i} (${tj.lines.length} vs ${zj.lines.length}):\n    ts:  ${tj.lines[i]}\n    zig: ${zj.lines[i]}`);
  }
  if (JSON.stringify(tj.sent) !== JSON.stringify(zj.sent)) diffs.push(`sent: ${JSON.stringify(tj.sent)} vs ${JSON.stringify(zj.sent)}`);
  if (tj.state !== zj.state) diffs.push(`state: ${tj.state} vs ${zj.state}`);

  const want = tips(src), got = tips(zigDb);
  let match = 0;
  for (const [k, v] of want) if (got.get(k) === v) match++;

  const counts = `${a.entries.length} entries, ${a.chains.length} chains, ${a.updates.length} updates, ${a.blocks.length} blocks, ${tj.lines.length} lines, ${tj.sent.length} sent`;
  if (diffs.length) {
    allSame = false;
    process.stdout.write(`${name}: DIFFERENT (${counts}; ts ${tsMs} ms, zig ${zigMs} ms)\n  ${diffs.join("\n  ")}\n`);
  } else {
    process.stdout.write(`${name}: identical (${counts}; ts ${tsMs} ms, zig ${zigMs} ms) · vs the source: ${match}/${want.size} thread/head tips\n`);
  }
  if (keep) process.stdout.write(`  kept ${work}\n`); else rmSync(work, { recursive: true, force: true });
}
process.exit(allSame ? 0 : 1);

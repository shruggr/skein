// Replay equivalence, Zig against Zig (issue #5: from fuel on, the Zig kernel
// is its own reference; the TypeScript runtime is deleted, #55).
// For each store: replay its log with no wallet on the Zig kernel
// (`skein-kernel replay`, attested answers from the source's records) into
// a fresh store z1, then replay z1's log into z2, and require the two to be
// exactly the same:
//
//   - the replay reports: the runtime's log lines, the log tip, the final
//     state record;
//   - everything `skein-kernel dump` derives: the log entries, chains and
//     tips, every update (with its fuel), threads, resting threads in resume
//     order, sleepers, awaits, edges, heads, the cursor, fuel per thread and
//     in total, every record's CID, the state CID (which covers every index
//     node);
//   - `skein-kernel fuel`, the fuel query.
//
// Also: every step that ended (finished/errored/waiting) records its fuel,
// and a source the Zig kernel wrote itself (equiv/serve.ts; format 1) is
// reproduced exactly by its replay.
//
// The backends are not compared here: that is the storage interface test's
// (kernel-zig/src/store_iface_test.zig), once. A source may be a RocksDB set,
// `rocksdb:<db dir>#<set>`, read in place once the host process that wrote it
// is stopped (one process per database), or a set of a wasm host's SQLite
// database, `sqlite:<db>#<set>` (exported first).
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/replays.ts [--keep] <store.db | rocksdb:<dir>#<set> | sqlite:<db>#<set>>…
//
// SQLite sources are copied first (with their -wal), never opened in place.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { parseSqliteSpec } from "../../src/runtime/index-store.ts";
import { exportSet } from "../../src/host/store-sqlite.ts";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";

const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const sources = args.filter((a) => a !== "--keep");

type Dump = {
  state: string; cursor: number; log: string | null; roots: Record<string, string | null>;
  entries: unknown[]; chains: Array<[string, string, number, string | null]>; updates: Array<[string, number, string, number | null]>;
  threads: string[]; resting: string[]; sleepers: unknown[]; awaits: unknown[]; edges: unknown[]; heads: unknown[];
  fuel: { total: number; threads: Array<[string, number, number]> }; blocks: string[]; indexBlocks: number;
};
const KEYS = ["state", "cursor", "log", "roots", "entries", "chains", "updates", "threads", "resting", "sleepers", "awaits", "edges", "heads", "fuel", "blocks", "indexBlocks"] as const;

function run(cmd: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(kernel, cmd, { maxBuffer: 1 << 30 });
  return { status: r.status, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}
function dump(db: string): Dump {
  const r = run(["dump", db]);
  if (r.status !== 0) throw new Error(`skein-kernel dump ${db}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
function fuelReport(db: string): string {
  const r = run(["fuel", db]);
  if (r.status !== 0) throw new Error(`skein-kernel fuel ${db}: ${r.stderr}`);
  return r.stdout;
}

/** The first difference between two dumps, key by key. */
function dumpDiff(x: Dump, y: Dump, what: string): string[] {
  const out: string[] = [];
  for (const k of KEYS) {
    const a = JSON.stringify(x[k]), b = JSON.stringify(y[k]);
    if (a === b) continue;
    if (Array.isArray(x[k]) && Array.isArray(y[k])) {
      const xs = (x[k] as unknown[]).map((r) => JSON.stringify(r)), ys = (y[k] as unknown[]).map((r) => JSON.stringify(r));
      const i = xs.findIndex((r, j) => r !== ys[j]);
      const at = i >= 0 ? i : Math.min(xs.length, ys.length);
      out.push(`${what} ${k}: ${xs.length} vs ${ys.length}, first difference at ${at}\n    ${xs[at]}\n    ${ys[at]}`);
    } else out.push(`${what} ${k}: ${a.slice(0, 200)} vs ${b.slice(0, 200)}`);
  }
  return out;
}

/** A file the Zig kernel wrote in the current format (its state record has `format`). */
function isZigStore(db: string): boolean {
  if (db.startsWith("rocksdb:")) {
    if (run(["fuel", db]).status !== 0) return false;
    const x = dump(db);
    return x.updates.some((u) => u[3] !== null) || !x.chains.some((c) => c[3] === "thread");
  }
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    const t = d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pointers'").get();
    if (!t) return false;
    if (!d.prepare("SELECT 1 FROM pointers WHERE name = 'state'").get() || run(["fuel", db]).status !== 0) return false;
    // A step with fuel; or no thread at all (#51: entries nothing is subscribed to — recorded, nothing ran).
    const x = dump(db);
    return x.updates.some((u) => u[3] !== null) || !x.chains.some((c) => c[3] === "thread");
  } finally { d.close(); }
}

/**
 * #156: `d` (the dump of the SQLite file `db`) without the host chain's blocks: every host chain record
 * (`{kind: "host-chain"}`) the file holds and every block it reaches (its map nodes, its headers); the
 * index-node count less the ones among them.
 */
function withoutHostChain(d: Dump, db: string): Dump {
  const f = new DatabaseSync(db, { readOnly: true });
  try {
    const held = new Set<string>();
    const queue: CID[] = [];
    for (const row of f.prepare("SELECT cid, bytes FROM blocks").all() as Array<{ cid: Uint8Array; bytes: Uint8Array }>) {
      const c = CID.decode(row.cid);
      if (c.code !== 0x71) continue;
      try { if ((dagCbor.decode(row.bytes) as { kind?: unknown })?.kind === "host-chain") queue.push(c); } catch { /* not a record */ }
    }
    const links = (v: unknown, out: CID[]) => {
      const c = CID.asCID(v);
      if (c) { out.push(c); return; }
      if (Array.isArray(v)) for (const x of v) links(x, out);
      else if (v && typeof v === "object" && !(v instanceof Uint8Array)) for (const x of Object.values(v)) links(x, out);
    };
    while (queue.length) {
      const c = queue.pop()!;
      const k = c.toString();
      if (held.has(k)) continue;
      held.add(k);
      if (c.code !== 0x71) continue;
      const row = f.prepare("SELECT bytes FROM blocks WHERE cid = ?").get(c.bytes) as { bytes: Uint8Array } | undefined;
      if (row) links(dagCbor.decode(row.bytes), queue);
    }
    const blocks = d.blocks.filter((b) => !held.has(b));
    const index = [...held].filter((b) => !d.blocks.includes(b) && f.prepare("SELECT 1 FROM blocks WHERE cid = ?").get(CID.parse(b).bytes)).length;
    return { ...d, blocks, indexBlocks: d.indexBlocks - index };
  } finally { f.close(); }
}

let allSame = true;
for (const source of sources) {
  const work = mkdtempSync(join(tmpdir(), "skein-kz-replay-"));
  const rocksSource = source.startsWith("rocksdb:");
  const setSource = rocksSource;
  // The settled split: a set of a wasm host's SQLite database, `sqlite:<db>#<set>` — exported as a native kernel's store
  // file (its blocks, the host chain's, its pointers: store-sqlite.ts exportSet) and replayed natively from there: what the
  // wasm kernel wrote, reproduced by the native reference (requirement 1).
  const sqliteSet = source.startsWith("sqlite:");
  const src = setSource ? source : join(work, "src.db");
  if (sqliteSet) {
    const q = parseSqliteSpec(source)!;
    exportSet(q.db, q.set, src);
  } else if (!setSource) {
    copyFileSync(source, src);
    if (existsSync(`${source}-wal`)) copyFileSync(`${source}-wal`, `${src}-wal`);
    const d = new DatabaseSync(src); d.exec("PRAGMA wal_checkpoint(TRUNCATE)"); d.close();
  }
  const z1 = join(work, "z1.db"), z2 = join(work, "z2.db");
  const name = setSource || sqliteSet ? `${source.slice(source.lastIndexOf("#") + 1)} (${rocksSource ? "rocksdb" : "wasm host's sqlite"} set)` : `${basename(dirname(source))}/${basename(source)}`;

  let t0 = Date.now();
  const r1 = run(["replay", src, z1]);
  const ms1 = Date.now() - t0;
  t0 = Date.now();
  const r2 = r1.status === 0 ? run(["replay", z1, z2]) : r1;
  const ms2 = Date.now() - t0;
  if (r1.status !== 0 || r2.status !== 0) {
    allSame = false;
    process.stdout.write(`${name}: FAILED to replay (exit ${r1.status}, ${r2.status})\n${r1.stderr}\n${r2.stderr}\n`);
    continue;
  }
  const j1 = JSON.parse(r1.stdout), j2 = JSON.parse(r2.stdout);
  const d1 = dump(z1), d2 = dump(z2);
  const diffs: string[] = [];
  for (const k of ["lines", "state"] as const) if (JSON.stringify(j1[k]) !== JSON.stringify(j2[k])) diffs.push(`replay ${k} differ: ${JSON.stringify(j1[k]).slice(0, 300)} vs ${JSON.stringify(j2[k]).slice(0, 300)}`);
  if (j1.index.record !== j2.index.record) diffs.push(`state record: ${j1.index.record} vs ${j2.index.record}`);
  if (j1.index.record !== d1.state) diffs.push(`state record: the replay ended at ${j1.index.record}, the store holds ${d1.state}`);
  for (const l of [...j1.lines, ...j2.lines] as string[]) if (/DIVERGED|cannot run/.test(l)) { diffs.push(`replay: ${l}`); break; }
  // 0.9.1: a replay has no clock: its step lines carry the step's fuel, never a wall-clock time.
  for (const l of [...j1.lines, ...j2.lines] as string[]) if (/ step \d+ → /.test(l) && (/ ms · fuel /.test(l) || !/ · fuel \d+/.test(l))) { diffs.push(`replay step line (fuel only, no time): ${l}`); break; }
  diffs.push(...dumpDiff(d1, d2, "z1 vs z2"));
  if (fuelReport(z1) !== fuelReport(z2)) diffs.push("skein-kernel fuel differs");
  // Every step that ended records its fuel (thread chains; heads and subscriptions have none).
  const threadChains = new Set(d1.chains.filter((c) => c[3] === "thread").map((c) => c[0]));
  const missing = d1.updates.filter((u) => threadChains.has(u[0]) && u[3] === null);
  const ending = d1.updates.filter((u) => threadChains.has(u[0]) && u[3] !== null).length;
  // Only a `running` update (a step starting) carries no fuel.
  const running = missing.length;
  let exhausted = 0;
  {
    const d = new DatabaseSync(z1, { readOnly: true });
    type Rec = { state?: string; fuel?: number; error?: { kind: string; message: string }; genesis?: CID; defaults?: Record<string, string> };
    const block = (c: string | CID): Rec | undefined => {
      const row = d.prepare("SELECT bytes FROM blocks WHERE cid = ?").get((typeof c === "string" ? CID.parse(c) : c).bytes);
      return row ? dagCbor.decode(row.bytes as Uint8Array) as Rec : undefined;
    };
    for (const u of missing) {
      const st = block(u[2])?.state;
      if (st !== "running") { diffs.push(`update ${u[2]} (${st}) records no fuel`); break; }
    }
    // A step that ran out: errored, can't-do "fuel exhausted", its fuel the genesis's limit.
    const g = block(block((d1.entries[0] as [number, string])[1])!.genesis!);
    const limit = Number(g?.defaults?.fuelPerStep ?? 1e12);
    for (const u of d1.updates) {
      if (!threadChains.has(u[0]) || u[3] === null) continue;
      const r = block(u[2])!;
      if (r.error?.message !== "fuel exhausted") continue;
      exhausted++;
      if (r.state !== "errored" || r.error.kind !== "cant-do" || r.fuel !== limit) diffs.push(`update ${u[2]}: fuel exhausted but ${r.state}/${r.error.kind}, fuel ${r.fuel} (limit ${limit})`);
    }
    if (/fuel\.db$/.test(basename(source)) && exhausted === 0) diffs.push(`no step ran out of fuel (limit ${limit})`);
    d.close();
  }
  let fromSource = "";
  const zigSource = isZigStore(src);
  if (zigSource) {
    const ds = dump(src);
    // #156: the host chain's blocks are compared on neither side, for every store kind. A RocksDB set reads
    // the host chain through the host/chain set, which is not its own (its dump holds none of them); a wasm
    // host's set is exported with the whole host/chain set beside it; a serve instance's file holds its own
    // host chain; the replay (a fresh file) holds the blocks its `chain` events name.
    const sd = dumpDiff(rocksSource ? ds : withoutHostChain(ds, src), withoutHostChain(d1, z1), "source vs replay");
    diffs.push(...sd);
    fromSource = sd.length ? "" : " · the source store reproduced exactly";
  }
  const n = d1.entries.length;
  const counts = `${n} entries, ${d1.chains.length} chains, ${d1.updates.length} updates (${ending} with fuel, ${running} running${exhausted ? `, ${exhausted} out of fuel` : ""}), ${d1.blocks.length} blocks + ${d1.indexBlocks} index, ${j1.lines.length} lines; fuel ${d1.fuel.total}`;
  // A store with no thread ran no step: only its genesis (a mailbox nothing was delivered to: a handshake writes
  // nothing, #40), or entries nothing is subscribed to (#51: accepted libp2p messages, recorded, nothing runs).
  if (ending === 0 && threadChains.size > 0) diffs.push("no update records fuel");
  if (diffs.length) {
    allSame = false;
    process.stdout.write(`${name}: DIFFERENT (${counts})\n  ${diffs.join("\n  ")}\n`);
  } else {
    process.stdout.write(`${name}: identical (${counts}; ${ms1} ms, ${ms2} ms)${fromSource}\n`);
  }
  if (keep) process.stdout.write(`  kept ${work}\n`); else rmSync(work, { recursive: true, force: true });
}
process.exit(allSame ? 0 : 1);

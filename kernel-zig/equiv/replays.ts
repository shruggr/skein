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
//   - `skein-kernel fuel`, the billing query.
//
// Also: every step that ended (finished/errored/waiting) records its fuel,
// and a source the Zig kernel wrote itself (equiv/serve.ts; format 1) is
// reproduced exactly by its replay.
//
// Both backends (#96): the same log is also replayed into a set of a fresh
// LMDB environment, which must come to the same report and dump as z1 (the
// same state CID, the same CIDs); a SQLite source the Zig kernel wrote is
// also migrated into a set (`skein-kernel migrate`), whose dump must be the
// source's and whose replay must come to z1's state. A source may itself be
// an LMDB set, `lmdb:<env dir>#<set>`: read in place (read only).
//
// RocksDB (#158): the same log is also replayed into a set of a fresh RocksDB
// database (the same report and dump as z1), and a SQLite source the Zig
// kernel wrote, or an LMDB set, is migrated into one (`skein-kernel migrate
// --into rocksdb:<dir>`: the same dump; its replay z1's state). A source may
// be a RocksDB set, `rocksdb:<db dir>#<set>`, read in place once the host
// process that wrote it is stopped (one process per database).
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/replays.ts [--keep] <store.db | lmdb:<dir>#<set> | rocksdb:<dir>#<set>>…
//
// SQLite sources are copied first (with their -wal), never opened in place.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";

const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL ?? join(here, "../zig-out/bin/skein-kernel");
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
  if (db.startsWith("lmdb:") || db.startsWith("rocksdb:")) {
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
  const lmdbSource = source.startsWith("lmdb:");
  const rocksSource = source.startsWith("rocksdb:");
  const setSource = lmdbSource || rocksSource;
  const src = setSource ? source : join(work, "src.db");
  if (!setSource) {
    copyFileSync(source, src);
    if (existsSync(`${source}-wal`)) copyFileSync(`${source}-wal`, `${src}-wal`);
    const d = new DatabaseSync(src); d.exec("PRAGMA wal_checkpoint(TRUNCATE)"); d.close();
  }
  const z1 = join(work, "z1.db"), z2 = join(work, "z2.db");
  const name = setSource ? `${source.slice(source.lastIndexOf("#") + 1)} (${lmdbSource ? "lmdb" : "rocksdb"} set)` : `${basename(dirname(source))}/${basename(source)}`;

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
    // #156: a RocksDB set reads the host chain through the host/chain set, which is not its own; the
    // replay (a fresh file) holds the blocks its `chain` events name. Compared without those.
    const sd = dumpDiff(ds, rocksSource ? withoutHostChain(d1, z1) : d1, "source vs replay");
    diffs.push(...sd);
    fromSource = sd.length ? "" : " · the source store reproduced exactly";
  }
  // #96: the other backend — the same log replayed into a set of a fresh LMDB environment.
  t0 = Date.now();
  const zl = `lmdb:${join(work, "env")}#replay`;
  const rl = run(["replay", src, zl]);
  const msl = Date.now() - t0;
  if (rl.status !== 0) diffs.push(`replay into LMDB failed (exit ${rl.status}): ${rl.stderr.slice(0, 300)}`);
  else {
    const jl = JSON.parse(rl.stdout);
    for (const k of ["lines", "state"] as const) if (JSON.stringify(jl[k]) !== JSON.stringify(j1[k])) diffs.push(`LMDB replay ${k} differ from SQLite's`);
    if (jl.index.record !== j1.index.record) diffs.push(`state record: LMDB ${jl.index.record} vs SQLite ${j1.index.record}`);
    diffs.push(...dumpDiff(dump(zl), d1, "LMDB replay vs SQLite replay"));
  }
  // #96: migrate — a SQLite source the Zig kernel wrote, into a set: the same dump; its replay the same state.
  let migrated = "";
  if (!setSource && zigSource) {
    const zm = `lmdb:${join(work, "menv")}#migrated`;
    const m = run(["migrate", "--from", src, "--into", join(work, "menv"), "--set", "migrated"]);
    if (m.status !== 0) diffs.push(`migrate failed (exit ${m.status}): ${m.stderr.slice(0, 300)}`);
    else {
      const md = dumpDiff(dump(src), dump(zm), "source vs migrated");
      diffs.push(...md);
      const rm = run(["replay", zm, join(work, "zm.db")]);
      if (rm.status !== 0) diffs.push(`replay of the migrated set failed (exit ${rm.status})`);
      else if (JSON.parse(rm.stdout).index.record !== j1.index.record) diffs.push(`the migrated set's replay ends at ${JSON.parse(rm.stdout).index.record}, the source's at ${j1.index.record}`);
      if (!md.length) migrated = " · migrated to LMDB: the same dump and replay";
    }
  }
  // #158: RocksDB — the same log replayed into a set of a fresh database; a Zig source (a file, an LMDB set) migrated into one.
  t0 = Date.now();
  const zr = `rocksdb:${join(work, "rdb")}#replay`;
  const rr = run(["replay", src, zr]);
  const msr = Date.now() - t0;
  if (rr.status !== 0) diffs.push(`replay into RocksDB failed (exit ${rr.status}): ${rr.stderr.slice(0, 300)}`);
  else {
    const jr = JSON.parse(rr.stdout);
    for (const k of ["lines", "state"] as const) if (JSON.stringify(jr[k]) !== JSON.stringify(j1[k])) diffs.push(`RocksDB replay ${k} differ from SQLite's`);
    if (jr.index.record !== j1.index.record) diffs.push(`state record: RocksDB ${jr.index.record} vs SQLite ${j1.index.record}`);
    diffs.push(...dumpDiff(dump(zr), d1, "RocksDB replay vs SQLite replay"));
  }
  if (!rocksSource && zigSource) {
    const zm = `rocksdb:${join(work, "mrdb")}#migrated`;
    const m = run(["migrate", "--from", src, "--into", `rocksdb:${join(work, "mrdb")}`, "--set", "migrated"]);
    if (m.status !== 0) diffs.push(`migrate into RocksDB failed (exit ${m.status}): ${m.stderr.slice(0, 300)}`);
    else {
      const md = dumpDiff(dump(src), dump(zm), "source vs migrated (RocksDB)");
      diffs.push(...md);
      const rm = run(["replay", zm, join(work, "zrm.db")]);
      if (rm.status !== 0) diffs.push(`replay of the RocksDB-migrated set failed (exit ${rm.status})`);
      else if (JSON.parse(rm.stdout).index.record !== j1.index.record) diffs.push(`the RocksDB-migrated set's replay ends at ${JSON.parse(rm.stdout).index.record}, the source's at ${j1.index.record}`);
      if (!md.length) migrated += " · migrated to RocksDB: the same dump and replay";
    }
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
    process.stdout.write(`${name}: identical (${counts}; ${ms1} ms, ${ms2} ms; into LMDB ${msl} ms, into RocksDB ${msr} ms, the same)${fromSource}${migrated}\n`);
  }
  if (keep) process.stdout.write(`  kept ${work}\n`); else rmSync(work, { recursive: true, force: true });
}
process.exit(allSame ? 0 : 1);

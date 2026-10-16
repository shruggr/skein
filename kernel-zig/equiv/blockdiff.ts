// Temporary diagnostic (overlay-sync): for each store, the blocks the source holds that its replay does not, decoded.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { openStoreFile } from "../../src/runtime/index-store.ts";

const here = dirname(fileURLToPath(import.meta.url));
const kernel = join(here, "../zig-out/bin/skein-kernel");
const show = (v: unknown): unknown => v instanceof Uint8Array ? `bytes(${v.length}) ${Buffer.from(v.subarray(0, 24)).toString("hex")}` : CID.asCID(v) ? `cid ${String(v)}` : Array.isArray(v) ? v.slice(0, 12).map(show) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, show(x)])) : v;
for (const source of process.argv.slice(2)) {
  const work = mkdtempSync(join(tmpdir(), "blockdiff-"));
  const src = join(work, "src.db"), z1 = join(work, "z1.db");
  copyFileSync(source, src);
  if (existsSync(`${source}-wal`)) copyFileSync(`${source}-wal`, `${src}-wal`);
  { const d = new DatabaseSync(src); d.exec("PRAGMA wal_checkpoint(TRUNCATE)"); d.close(); }
  const r = spawnSync(kernel, ["replay", src, z1], { maxBuffer: 1 << 30 });
  if (r.status !== 0) { console.log(`${source}: replay failed ${r.stderr}`); continue; }
  const dump = (db: string) => JSON.parse(spawnSync(kernel, ["dump", db], { maxBuffer: 1 << 30 }).stdout.toString()) as { blocks: string[] };
  const have = new Set(dump(z1).blocks);
  const extra = dump(src).blocks.filter((b) => !have.has(b));
  console.log(`${source}: ${extra.length} block(s) only in the source`);
  const s = openStoreFile(src, { readOnly: true });
  for (const b of extra) {
    const c = CID.parse(b);
    const bytes = await s.bytes(c).catch(() => undefined);
    let v: unknown = bytes ? `${bytes.length} bytes` : "unreadable";
    if (bytes && c.code === 0x71) try { v = show(dagCbor.decode(bytes)); } catch { /* raw */ }
    console.log(`  ${b} codec 0x${c.code.toString(16)}: ${JSON.stringify(v)}`);
  }
  await s.close();
}

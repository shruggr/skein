// The TypeScript side of the replay equivalence: exactly what
// `skein-kernel replay <source.db> <out.db>` does, with the TS runtime. The
// log alone into a fresh store (the pinned modules installed, and every
// module the source holds), a Runtime with no wallet and the source's
// witness; prints {lines, sent, state}.
//
// A source the Zig kernel wrote (issue #30: blocks and a state record, no
// tables) is first turned into a store the TS runtime reads: its blocks, its
// log appended entry by entry (read through `skein-kernel dump`), and the
// TS index rebuilt from the blocks (sqlite.ts rebuild) for the witness.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/replay.ts <source.db> <out.db>

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { install } from "../../src/dev/cli.ts";
import { copyLog, type LogEntry } from "../../src/runtime/log.ts";
import { Runtime, witnessFrom } from "../../src/runtime/scheduler.ts";
import { openStore } from "../../src/runtime/sqlite.ts";

const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL ?? join(here, "../zig-out/bin/skein-kernel");
const [source, out] = process.argv.slice(2);

const raw = new DatabaseSync(source, { readOnly: true });
const tables = new Set(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));

let srcPath = source;
if (!tables.has("entries") && tables.has("pointers")) {
  srcPath = join(dirname(out), "ts-view.db");
  const view = openStore(srcPath);
  for (const r of raw.prepare("SELECT cid, bytes FROM blocks ORDER BY cid").iterate()) await view.putBlock(CID.decode(r.cid as Uint8Array), r.bytes as Uint8Array);
  const d = spawnSync(kernel, ["dump", source], { maxBuffer: 1 << 30 });
  if (d.status !== 0) throw new Error(`skein-kernel dump: ${d.stderr}`);
  for (const [, c] of JSON.parse(d.stdout.toString()).entries as Array<[number, string]>) {
    const cid = CID.parse(c);
    const got = await view.log.append(dagCbor.decode<LogEntry>(await view.bytes(cid)));
    if (!got.equals(cid)) throw new Error(`log entry ${c} appends as ${got}`);
  }
  await view.edges.rebuild();
  await view.close();
}

const src = openStore(srcPath, { readOnly: true });
const fresh = openStore(out);
await install(fresh);
for (const r of raw.prepare("SELECT cid, bytes FROM blocks ORDER BY cid").iterate()) {
  const cid = CID.decode(r.cid as Uint8Array);
  if (cid.code === 0x55) await fresh.putBlock(cid, r.bytes as Uint8Array);
}
raw.close();
await copyLog(src, fresh);

const lines: string[] = [];
const sent: string[] = [];
const rt = new Runtime({ store: fresh, witness: await witnessFrom(src), outbox: { send: (o) => { sent.push(o.emit.toString()); } }, log: (l) => lines.push(l) });
await rt.start();
await rt.idle();
await rt.stop();
const state = (await fresh.log.tip())?.toString() ?? "";
await fresh.close();
await src.close();
process.stdout.write(JSON.stringify({ lines, sent, state }) + "\n");

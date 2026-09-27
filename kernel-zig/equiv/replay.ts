// The TypeScript side of the replay equivalence: exactly what
// `skein-kernel replay <source.db> <out.db>` does, with the TS runtime. The
// log alone into a fresh store (the pinned modules installed, and every
// module the source holds), a Runtime with no wallet and the source's
// witness; prints {lines, sent, state}.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/replay.ts <source.db> <out.db>

import { DatabaseSync } from "node:sqlite";
import { CID } from "multiformats/cid";
import { install } from "../../src/dev/cli.ts";
import { copyLog } from "../../src/runtime/log.ts";
import { Runtime, witnessFrom } from "../../src/runtime/scheduler.ts";
import { openStore } from "../../src/runtime/sqlite.ts";

const [source, out] = process.argv.slice(2);
const src = openStore(source, { readOnly: true });
const fresh = openStore(out);
await install(fresh);
const raw = new DatabaseSync(source, { readOnly: true });
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

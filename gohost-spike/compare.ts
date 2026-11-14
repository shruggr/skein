// Feasibility spike: compare runs of the captured COMMIT. For each run (live, node, go): the reply
// (decoded), the pointers after it, the blocks it added over before.bundle, and among those the
// step's update (a block with `fuel` and `input`). Runs are equal when the reply bytes, every
// pointer and the set of blocks (CID → bytes) are identical.
//
//   node --experimental-strip-types --no-warnings gohost-spike/compare.ts <fixture dir> live node go
import * as fs from "node:fs";
import { join } from "node:path";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { MemoryStore, readBundle } from "../kernel-zig/web/kernel.js";

const dir = process.argv[2] ?? "gohost-spike/fixture";
const runs = process.argv.slice(3);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const load = (f: string) => readBundle(new Uint8Array(fs.readFileSync(join(dir, f))), new MemoryStore());
const before = load("before.bundle");

const show = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x) => {
  const c = CID.asCID(x); if (c) return c.toString();
  if (x instanceof Uint8Array) return `bytes:${hex(x)}`;
  if (typeof x === "bigint") return Number(x);
  return x;
}));

const summary: Record<string, { reply: string; pointers: string; blocks: string; added: number; update?: unknown; state?: string }> = {};
for (const r of runs) {
  const reply = new Uint8Array(fs.readFileSync(join(dir, `${r}-reply.cbor`)));
  const after = load(`${r}-after.bundle`);
  const added = [...after.blocks.keys()].filter((k) => !before.blocks.has(k)).sort();
  const ptrs = [...after.pointers].map(([n, c]) => `${n}=${hex(c)}`).sort();
  const all = [...after.blocks].map(([k, v]) => `${hex(Uint8Array.from(k, (c) => c.charCodeAt(0)))}:${hex(v)}`).sort();
  let update: unknown;
  for (const k of added) {
    try { const v = dagCbor.decode(after.blocks.get(k)!) as Record<string, unknown>; if (v && typeof v === "object" && "fuel" in v && "input" in v && "step" in v) update = show(v); } catch { /* raw */ }
  }
  const state = after.pointers.get("state");
  summary[r] = { reply: hex(reply), pointers: ptrs.join(","), blocks: all.join("|"), added: added.length, update, state: state ? CID.decode(state).toString() : undefined };
  console.log(`== ${r}`);
  console.log("reply", JSON.stringify(show(dagCbor.decode(reply))));
  console.log("pointers after:", ptrs.map((p) => { const [n, c] = p.split("="); try { return `${n}=${CID.decode(Buffer.from(c!, "hex")).toString()}`; } catch { return p; } }).join(" "));
  console.log("blocks added", added.length, "update", JSON.stringify(update));
}
const base = runs[0]!;
for (const r of runs.slice(1)) {
  const a = summary[base]!, b = summary[r]!;
  console.log(`${base} vs ${r}: reply ${a.reply === b.reply ? "SAME" : "DIFFERENT"}, pointers ${a.pointers === b.pointers ? "SAME" : "DIFFERENT"}, blocks ${a.blocks === b.blocks ? "SAME" : "DIFFERENT"}, update.fuel ${JSON.stringify((a.update as { fuel?: number })?.fuel)} / ${JSON.stringify((b.update as { fuel?: number })?.fuel)}`);
}

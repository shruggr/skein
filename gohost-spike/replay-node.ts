// Feasibility spike: the captured COMMIT on a fresh Node kernel (kernel-zig/web/kernel.js over a
// MemoryStore loaded from before.bundle) — exactly what the Go program does with wasmtime.
//
//   node --experimental-strip-types --no-warnings gohost-spike/replay-node.ts <fixture dir> [reps]
// Writes <fixture>/node-reply.cbor, node-after.bundle, node-notices.txt; prints the per-COMMIT time.
import * as fs from "node:fs";
import { join } from "node:path";
import { Kernel, MemoryStore, readBundle, writeBundle } from "../kernel-zig/web/kernel.js";

const dir = process.argv[2] ?? "gohost-spike/fixture";
const reps = Number(process.argv[3] ?? 5);
const wasm = fs.readFileSync(process.env.SKEIN_KERNEL_WASM ?? "kernel-zig/zig-out/web/skein-kernel.wasm");
const before = new Uint8Array(fs.readFileSync(join(dir, "before.bundle")));
const frame = new Uint8Array(fs.readFileSync(join(dir, "frame.cbor")));
const module = await WebAssembly.compile(wasm);

const times: number[] = [];
for (let i = 0; i < reps; i++) {
  const store = readBundle(before, new MemoryStore());
  const notices: string[] = [];
  const k = new Kernel(module, {
    stores: { 1: store },
    peers: {
      request: (op: string) => { notices.push(`request ${op}`); return { error: `no ${op}` }; },
      notify: (op: string, v: Uint8Array | string) => { notices.push(`notify ${op} ${typeof v === "string" ? v : Buffer.from(v).toString("hex")}`); },
    },
  });
  k.open(1);
  // The worker's order after a boot (wasm-worker.ts `start`): start, then drain.
  const started = k.start();
  k.drain();
  if (i === 0) fs.writeFileSync(join(dir, "node-start.cbor"), started);
  const t0 = performance.now();
  const reply = k.call(frame);
  const dt = performance.now() - t0;
  times.push(dt);
  if (i === 0) {
    fs.writeFileSync(join(dir, "node-reply.cbor"), reply);
    fs.writeFileSync(join(dir, "node-after.bundle"), writeBundle(store));
    fs.writeFileSync(join(dir, "node-notices.txt"), notices.join("\n") + "\n");
    console.log("stats", JSON.stringify(k.stats));
  }
}
console.log("node commit ms", times.map((x) => x.toFixed(2)).join(" "));

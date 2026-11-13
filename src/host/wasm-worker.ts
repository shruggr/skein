// One machine (the settled split, 2026-10-31): a node worker thread holding
// one wasm kernel (kernel-zig/zig-out/web/skein-kernel.wasm through the
// dependency-free shim kernel-zig/web/kernel.js) for ONE active instance — or
// the host's chain holder (#156: the header chain, kept once for the host). The
// host's main thread never runs a program; one step at a time here; instances
// in parallel on their own workers (wasm-kernel.ts).
//
// The kernel's store is a set of the host's one SQLite database (store-sqlite.ts,
// this worker's own connection); the apps' wasm runs in the same V8 through the
// shim's engine (the kernel names a module, the shim compiles and instantiates
// it with imports that call back into the kernel). The kernel's blocking
// request — the signer, `wallet` — goes to the main thread and this thread
// waits for the answer (Atomics.wait on a SharedArrayBuffer, the browser
// worker's way: kernel-zig/web/worker.js): the wallet the host holds the key
// in is asynchronous. Its notices (emit, say, panic) are posted to the main
// thread as they come.
//
// Messages in: {id, frame} (dag-cbor {op, v}) → {re: id, frame} (the reply:
// dag-cbor {ok} | {error, rejected?}). One at a time: `check` (CHECK, reads
// only) then `commit` (COMMIT: the entry written and its step run to
// completion inside the call) in order, as the main thread sends them (SPEC.md
// section 4: the Node host calls CHECK then COMMIT on the instance's worker).
// After a start the worker drains (the step loop) before it takes the next
// message. A request's thread that comes to rest after its commit was answered
// is the `answered` notice. `stop` closes the store and ends.

import { parentPort, workerData } from "node:worker_threads";
import * as dagCbor from "@ipld/dag-cbor";
import { Kernel, type ShimStore } from "../../kernel-zig/web/kernel.js";
import { openHostDb, SqliteSetStore } from "./store-sqlite.ts";

interface Data {
  module: WebAssembly.Module;
  db: string;
  set: string;
  mode: "instance" | "chain";
  network?: string;
  control: SharedArrayBuffer;
  data: SharedArrayBuffer;
}
const d = workerData as Data;
const port = parentPort!;
const enc = new TextEncoder();
const dec = new TextDecoder();

const db = openHostDb(d.db);
const stores: Record<number, ShimStore> = { 1: new SqliteSetStore(db, d.set) };
const ctrl = new Int32Array(d.control); // [0] answered, [1] status (0 ok, 1 error), [2] length

function request(op: string, v: Uint8Array): { ok: Uint8Array } | { error: string } {
  Atomics.store(ctrl, 0, 0);
  port.postMessage({ request: op, v });
  Atomics.wait(ctrl, 0, 0);
  const bytes = new Uint8Array(d.data, 0, ctrl[2]!).slice();
  return ctrl[1] === 0 ? { ok: bytes } : { error: dec.decode(bytes) };
}

let fatal = false;
const kernel = new Kernel(d.module, {
  stores,
  peers: {
    request,
    notify: (op, v) => {
      if (op === "panic") fatal = true;
      port.postMessage({ notify: op, v });
    },
  },
});

const reply = (v: unknown) => dagCbor.encode(v);
type Frame = { op: string; v?: unknown };

if (d.mode === "chain") {
  const net = kernel.push(d.network ?? "main");
  try { kernel.check(kernel.x.skein_open_chain!(1, net[0], net[1])); } finally { kernel.release(net); }
} else {
  kernel.open(1);
}

// ------------------------------------------------------------ the main thread's calls

function handle(id: number, f: Frame, raw: Uint8Array): void {
  switch (f.op) {
    case "start": {
      const r = kernel.start();
      port.postMessage({ re: id, frame: r });
      kernel.drain();
      return;
    }
    case "drain": {
      port.postMessage({ re: id, frame: kernel.drain() });
      return;
    }
    case "idle": port.postMessage({ re: id, frame: reply({ ok: null }) }); return; // nothing runs between calls
    case "chain-import": {
      // #156: the image's chain/headers read from the instance's set (read only), as store 2.
      const v = f.v as { set: string; root: unknown };
      stores[2] = new SqliteSetStore(db, v.set, { readOnly: true });
      try { port.postMessage({ re: id, frame: kernel.call(dagCbor.encode({ op: "chain-import", v: { root: v.root, store: 2 } })) }); } finally { delete stores[2]; }
      return;
    }
    case "stop": {
      db.close();
      port.postMessage({ re: id, frame: reply({ ok: null }) });
      process.exit(0);
    }
    default:
      port.postMessage({ re: id, frame: kernel.call(raw) });
  }
}

port.on("message", (m: { id: number; frame: Uint8Array }) => {
  const f = dagCbor.decode(m.frame) as Frame;
  try {
    handle(m.id, f, m.frame);
  } catch (e) {
    port.postMessage({ re: m.id, frame: reply({ error: `${f.op}: ${(e as Error)?.message ?? String(e)}` }) });
  }
  if (fatal) { try { db.close(); } catch { /* closing anyway */ } process.exit(1); }
});

port.postMessage({ ready: true });
void enc;

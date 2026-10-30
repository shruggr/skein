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
// dag-cbor {ok} | {error, rejected?}). After an admit or a start the worker
// drains (the step loop) before it takes the next message, so the main
// thread's next call sees what that ran. `answer` {entry, wait} answers once
// the request entry's thread is at rest, or at its bound with the state as it
// stands (serve's waiters, the same rule). `stop` closes the store and ends.

import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  wasmDir: string;
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
  // The pinned modules (the boundary programs), checked against their CIDs by the kernel (serve's install).
  const mods = dagCbor.decode(kernel.modulesList()) as Array<{ name: string; file: string; cid: { bytes: Uint8Array } }>;
  for (const m of mods) {
    if (stores[1]!.hasBlock(m.cid.bytes)) continue;
    kernel.putBlock(m.cid.bytes, readFileSync(join(d.wasmDir, m.file)));
  }
}

// ------------------------------------------------------------ waiters (`answer` with a bound)

type Waiter = { id: number; entry: unknown; until: number };
let waiters: Waiter[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

function answerOf(entry: unknown): Uint8Array {
  return kernel.call(dagCbor.encode({ op: "answer", v: entry }));
}
function atRest(r: Uint8Array): boolean {
  const s = (dagCbor.decode(r) as { ok?: { state?: string } }).ok?.state;
  return s === "finished" || s === "errored";
}
/** Answer the waiters whose thread came to rest, or whose bound has passed. */
function checkWaiters(): void {
  const now = Date.now();
  const keep: Waiter[] = [];
  for (const w of waiters) {
    const r = answerOf(w.entry);
    if (atRest(r) || w.until <= now) port.postMessage({ re: w.id, frame: r });
    else keep.push(w);
  }
  waiters = keep;
  if (timer) { clearTimeout(timer); timer = undefined; }
  if (waiters.length) timer = setTimeout(checkWaiters, Math.max(0, Math.min(...waiters.map((w) => w.until)) - Date.now()));
}

// ------------------------------------------------------------ the main thread's calls

function handle(id: number, f: Frame, raw: Uint8Array): void {
  switch (f.op) {
    case "admit": {
      const r = kernel.admit(dagCbor.encode(f.v));
      port.postMessage({ re: id, frame: r });
      const ok = (dagCbor.decode(r) as { ok?: unknown }).ok;
      if (ok && !(typeof ok === "object" && "answered" in (ok as object))) { kernel.drain(); checkWaiters(); }
      return;
    }
    case "start": {
      const r = kernel.start();
      port.postMessage({ re: id, frame: r });
      kernel.drain();
      checkWaiters();
      return;
    }
    case "drain": {
      port.postMessage({ re: id, frame: kernel.drain() });
      checkWaiters();
      return;
    }
    case "answer": {
      const v = f.v as { entry: unknown; wait?: number | bigint };
      const r = answerOf(v.entry);
      if (atRest(r) || Number(v.wait ?? 0) <= 0) { port.postMessage({ re: id, frame: r }); return; }
      waiters.push({ id, entry: v.entry, until: Date.now() + Number(v.wait) });
      checkWaiters();
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
      if (timer) clearTimeout(timer);
      for (const w of waiters) port.postMessage({ re: w.id, frame: answerOf(w.entry) });
      waiters = [];
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

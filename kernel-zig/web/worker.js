// The kernel's thread in the browser (issue #35): a module Worker holding the
// wasm kernel (kernel.js) and its stores. A Worker, because the kernel runs
// programs synchronously — `new WebAssembly.Module` of a program, and its
// host calls — which a page's main thread may not do for large modules, and
// because the kernel's requests to its host (wallet, resolve, http) must be
// answered while it waits: it posts the request and blocks on a
// SharedArrayBuffer (Atomics.wait) until the page has written the answer
// (client.js). That needs a cross-origin isolated page (COOP/COEP headers).
//
// Messages in: {id, method, args} → {id, result} | {id, error}.
// Messages out: {notify: op, v} (emit, say, panic) and
// {request: op, v} (answered through the shared buffer).

import { codecOf, Kernel, MemoryStore, readBundle, replayInto, writeBundle } from "./kernel.js";
import { IdbStore } from "./store.js";

const dec = new TextDecoder();
let kernel = null;
const stores = {};
let ctrl = null; // Int32Array over the control buffer: [0] ready flag, [1] status (0 ok, 1 error), [2] length
let data = null; // the answer's bytes (a growable SharedArrayBuffer)

function request(op, v) {
  Atomics.store(ctrl, 0, 0);
  postMessage({ request: op, v });
  Atomics.wait(ctrl, 0, 0);
  const bytes = new Uint8Array(data, 0, ctrl[2]).slice();
  return ctrl[1] === 0 ? { ok: bytes } : { error: dec.decode(bytes) };
}

const flushAll = async () => { for (const s of Object.values(stores)) await s.flushed?.(); };

const methods = {
  async init(wasm, control, answer) {
    ctrl = new Int32Array(control);
    data = answer;
    const bytes = typeof wasm === "string" ? new Uint8Array(await (await fetch(wasm)).arrayBuffer()) : wasm;
    kernel = new Kernel(await WebAssembly.compile(bytes), { stores, peers: { request, notify: (op, v) => postMessage({ notify: op, v }) } });
    return true;
  },
  /** Store `id` over the IndexedDB database `name` (loaded). */
  async openIdb(id, name) { stores[id] = await IdbStore.open(name); return stores[id].blocks.size; },
  /** Store `id` in memory, from a bundle (kernel.js readBundle) or empty. */
  openMemory(id, bundle, readOnly = false) { stores[id] = new MemoryStore({ readOnly }); if (bundle) readBundle(new Uint8Array(bundle), stores[id]); return stores[id].blocks.size; },
  async removeIdb(name) { await IdbStore.remove(name); return true; },
  closeStore(id) { stores[id]?.close?.(); delete stores[id]; return true; },
  /** The store as a bundle (to write it out: equiv); `records` leaves out the raw blocks (the modules, which a replay installs). */
  async bundle(id, records = false) {
    await stores[id].flushed?.();
    if (!records) return writeBundle(stores[id]);
    const s = new MemoryStore();
    for (const [cid, bytes] of stores[id].entries()) if (codecOf(cid) !== 0x55) s.blocks.set(String.fromCharCode(...cid), bytes);
    for (const [n, c] of stores[id].pointers) s.pointers.set(n, c);
    return writeBundle(s);
  },
  open(id) { kernel.open(id); return true; },
  modules() { return kernel.modulesList(); },
  hasBlock(id, cid) { return stores[id].hasBlock(cid); },
  putBlock(cid, bytes) { kernel.putBlock(cid, bytes); return true; },
  getBlock(cid) { return kernel.getBlock(cid); },
  call(frame) { return kernel.call(frame); },
  /** The one call in: admitted and durable before the answer (the host then acknowledges its source). */
  async admit(frame) { const r = kernel.admit(frame); await flushAll(); return r; },
  async start() { const r = kernel.start(); await flushAll(); return r; },
  async drain() { const r = kernel.drain(); await flushAll(); return r; },
  state() { return kernel.state(); },
  async replay(src, dst) { const t = performance.now(); const out = replayInto(kernel, src, dst); await flushAll(); return { report: out, ms: performance.now() - t, stats: kernel.stats }; },
};

onmessage = async (e) => {
  const { id, method, args } = e.data;
  try {
    const f = methods[method];
    if (!f) throw new Error(`no method ${method}`);
    postMessage({ id, result: await f(...(args ?? [])) });
  } catch (err) {
    postMessage({ id, error: err?.stack ?? String(err) });
  }
};

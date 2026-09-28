// The page's side of the kernel's Worker (issue #35, worker.js): method calls
// as promises, the kernel's notifications as a callback, and its blocking
// requests answered by an async handler — the answer written into the shared
// buffer the worker waits on. The page must be cross-origin isolated
// (COOP: same-origin, COEP: require-corp) for SharedArrayBuffer.

const enc = new TextEncoder();

export class KernelWorker {
  /**
   * `wasm`: the kernel's URL or bytes. `onRequest(op, bytes)` → Promise<Uint8Array>
   * (throw for an error answer); `onNotify(op, v)`.
   */
  constructor({ wasm, workerUrl = new URL("./worker.js", import.meta.url), onRequest, onNotify } = {}) {
    if (!globalThis.crossOriginIsolated && typeof window !== "undefined") throw new Error("the kernel's worker needs a cross-origin isolated page (COOP/COEP)");
    this.worker = new Worker(workerUrl, { type: "module" });
    this.control = new SharedArrayBuffer(12);
    this.ctrl = new Int32Array(this.control);
    this.answer = new SharedArrayBuffer(1 << 16, { maxByteLength: 1 << 30 });
    this.next = 1;
    this.waiting = new Map();
    this.onRequest = onRequest;
    this.onNotify = onNotify;
    this.worker.onmessage = (e) => this.onMessage(e.data);
    this.worker.onerror = (e) => { for (const w of this.waiting.values()) w.reject(new Error(`kernel worker: ${e.message}`)); this.waiting.clear(); };
    this.ready = this.call("init", typeof wasm === "string" ? new URL(wasm, globalThis.location?.href).href : wasm, this.control, this.answer);
  }

  call(method, ...args) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ id, method, args });
    });
  }

  async onMessage(m) {
    if (m.id !== undefined) {
      const w = this.waiting.get(m.id);
      if (!w) return;
      this.waiting.delete(m.id);
      if (m.error !== undefined) w.reject(new Error(m.error)); else w.resolve(m.result);
      return;
    }
    if (m.notify !== undefined) { try { this.onNotify?.(m.notify, m.v); } catch (e) { console.error(e); } return; }
    if (m.request !== undefined) {
      let status = 0, bytes;
      try {
        if (!this.onRequest) throw new Error(`this host answers no ${m.request}`);
        bytes = await this.onRequest(m.request, m.v);
      } catch (e) {
        status = 1;
        bytes = enc.encode(e?.message ?? String(e));
      }
      if (bytes.length > this.answer.byteLength) this.answer.grow(bytes.length);
      new Uint8Array(this.answer, 0, bytes.length).set(bytes);
      this.ctrl[1] = status;
      this.ctrl[2] = bytes.length;
      Atomics.store(this.ctrl, 0, 1);
      Atomics.notify(this.ctrl, 0);
    }
  }

  terminate() { this.worker.terminate(); }
}

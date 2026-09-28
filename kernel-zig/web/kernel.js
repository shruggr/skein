// The browser build's shim (issue #35): the JS around zig-out/web/skein-kernel.wasm.
// Dependency-free and synchronous, so it runs wherever V8 does (a Worker in the
// browser, node for the tests). It gives the kernel what it imports:
//
//   skein_engine   V8 as the kernel's engine: compile the (fuel-instrumented)
//                  program modules it hands over, instantiate them with an
//                  import object whose every function calls back into the
//                  kernel (skein_host_call), run them, trap → code, read and
//                  write their memory and their fuel counter
//   skein_store    stores by id: key→bytes + named pointers (MemoryStore here,
//                  IdbStore in store.js), with begin/commit/rollback
//   skein_peer     the host: request(op, v) answered synchronously (wallet,
//                  resolve, http — a Worker blocks on a SharedArrayBuffer while
//                  the page answers: worker.js), notify(op, v) (send,
//                  sleepers, onSleep, say, panic)
//
// and wraps the kernel's exports as methods (Kernel below). Values cross as
// dag-cbor bytes; decoding them is the caller's (the page bundles
// @ipld/dag-cbor; this file needs nothing).

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Thrown through a program's frames when the kernel aborts it (exit, a park, a fatal host error). */
class Abort extends Error {}
/** The kernel itself failed inside a host call: rethrown out of `run`, never reported as the program's trap. */
class KernelFault extends Error {
  constructor(cause) { super(`kernel fault: ${cause?.message ?? cause}`); this.cause = cause; }
}

const key = (b) => { let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; };
const unkey = (s) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; };

/**
 * A store in memory: blocks by CID, named pointers, and a transaction buffer
 * (reads see it; commit applies it, rollback drops it). `onCommit(batch)` is
 * told every applied batch in order — IdbStore makes it durable there.
 */
export class MemoryStore {
  constructor({ readOnly = false } = {}) {
    this.blocks = new Map();
    this.pointers = new Map();
    this.readOnly = readOnly;
    this.tx = null;
  }
  /** Every block (cid bytes, bytes) and pointer, e.g. to write the store out. */
  *entries() { for (const [k, v] of this.blocks) yield [unkey(k), v]; }
  pointer(name) { return this.pointers.get(name); }
  getBlock(cid) {
    const k = key(cid);
    if (this.tx?.blocks.has(k)) return this.tx.blocks.get(k);
    return this.blocks.get(k);
  }
  hasBlock(cid) { return this.getBlock(cid) !== undefined; }
  putBlock(cid, bytes) {
    if (this.readOnly) return false;
    const k = key(cid);
    if (this.hasBlock(cid)) return true;
    if (this.tx) this.tx.blocks.set(k, bytes);
    else this.apply({ blocks: new Map([[k, bytes]]), pointers: new Map() });
    return true;
  }
  getPointer(name) { return this.tx?.pointers.has(name) ? this.tx.pointers.get(name) : this.pointers.get(name); }
  setPointer(name, cid) {
    if (this.readOnly) return false;
    if (this.tx) this.tx.pointers.set(name, cid);
    else this.apply({ blocks: new Map(), pointers: new Map([[name, cid]]) });
    return true;
  }
  begin() { this.tx = { blocks: new Map(), pointers: new Map() }; }
  commit() { const t = this.tx; this.tx = null; if (t) this.apply(t); return true; }
  rollback() { this.tx = null; }
  apply(batch) {
    for (const [k, v] of batch.blocks) this.blocks.set(k, v);
    for (const [k, v] of batch.pointers) this.pointers.set(k, v);
    this.onCommit?.(batch);
  }
}

/** A codec of a binary CID (v1: version varint, codec varint), e.g. 0x55 raw. */
export function codecOf(cid) {
  let i = 0;
  const varint = () => { let x = 0, s = 0; for (;;) { const b = cid[i++]; x += (b & 0x7f) * 2 ** s; if (!(b & 0x80)) return x; s += 7; } };
  varint();
  return varint();
}

/**
 * The kernel: one wasm instance of skein-kernel.wasm, with its stores (by id)
 * and its host (`peers`: request(op, bytes) → {ok: bytes} | {error: string},
 * notify(op, bytes)). One runtime per instance (skein_open); replay uses two stores.
 */
export class Kernel {
  static async load(source, o) {
    const bytes = source instanceof Uint8Array || source instanceof ArrayBuffer ? source : new Uint8Array(await (await fetch(source)).arrayBuffer());
    const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(bytes);
    return new Kernel(module, o);
  }

  constructor(module, { stores = {}, peers = {} } = {}) {
    this.stores = stores;
    this.peers = peers;
    this.modules = [];
    this.instances = new Map();
    this.nextInstance = 1;
    this.engineError = "";
    this.held = new Uint8Array();
    this.stats = { compiled: 0, instances: 0, hostCalls: 0 };
    this.instance = new WebAssembly.Instance(module, this.imports());
    this.x = this.instance.exports;
  }

  // ---------------------------------------------------------------- kernel memory

  get mem() { return new Uint8Array(this.x.memory.buffer); }
  bytesAt(ptr, len) { return new Uint8Array(this.x.memory.buffer, ptr, len); }
  str(ptr, len) { return dec.decode(this.bytesAt(ptr, len)); }
  /** Copy bytes into a fresh kernel buffer: [ptr, len]; free with release. */
  push(bytes) {
    const b = typeof bytes === "string" ? enc.encode(bytes) : bytes;
    const p = b.length ? this.x.skein_alloc(b.length) : 0;
    if (b.length && !p) throw new Error("kernel: out of memory");
    if (b.length) this.bytesAt(p, b.length).set(b);
    return [p, b.length];
  }
  release([p, n]) { if (n) this.x.skein_free(p, n); }
  /** The kernel's result buffer, copied out. */
  result(n) { return n < 0 ? new Uint8Array() : this.bytesAt(this.x.skein_result(), n).slice(); }
  hold(b) { this.held = b; return b.length; }

  imports() {
    const k = this;
    const store = (id) => { const s = k.stores[id]; if (!s) throw new Error(`kernel: no store ${id}`); return s; };
    const guest = (h) => { const g = k.instances.get(h); if (!g) throw new Error(`kernel: no instance ${h}`); return g; };
    return {
      skein_store: {
        get(id, c, n) { const b = store(id).getBlock(k.bytesAt(c, n)); if (b === undefined) return -1; return k.hold(b); },
        take(p) { k.bytesAt(p, k.held.length).set(k.held); },
        has(id, c, n) { return store(id).hasBlock(k.bytesAt(c, n)) ? 1 : 0; },
        put(id, c, cn, b, bn) { return store(id).putBlock(k.bytesAt(c, cn).slice(), k.bytesAt(b, bn).slice()) ? 0 : -1; },
        begin(id) { store(id).begin(); },
        commit(id) { return store(id).commit() ? 0 : -1; },
        rollback(id) { store(id).rollback(); },
        pointer_get(id, p, n) { const c = store(id).getPointer(k.str(p, n)); if (c === undefined) return -1; return k.hold(c); },
        pointer_set(id, p, n, c, cn) { return store(id).setPointer(k.str(p, n), k.bytesAt(c, cn).slice()) ? 0 : -1; },
      },
      skein_engine: {
        compile(p, n, d, dn) { return k.compile(k.bytesAt(p, n), k.bytesAt(d, dn).slice()); },
        instantiate(h) { return k.instantiate(h); },
        run(inst, hasStart, e, en) { return k.run(inst, hasStart !== 0, k.str(e, en)); },
        release(inst) { k.instances.delete(inst); },
        fuel_get(inst) { return guest(inst).exports.__skein_fuel.value; },
        fuel_set(inst, v) { guest(inst).exports.__skein_fuel.value = v; },
        mem_read(inst, at, len, p) { k.bytesAt(p, len).set(new Uint8Array(guest(inst).exports.memory.buffer, at, len)); },
        mem_write(inst, at, len, p) { new Uint8Array(guest(inst).exports.memory.buffer, at, len).set(k.bytesAt(p, len)); },
        error_len() { return enc.encode(k.engineError).length; },
        error_take(p) { const b = enc.encode(k.engineError); k.bytesAt(p, b.length).set(b); },
      },
      skein_peer: {
        request(o, on, v, vn) {
          const op = k.str(o, on);
          let r;
          try { r = k.peers.request ? k.peers.request(op, k.bytesAt(v, vn).slice()) : { error: `this host answers no ${op}` }; } catch (e) { r = { error: e?.message ?? String(e) }; }
          if (r.ok) return k.hold(r.ok);
          return -k.hold(enc.encode(String(r.error ?? "no answer"))) - 1;
        },
        notify(o, on, v, vn) {
          const op = k.str(o, on);
          const b = k.bytesAt(v, vn).slice();
          try { k.peers.notify?.(op, op === "say" || op === "panic" ? dec.decode(b) : b); } catch { /* the host's problem */ }
        },
        take(p) { k.bytesAt(p, k.held.length).set(k.held); },
      },
    };
  }

  // ---------------------------------------------------------------- the engine: programs on V8

  compile(bytes, desc) {
    try {
      const module = new WebAssembly.Module(bytes);
      const kinds = [];
      for (let i = 0; i < desc.length; i += 5) kinds.push({ result: desc[i], first: desc[i + 1] | (desc[i + 2] << 8) | (desc[i + 3] << 16) | (desc[i + 4] << 24) });
      this.modules.push({ module, kinds, names: WebAssembly.Module.imports(module).filter((x) => x.kind === "function") });
      this.stats.compiled++;
      return this.modules.length - 1;
    } catch (e) {
      this.engineError = e?.message ?? String(e);
      return -1;
    }
  }

  instantiate(h) {
    const m = this.modules[h];
    const id = this.nextInstance++;
    const imports = {};
    const fns = [];
    const k = this;
    m.names.forEach((imp, i) => {
      const kind = m.kinds[i] ?? { result: 0, first: i };
      if (kind.first !== i) { (imports[imp.module] ??= {})[imp.name] = fns[kind.first]; return; }
      const index = i, result = kind.result;
      const f = function (...args) {
        const x = k.x;
        const a = new BigInt64Array(x.memory.buffer, x.skein_args(), 16);
        const n = Math.min(args.length, 16);
        for (let j = 0; j < n; j++) a[j] = typeof args[j] === "bigint" ? args[j] : BigInt(Math.trunc(args[j]));
        const g = k.instances.get(id);
        const memLen = g?.exports.memory ? g.exports.memory.buffer.byteLength : 0;
        let r;
        k.stats.hostCalls++;
        try { r = x.skein_host_call(id, index, n, memLen); } catch (e) { throw new KernelFault(e); }
        if (r !== 0) throw new Abort("skein: abort");
        const v = new BigInt64Array(x.memory.buffer, x.skein_args(), 1)[0];
        return result === 2 ? v : result === 1 ? Number(BigInt.asIntN(32, v)) : undefined;
      };
      fns[i] = f;
      (imports[imp.module] ??= {})[imp.name] = f;
    });
    try {
      const inst = new WebAssembly.Instance(m.module, imports);
      this.instances.set(id, inst);
      this.stats.instances++;
      return id;
    } catch (e) {
      this.engineError = e?.message ?? String(e);
      return -1;
    }
  }

  run(id, hasStart, entry) {
    const inst = this.instances.get(id);
    try {
      if (hasStart) inst.exports.__skein_start();
      const f = inst.exports[entry];
      if (typeof f !== "function") { this.engineError = `no ${entry}`; return -2; }
      f();
      return 0;
    } catch (e) {
      if (e instanceof KernelFault) throw e;
      if (e instanceof Abort) return 1;
      if (inst.exports.__skein_oog?.value) return 3;
      if (e instanceof WebAssembly.RuntimeError || e instanceof RangeError) { this.engineError = e.message; return 2; }
      this.engineError = e?.message ?? String(e);
      return -1;
    }
  }

  // ---------------------------------------------------------------- the kernel's exports

  /** Open store `id` and a runtime over it. */
  open(id) { this.check(this.x.skein_open(id)); }
  /** A call's return value: a failure (< 0) throws with the kernel's message. */
  check(r) { if (r < 0) throw new Error(`kernel: ${dec.decode(this.result(-r - 1))}`); return r; }
  /** The pinned modules and files: dag-cbor [{name, file, cid}]. */
  modulesList() { return this.result(this.x.skein_modules()); }
  putBlock(cid, bytes) {
    const c = this.push(cid), b = this.push(bytes);
    try { this.check(this.x.skein_put_block(c[0], c[1], b[0], b[1])); } finally { this.release(c); this.release(b); }
  }
  getBlock(cid) {
    const c = this.push(cid);
    try { const n = this.x.skein_get_block(c[0], c[1]); return n === -1 ? undefined : this.result(this.check(n)); } finally { this.release(c); }
  }
  /**
   * A serve op as a frame {op, v} (dag-cbor) → the reply frame (dag-cbor {ok} | {error, rejected}).
   * Among them the kernel's `call` (#40): {op: "call", v: {program, fn, arg, caller?, now?}} → ok {ok, result | error, fuel}.
   */
  call(frame) { const f = this.push(frame); try { return this.result(this.x.skein_call(f[0], f[1])); } finally { this.release(f); } }
  /** serve's admit ({entry, envelope?, body?}, dag-cbor) → the reply frame; not processed until drain. */
  admit(frame) { const f = this.push(frame); try { return this.result(this.x.skein_admit(f[0], f[1])); } finally { this.release(f); } }
  start() { return this.result(this.x.skein_start()); }
  drain() { return this.result(this.x.skein_drain()); }
  state() { return this.result(this.x.skein_state()); }
  nextDeadline() { const d = this.x.skein_next_deadline(); return d < 0n ? undefined : Number(d); }
  /** `skein-kernel replay`: store `src`'s log into store `dst` (its raw blocks put there first: replayInto). The JSON report. */
  replay(src, dst) {
    return dec.decode(this.result(this.check(this.x.skein_replay(src, dst))));
  }
}

/**
 * replay.zig's order: the destination gets every raw block of the source
 * (the modules it ran), then the kernel copies the log and runs it.
 */
export function replayInto(kernel, srcId, dstId) {
  const src = kernel.stores[srcId], dst = kernel.stores[dstId];
  for (const [cid, bytes] of src.entries()) if (codecOf(cid) === 0x55) dst.putBlock(cid, bytes);
  return kernel.replay(srcId, dstId);
}

/** Blocks as one binary stream: [u32 cid length][cid][u32 length][bytes]…, then the pointers as [u32 name length][name][u32 cid length][cid]… after a zero u32. */
export function readBundle(buf, store) {
  const d = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let i = 0;
  const u32 = () => { const v = d.getUint32(i, true); i += 4; return v; };
  for (;;) {
    const cn = u32();
    if (cn === 0) break;
    const cid = buf.subarray(i, i + cn); i += cn;
    const bn = u32();
    const bytes = buf.subarray(i, i + bn); i += bn;
    store.blocks.set(key(cid), bytes.slice());
  }
  while (i < buf.length) {
    const nn = u32();
    const name = dec.decode(buf.subarray(i, i + nn)); i += nn;
    const cn = u32();
    store.pointers.set(name, buf.slice(i, i + cn)); i += cn;
  }
  return store;
}

export function writeBundle(store) {
  const parts = [];
  let size = 4;
  for (const [cid, bytes] of store.entries()) { parts.push(cid, bytes); size += 8 + cid.length + bytes.length; }
  const ptrs = [...store.pointers].map(([n, c]) => [enc.encode(n), c]);
  for (const [n, c] of ptrs) size += 8 + n.length + c.length;
  const out = new Uint8Array(size);
  const d = new DataView(out.buffer);
  let i = 0;
  const put = (b) => { d.setUint32(i, b.length, true); i += 4; out.set(b, i); i += b.length; };
  for (let j = 0; j < parts.length; j += 2) { put(parts[j]); put(parts[j + 1]); }
  d.setUint32(i, 0, true); i += 4;
  for (const [n, c] of ptrs) { put(n); put(c); }
  return out;
}

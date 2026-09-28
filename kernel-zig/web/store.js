// The instance store over IndexedDB (issue #35): the kernel's key→bytes map
// and its `state` pointer (issue #30), one database per instance with two
// object stores, `blocks` (CID bytes → bytes) and `pointers` (name → CID
// bytes). The kernel reads synchronously, so the whole store is loaded into
// memory at open (a MemoryStore) and every committed batch is written behind,
// one readwrite transaction per batch, created at the commit — IndexedDB runs
// transactions over the same stores in creation order, so what is durable is
// always a prefix of what was committed, and the pointer never names a state
// whose blocks are not written. `flushed()` resolves once everything committed
// so far is durable: the host acknowledges an admission (to the messagebox it
// came from) only after that.

import { MemoryStore } from "./kernel.js";

const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

export class IdbStore extends MemoryStore {
  /** Open (or create) the database `name` and load it. */
  static async open(name, { idb = globalThis.indexedDB } = {}) {
    const open = idb.open(name, 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("blocks")) db.createObjectStore("blocks");
      if (!db.objectStoreNames.contains("pointers")) db.createObjectStore("pointers");
    };
    const db = await req(open);
    const s = new IdbStore();
    s.db = db;
    s.name = name;
    const t = db.transaction(["blocks", "pointers"], "readonly");
    const [keys, values, pkeys, pvalues] = await Promise.all([
      req(t.objectStore("blocks").getAllKeys()), req(t.objectStore("blocks").getAll()),
      req(t.objectStore("pointers").getAllKeys()), req(t.objectStore("pointers").getAll()),
    ]);
    for (let i = 0; i < keys.length; i++) s.blocks.set(keyOf(new Uint8Array(keys[i])), new Uint8Array(values[i]));
    for (let i = 0; i < pkeys.length; i++) s.pointers.set(pkeys[i], new Uint8Array(pvalues[i]));
    s.last = Promise.resolve();
    s.failed = null;
    s.onCommit = (batch) => s.writeBehind(batch);
    return s;
  }

  writeBehind(batch) {
    const t = this.db.transaction(["blocks", "pointers"], "readwrite");
    const blocks = t.objectStore("blocks"), pointers = t.objectStore("pointers");
    for (const [k, v] of batch.blocks) blocks.put(v, unkeyOf(k));
    for (const [k, v] of batch.pointers) pointers.put(v, k);
    const done = new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = t.onabort = () => { this.failed ??= t.error ?? new Error("IndexedDB write failed"); reject(this.failed); };
    });
    done.catch(() => {});
    this.last = this.last.then(() => done);
  }

  /** Everything committed so far is durable (or the first write failure). */
  async flushed() { await this.last; if (this.failed) throw this.failed; }

  close() { this.db.close(); }

  /** Delete the database `name`. */
  static async remove(name, { idb = globalThis.indexedDB } = {}) { await req(idb.deleteDatabase(name)); }
}

// MemoryStore's map key: the CID's bytes as a latin1 string (kernel.js).
function keyOf(b) { let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; }
function unkeyOf(s) { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; }

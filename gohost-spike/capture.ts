// Feasibility spike (not a host): capture one COMMIT that runs an app step, from the real Node host.
// A test host with instance `a` born owned, the test app installed at birth (as request.test.ts's
// hostWithApp); one owner-signed POST /ping (root row → next.main.handle: an app step). Just before
// the COMMIT reaches the instance's worker, the instance's set is dumped from the host's SQLite
// (blocks of the set and of host/chain, the set's pointers) in kernel.js's bundle format, with the
// frame exactly as the worker gets it (dag-cbor {op, v}). The live reply is kept beside it.
//
//   node --experimental-strip-types --no-warnings gohost-spike/capture.ts <out dir>
import * as fs from "node:fs";
import { join } from "node:path";
import { encode } from "../src/runtime/cid.ts";
import { CHAIN_SET } from "../src/runtime/index-store.ts";
import { WasmKernel } from "../src/host/wasm-kernel.ts";
import { openHostDb } from "../src/host/store-sqlite.ts";
import { imageTree, NEXT_APP, testHost } from "../src/host/testhost.ts";

const out = process.argv[2] ?? "gohost-spike/fixture";
fs.mkdirSync(out, { recursive: true });

const ROOT_ROWS = [{ kind: "request", path: "/ping", role: "user", handler: "next.main.handle" }];
const cleanups: Array<() => unknown> = [];
const t = { after(f: () => unknown) { cleanups.push(f); } };

function bundle(db: string, set: string): Uint8Array {
  const d = openHostDb(db, { readOnly: true });
  try {
    const blocks = d.prepare(`SELECT DISTINCT b.cid AS cid, b.bytes AS bytes FROM members m JOIN blocks b ON b.cid = m.cid WHERE m."set" = ? OR m."set" = ? ORDER BY b.cid`).all(set, CHAIN_SET) as Array<{ cid: Uint8Array; bytes: Uint8Array }>;
    const ptrs = d.prepare(`SELECT name, cid FROM pointers WHERE "set" = ? ORDER BY name`).all(set) as Array<{ name: string; cid: Uint8Array }>;
    const parts: Buffer[] = [];
    const put = (b: Uint8Array) => { const n = Buffer.alloc(4); n.writeUInt32LE(b.length); parts.push(n, Buffer.from(b)); };
    for (const r of blocks) { put(new Uint8Array(r.cid)); put(new Uint8Array(r.bytes)); }
    parts.push(Buffer.alloc(4));
    for (const p of ptrs) { put(new TextEncoder().encode(p.name)); put(new Uint8Array(p.cid)); }
    return Buffer.concat(parts);
  } finally { d.close(); }
}

const h = await testHost(t);
const img = await imageTree(join(h.home, "img"), { apps: [NEXT_APP], appRoutes: ROOT_ROWS });
await h.instance("a", img);
await h.router.start();
await h.router.settled();

let captured = false;
const orig = WasmKernel.prototype.call;
WasmKernel.prototype.call = async function (this: WasmKernel, op: string, v?: unknown) {
  if (op !== "commit" || captured) return orig.call(this, op, v);
  captured = true;
  const db = this.o.db.replace(/^sqlite:/, "").split("#")[0]!;
  fs.writeFileSync(join(out, "before.bundle"), bundle(this.host.db, this.o.handle));
  fs.writeFileSync(join(out, "frame.cbor"), encode({ op, v: v ?? null }).bytes);
  const r = await orig.call(this, op, v);
  fs.writeFileSync(join(out, "live-reply.cbor"), encode({ ok: r }).bytes);
  fs.writeFileSync(join(out, "live-after.bundle"), bundle(this.host.db, this.o.handle));
  void db;
  return r;
};

const r = await h.request("a", "POST", "/ping", {});
console.log("live answer status", r.answer.status, "captured", captured);
await h.router.settled();
for (const f of cleanups.reverse()) await f();
process.exit(0);

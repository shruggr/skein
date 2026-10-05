// Determinism across ABIs (issue #34): one log, one program, two builds of it.
// The source store's log is replayed by the Zig kernel twice — as written
// (the preview1 module) and with the program's component build run wherever
// the log runs that module (SKEIN_REPLAY_MODULE) — and the two runs must
// derive the same thing: the same threads, every update the same field for
// field except `fuel` and `prev` (the previous update's CID, which covers its
// fuel): the component's adapter and canonical-ABI glue are
// instructions of their own, so its fuel is its own), the same log lines and
// emits, and no DIVERGED: the attested calls (the signer, http) are asked
// with the very same requests, so the replay finds every answer in the
// record. The component's replay is then run again and must reproduce itself
// exactly, fuel and state record included.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/abi.ts <source.db> <module-cid> <component.wasm>

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CID } from "multiformats/cid";
import { openStoreFile } from "../../src/runtime/index-store.ts";

const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL ?? join(here, "../zig-out/bin/skein-kernel");
const [source, moduleCid, component] = process.argv.slice(2);
if (!source || !moduleCid || !component) throw new Error("usage: abi.ts <source.db> <module-cid> <component.wasm>");

let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };

const work = mkdtempSync(join(tmpdir(), "skein-kz-abi-"));
const src = join(work, "src.db");
copyFileSync(source, src);
if (existsSync(`${source}-wal`)) copyFileSync(`${source}-wal`, `${src}-wal`);

type Report = { lines: string[]; state: string; index: { record: string } };
function replay(out: string, env: Record<string, string> = {}): Report {
  const r = spawnSync(kernel, ["replay", src, out], { maxBuffer: 1 << 30, env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`skein-kernel replay: ${r.stderr}`);
  return JSON.parse(r.stdout.toString());
}
function dump(db: string): { chains: Array<[string, string, number, string | null]>; fuel: { total: number } } {
  const r = spawnSync(kernel, ["dump", db], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`skein-kernel dump: ${r.stderr}`);
  return JSON.parse(r.stdout.toString());
}

const sub = { SKEIN_REPLAY_MODULE: `${moduleCid}=${component}` };
const m = replay(join(work, "module.db"));
const c = replay(join(work, "component.db"), sub);
const c2 = replay(join(work, "component2.db"), sub);
const bad = (r: Report) => r.lines.filter((l) => /DIVERGED|cannot run|failed/.test(l));
check(bad(m).length === 0 && bad(c).length === 0, `no DIVERGED or failed step on either ABI${[...bad(m), ...bad(c)].map((l) => `\n    ${l}`).join("")}`);
check(JSON.stringify(m.lines) === JSON.stringify(c.lines), `the same ${m.lines.length} log lines`);
check(m.state === c.state, "the same log tip");
check(c.index.record === c2.index.record, `the component's replay reproduces itself exactly, fuel included (state record ${c.index.record.slice(-12)})`);

// Update by update, through the index.
const dm = dump(join(work, "module.db")), dc = dump(join(work, "component.db"));
const x = openStoreFile(join(work, "module.db"), { readOnly: true }), y = openStoreFile(join(work, "component.db"), { readOnly: true });
const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_, w) => (w instanceof Uint8Array ? Buffer.from(w).toString("hex") : w)));
let updates = 0, same = 0;
const origins = dm.chains.map((ch) => ch[0]);
check(JSON.stringify(origins) === JSON.stringify(dc.chains.map((ch) => ch[0])), `the same ${origins.length} chains`);
const firstDiff: string[] = [];
for (const o of origins) {
  const origin = CID.parse(o);
  const hx: CID[] = [], hy: CID[] = [];
  for await (const u of x.chains.history(origin)) hx.push(u);
  for await (const u of y.chains.history(origin)) hy.push(u);
  if (hx.length !== hy.length) { firstDiff.push(`${o}: ${hx.length} vs ${hy.length} records`); continue; }
  for (let i = 0; i < hx.length; i++) {
    if (hx[i].equals(origin)) continue;
    const a = plain(await x.get(hx[i])) as Record<string, unknown>, b = plain(await y.get(hy[i])) as Record<string, unknown>;
    updates++;
    const fa = { ...a }, fb = { ...b };
    // `prev` links the previous update by CID, and that CID covers its fuel.
    delete fa.fuel; delete fb.fuel; delete fa.prev; delete fb.prev;
    if (JSON.stringify(fa) === JSON.stringify(fb) && (a.fuel === undefined) === (b.fuel === undefined)) same++;
    else if (firstDiff.length < 3) firstDiff.push(`${o} #${i}:\n    ${JSON.stringify(fa).slice(0, 400)}\n    ${JSON.stringify(fb).slice(0, 400)}`);
  }
}
await x.close(); await y.close();
check(same === updates && firstDiff.length === 0, `every update identical but for fuel (and prev, the CID of the update before, which covers its fuel): ${same}/${updates}${firstDiff.map((d) => `\n  ${d}`).join("")}`);
process.stdout.write(`     fuel: module ${dm.fuel.total}, component ${dc.fuel.total} (the ABI glue's own instructions)\n`);

rmSync(work, { recursive: true, force: true });
process.stdout.write(failures ? `abi: ${failures} FAILED\n` : "abi: all ok\n");
process.exit(failures ? 1 : 0);

// The supervisor (supervisor.ts), which `skein-host run` uses for the
// explorers since the router (#33) holds the kernels: prefixed lines, a child
// that dies restarts after its backoff, stop ends them all and none comes back.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Supervisor } from "./supervisor.ts";

const CHILD = `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const f = process.env.STUB_DIR + "/starts";
const n = (existsSync(f) ? Number(readFileSync(f, "utf8")) : 0) + 1;
writeFileSync(f, String(n));
console.log("start " + n);
console.error("a line on stderr");
if (n === 1) process.exit(3);
console.log("skein runtime 02" + "a".repeat(64) + " (x@localhost) · pid " + process.pid);
process.on("SIGTERM", () => { console.log("SIGTERM: stopping"); process.exit(0); });
setInterval(() => {}, 1 << 30);
`;

async function until(what: string, f: () => boolean, ms = 8000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (f()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out: ${what}`);
}

test("supervisor: prefixed lines; a child that dies restarts; stop ends it and it does not come back", async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), "skein-sup-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(join(dir, "child.mjs"), CHILD);
  const out: string[] = [], err: string[] = [];
  const s = new Supervisor({ out: (l) => out.push(l), err: (l) => err.push(l), backoff: { baseMs: 50, maxMs: 200, stableMs: 60_000 }, killAfterMs: 3000 });
  const c = s.add({ name: "x explore", command: process.execPath, args: [join(dir, "child.mjs")], env: { STUB_DIR: dir } });
  await until("ready", () => c.ready);
  assert.equal(c.restarts, 1);
  assert.equal(c.identity, `02${"a".repeat(64)}`);
  assert.ok(out.includes("[x explore] start 2"), out.join("\n"));
  assert.ok(err.includes("[x explore] a line on stderr"));
  assert.ok(err.some((l) => /^\[x explore\] exited \(code 3\) after \d+ ms; again in 50 ms$/.test(l)), err.join("\n"));
  const p = c.proc!;
  await s.stop();
  assert.equal(p.exitCode, 0);
  assert.ok(out.includes("[x explore] SIGTERM: stopping"));
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(!c.running, "no restart after stop");
});

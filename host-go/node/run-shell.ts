// The Node host's side of host-go's equivalence tests: run runShell
// (src/runtime/shell.ts) over a SQLite store for a batch of cases, so the Go
// host's results can be compared byte for byte.
//
//   node --experimental-strip-types --no-warnings host-go/node/run-shell.ts <db> < cases.json > results.json
//   node --experimental-strip-types --no-warnings host-go/node/run-shell.ts <db> --scan <dir>   → tree CID
//
// A case is {cmd, tree, cwd?, env?: [[k, v], …], stdin?: base64, time?, seed?}; a
// result is {exitCode, stdout, stderr (base64), tree} or {error}.

import { readFileSync } from "node:fs";
import { CID } from "multiformats/cid";
import { openStore } from "../../src/runtime/sqlite.ts";
import { loadShellModules } from "../../src/runtime/programs.ts";
import { runShell } from "../../src/runtime/shell.ts";
import { scan } from "../../src/dev/scan.ts";

interface Case { cmd: string; tree: string; cwd?: string; env?: Array<[string, string]>; stdin?: string; time?: number; seed?: number }

const [db, flag, dir] = process.argv.slice(2);
const store = openStore(db);
if (flag === "--scan") {
  process.stdout.write(`${await scan(store, dir)}\n`);
} else {
  const modules = await loadShellModules(store);
  const cases = JSON.parse(readFileSync(0, "utf8")) as Case[];
  const out = [];
  for (const c of cases) {
    try {
      const r = await runShell(store, {
        tree: CID.parse(c.tree), cmd: c.cmd, cwd: c.cwd, modules,
        env: c.env ? Object.fromEntries(c.env) : undefined,
        stdin: c.stdin ? Buffer.from(c.stdin, "base64") : undefined,
        time: c.time, seed: c.seed,
      });
      const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
      out.push({ exitCode: r.exitCode, stdout: b64(r.stdout), stderr: b64(r.stderr), tree: r.tree.toString() });
    } catch (e) {
      out.push({ error: (e as Error).message });
    }
  }
  process.stdout.write(JSON.stringify(out));
}
await store.close();

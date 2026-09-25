// The runtime has no disk, network, process table, clock or randomness
// (docs/ARCH.md). This scans every non-test source file under src/runtime for
// imports and identifiers that would give it one, and fails on any hit.
// Allowed exceptions, each named:
//   - inbox.ts is the instance's edge to the host's messagebox: the runtime's
//     own tooling talking to the network (through @bsv/message-box-client,
//     which does the fetching). It may import ../envelope.ts (sealing and
//     verifying BRC-169 envelopes, shared with the client), use a timer (to
//     poll the boxes), and read the wall clock inside `createdOf` only through
//     Date.parse/new Date(<ms>) of an envelope's own `created` (not the clock;
//     the freshness check uses log.ts's now());
//   - main.ts may read process.env (its config: home, store path, wallet, keys,
//     messagebox), import ../wallet.ts (the wallet edge, which reaches
//     wallet-api over HTTP), and use timers (a wake entry at each sleeper's deadline);
//   - log.ts may read the wall clock (Date.now / process.hrtime): the runtime
//     stamps each admitted entry with its own time, and this is the only place.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));

const FORBIDDEN_MODULES = [
  "fs", "fs/promises", "child_process", "http", "https", "http2", "dns", "dgram", "net", "tls",
  "worker_threads", "cluster", "os", "inspector", "vm", "module", "process", "timers", "readline",
];

const FORBIDDEN_IDENTIFIERS: Array<[RegExp, string]> = [
  [/\bfetch\s*\(/, "fetch("],
  [/\bDate\.now\b/, "Date.now"],
  [/\bnew Date\s*\(/, "new Date("],
  [/\bperformance\.now\b/, "performance.now"],
  [/\bprocess\.hrtime\b/, "process.hrtime"],
  [/\bMath\.random\b/, "Math.random"],
  [/\brandomBytes\b/, "randomBytes"],
  [/\brandomUUID\b/, "randomUUID"],
  [/\bgetRandomValues\b/, "getRandomValues"],
  [/\bsetTimeout\b|\bsetInterval\b/, "timers"],
  [/\brequire\s*\(/, "require("],
  [/\bimport\s*\(/, "dynamic import("],
  [/\bprocess\.env\b/, "process.env"],
];

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    if (d.isDirectory()) return files(p);
    return d.name.endsWith(".ts") && !d.name.endsWith(".test.ts") ? [p] : [];
  });
}

/** Source with comments and string/template contents blanked, so prose can't trip the scan. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1")
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``");
}

function imports(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\b(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g)) out.push(m[1] ?? m[2]);
  return out;
}

export function violations(root = ROOT): string[] {
  const out: string[] = [];
  for (const f of files(root)) {
    const rel = relative(root, f);
    const src = readFileSync(f, "utf8");
    for (const spec of imports(src)) {
      const bare = spec.replace(/^node:/, "");
      if (FORBIDDEN_MODULES.includes(bare) || FORBIDDEN_MODULES.some((m) => bare.startsWith(`${m}/`))) {
        out.push(`${rel}: imports ${spec}`);
      }
      if (spec.startsWith(".")) {
        const target = relative(root, join(f, "..", spec));
        const allowed = (rel === "main.ts" && spec === "../wallet.ts") || (rel === "inbox.ts" && spec === "../envelope.ts");
        if (target.startsWith("..") && !allowed) out.push(`${rel}: imports ${spec} from outside src/runtime`);
      }
    }
    const body = code(src);
    for (const [re, name] of FORBIDDEN_IDENTIFIERS) {
      if (!re.test(body)) continue;
      if (name === "process.env" && rel === "main.ts") continue;
      if (name === "timers" && (rel === "main.ts" || rel === "inbox.ts")) continue;
      if ((name === "Date.now" || name === "process.hrtime") && rel === "log.ts") continue;
      out.push(`${rel}: uses ${name}`);
    }
  }
  return out;
}

test("isolation: src/runtime imports no disk, network, process, clock or randomness", () => {
  assert.deepEqual(violations(), []);
});

test("isolation: the scan catches what it should", () => {
  const probe = (src: string) => {
    const hits: string[] = [];
    for (const spec of imports(src)) if (FORBIDDEN_MODULES.includes(spec.replace(/^node:/, ""))) hits.push(spec);
    for (const [re, name] of FORBIDDEN_IDENTIFIERS) if (re.test(code(src))) hits.push(name);
    return hits;
  };
  assert.deepEqual(probe(`import { readFile } from "node:fs/promises";`), ["node:fs/promises"]);
  assert.deepEqual(probe(`import * as cp from "node:child_process";`), ["node:child_process"]);
  assert.deepEqual(probe(`const t = Date.now();`), ["Date.now"]);
  assert.deepEqual(probe(`await fetch("http://x")`), ["fetch("]);
  assert.deepEqual(probe(`// Date.now() in a comment is fine`), []);
  assert.deepEqual(probe("const s = `Math.random`;"), []);
});

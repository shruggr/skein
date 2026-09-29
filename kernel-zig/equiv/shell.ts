// Shell equivalence (host-go's method, its 64 cases, plus 7 for the script
// runtimes of issue #25; the cases are shell-cases.ts): the command lines
// through `skein-kernel shell`, compared byte for byte with the results
// recorded from the TypeScript shell before it was deleted (issue #55,
// shell-expected.json): stdout, stderr, exit code, tree CID.
// SKEIN_EQUIV_SHOW=1 prints what the script cases gave.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/shell.ts [skein-kernel]

import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { shellCases, type Out } from "./shell-cases.ts";

const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.argv[2] ?? join(here, "../zig-out/bin/skein-kernel");

const dir = await fs.mkdtemp(join(tmpdir(), "skein-kz-shell-"));
const { db, cases } = await shellCases(dir);
const expected = JSON.parse(readFileSync(join(here, "shell-expected.json"), "utf8")) as Array<{ cmd: string } & Out>;
if (expected.length !== cases.length || expected.some((e, i) => e.cmd !== cases[i]!.cmd)) {
  throw new Error("shell-expected.json does not list shell-cases.ts's cases in order: a case changed after the recording");
}

let t0 = Date.now();
const z = spawnSync(kernel, ["shell", db], { input: JSON.stringify(cases), maxBuffer: 1 << 30 });
const zigMs = Date.now() - t0;
if (z.status !== 0) { process.stderr.write(z.stderr); throw new Error(`skein-kernel shell exited ${z.status}`); }
const zig = JSON.parse(z.stdout.toString()) as Out[];

// Issue #34: the same cases with every tool that is a plain preview1 program
// (coreutils and the extras; not brush, which imports skein's spawn) turned
// into a WASI 0.2 component through the preview1 adapter and run as one by the
// kernel: both ABIs must give identical results. Needs wasm-tools and the
// adapter (kernel-zig/README.md, "Components"); skipped with a note if absent.
const adapter = process.env.SKEIN_WASI_ADAPTER ?? join(homedir(), ".local/wasi-adapter-v49.0.1/wasi_snapshot_preview1.command.wasm");
const wasmTools = process.env.WASM_TOOLS ?? "wasm-tools";
let compOk = true;
const haveTools = !process.env.SKEIN_EQUIV_NO_COMPONENTS && spawnSync(wasmTools, ["--version"]).status === 0 && existsSync(adapter);
if (haveTools) {
  const cdir = join(dir, "components");
  await fs.mkdir(cdir);
  const made: string[] = [];
  for (const t of ["coreutils", "find", "xargs", "diff", "jq", "which", "grep", "tree", "awk", "sed", "git", "qjs", "python"]) {
    const src = join(here, "../../wasm", `${t}.wasm`);
    const r = spawnSync(wasmTools, ["component", "new", src, "--adapt", `wasi_snapshot_preview1=${adapter}`, "-o", join(cdir, `${t}.wasm`)]);
    if (r.status === 0) made.push(t);
  }
  if (made.includes("diff")) await fs.copyFile(join(cdir, "diff.wasm"), join(cdir, "cmp.wasm")); // one module, two names
  t0 = Date.now();
  const zc = spawnSync(kernel, ["shell", db], { input: JSON.stringify(cases), maxBuffer: 1 << 30, env: { ...process.env, SKEIN_SHELL_COMPONENTS: cdir } });
  const compMs = Date.now() - t0;
  if (zc.status !== 0) { process.stderr.write(zc.stderr); throw new Error(`skein-kernel shell (components) exited ${zc.status}`); }
  const comp = JSON.parse(zc.stdout.toString()) as Out[];
  let csame = 0, cstatus = 0;
  const digits = (o: Out) => JSON.stringify({ ...o, stdout: Buffer.from(o.stdout ?? "", "base64").toString().replace(/\d+/g, "N") });
  const showc = (s?: string) => JSON.stringify(Buffer.from(s ?? "", "base64").toString("utf8"));
  cases.forEach((k, i) => {
    const a = zig[i]!, b = comp[i]!;
    if (JSON.stringify(a) === JSON.stringify(b)) { csame++; return; }
    if (k.statusAbove1 && digits(a) === digits(b)) { cstatus++; return; }
    process.stdout.write(`DIFF (component) ${JSON.stringify(k.cmd)}\n module: ${a.error ?? `exit ${a.exitCode} tree ${a.tree}\n  stdout ${showc(a.stdout)}\n  stderr ${showc(a.stderr)}`}\n  component: ${b.error ?? `exit ${b.exitCode} tree ${b.tree}\n  stdout ${showc(b.stdout)}\n  stderr ${showc(b.stderr)}`}\n`);
  });
  compOk = csame + cstatus === cases.length;
  process.stdout.write(`shell, tools as components (${made.join(" ")}): ${csame}/${cases.length} identical to the modules, ${cstatus} differing only in an exit status above 1 (the adapter's 0/1) (${compMs} ms including compile)\n`);
} else {
  process.stdout.write("shell, tools as components: skipped (no wasm-tools or preview1 adapter)\n");
}

let same = 0;
const show = (s?: string) => JSON.stringify(Buffer.from(s ?? "", "base64").toString("utf8"));
cases.forEach((k, i) => {
  const a = expected[i]!, b = zig[i]!;
  const eq = (a.error !== undefined && b.error !== undefined && a.error === b.error)
    || (a.error === undefined && b.error === undefined && a.exitCode === b.exitCode && a.stdout === b.stdout && a.stderr === b.stderr && a.tree === b.tree);
  if (eq) { same++; return; }
  process.stdout.write(`DIFF ${JSON.stringify(k.cmd)}\n expected: ${a.error ?? `exit ${a.exitCode} tree ${a.tree}\n  stdout ${show(a.stdout)}\n  stderr ${show(a.stderr)}`}\n  zig: ${b.error ?? `exit ${b.exitCode} tree ${b.tree}\n  stdout ${show(b.stdout)}\n  stderr ${show(b.stderr)}`}\n`);
});
if (process.env.SKEIN_EQUIV_SHOW) cases.forEach((k, i) => { if (i >= cases.length - 7) process.stdout.write(`${k.cmd.slice(0, 60)}\n  exit ${zig[i]!.exitCode} ${show(zig[i]!.stdout)} ${show(zig[i]!.stderr)}\n`); });
process.stdout.write(`shell: ${same}/${cases.length} identical to the recorded results (zig ${zigMs} ms including compile)\n`);
if (process.env.SKEIN_EQUIV_KEEP) { await fs.writeFile(join(dir, "cases.json"), JSON.stringify(cases)); process.stdout.write(`kept ${dir}\n`); } else await fs.rm(dir, { recursive: true, force: true });
process.exit(same === cases.length && compOk ? 0 : 1);

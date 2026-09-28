// Shell equivalence (host-go's method, its 64 cases, plus 7 for the script
// runtimes of issue #25): the same command lines over the same tree
// (src/runtime/shell.test.ts's fixture, plus a copy with a 2 MB file) through
// runShell on Node and through `skein-kernel shell`, compared byte for byte:
// stdout, stderr, exit code, tree CID. SKEIN_EQUIV_SHOW=1 prints what the
// script cases gave.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/shell.ts [skein-kernel]

import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CID } from "multiformats/cid";
import { install } from "../../src/dev/cli.ts";
import { scan } from "../../src/dev/scan.ts";
import { loadShellModules } from "../../src/runtime/programs.ts";
import { runShell } from "../../src/runtime/shell.ts";
import { openStore } from "../../src/runtime/sqlite.ts";

const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.argv[2] ?? join(here, "../zig-out/bin/skein-kernel");

// statusAbove1: the case prints a tool's exit status above 1 — which the
// preview1 adapter cannot carry (wasi:cli/exit takes ok/err: 0 or 1), so as
// components those digits may differ and nothing else may (issue #34).
interface Case { cmd: string; tree: string; cwd?: string; env?: Array<[string, string]>; stdin?: string; time?: number; seed?: number; statusAbove1?: boolean }
interface Out { exitCode?: number; stdout?: string; stderr?: string; tree?: string; error?: string }

const dir = await fs.mkdtemp(join(tmpdir(), "skein-kz-shell-"));
const db = join(dir, "store.db");
const tree = join(dir, "tree");
const files: Record<string, string> = { "a.txt": "one\ntwo\nthree\n", "sub/b.txt": "bee\n", "sub/deep/c.txt": "sea\n" };
for (const [p, s] of Object.entries(files)) {
  await fs.mkdir(dirname(join(tree, p)), { recursive: true });
  await fs.writeFile(join(tree, p), s);
}
await fs.symlink("a.txt", join(tree, "link"));
const store = openStore(db);
await install(store);
const tr = (await scan(store, tree)).toString();
const big = Buffer.alloc(2 << 20);
for (let i = 0; i < big.length; i++) big[i] = (i * 7919) & 0xff;
await fs.writeFile(join(tree, "big.bin"), big);
const bigTree = (await scan(store, tree)).toString();

const c = (cmd: string): Case => ({ cmd, tree: tr });
const hi = (k: Case): Case => ({ ...k, statusAbove1: true });
const b64 = (s: string) => Buffer.from(s).toString("base64");
const det = "date; echo $RANDOM $RANDOM; ls -la; head -c 16 /dev/stdin | od -c; sleep 1; date +%s > t; mktemp -u XXXXXX";
const cases: Case[] = [
  c("ls"), c("cat a.txt"), c("cat link"), c("cat sub/deep/c.txt"), c("mv a.txt b.txt"),
  c("echo hi > new.txt"),
  c("mkdir d && cp a.txt d/ && ls d"),
  c("echo x >> a.txt && rm link && ln -s sub/b.txt l2"),
  c("cat a.txt | wc -l"),
  c("printf '%s\\n' c b a b | sort | uniq | tr a-z A-Z"),
  c('x=$(head -1 a.txt); echo "got $x"'),
  c("seq 1 4 | while read n; do echo $((n*n)); done"),
  c("cat <<EOF\nhello $USER\nEOF"),
  c("yes | head -2; echo ${PIPESTATUS[@]}"),
  c("exit 3"), c("false"), c("cat nope"), c("nosuchcommand"),
  c("false | true; echo $?"), c("set -o pipefail; false | true; echo $?"),
  { cmd: det, tree: tr, stdin: b64("0123456789abcdefXYZ") },
  { cmd: "date -u +%FT%T", tree: tr, time: Date.UTC(2026, 8, 25, 12, 0, 0) },
  { cmd: "echo $RANDOM", tree: tr, seed: 7 }, c("echo $RANDOM"),
  c("cat /etc/passwd"), c("cd /; cd ..; cd ..; ls"), c("ls ../../.."),
  hi(c("echo gone > /dev/null; ls /dev 2>&1; echo $?")),
  { cmd: "pwd; ls; cat ../a.txt | head -1; /bin/true 2>/dev/null; echo $FOO", tree: tr, cwd: "/sub", env: [["FOO", "bar"]] },
  { cmd: "ls", tree: tr, cwd: "/nope" },
  c("printf '#!/bin/sh\\necho script $1\\n' > s.sh && bash s.sh one && ./s.sh two && sh -c 'echo nested'"),
  { cmd: "cp big.bin copy.bin && cat big.bin | cat > piped.bin && wc -c < big.bin && md5sum big.bin copy.bin piped.bin | cut -c1-32 | uniq | wc -l", tree: bigTree },
  c("ls -lai; ls -la sub sub/deep"),
  c("ls -R; wc a.txt sub/b.txt; realpath link sub/../sub/deep; readlink -f link; basename sub/b.txt .txt"),
  c("cp -r sub sub3 && ls -R sub3 && rm -r sub && ls && touch sub3/deep/new && ls sub3/deep"),
  c("ln a.txt hard && ls -i hard a.txt && echo more >> hard && cat a.txt hard"),
  c("type ls cat; command -v sort; type nosuch; echo $?"),
  c("./a.txt; echo $?; ./nope; echo $?"),
  c("rmdir sub; echo $?; mkdir x && rmdir x && ls"),
  c("touch z && truncate -s 5 z && od -c z && truncate -s 2 z && od -c z"),
  c("sort -r a.txt > r.txt; cat r.txt; sort -r a.txt > a.txt; cat a.txt; wc -c a.txt"),
  c("dd if=a.txt bs=1 skip=2 count=3 2>/dev/null; echo; tail -n1 a.txt; tail -c 4 a.txt"),
  c("mv sub sub2 && ls sub2/deep && mv sub2 sub2/deep; echo $?; mkdir e && mv e sub2/deep && ls -R sub2"),
  c("ln -s nowhere dangling && cat dangling; echo $?; echo made > dangling; cat nowhere; readlink dangling"),
  c("printf 'a\\0b' | od -An -c; echo -n abc | md5sum; seq 1000 | tail -1"),
  c("for i in 1 2 3; do echo $i > f$i; done; cat f*; ls | wc -l"),
  c("echo $(echo $(echo nested)); (cd sub && pwd); pwd"),
  c("ls /; cat /dev/null; echo ok > /dev/stdout; echo err > /dev/stderr"),
  { cmd: "cat; wc -c < /dev/stdin", tree: tr, stdin: b64("piped in\n") },
  c("printenv | sort; export X=1; printenv X"),
  c("echo $((RANDOM % 100)) $SRANDOM; shuf -n2 -e a b c d; mktemp; ls tmp* 2>/dev/null; ls"),
  c("test -x a.txt && echo exec; test -d sub && echo dir; [ -e nope ] || echo none; cut -c1-2 a.txt | paste -sd,"),
  c("mkdir -p src && printf '// TODO: fix\\nconst x = 1;\\n' > src/a.go && printf 'package p\\n// TODO later\\n' > src/sub.go && printf 'FOO bar\\n' > readme.md && printf 'nothing here\\n' > other.md && grep -rn TODO src/"),
  c("printf 'FOO bar\\n' > readme.md && printf 'nothing here\\n' > other.md && grep -il foo *.md"),
  c("mkdir -p src && printf 'x\\n' > src/a.go && printf 'x\\n' > src/sub.go && find . -name '*.go' | xargs wc -l"),
  c("which cat; which nosuchcmd; echo $?"),
  c("printf 'x\\nfoo x bar\\nx x x\\n' > f && sed -i 's/x/y/' f && cat f"),
  c("printf 'one\\ntwo\\nthree\\nfour\\n' > f && sed -n '2,4p' f"),
  c("printf 'a b\\nc d\\n' > f && awk '{print $2}' f"),
  c("printf 'a\\nb\\nc\\n' > x.txt && printf 'a\\nB\\nc\\n' > y.txt && diff x.txt y.txt"),
  c("printf 'same\\n' > x.txt && cp x.txt y.txt && cmp x.txt y.txt; echo $?"),
  c(`echo '{"name":"widget","id":3}' > file.json && jq .name file.json`),
  c(`echo '[{"id":"a"},{"id":"b"}]' > list.json && jq -r '.[] | .id' list.json`),
  c("mkdir -p src && printf 'TODO: a\\nkeep\\n' > src/one.txt && printf 'nothing\\nTODO: b\\n' > src/two.txt && grep -rl TODO src/ | xargs wc -l | sed -n '1,2p' | awk '{print $2, $1}'"),
  // Script runtimes (issue #25): qjs/node and python, by name and by `#!`;
  // argv, stdin, files in the tree, exit codes; the stdlib mount; clock and random.
  ...scriptCases(),
];

function scriptCases(): Case[] {
  const js = [
    "#!/usr/bin/env node",
    "const fs = require('fs'); const path = require('path');",
    "const input = fs.readFileSync(0, 'utf8');",
    "fs.mkdirSync('out', { recursive: true });",
    "fs.writeFileSync('out/js.txt', fs.readFileSync(path.join(__dirname, 'a.txt'), 'utf8').toUpperCase());",
    "console.log('js', process.argv.slice(2), input.trim(), { n: 1 }); console.error('to err');",
    "process.exitCode = 3;",
  ].join("\n");
  const py = [
    "#!/usr/bin/env python3",
    "import sys, os, json, pathlib",
    "data = pathlib.Path('a.txt').read_text()",
    "os.makedirs('out', exist_ok=True)",
    "json.dump({'lines': data.splitlines(), 'argv': sys.argv[1:], 'stdin': sys.stdin.read()}, open('out/py.json', 'w'), sort_keys=True)",
    "print('py', sys.argv[1:]); print('to err', file=sys.stderr)",
    "sys.exit(5)",
  ].join("\n");
  const ent = [
    "import time, random, os, uuid, datetime",
    "print(time.time(), time.monotonic(), datetime.datetime.now().isoformat())",
    "print(random.random(), os.urandom(4).hex(), hash('skein'), uuid.uuid4())",
  ].join("\n");
  const put = (name: string, body: string) => `echo ${b64(body + "\n")} | base64 -d > ${name}`;
  const js1 = put("t.js", js), py1 = put("t.py", py), e1 = put("e.py", ent);
  return [
    hi({ cmd: `${js1} && ./t.js a b <<< piped; echo "exit=$?"; node t.js c; echo "exit=$?"; cat out/js.txt`, tree: tr }),
    hi({ cmd: `${py1} && echo in | ./t.py a b; echo "exit=$?"; python t.py c < /dev/null; echo "exit=$?"; cat out/py.json`, tree: tr }),
    hi({ cmd: `qjs -e 'import("qjs:std").then((std) => { console.log(scriptArgs, std.getenv("HOME")); std.exit(4) })'; echo "exit=$?"; qjs -e 'throw new Error("boom")'; echo "exit=$?"`, tree: tr }),
    { cmd: `${e1} && python3 e.py; node -e 'console.log(Date.now(), new Date().toISOString(), Math.random())'`, tree: tr, time: Date.UTC(2023, 10, 14, 22, 13, 20), seed: 7 },
    { cmd: `node -e 'setTimeout((x) => console.log("later", x, Date.now()), 1500, 1); console.log("now", Date.now())'; python3 -c 'import time; time.sleep(2); print(time.time())'`, tree: tr },
    hi(c(`python3 -c 'import sys; print(sys.prefix, sys.path[1:3])'; python3 -c 'open("/opt/skein/python/lib/python314.zip", "ab")'; echo "exit=$?"; ls /opt; echo "exit=$?"`)),
    c(`node -e 'require("child_process")'; echo "exit=$?"; python3 -c 'import subprocess; subprocess.run(["ls"])' 2>&1 | tail -1`),
  ];
}

// Node: runShell over the store, one process for the batch.
const modules = await loadShellModules(store);
const node: Out[] = [];
let t0 = Date.now();
for (const k of cases) {
  try {
    const r = await runShell(store, {
      tree: CID.parse(k.tree), cmd: k.cmd, cwd: k.cwd, modules,
      env: k.env ? Object.fromEntries(k.env) : undefined,
      stdin: k.stdin ? Buffer.from(k.stdin, "base64") : undefined,
      time: k.time, seed: k.seed,
    });
    const e = (b: Uint8Array) => Buffer.from(b).toString("base64");
    node.push({ exitCode: r.exitCode, stdout: e(r.stdout), stderr: e(r.stderr), tree: r.tree.toString() });
  } catch (e) {
    node.push({ error: (e as Error).message });
  }
}
const nodeMs = Date.now() - t0;
await store.close();

t0 = Date.now();
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
    const a = zig[i], b = comp[i];
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
  const a = node[i], b = zig[i];
  const eq = (a.error !== undefined && b.error !== undefined && a.error === b.error)
    || (a.error === undefined && b.error === undefined && a.exitCode === b.exitCode && a.stdout === b.stdout && a.stderr === b.stderr && a.tree === b.tree);
  if (eq) { same++; return; }
  process.stdout.write(`DIFF ${JSON.stringify(k.cmd)}\n node: ${a.error ?? `exit ${a.exitCode} tree ${a.tree}\n  stdout ${show(a.stdout)}\n  stderr ${show(a.stderr)}`}\n  zig: ${b.error ?? `exit ${b.exitCode} tree ${b.tree}\n  stdout ${show(b.stdout)}\n  stderr ${show(b.stderr)}`}\n`);
});
if (process.env.SKEIN_EQUIV_SHOW) cases.forEach((k, i) => { if (i >= cases.length - 7) process.stdout.write(`${k.cmd.slice(0, 60)}\n  exit ${node[i].exitCode} ${show(node[i].stdout)} ${show(node[i].stderr)}\n`); });
process.stdout.write(`shell: ${same}/${cases.length} identical (node ${nodeMs} ms, zig ${zigMs} ms including compile)\n`);
if (process.env.SKEIN_EQUIV_KEEP) { await fs.writeFile(join(dir, "cases.json"), JSON.stringify(cases)); process.stdout.write(`kept ${dir}\n`); } else await fs.rm(dir, { recursive: true, force: true });
process.exit(same === cases.length && compOk ? 0 : 1);

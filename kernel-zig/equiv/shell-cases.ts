// The shell cases (host-go's method, its 64, plus 7 for the script runtimes
// of issue #25): the command lines and the tree they run over (a small tree,
// plus a copy with a 2 MB file), for equiv/shell.ts. Their expected results —
// stdout, stderr, exit code, tree CID — are shell-expected.json, recorded from
// the TypeScript shell (issue #55) before it was deleted; every CID here is
// content-derived, so the same cases give the same trees on any machine.

import * as fs from "node:fs/promises";
import { join, dirname } from "node:path";
import { install } from "../../src/dev/cli.ts";
import { scan } from "../../src/dev/scan.ts";
import { openStore } from "../../src/runtime/sqlite.ts";

// statusAbove1: the case prints a tool's exit status above 1 — which the
// preview1 adapter cannot carry (wasi:cli/exit takes ok/err: 0 or 1), so as
// components those digits may differ and nothing else may (issue #34).
export interface Case { cmd: string; tree: string; cwd?: string; env?: Array<[string, string]>; stdin?: string; time?: number; seed?: number; statusAbove1?: boolean }
export interface Out { exitCode?: number; stdout?: string; stderr?: string; tree?: string; error?: string }

/** Write the trees into `dir`, a store at `dir`/store.db holding them and the shell's modules; the cases over them. */
export async function shellCases(dir: string): Promise<{ db: string; cases: Case[] }> {
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
    ...scriptCases(tr, c, hi, b64),
  ];
  await store.close();
  return { db, cases };
}

function scriptCases(tr: string, c: (cmd: string) => Case, hi: (k: Case) => Case, b64: (s: string) => string): Case[] {
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


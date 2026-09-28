// Script runtimes in the shell (issue #25): qjs (QuickJS-ng, also `node`
// with the shim of wasm/tools/qjs/node.js) and python (CPython on WASI, also
// `python3`, stdlib mounted from wasm/python314.zip). Each runs a script from
// the tree: argv, stdin -> stdout, a file read and written in the tree, the
// exit code, and determinism (clock and random come from the runtime).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CID } from "multiformats/cid";
import { gitSha, readFile, type TreeBlocks } from "./tree.ts";
import { scan } from "../dev/scan.ts";
import { wasmModules } from "../testkit.ts";
import { runShell, type ShellOptions } from "./shell.ts";

class MapBlocks implements TreeBlocks {
  m = new Map<string, Uint8Array>();
  async has(cid: CID) { return this.m.has(cid.toString()); }
  async bytes(cid: CID) {
    const b = this.m.get(cid.toString());
    if (!b) throw new Error(`not found: ${cid}`);
    return b;
  }
  async putBlock(cid: CID, bytes: Uint8Array) {
    assert.equal(createHash("sha1").update(bytes).digest("hex"), gitSha(cid), "putBlock: cid does not match bytes");
    this.m.set(cid.toString(), bytes);
  }
}

const text = (b: Uint8Array) => Buffer.from(b).toString("utf8");

const JS_NODE = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const [name, ...rest] = process.argv.slice(2);
const input = fs.readFileSync(0, "utf8");
const data = fs.readFileSync(path.join(__dirname, "data.txt"), "utf8");
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/js.txt", data.toUpperCase());
console.log(\`hello \${name} [\${rest.join(",")}] stdin=\${input.trim()} lines=\${data.split("\\n").filter(Boolean).length}\`);
console.error("to stderr");
process.exitCode = 3;
`;

const JS_QJS = `import * as std from "qjs:std";
const input = std.in.readAsString();
const data = std.loadFile("data.txt");
std.writeFile("out/qjs.txt", data.split("\\n").reverse().join("\\n"));
console.log("qjs", scriptArgs.slice(1).join(" "), input.trim().length);
std.exit(4);
`;

const PY = `#!/usr/bin/env python3
import sys, os, json, pathlib
name, *rest = sys.argv[1:]
data = pathlib.Path("data.txt").read_text()
inp = sys.stdin.read()
os.makedirs("out", exist_ok=True)
with open("out/py.json", "w") as f:
    json.dump({"lines": data.splitlines(), "rest": rest}, f, sort_keys=True)
print(f"hello {name} {rest} stdin={inp.strip()} lines={len(data.splitlines())}")
print("to stderr", file=sys.stderr)
sys.exit(5)
`;

// What a run can observe of time and randomness: all from the runtime.
const PY_ENTROPY = `import time, random, os, uuid, datetime
print(time.time(), time.monotonic(), datetime.datetime.now().isoformat())
print(random.random(), os.urandom(4).hex(), hash("skein"), uuid.uuid4())
`;
const JS_ENTROPY = `console.log(Date.now(), new Date().toISOString(), Math.random())`;

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fs.mkdtemp(join(tmpdir(), "skein-scripts-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(join(dir, "data.txt"), "alpha\nbeta\ngamma\n");
  await fs.writeFile(join(dir, "tool.js"), JS_NODE, { mode: 0o755 });
  await fs.writeFile(join(dir, "tool.mjs"), JS_QJS);
  await fs.writeFile(join(dir, "tool.py"), PY, { mode: 0o755 });
  await fs.writeFile(join(dir, "entropy.py"), PY_ENTROPY);
  await fs.writeFile(join(dir, "entropy.js"), JS_ENTROPY);
  await fs.mkdir(join(dir, "out"));
  await fs.writeFile(join(dir, "out/.keep"), "");
  const blocks = new MapBlocks();
  const tree = await scan(blocks, dir);
  const modules = await wasmModules();
  const sh = async (cmd: string, o: Partial<Omit<ShellOptions, "modules">> = {}) => {
    const r = await runShell(blocks, { tree, cmd, modules, ...o });
    return { ...r, out: text(r.stdout), err: text(r.stderr) };
  };
  const file = async (root: CID, path: string) => text(await readFile(blocks, root, path));
  return { blocks, tree, sh, file };
}

test("node (qjs + shim): argv, stdin, files in the tree, exit code; run by #! and by name", async (t) => {
  const { sh, file } = await fixture(t);
  for (const cmd of ["./tool.js world a b", "node tool.js world a b"]) {
    const r = await sh(`echo piped | ${cmd}; echo "exit=$?"`);
    assert.equal(r.out, "hello world [a,b] stdin=piped lines=3\nexit=3\n", r.err);
    assert.equal(r.err, "to stderr\n");
    assert.equal(await file(r.tree, "out/js.txt"), "ALPHA\nBETA\nGAMMA\n");
  }
  const esm = await sh(`printf 'import { readFileSync } from "node:fs";\\nimport path from "path";\\nconsole.log(path.basename(process.argv[1]), readFileSync("data.txt", "utf8").length, { a: [1, "x"] });\\nprocess.exit(2);\\n' > m.mjs && node m.mjs; echo "exit=$?"`);
  assert.equal(esm.out, "m.mjs 17 { a: [ 1, 'x' ] }\nexit=2\n", esm.err);
  const missing = await sh(`node -e 'require("child_process")'; echo "exit=$?"`);
  assert.equal(missing.out, "exit=1\n");
  assert.match(missing.err, /Cannot find module 'child_process': skein's node shim/);
  const net = await sh(`node -e 'fetch("http://example.com")'; echo "exit=$?"`);
  assert.equal(net.out, "exit=1\n");
  assert.match(net.err, /fetch is not defined/);
});

test("qjs: std-based script, argv, stdin, files, exit code, uncaught error", async (t) => {
  const { sh, file } = await fixture(t);
  const r = await sh(`echo 12345 | qjs tool.mjs x y; echo "exit=$?"`);
  assert.equal(r.out, "qjs x y 5\nexit=4\n", r.err);
  assert.equal(await file(r.tree, "out/qjs.txt"), "\ngamma\nbeta\nalpha");
  const boom = await sh(`qjs -e 'throw new Error("boom")'; echo "exit=$?"`);
  assert.equal(boom.out, "exit=1\n");
  assert.match(boom.err, /Error: boom/);
});

test("python: argv, stdin, files in the tree, exit code; run by #!, python3 and python", async (t) => {
  const { sh, file } = await fixture(t);
  for (const cmd of ["./tool.py world a b", "python3 tool.py world a b", "python tool.py world a b"]) {
    const r = await sh(`echo piped | ${cmd}; echo "exit=$?"`);
    assert.equal(r.out, "hello world ['a', 'b'] stdin=piped lines=3\nexit=5\n", r.err);
    assert.equal(r.err, "to stderr\n");
    assert.equal(await file(r.tree, "out/py.json"), '{"lines": ["alpha", "beta", "gamma"], "rest": ["a", "b"]}');
  }
});

test("python: stdlib is mounted read-only outside the tree; no bytecode caches in the tree; no network, no processes", async (t) => {
  const { sh, tree } = await fixture(t);
  const imp = await sh(`printf 'def f():\\n    return 42\\n' > helper.py && python3 -c 'import helper, sys; print(helper.f(), sys.prefix, sys.path[1])' && ls`);
  assert.equal(imp.out, "42 /opt/skein/python /opt/skein/python/lib/python314.zip\ndata.txt\nentropy.js\nentropy.py\nhelper.py\nout\ntool.js\ntool.mjs\ntool.py\n", imp.err);
  const ro = await sh(`python3 -c 'open("/opt/skein/python/lib/python314.zip", "ab")'`);
  assert.equal(ro.exitCode, 1);
  assert.match(ro.err, /Read-only file system/);
  const unseen = await sh("ls /opt");
  assert.notEqual(unseen.exitCode, 0); // the mount is python's alone
  assert.equal(unseen.tree.toString(), tree.toString());
  const net = await sh(`python3 -c 'import urllib.request; urllib.request.urlopen("http://example.com")'`);
  assert.equal(net.exitCode, 1);
  assert.match(net.err, /getaddrinfo/);
  const proc = await sh(`python3 -c 'import subprocess; subprocess.run(["ls"])'`);
  assert.equal(proc.exitCode, 1);
  assert.match(proc.err, /does not support processes/);
});

test("determinism: identical runs give identical output and tree; clock and random come from the runtime", async (t) => {
  const { sh } = await fixture(t);
  const cmd = "./tool.js w < data.txt; qjs tool.mjs < data.txt; ./tool.py w < data.txt; python3 entropy.py; node entropy.js";
  const a = await sh(cmd), b = await sh(cmd);
  assert.equal(a.out, b.out);
  assert.equal(a.err, b.err);
  assert.equal(a.tree.toString(), b.tree.toString());

  // The clock is the runtime's (`time`, ms since the epoch); nothing reads a wall clock.
  const at = await sh("python3 entropy.py; node entropy.js", { time: 1_700_000_000_000, seed: 7 });
  const [pyClock, pyRandom, jsLine] = at.out.split("\n");
  assert.equal(pyClock, "1700000000.0 1700000000.0 2023-11-14T22:13:20");
  assert.match(jsLine, /^1700000000000 2023-11-14T22:13:20.000Z 0\.\d+$/);
  // Randomness (python's random/os.urandom/hash seed/uuid4; JS Math.random) is the runtime's stream: same seed, same values; another seed, others.
  const again = await sh("python3 entropy.py; node entropy.js", { time: 1_700_000_000_000, seed: 7 });
  assert.equal(again.out, at.out);
  const other = await sh("python3 entropy.py; node entropy.js", { time: 1_700_000_000_000, seed: 8 });
  const [, pyRandom2, jsLine2] = other.out.split("\n");
  for (let i = 0; i < 4; i++) assert.notEqual(pyRandom.split(" ")[i], pyRandom2.split(" ")[i], `python entropy field ${i}`);
  assert.notEqual(jsLine.split(" ")[2], jsLine2.split(" ")[2]);
});

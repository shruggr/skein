import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CID } from "multiformats/cid";
import { diff, gitSha, lookup, readFile, type TreeBlocks } from "./tree.ts";
import { materialize, scan } from "../dev/scan.ts";
import { wasmModules } from "../testkit.ts";
import { runShell, type ShellOptions } from "./shell.ts";

class MapBlocks implements TreeBlocks {
  m = new Map<string, Uint8Array>();
  reads = new Map<string, number>();
  async has(cid: CID) { return this.m.has(cid.toString()); }
  async bytes(cid: CID) {
    const k = cid.toString();
    this.reads.set(k, (this.reads.get(k) ?? 0) + 1);
    const b = this.m.get(k);
    if (!b) throw new Error(`not found: ${cid}`);
    return b;
  }
  async putBlock(cid: CID, bytes: Uint8Array) {
    assert.equal(createHash("sha1").update(bytes).digest("hex"), gitSha(cid), "putBlock: cid does not match bytes");
    this.m.set(cid.toString(), bytes);
  }
}

const text = (b: Uint8Array) => Buffer.from(b).toString("utf8");

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fs.mkdtemp(join(tmpdir(), "skein-sh-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(join(dir, "a.txt"), "one\ntwo\nthree\n");
  await fs.mkdir(join(dir, "sub/deep"), { recursive: true });
  await fs.writeFile(join(dir, "sub/b.txt"), "bee\n");
  await fs.writeFile(join(dir, "sub/deep/c.txt"), "sea\n");
  await fs.symlink("a.txt", join(dir, "link"));
  const blocks = new MapBlocks();
  const tree = await scan(blocks, dir);
  const sh = async (cmd: string, o: Partial<Omit<ShellOptions, "modules">> = {}) => {
    const t0 = performance.now();
    const r = await runShell(blocks, { tree, cmd, modules: await wasmModules(), ...o });
    return { ...r, out: text(r.stdout), err: text(r.stderr), ms: performance.now() - t0 };
  };
  return { dir, blocks, tree, sh };
}

test("ls and cat read the tree; timings", async (t) => {
  const { sh } = await fixture(t);
  const cold = await sh("ls"); // first run in the process compiles brush + coreutils
  const warm = await sh("ls");
  assert.equal(warm.out, "a.txt\nlink\nsub\n");
  assert.equal(warm.exitCode, 0);
  assert.equal((await sh("cat a.txt")).out, "one\ntwo\nthree\n");
  assert.equal((await sh("cat link")).out, "one\ntwo\nthree\n");
  assert.equal((await sh("cat sub/deep/c.txt")).out, "sea\n");
  const mv = await sh("mv a.txt b.txt");
  t.diagnostic(`cold ls ${cold.ms.toFixed(0)}ms, warm ls ${warm.ms.toFixed(0)}ms, mv ${mv.ms.toFixed(0)}ms`);
});

test("echo > new.txt adds a blob; the host directory is untouched", async (t) => {
  const { dir, blocks, tree, sh } = await fixture(t);
  const r = await sh("echo hi > new.txt");
  assert.equal(r.exitCode, 0);
  assert.equal(text(await readFile(blocks, r.tree, "new.txt")), "hi\n");
  assert.deepEqual((await diff(blocks, tree, r.tree)).map((c) => [c.type, c.path]), [["added", "new.txt"]]);
  await assert.rejects(fs.stat(join(dir, "new.txt")));
  assert.ok((await scan(blocks, dir)).equals(tree));
});

test("mv is a rename; mkdir && cp copies", async (t) => {
  const { blocks, tree, sh } = await fixture(t);
  const mv = await sh("mv a.txt b.txt");
  assert.deepEqual((await diff(blocks, tree, mv.tree)).map((c) => [c.type, c.path, c.from]), [["renamed", "b.txt", "a.txt"]]);
  const cp = await sh("mkdir d && cp a.txt d/ && ls d");
  assert.equal(cp.out, "a.txt\n");
  const d = await lookup(blocks, cp.tree, "d/a.txt");
  assert.ok(d && d.cid.equals((await lookup(blocks, tree, "a.txt"))!.cid));
});

test("the new tree checks out and scans back to itself; untouched subtrees keep their CIDs unread", async (t) => {
  const { blocks, tree, sh } = await fixture(t);
  const sub = (await lookup(blocks, tree, "sub"))!.cid;
  blocks.reads.clear();
  const r = await sh("echo x >> a.txt && rm link && ln -s sub/b.txt l2");
  assert.equal(r.exitCode, 0, r.err);
  assert.ok((await lookup(blocks, r.tree, "sub"))!.cid.equals(sub));
  assert.equal(blocks.reads.get(sub.toString()), undefined, "sub was never read");
  assert.equal((await lookup(blocks, r.tree, "l2"))!.mode, "120000");
  const out = await fs.mkdtemp(join(tmpdir(), "skein-sh-out-"));
  t.after(() => fs.rm(out, { recursive: true, force: true }));
  await materialize(blocks, r.tree, out);
  assert.ok((await scan(blocks, out)).equals(r.tree));
});

test("pipelines, command substitution, loops, here-docs", async (t) => {
  const { sh } = await fixture(t);
  assert.equal((await sh("cat a.txt | wc -l")).out, "3\n");
  assert.equal((await sh("printf '%s\\n' c b a b | sort | uniq | tr a-z A-Z")).out, "A\nB\nC\n");
  assert.equal((await sh('x=$(head -1 a.txt); echo "got $x"')).out, "got one\n");
  assert.equal((await sh("seq 1 4 | while read n; do echo $((n*n)); done")).out, "1\n4\n9\n16\n");
  assert.equal((await sh("cat <<EOF\nhello $USER\nEOF")).out, "hello skein\n");
  const yes = await sh("yes | head -2; echo ${PIPESTATUS[@]}");
  assert.match(yes.out, /^y\ny\n\d+ 0\n$/); // yes stops when the pipe hits its cap
});

test("exit codes propagate", async (t) => {
  const { sh } = await fixture(t);
  assert.equal((await sh("exit 3")).exitCode, 3);
  assert.equal((await sh("false")).exitCode, 1);
  assert.equal((await sh("cat nope")).exitCode, 1);
  assert.equal((await sh("nosuchcommand")).exitCode, 127);
  assert.equal((await sh("false | true; echo $?")).out, "0\n");
  assert.equal((await sh("set -o pipefail; false | true; echo $?")).out, "1\n");
});

test("deterministic: same inputs, byte-identical outputs and tree", async (t) => {
  const { sh } = await fixture(t);
  const cmd = "date; echo $RANDOM $RANDOM; ls -la; head -c 16 /dev/stdin | od -c; sleep 1; date +%s > t; mktemp -u XXXXXX";
  const a = await sh(cmd, { stdin: Buffer.from("0123456789abcdefXYZ") });
  const b = await sh(cmd, { stdin: Buffer.from("0123456789abcdefXYZ") });
  assert.equal(a.exitCode, 0, a.err);
  assert.deepEqual([a.out, a.err, a.tree.toString()], [b.out, b.err, b.tree.toString()]);
  assert.match(a.out, /^Thu Jan  1 00:00:00 UTC 1970\n/);
  const later = await sh("date -u +%FT%T", { time: Date.UTC(2026, 8, 25, 12) });
  assert.equal(later.out, "2026-09-25T12:00:00\n");
  const seeded = await sh("echo $RANDOM", { seed: 7 });
  assert.notEqual(seeded.out, (await sh("echo $RANDOM")).out);
});

test("nothing outside the tree is reachable", async (t) => {
  const { sh } = await fixture(t);
  const r = await sh("cat /etc/passwd");
  assert.equal(r.exitCode, 1);
  assert.match(r.err, /No such file/);
  assert.equal((await sh("cd /; cd ..; cd ..; ls")).out, "a.txt\nlink\nsub\n");
  assert.equal((await sh("ls ../../..")).out, "a.txt\nlink\nsub\n");
  assert.equal((await sh("echo gone > /dev/null; ls /dev 2>&1; echo $?")).out.trim().split("\n").pop(), "2");
});

test("cwd and env are inputs", async (t) => {
  const { sh } = await fixture(t);
  const r = await sh("pwd; ls; cat ../a.txt | head -1; /bin/true 2>/dev/null; echo $FOO", { cwd: "/sub", env: { FOO: "bar" } });
  assert.equal(r.out, "/sub\nb.txt\ndeep\none\nbar\n");
  await assert.rejects(sh("ls", { cwd: "/nope" }));
});

test("scripts in the tree run under the shell", async (t) => {
  const { sh } = await fixture(t);
  const r = await sh("printf '#!/bin/sh\\necho script $1\\n' > s.sh && bash s.sh one && ./s.sh two && sh -c 'echo nested'");
  assert.equal(r.out, "script one\nscript two\nnested\n");
});

test("a 2 MB file round-trips", async (t) => {
  const { blocks, dir } = await fixture(t);
  const big = Buffer.alloc(2 << 20);
  for (let i = 0; i < big.length; i++) big[i] = (i * 7919) & 0xff;
  await fs.writeFile(join(dir, "big.bin"), big);
  const tree = await scan(blocks, dir);
  const t0 = performance.now();
  const r = await runShell(blocks, { tree, modules: await wasmModules(), cmd: "cp big.bin copy.bin && cat big.bin | cat > piped.bin && wc -c < big.bin && md5sum big.bin copy.bin piped.bin | cut -c1-32 | uniq | wc -l" });
  t.diagnostic(`2 MB cp + pipe + md5sum: ${(performance.now() - t0).toFixed(0)}ms`);
  assert.equal(text(r.stdout), "2097152\n1\n", text(r.stderr));
  assert.ok(Buffer.from(await readFile(blocks, r.tree, "piped.bin")).equals(big));
  assert.ok((await lookup(blocks, r.tree, "copy.bin"))!.cid.equals((await lookup(blocks, tree, "big.bin"))!.cid));
});

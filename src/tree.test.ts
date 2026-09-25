import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CID } from "multiformats/cid";
import {
  diff, gitCid, gitSha, hashBlob, hashTree, lookup, materialize, readFile, scan, walk,
  type TreeBlocks,
} from "./tree.ts";

// Local on purpose: memory.ts is in flux. Verifies every put, so a wrong object never passes silently.
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

const HAS_GIT = spawnSync("git", ["--version"]).status === 0;
const needGit = { skip: HAS_GIT ? false : "git not on PATH" };
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
function git(cwd: string, args: string[], input?: Uint8Array): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, input, encoding: "utf8" }).trim();
}

async function tmp(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const d = await fs.mkdtemp(join(tmpdir(), "skein-tree-"));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
}

async function put(root: string, rel: string, data: string | Uint8Array, mode = 0o644) {
  const p = join(root, rel);
  await fs.mkdir(dirname(p), { recursive: true });
  await fs.writeFile(p, data);
  await fs.chmod(p, mode);
}

// Names chosen to trip naive sorting: git orders "foo-bar" < "foo.txt" < "foo/" < "foo0".
async function fixture(root: string) {
  await put(root, "README.md", "hello\n");
  await put(root, "empty", "");
  await put(root, "bin/run.sh", "#!/bin/sh\necho hi\n", 0o755);
  await put(root, "foo-bar", "a");
  await put(root, "foo.txt", "b");
  await put(root, "foo/inner.txt", "c");
  await put(root, "foo/deep/er/x.json", "{}\n");
  await put(root, "foo0", "d");
  await put(root, "ünïcode ✓.txt", "u");
  const big = Buffer.alloc(3 << 20);
  for (let i = 0; i < big.length; i++) big[i] = (i * 2654435761) >>> 24;
  await put(root, "big.bin", big); // over the streaming threshold
  await fs.symlink("README.md", join(root, "link"));
  await fs.symlink("../foo0", join(root, "foo/up"));
  await fs.symlink("nowhere", join(root, "dangling"));
  await fs.mkdir(join(root, "hollow/inner"), { recursive: true }); // git keeps no empty trees
}

test("gitCid/gitSha round trip; non-git cids refused", () => {
  const sha = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const cid = gitCid(sha);
  assert.equal(cid.code, 0x78);
  assert.equal(cid.multihash.code, 0x11);
  assert.equal(gitSha(cid), sha);
  assert.equal(gitSha(hashTree([]).cid), sha); // git's well-known empty tree
  assert.throws(() => gitCid("xyz"));
});

test("hashBlob equals git hash-object", needGit, async (t) => {
  const d = await tmp(t);
  for (const data of [Buffer.from(""), Buffer.from("hello\n"), Buffer.from([0, 255, 10, 0])]) {
    assert.equal(gitSha(hashBlob(data).cid), git(d, ["hash-object", "--stdin"], data));
  }
});

test("scan equals git write-tree (modes, symlinks, nesting, sort order, big file)", needGit, async (t) => {
  const d = await tmp(t);
  await fixture(d);
  git(d, ["init", "-q"]);
  git(d, ["add", "-A"]);
  const expected = git(d, ["write-tree"]);
  const blocks = new MapBlocks();
  const root = await scan(blocks, d); // .git ignored by default
  assert.equal(gitSha(root), expected);
  // Every object git has, we have, byte for byte.
  for (const line of git(d, ["ls-tree", "-r", "-t", expected]).split("\n")) {
    const [, type, sha] = line.split(/\s+/);
    const raw = execFileSync("git", ["cat-file", type!, sha!], { cwd: d, env: GIT_ENV, maxBuffer: 64 << 20 });
    const ours = await blocks.bytes(gitCid(sha!));
    assert.ok(Buffer.from(ours).subarray(Buffer.from(ours).indexOf(0) + 1).equals(raw), line);
  }
});

test("scan is idempotent and stores nothing new the second time", async (t) => {
  const d = await tmp(t);
  await fixture(d);
  const blocks = new MapBlocks();
  const a = await scan(blocks, d);
  const n = blocks.m.size;
  assert.ok((await scan(blocks, d)).equals(a));
  assert.equal(blocks.m.size, n);
});

test("materialize → scan round trip; walk, lookup, readFile", async (t) => {
  const src = await tmp(t), dst = await tmp(t);
  await fixture(src);
  const blocks = new MapBlocks();
  const root = await scan(blocks, src);
  await materialize(blocks, root, join(dst, "out"));
  assert.ok((await scan(blocks, join(dst, "out"))).equals(root));
  assert.equal((await fs.stat(join(dst, "out/bin/run.sh"))).mode & 0o100, 0o100);
  assert.equal((await fs.stat(join(dst, "out/foo.txt"))).mode & 0o111, 0);

  const files = [];
  for await (const e of walk(blocks, root)) files.push(e.path);
  assert.deepEqual(files, [
    "README.md", "big.bin", "bin/run.sh", "dangling", "empty", "foo-bar", "foo.txt",
    "foo/deep/er/x.json", "foo/inner.txt", "foo/up", "foo0", "link", "ünïcode ✓.txt",
  ]);
  const withDirs = [];
  for await (const e of walk(blocks, root, "foo", { dirs: true })) withDirs.push(`${e.mode} ${e.path}`);
  assert.deepEqual(withDirs, ["40000 foo/deep", "40000 foo/deep/er", "100644 foo/deep/er/x.json", "100644 foo/inner.txt", "120000 foo/up"]);
  assert.equal(Buffer.from(await readFile(blocks, root, "foo/deep/er/x.json")).toString(), "{}\n");
  assert.equal(Buffer.from(await readFile(blocks, root, "link")).toString(), "README.md");
  assert.equal((await lookup(blocks, root, "bin/run.sh"))?.mode, "100755");
  assert.equal(await lookup(blocks, root, "nope/x"), undefined);
  await assert.rejects(readFile(blocks, root, "foo"), /not a file/);
});

test("materialize is a checkout: stale files go, types swap, modes follow, .git stays", async (t) => {
  const src = await tmp(t), dst = await tmp(t);
  await fixture(src);
  const blocks = new MapBlocks();
  const root = await scan(blocks, src);
  await put(dst, "stale.txt", "old");
  await put(dst, "foo/stale/deep.txt", "old");
  await put(dst, "foo.txt", "wrong content, wrong mode", 0o755);
  await put(dst, "foo0/was-a-dir", "x");        // dir where the tree has a file
  await put(dst, "bin", "was a file");          // file where the tree has a dir
  await fs.symlink("somewhere", join(dst, "README.md")); // symlink where the tree has a file
  await put(dst, ".git/HEAD", "ref: refs/heads/main\n");
  await materialize(blocks, root, dst);
  assert.ok((await scan(blocks, dst)).equals(root));
  await assert.rejects(fs.stat(join(dst, "stale.txt")));
  await assert.rejects(fs.stat(join(dst, "foo/stale")));
  assert.equal(await fs.readFile(join(dst, ".git/HEAD"), "utf8"), "ref: refs/heads/main\n");
});

test("diff: modified, added, removed, and a rename carries the same blob", async (t) => {
  const a = await tmp(t), b = await tmp(t);
  await put(a, "keep.txt", "same");
  await put(a, "edit.txt", "v1");
  await put(a, "gone.txt", "bye");
  await put(a, "old/place.txt", "moving blob");
  await put(b, "keep.txt", "same");
  await put(b, "edit.txt", "v2");
  await put(b, "new.txt", "hi");
  await put(b, "new/spot.txt", "moving blob");
  const blocks = new MapBlocks();
  const ta = await scan(blocks, a), tb = await scan(blocks, b);
  const changes = await diff(blocks, ta, tb);
  assert.deepEqual(changes.map((c) => [c.type, c.path, c.from]), [
    ["modified", "edit.txt", undefined],
    ["removed", "gone.txt", undefined],
    ["added", "new.txt", undefined],
    ["renamed", "new/spot.txt", "old/place.txt"],
  ]);
  const r = changes.find((c) => c.type === "renamed")!;
  assert.ok(r.a!.cid.equals(r.b!.cid));
  assert.deepEqual((await diff(blocks, ta, tb, { renames: false })).map((c) => c.type).sort(),
    ["added", "added", "modified", "removed", "removed"]);
  assert.deepEqual(await diff(blocks, ta, ta), []);
});

// A tree built by hand, since hashTree refuses these names.
async function rawTree(blocks: MapBlocks, name: string, blob: CID): Promise<CID> {
  const body = Buffer.concat([Buffer.from(`100644 ${name}\0`), blob.multihash.digest]);
  const object = Buffer.concat([Buffer.from(`tree ${body.length}\0`), body]);
  const cid = gitCid(createHash("sha1").update(object).digest("hex"));
  await blocks.putBlock(cid, object);
  return cid;
}

test("materialize refuses to write outside dir", async (t) => {
  const d = await tmp(t);
  const blocks = new MapBlocks();
  const { cid: blob, object } = hashBlob(Buffer.from("pwned"));
  await blocks.putBlock(blob, object);
  for (const name of ["..", "../escape", "a/../../escape", ".git", ".GIT", "."]) {
    await assert.rejects(materialize(blocks, await rawTree(blocks, name, blob), join(d, "box")), /refusing/, name);
  }
  await assert.rejects(fs.stat(join(d, "escape")));

  // An existing symlink in the target must be replaced, not written through.
  const outside = join(d, "outside");
  await fs.mkdir(outside);
  await fs.mkdir(join(d, "box2"));
  await fs.symlink(outside, join(d, "box2/sub"));
  const sub = hashTree([{ mode: "100644", name: "evil", cid: blob }]);
  await blocks.putBlock(sub.cid, sub.object);
  const top = hashTree([{ mode: "40000", name: "sub", cid: sub.cid }]);
  await blocks.putBlock(top.cid, top.object);
  await materialize(blocks, top.cid, join(d, "box2"));
  assert.deepEqual(await fs.readdir(outside), []);
  assert.ok((await fs.lstat(join(d, "box2/sub"))).isDirectory());
});

test("symlinks round trip, including dangling and absolute targets", async (t) => {
  const a = await tmp(t), b = await tmp(t);
  await fs.symlink("../elsewhere/x", join(a, "rel"));
  await fs.symlink("/etc/hostname", join(a, "abs"));
  await fs.mkdir(join(a, "d"));
  await fs.symlink("d", join(a, "dirlink"));
  await put(a, "d/f", "f");
  const blocks = new MapBlocks();
  const root = await scan(blocks, a);
  assert.equal((await lookup(blocks, root, "dirlink"))?.mode, "120000"); // not followed
  await materialize(blocks, root, b);
  assert.equal(await fs.readlink(join(b, "rel")), "../elsewhere/x");
  assert.equal(await fs.readlink(join(b, "abs")), "/etc/hostname");
  assert.equal(await fs.readlink(join(b, "dirlink")), "d");
  assert.ok((await scan(blocks, b)).equals(root));
  // Re-materializing over itself changes nothing.
  await materialize(blocks, root, b);
  assert.ok((await scan(blocks, b)).equals(root));
});

test("custom ignore replaces the default", async (t) => {
  const d = await tmp(t);
  await put(d, "keep.txt", "k");
  await put(d, "node_modules/x.js", "x");
  await put(d, "dist/out.js", "o");
  const blocks = new MapBlocks();
  const paths = async (root: CID) => { const o = []; for await (const e of walk(blocks, root)) o.push(e.path); return o; };
  assert.deepEqual(await paths(await scan(blocks, d)), ["dist/out.js", "keep.txt"]);
  assert.deepEqual(await paths(await scan(blocks, d, { ignore: (r) => r === "dist" })), ["keep.txt", "node_modules/x.js"]);
});

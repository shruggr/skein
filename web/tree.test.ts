// The browser's tree hashing (web/tree.ts) against the runtime's
// (src/runtime/tree.ts via src/dev/scan.ts, which is what `skein import` runs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { hashDir } from "../src/client/client.ts";
import { hashBlob as runtimeBlob, hashTree as runtimeTree } from "../src/runtime/tree.ts";
import { hashBlob, hashFiles, hashTree, ignored, relativeToPicked, type PickedFile } from "./tree.ts";

/** What <input webkitdirectory> would give for `dir` (regular files only), with modes when `modes`. */
function pickDir(dir: string, modes = false): PickedFile[] {
  const out: PickedFile[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = relative(dir, p).split("\\").join("/");
      if (ignored(rel)) continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push({ path: rel, bytes: readFileSync(p), ...(modes && statSync(p).mode & 0o100 ? { mode: "100755" as const } : {}) });
    }
  };
  walk(dir);
  return out;
}

function fixture(): string {
  const d = mkdtempSync(join(tmpdir(), "skein-web-tree-"));
  const w = (p: string, s: string | Uint8Array) => { mkdirSync(join(d, p, ".."), { recursive: true }); writeFileSync(join(d, p), s); };
  // git's ordering traps: "foo.txt" < "foo" (dir, compared as "foo/") < "foo0"; bytes, not locale.
  w("foo.txt", "a file\n");
  w("foo/inner.md", "# inner\n");
  w("foo0", "zero\n");
  w("foo-bar/x", "");
  w("B", "upper\n");
  w("a", "lower\n");
  w("ümlaut/ñ.txt", "unicode names\n");
  w("émoji 🎉.txt", "space and astral\n");
  w("deep/er/still/leaf.bin", Uint8Array.from({ length: 70000 }, (_, i) => (i * 31) & 0xff));
  w("empty.txt", "");
  w("run.sh", "#!/bin/sh\necho hi\n");
  chmodSync(join(d, "run.sh"), 0o755);
  w(".git/HEAD", "ignored\n");
  w("node_modules/x/index.js", "ignored\n");
  w("sub/node_modules/y", "ignored too\n");
  mkdirSync(join(d, "emptydir/nested"), { recursive: true }); // vanishes, as in git
  return d;
}

test("blob and tree objects are the runtime's, byte for byte", async () => {
  for (const s of ["", "hello\n", "x".repeat(100000)]) {
    const bytes = new TextEncoder().encode(s);
    const a = await hashBlob(bytes), b = runtimeBlob(bytes);
    assert.equal(a.cid.toString(), b.cid.toString());
    assert.deepEqual(Buffer.from(a.object), Buffer.from(b.object));
  }
  const c = (await hashBlob(new Uint8Array())).cid;
  const entries = [
    { mode: "100644" as const, name: "foo0", cid: c }, { mode: "40000" as const, name: "foo", cid: c },
    { mode: "100644" as const, name: "foo.txt", cid: c }, { mode: "100755" as const, name: "Z", cid: c }, { mode: "100644" as const, name: "ä", cid: c },
  ];
  const a = await hashTree(entries), b = runtimeTree(entries);
  assert.equal(a.cid.toString(), b.cid.toString());
  assert.deepEqual(Buffer.from(a.object), Buffer.from(b.object));
});

test("a picked directory hashes to the same root as `skein import` (scan)", async () => {
  const d = fixture();
  const cli = await hashDir(d);
  // With modes (a picker that knew them): identical root and identical object set.
  const web = await hashFiles(pickDir(d, true));
  assert.equal(web.root.toString(), cli.root.toString());
  const key = (rs: { cid: { toString(): string } }[]) => rs.map((r) => r.cid.toString()).sort();
  assert.deepEqual(key(web.records), key(cli.records));
  // The browser's picker has no modes: run.sh becomes 100644, so the root differs, as documented.
  const noModes = await hashFiles(pickDir(d, false));
  assert.notEqual(noModes.root.toString(), cli.root.toString());
});

test("a real source directory (src/client) hashes the same", async () => {
  const dir = new URL("../src/client", import.meta.url).pathname;
  assert.equal((await hashFiles(pickDir(dir, true))).root.toString(), (await hashDir(dir)).root.toString());
});

test("webkitRelativePath is relative to the picked directory; .git and node_modules are skipped", () => {
  assert.equal(relativeToPicked("proj/a/b.txt"), "a/b.txt");
  assert.equal(relativeToPicked("proj/x"), "x");
  assert.ok(ignored(".git/HEAD") && ignored("a/node_modules/b") && ignored("node_modules"));
  assert.ok(!ignored("gitx/a") && !ignored("a/.github/x"));
});

// git inside the VM on the Zig kernel (issue #2): real git (wasm/git.wasm)
// run by the wasm shell over a tree, its `.git/objects` the kernel's
// synthetic object directory. Checks that
//   - the verbs work (init add rm mv status diff commit log show branch
//     checkout reset restore merge tag), with author/committer from the env
//     or .gitconfig and dates from the run's clock;
//   - the commit's tree is the tree the VFS holds for the project (the same
//     record, not a copy), and every commit/tree/blob git wrote is a git-raw
//     record in the store exactly once, never a zlib blob of itself;
//   - `.git/objects/xx/…` in the tree is a gitlink per object (no content);
//   - the same commands give the same trees and output again (replay).
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/git.ts [skein-kernel]

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { CID } from "multiformats/cid";
import { install } from "../../src/dev/cli.ts";
import { openStoreFile } from "../../src/runtime/index-store.ts";
import { scan } from "../../src/dev/scan.ts";
import { openStore } from "../../src/runtime/sqlite.ts";
import { DatabaseSync } from "node:sqlite";
import { gitCid, parseTree } from "../../src/runtime/tree.ts";

const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.argv[2] ?? join(here, "../zig-out/bin/skein-kernel");

interface Case { cmd: string; tree: string; cwd?: string; env?: Array<[string, string]>; time?: number; seed?: number }
interface Out { exitCode?: number; stdout?: string; stderr?: string; tree?: string; error?: string }

const dir = await fs.mkdtemp(join(tmpdir(), "skein-kz-git-"));
const db = join(dir, "store.db");
const src = join(dir, "tree");
await fs.mkdir(join(src, "proj", "src"), { recursive: true });
await fs.writeFile(join(src, "proj", "README.md"), "# proj\n");
await fs.writeFile(join(src, "proj", "src", "main.txt"), "one\ntwo\nthree\n");
await fs.writeFile(join(src, ".gitconfig"), "[user]\n\tname = Martha\n\temail = martha@skein\n");
const store = openStore(db);
await install(store);
const tree0 = (await scan(store, src)).toString();
await store.close();

function run(cases: Case[]): Out[] {
  const r = spawnSync(kernel, ["shell", db], { input: JSON.stringify(cases), maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`skein-kernel shell: ${r.status}\n${r.stderr}`);
  return JSON.parse(r.stdout.toString());
}
const dec = (s?: string) => Buffer.from(s ?? "", "base64").toString();

let failed = 0;
function check(what: string, ok: boolean, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : `\n${detail}`}`);
  if (!ok) failed++;
}

// One command line per step, each over the tree the last one left: the way
// the loop's bash tool runs them. The clock moves one minute a step.
const t0 = Date.UTC(2026, 8, 28, 12, 0, 0);
const steps: Array<{ cmd: string; env?: Array<[string, string]>; expect?: (o: Out) => string | null }> = [
  { cmd: "git init -q proj && ls -a proj/.git && git -C proj config user.name" },
  { cmd: "cd proj && git add -A && git commit -q -m 'first' && git log --format='%H %T %an <%ae> %ad' --date=iso-strict" },
  { cmd: "cd proj && git status --short && git cat-file -p HEAD" },
  { cmd: "cd proj && echo four >> src/main.txt && git diff && git status --short" },
  { cmd: "cd proj && git commit -qam 'four' && git log --oneline | wc -l && git show --stat --format=%s HEAD" },
  { cmd: "cd proj && git branch topic && git checkout -q topic && echo t > t.txt && git add t.txt && git commit -qm topic && git branch --list" },
  { cmd: "cd proj && git checkout -q master && printf 'ONE\\ntwo\\nthree\\nfour\\n' > src/main.txt && git commit -qam 'upper' && git merge -q --no-edit topic && git log --graph --format=%s" },
  { cmd: "cd proj && git mv README.md READ.md && git rm -q t.txt && git status --short && git commit -qm 'mv rm'" },
  { cmd: "cd proj && echo junk > src/main.txt && git add src/main.txt && git reset -q && git restore src/main.txt && git status --short && cat src/main.txt" },
  { cmd: "cd proj && git tag -a v1 -m 'one' && git tag light && git tag && git describe" },
  { cmd: "cd proj && git checkout -q -b conflict HEAD~1 && echo A > c.txt && git add c.txt && git commit -qm a && git checkout -q master && echo B > c.txt && git add c.txt && git commit -qm b && git merge conflict; echo merge=$?; cat c.txt; git merge --abort && git status --short" },
  { cmd: "cd proj && git reset -q --hard HEAD~1 && git log --format=%s -1 && git show v1:READ.md", },
  { cmd: "cd proj && GIT_AUTHOR_NAME=Kurt GIT_AUTHOR_EMAIL=kurt@skein git commit -q --allow-empty -m env && git log -1 --format='%an %ae / %cn %ce'" },
  { cmd: "cd proj && git fsck --strict 2>&1; git count-objects -v | grep -E '^(count|packs)'" },
  { cmd: "cd proj && git gc; echo gc=$?; git repack; echo repack=$?; ls .git/objects/pack | wc -l" },
];

function play(): Out[] {
  const outs: Out[] = [];
  let tree = tree0;
  steps.forEach((s, i) => {
    const [o] = run([{ cmd: s.cmd, tree, time: t0 + i * 60_000, seed: i }]);
    outs.push(o);
    if (o.tree) tree = o.tree;
  });
  return outs;
}

const outs = play();
steps.forEach((s, i) => {
  const o = outs[i];
  console.log(`\n$ ${s.cmd}\n[exit ${o.exitCode}${o.error ? ` error ${o.error}` : ""}]\n${dec(o.stdout)}${dec(o.stderr) ? `--- stderr\n${dec(o.stderr)}` : ""}`);
});
console.log("");

// The repository as the store holds it.
const st = openStoreFile(db, { readOnly: true });   // the kernel may have moved it to the #30 format
const getBytes = async (c: CID) => await st.bytes(c);
async function treeEntries(c: CID) { return parseTree(await getBytes(c)); }
async function walk(root: CID, path: string[]): Promise<CID> {
  let c = root;
  for (const p of path) {
    const e = (await treeEntries(c)).find((x) => x.name === p);
    if (!e) throw new Error(`no ${p} under ${c}`);
    c = e.cid;
  }
  return c;
}

const final = CID.parse(outs[1].tree!);
const log = dec(outs[1].stdout).trim().split(" ");
const [commitHex, treeHex] = log;
const projTree = await walk(final, ["proj"]);
const projEntries = (await treeEntries(projTree)).filter((e) => e.name !== ".git");
// The commit's tree as git wrote it is the project directory minus .git: same entries, same records.
const commitTree = await treeEntries(gitCid(treeHex));
check("the commit's tree is the project's tree in the VFS (minus .git)",
  JSON.stringify(commitTree.map((e) => [e.name, e.mode, e.cid.toString()])) === JSON.stringify(projEntries.map((e) => [e.name, e.mode, e.cid.toString()])));
const srcInVfs = (await treeEntries(projTree)).find((e) => e.name === "src")!.cid;
const srcInCommit = commitTree.find((e) => e.name === "src")!.cid;
check("a subdirectory is one record for both (src/)", srcInVfs.equals(srcInCommit), `${srcInVfs} ${srcInCommit}`);
check("author from .gitconfig, date from the run's clock", dec(outs[1].stdout).includes("Martha <martha@skein> 2026-09-28T12:01:00Z"), dec(outs[1].stdout));

// .git/objects: every loose object is a gitlink naming the record, nothing else.
// Every step's expected output (the verbs work).
const want: Array<[number, string]> = [
  [0, "Martha"], [2, "tree " + "d1a0daf17137033a8c71266f1e9629b2760353d4"], [3, "+four"], [3, " M src/main.txt"],
  [4, " 1 file changed, 1 insertion(+)"], [5, "* topic"], [6, "*   Merge branch 'topic'"], [7, "R  README.md -> READ.md"],
  [7, "D  t.txt"], [8, "ONE\ntwo"], [9, "v1\n"], [10, "CONFLICT (add/add)"], [10, "<<<<<<< HEAD\nB\n=======\nA\n>>>>>>> conflict"],
  [11, "# proj"], [12, "Kurt kurt@skein / Martha martha@skein"], [13, "packs: 0"],
];
for (const [i, w] of want) {
  const text = dec(outs[i].stdout) + dec(outs[i].stderr);
  check(`step ${i}: ${JSON.stringify(w)}`, text.includes(w), text);
}
check("no step exits non-zero except by design", outs.every((o, i) => o.exitCode === 0 || i === 14), outs.map((o) => o.exitCode).join(" "));
check("gc and repack write no pack (EPERM in .git/objects/pack)", /gc=\d+\nrepack=[1-9]\d*\n0\n$/.test(dec(outs[14].stdout)), dec(outs[14].stdout) + dec(outs[14].stderr));

// After every step, in the last tree:
const last = CID.parse(outs[outs.length - 1].tree!);
const objs = await walk(last, ["proj", ".git", "objects"]);
let gitlinks = 0, other = 0;
const named: string[] = [];
for (const fan of await treeEntries(objs)) {
  if (fan.mode !== "40000" || !/^[0-9a-f]{2}$/.test(fan.name)) continue;
  for (const e of await treeEntries(fan.cid)) {
    if (e.mode === "160000" && Buffer.from(e.cid.multihash.digest).toString("hex") === fan.name + e.name) { gitlinks++; named.push(fan.name + e.name); } else other++;
  }
}
check(`.git/objects holds gitlinks only (${gitlinks} objects, ${other} other entries)`, gitlinks > 0 && other === 0);
check("the commit and its tree are among them", named.includes(commitHex) && named.includes(treeHex));

// Every object is its git-raw record, and no block anywhere is a zlib copy of one.
const db2 = new DatabaseSync(db, { readOnly: true });
let present = 0;
for (const hex of named) {
  const b = await getBytes(gitCid(hex)).catch(() => undefined);
  if (b && createHash("sha1").update(b).digest("hex") === hex) present++;
}
check(`every loose object is a git-raw record in the store (${present}/${named.length})`, present === named.length);
const rows = db2.prepare("select cid, bytes from blocks").all() as Array<{ cid: Uint8Array; bytes: Uint8Array }>;
let zlibCopies = 0, dup = 0;
const seen = new Set<string>();
for (const r of rows) {
  const k = Buffer.from(r.cid).toString("hex");
  if (seen.has(k)) dup++;
  seen.add(k);
  const b = Buffer.from(r.bytes);
  // a git blob whose content is a zlib stream of a git object = double storage
  const nul = b.indexOf(0);
  if (b.subarray(0, 5).toString() === "blob " && nul > 0 && b[nul + 1] === 0x78) {
    try { if (/^(blob|tree|commit|tag) \d+\0/.test(inflateSync(b.subarray(nul + 1)).subarray(0, 20).toString("latin1"))) zlibCopies++; } catch { /* not zlib */ }
  }
}
check(`no object stored twice (${rows.length} blocks, ${dup} duplicate rows, ${zlibCopies} zlib copies)`, dup === 0 && zlibCopies === 0);

// Replay: the same steps over the same start give the same trees and output.
const again = play();
check("replay: same trees, same output", JSON.stringify(again) === JSON.stringify(outs));

const bad = outs.map((o, i) => [i, o] as const).filter(([, o]) => o.error);
check("no step failed in the kernel", bad.length === 0, JSON.stringify(bad));

console.log(failed ? `\n${failed} failed` : "\nall ok");
await fs.rm(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { encode } from "../runtime/cid.ts";
import { blobCid, gitSha } from "../runtime/tree.ts";
import { chunk, decodeBundle, BUNDLE_LIMIT, type Rec } from "./bundle.ts";
import { SkeinClient, dispatchBody, hashDir, handlerCid } from "./client.ts";
import { parseCli } from "./cli.ts";
import type { ClientConfig } from "./config.ts";
import { KERNEL_BIN } from "../host/kernel.ts";
import { testHost, until } from "../host/testhost.ts";
import { SHELL_APP } from "../testapps.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "skein-client-"));

// ---------------------------------------------------------------- chunker

test("chunk: bundles stay under the limit and keep every record in order", () => {
  const recs: Rec[] = [];
  for (let i = 0; i < 300; i++) {
    const bytes = new Uint8Array(1000 + ((i * 7919) % 20000)).fill(i & 0xff);
    recs.push({ cid: blobCid(bytes), bytes });
  }
  const bundles = [...chunk(recs, 64 * 1024)];
  assert.ok(bundles.length > 1);
  for (const b of bundles) assert.ok(b.length <= 64 * 1024, `bundle of ${b.length}`);
  const back = bundles.flatMap(decodeBundle);
  assert.equal(back.length, recs.length);
  back.forEach((r, i) => { assert.ok(r.cid.equals(recs[i]!.cid)); assert.deepEqual(r.bytes, recs[i]!.bytes); });
});

test("chunk: the root rides on the last bundle only", () => {
  const recs: Rec[] = [1, 2, 3].map((n) => { const bytes = new Uint8Array(100).fill(n); return { cid: blobCid(bytes), bytes }; });
  const root = recs[2]!.cid;
  const roots = [...chunk(recs, 200, root)].map((b) => (dagCbor.decode(b) as { root?: CID }).root?.toString());
  assert.deepEqual(roots, [undefined, undefined, root.toString()]);
});

test("chunk: an oversized record travels alone; default limit is 1 MiB", () => {
  const small = new Uint8Array(10), big = new Uint8Array(BUNDLE_LIMIT + 5);
  const bundles = [...chunk([{ cid: blobCid(small), bytes: small }, { cid: blobCid(big), bytes: big }, { cid: blobCid(small), bytes: small }])];
  assert.equal(bundles.length, 3);
  assert.equal(decodeBundle(bundles[1]!)[0]!.bytes.length, big.length);
  assert.deepEqual([...chunk([])], []);
});

test("hashDir: the root is git's own tree id", (t) => {
  const d = tmp();
  mkdirSync(join(d, "src/deep"), { recursive: true });
  writeFileSync(join(d, "README"), "hi\n");
  writeFileSync(join(d, "src/deep/x.ts"), "export {}\n");
  writeFileSync(join(d, "run.sh"), "#!/bin/sh\n"); chmodSync(join(d, "run.sh"), 0o755);
  symlinkSync("README", join(d, "link"));
  return hashDir(d).then(({ root, records }) => {
    assert.equal(records.length, 7); // 4 blobs (the symlink is a blob) + 3 trees
    try {
      execFileSync("git", ["init", "-q", d]);
      execFileSync("git", ["-C", d, "add", "-A"]);
      const want = execFileSync("git", ["-C", d, "write-tree"], { encoding: "utf8" }).trim();
      assert.equal(gitSha(root), want);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") t.skip("git not installed"); else throw e;
    }
  });
});

// ---------------------------------------------------------------- CLI args

test("parseCli", () => {
  assert.deepEqual(parseCli(["import", "/x"]), { cmd: "import", dir: "/x" });
  assert.deepEqual(parseCli(["run", "--tree", "baf", "--", "ls", "|", "head", "-3"]), { cmd: "run", tree: "baf", line: "ls | head -3" });
  assert.deepEqual(parseCli(["run", "--tree", "baf", "--cwd", "src", "--env", "A=1", "--env", "B=x=y", "--", "ls | head -3"]),
    { cmd: "run", tree: "baf", line: "ls | head -3", cwd: "src", env: { A: "1", B: "x=y" } });
  assert.deepEqual(parseCli(["inbox", "--wait"]), { cmd: "inbox", wait: true, timeout: 120, ack: true, json: false });
  assert.deepEqual(parseCli(["inbox", "--no-ack", "--timeout", "5", "--json"]), { cmd: "inbox", wait: false, timeout: 5, ack: false, json: true });
  assert.deepEqual(parseCli(["whoami"]), { cmd: "whoami" });
  assert.deepEqual(parseCli([]), { cmd: "help" });
  assert.throws(() => parseCli(["run", "--tree", "x", "ls"]), /after `--`/);
  assert.deepEqual(parseCli(["run", "--", "ls"]), { cmd: "run", line: "ls" }, "no --tree: the instance's `main`");
  assert.deepEqual(parseCli(["head", "main", "baf"]), { cmd: "head", name: "main", tree: "baf" });
  assert.throws(() => parseCli(["head", "baf"]), /<name> <tree-cid>/);
  assert.deepEqual(parseCli(["dispatch", "add", "--sender", "02ab", "chat", "loop"]), { cmd: "dispatch", op: "add", sender: "02ab", box: "chat", handler: "loop" });
  assert.deepEqual(parseCli(["dispatch", "remove", "chat", "baf"]), { cmd: "dispatch", op: "remove", box: "chat", handler: "baf" });
  assert.throws(() => parseCli(["dispatch", "swap", "chat", "loop"]), /add\|remove/);
  assert.throws(() => parseCli(["dispatch", "add", "chat"]), /add\|remove/);
  assert.throws(() => parseCli(["run", "--tree", "x", "--env", "NOEQ", "--", "ls"]), /K=V/);
  assert.throws(() => parseCli(["import"]), /one <dir>/);
  assert.throws(() => parseCli(["inbox", "--bogus"]));
  assert.throws(() => parseCli(["frob"]), /unknown command/);
});

// ---------------------------------------------------------------- live messagebox

test("bin/skein on a host (#40): run to the instance's front door, the result read from David's mailbox instance, acknowledged", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  const h = await testHost(t);
  h.mailbox("david", h.ownerId);
  const alpha = h.instance("alpha");
  await h.router.start();
  await h.install("alpha", [SHELL_APP]); // #83: `run` is the shell app's
  const cfg: ClientConfig = {
    home: tmp(), walletUrl: "unused", originator: "skein-client-test",
    instanceUrl: `${h.base}/@alpha`, mailboxUrl: h.origin("david"),
    instance: { identityKey: alpha, handle: "alpha", domain: "localhost" },
    stateDir: join(tmp(), "client"),
  };
  const client = new SkeinClient(cfg, h.owner);
  const sent = await client.run({ cmd: "echo a; echo b" });
  assert.equal(client.lastSent("run")?.cid, sent.cid);
  assert.equal(sent.messageId, sent.cid, "a message's id is its record's CID");

  // 3 minutes: the shell app's modules compile on their first run, which on a cold wasmtime cache (a CI runner) takes more than the default 30 s.
  const results = await until("the result", async () => { const r = await client.inbox(); return r.length ? r : undefined; }, 180_000);
  assert.equal(results.length, 1);
  const r = results[0]!;
  assert.ok(r.verified && !r.error, r.error ?? "");
  assert.equal(r.sender, alpha);
  assert.equal(String(r.body!.replyTo), sent.cid);
  assert.equal(r.body!.exitCode, 0);
  assert.equal(new TextDecoder().decode(r.body!.stdout as Uint8Array), "a\nb\n");
  assert.deepEqual(await client.inbox(), [], "acknowledged");
});

test("dispatch body: a mailbox row; a handler by CID, or by a name the genesis's programs give; sender anyone unless given (then its 33 bytes)", () => {
  const loop = encode({ kind: "program", name: "loop" }).cid, other = encode({ kind: "program", name: "other" }).cid;
  const programs = { loop };
  assert.ok(handlerCid("loop", programs).equals(loop));
  assert.ok(handlerCid(other.toString()).equals(other));
  assert.throws(() => handlerCid("nope", programs), /not a CID or a program name \(loop\)/);
  assert.throws(() => handlerCid("loop"), /needs the instance's genesis/);
  const b = dispatchBody({ op: "add", box: "chat", handler: "loop" }, programs);
  assert.deepEqual(b, { op: "add", row: { transport: "mailbox", address: "chat", sender: "*", program: loop } });
  const key = `02${"ab".repeat(32)}`;
  const r = dispatchBody({ op: "remove", sender: key, box: "chat", handler: loop.toString() });
  assert.equal(r.op, "remove");
  assert.ok(r.row.sender instanceof Uint8Array && r.row.sender.length === 33);
  assert.equal(Buffer.from(r.row.sender as Uint8Array).toString("hex"), key);
  assert.throws(() => dispatchBody({ op: "add", sender: "02ab", box: "chat", handler: "loop" }, programs), /not an identity key/);
});

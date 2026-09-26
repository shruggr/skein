import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthFetch, PrivateKey, ProtoWallet, type WalletInterface } from "@bsv/sdk";
import { MessageBoxClient } from "@bsv/message-box-client";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { blobCid, gitSha } from "../runtime/tree.ts";
import { chunk, decodeBundle, BUNDLE_LIMIT, type Rec } from "./bundle.ts";
import { SkeinClient, hashDir, envelopeCid } from "./client.ts";
import { parseCli } from "./cli.ts";
import { open, seal, verify, type Envelope } from "./envelope.ts";
import type { ClientConfig } from "./config.ts";

const wallet = (): WalletInterface => new ProtoWallet(PrivateKey.fromRandom()) as unknown as WalletInterface;
const idk = async (w: WalletInterface) => (await w.getPublicKey({ identityKey: true })).publicKey;
const tmp = () => mkdtempSync(join(tmpdir(), "skein-client-"));

// ---------------------------------------------------------------- envelopes

test("envelope: seal, verify, open between two wallets", async () => {
  const david = wallet(), inst = wallet();
  const body = dagCbor.encode({ cmd: "ls", tree: blobCid(new Uint8Array()) });
  const env = await seal(david, { recipient: { identityKey: await idk(inst), handle: "skein", domain: "localhost" }, body });
  assert.equal(env.sender.identityKey, await idk(david));
  assert.ok(verify(env));
  const opened = await open(inst, env);
  assert.deepEqual(opened.body, body);
  assert.equal(opened.senderIdentityKey, await idk(david));
  await assert.rejects(open(david, env), /addressed to/);
  assert.ok(!verify({ ...env, created: "2000-01-01T00:00:00.000Z" }), "metadata is signed");
  assert.ok(!verify({ ...env, sender: { identityKey: await idk(inst) } }), "sender is bound");
  // The envelope survives the messagebox's JSON round trip.
  const back = JSON.parse(JSON.stringify(env)) as Envelope;
  assert.ok(verify(back));
  assert.equal((await envelopeCid(back)).toString(), (await envelopeCid(env)).toString());
});

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
  assert.throws(() => parseCli(["run", "--tree", "x", "--env", "NOEQ", "--", "ls"]), /K=V/);
  assert.throws(() => parseCli(["import"]), /one <dir>/);
  assert.throws(() => parseCli(["inbox", "--bogus"]));
  assert.throws(() => parseCli(["frob"]), /unknown command/);
});

// ---------------------------------------------------------------- live messagebox

const HOST = process.env.SKEIN_TEST_MESSAGEBOX_HOST ?? "http://127.0.0.1:8100";

async function hostUp(): Promise<boolean> {
  try { await fetch(`${HOST}/exchange-rate`, { signal: AbortSignal.timeout(1000) }); return true; } catch { return false; }
}

async function register(w: WalletInterface): Promise<void> {
  const res = await new AuthFetch(w).fetch(`${HOST}/account/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}` }),
  });
  assert.equal(res.status, 200, await res.text());
}

test("messagebox round trip: run out, result back (real local server)", async (t) => {
  if (!(await hostUp())) { t.skip(`no messagebox at ${HOST} (scripts/host/messagebox.sh --bg)`); return; }
  const david = wallet(), inst = wallet();
  await register(david); await register(inst); // the host only stores for account holders
  const cfg: ClientConfig = {
    home: tmp(), walletUrl: "unused", originator: "skein-client-test",
    messageboxUrl: `${HOST}/messagebox`,
    instance: { identityKey: await idk(inst), handle: "skein", domain: "localhost" },
    stateDir: join(tmp(), "client"),
  };
  const client = new SkeinClient(cfg, david);
  const tree = blobCid(new TextEncoder().encode("not really a tree")).toString();
  const sent = await client.run({ tree, cmd: "ls | head -3", cwd: "src" });
  assert.equal(client.lastSent("run")?.cid, sent.cid);

  // The instance's side, by hand: collect the run box, open, answer into david's results box.
  const mb = new MessageBoxClient({ host: cfg.messageboxUrl, walletClient: inst });
  const got = await mb.listMessagesLite({ messageBox: "run", host: cfg.messageboxUrl });
  assert.equal(got.length, 1);
  const env = got[0]!.body as unknown as Envelope;
  assert.ok(verify(env));
  assert.equal((await envelopeCid(env)).toString(), sent.cid);
  const req = dagCbor.decode((await open(inst, env)).body) as { cmd: string; tree: CID; cwd: string };
  assert.equal(req.cmd, "ls | head -3");
  assert.equal(req.tree.toString(), tree);
  assert.equal(req.cwd, "src");
  await mb.acknowledgeMessage({ messageIds: [got[0]!.messageId], host: cfg.messageboxUrl });

  const reply = await seal(inst, {
    recipient: { identityKey: await idk(david), handle: "david", domain: "localhost" },
    body: dagCbor.encode({ replyTo: CID.parse(sent.cid), exitCode: 0, stdout: new TextEncoder().encode("a\nb\nc\n"), stderr: new Uint8Array(), tree: CID.parse(tree) }),
  });
  await mb.sendMessage({ recipient: await idk(david), messageBox: "results", body: reply as unknown as Record<string, unknown>, skipEncryption: true }, cfg.messageboxUrl);

  const results = await client.inbox();
  assert.equal(results.length, 1);
  const r = results[0]!;
  assert.ok(r.verified, r.error ?? "unverified");
  assert.equal(String(r.body!.replyTo), sent.cid);
  assert.equal(r.body!.exitCode, 0);
  assert.equal(new TextDecoder().decode(r.body!.stdout as Uint8Array), "a\nb\nc\n");
  assert.deepEqual(await client.inbox(), [], "acknowledged");
});

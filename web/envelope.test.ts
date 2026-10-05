// The page's code path, as the browser runs it: web/core.ts bundled by
// esbuild with the page's options (node:crypto, node:fs/path and Buffer
// shimmed), then driven with ProtoWallets. The instance side uses the node
// modules (src/envelope.ts), so this also checks the two agree.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { AuthFetch, PrivateKey, ProtoWallet, type WalletInterface } from "@bsv/sdk";
import { MessageBoxClient } from "@bsv/message-box-client";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { open, seal, verify, type Envelope } from "../src/envelope.ts";
import { envelopeCid as nodeEnvelopeCid } from "../src/envelope.ts";
import { decodeBundle } from "../src/client/bundle.ts";
import { blobCid } from "../src/runtime/tree.ts";
import { browserOptions, WEB } from "./build.ts";
import type * as Core from "./core.ts";

let core: typeof Core;
before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "skein-web-bundle-"));
  const out = join(dir, "core.js");
  await build({ ...browserOptions(join(WEB, "core.ts"), out), sourcemap: false, logLevel: "error" });
  core = await import(pathToFileURL(out).href);
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
});

const wallet = (): WalletInterface => new ProtoWallet(PrivateKey.fromRandom()) as unknown as WalletInterface;
const idk = async (w: WalletInterface) => (await w.getPublicKey({ identityKey: true })).publicKey;

/** A messagebox in memory: what sendMessage delivers, listMessagesLite returns to the recipient. */
function fakeBox() {
  const boxes = new Map<string, { messageId: string; sender: string; body: unknown; recipient: string }[]>();
  let n = 0;
  const forWallet = (w: WalletInterface) => ({
    async sendMessage(m: { recipient: string; messageBox: string; body: unknown; skipEncryption?: boolean }) {
      assert.equal(m.skipEncryption, true);
      const messageId = `m${++n}`;
      const list = boxes.get(m.messageBox) ?? [];
      list.push({ messageId, sender: await idk(w), recipient: m.recipient, body: JSON.parse(JSON.stringify(m.body)) });
      boxes.set(m.messageBox, list);
      return { status: "success", messageId };
    },
    async listMessagesLite({ messageBox }: { messageBox: string }) {
      const me = await idk(w);
      return (boxes.get(messageBox) ?? []).filter((m) => m.recipient === me);
    },
    async acknowledgeMessage({ messageIds }: { messageIds: string[] }) {
      for (const [k, v] of boxes) boxes.set(k, v.filter((m) => !messageIds.includes(m.messageId)));
    },
  });
  return { boxes, forWallet };
}

async function setup() {
  const david = wallet(), inst = wallet();
  const box = fakeBox();
  const cfg: Core.WebConfig = {
    instance: { identityKey: await idk(inst), handle: "skein", domain: "localhost" },
    messageboxUrl: "http://unused/messagebox", hostUrl: "http://unused",
  };
  const page = new core.WebSkein(cfg, david, core.memoryStore(), box.forWallet(david) as unknown as MessageBoxClient);
  return { david, inst, box, page, instBox: box.forWallet(inst) };
}

/** The instance's `chat` reply to david, sealed with the node envelope code. */
async function reply(inst: WalletInterface, david: WalletInterface, instBox: ReturnType<ReturnType<typeof fakeBox>["forWallet"]>, body: Record<string, unknown>) {
  const env = await seal(inst, { recipient: { identityKey: await idk(david), handle: "david", domain: "localhost" }, body: dagCbor.encode(body) });
  await instBox.sendMessage({ recipient: await idk(david), messageBox: "chat", body: env, skipEncryption: true });
  return (await nodeEnvelopeCid(env)).toString();
}

test("chat → chat reply → chat: the bundled page seals, the instance opens, replyTo chains", async () => {
  const { david, inst, box, page, instBox } = await setup();
  const tcid = blobCid(new Uint8Array([1])).toString();

  const s1 = await page.chat({ text: "hello", tree: tcid });
  const [m1] = box.boxes.get("chat")!;
  const env1 = m1!.body as Envelope;
  assert.ok(verify(env1), "node verify() accepts the page's envelope");
  assert.equal((await nodeEnvelopeCid(env1)).toString(), s1.cid, "page and CLI compute the same envelope CID");
  assert.equal(env1.sender.identityKey, await idk(david));
  const b1 = dagCbor.decode((await open(inst, env1)).body) as Record<string, unknown>;
  assert.equal(b1.text, "hello");
  assert.equal(String(b1.tree), tcid);
  assert.equal(b1.replyTo, undefined, "a first chat has no replyTo");
  await instBox.acknowledgeMessage({ messageIds: [m1!.messageId] });

  const thread = CID.parse(s1.cid); // any CID will do for the thread
  const replyCid = await reply(inst, david, instBox, { text: "hi", page: "# Title\n\n- a\n- b", tree: CID.parse(tcid), thread, replyTo: CID.parse(s1.cid) });
  const got = await page.inbox();
  assert.equal(got.length, 1);
  assert.ok(got[0]!.verified, got[0]!.error ?? "unverified");
  assert.equal(got[0]!.error, undefined);
  assert.equal(got[0]!.cid, replyCid);
  assert.equal(got[0]!.body!.text, "hi");
  assert.deepEqual(page.conversation()?.reply, replyCid);
  assert.deepEqual(await page.inbox(), [], "acknowledged");

  // A chat that is not a reply (a new conversation), or a reply from anyone but the instance, is shown, not continued.
  const other = wallet();
  await reply(inst, david, instBox, { text: "new topic" }); // no replyTo
  await reply(other, david, box.forWallet(other), { text: "not the instance", replyTo: CID.parse(s1.cid) });
  const shown = await page.inbox();
  assert.deepEqual(shown.map((r) => [r.body?.text, r.error]), [["new topic", undefined], ["not the instance", undefined]]);
  assert.deepEqual(page.conversation()?.reply, replyCid);

  // The next chat replies to that reply and inherits its tree.
  await page.chat({ text: "more" });
  const b2 = dagCbor.decode((await open(inst, box.boxes.get("chat")!.at(-1)!.body as Envelope)).body) as Record<string, unknown>;
  assert.equal(String(b2.replyTo), replyCid);
  assert.equal(String(b2.tree), tcid);
  // --new: neither.
  await page.chat({ text: "fresh", fresh: true });
  const b3 = dagCbor.decode((await open(inst, box.boxes.get("chat")!.at(-1)!.body as Envelope)).body) as Record<string, unknown>;
  assert.equal(b3.replyTo, undefined);
  assert.equal(b3.tree, undefined);
});

test("run and import reach the instance; a tampered reply shows its error", async () => {
  const { david, inst, box, page, instBox } = await setup();
  const imp = await page.importFiles([{ path: "a.txt", bytes: new TextEncoder().encode("A\n") }, { path: "d/b.txt", bytes: new TextEncoder().encode("B\n") }]);
  const objs = box.boxes.get("objects")!;
  assert.equal(objs.length, 1);
  const recs = decodeBundle((await open(inst, objs[0]!.body as Envelope)).body);
  assert.equal(recs.length, 4); // 2 blobs, tree d, the root tree
  assert.equal(recs.at(-1)!.cid.toString(), imp.root.toString());

  const r = await page.run({ tree: imp.root.toString(), cmd: "ls", cwd: "d" });
  const rb = dagCbor.decode((await open(inst, box.boxes.get("shell/run")![0]!.body as Envelope)).body) as Record<string, unknown>;
  assert.deepEqual([rb.cmd, String(rb.tree), rb.cwd], ["ls", imp.root.toString(), "d"]);
  assert.equal(page.lastSent("shell/run")?.cid, r.cid);

  // Tampered: the signature no longer covers `created`.
  const env = await seal(inst, { recipient: { identityKey: await idk(david), handle: "david", domain: "localhost" }, body: dagCbor.encode({ replyTo: CID.parse(r.cid), exitCode: 0 }) });
  await instBox.sendMessage({ recipient: await idk(david), messageBox: "results", body: { ...env, created: "2001-01-01T00:00:00.000Z" }, skipEncryption: true });
  const [bad] = await page.inbox();
  assert.equal(bad!.verified, false);
  assert.match(bad!.error!, /does not verify/);
});

test("the shimmed bundle and node agree on sha256/sha1 and random bytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "skein-web-shim-"));
  const out = join(dir, "shim.js");
  await build({ ...browserOptions(join(WEB, "shims/crypto.ts"), out), sourcemap: false, logLevel: "error" });
  const shim = await import(pathToFileURL(out).href);
  const { createHash } = await import("node:crypto");
  for (const s of ["", "abc", "x".repeat(5000), "ünïcødé"]) {
    for (const alg of ["sha256", "sha1"]) {
      assert.equal(Buffer.from(shim.createHash(alg).update(s).update(new Uint8Array([1, 2])).digest()).toString("hex"),
        createHash(alg).update(s).update(new Uint8Array([1, 2])).digest("hex"), `${alg}(${s.slice(0, 8)})`);
    }
  }
  assert.equal(shim.randomBytes(32).length, 32);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- live messagebox

const HOST = process.env.SKEIN_TEST_MESSAGEBOX_HOST ?? "http://127.0.0.1:8100";
async function hostUp(): Promise<boolean> {
  try { await fetch(`${HOST}/exchange-rate`, { signal: AbortSignal.timeout(1000) }); return true; } catch { return false; }
}

test("live: the bundled page registers, chats and reads a chat reply through the real messagebox", async (t) => {
  if (!(await hostUp())) { t.skip(`no messagebox at ${HOST}`); return; }
  const david = wallet(), inst = wallet();
  const cfg: Core.WebConfig = { instance: { identityKey: await idk(inst), handle: "skein", domain: "localhost" }, messageboxUrl: `${HOST}/messagebox`, hostUrl: HOST };
  const page = new core.WebSkein(cfg, david);
  const name = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const reg = await page.register(name());
  assert.equal(reg.status, 200, reg.text);
  const again = await page.register(name());
  assert.equal(again.status, 409, again.text); // one account per identity
  const ir = await new AuthFetch(inst).fetch(`${HOST}/account/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: name() }) });
  assert.equal(ir.status, 200);

  const sent = await page.chat({ text: "live hello" });
  const mb = new MessageBoxClient({ host: cfg.messageboxUrl, walletClient: inst });
  const got = await mb.listMessagesLite({ messageBox: "chat", host: cfg.messageboxUrl });
  assert.equal(got.length, 1);
  const env = got[0]!.body as unknown as Envelope;
  assert.equal((await nodeEnvelopeCid(env)).toString(), sent.cid);
  assert.equal((dagCbor.decode((await open(inst, env)).body) as { text: string }).text, "live hello");
  await mb.acknowledgeMessage({ messageIds: [got[0]!.messageId], host: cfg.messageboxUrl });

  const answer = await seal(inst, { recipient: { identityKey: await idk(david), handle: "david", domain: "localhost" }, body: dagCbor.encode({ text: "live hi", thread: CID.parse(sent.cid), replyTo: CID.parse(sent.cid) }) });
  await mb.sendMessage({ recipient: await idk(david), messageBox: "chat", body: answer as unknown as Record<string, unknown>, skipEncryption: true }, cfg.messageboxUrl);
  const rs = await page.inbox();
  assert.equal(rs.length, 1);
  assert.ok(rs[0]!.verified, rs[0]!.error ?? "unverified");
  assert.equal(rs[0]!.body!.text, "live hi");
  assert.equal(page.conversation()?.reply, (await nodeEnvelopeCid(answer)).toString());
});

// The page's code path, as the browser runs it: web/core.ts bundled by
// esbuild with the page's options (node:crypto, node:fs/path and Buffer
// shimmed), then driven with ProtoWallets over a messagebox in memory. A
// message is a plain BRC-33 message on the sender's session (#126 step 4: no
// envelope, nothing signed or sealed inside): the box records who sent it.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { AuthFetch, PrivateKey, ProtoWallet, type WalletInterface } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { decodeBundle } from "../src/client/bundle.ts";
import { RawBox } from "../src/client/raw.ts";
import { encode } from "../src/runtime/cid.ts";
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

/** A messagebox in memory: the sender is the wallet whose session it is; a message's id is its record's CID. */
function fakeBox() {
  const boxes = new Map<string, { messageId: string; sender: string; body: Uint8Array; recipient: string }[]>();
  let n = 0;
  const forWallet = (w: WalletInterface): Core.Box => ({
    async send(recipient: string, box: string, body: unknown) {
      const bytes = body instanceof Uint8Array ? body : dagCbor.encode(body);
      const sender = await idk(w);
      const id = encode({ sender, recipient, box, body: bytes, n: ++n }).cid;
      const list = boxes.get(box) ?? [];
      list.push({ messageId: id.toString(), sender, recipient, body: bytes });
      boxes.set(box, list);
      return { id };
    },
    async list(box: string) {
      const me = await idk(w);
      return (boxes.get(box) ?? []).filter((m) => m.recipient === me).map((m) => ({ messageId: m.messageId, sender: m.sender, body: m.body, value: dagCbor.decode(m.body) }));
    },
    async ack(ids: string[]) {
      for (const [k, v] of boxes) boxes.set(k, v.filter((m) => !ids.includes(m.messageId)));
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
  const page = new core.WebSkein(cfg, david, core.memoryStore(), box.forWallet(david));
  return { david, inst, box, page, instBox: box.forWallet(inst) };
}

/** The instance's `chat` reply to david: its id. */
async function reply(david: WalletInterface, from: Core.Box, body: Record<string, unknown>, box = "chat") {
  return (await from.send(await idk(david), box, body)).id.toString();
}

const bodyOf = (m: { body: Uint8Array }) => dagCbor.decode(m.body) as Record<string, unknown>;

test("chat → chat reply → chat: the bundled page sends plain messages, replyTo chains", async () => {
  const { david, inst, box, page, instBox } = await setup();
  const tcid = blobCid(new Uint8Array([1])).toString();

  const s1 = await page.chat({ text: "hello", tree: tcid });
  const [m1] = box.boxes.get("chat")!;
  assert.equal(m1!.messageId, s1.cid, "the page keeps the message's id");
  assert.equal(m1!.sender, await idk(david), "the box records the session's identity");
  const b1 = bodyOf(m1!);
  assert.equal(b1.text, "hello");
  assert.equal(String(b1.tree), tcid);
  assert.equal(b1.replyTo, undefined, "a first chat has no replyTo");
  await instBox.ack([m1!.messageId]);

  const thread = CID.parse(s1.cid); // any CID will do for the thread
  const replyCid = await reply(david, instBox, { text: "hi", page: "# Title\n\n- a\n- b", tree: CID.parse(tcid), thread, replyTo: CID.parse(s1.cid) });
  const got = await page.inbox();
  assert.equal(got.length, 1);
  assert.equal(got[0]!.error, undefined);
  assert.equal(got[0]!.cid, replyCid);
  assert.equal(got[0]!.sender, await idk(inst));
  assert.equal(got[0]!.body!.text, "hi");
  assert.deepEqual(page.conversation()?.reply, replyCid);
  assert.deepEqual(await page.inbox(), [], "acknowledged");

  // A chat that is not a reply (a new conversation), or a reply from anyone but the instance, is shown, not continued.
  const other = wallet();
  await reply(david, instBox, { text: "new topic" }); // no replyTo
  await reply(david, box.forWallet(other), { text: "not the instance", replyTo: CID.parse(s1.cid) });
  const shown = await page.inbox();
  assert.deepEqual(shown.map((r) => [r.body?.text, r.error]), [["new topic", undefined], ["not the instance", undefined]]);
  assert.deepEqual(page.conversation()?.reply, replyCid);

  // The next chat replies to that reply and inherits its tree.
  await page.chat({ text: "more" });
  const b2 = bodyOf(box.boxes.get("chat")!.at(-1)!);
  assert.equal(String(b2.replyTo), replyCid);
  assert.equal(String(b2.tree), tcid);
  // --new: neither.
  await page.chat({ text: "fresh", fresh: true });
  const b3 = bodyOf(box.boxes.get("chat")!.at(-1)!);
  assert.equal(b3.replyTo, undefined);
  assert.equal(b3.tree, undefined);
});

test("run and import reach the instance; a body that is not a record shows its error", async () => {
  const { david, box, page, instBox } = await setup();
  const imp = await page.importFiles([{ path: "a.txt", bytes: new TextEncoder().encode("A\n") }, { path: "d/b.txt", bytes: new TextEncoder().encode("B\n") }]);
  const objs = box.boxes.get("objects")!;
  assert.equal(objs.length, 1);
  const recs = decodeBundle(objs[0]!.body);
  assert.equal(recs.length, 4); // 2 blobs, tree d, the root tree
  assert.equal(recs.at(-1)!.cid.toString(), imp.root.toString());

  const r = await page.run({ tree: imp.root.toString(), cmd: "ls", cwd: "d" });
  const rb = bodyOf(box.boxes.get("shell/run")![0]!);
  assert.deepEqual([rb.cmd, String(rb.tree), rb.cwd], ["ls", imp.root.toString(), "d"]);
  assert.equal(page.lastSent("shell/run")?.cid, r.cid);

  await instBox.send(await idk(david), "results", dagCbor.encode("just text"));
  const [bad] = await page.inbox();
  assert.match(bad!.error!, /not a record/);
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
  const mb = new RawBox(inst, cfg.messageboxUrl);
  const got = await mb.list("chat");
  assert.equal(got.length, 1);
  assert.equal(got[0]!.messageId, sent.cid);
  assert.equal((got[0]!.value as { text: string }).text, "live hello");
  await mb.ack([got[0]!.messageId]);

  const answer = await mb.send(await idk(david), "chat", { text: "live hi", thread: CID.parse(sent.cid), replyTo: CID.parse(sent.cid) });
  const rs = await page.inbox();
  assert.equal(rs.length, 1);
  assert.equal(rs[0]!.body!.text, "live hi");
  assert.equal(page.conversation()?.reply, answer.id.toString());
});

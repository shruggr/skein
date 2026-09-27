import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthFetch, PrivateKey, ProtoWallet, type WalletInterface } from "@bsv/sdk";
import { MessageBoxClient } from "@bsv/message-box-client";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { blobCid } from "../runtime/tree.ts";
import { SkeinClient, envelopeCid } from "./client.ts";
import { formatReply, parseCli } from "./cli.ts";
import { asConversation, chatBody, conversationFrom, loadConversation, parseReplLine, parseReply, saveConversation, type Conversation } from "./conversation.ts";
import { open, seal, verify, type Envelope } from "./envelope.ts";
import type { ClientConfig } from "./config.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "skein-chat-"));
const cid = (s: string) => blobCid(new TextEncoder().encode(s));
const conv: Conversation = { reply: cid("reply").toString(), thread: cid("thread").toString(), tree: cid("tree").toString(), at: "2026-09-25T00:00:00.000Z" };

test("chatBody: new conversation has no replyTo and no default tree", () => {
  assert.deepEqual(chatBody({ text: "hi" }), { text: "hi" });
  assert.deepEqual(chatBody({ text: "hi", fresh: true }, conv), { text: "hi" });
  const b = chatBody({ text: "hi", fresh: true, tree: conv.tree, model: "ripper/qwen38" }, conv);
  assert.deepEqual(b, { text: "hi", tree: CID.parse(conv.tree!), model: "ripper/qwen38" });
  assert.throws(() => chatBody({ text: "  " }), /empty/);
});

test("chatBody: continuing replies to the last reply; tree defaults to its tree", () => {
  const b = chatBody({ text: "more" }, conv);
  assert.ok(b.replyTo?.equals(CID.parse(conv.reply)));
  assert.ok(b.tree?.equals(CID.parse(conv.tree!)));
  const other = cid("other").toString();
  assert.equal(chatBody({ text: "more", tree: other }, conv).tree?.toString(), other);
  const { tree: _t, ...noTree } = conv;
  assert.equal(chatBody({ text: "more" }, noTree).tree, undefined);
  // The body survives dag-cbor with CIDs as links.
  const back = dagCbor.decode(dagCbor.encode(b)) as unknown as Record<string, unknown>;
  assert.ok(CID.asCID(back.replyTo)?.equals(b.replyTo!));
});

test("conversation.json round trip", () => {
  const d = tmp();
  assert.equal(loadConversation(d), undefined);
  saveConversation(join(d, "client"), conv);
  assert.deepEqual(loadConversation(join(d, "client")), conv);
  // An older file names the envelope `say`: read as `reply`.
  const { reply, ...rest } = conv;
  assert.deepEqual(asConversation({ ...rest, say: reply }), conv);
  assert.equal(asConversation({ at: "x" }), undefined);
});

test("parseReply / conversationFrom / formatReply", () => {
  const body = dagCbor.decode(dagCbor.encode({ text: "done", page: "# Title\n\n- a\n", tree: cid("t"), thread: cid("th"), replyTo: cid("c") })) as Record<string, unknown>;
  const s = parseReply(body);
  assert.equal(s.text, "done");
  assert.equal(s.page, "# Title\n\n- a\n");
  const c = conversationFrom("bafyenv", s, "2026-01-01T00:00:00Z");
  assert.deepEqual(c, { reply: "bafyenv", thread: cid("th").toString(), tree: cid("t").toString(), at: "2026-01-01T00:00:00Z" });
  // A reply naming no tree or thread (a message mid-turn) keeps the previous ones.
  assert.deepEqual(conversationFrom("bafy2", parseReply({ text: "q?", replyTo: cid("c") }), "2026-01-02T00:00:00Z", c), { reply: "bafy2", thread: cid("th").toString(), tree: cid("t").toString(), at: "2026-01-02T00:00:00Z" });
  const out = formatReply(body);
  assert.match(out, /^done\n\n# Title\n\n- a\n\n  \[tree \S+…\S+  thread \S+…\S+\]$/);
  assert.equal(formatReply({ text: "x", thread: cid("th"), replyTo: cid("c") }).split("\n").length, 2);
  assert.equal(formatReply({ text: "x", replyTo: cid("c") }), "x");
  assert.throws(() => parseReply({ text: "x" }), /not a reply/);
  assert.throws(() => parseReply({ thread: cid("th"), replyTo: cid("c") }), /text/);
  assert.throws(() => parseReply({ text: "x", thread: "nope", replyTo: cid("c") }), /thread/);
  assert.throws(() => parseReply({ text: "x", thread: cid("th"), replyTo: cid("c"), page: 3 }), /page/);
});

test("parseCli: chat and talk", () => {
  assert.deepEqual(parseCli(["chat", "hello there"]), { cmd: "chat", text: "hello there", fresh: false, wait: false, timeout: 120 });
  assert.deepEqual(parseCli(["chat", "hi", "--tree", "baf", "--model", "ripper/qwen38", "--new", "--wait", "--timeout", "30"]),
    { cmd: "chat", text: "hi", tree: "baf", model: "ripper/qwen38", fresh: true, wait: true, timeout: 30 });
  assert.throws(() => parseCli(["chat"]), /text/);
  assert.throws(() => parseCli(["chat", "x", "--timeout", "0"]), /timeout/);
  assert.deepEqual(parseCli(["talk"]), { cmd: "talk", fresh: false, timeout: 120 });
  assert.deepEqual(parseCli(["talk", "--new", "--model", "m"]), { cmd: "talk", model: "m", fresh: true, timeout: 120 });
  assert.throws(() => parseCli(["talk", "extra"]));
});

test("parseReplLine", () => {
  const t = cid("t").toString();
  assert.deepEqual(parseReplLine("  what is in src?  "), { kind: "chat", text: "what is in src?" });
  assert.deepEqual(parseReplLine(""), { kind: "empty" });
  assert.deepEqual(parseReplLine("/new"), { kind: "new" });
  assert.deepEqual(parseReplLine("/quit"), { kind: "quit" });
  assert.deepEqual(parseReplLine(`/tree ${t}`), { kind: "tree", cid: t });
  assert.equal(parseReplLine("/tree").kind, "error");
  assert.equal(parseReplLine("/tree nope").kind, "error");
  assert.equal(parseReplLine("/new x").kind, "error");
  assert.equal(parseReplLine("/frob").kind, "error");
});

// ---------------------------------------------------------------- live messagebox

const HOST = process.env.SKEIN_TEST_MESSAGEBOX_HOST ?? "http://127.0.0.1:8100";
const wallet = (): WalletInterface => new ProtoWallet(PrivateKey.fromRandom()) as unknown as WalletInterface;
const idk = async (w: WalletInterface) => (await w.getPublicKey({ identityKey: true })).publicKey;

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

test("messagebox: chat out, a chat reply back, the next chat continues (real local server)", async (t) => {
  if (!(await hostUp())) { t.skip(`no messagebox at ${HOST} (scripts/host/messagebox.sh --bg)`); return; }
  const david = wallet(), inst = wallet();
  await register(david); await register(inst);
  const cfg: ClientConfig = {
    home: tmp(), walletUrl: "unused", originator: "skein-client-test", messageboxUrl: `${HOST}/messagebox`,
    instance: { identityKey: await idk(inst), handle: "skein", domain: "localhost" }, stateDir: join(tmp(), "client"),
  };
  const client = new SkeinClient(cfg, david);
  const tree = cid("tree").toString();
  const first = await client.chat({ text: "hello", tree, model: "ripper/qwen38" });
  assert.equal(first.replyTo, undefined);

  const mb = new MessageBoxClient({ host: cfg.messageboxUrl, walletClient: inst });
  const got = await mb.listMessagesLite({ messageBox: "chat", host: cfg.messageboxUrl });
  assert.equal(got.length, 1);
  const env = got[0]!.body as unknown as Envelope;
  assert.ok(verify(env));
  const req = dagCbor.decode((await open(inst, env)).body) as Record<string, unknown>;
  assert.equal(req.text, "hello");
  assert.equal(req.model, "ripper/qwen38");
  assert.equal(String(req.tree), tree);
  assert.equal(req.replyTo, undefined);
  await mb.acknowledgeMessage({ messageIds: [got[0]!.messageId], host: cfg.messageboxUrl });

  const newTree = cid("tree2");
  const reply = await seal(inst, {
    recipient: { identityKey: await idk(david), handle: "david", domain: "localhost" },
    body: dagCbor.encode({ text: "hi David", page: "# notes\n", tree: newTree, thread: cid("thread"), replyTo: CID.parse(first.cid) }),
  });
  await mb.sendMessage({ recipient: await idk(david), messageBox: "chat", body: reply as unknown as Record<string, unknown>, skipEncryption: true }, cfg.messageboxUrl);

  const seen: string[] = [];
  const hit = await client.waitFor([{ box: "chat", replyTo: first.cid }], { timeoutMs: 10_000, intervalMs: 200, onResult: (r) => seen.push(r.box) });
  assert.ok(hit, "the reply arrived");
  assert.equal(hit!.body!.text, "hi David");
  const replyCid = (await envelopeCid(reply)).toString();
  assert.equal(hit!.cid, replyCid);
  assert.deepEqual(client.conversation()?.reply, replyCid);
  assert.equal(client.conversation()?.tree, newTree.toString());

  const second = await client.chat({ text: "more" });
  assert.equal(second.replyTo, replyCid);
  assert.equal(second.tree, newTree.toString());
  const got2 = await mb.listMessagesLite({ messageBox: "chat", host: cfg.messageboxUrl });
  const req2 = dagCbor.decode((await open(inst, got2[0]!.body as unknown as Envelope)).body) as Record<string, unknown>;
  assert.equal(String(req2.replyTo), replyCid);
  assert.equal(String(req2.tree), newTree.toString());
  await mb.acknowledgeMessage({ messageIds: got2.map((m) => m.messageId), host: cfg.messageboxUrl });
});

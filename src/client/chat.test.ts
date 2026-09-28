import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { blobCid } from "../runtime/tree.ts";
import { SkeinClient } from "./client.ts";
import { formatReply, parseCli } from "./cli.ts";
import { asConversation, chatBody, conversationFrom, loadConversation, parseReplLine, parseReply, saveConversation, type Conversation } from "./conversation.ts";
import type { ClientConfig } from "./config.ts";
import { RawBox } from "./raw.ts";
import { KERNEL_BIN } from "../host/kernel.ts";
import { testHost } from "../host/testhost.ts";

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

// ---------------------------------------------------------------- on a host

test("chat on a host (#40): out to the instance's front door, the reply read from David's mailbox instance, the next chat continues", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  const h = await testHost(t);
  h.mailbox("david", h.ownerId);
  // The instance, played by hand: a mailbox instance for its key (its chat box kept for it).
  const instKey = h.keyOf("inst-owner");
  const instId = instKey.toPublicKey().toString();
  h.mailbox("inst", instId);
  const { ephemeralWallet } = await import("../wallet.ts");
  const inst = ephemeralWallet(instKey);
  const cfg: ClientConfig = {
    home: tmp(), walletUrl: "unused", originator: "skein-client-test",
    instanceUrl: h.origin("inst"), mailboxUrl: h.origin("david"),
    instance: { identityKey: instId, handle: "inst", domain: "localhost" }, stateDir: join(tmp(), "client"),
  };
  const client = new SkeinClient(cfg, h.owner);
  const tree = cid("tree").toString();
  const first = await client.chat({ text: "hello", tree, model: "ripper/qwen38" });
  assert.equal(first.replyTo, undefined);

  const mine = new RawBox(inst, h.origin("inst"));
  const got = await mine.list("chat");
  assert.equal(got.length, 1);
  assert.equal(got[0]!.messageId, first.cid, "the id the client keeps is the id the recipient lists");
  const req = got[0]!.value as Record<string, unknown>;
  assert.equal(req.text, "hello");
  assert.equal(req.model, "ripper/qwen38");
  assert.equal(String(req.tree), tree);
  assert.equal(req.replyTo, undefined);
  await mine.ack([got[0]!.messageId]);

  const newTree = cid("tree2");
  const { id: replyId } = await new RawBox(inst, h.origin("david")).send(h.ownerId, "chat", { text: "hi David", page: "# notes\n", tree: newTree, thread: cid("thread"), replyTo: CID.parse(first.cid) });

  const seen: string[] = [];
  const hit = await client.waitFor([{ box: "chat", replyTo: first.cid }], { timeoutMs: 10_000, intervalMs: 200, onResult: (r) => seen.push(r.box) });
  assert.ok(hit, "the reply arrived");
  assert.equal(hit!.body!.text, "hi David");
  assert.equal(hit!.cid, replyId.toString());
  assert.deepEqual(client.conversation()?.reply, replyId.toString());
  assert.equal(client.conversation()?.tree, newTree.toString());

  const second = await client.chat({ text: "more" });
  assert.equal(second.replyTo, replyId.toString());
  assert.equal(second.tree, newTree.toString());
  const got2 = await mine.list("chat");
  const req2 = got2[0]!.value as Record<string, unknown>;
  assert.equal(String(req2.replyTo), replyId.toString());
  assert.equal(String(req2.tree), newTree.toString());
});

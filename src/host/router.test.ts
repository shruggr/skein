// The router as a reverse proxy (#40), end to end with the real Zig kernel:
// every instance is an HTTP server (its front door) at its own origin; the
// stock @bsv/message-box-client talks to an agent by host name, our raw
// BRC-33 client by path prefix; the agent answers into its owner's mailbox —
// a mailbox instance — over http, short-circuited in process; the owner lists
// and acknowledges there; every request is an entry (#68), a poll moves
// nothing; sessions are records and survive a killed kernel.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { MessageBoxClient } from "@bsv/message-box-client";
import { CID } from "multiformats/cid";
import { RawBox } from "../client/raw.ts";
import { KERNEL_BIN } from "./kernel.ts";
import { testHost, until } from "./testhost.ts";

test("router: the stock client by host name, our client by path prefix; the answer delivered into the owner's mailbox instance over http; list/ack; polls are entries that move nothing", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  const h = await testHost(t);
  h.mailbox("david", h.ownerId);
  const alpha = h.agent("alpha");
  await h.router.start();

  // The stock client, by host name (one BRC-104 session per origin: the instance's).
  const mb = new MessageBoxClient({ host: h.origin("alpha"), walletClient: h.owner });
  await mb.sendMessage({ recipient: alpha, messageBox: "run", body: { cmd: "echo hello; echo from $PWD" }, skipEncryption: true }, h.origin("alpha"));

  // The run's result is delivered by alpha itself, over http, to the owner's mailbox instance — in process.
  const dav = new MessageBoxClient({ host: h.origin("david"), walletClient: h.owner });
  const results = await until("the result in david's mailbox", async () => {
    const ms = await dav.listMessagesLite({ messageBox: "results", host: h.origin("david") });
    return ms.length ? ms : undefined;
  });
  const r = results[0]!.body as { exitCode: number; stdout: { "/": { bytes: string } }; replyTo: { "/": string } };
  assert.equal(r.exitCode, 0);
  assert.match(Buffer.from(r.stdout["/"].bytes, "base64").toString(), /^hello\n/);
  assert.equal(results[0]!.sender, alpha, "the sender is the session's identity: alpha's");
  assert.ok(h.lines.some((l) => l.startsWith("[alpha] deliver results for ") && l.endsWith(`→ ${h.origin("david")}/sendMessage (local): 200 delivered`)), "the delivery's log line: where, how, the result");
  await dav.acknowledgeMessage({ messageIds: results.map((m) => m.messageId), host: h.origin("david") });
  await h.router.settled();
  assert.deepEqual(await dav.listMessagesLite({ messageBox: "results", host: h.origin("david") }), [], "acknowledged: the reader's pointer moved");

  // Our raw client, by path prefix: a chat, answered (no inference peer: the loop says so) into david's `chat`.
  const toAlpha = new RawBox(h.owner, `${h.base}/@alpha`);
  const sent = await toAlpha.send(alpha, "chat", { text: "hi" });
  const inDavid = new RawBox(h.owner, `${h.base}/@david`);
  const answer = await until("the answer", async () => (await inDavid.list("chat"))[0]);
  assert.equal(answer.sender, alpha);
  const body = answer.value as { text: string; replyTo: CID };
  assert.match(body.text, /no inference peer/);
  assert.ok(CID.asCID(body.replyTo)?.equals(sent.id), "the answer replies to the chat's id: the record alpha keeps");

  // Alpha's peer table: only what its own programs wrote (nothing: the owner is the genesis's one peer).
  const k = (await h.router.hydrate("alpha")).kernel;
  assert.equal(await k.call("head", "peers"), null, "no peer seeded from the host's rows");

  // Polls (#68: skein is a state process): each listMessages on david's mailbox is an entry — an access
  // log — and a read: the mailbox itself does not move.
  await h.router.settled();
  const kd = (await h.router.hydrate("david")).kernel;
  const n0 = await h.entries("david"), m0 = await kd.call("head", "mailbox") as CID;
  const n = Number(process.env.SKEIN_POLLS ?? 100);
  for (let i = 0; i < n; i++) await dav.listMessagesLite({ messageBox: "results", host: h.origin("david") });
  await h.router.settled();
  assert.equal(await h.entries("david"), n0 + n, `${n} polls: ${n} entries`);
  assert.ok((await kd.call("head", "mailbox") as CID).equals(m0), `${n} polls: the mailbox unchanged`);
});

test("router: an agent's genesis names the owner's mailbox instance when it exists first; one without it is warned about at hydration", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  const h = await testHost(t);
  h.agent("early"); // genesised before the owner has a mailbox instance
  await h.router.hydrate("early");
  assert.ok(h.lines.some((l) => l.startsWith("[early] WARNING: its genesis names no owner messagebox")), `warned (${h.lines.join(" | ")})`);
  h.mailbox("david", h.ownerId);
  h.agent("late");
  const k = (await h.router.hydrate("late")).kernel;
  const g = await k.genesis() as { defaults: Record<string, string> };
  assert.equal(g.defaults.ownerMessagebox, h.origin("david"), "the owner's mailbox instance, by default");
  assert.ok(!h.lines.some((l) => l.startsWith("[late] WARNING")), "no warning for an agent whose genesis names it");
});

test("router: sessions are state (#68) — the stock client's handshake is an entry and a record, on a mailbox instance and an agent; a killed kernel keeps them, and the client goes on with no new handshake", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  const h = await testHost(t);
  h.mailbox("david", h.ownerId);
  h.agent("alpha");
  await h.router.start();
  await h.router.settled();
  // Every forwarded request's answer, as the client got it: `<handle> <route> <status>`.
  const seen: string[] = [];
  const r = h.router as unknown as { forward(handle: string, route: string, ...rest: unknown[]): Promise<{ status: number }> };
  const forward = r.forward.bind(h.router);
  r.forward = async (handle, route, ...rest) => { const a = await forward(handle, route, ...rest); seen.push(`${handle} ${route} ${a.status}`); return a; };
  const n0 = { david: await h.entries("david"), alpha: await h.entries("alpha") };

  // The first request to each origin shakes hands: the handshake is an entry, and its session a record.
  const dav = new MessageBoxClient({ host: h.origin("david"), walletClient: h.owner });
  assert.deepEqual(await dav.listMessagesLite({ messageBox: "chat", host: h.origin("david") }), []);
  const al = new MessageBoxClient({ host: h.origin("alpha"), walletClient: h.owner });
  assert.deepEqual(await al.listMessagesLite({ messageBox: "chat", host: h.origin("alpha") }), []);
  await h.router.settled();
  assert.deepEqual(seen, ["david /.well-known/auth 200", "david /listMessages 200", "alpha /.well-known/auth 200", "alpha /listMessages 200"]);
  assert.equal(await h.entries("david"), n0.david + 2, "the mailbox instance: the handshake and the listing, an entry each");
  assert.equal(await h.entries("alpha"), n0.alpha + 2, "the agent: the handshake and the listing, an entry each");
  const kd = (await h.router.hydrate("david")).kernel;
  const s1 = await kd.call("head", "sessions") as CID | null;
  assert.ok(s1, "david's session: a record (head `sessions`)");

  // Kill both kernels: the next request hydrates a new process over the same store; the sessions are there.
  const kill = async (handle: string) => { const k = (await h.router.hydrate(handle)).kernel; k.proc.kill("SIGKILL"); await k.exited(); };
  await kill("david");
  await kill("alpha");
  seen.length = 0;
  const sent = await dav.sendMessage({ recipient: h.ownerId, messageBox: "chat", body: { text: "after the restart" }, skipEncryption: true }, h.origin("david"));
  assert.ok(sent.messageId, "send works after the restart");
  assert.deepEqual(seen, ["david /sendMessage 200"], "no 401, no new handshake");
  const listed = await dav.listMessagesLite({ messageBox: "chat", host: h.origin("david") });
  assert.equal(listed.length, 1, "list works after the restart");
  assert.equal(listed[0]!.sender, h.ownerId);
  seen.length = 0;
  assert.deepEqual(await al.listMessagesLite({ messageBox: "chat", host: h.origin("alpha") }), [], "list works on the agent after its restart");
  assert.deepEqual(seen, ["alpha /listMessages 200"]);
  const kd2 = (await h.router.hydrate("david")).kernel;
  assert.notEqual(kd2, kd, "a new kernel process");
  assert.ok((await kd2.call("head", "sessions") as CID).equals(s1), "the same session table");

  // The message is routed from its request, and its record carries its proof: the sender, the 104 signature, both nonces.
  await h.router.settled();
  const box = await kd2.call("head", "mailbox") as CID;
  const lists = (await kd2.store.get(box) as unknown as { lists: Array<{ box: string; list: CID }> }).lists;
  const chat = await kd2.store.get(lists.find((l) => l.box === "chat")!.list) as unknown as { messages: Array<{ id: CID }> };
  const mail = await kd2.store.get(chat.messages[0]!.id) as unknown as { sender: Uint8Array; session: { signature: Uint8Array; nonce: string; yourNonce: string } };
  assert.equal(Buffer.from(mail.sender).toString("hex"), h.ownerId);
  assert.ok(mail.session.signature.length > 0 && mail.session.nonce && mail.session.yourNonce, "the 104 signature and both nonces");
});

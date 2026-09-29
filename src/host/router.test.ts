// The router as a reverse proxy (#40), end to end with the real Zig kernel:
// every instance is an HTTP server (its front door) at its own origin; the
// stock @bsv/message-box-client talks to an agent by host name, our raw
// BRC-33 client by path prefix; the agent answers into its owner's mailbox —
// a mailbox instance — over http, short-circuited in process; the owner lists
// and acknowledges there; ten thousand polls write nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { MessageBoxClient } from "@bsv/message-box-client";
import { CID } from "multiformats/cid";
import { RawBox } from "../client/raw.ts";
import { KERNEL_BIN } from "./kernel.ts";
import { testHost, until } from "./testhost.ts";

test("router: the stock client by host name, our client by path prefix; the answer delivered into the owner's mailbox instance over http; list/ack; 10,000 polls write nothing", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
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

  // Polls: ten thousand listMessages on david's mailbox write no entry and no byte.
  await h.router.settled();
  const n0 = await h.entries("david"), s0 = h.storeSize("david");
  const n = Number(process.env.SKEIN_POLLS ?? 10_000);
  for (let i = 0; i < n; i++) await dav.listMessagesLite({ messageBox: "results", host: h.origin("david") });
  await h.router.settled();
  assert.equal(await h.entries("david"), n0, `${n} polls: no entry`);
  assert.equal(h.storeSize("david"), s0, `${n} polls: no byte`);
  h.router.flushLedger();
  const ledger = h.db.ledger("david").find((l) => l.caller === h.ownerId && l.op === "/listMessages");
  assert.ok(ledger && ledger.calls >= n && ledger.fuel > 0, "the polls' fuel is on the host's ledger");
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

test("router: sessions are not state — the stock client's handshakes write nothing on a mailbox instance or an agent; a killed kernel is a 401 the client recovers from by itself", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
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
  const s0 = { david: h.storeSize("david"), alpha: h.storeSize("alpha") };

  // The first request to each origin shakes hands: nothing is written for it.
  const dav = new MessageBoxClient({ host: h.origin("david"), walletClient: h.owner });
  assert.deepEqual(await dav.listMessagesLite({ messageBox: "chat", host: h.origin("david") }), []);
  const al = new MessageBoxClient({ host: h.origin("alpha"), walletClient: h.owner });
  assert.deepEqual(await al.listMessagesLite({ messageBox: "chat", host: h.origin("alpha") }), []);
  await h.router.settled();
  assert.deepEqual(seen, ["david /.well-known/auth 200", "david /listMessages 200", "alpha /.well-known/auth 200", "alpha /listMessages 200"]);
  assert.equal(await h.entries("david"), n0.david, "the mailbox instance: the handshake is no entry");
  assert.equal(h.storeSize("david"), s0.david, "the mailbox instance: the handshake is no byte");
  assert.equal(await h.entries("alpha"), n0.alpha, "the agent: the handshake is no entry");
  assert.equal(h.storeSize("alpha"), s0.alpha, "the agent: the handshake is no byte");
  const kd = (await h.router.hydrate("david")).kernel;
  assert.equal(kd.scratch.size, 1, "david's session: in its kernel's memory");
  assert.ok(!(await kd.boxes()).includes(":sessions"), "no :sessions box");

  // Kill both kernels: the next request hydrates a new process with no sessions; the stock client gets a 401 and shakes hands again by itself.
  const kill = async (handle: string) => { const k = (await h.router.hydrate(handle)).kernel; k.proc.kill("SIGKILL"); await k.exited(); };
  await kill("david");
  await kill("alpha");
  seen.length = 0;
  const sent = await dav.sendMessage({ recipient: h.ownerId, messageBox: "chat", body: { text: "after the restart" }, skipEncryption: true }, h.origin("david"));
  assert.ok(sent.messageId, "send works after the restart");
  assert.deepEqual(seen, ["david /sendMessage 401", "david /.well-known/auth 200", "david /sendMessage 200"], "401, the handshake, the send again");
  const listed = await dav.listMessagesLite({ messageBox: "chat", host: h.origin("david") });
  assert.equal(listed.length, 1, "list works after the restart");
  assert.equal(listed[0]!.sender, h.ownerId);
  seen.length = 0;
  assert.deepEqual(await al.listMessagesLite({ messageBox: "chat", host: h.origin("alpha") }), [], "list works on the agent after its restart");
  assert.deepEqual(seen, ["alpha /listMessages 401", "alpha /.well-known/auth 200", "alpha /listMessages 200"]);
  const kd2 = (await h.router.hydrate("david")).kernel;
  assert.notEqual(kd2, kd, "a new kernel process");
  assert.equal(kd2.scratch.size, 1, "one new session, in memory");

  // The only entry all that wrote is the message, and it carries its proof: the sender, the 104 signature, both nonces.
  await h.router.settled();
  assert.equal(await h.entries("david"), n0.david + 1, "one entry: the message");
  const tip = await kd2.store.get((await kd2.store.log.tip())!) as { mail?: CID };
  const mail = await kd2.store.get(tip.mail!) as unknown as { sender: Uint8Array; session: { signature: Uint8Array; nonce: string; yourNonce: string } };
  assert.equal(Buffer.from(mail.sender).toString("hex"), h.ownerId);
  assert.ok(mail.session.signature.length > 0 && mail.session.nonce && mail.session.yourNonce, "the 104 signature and both nonces");
});

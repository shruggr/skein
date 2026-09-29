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

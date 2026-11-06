// The hosted messagebox (shruggr/skein-messagebox, installed in the host skein beside onboard): a mailbox
// for every key onboard records, at <host skein>/messagebox — send filed in the request's step, acknowledge
// in its step, list a read route (its filter answers, nothing is logged); a refused send logs nothing; a
// registration makes no instance. And the stock mail program: a skein's own /sendMessage takes only its own
// mail, and a skein has no /listMessages or /acknowledgeMessage of its own.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { PrivateKey } from "@bsv/sdk";
import { RawBox } from "../client/raw.ts";
import { ephemeralWallet } from "../wallet.ts";
import { KERNEL_BIN } from "./kernel.ts";
import { testHost } from "./testhost.ts";

const skip = !existsSync(KERNEL_BIN) && "kernel-zig not built";

test("hosted messagebox: two keys registered; a third session sends to each at the host skein's URL; each lists only its own; an ack moves only its own; a send to an unregistered key, or to the host skein's own key, is 403 with no entry; 1,000 list polls add no entries; no instance row for a registration", { skip, timeout: 300_000 }, async (t) => {
  const h = await testHost(t);
  const aliceKey = PrivateKey.fromRandom(), bobKey = PrivateKey.fromRandom(), carolKey = PrivateKey.fromRandom();
  const alice = aliceKey.toPublicKey().toString(), bob = bobKey.toPublicKey().toString();
  const url = await h.inbox(aliceKey, "alice");
  assert.equal(await h.inbox(bobKey, "bob"), url, "one messagebox for every handle: the host skein's");
  assert.equal(url, `${h.origin("host")}/messagebox`);
  assert.deepEqual(h.db.list().map((r) => r.handle), ["host"], "a registration makes no instance row");

  // A third key (registered nowhere) sends to each, on one session with the host skein.
  const carol = new RawBox(ephemeralWallet(carolKey), url);
  await h.router.settled();
  const n0 = await h.entries("host");
  const toAlice = await carol.send(alice, "inbox", { text: "for alice" });
  const toBob = await carol.send(bob, "inbox", { text: "for bob" });
  await h.router.settled();
  const n1 = await h.entries("host");
  assert.ok(n1 > n0, "a send is an entry (the handshake and the two sends)");

  // Each lists only what is addressed to its own key.
  const a = new RawBox(ephemeralWallet(aliceKey), url), b = new RawBox(ephemeralWallet(bobKey), url);
  const la = await a.list("inbox"), lb = await b.list("inbox");
  assert.deepEqual(la.map((m) => [m.messageId, m.sender, (m.value as { text: string }).text]), [[toAlice.id.toString(), carolKey.toPublicKey().toString(), "for alice"]]);
  assert.deepEqual(lb.map((m) => [m.messageId, (m.value as { text: string }).text]), [[toBob.id.toString(), "for bob"]]);
  assert.deepEqual(await a.list("other"), [], "another box: empty");

  // An ack moves only the caller's own: bob acknowledging alice's message finds nothing; alice's own goes.
  await assert.rejects(b.ack([toAlice.id.toString()]), /HTTP 400/, "not bob's: Message not found");
  assert.equal((await a.list("inbox")).length, 1, "alice's untouched by bob's ack");
  await a.ack([toAlice.id.toString()]);
  assert.deepEqual(await a.list("inbox"), [], "alice's acknowledged");
  assert.equal((await b.list("inbox")).length, 1, "bob's untouched by alice's ack");

  // A send to a key this messagebox does not host, and to the host skein's own key: 403, nothing logged.
  await h.router.settled();
  const n2 = await h.entries("host");
  await assert.rejects(carol.send(PrivateKey.fromRandom().toPublicKey().toString(), "inbox", { text: "nobody" }), /HTTP 403 ERR_ACCOUNT_REQUIRED/);
  await assert.rejects(carol.send(h.db.get("host")!.identity!, "inbox", { text: "the skein itself" }), /HTTP 403 ERR_ACCOUNT_REQUIRED/, "the skein's own mail is its own /sendMessage's");
  await h.router.settled();
  assert.equal(await h.entries("host"), n2, "a refused send: no entry");

  // 1,000 list polls on one session: no entries.
  for (let i = 0; i < 1000; i++) await b.list("inbox");
  await h.router.settled();
  assert.equal(await h.entries("host"), n2, "1,000 polls: the log's length unchanged");
});

test("the stock mail program: a skein's own /sendMessage takes only its own mail (another key: 403); a plain skein answers /listMessages and /acknowledgeMessage 404, and has nothing under /messagebox/", { skip, timeout: 120_000 }, async (t) => {
  const h = await testHost(t);
  const plain = h.instance("plain");
  await h.router.start();
  const box = new RawBox(h.owner, h.origin("plain"));
  await assert.rejects(box.send(PrivateKey.fromRandom().toPublicKey().toString(), "inbox", { text: "not for this skein" }), /HTTP 403 ERR_ACCOUNT_REQUIRED/);
  await assert.rejects(box.send(plain, "nobody-routes-this", { text: "x" }), /HTTP 403 ERR_NOT_SUBSCRIBED/, "its own mail in a box no route takes");
  for (const path of ["/listMessages", "/acknowledgeMessage", "/messagebox/sendMessage", "/messagebox/listMessages", "/messagebox/acknowledgeMessage"]) {
    const r = await box.postJson(path, JSON.stringify({ messageBox: "inbox", messageIds: ["x"] }));
    assert.equal(r.status, 404, `${path}: ${r.text}`);
  }
});

// The instance manager (#90) with the real kernel, driven by signed messages
// as the host skein's onboarding app sends them: the host skein is created
// from the default image with the manager in its address book (no other
// instance's book names it); `create` boots a child from the default image,
// delivers its owner's claim as its first entry after the genesis, then
// publishes it; a second `create` of the handle is refused (an answer); a
// message from any other instance is not acted on and not answered; `stop`
// unpublishes, `start` publishes again. #113: `create` records the domain it
// is given; image `mailbox` makes a mailbox instance (what a registration
// asks for), the same owner and handle again the same answer. (kernel-zig/
// equiv/host.ts runs the whole flow through the onboarding app.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { PrivateKey, ProtoWallet } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { encode } from "../runtime/cid.ts";
import { openStoreFile } from "../runtime/index-store.ts";
import { KERNEL_BIN } from "./kernel.ts";
import { MESSAGE_KEY_ID, MESSAGE_PROTOCOL, type MailRecord } from "./providers.ts";
import { testHost } from "./testhost.ts";

const skip = !existsSync(KERNEL_BIN) && "kernel-zig not built";
const hex = (b: unknown) => b instanceof Uint8Array ? Buffer.from(b).toString("hex") : String(b);

test("the instance manager: create (claimed before published), refusals, the host skein's only, stop and start", { skip, timeout: 180_000 }, async (t) => {
  const h = await testHost(t);
  const answers: Array<{ handle: string; box: string; body: Record<string, unknown> }> = [];
  const append = h.router.providers.o.append;
  (h.router.providers.o as { append: typeof append }).append = async (handle, pkg) => {
    answers.push({ handle, box: pkg.message.box, body: dagCbor.decode(pkg.body) as Record<string, unknown> });
    return await append(handle, pkg);
  };
  const manager = h.router.providers.key("manager");

  // The host skein: the default image, claimed for the operator, the manager in its book.
  const host = await h.router.createInstance("host", h.ownerId, { host: true });
  assert.equal(h.db.hostSkein()?.handle, "host");
  assert.equal(h.db.get("host")!.status, "enabled");
  const roles = async (handle: string) => (((await (await h.router.hydrate(handle)).kernel.genesis()) as { addressBook?: Array<{ role?: string }> }).addressBook ?? []).map((e) => e.role);
  assert.ok((await roles("host")).includes("manager"), "the host skein's address book names the instance manager");

  /** A message from `from` (its key) to the instance manager, carried as the kernel hands it over. */
  const send = async (from: string, box: string, body: Record<string, unknown>) => {
    const key = h.keyOf(from);
    const bytes = dagCbor.encode(body);
    const unsigned = { kind: "mail" as const, op: "put" as const, sender: Uint8Array.from(Buffer.from(key.toPublicKey().toString(), "hex")), recipient: Uint8Array.from(Buffer.from(manager, "hex")), box, body: encode(dagCbor.decode(bytes)).cid, nonce: Uint8Array.from(randomBytes(16)) };
    const { signature } = await new ProtoWallet(key).createSignature({ protocolID: MESSAGE_PROTOCOL, keyID: MESSAGE_KEY_ID, counterparty: "anyone", data: [...dagCbor.encode(unsigned)] });
    const message: MailRecord = { ...unsigned, signature: Uint8Array.from(signature) };
    const n = answers.length;
    h.router.providers.deliver(from, { message, body: bytes, transport: "local", address: "manager" });
    await h.router.providers.idle();
    await h.router.settled();
    return answers.slice(n).filter((a) => a.box === box && a.handle === from);
  };

  const client = PrivateKey.fromRandom().toPublicKey().toString();
  let a = await send("host", "create", { handle: "alice", owner: Uint8Array.from(Buffer.from(client, "hex")) });
  assert.equal(a.length, 1, "one answer");
  assert.equal(a[0]!.body.handle, "alice");
  assert.equal(a[0]!.body.url, h.origin("alice"));
  assert.equal(hex(a[0]!.body.identity), h.keyOf("alice").toPublicKey().toString(), "the child's identity, derived");
  const alice = h.db.get("alice")!;
  assert.equal(alice.status, "enabled", "published");
  const k = (await h.router.hydrate("alice")).kernel;
  const rows = (await k.dispatch()).rows as Array<Record<string, unknown>>;
  assert.deepEqual(rows.filter((r) => r.program === "kernel").map((r) => `${r.address}<-${hex(r.sender)}`), ["objects", "head", "dispatch", "peers"].map((o) => `${o}<-${client}`), "claimed for the client's key; the claim row gone");
  const first: Array<Record<string, unknown>> = [];
  const s = openStoreFile(alice.store, { readOnly: true });
  try { for await (const { entry } of s.log.entries(1)) { first.push(entry as Record<string, unknown>); break; } } finally { s.close(); }
  assert.equal(first[0]!.transport, "local", "the claim is the first entry after the genesis: nothing reached it before");
  assert.ok(!(await roles("alice")).includes("manager"), "the child's address book has no instance manager");
  assert.equal((await fetch(`${h.base}/@alice/`)).status, 200, "it answers at its origin");

  a = await send("host", "create", { handle: "alice", owner: Uint8Array.from(Buffer.from(client, "hex")) });
  assert.match(String(a[0]?.body.error), /handle alice is taken/, "a second create of the handle is refused, as an answer");
  a = await send("host", "create", { handle: "Bad_Name", owner: Uint8Array.from(Buffer.from(client, "hex")) });
  assert.match(String(a[0]?.body.error), /hostname label/);
  a = await send("host", "create", { handle: "carol", owner: "nope" });
  assert.match(String(a[0]?.body.error), /owner: not an identity key/);
  a = await send("host", "create", { handle: "carol", owner: client, image: "other" });
  assert.match(String(a[0]?.body.error), /the default image and mailbox instances/);
  assert.equal(h.db.get("carol"), undefined);
  a = await send("host", "create", { handle: "carol", owner: Uint8Array.from(Buffer.from(client, "hex")), domain: "Not A Domain" });
  assert.match(String(a[0]?.body.error), /domain .*a host name/);

  // #113: the domain asked is the row's; image `mailbox` is a mailbox instance for the owner, published at once.
  a = await send("host", "create", { handle: "dora", owner: Uint8Array.from(Buffer.from(client, "hex")), domain: "skein.test" });
  assert.equal(h.db.get("dora")!.domain, "skein.test");
  const mailer = PrivateKey.fromRandom().toPublicKey().toString();
  a = await send("host", "create", { handle: "mel", owner: Uint8Array.from(Buffer.from(mailer, "hex")), image: "mailbox", domain: "skein.test" });
  assert.deepEqual([a[0]!.body.handle, a[0]!.body.url, hex(a[0]!.body.identity)], ["mel", h.origin("mel"), h.keyOf("mel").toPublicKey().toString()]);
  const mel = h.db.get("mel")!;
  assert.deepEqual([mel.kind, mel.owner, mel.domain, mel.status], ["mailbox", mailer, "skein.test", "enabled"]);
  const mg = await (await h.router.hydrate("mel")).kernel.genesis() as { owner?: unknown };
  assert.equal(hex(mg.owner), mailer, "its genesis names the owner (no claim)");
  a = await send("host", "create", { handle: "mel", owner: Uint8Array.from(Buffer.from(mailer, "hex")), image: "mailbox" });
  assert.equal(a[0]!.body.handle, "mel", "the same owner and handle again: the same answer");
  a = await send("host", "create", { handle: "mel2", owner: Uint8Array.from(Buffer.from(mailer, "hex")), image: "mailbox" });
  assert.match(String(a[0]?.body.error), /has a mailbox instance here already: mel/);
  a = await send("host", "create", { handle: "mel", owner: Uint8Array.from(Buffer.from(client, "hex")), image: "mailbox" });
  assert.match(String(a[0]?.body.error), /handle mel is taken/);

  // Another instance (its own key, from its own handle) is not acted on, and not answered.
  h.instance("other");
  await h.router.hydrate("other");
  const lines = h.lines.length;
  a = await send("other", "create", { handle: "bob", owner: client });
  assert.equal(a.length, 0, "no answer");
  assert.equal(h.db.get("bob"), undefined, "nothing created");
  assert.ok(h.lines.slice(lines).some((l) => /the instance manager takes messages from the host skein only: not acted on/.test(l)));

  // stop and start.
  a = await send("host", "stop", { handle: "alice" });
  assert.equal(a[0]!.body.stopped, true);
  assert.equal(h.db.get("alice")!.status, "disabled");
  assert.equal((await fetch(`${h.base}/@alice/`)).status, 404, "unpublished");
  a = await send("host", "start", { handle: "alice" });
  assert.equal(a[0]!.body.started, true);
  assert.equal((await fetch(`${h.base}/@alice/`)).status, 200, "published again");
  a = await send("host", "stop", { handle: "host" });
  assert.match(String(a[0]?.body.error), /is the host skein/);
  void host;
});

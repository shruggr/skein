import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKey, ProtoWallet } from "@bsv/sdk";
import { INSTANCE_PROTOCOL, masterKey, Signer } from "./signer.ts";

test("signer: one master secret (a 0600 file made once, or SKEIN_MASTER_KEY); per instance a BRC-42 child, key ID = the handle, behind a ProtoWallet", async (t) => {
  const home = await fs.mkdtemp(join(tmpdir(), "skein-signer-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const m1 = masterKey({}, home);
  assert.equal(statSync(join(home, "master.key")).mode & 0o777, 0o600);
  assert.equal(masterKey({}, home).toHex(), m1.toHex(), "the same secret next time");
  assert.equal(masterKey({ SKEIN_MASTER_KEY: "22".repeat(32) }, home).toHex(), "22".repeat(32));

  const o = new Signer(m1);
  // The identity is what the master's own wallet derives for [2, "skein instance"] / handle / self.
  const { publicKey } = await new ProtoWallet(m1).getPublicKey({ protocolID: INSTANCE_PROTOCOL, keyID: "martha", counterparty: "self" });
  assert.equal(o.identity("martha"), publicKey);
  assert.notEqual(o.identity("martha"), o.identity("kurt"));
  const w = o.wallet("martha");
  assert.equal((await w.getPublicKey({ identityKey: true })).publicKey, publicKey, "the ProtoWallet's root is the child");
  const other = PrivateKey.fromRandom();
  const c = await w.encrypt({ protocolID: [2, "message encryption"], keyID: "k", counterparty: other.toPublicKey().toString(), plaintext: [1, 2, 3] });
  const p = await new ProtoWallet(other).decrypt({ protocolID: [2, "message encryption"], keyID: "k", counterparty: publicKey, ciphertext: c.ciphertext });
  assert.deepEqual([...p.plaintext], [1, 2, 3]);
  await assert.rejects(w.createAction({ description: "no", outputs: [] } as never), /not supported/, "no actions: signing only");
});

test("signer, one-key mode (#160): SKEIN_KEY_FILE / SKEIN_KEY read, never made; every instance the key itself; the peer key one child whatever the handle, what the wallet answers for libp2p:<handle>", async (t) => {
  const home = await fs.mkdtemp(join(tmpdir(), "skein-onekey-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const { oneKey, signerOf } = await import("./signer.ts");
  const { writeFileSync, existsSync } = await import("node:fs");
  const file = join(home, "shared.key");
  assert.throws(() => oneKey({ SKEIN_KEY_FILE: file }), /never made/, "a one-key host is provisioned: no file, refused");
  assert.equal(existsSync(file), false);
  const k = PrivateKey.fromRandom();
  writeFileSync(file, `${k.toHex().padStart(64, "0")}\n`, { mode: 0o600 });
  assert.equal(oneKey({ SKEIN_KEY_FILE: file }).toHex(), k.toHex());
  assert.equal(oneKey({ SKEIN_KEY: k.toHex() }).toHex(), k.toHex());
  assert.throws(() => oneKey({ SKEIN_KEY_FILE: file, SKEIN_MASTER_KEY: "22".repeat(32) }), /two modes/);
  assert.throws(() => signerOf({ SKEIN_KEY: k.toHex(), SKEIN_MASTER_KEY_FILE: join(home, "m") }, home), /two modes/);
  assert.equal(existsSync(join(home, "master.key")), false, "no master key made in one-key mode");

  const s = signerOf({ SKEIN_KEY_FILE: file }, home);
  assert.equal(s.identity("alice"), k.toPublicKey().toString());
  assert.equal(s.identity(`${"ab".repeat(32)}_0`), k.toPublicKey().toString(), "every handle: the key itself");
  assert.equal(s.peerKey("alice").toHex(), s.peerKey("bob").toHex(), "one peer key");
  const child = await new ProtoWallet(k).getPublicKey({ protocolID: INSTANCE_PROTOCOL, keyID: "libp2p", counterparty: "self" });
  assert.equal(s.peerKey("alice").toPublicKey().toString(), child.publicKey, "the key's child [2, skein instance] / libp2p / self");
  const w = s.wallet("alice");
  assert.equal(w, s.wallet("bob"), "one wallet");
  for (const h of ["alice", "bob", `${"ab".repeat(32)}_0`]) {
    assert.equal((await w.getPublicKey({ protocolID: INSTANCE_PROTOCOL, keyID: `libp2p:${h}`, counterparty: "self" })).publicKey, child.publicKey, `libp2p:${h} answered with the one peer key`);
  }
  assert.equal((await w.getPublicKey({ protocolID: INSTANCE_PROTOCOL, keyID: "libp2p:alice" })).publicKey, child.publicKey, "counterparty defaulting to self");
  const other = await new ProtoWallet(k).getPublicKey({ protocolID: INSTANCE_PROTOCOL, keyID: "something else", counterparty: "self" });
  assert.equal((await w.getPublicKey({ protocolID: INSTANCE_PROTOCOL, keyID: "something else", counterparty: "self" })).publicKey, other.publicKey, "any other lookup: the ProtoWallet's own");
  assert.equal((await w.getPublicKey({ identityKey: true })).publicKey, k.toPublicKey().toString());
  assert.equal(s.providerKey("fetch").toHex(), new Signer(k).providerKey("fetch").toHex(), "providers derive from the key as from a master");
  await assert.rejects(w.createAction({ description: "no", outputs: [] } as never), /not supported/, "no actions");
  // Master-key mode unchanged through the factory.
  const m = signerOf({}, home);
  assert.equal(m.identity("alice"), new Signer(masterKey({}, home)).identity("alice"));
  assert.notEqual(m.peerKey("alice").toHex(), m.peerKey("bob").toHex());
});

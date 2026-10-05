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
  assert.notEqual((await o.routerWallet().getPublicKey({ identityKey: true })).publicKey, publicKey);
});

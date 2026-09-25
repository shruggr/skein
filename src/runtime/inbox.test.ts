// The edge: message keys (against @bsv/sdk, and as vectors for the Go
// handler's pure decryption), and admission screening — signature, the
// messagebox's authenticated sender, freshness, and duplicates.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { PrivateKey, ProtoWallet, SymmetricKey } from "@bsv/sdk";
import { encrypt as sdkEncrypt } from "@bsv/sdk/messages/EncryptedMessage";
import * as dagCbor from "@ipld/dag-cbor";
import { brc78Decode, seal } from "../envelope.ts";
import { instance, iso, send, T0 } from "../testkit.ts";
import { encode } from "./cid.ts";
import { deriveMessageKey } from "./inbox.ts";
import { readLog } from "./log.ts";

const GO_VECTORS = new URL("../../programs/brc78/testdata/sdk.json", import.meta.url);

test("message key: deriveMessageKey is the key @bsv/sdk decrypts with (EncryptedMessage and a wallet's encrypt); vectors for Go", async () => {
  const vectors: object[] = [];
  for (let n = 0; n < 4; n++) {
    const recipient = PrivateKey.fromRandom(), sender = PrivateKey.fromRandom();
    const plaintext = Buffer.from(`message ${n} ${"x".repeat(n * 37)}`);
    // The SDK's portable encrypt, and a wallet's encrypt as seal() does it.
    const viaSdk = Uint8Array.from(sdkEncrypt([...plaintext], sender, recipient.toPublicKey()));
    const env = await seal(new ProtoWallet(sender) as never, { recipient: { identityKey: recipient.toPublicKey().toString(), handle: "r", domain: "x" }, body: plaintext });
    const viaWallet = Buffer.from(env.content, "base64");
    for (const [name, msg] of [["sdk EncryptedMessage", viaSdk], ["wallet encrypt", viaWallet]] as const) {
      const h = brc78Decode(msg);
      const key = deriveMessageKey(recipient, h);
      // Our key opens the ciphertext with the SDK's own symmetric decryption…
      assert.deepEqual(Buffer.from(new SymmetricKey([...key]).decrypt([...h.ciphertext]) as number[]), plaintext, name);
      // …and a wallet's decrypt agrees on the plaintext.
      const { plaintext: w } = await new ProtoWallet(recipient).decrypt({ protocolID: [2, "message encryption"], keyID: Buffer.from(h.keyId).toString("base64"), counterparty: h.sender, ciphertext: [...h.ciphertext] });
      assert.deepEqual(Buffer.from(w), plaintext);
      vectors.push({ name: `${name} ${n}`, message: Buffer.from(msg).toString("hex"), key: Buffer.from(key).toString("hex"), plaintext: plaintext.toString("hex"), sender: h.sender, recipient: h.recipient });
    }
    assert.throws(() => deriveMessageKey(PrivateKey.fromRandom(), brc78Decode(viaSdk)), /not this instance/);
  }
  if (process.env.SKEIN_WRITE_VECTORS) writeFileSync(GO_VECTORS, JSON.stringify(vectors, null, 1) + "\n");
});

test("message key: the Go handler's pure BRC-78 decryption opens SDK-encrypted vectors (go test ./brc78)", { skip: !hasGo() && "go not on PATH" }, () => {
  const out = execFileSync("go", ["test", "-count=1", "-v", "./brc78"], { cwd: new URL("../../programs/", import.meta.url), encoding: "utf8" });
  assert.match(out, /--- PASS: TestSDKVectors/);
});

function hasGo(): boolean {
  try { execFileSync("go", ["version"]); return true; } catch { return false; }
}

test("screening: a good envelope is admitted with its key; a bad signature, a forged messagebox sender, a stale or future `created`, and a duplicate are rejected — all acknowledged", async () => {
  const i = await instance();
  const good = await send(i, "run", { cmd: "true", tree: encode({}).cid });
  // A tampered envelope: the metadata no longer matches the signature.
  const tampered = { ...(await seal(i.owner.wallet, { recipient: { identityKey: i.identity, handle: "skein", domain: "localhost" }, body: dagCbor.encode({ a: 1 }), created: iso(i.clock.now()) })), quoteId: "x" };
  i.hub.inject(i.identity, "run", { sender: i.owner.identity, body: JSON.stringify(tampered) });
  // A valid envelope, but the messagebox says someone else submitted it.
  const forged = await seal(i.owner.wallet, { recipient: { identityKey: i.identity, handle: "skein", domain: "localhost" }, body: dagCbor.encode({ b: 2 }), created: iso(i.clock.now()) });
  i.hub.inject(i.identity, "run", { sender: PrivateKey.fromRandom().toPublicKey().toString(), body: JSON.stringify(forged) });
  // Outside the ±10 min window, both ways.
  await send(i, "run", { c: 3 }, iso([T0[0] - 11 * 60, 0]));
  await send(i, "run", { c: 4 }, iso([T0[0] + 11 * 60, 0]));
  // Inside it.
  await send(i, "run", { c: 5 }, iso([T0[0] - 9 * 60, 0]));

  const admitted = await i.edge.poll();
  assert.equal(admitted.length, 2);
  assert.ok(admitted.some((a) => a.envelope === encode(good).cid.toString()));
  const reasons = i.lines.filter((l) => l.includes("rejected")).join("\n");
  assert.match(reasons, /signature does not verify/);
  assert.match(reasons, /messagebox sender .* is not envelope.sender/);
  assert.equal((reasons.match(/outside ±600000 ms/g) ?? []).length, 2);
  assert.equal(i.hub.pending(i.identity, "run").length, 0, "rejections are acknowledged too");

  // The same envelope delivered again (a replayed message) is refused by its record CID.
  i.hub.inject(i.identity, "run", { sender: i.owner.identity, body: JSON.stringify(good) });
  assert.equal((await i.edge.poll()).length, 0);
  assert.match(i.lines.at(-1)!, /already admitted/);
  await assert.rejects(i.rt.admitEnvelope(good, "run", new Uint8Array(32)), /already admitted/);

  const log = await readLog(i.store);
  assert.equal(log.length, 3, "genesis + two admissions");
  const e = log.find((x) => x.entry.envelope?.equals(encode(good).cid))!.entry;
  const k = await i.store.get(e.key!) as unknown as { key: Uint8Array };
  assert.deepEqual(k.key, deriveMessageKey(i.instanceKey, brc78Decode(Buffer.from(good.content, "base64"))));
  await i.rt.stop();
});

test("screening: the freshness window is configurable", async () => {
  const i = await instance({ freshnessMs: 60 * 60_000 });
  await send(i, "run", { c: 1 }, iso([T0[0] - 30 * 60, 0]));
  assert.equal((await i.edge.poll()).length, 1);
  await i.rt.stop();
});

test("edge.check: the root key must be the wallet's identity", async () => {
  const i = await instance();
  await i.edge.check();
  const { Edge } = await import("./inbox.ts");
  const wrong = new Edge({ runtime: i.rt, wallet: i.wallet, rootKey: PrivateKey.fromRandom(), box: i.hub.as(i.identity) });
  await assert.rejects(wrong.check(), /not the wallet's identity/);
  await i.rt.stop();
});

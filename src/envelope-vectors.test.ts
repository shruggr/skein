// The envelope vectors kernel-zig/test/{fixtures,format2}.json carry
// (made by kernel-zig/test/fixtures.ts and format2.ts), checked here since
// the kernel no longer has an envelope module of its own (the SDK's
// lib/message.zig is the Zig copy, used by the front door and the
// messagebox): a JSON-form envelope's JCS and signature, and a §7.3 dag-cbor
// envelope's signature over the preimage, its BRC-78 sender, its content
// hash, and a tampered one refused.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as dagCbor from "@ipld/dag-cbor";
import { canonical, isEnvelope, isSigned, verify, type Signed } from "./runtime/envelope.ts";
import { formOf, isCborEnvelope, isCborSigned, verifyCbor, type CborEnvelope, type CborSigned } from "./envelope-cbor.ts";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "kernel-zig", "test");
const read = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8"));
const unhex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

test("envelope vectors (fixtures.json): the JSON form's JCS and its anyone signature", () => {
  const env = read("fixtures.json").envelope as { signed: string; jcs: string; ok: boolean };
  const signed = dagCbor.decode(unhex(env.signed)) as Signed;
  assert.ok(isSigned(signed) && !isEnvelope(signed));
  assert.equal(canonical(signed), env.jcs);
  assert.equal(verify(signed), env.ok);
});

test("envelope vectors (format2.json, #33): §7.3 dag-cbor envelopes verify over the preimage; the content hash; tampered refused", () => {
  const f = read("format2.json") as { envelope: { signed: string; full: string; body: string }; tampered: string };
  const signed = dagCbor.decode(unhex(f.envelope.signed)) as CborSigned;
  const full = dagCbor.decode(unhex(f.envelope.full)) as CborEnvelope;
  assert.equal(formOf(full), "cbor");
  assert.ok(isCborSigned(signed) && !isCborEnvelope(signed) && isCborEnvelope(full));
  assert.ok(verifyCbor(signed));
  assert.ok(verifyCbor(full), "the BRC-78 sender is the signer");
  const digest = createHash("sha256").update(unhex(f.envelope.body)).digest();
  assert.deepEqual(Buffer.from(signed.contentHash), digest, "the content hash is the body's sha256");
  assert.notDeepEqual(Buffer.from(signed.contentHash), createHash("sha256").update("other").digest());
  assert.ok(!verifyCbor(dagCbor.decode(unhex(f.tampered)) as CborSigned));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { BigNumber, ECDSA, PrivateKey, PublicKey, Signature } from "@bsv/sdk";
import { decode, encode } from "./cid.ts";
import {
  isDispatchRow, isEmit, isGenesis, isMessage, isSignerCall, isProgram, messageBytes, messageDigest, program,
  signMessage, verifyMessage, type Genesis, type Message,
} from "./records.ts";
import { ephemeralWallet, identityOf, signerFor } from "../wallet.ts";

const wasm = encode({ kind: "blob", n: 1 }).cid;

test("message: signed over dag-cbor without sig; verifies from the record alone", async () => {
  const signer = await signerFor(ephemeralWallet(), "david");
  const m = await signMessage(signer, { to: "admin", seq: 1, body: { kind: "line", text: "hi", nope: undefined }, refs: [{ to: wasm, rel: "about" }], at: 5 });
  assert.equal(m.from, signer.identity);
  assert.deepEqual(m.body, { kind: "line", text: "hi" });
  assert.ok(isMessage(m));

  // The scheme, checked with nothing but @bsv/sdk primitives: DER ECDSA over sha256(dag-cbor(record − sig)).
  const { sig: _, ...rest } = m;
  const bytes = encode(rest).bytes;
  assert.deepEqual(messageBytes(m), bytes);
  const digest = createHash("sha256").update(bytes).digest();
  assert.deepEqual(messageDigest(m), new Uint8Array(digest));
  const sig = Signature.fromDER([...m.sig]);
  assert.ok(ECDSA.verify(new BigNumber([...digest]), sig, PublicKey.fromString(m.from)));

  // Over the wire and back: the wallet is out of reach, the record still verifies.
  const received = decode<Message>(encode(m).bytes);
  assert.equal(await verifyMessage(received), true);
});

test("message: any change breaks the signature", async () => {
  const signer = await signerFor(ephemeralWallet(), "david");
  const other = await identityOf(ephemeralWallet(), "david");
  const m = await signMessage(signer, { seq: 3, body: { text: "pay 1 sat" }, at: 9 });
  const flipped = new Uint8Array(m.sig); flipped[10] ^= 1;
  for (const bad of [
    { ...m, body: { text: "pay 1000 sats" } },
    { ...m, seq: 4 },
    { ...m, at: 10 },
    { ...m, to: "someone" },
    { ...m, from: other },
    { ...m, sig: flipped },
    { ...m, sig: new Uint8Array([1, 2, 3]) },
    { ...m, from: "not a key" },
    { ...m, extra: 1 },           // unsigned fields are covered too
  ]) assert.equal(await verifyMessage(bad), false, JSON.stringify(Object.keys(bad)));
  assert.equal(await verifyMessage({ ...m }), true);
});

test("route row: the kernel's rule (dispatch.zig problem; skein next, SPEC 3)", () => {
  assert.ok(isDispatchRow({ kind: "request", path: "/run", role: "root", handler: "shell.run.run" }));
  assert.ok(isDispatchRow({ kind: "event", name: "chain", handler: "chain.c" }));
  assert.ok(!isDispatchRow({ transport: "mailbox", address: "run", program: wasm }), "the old row form");
  assert.ok(!isDispatchRow({ kind: "request", path: "/run", handler: "shell.run" }), "no role: nothing open by omission");
});

test("program and genesis: validated", () => {
  const p = program({ name: "shell", code: { ts: "export default () => 1" }, inputs: { type: "object" }, services: ["execution"], description: "run a command" });
  assert.ok(isProgram(p));
  assert.ok(isProgram(program({ name: "w", code: { wasm }, inputs: {}, services: [], description: "" })));
  assert.throws(() => program({ name: "x", code: { ts: "", wasm } as never, inputs: {}, services: [], description: "" }), TypeError);
  assert.throws(() => program({ name: "", code: { ts: "" }, inputs: {}, services: [], description: "" }), TypeError);
  const id = new Uint8Array(Buffer.from(PrivateKey.fromRandom().toPublicKey().toString(), "hex"));
  const g: Genesis = { kind: "genesis", identity: id, handle: "skein", domain: "localhost", routes: [{ kind: "request", path: "/run", role: "root", handler: "shell.run.run" }], grants: { root: [id] } };
  assert.ok(isGenesis(g));
  assert.ok(!isGenesis({ ...g, identity: new Uint8Array(3) }));
  assert.ok(!isGenesis({ ...g, routes: [{ transport: "mailbox", address: "run", program: wasm }] } as never), "a bad row is refused");
  for (const k of ["owner", "root", "programs", "addressBook", "scopes", "peers", "feeds"]) assert.ok(!isGenesis({ ...g, [k]: [] } as never), `${k}: gone`);
  assert.ok(!isGenesis({ ...g, routes: undefined } as never), "the starting rows are required");
});

test("emit and signer-call records: validated", () => {
  const to = PrivateKey.fromRandom().toPublicKey().toString();
  const envelope = { metanetHandles: "1.0", content: "QkIQMw==" };
  assert.ok(isEmit({ kind: "emit", to, box: "results", body: wasm, envelope }));
  assert.ok(!isEmit({ kind: "emit", to, box: "", body: wasm, envelope }));
  assert.ok(!isEmit({ kind: "emit", to, box: "results", body: wasm }), "the program seals: an emit carries its envelope");
  assert.ok(isSignerCall({ kind: "oracle", thread: wasm, step: 1, i: 0, request: new Uint8Array(3), result: new Uint8Array(70) }));
  assert.ok(!isSignerCall({ kind: "attested", thread: wasm, step: 1, i: 0, op: "http", request: new Uint8Array(3), result: new Uint8Array(70) }), "format 6 (#67): no recorded http calls; the signer's answers alone are recorded");
  assert.ok(!isSignerCall({ kind: "oracle", thread: wasm, step: 1, i: 0, request: wasm, result: new Uint8Array(70) }), "the request is a wire frame");
});

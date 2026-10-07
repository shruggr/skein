// The owner's admin messages (#124, #142, admin.ts): the JSON body a dry run
// prints, read as DAG-JSON, is the same record the client sends as dag-cbor;
// the kernel's bodies; host.env and the operator's key; a message signed in
// the client's own process.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { PrivateKey, ProtoWallet } from "@bsv/sdk";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as dagCbor from "@ipld/dag-cbor";
import * as dagJson from "@ipld/dag-json";
import { encode } from "../runtime/cid.ts";
import { messageJson, planDispatch, planPeers } from "./admin.ts";
import { signMessage } from "./raw.ts";
import { identityOf, operatorKey, withHostEnv } from "../host/hostenv.ts";
import { keyWallet } from "../wallet.ts";

const KEY = `02${"ab".repeat(32)}`;

test("messageJson: the /sendMessage JSON body; its body read as DAG-JSON is the dag-cbor record the page sends", () => {
  const rec = encode({ kind: "x", n: 1 } as never);
  const body = { records: [{ cid: rec.cid, bytes: rec.bytes }], root: rec.cid };
  const json = messageJson(KEY, { box: "objects", body });
  const v = JSON.parse(json) as { message: { recipient: string; messageBox: string; body: unknown } };
  assert.deepEqual([v.message.recipient, v.message.messageBox], [KEY, "objects"]);
  const back = dagJson.decode(new TextEncoder().encode(JSON.stringify(v.message.body)));
  assert.deepEqual(dagCbor.encode(back), dagCbor.encode(body));
});

test("planDispatch / planPeers: the kernel's bodies (sender and key as bytes)", () => {
  const p = planDispatch(KEY, { op: "add", sender: KEY, box: "register", handler: String(encode({ kind: "program" } as never).cid) });
  const row = (p.messages[0]!.body as { row: { sender: Uint8Array; transport: string } }).row;
  assert.equal(p.messages[0]!.box, "dispatch");
  assert.deepEqual([row.transport, Buffer.from(row.sender).toString("hex")], ["mailbox", KEY]);
  const q = planPeers(KEY, [{ op: "add", key: KEY, transport: "mailbox", address: "https://x.example", handle: "bob", domain: "example.com" }, { op: "remove", key: KEY }]);
  assert.deepEqual(q.messages.map((m) => (m.body as { op: string }).op), ["add", "remove"]);
  assert.ok((q.messages[1]!.body as { key: unknown }).key instanceof Uint8Array);
  assert.throws(() => planPeers(KEY, [{ op: "remove", key: "02ab" }]), /not an identity key/);
});

test("planDispatch --http (#125): the owner's http row (prefix, fn, the handler's settings; no app); refusals", () => {
  const prog = encode({ kind: "program" } as never).cid;
  const p = planDispatch(KEY, { op: "add", box: "/", handler: "site.site", http: { prefix: true, fn: "get", settings: { root: "www" } } }, { "site.site": prog });
  const row = (p.messages[0]!.body as { row: Record<string, unknown> }).row;
  assert.deepEqual({ ...row, program: String(row.program) }, { transport: "http", address: "/", prefix: true, sender: "*", program: String(prog), fn: "get", root: "www" });
  assert.equal(p.prompt[0], `dispatch add http /* from anyone → site.site.get (${prog}) (root www)`);
  const s = planDispatch(KEY, { op: "add", box: "/x", sender: "session", handler: String(prog), http: { fn: "get" } });
  assert.deepEqual([(s.messages[0]!.body as { row: { sender: unknown; prefix?: unknown } }).row.sender, (s.messages[0]!.body as { row: { prefix?: unknown } }).row.prefix], ["session", undefined]);
  assert.throws(() => planDispatch(KEY, { op: "add", box: "x", handler: String(prog), http: { fn: "get" } }), /a path/);
  assert.throws(() => planDispatch(KEY, { op: "add", box: "/a/../b", handler: String(prog), http: { fn: "get" } }), /a path/);
  assert.throws(() => planDispatch(KEY, { op: "add", box: "/", handler: String(prog), http: { fn: "" } }), /--fn/);
  assert.throws(() => planDispatch(KEY, { op: "add", box: "/", handler: String(prog), http: { fn: "get", settings: { app: "site" } } }), /the row's own/);
  assert.throws(() => planDispatch(KEY, { op: "add", box: "x", sender: "session", handler: String(prog) }), /an http row's/);
});

test("host.env (#142): every SKEIN_* line, quotes and comments stripped, the environment wins; the operator's key made once, 0600", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "skein-hostenv-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, "host.env"), "# the host\nSKEIN_ROUTER_ORIGIN=https://id.example.com\nexport SKEIN_HANDLE_DOMAIN='example.com'\nSKEIN_HOST_NAME=\"A host\"\nSKEIN_ROUTER_PORT=8100 # the port\nOTHER=1\n");
  const v = withHostEnv({ SKEIN_HOME: home, SKEIN_ROUTER_PORT: "9000" });
  assert.deepEqual([v.SKEIN_ROUTER_ORIGIN, v.SKEIN_HANDLE_DOMAIN, v.SKEIN_HOST_NAME, v.SKEIN_ROUTER_PORT, v.OTHER], ["https://id.example.com", "example.com", "A host", "9000", undefined]);
  assert.throws(() => operatorKey(v), /no operator key/);
  const made = operatorKey(v, { create: true });
  assert.equal(made.made, true);
  assert.equal(statSync(made.path).mode & 0o777, 0o600);
  const again = operatorKey(v, { create: true });
  assert.deepEqual([again.made, identityOf(again.key)], [false, identityOf(made.key)]);
  const wif = join(home, "wif.key");
  writeFileSync(wif, `${made.key.toWif()}\n`);
  assert.equal(identityOf(operatorKey({ SKEIN_HOME: home, SKEIN_OPERATOR_KEY: wif }).key), identityOf(made.key), "a WIF key file reads as the same key");
});

test("signMessage (#142): the mail record the front door checks — sender, recipient, box, the body's CID, signed by the key", async () => {
  const key = PrivateKey.fromRandom();
  const m = await signMessage(keyWallet(key), { recipient: KEY, box: "git", body: dagCbor.encode({ fn: "git.clone", args: { url: "https://x", hash: "ab".repeat(20) } }) });
  const rec = m.message as { kind: string; op: string; sender: Uint8Array; recipient: Uint8Array; box: string; body: unknown; signature: Uint8Array };
  assert.deepEqual([rec.kind, rec.op, rec.box, Buffer.from(rec.sender).toString("hex"), Buffer.from(rec.recipient).toString("hex")], ["mail", "put", "git", key.toPublicKey().toString(), KEY]);
  assert.equal(String(rec.body), String(encode(dagCbor.decode(m.body) as never).cid));
  const { signature, ...unsigned } = rec;
  const ok = await new ProtoWallet("anyone").verifySignature({ protocolID: [2, "metanet handles envelope"], keyID: "send", counterparty: key.toPublicKey().toString(), data: [...dagCbor.encode(unsigned)], signature: [...signature], forSelf: false });
  assert.equal(ok.valid, true);
  const c = await signMessage(keyWallet(key), { box: "claim", body: dagCbor.encode({}) });
  assert.equal((c.message as { recipient?: unknown }).recipient, undefined, "a claim names no recipient (#127)");
});

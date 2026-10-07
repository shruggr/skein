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
import { messageJson, planGrant, planPeers, planRoute } from "./admin.ts";
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

/** A view with no store: what planRoute reads of an instance (the route table, the heads). */
const view = (dispatch: unknown[] = []) => ({ store: { get: async () => { throw new Error("none"); }, has: async () => false, bytes: async () => { throw new Error("none"); }, putBlock: async () => {} }, identity: KEY, programs: {}, addressBook: [], heads: [], dispatch }) as never;

test("planRoute / planPeers / planGrant: the kernel's bodies (a route with no sender, #143; a key as bytes)", async () => {
  const prog = encode({ kind: "program" } as never).cid;
  const p = await planRoute(view(), { op: "add", address: "register", handler: String(prog) });
  const row = (p.messages[0]!.body as { row: Record<string, unknown> }).row;
  assert.equal(p.messages[0]!.box, "dispatch");
  assert.deepEqual([row.transport, row.address, row.sender, String(row.program)], ["mailbox", "register", undefined, String(prog)]);
  const q = planPeers(KEY, [{ op: "add", key: KEY, transport: "mailbox", address: "https://x.example", handle: "bob", domain: "example.com" }, { op: "remove", key: KEY }]);
  assert.deepEqual(q.messages.map((m) => (m.body as { op: string }).op), ["add", "remove"]);
  assert.ok((q.messages[1]!.body as { key: unknown }).key instanceof Uint8Array);
  assert.throws(() => planPeers(KEY, [{ op: "remove", key: "02ab" }]), /not an identity key/);
  const g = await planGrant(view(), KEY, { role: "amm.admin" });
  assert.deepEqual([g.messages[0]!.box, (g.messages[0]!.body as { op: string; role: string }).op, (g.messages[0]!.body as { role: string }).role], ["grant", "add", "amm.admin"]);
  assert.ok((g.messages[0]!.body as { principal: unknown }).principal instanceof Uint8Array);
  await assert.rejects(planGrant(view(), KEY, { role: "user" }), /user is any principal/);
});

test("planRoute (#125, #143): root's own http route (prefix, filters, fn, settings; no app, no sender); a read route; removes; refusals", async () => {
  const prog = encode({ kind: "program" } as never).cid;
  const p = await planRoute(view(), { op: "add", address: "/x", prefix: true, filters: ["kernel.brc104"], handler: "site.site", fn: "get", settings: { root: "www" } }, { "site.site": prog });
  const row = (p.messages[0]!.body as { row: Record<string, unknown> }).row;
  assert.deepEqual({ ...row, program: String(row.program) }, { root: "www", transport: "http", address: "/x", prefix: true, filters: ["kernel.brc104"], program: String(prog), fn: "get" });
  assert.equal(p.prompt[0], `dispatch add http /x prefix [kernel.brc104] → ${prog}.get (root www) (root's own: no app)`);
  // A read route needs its filter declared by an installed app.
  await assert.rejects(planRoute(view(), { op: "add", address: "/", prefix: true, filters: ["site.get"] }), /no installed app site declares it/);
  const held = { transport: "http", address: "/y", program: prog, fn: "get" };
  const r = await planRoute(view([held]), { op: "remove", address: "/y" });
  assert.deepEqual((r.messages[0]!.body as { op: string; row: unknown }), { op: "remove", row: held }, "a remove sends the route as held");
  await assert.rejects(planRoute(view([{ ...held, app: "site" }]), { op: "remove", address: "/y" }), /root has no route there/);
  await assert.rejects(planRoute(view(), { op: "add", address: "x", transport: "http", handler: String(prog), fn: "get" }), /a path/);
  await assert.rejects(planRoute(view(), { op: "add", address: "/a/../b", handler: String(prog), fn: "get" }), /a path/);
  await assert.rejects(planRoute(view(), { op: "add", address: "/", handler: String(prog) }), /--fn/);
  await assert.rejects(planRoute(view(), { op: "add", address: "/", handler: String(prog), fn: "get", settings: { app: "site" } }), /the route's own/);
  await assert.rejects(planRoute(view(), { op: "add", address: "x", prefix: true, handler: String(prog) }), /--prefix: an http route's/);
  await assert.rejects(planRoute(view(), { op: "add", address: "/z" }), /only an http read route/);
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

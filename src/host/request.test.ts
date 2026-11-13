// The request path (skein next, SPEC 2, 4, 8, 8a) through the host and the real wasm kernel, over the
// test app (programs/test/next-app: the kernel's test program as app `next`):
//   - a BRC-104 request from the stock AuthFetch: the handshake answered by the host (nothing logged),
//     the request checked and committed, the reply signed on the session (AuthFetch verifies it);
//   - the host forgets the session: a plain 401 before the kernel is asked, and AuthFetch shakes hands
//     again by itself;
//   - a content-proven request whose check refuses: refused, nothing written;
//   - a host-signed root request installing an app's rows and granting a role, the result returned;
//   - a read row: CHECK only, nothing written;
//   - a handler that awaits a fact: the client held until the `answered` notice;
//   - a request over /skein/request/1.0.0 between two hosts (signed, content-proven, a read).

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { AuthFetch, PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { requestPayload } from "../client/raw.ts";
import { prefixedFetch } from "../session-base.ts";
import { ephemeralWallet } from "../wallet.ts";
import { DoorAnswered } from "./door-answer.ts";
import { peerIdOf, REQUEST_PROTOCOL } from "./p2p.ts";
import { bodyOf, imageTree, NEXT_APP, testHost } from "./testhost.ts";

const ROOT_ROWS = [
  { kind: "request", path: "/ping", role: "user", handler: "next.main.handle" },
  { kind: "request", path: "/spend", role: "anyone", checks: ["next.main.pass"], recheck: "next.main.unspent", handler: "next.main.handle" },
];

/** A host with instance `a` born owned, the test app installed at birth (its rows under /next/, root's /ping and /spend). */
async function hostWithApp(t: { after(f: () => unknown): void }, o: Parameters<typeof testHost>[1] = {}) {
  const h = await testHost(t, o);
  const img = await imageTree(join(h.home, "img"), { apps: [NEXT_APP], appRoutes: ROOT_ROWS });
  const id = await h.instance("a", img);
  await h.router.start();
  return { h, id };
}

/** The stock AuthFetch for `key` at `/@a` on the host, its handshakes counted. */
function client(base: string, key = PrivateKey.fromRandom()) {
  let handshakes = 0;
  const f = prefixedFetch(`${base}/@a`, (input, init) => {
    if (String(input instanceof Request ? input.url : input).endsWith("/.well-known/auth")) handshakes++;
    return globalThis.fetch(input, init);
  });
  return { af: new AuthFetch(ephemeralWallet(key), undefined, undefined, undefined, {}, f), key, handshakes: () => handshakes };
}

test("BRC-104 from the real AuthFetch: the handshake at the host (nothing logged), the request checked and committed, the reply signed and verified; a forgotten session → 401, and AuthFetch shakes hands again", { timeout: 120_000 }, async (t) => {
  const { h } = await hostWithApp(t);
  const c = client(h.base);
  const n0 = await h.entries("a");
  const r = await c.af.fetch(`${h.base}/@a/next/user`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hi: 1 }) });
  assert.equal(r.status, 200);
  const v = dagCbor.decode(new Uint8Array(await r.arrayBuffer())) as { path: string; caller: Uint8Array; body: Uint8Array };
  assert.equal(v.path, "/next/user", "the handler gets the matched path (the kernel stripped /@a)");
  assert.equal(Buffer.from(v.caller).toString("hex"), c.key.toPublicKey().toString(), "the caller is the session's key, verified by the kernel");
  assert.equal(c.handshakes(), 1);
  assert.equal(await h.entries("a"), n0 + 1, "one entry: the request (the handshake logs nothing)");
  assert.equal(h.router.sessions.size("a"), 1, "the session in host memory");
  const e = await (await h.router.hydrate("a")).kernel.store.get((await (await h.router.hydrate("a")).kernel.store.log.tip())!) as unknown as { door: { scheme: string; principal: Uint8Array } };
  assert.equal(e.door.scheme, "brc104");

  // The host forgets the session (a restart): a plain 401 before the kernel is asked; AuthFetch shakes hands again.
  h.router.sessions.forget("a");
  const r2 = await c.af.fetch(`${h.base}/@a/next/user`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hi: 2 }) });
  assert.equal(r2.status, 200, "answered after the second handshake");
  assert.equal(c.handshakes(), 2, "AuthFetch shook hands again by itself");
  assert.equal(await h.entries("a"), n0 + 2, "the 401 wrote nothing; the retried request one entry");

  // A request on a session the host never held: 401, nothing written.
  const forged = await fetch(`${h.base}/@a/next/user`, { method: "POST", headers: { "x-bsv-auth-version": "0.1", "x-bsv-auth-identity-key": c.key.toPublicKey().toString(), "x-bsv-auth-nonce": "bm9uY2U=", "x-bsv-auth-your-nonce": "bm9uY2U=", "x-bsv-auth-request-id": Buffer.alloc(32).toString("base64"), "x-bsv-auth-signature": "3006020101020101" }, body: "" });
  assert.equal(forged.status, 401);
  assert.equal(forged.headers.get("x-bsv-auth-signature"), null, "a plain 401: no auth headers");
  assert.equal(await h.entries("a"), n0 + 2);
});

test("a content-proven request whose check refuses writes nothing; one whose check passes is committed; a read row is CHECK only", { timeout: 120_000 }, async (t) => {
  const { h } = await hostWithApp(t);
  const n0 = await h.entries("a");
  const refused = await fetch(`${h.base}/@a/next/refused`, { method: "POST", body: "x" });
  assert.equal(refused.status, 418, "the check's own refusal");
  assert.deepEqual(await refused.json(), { status: "error", code: "ERR_NO", description: "no" });
  assert.equal(await h.entries("a"), n0, "nothing written (not even what the check put)");
  const proven = await fetch(`${h.base}/@a/next/proven`, { method: "POST", body: "y" });
  assert.equal(proven.status, 200);
  assert.equal(await h.entries("a"), n0 + 1);
  const none = await fetch(`${h.base}/@a/next/user`, { method: "POST", body: "z" });
  assert.equal(none.status, 401, "an unsigned request at a user row: refused, nothing written");
  assert.equal(await h.entries("a"), n0 + 1);
  const read = await fetch(`${h.base}/@a/next/read/thing`);
  assert.equal(read.status, 200);
  assert.deepEqual(dagCbor.decode(new Uint8Array(await read.arrayBuffer())), { read: "/next/read/thing" });
  assert.equal(await h.entries("a"), n0 + 1, "a read writes nothing");
  // An identical signed request is refused the second time (the unique map), nothing written.
  const { signRequest } = await import("../client/raw.ts");
  const once = await signRequest(h.owner, { recipient: (await h.router.hydrate("a")).identity, payload: requestPayload("POST", "/next/user", { n: 1 }) });
  await h.router.messageLocal("a", once);
  await assert.rejects(h.router.messageLocal("a", once), (e) => e instanceof DoorAnswered && e.answer.status === 409);
  assert.equal(await h.entries("a"), n0 + 2);
  // A recheck at COMMIT: /spend advances next/spent; the second is refused at COMMIT ("already spent").
  assert.equal((await fetch(`${h.base}/@a/spend`, { method: "POST", body: "1" })).status, 200);
  const again = await fetch(`${h.base}/@a/spend`, { method: "POST", body: "2" });
  assert.equal(again.status, 409);
  assert.equal(((await again.json()) as { code: string }).code, "ERR_SPENT");
  assert.equal(await h.entries("a"), n0 + 3);
});

test("a host-signed root request: the test app installed (objects, head, rows) and a role granted, each returning data; the granted key passes the role's row, another does not", { timeout: 120_000 }, async (t) => {
  const h = await testHost(t);
  await h.instance("b");
  await h.router.start();
  const plan = await h.install("b", NEXT_APP);
  assert.deepEqual(plan.requests.map((r) => r.path), ["/kernel/objects", "/kernel/head", ...plan.record.routes.map(() => "/kernel/route")]);
  const k = (await h.router.hydrate("b")).kernel;
  assert.ok(((await k.routes()).rows as Array<{ path?: string }>).some((r) => r.path === "/next/admin"), "the app's rows installed");
  const admin = PrivateKey.fromRandom();
  const g = await h.request("b", "POST", "/kernel/grant", { op: "add", role: "next.admin", principal: Uint8Array.from(Buffer.from(admin.toPublicKey().toString(), "hex")) });
  assert.deepEqual(dagCbor.decode(g.answer.body), { done: { changed: true } }, "the grant's result");
  const ok = await h.request("b", "POST", "/next/admin", { x: 1 }, admin);
  assert.equal(ok.answer.status, 200);
  await assert.rejects(h.request("b", "POST", "/next/admin", { x: 2 }, PrivateKey.fromRandom()), (e) => e instanceof DoorAnswered && e.answer.status === 403);
  // A refused kernel operation still writes its entry; its refusal is the answer (400).
  await assert.rejects(h.request("b", "POST", "/kernel/grant", { op: "add", role: "user", principal: new Uint8Array(33) }), /400/);
});

test("a handler that awaits a fact: COMMIT is `waiting`, the client held; another request emits the fact, the thread answers in the `answered` notice", { timeout: 120_000 }, async (t) => {
  const { h } = await hostWithApp(t);
  const c = client(h.base);
  const waiting = c.af.fetch(`${h.base}/@a/next/awaitname`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  let done = false;
  void waiting.then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(done, false, "held: its handler waits");
  await h.request("a", "POST", "/ping", {});
  const r = await waiting;
  assert.equal(r.status, 200);
  assert.deepEqual(dagCbor.decode(new Uint8Array(await r.arrayBuffer())), { woke: "next/ping" }, "the answer from the woken thread, signed on the session");
});

test("/skein/request/1.0.0 between two hosts: a frame is a request record (signed, content-proven, a read), the answer frame the handler's answer", { timeout: 120_000 }, async (t) => {
  const { h: h1, id: aId } = await hostWithApp(t, { libp2p: true });
  const h2 = await testHost(t, { libp2p: true });
  await h2.instance("b");
  await h2.router.start();
  // The nodes (no app here declares membership: the test starts them).
  await h1.router.p2p!.declare("a", { topics: [], protocols: [] });
  await h2.router.p2p!.declare("b", { topics: [], protocols: [] });
  await h2.router.p2p!.connect("b", h1.router.p2p!.peerId("a"), h1.router.p2p!.addrs("a"));
  const ask = async (record: unknown) => dagCbor.decode((await h2.router.p2p!.call("b", h1.router.p2p!.peerId("a"), REQUEST_PROTOCOL, dagCbor.encode(record))).body) as { status: number; body: Uint8Array };
  const n0 = await h1.entries("a");
  // Signed by b's key (Router.signRequest) to a: the kernel verifies the `signed` scheme; the caller is b.
  const signed = await h2.router.signRequest("b", { recipient: aId, payload: requestPayload("POST", "/next/user", { from: "b" }) });
  const a1 = await ask(signed);
  assert.equal(a1.status, 200);
  assert.equal(Buffer.from((dagCbor.decode(a1.body) as { caller: Uint8Array }).caller).toString("hex"), (await h2.router.hydrate("b")).identity);
  // Content-proven, and refused.
  assert.equal((await ask({ kind: "request", payload: requestPayload("POST", "/next/proven", new Uint8Array([1])) })).status, 200);
  assert.equal((await ask({ kind: "request", payload: requestPayload("POST", "/next/refused", new Uint8Array([1])) })).status, 418);
  // A read.
  const rd = await ask({ kind: "request", payload: requestPayload("GET", "/next/read/x") });
  assert.deepEqual([rd.status, dagCbor.decode(rd.body)], [200, { read: "/next/read/x" }]);
  assert.equal(await h1.entries("a"), n0 + 2, "the signed and the proven requests: an entry each; the refusal and the read none");
  assert.equal(peerIdOf(PrivateKey.fromRandom()).toString().length > 0, true);
});

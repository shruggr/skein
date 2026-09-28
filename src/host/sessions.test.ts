// BRC-104 sessions belong to the instance (#33 part 2), end to end with the
// real Zig kernel: the stock clients' session peer is the instance's
// identity; every session signature in the log verifies with the instance's
// own key (no router key); compact messages both ways on a session that asked
// for them; a per-instance origin (host name) reaches that instance's session;
// expiry by the instance's policy over entry stamps, the stock client
// shaking hands again by itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { join } from "node:path";
import { AuthFetch, PrivateKey, ProtoWallet } from "@bsv/sdk";
import { MessageBoxClient } from "@bsv/message-box-client";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { seal } from "../envelope.ts";
import { msStamp } from "../runtime/syscalls.ts";
import { encode } from "../runtime/cid.ts";
import { bundlesOf } from "../testkit.ts";
import { ephemeralWallet } from "../wallet.ts";
import { cborBoxClient } from "./brc231.ts";
import { HostDb } from "./instances.ts";
import { KERNEL_BIN, type Kernel } from "./kernel.ts";
import { Router } from "./router.ts";

const until = async <T>(what: string, f: () => Promise<T | undefined> | T | undefined, ms = 30_000): Promise<T> => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    const v = await f();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out: ${what}`);
};

const PROTOCOL: [2, string] = [2, "auth message signature"];

/** The `:auth` event records in the instance's log, oldest first. */
async function authEvents(k: Kernel): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let c = await k.store.log.tip();
  while (c) {
    const e = await k.store.get(c) as Record<string, unknown>;
    if (e.box === ":auth") out.unshift(await k.store.get(e.event as CID) as Record<string, unknown>);
    c = e.prev as CID | undefined;
  }
  return out;
}

async function sessionsOf(k: Kernel): Promise<Array<Record<string, unknown>>> {
  const root = await k.call("head", "sessions") as CID | null;
  if (!root) return [];
  const r = await k.store.get(root) as unknown as { sessions: Array<{ session: CID }> };
  return Promise.all(r.sessions.map(async (x) => await k.store.get(x.session) as Record<string, unknown>));
}

test("sessions in the instance: the peer is the instance, signatures verify from its log, compact both ways, per-instance origins, expiry", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  const home = await fs.mkdtemp(join(tmpdir(), "skein-sessions-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const db = new HostDb(join(home, "host.db"));
  t.after(() => db.close());
  db.add("alpha", { store: join(home, "instances/alpha/runtime.db") });
  db.add("beta", { store: join(home, "instances/beta/runtime.db") });
  const keys: Record<string, PrivateKey> = { alpha: PrivateKey.fromRandom(), beta: PrivateKey.fromRandom() };
  const ownerKey = PrivateKey.fromRandom();
  const owner = ephemeralWallet(ownerKey), ownerId = ownerKey.toPublicKey().toString();
  let skew = 0;
  const router = new Router({
    db, walletFor: (row) => ephemeralWallet(keys[row.handle]!), owner: ownerId, idleMs: 0, mailboxHost: "alpha",
    now: () => msStamp(Date.now() + skew), kernel: { env: { SKEIN_HOME: home } },
    log: (s, l) => { if (process.env.VERBOSE) console.log(`[${s}] ${l}`); },
  });
  t.after(() => router.stop());
  const port = ((await router.listen(0)).address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  await router.start();
  const alpha = keys.alpha!.toPublicKey().toString(), beta = keys.beta!.toPublicKey().toString();
  const alphaK = () => router.loaded.get("alpha")!.kernel;

  // The stock client at the bare URL: its session is with the front instance's identity.
  const reg = new AuthFetch(owner);
  const r0 = await reg.fetch(`${base}/account/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "david" }) });
  assert.equal(r0.status, 200, await r0.clone().text());
  assert.equal((reg as unknown as { peers: Record<string, { identityKey?: string }> }).peers[base]!.identityKey, alpha, "the session's peer key is the instance's identity");
  const mb = new MessageBoxClient({ host: `${base}/messagebox`, walletClient: owner });
  assert.deepEqual(await mb.listMessagesLite({ messageBox: "results", host: `${base}/messagebox` }), []);
  const [s1] = (await sessionsOf(alphaK())).filter((s) => Buffer.from(s.peer as Uint8Array).toString("hex") === ownerId);
  assert.ok(s1 && s1.authenticated === true && s1.compact === false, "the session is a record in the instance");

  // A per-instance origin (a host name per handle): the stock AuthFetch keeps one session per origin, this one with beta.
  // (node:http, so the Host header goes as given: `beta.test` resolves nowhere.)
  const hostFetch = ((url: string, init: RequestInit & { headers?: Record<string, string> }) => new Promise<Response>((resolve, reject) => {
    const u = new URL(url);
    const req = request({ host: "127.0.0.1", port, method: init.method ?? "GET", path: u.pathname + u.search, headers: { ...init.headers, host: u.host } } as never, (res: import("node:http").IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === "string") h.set(k, v);
        resolve(new Response(res.statusCode === 204 ? null : Buffer.concat(chunks), { status: res.statusCode, headers: h }));
      });
    });
    req.on("error", reject);
    if (init.body) req.write(init.body as Uint8Array | string);
    req.end();
  })) as unknown as typeof fetch;
  const bf = new AuthFetch(owner, undefined, undefined, undefined, {}, hostFetch);
  const rb = await bf.fetch(`http://beta.test:${port}/messagebox/listMessages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageBox: "x" }) });
  assert.equal(rb.status, 200, await rb.clone().text()); // answered (the mail is where it is kept), and signed by beta:
  assert.equal((bf as unknown as { peers: Record<string, { identityKey?: string }> }).peers[`http://beta.test:${port}`]!.identityKey, beta);
  assert.equal((await sessionsOf(router.loaded.get("beta")!.kernel)).length, 1, "beta's session is beta's record");
  // The routes: a path prefix names the instance (the rest is what the transport signs); else the host name; else the front.
  assert.deepEqual(router.front("/@beta/.well-known/auth"), { handle: "beta", path: "/.well-known/auth" });
  assert.deepEqual(router.front("/messagebox/sendMessage", `beta.example:${port}`), { handle: "beta", path: "/messagebox/sendMessage" });
  assert.deepEqual(router.front("/messagebox/sendMessage", `127.0.0.1:${port}`), { handle: "alpha", path: "/messagebox/sendMessage" });
  assert.equal(router.front("/@nobody/x"), undefined);
  // The reserved boxes are not a client's to name.
  await assert.rejects(mb.sendMessage({ recipient: alpha, messageBox: ":auth", body: "x", skipEncryption: true }, `${base}/messagebox`), /ERR_INVALID_MESSAGEBOX/);

  // Compact both ways: a BRC-231 client asks for compact messages on its session with alpha.
  const cb = cborBoxClient(owner, `${base}/messagebox`, { compact: true });
  assert.deepEqual(await cb.list("results"), []);
  const dir = await fs.mkdtemp(join(tmpdir(), "skein-sessions-tree-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(join(dir, "README"), "hello\n");
  const { root, bundles } = await bundlesOf(dir);
  const sendFull = async (box: string, body: unknown) => {
    const env = await seal(owner, { recipient: { identityKey: alpha, handle: "alpha", domain: "localhost" }, body: body instanceof Uint8Array ? body : dagCbor.encode(body), created: new Date().toISOString() });
    await mb.sendMessage({ recipient: alpha, messageBox: box, body: env as unknown as Record<string, unknown>, skipEncryption: true }, `${base}/messagebox`);
    return encode((await import("../envelope.ts")).signedPart(env)).cid;
  };
  for (const b of bundles) await sendFull("objects", b);
  const asked = await sendFull("run", { cmd: "cat README", tree: root });
  const [m] = await until("the compact answer", async () => { const x = await cb.list("results"); return x.length ? x : undefined; });
  assert.equal(m!.sender, alpha);
  const rec = dagCbor.decode(m!.body as Uint8Array) as { type: string; replyTo?: CID; id?: CID; body: Uint8Array; session: { payload: Uint8Array; signature: Uint8Array; nonce: string; yourNonce: string } };
  assert.equal(rec.type, "reply");
  assert.ok(rec.replyTo?.equals(asked), "it answers the run");
  assert.deepEqual(Buffer.from(rec.session.payload), Buffer.from(dagCbor.encode({ type: rec.type, replyTo: rec.replyTo, id: rec.id, body: rec.body })), "the signed payload is the compact message");
  const out = dagCbor.decode(rec.body) as { stdout: Uint8Array; stderr?: Uint8Array };
  assert.equal(Buffer.from(out.stdout).toString(), "hello\n", Buffer.from(out.stderr ?? []).toString());
  const mine = await owner.verifySignature({ data: [...rec.session.payload], signature: [...rec.session.signature], protocolID: PROTOCOL, keyID: `${rec.session.nonce} ${rec.session.yourNonce}`, counterparty: alpha });
  assert.equal(mine.valid, true, "the client verifies the instance's session signature");
  await cb.ack([m!.messageId]);
  // A stock JSON client on another session (no compact asked) still gets full envelopes: router.test.ts.

  // The client answers compact on the same session (client → agent), naming the message's `id`.
  assert.ok(rec.id, "a compact message names what a reply to it names");
  await cb.send({ recipient: alpha, box: "chat-none", body: dagCbor.encode({ type: "reply", replyTo: rec.id, body: dagCbor.encode({ text: "thanks" }) }) });
  await router.settled();
  let e = await alphaK().store.get(await alphaK().store.log.tip() as CID) as Record<string, unknown>;
  while (!e.envelope) e = await alphaK().store.get(e.prev as CID) as Record<string, unknown>;
  const replyRec = await alphaK().store.get(e.envelope as CID) as unknown as { type: string; session: { payload: Uint8Array; signature: Uint8Array; nonce: string; yourNonce: string } };
  assert.equal(replyRec.type, "reply");

  // Every session signature in the log verifies with the instance's own key alone.
  const inst = new ProtoWallet(keys.alpha!);
  const evs = await authEvents(alphaK());
  const requests = evs.filter((e) => e.op === "request");
  assert.ok(requests.length >= 5, `requests recorded (${requests.length})`);
  const owned = await sessionsOf(alphaK());
  for (const e of requests) {
    const peer = Buffer.from(e.identityKey as Uint8Array).toString("hex");
    const v = await inst.verifySignature({ data: [...(e.payload as Uint8Array)], signature: [...(e.signature as Uint8Array)], protocolID: PROTOCOL, keyID: `${String(e.nonce)} ${String(e.yourNonce)}`, counterparty: peer }).catch(() => ({ valid: false }));
    assert.equal(v.valid, true, `a recorded request signature verifies with the instance key (${peer.slice(0, 8)})`);
  }
  assert.ok(owned.every((s) => typeof s.sessionNonce === "string" && typeof s.peerNonce === "string"));
  // The session reply's recorded proof (part 1 needed the router's key for it): the instance's key alone.
  const rs = replyRec.session;
  assert.equal((await inst.verifySignature({ data: [...rs.payload], signature: [...rs.signature], protocolID: PROTOCOL, keyID: `${rs.nonce} ${rs.yourNonce}`, counterparty: ownerId })).valid, true, "the session reply verifies from the log");
  // Its own signatures too: the compact message above verifies with the instance's key (forSelf), as the client's did.
  assert.equal((await inst.verifySignature({ data: [...rec.session.payload], signature: [...rec.session.signature], protocolID: PROTOCOL, keyID: `${rec.session.nonce} ${rec.session.yourNonce}`, counterparty: ownerId, forSelf: true })).valid, true);

  // Expiry: the instance's policy (defaults.sessionTtlMs, a day), judged by entry stamps. Two days on, the
  // stock client's session is gone; it gets a plain 401, shakes hands again by itself, and the call succeeds.
  const before = (await sessionsOf(alphaK())).map((s) => s.sessionNonce);
  skew = 2 * 86_400_000;
  assert.deepEqual(await mb.listMessagesLite({ messageBox: "results", host: `${base}/messagebox` }), []);
  const after = (await sessionsOf(alphaK())).map((s) => s.sessionNonce);
  assert.ok(after.length >= 1 && after.every((n) => !before.includes(n)), "the old sessions expired; a new one was made");
});

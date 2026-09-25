import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encode } from "./cid.ts";
import { ensureGenesis, readLog } from "./log.ts";
import { memoryStore } from "./memory.ts";
import { signMessage, type Message } from "./records.ts";
import { Runtime } from "./scheduler.ts";
import { encodeFrame, FrameReader, Transport, type Control } from "./transport.ts";
import { connectPeer } from "../peers/connection.ts";
import { ephemeralWallet, signerFor } from "../wallet.ts";

async function setup(t: { after(fn: () => Promise<void> | void): void }) {
  const dir = await fs.mkdtemp(join(tmpdir(), "skein-tr-"));
  const sock = join(dir, "runtime.sock");
  const wallet = ephemeralWallet();
  const store = memoryStore();
  await ensureGenesis(store, wallet);
  const rt = new Runtime({ store, wallet });
  const transport = new Transport({ get identity() { return rt.identity; }, admit: (m) => rt.admit(m), nextSeq: (id) => rt.nextSeq(id) });
  rt.outbox = transport;
  await rt.start();
  await transport.listen(sock);
  t.after(async () => { await transport.close(); await rt.stop(); await fs.rm(dir, { recursive: true, force: true }); });
  return { sock, wallet, store, rt, transport };
}

/** A raw connection: write frames, collect what comes back until the socket closes or `ms` passes. */
function raw(sock: string) {
  const s = connect(sock);
  const reader = new FrameReader();
  const got: unknown[] = [];
  let closed = false;
  s.on("data", (c: Buffer) => got.push(...reader.push(c)));
  s.on("close", () => { closed = true; });
  s.on("error", () => {});
  return {
    send: (v: unknown) => s.write(encodeFrame(v)),
    got,
    get closed() { return closed; },
    settle: (ms = 150) => new Promise((r) => setTimeout(r, ms)),
    end: () => s.destroy(),
  };
}

test("transport: hello is required first; the connection is refused otherwise", async (t) => {
  const { sock, wallet, store } = await setup(t);
  const before = (await readLog(store)).length;
  const david = await signerFor(wallet, "david");
  const c = raw(sock);
  c.send(await signMessage(david, { seq: 0, at: 1, body: { kind: "run", cmd: "true" } }));
  await c.settle();
  assert.deepEqual((c.got[0] as Control).kind, "rejected");
  assert.match((c.got[0] as { reason: string }).reason, /hello required/);
  assert.ok(c.closed);
  // A hello naming someone else than its signer is not a hello.
  const d = raw(sock);
  d.send(await signMessage(david, { seq: 0, at: 1, body: { kind: "hello", identity: (await signerFor(wallet, "admin")).identity } }));
  await d.settle();
  assert.equal((d.got[0] as Control).kind, "rejected");
  assert.equal((await readLog(store)).length, before, "nothing admitted");
});

test("transport: unsigned, tampered, or foreign-signed inbound messages are rejected and not logged", async (t) => {
  const { sock, wallet, store } = await setup(t);
  const before = (await readLog(store)).length;
  const david = await signerFor(wallet, "david");
  const stranger = await signerFor(ephemeralWallet(), "david");
  const c = raw(sock);
  c.send(await signMessage(david, { seq: 0, at: 1, body: { kind: "hello", identity: david.identity } }));
  await c.settle(50);
  const welcome = c.got[0] as Extract<Control, { kind: "welcome" }>;
  assert.equal(welcome.kind, "welcome");

  const good = await signMessage(david, { seq: welcome.next, at: 2, body: { kind: "note", text: "hi" } });
  const tampered = { ...good, body: { kind: "note", text: "forged" } };
  const unsigned = { ...good, seq: welcome.next + 1, sig: new Uint8Array(0) };
  const foreign = await signMessage(stranger, { seq: 0, at: 3, body: { kind: "note", text: "not david" } });
  c.send(tampered);
  c.send(unsigned);
  c.send(foreign);
  c.send({ kind: "not-a-message" });
  c.send(good);
  await c.settle();
  const replies = c.got.slice(1) as Control[];
  assert.deepEqual(replies.map((r) => r.kind), ["rejected", "rejected", "rejected", "rejected", "admitted"]);
  assert.deepEqual(replies.slice(0, 3).map((r) => (r as { reason: string }).reason.split(":")[0]), ["bad-signature", "bad-signature", "wrong-sender"]);
  const log = await readLog(store);
  assert.equal(log.length, before + 1, "only the good one");
  assert.ok(encode(log.at(-1)!.message).cid.equals(encode(good).cid));
  c.end();
});

test("transport: a message to an unconnected identity is held, then delivered on hello", async (t) => {
  const { sock, wallet, rt, transport } = await setup(t);
  const peer = await signerFor(wallet, "peer");
  const runtimeSigner = await signerFor(wallet, "runtime");
  const m = await signMessage(runtimeSigner, { to: peer.identity, seq: 999, at: 1, body: { kind: "time", state: encode({ x: 1 }).cid } });
  rt.outbox!.send(m);
  assert.equal(transport.heldFor(peer.identity).length, 1);
  const got: Message[] = [];
  const conn = await connectPeer(peer, sock);
  conn.onMessage((x) => got.push(x));
  for (let i = 0; i < 50 && !got.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(got.length, 1);
  assert.ok(encode(got[0]).cid.equals(encode(m).cid));
  assert.equal(transport.heldFor(peer.identity).length, 0);
  // Connected now: delivered straight away.
  const m2 = await signMessage(runtimeSigner, { to: peer.identity, seq: 1000, at: 2, body: { kind: "time", state: encode({ x: 2 }).cid } });
  rt.outbox!.send(m2);
  for (let i = 0; i < 50 && got.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(got.length, 2);
  conn.close();
});

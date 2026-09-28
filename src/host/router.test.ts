// The router (#33) end to end with the real Zig kernel: the stock
// @bsv/message-box-client, authenticated (BRC-104) against the router,
// sends into an instance; the instance answers into the owner's mailbox
// (kept by the instance); list and acknowledge work; an idle instance is
// stopped and hydrated again on demand; a sleeper's wake fires after
// hydration (the waker is the router's timer).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthFetch, PrivateKey } from "@bsv/sdk";
import { MessageBoxClient } from "@bsv/message-box-client";
import * as dagCbor from "@ipld/dag-cbor";
import { open, seal, verify, type Envelope } from "../envelope.ts";
import { bundlesOf } from "../testkit.ts";
import { ephemeralWallet } from "../wallet.ts";
import { HostDb } from "./instances.ts";
import { KERNEL_BIN } from "./kernel.ts";
import { Router } from "./router.ts";

const until = async <T>(what: string, f: () => Promise<T | undefined> | T | undefined, ms = 30_000): Promise<T> => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    const v = await f();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out: ${what}`);
};

test("router: messagebox client → instance → owner's mailbox; list/ack; idle stop and hydrate on demand; a wake after hydration", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  const home = await fs.mkdtemp(join(tmpdir(), "skein-router-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const db = new HostDb(join(home, "host.db"));
  t.after(() => db.close());
  db.add("alpha", { store: join(home, "instances/alpha/runtime.db") });
  const instanceKey = PrivateKey.fromRandom(), ownerKey = PrivateKey.fromRandom();
  const owner = ephemeralWallet(ownerKey), ownerId = ownerKey.toPublicKey().toString();
  const lines: string[] = [];
  const router = new Router({
    db, walletFor: () => ephemeralWallet(instanceKey), authWallet: ephemeralWallet(),
    owner: ownerId, idleMs: 1500, kernel: { env: { SKEIN_HOME: home } },
    log: (s, l) => { lines.push(`[${s}] ${l}`); if (process.env.VERBOSE) console.log(`[${s}] ${l}`); },
  });
  t.after(() => router.stop());
  const server = await router.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await router.start();
  const alpha = db.get("alpha")!.identity!;
  assert.equal(alpha, instanceKey.toPublicKey().toString(), "the row's identity is recorded at first hydration");

  // The owner registers a mailbox (kept by alpha), as the front end's Register does.
  const reg = await new AuthFetch(owner).fetch(`${base}/account/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "david" }) });
  assert.equal(reg.status, 200, await reg.clone().text());
  assert.deepEqual(await (await fetch(`${base}/bsvalias/id/david@localhost`)).json(), { bsvalias: "1.0", handle: "david@localhost", pubkey: ownerId });
  assert.equal((await fetch(`${base}/bsvalias/id/alpha@localhost`).then((r) => r.json()) as { pubkey: string }).pubkey, alpha);

  const mb = new MessageBoxClient({ host: `${base}/messagebox`, walletClient: owner });
  const sendTo = async (box: string, body: unknown) => {
    const env = await seal(owner, { recipient: { identityKey: alpha, handle: "alpha", domain: "localhost" }, body: body instanceof Uint8Array ? body : dagCbor.encode(body), created: new Date().toISOString() });
    await mb.sendMessage({ recipient: alpha, messageBox: box, body: env as unknown as Record<string, unknown>, skipEncryption: true }, `${base}/messagebox`);
  };
  const results = async (n: number) => until(`${n} result(s)`, async () => {
    const ms = await mb.listMessagesLite({ messageBox: "results", host: `${base}/messagebox` });
    return ms.length >= n ? ms : undefined;
  });
  const read = async (m: { body: unknown }) => {
    const e = (typeof m.body === "string" ? JSON.parse(m.body) : m.body) as Envelope;
    assert.ok(verify(e));
    return dagCbor.decode((await open(owner, e)).body) as Record<string, unknown>;
  };

  const dir = await fs.mkdtemp(join(tmpdir(), "skein-router-tree-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(join(dir, "README"), "hello\n");
  const { root, bundles } = await bundlesOf(dir);
  for (const b of bundles) await sendTo("objects", b);
  await sendTo("run", { cmd: "cat README", tree: root });
  const [r1] = await results(1);
  const b1 = await read(r1!);
  assert.equal(Buffer.from(b1.stdout as Uint8Array).toString(), "hello\n");
  assert.equal(r1!.sender, alpha);
  await mb.acknowledgeMessage({ messageIds: [r1!.messageId], host: `${base}/messagebox` });
  assert.equal((await mb.listMessagesLite({ messageBox: "results", host: `${base}/messagebox` })).length, 0, "acknowledged");

  // Idle: the kernel is stopped; the next message hydrates it again.
  await until("alpha idle-stopped", () => !router.loaded.has("alpha"), 10_000);
  await sendTo("run", { cmd: "echo again", tree: root });
  const [r2] = await results(1);
  assert.equal(Buffer.from((await read(r2!)).stdout as Uint8Array).toString(), "again\n");
  assert.ok(lines.filter((l) => l.startsWith("[router] hydrated alpha")).length >= 2, "hydrated twice");
  await mb.acknowledgeMessage({ messageIds: [r2!.messageId], host: `${base}/messagebox` });

  // A sleep longer than the idle timeout: the kernel stops mid-sleep; the waker hydrates it at the deadline and admits the wake.
  await sendTo("run", { cmd: "sleep 3; echo woke", tree: root });
  await until("alpha stopped while its thread sleeps", () => !router.loaded.has("alpha") && router.deadlines.has("alpha") ? true : undefined, 10_000);
  const [r3] = await results(1);
  assert.equal(Buffer.from((await read(r3!)).stdout as Uint8Array).toString(), "woke\n");
  assert.ok(lines.some((l) => /^\[alpha\] tick: wake /.test(l)), lines.join("\n"));

  // A recipient with no account here is refused as the messagebox refused it.
  await assert.rejects(mb.sendMessage({ recipient: PrivateKey.fromRandom().toPublicKey().toString(), messageBox: "x", body: "hi", skipEncryption: true }, `${base}/messagebox`), /HTTP 403 \(ERR_ACCOUNT_REQUIRED\)/);

  // The owner's mail is the instance's records (the messagebox program), not the router's memory: a new router lists it.
  await router.stop();
  const again = new Router({ db, walletFor: () => ephemeralWallet(instanceKey), authWallet: ephemeralWallet(), owner: ownerId, idleMs: 0, kernel: { env: { SKEIN_HOME: home } } });
  t.after(() => again.stop());
  const base2 = `http://127.0.0.1:${((await again.listen(0)).address() as { port: number }).port}`;
  const mb2 = new MessageBoxClient({ host: `${base2}/messagebox`, walletClient: owner });
  const kept = await mb2.listMessagesLite({ messageBox: "results", host: `${base2}/messagebox` });
  assert.deepEqual(kept.map((m) => m.messageId), [r3!.messageId], "unacknowledged mail survives the router");
  await mb2.acknowledgeMessage({ messageIds: [r3!.messageId], host: `${base2}/messagebox` });
  assert.equal((await mb2.listMessagesLite({ messageBox: "results", host: `${base2}/messagebox` })).length, 0);
  await assert.rejects(mb2.acknowledgeMessage({ messageIds: ["nope"], host: `${base2}/messagebox` }), /Failed to acknowledge/);

  // BRC-231: a §7.3 (dag-cbor) envelope in, the answer in the same form, listed as bytes.
  const { cborBoxClient } = await import("./brc231.ts");
  const { sealCbor, openCbor, asEnvelope, isCborEnvelope } = await import("../envelope-cbor.ts");
  const cb = cborBoxClient(owner, `${base2}/messagebox`);
  const env = await sealCbor(owner, { recipient: { identityKey: alpha, handle: "alpha", domain: "localhost" }, body: dagCbor.encode({ cmd: "echo cbor", tree: root }) });
  await cb.send({ recipient: alpha, box: "run", body: env });
  const [c1] = await until("the CBOR answer", async () => { const x = await cb.list("results"); return x.length ? x : undefined; });
  assert.ok(c1!.body instanceof Uint8Array);
  const back = asEnvelope(c1!.body);
  assert.ok(back && isCborEnvelope(back), "answered in the form it was asked in");
  assert.equal(Buffer.from((dagCbor.decode((await openCbor(owner, back)).body) as { stdout: Uint8Array }).stdout).toString(), "cbor\n");
  await cb.ack([c1!.messageId]);
  assert.equal((await cb.list("results")).length, 0);

  // Session replies: the standard client sends the full envelope (the first message on its session); the
  // answer to the agent's reply goes back compact on the same session ({type: "reply", replyTo, body},
  // BRC-231 bytes). Both land as the same entry shape; list/ack are unaffected.
  const { sessionRecord } = await import("../envelope-cbor.ts");
  const { signedPart } = await import("../envelope.ts");
  const { encode } = await import("../runtime/cid.ts");
  const first = await seal(owner, { recipient: { identityKey: alpha, handle: "alpha", domain: "localhost" }, body: dagCbor.encode({ cmd: "echo session", tree: root }), created: new Date().toISOString() });
  await mb2.sendMessage({ recipient: alpha, messageBox: "run", body: first as unknown as Record<string, unknown>, skipEncryption: true }, `${base2}/messagebox`);
  const [answer] = await until("the agent's reply", async () => { const x = await mb2.listMessagesLite({ messageBox: "results", host: `${base2}/messagebox` }); return x.length ? x : undefined; });
  const answerEnv = (typeof answer!.body === "string" ? JSON.parse(answer!.body) : answer!.body) as Envelope;
  const answerId = encode(signedPart(answerEnv)).cid;
  const same = cborBoxClient(mb2.authFetch, `${base2}/messagebox`); // the standard client's own session
  const compactBody = dagCbor.encode({ text: "thanks" });
  await same.send({ recipient: alpha, box: "chat", body: dagCbor.encode({ type: "reply", replyTo: answerId, body: compactBody }) });
  await again.settled();
  const k = again.loaded.get("alpha")!.kernel;
  const tip = await k.store.log.tip();
  const last = await k.store.get(tip!) as Record<string, unknown>;
  let prev = await k.store.get(last.prev as never) as Record<string, unknown>;
  while (!prev.envelope) prev = await k.store.get(prev.prev as never) as Record<string, unknown>; // back past the run's outcome entries
  assert.deepEqual(Object.keys(last).sort(), Object.keys(prev).sort(), "a session reply is the same entry shape as a full envelope");
  assert.deepEqual(Object.keys(last).sort(), ["body", "box", "envelope", "kind", "n", "prev", "time"]);
  const rec = await k.store.get(last.envelope as never) as unknown as ReturnType<typeof sessionRecord>;
  assert.equal(rec.type, "reply");
  assert.ok(rec.replyTo.equals(answerId));
  assert.equal(Buffer.from(rec.sender.identityKey).toString("hex"), ownerId);
  assert.ok(rec.session.signature.length > 60 && rec.session.nonce && rec.session.yourNonce, "the BRC-104 signature and the nonces are recorded");
  assert.ok(Buffer.from(rec.session.payload).indexOf(Buffer.from(compactBody)) >= 0, "the signed request carries the body");
  // A compact message that answers nothing here is refused (the first message on a session is a full envelope).
  await assert.rejects(same.send({ recipient: alpha, box: "chat", body: dagCbor.encode({ type: "reply", replyTo: encode({ nothing: 1 }).cid, body: compactBody }) }), /ERR_REJECTED/);
  await mb2.acknowledgeMessage({ messageIds: [answer!.messageId], host: `${base2}/messagebox` });
  assert.equal((await mb2.listMessagesLite({ messageBox: "results", host: `${base2}/messagebox` })).length, 0);
});

test("skein-host run: the router with the oracle — a row added by the CLI gets the derived identity; its kernel's genesis is that identity; host page and roster", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  const home = await fs.mkdtemp(join(tmpdir(), "skein-run-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const { main, runHost } = await import("./cli.ts");
  const { Oracle, masterKey } = await import("./oracle.ts");
  const out: string[] = [];
  const vars = { SKEIN_HOME: home, SKEIN_ROUTER_PORT: "0", SKEIN_HOST_PORT: "0", SKEIN_EXPLORE_BASE_PORT: "off", SKEIN_OWNER: PrivateKey.fromRandom().toPublicKey().toString(), SKEIN_KERNEL_BIN: KERNEL_BIN };
  const env = { vars, out: (l: string) => out.push(l), err: (l: string) => out.push(l) };
  assert.equal(await main(["add", "solo", "--domain", "example.test"], env), 0);
  const db = new HostDb(join(home, "host.db"));
  t.after(() => db.close());
  const id = new Oracle(masterKey(vars, home)).identity("solo");
  assert.equal(db.get("solo")!.identity, id);
  const host = await runHost(db, env);
  t.after(() => host.stop());
  assert.ok(out.some((l) => l.startsWith("[router] hydrated solo")), out.join("\n"));
  await until("the ready line", () => out.some((l) => l.startsWith(`[solo] skein runtime ${id} (solo@example.test)`)), 5000);
  const roster = await (await fetch(`http://127.0.0.1:${host.port}/roster.json`)).json() as Array<{ handle: string; status: string }>;
  assert.deepEqual(roster.map((r) => [r.handle, r.status]), [["solo", "live"]]);
  const page = await (await fetch(`http://127.0.0.1:${host.port}/`)).text();
  assert.match(page, /<b>solo<\/b>@example\.test/);
  assert.ok(page.includes(`messagebox <code>http://127.0.0.1:${host.messagebox}/messagebox</code>`) && page.includes("mailboxes kept here"), page);
  assert.equal((await (await fetch(`http://127.0.0.1:${host.messagebox}/bsvalias/id/solo@example.test`)).json() as { pubkey: string }).pubkey, id);
});

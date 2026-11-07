// The router as a reverse proxy (#40), end to end with the real Zig kernel:
// every instance is an HTTP server (its front door) at its own origin; the
// stock @bsv/message-box-client talks to an instance by host name, our raw
// BRC-33 client by path prefix; the instance answers into its owner's mailbox —
// the hosted messagebox another test host keeps — over http; the owner lists
// and acknowledges there; a poll is a read (no entry), it moves nothing; sessions are records and survive a killed kernel. The host's
// headers feed (#102) reaches only the instances with a row taking events in
// box `chain`, following their dispatch tables live. A registration from a
// page (#103, #113): signed by the key over `register <name>@<domain>`,
// carried by the router into the host skein, where the onboarding app asks
// the instance manager for the mailbox and the certifier for the handle
// certificate, records both and answers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { MessageBoxClient } from "@bsv/message-box-client";
import { AuthFetch, Certificate, MasterCertificate, PrivateKey, ProtoWallet, Utils } from "@bsv/sdk";
import { CID } from "multiformats/cid";
import { RawBox } from "../client/raw.ts";
import { KERNEL_BIN, type Kernel } from "./kernel.ts";
import { main } from "./cli.ts";
import { sendPlan } from "../testapps.ts";
import { testHost, until } from "./testhost.ts";
import { HANDLE_CERTIFICATE_TYPE, NO_REVOCATION_OUTPOINT } from "./handles.ts";
import { ephemeralWallet } from "../wallet.ts";

test("router: the stock client by host name, our client by path prefix; the answer delivered into the owner's hosted mailbox over http; list/ack; polls are reads: no entries, nothing moves", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  const h = await testHost(t);
  const mailbox = await h.ownerInbox();
  const alpha = h.instance("alpha");
  await h.router.start();
  await h.install("alpha"); // #83: `run` and `chat` are the shell app's and the chat app's

  // The stock client, by host name (one BRC-104 session per origin: the instance's).
  const mb = new MessageBoxClient({ host: h.origin("alpha"), walletClient: h.owner });
  await mb.sendMessage({ recipient: alpha, messageBox: "shell/run", body: { cmd: "echo hello; echo from $PWD" }, skipEncryption: true }, h.origin("alpha"));

  // The run's result is delivered by alpha itself, over http, to the owner's hosted mailbox (host B's host skein's messagebox app).
  const dav = new MessageBoxClient({ host: mailbox, walletClient: h.owner });
  const results = await until("the result in david's mailbox", async () => {
    const ms = await dav.listMessagesLite({ messageBox: "results", host: mailbox });
    return ms.length ? ms : undefined;
  });
  const r = results[0]!.body as { exitCode: number; stdout: { "/": { bytes: string } }; replyTo: { "/": string } };
  assert.equal(r.exitCode, 0);
  assert.match(Buffer.from(r.stdout["/"].bytes, "base64").toString(), /^hello\n/);
  assert.equal(results[0]!.sender, alpha, "the sender is the session's identity: alpha's");
  assert.ok(h.lines.some((l) => l.startsWith("[alpha] deliver results for ") && l.endsWith(`→ ${mailbox}/sendMessage (remote): 200 delivered`)), "the delivery's log line: where, how (another host's), the result");
  await dav.acknowledgeMessage({ messageIds: results.map((m) => m.messageId), host: mailbox });
  await h.router.settled();
  assert.deepEqual(await dav.listMessagesLite({ messageBox: "results", host: mailbox }), [], "acknowledged: removed from the box");

  // Our raw client, by path prefix: a chat, answered (no inference peer: the loop says so) into david's `chat`.
  const toAlpha = new RawBox(h.owner, `${h.base}/@alpha`);
  const sent = await toAlpha.send(alpha, "chat", { text: "hi" });
  const inDavid = new RawBox(h.owner, mailbox);
  const answer = await until("the answer", async () => (await inDavid.list("chat"))[0]);
  assert.equal(answer.sender, alpha);
  const body = answer.value as { text: string; replyTo: CID };
  assert.match(body.text, /no inference peer/);
  assert.ok(CID.asCID(body.replyTo)?.equals(sent.id), "the answer replies to the chat's id: the record alpha keeps");

  // Alpha's peer table: the genesis's seed (#70: the host's providers, the owner's mailbox) and nothing from the host's rows.
  const k = (await h.router.hydrate("alpha")).kernel;
  const root = await k.call("head", "peers") as CID;
  const tab = await k.store.get(root) as unknown as { peers: Array<{ peer: CID }> };
  const seeded = await Promise.all(tab.peers.map(async (p) => await k.store.get(p.peer) as unknown as { source: string; address: string; transport: string }));
  assert.ok(seeded.every((p) => p.source === "genesis"), "no peer seeded from the host's rows");
  assert.deepEqual(seeded.map((p) => p.transport === "local" ? p.address : p.transport).sort(), ["cron", "fetch", "mailbox", "waker"], "the providers (#69: the cron provider among them) and the owner's mailbox");

  // Polls: listMessages is a read route (the messagebox app's filter answers it): no entry, the mailbox unchanged.
  const b = await h.inboxHost();
  await b.router.settled();
  const kd = (await b.router.hydrate("host")).kernel;
  const n0 = await b.entries("host"), m0 = await kd.call("head", "messagebox/mailbox") as CID;
  const n = Number(process.env.SKEIN_POLLS ?? 100);
  for (let i = 0; i < n; i++) await dav.listMessagesLite({ messageBox: "results", host: mailbox });
  await b.router.settled();
  assert.equal(await b.entries("host"), n0, `${n} polls: no entries`);
  assert.ok((await kd.call("head", "messagebox/mailbox") as CID).equals(m0), `${n} polls: the mailbox unchanged`);
});

test("router: an instance's genesis names the owner's configured messagebox (SKEIN_OWNER_MESSAGEBOX) when it is set first; one without it is warned about at hydration", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  const h = await testHost(t);
  h.instance("early"); // genesised before the owner's messagebox is configured
  await h.router.hydrate("early");
  assert.ok(h.lines.some((l) => l.startsWith("[early] WARNING: its genesis names no owner messagebox")), `warned (${h.lines.join(" | ")})`);
  const mailbox = await h.ownerInbox();
  h.instance("late");
  const k = (await h.router.hydrate("late")).kernel;
  const g = await k.genesis() as { defaults: Record<string, string> };
  assert.equal(g.defaults.ownerMessagebox, mailbox, "the configured messagebox");
  assert.ok(!h.lines.some((l) => l.startsWith("[late] WARNING")), "no warning for an instance whose genesis names it");
});

test("router: sessions are state (#68) — the stock client's handshake is an entry and a record, on the host skein that keeps the hosted mailbox (host B) and an instance (host A); a killed kernel keeps them, and the client goes on with no new handshake", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  const h = await testHost(t);
  const mailbox = await h.ownerInbox();
  h.instance("alpha");
  await h.router.start();
  await h.router.settled();
  const b = await h.inboxHost();
  // Every forwarded request's answer, as the client got it, on either host: `<handle> <route> <status>`.
  const seen: string[] = [];
  for (const router of [h.router, b.router]) {
    const r = router as unknown as { forward(handle: string, route: string, ...rest: unknown[]): Promise<{ status: number }> };
    const forward = r.forward.bind(router);
    r.forward = async (handle, route, ...rest) => { const a = await forward(handle, route, ...rest); seen.push(`${handle} ${route} ${a.status}`); return a; };
  }
  const n0 = { host: await b.entries("host"), alpha: await h.entries("alpha") };

  // The first request to each origin shakes hands: the handshake is an entry, and its session a record.
  const dav = new MessageBoxClient({ host: mailbox, walletClient: h.owner });
  assert.deepEqual(await dav.listMessagesLite({ messageBox: "chat", host: mailbox }), []);
  const al = new AuthFetch(h.owner);
  assert.equal((await al.fetch(`${h.origin("alpha")}/explore`, { method: "GET" })).status, 200);
  await h.router.settled();
  await b.router.settled();
  assert.deepEqual(seen, ["host /.well-known/auth 200", "host /messagebox/listMessages 200", "alpha /.well-known/auth 200", "alpha /explore 200"]);
  assert.equal(await b.entries("host"), n0.host + 1, "the host skein: the handshake an entry; the listing a read (none)");
  assert.equal(await h.entries("alpha"), n0.alpha + 2, "the instance: the handshake and the explorer's request, an entry each");
  const kd = (await b.router.hydrate("host")).kernel;
  const s1 = await kd.call("head", "frontdoor/sessions") as CID | null;
  assert.ok(s1, "the host skein's session: a record (head `frontdoor/sessions`)");

  // Kill both kernels: the next request hydrates a new process over the same store; the sessions are there.
  // A killed kernel: a serve process SIGKILLed, or (the settled split) a wasm machine's worker terminated.
  const kill = async (router: typeof h.router, handle: string) => {
    const k = (await router.hydrate(handle)).kernel as Kernel & { machine?: { worker: { terminate(): Promise<number> } } };
    if (k.machine) await k.machine.worker.terminate(); else k.proc.kill("SIGKILL");
    await k.exited();
  };
  await kill(b.router, "host");
  await kill(h.router, "alpha");
  seen.length = 0;
  const sent = await dav.sendMessage({ recipient: h.ownerId, messageBox: "chat", body: { text: "after the restart" }, skipEncryption: true }, mailbox);
  assert.ok(sent.messageId, "send works after the restart");
  assert.deepEqual(seen, ["host /messagebox/sendMessage 200"], "no 401, no new handshake");
  const listed = await dav.listMessagesLite({ messageBox: "chat", host: mailbox });
  assert.equal(listed.length, 1, "list works after the restart");
  assert.equal(listed[0]!.sender, h.ownerId);
  seen.length = 0;
  assert.equal((await al.fetch(`${h.origin("alpha")}/explore`, { method: "GET" })).status, 200, "the instance after its restart");
  assert.deepEqual(seen, ["alpha /explore 200"]);
  const kd2 = (await b.router.hydrate("host")).kernel;
  assert.notEqual(kd2, kd, "a new kernel process");
  assert.ok((await kd2.call("head", "frontdoor/sessions") as CID).equals(s1), "the same session table");

  // The message is kept in its step (the messagebox app's head), and its record carries its proof: the sender, the 104 signature, both nonces.
  await b.router.settled();
  const box = await kd2.call("head", "messagebox/mailbox") as CID;
  const lists = (await kd2.store.get(box) as unknown as { lists: Array<{ box: string; list: CID }> }).lists;
  const chat = await kd2.store.get(lists.find((l) => l.box === "chat")!.list) as unknown as { messages: Array<{ id: CID }> };
  const mail = await kd2.store.get(chat.messages[0]!.id) as unknown as { sender: Uint8Array; session: { signature: Uint8Array; nonce: string; yourNonce: string } };
  assert.equal(Buffer.from(mail.sender).toString("hex"), h.ownerId);
  assert.ok(mail.session.signature.length > 0 && mail.session.nonce && mail.session.yourNonce, "the 104 signature and both nonces");
});

test("router: the host's headers feed (#102) reaches only the instances whose dispatch table takes events in box `chain` — a row added later subscribes, removed unsubscribes", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  const conns: ServerResponse[] = [];
  // Only the tip stream (no history here: the image's chain part, #132, stays empty and says so).
  const server = createServer((req, res) => { if (!req.url?.endsWith("/tip/stream")) { res.writeHead(404).end(); return; } res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": hello\n\n"); conns.push(res); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { for (const c of conns) c.end(); server.close(); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/chaintracks/v2/tip/stream`;
  const h = await testHost(t, { headersFeed: url });
  h.instance("a");
  h.instance("b");
  await h.router.start();
  await h.router.settled();
  const subscribed = () => ["a", "b"].filter((x) => h.router.feeds.hosts(x));
  assert.deepEqual(subscribed(), [], "no instance has a chain row yet");
  // #132: the host listens itself (the default image's chain part grows by it): one connection, shared with the instances later.
  await until("the host's own connection", () => conns[0]);
  assert.equal(conns.length, 1, "one connection: the host's own, no instance's");

  // An event route at box `chain` (as the chain app's), added to `a`: `a` is subscribed, live.
  const programs = Object.keys(((await (await h.router.hydrate("a")).kernel.genesis()) as { programs: Record<string, unknown> }).programs);
  const handler = programs.includes("resolve") ? "resolve" : programs[0]!;
  const gp = ((await (await h.router.hydrate("a")).kernel.genesis()) as { programs: Record<string, CID> }).programs;
  const id = h.db.get("a")!.identity!;
  // #124: the owner's dispatch message (`skein routes`), POSTed to a's /sendMessage on the owner's session.
  // #143: events are their own transport — an `event` route at box `chain`.
  const sendRow = (op: "add" | "remove") => sendPlan({ port: h.router.port!, owner: h.owner, settled: () => h.router.settled() }, "a", { prompt: [], recipient: id, messages: [{ box: "dispatch", body: { op, row: { transport: "event", address: "chain", program: gp[handler]! } } }] });
  await sendRow("add");
  await until("a subscribed", async () => { await h.router.settled(); return h.router.feeds.hosts("a") || undefined; });
  assert.deepEqual(subscribed(), ["a"]);
  assert.ok(h.lines.includes(`[router] a: subscribed to the host's headers feed ${url}`), h.lines.join("\n"));
  assert.equal(conns.length, 1, "the same connection");

  // A header (chaintracks' JSON, mainnet block 1): an entry in `a`, nothing in `b`.
  const n0 = { a: await h.entries("a"), b: await h.entries("b") };
  const block1 = {
    version: 1, previousHash: "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f", merkleRoot: "0e3e2357e806b6cdb1f70b54c3a3a17b6714ee1f0e68bebb44a74b1efd512098",
    time: 1231469665, bits: 486604799, nonce: 2573394689, height: 1, hash: "00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048",
  };
  conns[0]!.write(`data: ${JSON.stringify(block1)}\n\n`);
  await until("the header admitted into a", async () => (await h.entries("a")) > n0.a || undefined);
  await h.router.settled();
  assert.equal(await h.entries("b"), n0.b);

  // The row removed: unsubscribed.
  await sendRow("remove");
  await until("a unsubscribed", async () => { await h.router.settled(); return !h.router.feeds.hosts("a") || undefined; });
  assert.ok(h.lines.includes(`[router] a: unsubscribed from the host's headers feed ${url}`));
});

test("router: registration through the host skein (#113) — POST /account/register is an entry in the host skein, answered by its onboarding app; no instance is made: the handle's messagebox is the host skein's messagebox app; a second registration a new serial, the record's trail two long; resolve the current certificate and the paymail PKI; a taken, second or reserved name 409; no host.db row for a handle", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built", timeout: 180_000 }, async (t) => {
  const h = await testHost(t);
  await h.hostSkein();
  const k = async () => (await h.router.hydrate("host")).kernel;
  const head = async (name: string) => { const c = await (await k()).call("head", name) as CID | null; return c ? { cid: c, rec: await (await k()).store.get(c) as unknown as Record<string, unknown> } : undefined; };
  // #135: a registration is a signed request, over the registrant's session with the host's origin (`session`: another key's).
  const register = async (key: PrivateKey, username: string, o: { signer?: PrivateKey; text?: string; session?: PrivateKey } = {}) => {
    const { signature } = await new ProtoWallet(o.signer ?? key).createSignature({ protocolID: [2, "skein register"], keyID: username, counterparty: "anyone", data: Utils.toArray(o.text ?? `register ${username}@localhost`, "utf8") });
    const r = await new AuthFetch(ephemeralWallet(o.session ?? key)).fetch(`${h.base}/account/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, identityKey: key.toPublicKey().toString(), signature: Utils.toHex(signature) }) });
    return { status: r.status, body: await r.json() as Record<string, unknown> & { certificate: Record<string, unknown> & { fields: Record<string, string>; serialNumber: string }; keyringForSubject: Record<string, string> } };
  };
  const { publicKey: certifier } = await h.router.certifier.getPublicKey({ identityKey: true });
  const dave = PrivateKey.fromRandom(), daveId = dave.toPublicKey().toString();
  h.instance("alpha");

  // Where a page finds the router and the handle domain (the app's config): at any host name.
  for (const url of [`${h.base}/.well-known/skein-host`, `http://alpha.localhost:${h.router.port}/.well-known/skein-host`]) {
    const a = await h.router.dispatch({ method: "GET", url, headers: {}, body: new Uint8Array() });
    assert.deepEqual(JSON.parse(new TextDecoder().decode(a.body)), { origin: h.base, domain: "localhost" });
  }

  // The signature covers the domain: the old text, another key, another domain — refused.
  assert.equal((await register(dave, "dave", { text: "register dave" })).status, 401);
  assert.equal((await register(dave, "dave", { signer: PrivateKey.fromRandom() })).status, 401);
  assert.equal((await register(dave, "dave", { text: "register dave@id.skein.nexus" })).status, 401);
  // #135: over another key's session, 403; with no session at all, 401 (the row takes a session).
  assert.equal((await register(dave, "dave", { session: PrivateKey.fromRandom() })).status, 403);
  const { signature: plainSig } = await new ProtoWallet(dave).createSignature({ protocolID: [2, "skein register"], keyID: "dave", counterparty: "anyone", data: Utils.toArray("register dave@localhost", "utf8") });
  assert.equal((await fetch(`${h.base}/account/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "dave", identityKey: daveId, signature: Utils.toHex(plainSig) }) })).status, 401, "an unsigned registration: 401");
  assert.equal(h.db.get("dave"), undefined);

  const before = await h.entries("host");
  const first = await register(dave, "dave");
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const { certificate: c, keyringForSubject, ...rest } = first.body;
  const hosted = `${h.origin("host")}/messagebox`;
  assert.deepEqual(rest, { handle: "dave", domain: "localhost", identityKey: daveId, messagebox: hosted });
  // An entry in the host skein: the request as received (its path the client's, its route the app's).
  const requests: Array<Record<string, unknown>> = [];
  const s = (await k()).store;
  for (let e: CID | null | undefined = await s.log.tip(); e;) {
    const entry = await s.get(e) as unknown as { n: number; prev?: CID; request?: CID };
    if (entry.n < before) break;
    if (entry.request) requests.push(await s.get(entry.request) as unknown as Record<string, unknown>);
    e = entry.prev ?? null;
  }
  assert.ok(requests.some((r) => r.kind === "http" && r.method === "POST" && r.path === "/account/register"), "the registration is a request entry in the host skein");
  // No instance: no host.db row, nothing asked of the instance manager.
  assert.equal(h.db.get("dave"), undefined, "no row");
  assert.equal(await head("onboard/instances/dave"), undefined, "no manager's answer recorded");
  // The holder's certificate, as a wallet's acquireCertificate (direct) takes it.
  assert.equal(c.type, HANDLE_CERTIFICATE_TYPE);
  assert.equal(c.subject, daveId);
  assert.equal(c.certifier, certifier);
  assert.equal(c.revocationOutpoint, NO_REVOCATION_OUTPOINT);
  const m = new MasterCertificate(c.type as string, c.serialNumber, c.subject as string, c.certifier as string, c.revocationOutpoint as string, c.fields, keyringForSubject, c.signature as string);
  assert.equal(await m.verify(), true);
  assert.deepEqual({ ...await MasterCertificate.decryptFields(new ProtoWallet(dave), keyringForSubject, c.fields, certifier) }, { handle: "dave", domain: "localhost" });
  // The answer is the app's record: onboard/handles/dave → the certificate record; its serial the hash of the issuance record.
  const r1 = (await head("onboard/handles/dave"))!;
  assert.equal(r1.rec.kind, "handle-certificate");
  assert.equal(r1.rec.serialNumber, c.serialNumber);
  assert.deepEqual((r1.rec.holder as { certificate: unknown }).certificate, c, "the answer is the certificate the app recorded");
  assert.equal(Buffer.from(r1.rec.subject as Uint8Array).toString("hex"), daveId);
  const issuance = r1.rec.issuance as CID;
  assert.equal(c.serialNumber, Utils.toBase64(Array.from(issuance.multihash.digest)), "the serial number is the issuance record's hash");
  assert.equal(r1.rec.prev, undefined);

  // The same key and name again: a new certificate with a new serial; the trail two records long.
  const again = await register(dave, "dave");
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.notEqual(again.body.certificate.serialNumber, c.serialNumber);
  const r2 = (await head("onboard/handles/dave"))!;
  assert.equal(r2.rec.serialNumber, again.body.certificate.serialNumber);
  assert.ok((r2.rec.prev as CID).equals(r1.cid), "the head's record names the first: two entries");

  // Resolve answers the current certificate (plaintext fields), from the app's record.
  const res = await fetch(`${h.base}/.well-known/metanet-handles/resolve?handle=dave`);
  assert.equal(res.status, 200);
  const ra = await res.json() as Record<string, unknown> & { certificate: Certificate };
  assert.equal(ra.certificate.serialNumber, again.body.certificate.serialNumber);
  assert.deepEqual([ra.identityKey, ra.messagebox, ra.domain], [daveId, hosted, "localhost"]);
  assert.equal(await new Certificate(ra.certificate.type, ra.certificate.serialNumber, ra.certificate.subject, ra.certificate.certifier, ra.certificate.revocationOutpoint, ra.certificate.fields, ra.certificate.signature).verify(), true);

  // The paymail PKI, from the app's record (the domain the app's when none is given).
  for (const q of ["dave", "dave@localhost"]) assert.deepEqual(await (await fetch(`${h.base}/bsvalias/id/${q}`)).json(), { bsvalias: "1.0", handle: "dave@localhost", pubkey: daveId });
  assert.equal((await fetch(`${h.base}/bsvalias/id/nobody`)).status, 404);

  // 409: another key's name; the key's second name; the reserved labels.
  const eve = PrivateKey.fromRandom();
  const taken = await register(eve, "dave");
  assert.equal(taken.status, 409);
  assert.match(String(taken.body.error), /dave is taken/);
  const second = await register(dave, "dave2");
  assert.equal(second.status, 409);
  assert.match(String(second.body.error), /already registered as dave/);
  for (const name of ["id", "host"]) {
    const r = await register(eve, name);
    assert.equal(r.status, 409);
    assert.match(String(r.body.error), /reserved/);
  }
  assert.equal((await register(eve, "e.ve")).status, 400);

  // The index (what the messagebox app hosts): every handle at the hosted messagebox, its key named; no host.db row for any.
  const idx = (await head("onboard/index"))!.rec as { handles: Record<string, CID>; keys: Record<string, string> };
  assert.deepEqual(Object.keys(idx.handles), ["dave"]);
  const rec = await (await k()).store.get(idx.handles.dave!) as unknown as { subject: Uint8Array; domain: string; messagebox: string };
  assert.deepEqual([Buffer.from(rec.subject).toString("hex"), rec.domain, rec.messagebox], [daveId, "localhost", hosted]);
  assert.equal(idx.keys[daveId], "dave");
  assert.deepEqual(h.db.list().map((x) => x.handle).sort(), ["alpha", "host"], "registrations made no instance");
});

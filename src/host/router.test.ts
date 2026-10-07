// The router as a reverse proxy (#40), end to end with the real Zig kernel:
// every instance is an HTTP server (its front door) at its own origin; the
// stock @bsv/message-box-client talks to an instance by host name, our raw
// BRC-33 client by path prefix; the instance answers into its owner's mailbox —
// a mailbox instance — over http, short-circuited in process; the owner lists
// and acknowledges there; every request is an entry (#68), a poll moves
// nothing; sessions are records and survive a killed kernel. The host's
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
import { KERNEL_BIN } from "./kernel.ts";
import { main } from "./cli.ts";
import { planDispatch } from "../client/admin.ts";
import { sendPlan } from "../testapps.ts";
import { testHost, until } from "./testhost.ts";
import { HANDLE_CERTIFICATE_TYPE, NO_REVOCATION_OUTPOINT } from "./handles.ts";
import { ephemeralWallet } from "../wallet.ts";

test("router: the stock client by host name, our client by path prefix; the answer delivered into the owner's mailbox instance over http; list/ack; polls are entries that move nothing", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  const h = await testHost(t);
  h.mailbox("david", h.ownerId);
  const alpha = h.instance("alpha");
  await h.router.start();
  await h.install("alpha"); // #83: `run` and `chat` are the shell app's and the chat app's

  // The stock client, by host name (one BRC-104 session per origin: the instance's).
  const mb = new MessageBoxClient({ host: h.origin("alpha"), walletClient: h.owner });
  await mb.sendMessage({ recipient: alpha, messageBox: "shell/run", body: { cmd: "echo hello; echo from $PWD" }, skipEncryption: true }, h.origin("alpha"));

  // The run's result is delivered by alpha itself, over http, to the owner's mailbox instance — in process.
  const dav = new MessageBoxClient({ host: h.origin("david"), walletClient: h.owner });
  const results = await until("the result in david's mailbox", async () => {
    const ms = await dav.listMessagesLite({ messageBox: "results", host: h.origin("david") });
    return ms.length ? ms : undefined;
  });
  const r = results[0]!.body as { exitCode: number; stdout: { "/": { bytes: string } }; replyTo: { "/": string } };
  assert.equal(r.exitCode, 0);
  assert.match(Buffer.from(r.stdout["/"].bytes, "base64").toString(), /^hello\n/);
  assert.equal(results[0]!.sender, alpha, "the sender is the session's identity: alpha's");
  assert.ok(h.lines.some((l) => l.startsWith("[alpha] deliver results for ") && l.endsWith(`→ ${h.origin("david")}/sendMessage (local): 200 delivered`)), "the delivery's log line: where, how, the result");
  await dav.acknowledgeMessage({ messageIds: results.map((m) => m.messageId), host: h.origin("david") });
  await h.router.settled();
  assert.deepEqual(await dav.listMessagesLite({ messageBox: "results", host: h.origin("david") }), [], "acknowledged: the reader's pointer moved");

  // Our raw client, by path prefix: a chat, answered (no inference peer: the loop says so) into david's `chat`.
  const toAlpha = new RawBox(h.owner, `${h.base}/@alpha`);
  const sent = await toAlpha.send(alpha, "chat", { text: "hi" });
  const inDavid = new RawBox(h.owner, `${h.base}/@david`);
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

  // Polls (#68: skein is a state process): each listMessages on david's mailbox is an entry — an access
  // log — and a read: the mailbox itself does not move.
  await h.router.settled();
  const kd = (await h.router.hydrate("david")).kernel;
  const n0 = await h.entries("david"), m0 = await kd.call("head", "mailbox") as CID;
  const n = Number(process.env.SKEIN_POLLS ?? 100);
  for (let i = 0; i < n; i++) await dav.listMessagesLite({ messageBox: "results", host: h.origin("david") });
  await h.router.settled();
  assert.equal(await h.entries("david"), n0 + n, `${n} polls: ${n} entries`);
  assert.ok((await kd.call("head", "mailbox") as CID).equals(m0), `${n} polls: the mailbox unchanged`);
});

test("router: an instance's genesis names the owner's mailbox instance when it exists first; one without it is warned about at hydration", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  const h = await testHost(t);
  h.instance("early"); // genesised before the owner has a mailbox instance
  await h.router.hydrate("early");
  assert.ok(h.lines.some((l) => l.startsWith("[early] WARNING: its genesis names no owner messagebox")), `warned (${h.lines.join(" | ")})`);
  h.mailbox("david", h.ownerId);
  h.instance("late");
  const k = (await h.router.hydrate("late")).kernel;
  const g = await k.genesis() as { defaults: Record<string, string> };
  assert.equal(g.defaults.ownerMessagebox, h.origin("david"), "the owner's mailbox instance, by default");
  assert.ok(!h.lines.some((l) => l.startsWith("[late] WARNING")), "no warning for an instance whose genesis names it");
});

test("router: sessions are state (#68) — the stock client's handshake is an entry and a record, on a mailbox instance and another instance; a killed kernel keeps them, and the client goes on with no new handshake", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  const h = await testHost(t);
  h.mailbox("david", h.ownerId);
  h.instance("alpha");
  await h.router.start();
  await h.router.settled();
  // Every forwarded request's answer, as the client got it: `<handle> <route> <status>`.
  const seen: string[] = [];
  const r = h.router as unknown as { forward(handle: string, route: string, ...rest: unknown[]): Promise<{ status: number }> };
  const forward = r.forward.bind(h.router);
  r.forward = async (handle, route, ...rest) => { const a = await forward(handle, route, ...rest); seen.push(`${handle} ${route} ${a.status}`); return a; };
  const n0 = { david: await h.entries("david"), alpha: await h.entries("alpha") };

  // The first request to each origin shakes hands: the handshake is an entry, and its session a record.
  const dav = new MessageBoxClient({ host: h.origin("david"), walletClient: h.owner });
  assert.deepEqual(await dav.listMessagesLite({ messageBox: "chat", host: h.origin("david") }), []);
  const al = new MessageBoxClient({ host: h.origin("alpha"), walletClient: h.owner });
  assert.deepEqual(await al.listMessagesLite({ messageBox: "chat", host: h.origin("alpha") }), []);
  await h.router.settled();
  assert.deepEqual(seen, ["david /.well-known/auth 200", "david /listMessages 200", "alpha /.well-known/auth 200", "alpha /listMessages 200"]);
  assert.equal(await h.entries("david"), n0.david + 2, "the mailbox instance: the handshake and the listing, an entry each");
  assert.equal(await h.entries("alpha"), n0.alpha + 2, "the instance: the handshake and the listing, an entry each");
  const kd = (await h.router.hydrate("david")).kernel;
  const s1 = await kd.call("head", "frontdoor/sessions") as CID | null;
  assert.ok(s1, "david's session: a record (head `frontdoor/sessions`)");

  // Kill both kernels: the next request hydrates a new process over the same store; the sessions are there.
  const kill = async (handle: string) => { const k = (await h.router.hydrate(handle)).kernel; k.proc.kill("SIGKILL"); await k.exited(); };
  await kill("david");
  await kill("alpha");
  seen.length = 0;
  const sent = await dav.sendMessage({ recipient: h.ownerId, messageBox: "chat", body: { text: "after the restart" }, skipEncryption: true }, h.origin("david"));
  assert.ok(sent.messageId, "send works after the restart");
  assert.deepEqual(seen, ["david /sendMessage 200"], "no 401, no new handshake");
  const listed = await dav.listMessagesLite({ messageBox: "chat", host: h.origin("david") });
  assert.equal(listed.length, 1, "list works after the restart");
  assert.equal(listed[0]!.sender, h.ownerId);
  seen.length = 0;
  assert.deepEqual(await al.listMessagesLite({ messageBox: "chat", host: h.origin("alpha") }), [], "list works on the instance after its restart");
  assert.deepEqual(seen, ["alpha /listMessages 200"]);
  const kd2 = (await h.router.hydrate("david")).kernel;
  assert.notEqual(kd2, kd, "a new kernel process");
  assert.ok((await kd2.call("head", "frontdoor/sessions") as CID).equals(s1), "the same session table");

  // The message is routed from its request, and its record carries its proof: the sender, the 104 signature, both nonces.
  await h.router.settled();
  const box = await kd2.call("head", "mailbox") as CID;
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
  h.mailbox("david", h.ownerId); // its catch-all `*` row is not a chain row
  h.instance("a");
  h.instance("b");
  await h.router.start();
  await h.router.settled();
  const subscribed = () => ["david", "a", "b"].filter((x) => h.router.feeds.hosts(x));
  assert.deepEqual(subscribed(), [], "no instance has a chain row yet");
  // #132: the host listens itself (the default image's chain part grows by it): one connection, shared with the instances later.
  await until("the host's own connection", () => conns[0]);
  assert.equal(conns.length, 1, "one connection: the host's own, no instance's");

  // A row taking box `chain` from anyone (events included, as the chain app's `event` row does), added to `a`: `a` is subscribed, live.
  const programs = Object.keys(((await (await h.router.hydrate("a")).kernel.genesis()) as { programs: Record<string, unknown> }).programs);
  const handler = programs.includes("resolve") ? "resolve" : programs[0]!;
  const gp = ((await (await h.router.hydrate("a")).kernel.genesis()) as { programs: Record<string, CID> }).programs;
  const id = h.db.get("a")!.identity!;
  // #124: the owner's dispatch message (`skein dispatch`), POSTed to a's /sendMessage on the owner's session.
  const sendRow = (op: "add" | "remove") => sendPlan({ port: h.router.port!, owner: h.owner, settled: () => h.router.settled() }, "a", planDispatch(id, { op, box: "chain", handler }, gp));
  await sendRow("add");
  await until("a subscribed", async () => { await h.router.settled(); return h.router.feeds.hosts("a") || undefined; });
  assert.deepEqual(subscribed(), ["a"]);
  assert.ok(h.lines.includes(`[router] a: subscribed to the host's headers feed ${url}`), h.lines.join("\n"));
  assert.equal(conns.length, 1, "the same connection");

  // A header (chaintracks' JSON, mainnet block 1): an entry in `a`, nothing in `b` or `david`.
  const n0 = { a: await h.entries("a"), b: await h.entries("b"), david: await h.entries("david") };
  const block1 = {
    version: 1, previousHash: "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f", merkleRoot: "0e3e2357e806b6cdb1f70b54c3a3a17b6714ee1f0e68bebb44a74b1efd512098",
    time: 1231469665, bits: 486604799, nonce: 2573394689, height: 1, hash: "00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048",
  };
  conns[0]!.write(`data: ${JSON.stringify(block1)}\n\n`);
  await until("the header admitted into a", async () => (await h.entries("a")) > n0.a || undefined);
  await h.router.settled();
  assert.equal(await h.entries("b"), n0.b);
  assert.equal(await h.entries("david"), n0.david);

  // The row removed: unsubscribed.
  await sendRow("remove");
  await until("a unsubscribed", async () => { await h.router.settled(); return !h.router.feeds.hosts("a") || undefined; });
  assert.ok(h.lines.includes(`[router] a: unsubscribed from the host's headers feed ${url}`));
});

test("router: registration through the host skein (#113) — POST /account/register is an entry in the host skein, answered by its onboarding app; the instance manager creates the mailbox; a second registration a new serial, the record's trail two long; resolve the current certificate; a taken, second or reserved name 409; host.db and the host skein's records agree", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built", timeout: 180_000 }, async (t) => {
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
  assert.deepEqual(rest, { handle: "dave", domain: "localhost", identityKey: daveId, messagebox: h.origin("dave") });
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
  // The instance manager created the mailbox: a mailbox row for dave's key at the app's domain, published.
  const row = h.db.get("dave")!;
  assert.deepEqual([row.kind, row.owner, row.domain, row.status], ["mailbox", daveId, "localhost", "enabled"]);
  const mgr = await head("onboard/instances/dave");
  assert.equal(mgr?.rec.handle, "dave");
  assert.equal(mgr?.rec.url, h.origin("dave"));
  assert.equal(Buffer.from(mgr!.rec.identity as Uint8Array).toString("hex"), row.identity, "onboard/instances/dave → the manager's answer");
  assert.equal((await fetch(`${h.base}/@dave/listMessages`, { method: "POST" })).status !== 404, true, "the mailbox instance answers at its origin");
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

  // The same key and name again: the same mailbox, a new certificate with a new serial; the trail two records long.
  const again = await register(dave, "dave");
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.notEqual(again.body.certificate.serialNumber, c.serialNumber);
  const r2 = (await head("onboard/handles/dave"))!;
  assert.equal(r2.rec.serialNumber, again.body.certificate.serialNumber);
  assert.ok((r2.rec.prev as CID).equals(r1.cid), "the head's record names the first: two entries");
  assert.equal(h.db.list().filter((x) => x.owner === daveId).length, 1, "one mailbox");

  // Resolve answers the current certificate (plaintext fields), from the app's record.
  const res = await fetch(`${h.base}/.well-known/metanet-handles/resolve?handle=dave`);
  assert.equal(res.status, 200);
  const ra = await res.json() as Record<string, unknown> & { certificate: Certificate };
  assert.equal(ra.certificate.serialNumber, again.body.certificate.serialNumber);
  assert.deepEqual([ra.identityKey, ra.messagebox, ra.domain], [daveId, h.origin("dave"), "localhost"]);
  assert.equal(await new Certificate(ra.certificate.type, ra.certificate.serialNumber, ra.certificate.subject, ra.certificate.certifier, ra.certificate.revocationOutpoint, ra.certificate.fields, ra.certificate.signature).verify(), true);

  // 409: another key's name; the key's second name; an instance's handle (the manager refuses); the reserved labels.
  const eve = PrivateKey.fromRandom();
  const taken = await register(eve, "dave");
  assert.equal(taken.status, 409);
  assert.match(String(taken.body.error), /dave is taken/);
  const second = await register(dave, "dave2");
  assert.equal(second.status, 409);
  assert.match(String(second.body.error), /already registered as dave/);
  const inst = await register(eve, "alpha");
  assert.equal(inst.status, 409, JSON.stringify(inst.body));
  assert.match(String(inst.body.error), /alpha is taken/);
  for (const name of ["id", "host"]) {
    const r = await register(eve, name);
    assert.equal(r.status, 409);
    assert.match(String(r.body.error), /reserved/);
  }
  assert.equal((await register(eve, "e.ve")).status, 400);
  assert.equal(h.db.list().filter((x) => x.owner === eve.toPublicKey().toString()).length, 0);

  // host.db and the host skein's records agree: every handle the index names is a mailbox row of its subject at its domain, and the other way round.
  const idx = (await head("onboard/index"))!.rec as { handles: Record<string, CID>; keys: Record<string, string> };
  const recorded: string[] = [];
  for (const [handle, cid] of Object.entries(idx.handles)) {
    const rec = await (await k()).store.get(cid) as unknown as { subject: Uint8Array; domain: string; messagebox: string };
    const r = h.db.get(handle)!;
    assert.deepEqual([r.kind, r.owner, r.domain, h.origin(handle)], ["mailbox", Buffer.from(rec.subject).toString("hex"), rec.domain, rec.messagebox]);
    assert.equal(idx.keys[r.owner!], handle);
    recorded.push(handle);
  }
  assert.deepEqual(h.db.list().filter((x) => x.kind === "mailbox").map((x) => x.handle), recorded);
});

test("router: a mailbox registered before #113 (a host.db row the app has no record of) listed by skein-host import-handles with the owner's request — onboard.adopt sent by the owner's wallet (#124), the manager's answer for the row, at the app's domain; then it resolves, and the paymail PKI answers from the same record; adopt is the owner's", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built", timeout: 180_000 }, async (t) => {
  const h = await testHost(t);
  await h.hostSkein();
  const old = PrivateKey.fromRandom().toPublicKey().toString();
  h.mailbox("olde", old);
  h.db.add("olde", { domain: "id.skein.nexus" });
  assert.equal((await fetch(`${h.base}/.well-known/metanet-handles/resolve?handle=olde`)).status, 404, "no record: not resolved");
  const out: string[] = [], err: string[] = [];
  const run = async () => { out.length = 0; err.length = 0; return await main(["import-handles"], { vars: { SKEIN_HOME: h.home, HOME: h.home, SKEIN_ROUTER_PORT: String(h.router.port) }, out: (l) => out.push(l), err: (l) => err.push(l) }); };
  assert.equal(await run(), 0, err.join("\n"));
  // #124: each line is the owner's request for the wallet to send; sent here on the owner's session.
  assert.equal(out.length, 1, out.join("\n"));
  const body = /--body '(.*)'$/.exec(out[0]!)![1]!;
  assert.deepEqual(JSON.parse(body), { fn: "onboard.adopt", args: { handle: "olde", owner: old } });
  const adopted = await new RawBox(h.owner, `${h.base}/@host`).af.fetch(`${h.base}/@host/onboard/call`, { method: "POST", headers: { "content-type": "application/json" }, body });
  const v = JSON.parse(await adopted.text()) as { result?: { domain?: string; serialNumber?: string } };
  assert.equal(adopted.status, 200, JSON.stringify(v));
  assert.equal(v.result?.domain, "localhost");
  assert.ok(v.result?.serialNumber);
  assert.equal(h.db.get("olde")!.domain, "localhost", "the row's domain is the app's now");
  const r = await (await fetch(`${h.base}/.well-known/metanet-handles/resolve?handle=olde`)).json() as { identityKey: string; messagebox: string; certificate: Certificate };
  assert.deepEqual([r.identityKey, r.messagebox, r.certificate.subject], [old, h.origin("olde"), old]);
  assert.equal(await run(), 0);
  assert.deepEqual([out, err], [[], ["every mailbox instance is recorded"]]);
  // The paymail PKI, from the app's record (the domain the app's when none is given).
  for (const q of ["olde", "olde@localhost"]) assert.deepEqual(await (await fetch(`${h.base}/bsvalias/id/${q}`)).json(), { bsvalias: "1.0", handle: "olde@localhost", pubkey: old });
  assert.equal((await fetch(`${h.base}/bsvalias/id/nobody`)).status, 404);
  // Another key's session may not adopt.
  const stranger = ephemeralWallet(PrivateKey.fromRandom());
  const no = await new RawBox(stranger, `${h.base}/@host`).af.fetch(`${h.base}/@host/onboard/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fn: "onboard.adopt", args: { handle: "x", owner: old } }) });
  assert.equal(no.status, 403);
});

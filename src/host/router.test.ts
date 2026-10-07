// The router as a reverse proxy (#40), end to end with the real Zig kernel:
// every instance is an HTTP server (its front door) at its own origin; the
// stock @bsv/message-box-client talks to an instance by host name, our raw
// BRC-33 client by path prefix; the instance answers into its owner's mailbox —
// a mailbox instance — over http, short-circuited in process; the owner lists
// and acknowledges there; every request is an entry (#68), a poll moves
// nothing; sessions are records and survive a killed kernel. The host's
// headers feed (#102) reaches only the instances with a row taking events in
// box `chain`, following their dispatch tables live. A registration from a
// skein (#103, #113, #131): signed by the key over `register <name>@<domain>`,
// naming the skein that hosts the handle, carried by the router into the host
// skein, where the onboarding app asks the instance manager whether the key
// holds root on that skein and the certifier for the handle certificate,
// records it and answers; no instance is made.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { MessageBoxClient } from "@bsv/message-box-client";
import { AuthFetch, Certificate, MasterCertificate, PrivateKey, ProtoWallet, Utils } from "@bsv/sdk";
import { CID } from "multiformats/cid";
import { RawBox, signClaim } from "../client/raw.ts";
import { KERNEL_BIN } from "./kernel.ts";
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

test("router: registration from a skein (#113, #131) — POST /account/register {…, skein} is an entry in the host skein, answered by its onboarding app; the instance manager confirms the key holds root on that skein and no instance is made; the handle's messagebox is the skein's origin; again a new serial, the trail two long; pointed at another skein of the key's; a skein the key holds no root on 403, none here 404; a taken, second, reserved or instance's name 409", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built", timeout: 240_000 }, async (t) => {
  const h = await testHost(t);
  await h.hostSkein();
  const k = async () => (await h.router.hydrate("host")).kernel;
  const head = async (name: string) => { const c = await (await k()).call("head", name) as CID | null; return c ? { cid: c, rec: await (await k()).store.get(c) as unknown as Record<string, unknown> } : undefined; };
  // #135: a registration is a signed request, over the registrant's session with the host's origin (`session`: another key's).
  const register = async (key: PrivateKey, username: string, o: { signer?: PrivateKey; text?: string; session?: PrivateKey; skein?: string | null } = {}) => {
    const { signature } = await new ProtoWallet(o.signer ?? key).createSignature({ protocolID: [2, "skein register"], keyID: username, counterparty: "anyone", data: Utils.toArray(o.text ?? `register ${username}@localhost`, "utf8") });
    const body = { username, identityKey: key.toPublicKey().toString(), signature: Utils.toHex(signature), ...(o.skein === null ? {} : { skein: o.skein ?? "dsk" }) };
    const r = await new AuthFetch(ephemeralWallet(o.session ?? key)).fetch(`${h.base}/account/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() as Record<string, unknown> & { certificate: Record<string, unknown> & { fields: Record<string, string>; serialNumber: string }; keyringForSubject: Record<string, string> } };
  };
  const { publicKey: certifier } = await h.router.certifier.getPublicKey({ identityKey: true });
  const dave = PrivateKey.fromRandom(), daveId = dave.toPublicKey().toString();
  h.instance("alpha");
  // Dave's skein first (#131: a handle is registered from a skein): claimed by his key, so he holds root there.
  const dsk = await h.router.createInstance("dsk", daveId, { claim: await signClaim(ephemeralWallet(dave)) });

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
  assert.equal((await fetch(`${h.base}/account/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "dave", identityKey: daveId, signature: Utils.toHex(plainSig), skein: "dsk" }) })).status, 401, "an unsigned registration: 401");
  // #131: no skein named: 400 (a handle is registered from a skein); a skein not on this host: 404.
  const none = await register(dave, "dave", { skein: null });
  assert.equal(none.status, 400);
  assert.match(String(none.body.error), /skein: the skein that hosts the handle/);
  const away = await register(dave, "dave", { skein: "nowhere" });
  assert.equal(away.status, 404, JSON.stringify(away.body));
  assert.match(String(away.body.error), /no skein nowhere on this host/);
  assert.equal(await head("onboard/handles/dave"), undefined);

  const rows = h.db.list().length;
  const before = await h.entries("host");
  const first = await register(dave, "dave");
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const { certificate: c, keyringForSubject, ...rest } = first.body;
  assert.deepEqual(rest, { handle: "dave", domain: "localhost", identityKey: daveId, messagebox: dsk.url });
  assert.equal(dsk.url, h.origin("dsk"), "the handle's messagebox is the hosting skein's origin");
  // #131: no instance made — no row for the handle, no manager's create recorded for it.
  assert.equal(h.db.get("dave"), undefined);
  assert.equal(h.db.list().length, rows);
  assert.equal(await head("onboard/instances/dave"), undefined);
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
  // The holder's certificate, as a wallet's acquireCertificate (direct) takes it.
  assert.equal(c.type, HANDLE_CERTIFICATE_TYPE);
  assert.equal(c.subject, daveId, "the subject is the registrant's key, not the skein's");
  assert.equal(c.certifier, certifier);
  assert.equal(c.revocationOutpoint, NO_REVOCATION_OUTPOINT);
  const m = new MasterCertificate(c.type as string, c.serialNumber, c.subject as string, c.certifier as string, c.revocationOutpoint as string, c.fields, keyringForSubject, c.signature as string);
  assert.equal(await m.verify(), true);
  assert.deepEqual({ ...await MasterCertificate.decryptFields(new ProtoWallet(dave), keyringForSubject, c.fields, certifier) }, { handle: "dave", domain: "localhost" });
  // The answer is the app's record: onboard/handles/dave → the certificate record (the hosting skein's identity in it); its serial the hash of the issuance record.
  const r1 = (await head("onboard/handles/dave"))!;
  assert.equal(r1.rec.kind, "handle-certificate");
  assert.equal(r1.rec.serialNumber, c.serialNumber);
  assert.equal(r1.rec.messagebox, dsk.url);
  assert.equal(Buffer.from(r1.rec.skein as Uint8Array).toString("hex"), dsk.identity, "the record names the hosting skein");
  assert.deepEqual((r1.rec.holder as { certificate: unknown }).certificate, c, "the answer is the certificate the app recorded");
  assert.equal(Buffer.from(r1.rec.subject as Uint8Array).toString("hex"), daveId);
  const issuance = r1.rec.issuance as CID;
  assert.equal(c.serialNumber, Utils.toBase64(Array.from(issuance.multihash.digest)), "the serial number is the issuance record's hash");
  assert.equal(r1.rec.prev, undefined);

  // The same key and name again, the skein named by its identity: a new certificate with a new serial; the trail two records long.
  const again = await register(dave, "dave", { skein: dsk.identity });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.notEqual(again.body.certificate.serialNumber, c.serialNumber);
  assert.equal(again.body.messagebox, dsk.url);
  const r2 = (await head("onboard/handles/dave"))!;
  assert.equal(r2.rec.serialNumber, again.body.certificate.serialNumber);
  assert.ok((r2.rec.prev as CID).equals(r1.cid), "the head's record names the first: two entries");

  // Resolve answers the current certificate (plaintext fields), from the app's record; the messagebox the skein's.
  const res = await fetch(`${h.base}/.well-known/metanet-handles/resolve?handle=dave`);
  assert.equal(res.status, 200);
  const ra = await res.json() as Record<string, unknown> & { certificate: Certificate };
  assert.equal(ra.certificate.serialNumber, again.body.certificate.serialNumber);
  assert.deepEqual([ra.identityKey, ra.messagebox, ra.domain], [daveId, dsk.url, "localhost"]);
  assert.equal(await new Certificate(ra.certificate.type, ra.certificate.serialNumber, ra.certificate.subject, ra.certificate.certifier, ra.certificate.revocationOutpoint, ra.certificate.fields, ra.certificate.signature).verify(), true);
  assert.equal((await fetch(`${h.base}/@dsk/listMessages`, { method: "POST" })).status !== 404, true, "the messagebox answers at the skein's origin");

  // Pointed at another skein of his: the handle moves (resolve answers the newest record).
  const dsk2 = await h.router.createInstance("dsk2", daveId, { claim: await signClaim(ephemeralWallet(dave)) });
  const moved = await register(dave, "dave", { skein: "dsk2" });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.messagebox, dsk2.url);
  assert.equal(((await (await fetch(`${h.base}/.well-known/metanet-handles/resolve?handle=dave`)).json()) as { messagebox: string }).messagebox, dsk2.url);

  // 403: a skein the key holds no root on (dave's, for eve); nothing recorded.
  const eve = PrivateKey.fromRandom(), eveId = eve.toPublicKey().toString();
  const notRoot = await register(eve, "evie", { skein: "dsk" });
  assert.equal(notRoot.status, 403, JSON.stringify(notRoot.body));
  assert.match(String(notRoot.body.error), /does not hold root on the skein dsk/);
  assert.equal(await head("onboard/handles/evie"), undefined);
  // 409: another key's name; the key's second name; an instance's handle here; the reserved labels. 400: not a label.
  await h.router.createInstance("esk", eveId, { claim: await signClaim(ephemeralWallet(eve)) });
  const taken = await register(eve, "dave", { skein: "esk" });
  assert.equal(taken.status, 409);
  assert.match(String(taken.body.error), /dave is taken/);
  const second = await register(dave, "dave2");
  assert.equal(second.status, 409);
  assert.match(String(second.body.error), /already registered as dave/);
  const inst = await register(eve, "alpha", { skein: "esk" });
  assert.equal(inst.status, 409, JSON.stringify(inst.body));
  assert.match(String(inst.body.error), /alpha is taken \(an instance on this host\)/);
  for (const name of ["id", "host"]) {
    const r = await register(eve, name, { skein: "esk" });
    assert.equal(r.status, 409);
    assert.match(String(r.body.error), /reserved/);
  }
  assert.equal((await register(eve, "e.ve", { skein: "esk" })).status, 400);
  // eve's own handle, from her skein.
  const evie = await register(eve, "evie", { skein: "esk" });
  assert.equal(evie.status, 200, JSON.stringify(evie.body));
  assert.equal(evie.body.messagebox, h.origin("esk"));
  // #131: onboard.create may not take a registered handle's name (the manager is never asked).
  const made = await new RawBox(ephemeralWallet(eve), `${h.base}/@host`).af.fetch(`${h.base}/@host/onboard/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fn: "onboard.create", args: { handle: "dave", claim: { message: { kind: "mail" }, body: { "/": { bytes: "oA" } } } } }) });
  assert.equal(made.status, 409, await made.clone().text());
  assert.match(await made.text(), /handle dave is taken/);
  assert.equal(h.db.get("dave"), undefined);

  // The index: every handle the app recorded names its subject; no host.db row was made for one.
  const idx = (await head("onboard/index"))!.rec as { handles: Record<string, CID>; keys: Record<string, string> };
  assert.deepEqual(Object.keys(idx.handles).sort(), ["dave", "evie"]);
  assert.deepEqual([idx.keys[daveId], idx.keys[eveId]], ["dave", "evie"]);
  assert.deepEqual(h.db.list().filter((x) => x.kind === "mailbox").map((x) => x.handle), []);
});

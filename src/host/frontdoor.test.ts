// The front door (#68, #66) at the kernel, no router: every request is
// appended as received and the front door is stepped on it, as the request's
// own thread; the answer is read off that thread once it has come to rest.
// The stock AuthFetch shakes hands with the instance — the handshake is a
// request like any other, and its session is a record (head `frontdoor/sessions`) —
// its signed requests verify inside the VM and the answers verify at the
// client. A refusal (401, 404) of a signed request is recorded and changes
// nothing else; an unsigned request is no entry (#135: the second door is
// for reads; a row is a message route) — but at an open row whose filter
// validates the payload (`beef`): admitted with no sender key, answered
// plain (#135: signed or validated). A poll costs an entry. Sessions survive a new kernel process; an expired one is a
// 401 and the stock client shakes hands again by itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthFetch, Beef, P2PKH, PrivateKey, Transaction } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { encode } from "../runtime/cid.ts";
import { msStamp } from "../runtime/syscalls.ts";
import { ephemeralWallet } from "../wallet.ts";
import { rawCid } from "./boot.ts";
import { appendRequest, frontDoorFetch, routeOf, type FrontAnswer } from "./frontdoor.ts";
import { keyBytes, writeGenesis } from "./genesis.ts";
import { Kernel, KERNEL_BIN } from "./kernel.ts";
import { MESSAGE_KEY_ID, MESSAGE_PROTOCOL } from "./providers.ts";

const PROBE = new URL("../../kernel-zig/test/call/probe.wasm", import.meta.url);

test("front door: every request is an entry and a thread; the handshake writes the session as a record; refusals are recorded and change nothing else; sessions survive a restart; an expired one is a 401 the stock client recovers from", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  const home = await fs.mkdtemp(join(tmpdir(), "skein-front-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const key = PrivateKey.fromRandom(), clientKey = PrivateKey.fromRandom();
  const identity = key.toPublicKey().toString(), client = clientKey.toPublicKey().toString();
  const db = join(home, "runtime.db");
  const open = () => new Kernel({ db, handle: "alpha", domain: "localhost", wallet: ephemeralWallet(key), env: { SKEIN_HOME: home } });
  let k = open();
  t.after(() => k.stop());
  const wasm = readFileSync(PROBE);
  await k.putBlock(rawCid(wasm), wasm);
  const probe = await k.store.put({ kind: "program", name: "probe", code: { wasm: rawCid(wasm) }, inputs: {}, services: [], description: "the call probe" } as never) as CID;
  await writeGenesis(k, {
    identity, owner: client, handle: "alpha", domain: "localhost",
    routes: [{ path: "/whoami", program: probe.toString(), fn: "whoami" }, { path: "/open", program: probe.toString(), fn: "whoami", auth: "none" }],
    // #135: an open row behind the door's `beef` filter (no chain app here: every BEEF is refused at the door).
    dispatch: [{ transport: "http", address: "/beef", sender: "*", program: probe.toString(), fn: "whoami", filter: "beef" }, { transport: "http", address: "/mine", sender: client, program: probe.toString(), fn: "whoami" }],
  });
  await k.start();
  await k.idle();

  const entries = async () => (await k.store.get((await k.store.log.tip())!) as unknown as { n: number }).n;
  const sessions = async () => await k.call("head", "frontdoor/sessions") as CID | null;
  // The entries' clock: shifted forward to expire a session (never back: the log's stamps only rise).
  let shift = 0;
  const now = () => msStamp(Date.now() + shift);
  // The client's transport follows whichever kernel process is current; it keeps the answers.
  const answers: FrontAnswer[] = [];
  const door: typeof fetch = (input, init) => frontDoorFetch(k, { now, onAnswer: (a) => answers.push(a) })(input, init);
  const af = new AuthFetch(ephemeralWallet(clientKey), undefined, undefined, undefined, {}, door);
  const whoami = async () => {
    const r = await af.fetch("http://alpha.test/whoami", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 200, await r.clone().text());
    return Buffer.from(await r.arrayBuffer()).toString("hex");
  };
  const statuses = () => answers.map((a) => a.status);

  const n0 = await entries();
  assert.equal(await sessions(), null, "no session yet");
  assert.equal(await whoami(), client, "the handler sees the authenticated caller; the client verified the signed answer");
  await k.idle();
  assert.deepEqual(statuses(), [200, 200], "the handshake, the request");
  assert.equal(await entries(), n0 + 2, "the handshake and the request: one entry each");
  const s1 = await sessions();
  assert.ok(s1, "the handshake wrote the session table (head `frontdoor/sessions`)");
  const root = await k.store.get(s1) as unknown as { kind: string; buckets: CID[] };
  assert.equal(root.kind, "sessions");
  const held = (await Promise.all(root.buckets.map(async (b) => (await k.store.get(b) as unknown as { sessions: Array<{ peer: Uint8Array; nonce: string; peerNonce: string; created: number }> }).sessions))).flat();
  assert.equal(held.length, 1, "one session");
  assert.equal(Buffer.from(held[0]!.peer).toString("hex"), client);
  assert.ok(held[0]!.nonce.length > 0 && held[0]!.peerNonce.length > 0 && held[0]!.created > 0);
  // Each request's answer is on the last update of the thread it launched: the front door on the request.
  for (const a of answers) {
    assert.ok(a.entry && a.thread, "the entry and its thread");
    const o = await k.store.get(a.thread!) as { kind: string; args: { request: CID; transport: string }; input: CID };
    assert.deepEqual([o.kind, o.args.transport, o.input.toString()], ["thread", "http", a.entry!.toString()]);
  }
  const last = answers.at(-1)!;
  const e = await k.store.get(last.entry!) as { request?: CID; transport?: string };
  assert.equal(e.transport, "http");
  const req = await k.store.get(e.request!) as { kind: string; method: string; route: string; headers: Record<string, string> };
  assert.deepEqual([req.kind, req.method, req.route], ["http", "POST", "/whoami"], "the request as received");
  assert.ok(req.headers["x-bsv-auth-signature"], "its BRC-104 headers too: the host verified nothing");

  // #135, two doors: an unsigned request never reaches the kernel's door — a 401 at a message route
  // (any row, an open one `*` included: sign it), a 404 at nothing; answered by the host, no entry.
  answers.length = 0;
  const n1 = await entries();
  assert.equal((await door("http://alpha.test/whoami", { method: "POST" })).status, 401);
  assert.equal((await door("http://alpha.test/open", { method: "POST" })).status, 401, "an open row (`*`) is a message route too: an unsigned request is 401");
  assert.equal((await door("http://alpha.test/nowhere", { method: "POST" })).status, 404);
  await k.idle();
  assert.equal(await entries(), n1, "an unsigned request is no entry");
  assert.equal((await sessions())!.toString(), s1.toString(), "a refusal moves nothing");
  assert.ok(answers.every((a) => !a.thread && !a.entry), "answered by the host: no entry, no thread");

  // 2026-10-07: a signed request is verified and answered signed on its session whatever the row's
  // sender — an open row (`*`) included; the row's sender is who may reach it, not how the wire is answered.
  const signed = (x: FrontAnswer) => !!x.headers["x-bsv-auth-signature"] && x.headers["x-bsv-auth-your-nonce"] !== undefined;
  answers.length = 0;
  const openSigned = await af.fetch("http://alpha.test/open", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(openSigned.status, 200);
  assert.equal(Buffer.from(await openSigned.arrayBuffer()).toString("hex"), client, "a signed request on an open row: the handler sees the verified caller");
  assert.ok(signed(answers.at(-1)!), "a signed request on an open row: its answer signed on the session (AuthFetch verified it)");
  const openGet = await af.fetch("http://alpha.test/open", { method: "GET" });
  assert.equal(openGet.status, 200);
  assert.equal(Buffer.from(await openGet.arrayBuffer()).toString("hex"), client);
  assert.ok(signed(answers.at(-1)!), "a signed GET on an open row: answered signed");
  const nowhere = await af.fetch("http://alpha.test/nowhere", { method: "GET" });
  assert.equal(nowhere.status, 404);
  assert.ok(signed(answers.at(-1)!), "a signed request no row is at: its 404 signed");
  answers.length = 0;
  const plainGet = await door("http://alpha.test/open", { method: "GET" });
  assert.equal(plainGet.status, 401, "#135: an unsigned GET of an open row: 401 (a read is a read, declared as one; a row is a message route)");
  assert.ok(!Object.keys(answers.at(-1)!.headers).some((h) => h.startsWith("x-bsv-auth-")), "answered plain");

  // #135: a door refusal (no thread ran) of a signed request is answered signed on its session too:
  // the host asks the front door (fn "refusal") with the request as received. A BEEF the filter
  // decodes is replaced in the record the entry names, so the signature verifies over the bytes sent.
  const beef = new Beef();
  beef.mergeRawTx(new Transaction(1, [], [{ lockingScript: new P2PKH().lock(clientKey.toPublicKey().toHash()), satoshis: 1 }], 0).toBinary());
  answers.length = 0;
  const refusedSigned = await af.fetch("http://alpha.test/beef", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: Uint8Array.from(beef.toBinary()) });
  assert.equal(refusedSigned.status, 400, "the filter refused the BEEF (no chain state to check it against)");
  assert.match(await refusedSigned.text(), /no chain state/, "the refusal's reason, in the body AuthFetch verified");
  assert.ok(signed(answers.at(-1)!) && !answers.at(-1)!.thread, "a door refusal (no thread) of a signed request: answered signed on its session");
  const refusedRecord = await k.store.get((await k.store.get(answers.at(-1)!.entry!) as { request: CID }).request) as unknown as { body: unknown };
  assert.ok(!(refusedRecord.body instanceof Uint8Array), "the record the refusal entry names has its BEEF replaced (the host signed over the bytes as received)");
  // #135, signed or validated: the same request unsigned reaches the door's filter (an open row whose
  // filter validates the payload) — refused there, answered plain.
  const plain = (x: FrontAnswer) => !Object.keys(x.headers).some((h) => h.startsWith("x-bsv-auth-"));
  answers.length = 0;
  const refusedPlain = await door("http://alpha.test/beef", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: Uint8Array.from(beef.toBinary()) });
  assert.equal(refusedPlain.status, 400, "#135: unsigned at an open row behind `filter: beef`: through the door, the filter's refusal");
  assert.match(await refusedPlain.text(), /no chain state/);
  assert.ok(plain(answers.at(-1)!) && answers.at(-1)!.entry && !answers.at(-1)!.thread, "a refusal entry, no thread, answered plain");

  // A chain state for the filter to check against (the owner's `head` message: no headers, so a BEEF with
  // no BUMP passes as unproven, the chain app's to judge).
  {
    const state = await k.store.put({ kind: "chain-state", network: "main", maps: { headers: null } } as never);
    const bodyBytes = dagCbor.encode({ name: "chain/state", tree: state });
    const unsigned = { kind: "mail", op: "put", sender: keyBytes(client), recipient: keyBytes(identity), box: "head", body: encode(dagCbor.decode(bodyBytes)).cid, nonce: new Uint8Array(16) };
    const { signature } = await ephemeralWallet(clientKey).createSignature({ protocolID: MESSAGE_PROTOCOL, keyID: MESSAGE_KEY_ID, counterparty: "anyone", data: [...dagCbor.encode(unsigned)] });
    await appendRequest(k, "local", { kind: "message", message: { ...unsigned, signature: Uint8Array.from(signature) }, body: bodyBytes });
    await k.idle();
    assert.ok(((await k.call("head", "chain/state")) as CID | null)?.equals(state), "the chain state is set");
  }
  // A good BEEF unsigned: validated at the door, the handler's plain answer (no caller); the admission
  // carries no sender key (`door` names the filter and the BEEF's pointer record, no `verified`).
  answers.length = 0;
  const validated = await door("http://alpha.test/beef", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: Uint8Array.from(beef.toBinary()) });
  assert.equal(validated.status, 200, await validated.clone().text());
  // The probe answers the first `caller` its scan finds: with none in the request, the in-VM call's own (a program CID), never a key.
  const vb = Buffer.from(await validated.arrayBuffer());
  assert.ok(vb.byteLength !== 33 && vb[0] === 0x01, `the handler got no caller key (${vb.toString("hex")})`);
  assert.ok(plain(answers.at(-1)!) && answers.at(-1)!.thread, "a thread ran; answered plain");
  const admitted = await k.store.get(answers.at(-1)!.entry!) as { door?: { verified?: unknown; filter?: string; beefs?: CID[] }; refused?: unknown };
  assert.ok(!admitted.refused && admitted.door?.filter === "beef" && admitted.door.beefs?.length === 1 && admitted.door.verified == null, `the admission: the filter, the BEEF's pointer record, no sender key (${JSON.stringify(Object.keys(admitted.door ?? {}))})`);
  // A bad BEEF unsigned (a BEEF pattern that does not decode): the filter's refusal, plain 400.
  answers.length = 0;
  const bad = await door("http://alpha.test/beef", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: Uint8Array.from(beef.toBinary()).subarray(0, 12) });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /does not decode/);
  assert.ok(plain(answers.at(-1)!) && !answers.at(-1)!.thread, "refused at the door, answered plain");
  // The same good BEEF signed: verified, the handler sees the caller, the answer signed.
  answers.length = 0;
  const validatedSigned = await af.fetch("http://alpha.test/beef", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: Uint8Array.from(beef.toBinary()) });
  assert.equal(validatedSigned.status, 200);
  assert.equal(Buffer.from(await validatedSigned.arrayBuffer()).toString("hex"), client, "a signed request at the same row: the verified caller");
  assert.ok(signed(answers.at(-1)!), "answered signed on its session");
  // 403: a stranger's signed request to a row for another key: verified, its 403 signed.
  const stranger = new AuthFetch(ephemeralWallet(PrivateKey.fromRandom()), undefined, undefined, undefined, {}, door);
  answers.length = 0;
  const forbidden = await stranger.fetch("http://alpha.test/mine", { method: "GET" });
  assert.equal(forbidden.status, 403);
  assert.ok(signed(answers.at(-1)!), "a signed request no row takes for its key: its 403 signed");

  // Polls: an entry each (an access log), and the session table unchanged.
  const s2 = (await sessions())!; // the stranger's handshake added one
  const n2 = await entries();
  for (let i = 0; i < 20; i++) await whoami();
  await k.idle();
  assert.equal(await entries(), n2 + 20, "20 polls: 20 entries");
  assert.equal((await sessions())!.toString(), s2.toString(), "polls add no session");

  // Sessions are state: a new kernel process keeps them; the same client's next request is served at once.
  await k.stop();
  k = open();
  await k.start();
  await k.idle();
  answers.length = 0;
  assert.equal(await whoami(), client);
  assert.deepEqual(statuses(), [200], "after a restart: no new handshake");

  // Expiry is judged against the session's `created` (`sessionTtlMs`, a day), by the entry's time.
  shift = 86_400_001;
  answers.length = 0;
  assert.equal(await whoami(), client);
  assert.deepEqual(statuses(), [401, 200, 200], "an expired session: 401, the handshake, the request again");
  assert.ok(answers[0]!.thread === undefined && !Object.keys(answers[0]!.headers).some((h) => h.startsWith("x-bsv-auth-")), "#135: the expired session's 401 is a door refusal answered plain — no session to sign on; the stock client takes it as stale and shakes hands");
  await k.idle();
  const root2 = await k.store.get((await sessions())!) as unknown as { buckets: CID[] };
  const held2 = (await Promise.all(root2.buckets.map(async (b) => (await k.store.get(b) as unknown as { sessions: unknown[] }).sessions))).flat();
  assert.equal(held2.length, 1, "the handshake dropped the expired session");
});

test("two doors (#135): a path goes to a read or a row as the table matches — exact first, then the longest prefix", () => {
  const read = (address: string, prefix?: true) => ({ address, ...(prefix ? { prefix } : {}), program: "p" as never, fn: "get" });
  const row = (address: string, prefix?: true) => ({ transport: "http" as const, address, ...(prefix ? { prefix } : {}), sender: "*" as const, program: "p" as never, fn: "f" });
  const reads = [read("/", true), read("/site/", true), read("/onboard/resolve"), read("/amm/", true)];
  const rows = [row("/sendMessage"), row("/amm/call"), row("/explore", true), { ...row("/x"), transport: "mailbox" as const }];
  const to = (p: string) => { const r = routeOf(reads, rows as never, p); return !r ? "none" : "read" in r ? `read ${r.read.address}` : `row ${r.row.address}`; };
  assert.equal(to("/sendMessage"), "row /sendMessage", "an exact row over the root read");
  assert.equal(to("/amm/call"), "row /amm/call", "an exact row over a prefix read");
  assert.equal(to("/amm/index.html"), "read /amm/");
  assert.equal(to("/explore/log"), "row /explore", "a longer prefix row over the root read");
  assert.equal(to("/onboard/resolve"), "read /onboard/resolve");
  assert.equal(to("/site/app.js"), "read /site/");
  assert.equal(to("/anything"), "read /");
  assert.equal(routeOf([], rows as never, "/x"), undefined, "a mailbox row is no http path");
  assert.equal(routeOf([], rows as never, "/nowhere"), undefined);
});

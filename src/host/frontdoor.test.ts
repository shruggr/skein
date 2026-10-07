// The front door (#68, #66, #143) at the kernel, no router: every request goes
// to the kernel's door — its route matched, the route's filters run, the gate
// checked. What passes is one entry and a thread (the front door stepped on
// it); what a filter rejects or answers, or the gate refuses, writes nothing
// and is answered at once (signed on the request's session when it is
// signed: the front door's fn "respond"). The stock AuthFetch shakes hands
// with the instance — the handshake is a route of its own, and its session a
// record (head `frontdoor/sessions`) that kernel.brc104 reads. kernel.beef
// admits an unsigned request only when it validates (#135: signed or
// validated). An app's filters answer, reject or pass; roles gate functions,
// root passes everything, and root's grants change who else may. Sessions
// survive a new kernel process; an expired one is a 401 and the stock client
// shakes hands again by itself.

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
import { appendRequest, frontDoorFetch, type FrontAnswer } from "./frontdoor.ts";
import { keyBytes, writeGenesis } from "./genesis.ts";
import { Kernel, KERNEL_BIN } from "./kernel.ts";
import { MESSAGE_KEY_ID, MESSAGE_PROTOCOL } from "./providers.ts";

const PROBE = new URL("../../kernel-zig/test/call/probe.wasm", import.meta.url);

test("front door (#143): the route's filters before anything is recorded — kernel.brc104, kernel.beef, an app's own; the gate (root, an app role, a grant and its revoke); what is turned away or answered writes nothing; sessions survive a restart; an expired one is a 401 the stock client recovers from", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  const home = await fs.mkdtemp(join(tmpdir(), "skein-front-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const key = PrivateKey.fromRandom(), clientKey = PrivateKey.fromRandom(), strangerKey = PrivateKey.fromRandom();
  const identity = key.toPublicKey().toString(), client = clientKey.toPublicKey().toString(), strangerId = strangerKey.toPublicKey().toString();
  const db = join(home, "runtime.db");
  const open = () => new Kernel({ db, handle: "alpha", domain: "localhost", wallet: ephemeralWallet(key), env: { SKEIN_HOME: home } });
  let k = open();
  t.after(() => k.stop());
  const wasm = readFileSync(PROBE);
  await k.putBlock(rawCid(wasm), wasm);
  const probe = await k.store.put({ kind: "program", name: "probe", code: { wasm: rawCid(wasm) }, inputs: {}, services: [], description: "the call probe" } as never) as CID;
  const p = probe.toString();
  await writeGenesis(k, {
    // #143: the client is root.
    identity, root: [client], handle: "alpha", domain: "localhost",
    dispatch: [
      { transport: "http", address: "/whoami", filters: ["kernel.brc104"], program: p, fn: "whoami" },
      // No filters: open to whatever comes, signed or not; the handler gets no caller.
      { transport: "http", address: "/open", program: p, fn: "whoami" },
      // #135: an open route behind kernel.beef (no chain app here at first: every BEEF is rejected).
      { transport: "http", address: "/beef", filters: ["kernel.beef"], program: p, fn: "whoami" },
      { transport: "http", address: "/beef-signed", filters: ["kernel.brc104", "kernel.beef"], program: p, fn: "whoami" },
    ],
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
  const stranger = new AuthFetch(ephemeralWallet(strangerKey), undefined, undefined, undefined, {}, door);
  const hexOf = async (r: Response) => Buffer.from(await r.arrayBuffer()).toString("hex");
  const whoami = async () => {
    const r = await af.fetch("http://alpha.test/whoami", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 200, await r.clone().text());
    return await hexOf(r);
  };
  const statuses = () => answers.map((a) => a.status);
  const signed = (x: FrontAnswer) => !!x.headers["x-bsv-auth-signature"] && x.headers["x-bsv-auth-your-nonce"] !== undefined;
  const plain = (x: FrontAnswer) => !Object.keys(x.headers).some((h) => h.startsWith("x-bsv-auth-"));
  /** A message from root (the client) to an admin box: a signed `local` request, routed by the kernel. */
  const admin = async (box: string, body: unknown) => {
    const bodyBytes = dagCbor.encode(body);
    const unsigned = { kind: "mail", op: "put", sender: keyBytes(client), recipient: keyBytes(identity), box, body: encode(dagCbor.decode(bodyBytes)).cid, nonce: Uint8Array.from(Buffer.from(PrivateKey.fromRandom().toHex().slice(0, 32), "hex")) };
    const { signature } = await ephemeralWallet(clientKey).createSignature({ protocolID: MESSAGE_PROTOCOL, keyID: MESSAGE_KEY_ID, counterparty: "anyone", data: [...dagCbor.encode(unsigned)] });
    await appendRequest(k, "local", { kind: "message", message: { ...unsigned, signature: Uint8Array.from(signature) }, body: bodyBytes });
    await k.idle();
  };

  const n0 = await entries();
  assert.equal(await sessions(), null, "no session yet");
  assert.equal(await whoami(), client, "kernel.brc104's principal is the handler's caller; the client verified the signed answer");
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
  // Each request's answer is on the last update of the thread it launched: the front door on the request.
  for (const a of answers) {
    assert.ok(a.entry && a.thread, "the entry and its thread");
    const o = await k.store.get(a.thread!) as { kind: string; args: { request: CID; transport: string }; input: CID };
    assert.deepEqual([o.kind, o.args.transport, o.input.toString()], ["thread", "http", a.entry!.toString()]);
  }
  const last = answers.at(-1)!;
  const e = await k.store.get(last.entry!) as { request?: CID; transport?: string; door?: { principal?: Uint8Array; filters?: string[]; verified?: unknown } };
  assert.equal(e.transport, "http");
  assert.equal(Buffer.from(e.door!.principal!).toString("hex"), client, "the door's principal: kernel.brc104's");
  assert.deepEqual(e.door!.filters, ["kernel.brc104"], "the filters that ran");
  const req = await k.store.get(e.request!) as { kind: string; method: string; route: string; headers: Record<string, string> };
  assert.deepEqual([req.kind, req.method, req.route], ["http", "POST", "/whoami"], "the request as received");

  // Turned away at the door: nothing written. An unsigned request at a kernel.brc104 route: 401; a path no
  // route is at: 404 — plain for an unsigned request.
  answers.length = 0;
  const n1 = await entries();
  assert.equal((await door("http://alpha.test/whoami", { method: "POST" })).status, 401);
  assert.equal((await door("http://alpha.test/nowhere", { method: "POST" })).status, 404);
  await k.idle();
  assert.equal(await entries(), n1, "turned away: no entry");
  assert.ok(answers.every((a) => !a.thread && !a.entry && plain(a)), "no entry, no thread, answered plain");
  // A route with no filters takes an unsigned request: admitted, the handler with no caller key.
  answers.length = 0;
  const openPlain = await door("http://alpha.test/open", { method: "GET" });
  assert.equal(openPlain.status, 200);
  const ob = Buffer.from(await openPlain.arrayBuffer());
  assert.ok(ob.byteLength !== 33 && ob[0] === 0x01, `no principal: the probe's first caller is the in-VM call's own (a CID), never a key (${ob.toString("hex")})`);
  assert.ok(answers.at(-1)!.entry && plain(answers.at(-1)!), "an entry, answered plain");
  // Signed at a route that names no identity filter: answered signed (the session verified for the answer
  // alone), the handler with no caller — #143: the principal is what the route's filters yield.
  answers.length = 0;
  const openSigned = await af.fetch("http://alpha.test/open", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(openSigned.status, 200);
  assert.notEqual(await hexOf(openSigned), client, "no identity filter: no caller");
  assert.ok(signed(answers.at(-1)!), "a signed request: its answer signed on its session (AuthFetch verified it)");
  // A signed request no route is at: its 404, signed (the front door's fn "respond"), no entry.
  answers.length = 0;
  const nowhere = await af.fetch("http://alpha.test/nowhere", { method: "GET" });
  assert.equal(nowhere.status, 404);
  assert.ok(signed(answers.at(-1)!) && !answers.at(-1)!.entry, "a signed 404: signed, nothing written");

  // kernel.beef: no chain state to check a BUMP against — rejected, nothing written; signed, the rejection
  // signed; unsigned, plain.
  const beef = new Beef();
  beef.mergeRawTx(new Transaction(1, [], [{ lockingScript: new P2PKH().lock(clientKey.toPublicKey().toHash()), satoshis: 1 }], 0).toBinary());
  const beefBody = () => ({ method: "POST", headers: { "content-type": "application/octet-stream" }, body: Uint8Array.from(beef.toBinary()) });
  answers.length = 0;
  const rejectedSigned = await af.fetch("http://alpha.test/beef-signed", beefBody());
  assert.equal(rejectedSigned.status, 400);
  assert.match(await rejectedSigned.text(), /no chain state/, "the rejection's reason, in the body AuthFetch verified");
  assert.ok(signed(answers.at(-1)!) && !answers.at(-1)!.entry, "rejected at the door: signed on its session, nothing written");
  answers.length = 0;
  const rejectedPlain = await door("http://alpha.test/beef", beefBody());
  assert.equal(rejectedPlain.status, 400);
  assert.match(await rejectedPlain.text(), /no chain state/);
  assert.ok(plain(answers.at(-1)!) && !answers.at(-1)!.entry, "unsigned: plain, nothing written");

  // A chain state for kernel.beef to check against: root's `head` message (no headers, so a BEEF with no
  // BUMP passes as unproven, the chain app's to judge).
  const state = await k.store.put({ kind: "chain-state", network: "main", maps: { headers: null } } as never);
  await admin("head", { name: "chain/state", tree: state });
  assert.ok(((await k.call("head", "chain/state")) as CID | null)?.equals(state), "root's head message moved the head (the gate: root)");
  // A good BEEF unsigned: validated, admitted — the door names the filter and the BEEF's pointer record, no principal.
  answers.length = 0;
  const validated = await door("http://alpha.test/beef", beefBody());
  assert.equal(validated.status, 200, await validated.clone().text());
  assert.ok(plain(answers.at(-1)!) && answers.at(-1)!.thread, "a thread ran; answered plain");
  const admitted = await k.store.get(answers.at(-1)!.entry!) as { door?: { principal?: unknown; filters?: string[]; beefs?: CID[] } };
  assert.ok(admitted.door?.filters?.[0] === "kernel.beef" && admitted.door.beefs?.length === 1 && admitted.door.principal == null, `the admission: the filter, the BEEF's pointer record, no principal (${JSON.stringify(Object.keys(admitted.door ?? {}))})`);
  // A bad BEEF (a BEEF pattern that does not decode): rejected, plain 400, nothing written.
  answers.length = 0;
  const bad = await door("http://alpha.test/beef", { ...beefBody(), body: Uint8Array.from(beef.toBinary()).subarray(0, 12) });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /does not decode/);
  assert.ok(plain(answers.at(-1)!) && !answers.at(-1)!.entry);
  // #135, signed or validated: unsigned and no BEEF — nothing to validate, nothing written.
  answers.length = 0;
  const nothing = await door("http://alpha.test/beef", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hello: "world" }) });
  assert.equal(nothing.status, 400);
  assert.match(await nothing.text(), /nothing to validate/);
  assert.ok(!answers.at(-1)!.entry);
  // Behind kernel.brc104 then kernel.beef: a signed request with no BEEF passes (the principal admits it); the caller is the client.
  answers.length = 0;
  const signedNothing = await af.fetch("http://alpha.test/beef-signed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hello: "world" }) });
  assert.equal(signedNothing.status, 200);
  assert.equal(await hexOf(signedNothing), client);
  assert.ok(signed(answers.at(-1)!) && answers.at(-1)!.thread);

  // An app (#143): its record lists its filters and roles; root installs it with `objects`/`head` and its routes.
  const app = await k.store.put({
    kind: "app", name: "probe", version: "0.1.0", programs: { probe }, provides: [], requires: [], routes: [], tree: state,
    filters: { page: "probe.page", deny: "probe.deny", pass: "probe.pass" }, roles: { admin: ["whoami"] },
  } as never) as CID;
  await admin("head", { name: "probe/app", tree: app });
  const route = (r: Record<string, unknown>) => admin("dispatch", { op: "add", row: { transport: "http", ...r, app: "probe" } });
  await route({ address: "/probe/page", filters: ["probe.page"] }); // a read route: filters only
  await route({ address: "/probe/deny", filters: ["probe.deny"], program: probe, fn: "whoami" });
  await route({ address: "/probe/gated", filters: ["kernel.brc104", "probe.pass"], program: probe, fn: "whoami" });
  const rows = (await k.dispatch()).rows.filter((r) => r.app === "probe").map((r) => r.address);
  assert.deepEqual(rows, ["/probe/page", "/probe/deny", "/probe/gated"], "root's dispatch messages: the routes");

  // A read route: its filter answers, nothing written.
  answers.length = 0;
  const n2 = await entries();
  const page = await door("http://alpha.test/probe/page", { method: "GET" });
  assert.equal(page.status, 200);
  assert.equal(await page.text(), "page");
  assert.equal(page.headers.get("content-type"), "text/plain");
  // An app's filter rejects: its status and reason, nothing written — signed when the request is.
  const denied = await af.fetch("http://alpha.test/probe/deny", { method: "GET" });
  assert.equal(denied.status, 418);
  assert.match(await denied.text(), /"no"/);
  assert.ok(signed(answers.at(-1)!));
  await k.idle();
  assert.equal(await entries(), n2, "a read and a rejection: no entry");

  // The gate: `whoami` of the probe app is gated by its role `admin` (probe.admin). Root passes; a stranger
  // does not (403, signed, nothing written); granted, it does; revoked, it does not.
  answers.length = 0;
  const asRoot = await af.fetch("http://alpha.test/probe/gated", { method: "GET" });
  assert.equal(asRoot.status, 200);
  assert.equal(await hexOf(asRoot), client, "root passes every gate; an app's `pass` keeps the principal");
  const n3 = await entries();
  const forbidden = await stranger.fetch("http://alpha.test/probe/gated", { method: "GET" });
  assert.equal(forbidden.status, 403);
  assert.ok(signed(answers.at(-1)!), "the gate's 403: signed on the stranger's session");
  await k.idle();
  assert.equal(await entries(), n3 + 1, "the stranger's handshake is an entry; its refused request is none");
  assert.equal((await door("http://alpha.test/probe/gated", { method: "GET" })).status, 401, "no principal: kernel.brc104 turns it away first");
  await admin("grant", { op: "add", role: "probe.admin", principal: keyBytes(strangerId) });
  const grants = await k.store.get(await k.call("head", "grants") as CID) as unknown as { kind: string; roles: Record<string, Uint8Array[]> };
  assert.deepEqual(Object.fromEntries(Object.entries(grants.roles).map(([r, ks]) => [r, ks.map((x) => Buffer.from(x).toString("hex"))])), { root: [client], "probe.admin": [strangerId] }, "the grants head: root and the app role");
  const granted = await stranger.fetch("http://alpha.test/probe/gated", { method: "GET" });
  assert.equal(granted.status, 200);
  assert.equal(await hexOf(granted), strangerId);
  await admin("grant", { op: "remove", role: "probe.admin", principal: keyBytes(strangerId) });
  assert.equal((await stranger.fetch("http://alpha.test/probe/gated", { method: "GET" })).status, 403, "revoked");
  // A stranger's admin message: the gate (root) — recorded, nothing runs.
  const before = await k.call("head", "grants") as CID;
  {
    const bodyBytes = dagCbor.encode({ op: "add", role: "root", principal: keyBytes(strangerId) });
    const unsigned = { kind: "mail", op: "put", sender: keyBytes(strangerId), recipient: keyBytes(identity), box: "grant", body: encode(dagCbor.decode(bodyBytes)).cid, nonce: new Uint8Array(16) };
    const { signature } = await ephemeralWallet(strangerKey).createSignature({ protocolID: MESSAGE_PROTOCOL, keyID: MESSAGE_KEY_ID, counterparty: "anyone", data: [...dagCbor.encode(unsigned)] });
    await appendRequest(k, "local", { kind: "message", message: { ...unsigned, signature: Uint8Array.from(signature) }, body: bodyBytes });
    await k.idle();
  }
  assert.ok((await k.call("head", "grants") as CID).equals(before), "only root grants");

  // Polls: an entry each (an access log), and the session table unchanged.
  const s2 = (await sessions())!;
  const n4 = await entries();
  for (let i = 0; i < 10; i++) await whoami();
  await k.idle();
  assert.equal(await entries(), n4 + 10, "10 polls: 10 entries");
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
  assert.ok(!answers[0]!.entry && plain(answers[0]!), "the expired session's 401: turned away at the door, answered plain (no session to sign on)");
  await k.idle();
  const root2 = await k.store.get((await sessions())!) as unknown as { buckets: CID[] };
  const held2 = (await Promise.all(root2.buckets.map(async (b) => (await k.store.get(b) as unknown as { sessions: unknown[] }).sessions))).flat();
  assert.equal(held2.length, 1, "the handshake dropped the expired sessions");
});

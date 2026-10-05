// The explorer's read route (#40, #68): the front door's `explore` behind the
// read op `explore` (the stock reads: the owner), over a live instance
// through the router — its log, threads, one thread, a head, a record, as
// DAG-JSON. Each request is appended and verified on its own thread like any
// other; the log as it stands is no function of that thread's place in it,
// so the answer is a read the host makes once the thread has ended (the
// front door's fn "read", signed there). A stranger is refused, recorded.
// Nothing any of it does moves a head.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { AuthFetch, PrivateKey } from "@bsv/sdk";
import { RawBox } from "../client/raw.ts";
import { ephemeralWallet } from "../wallet.ts";
import { KERNEL_BIN } from "./kernel.ts";
import { testHost, until } from "./testhost.ts";
import { CHAT_APP } from "../testapps.ts";

type Obj = Record<string, unknown>;
const link = (v: unknown) => (v as { "/": string })["/"];

test("explore: the owner reads the log, threads, a thread, a head and a record; a stranger is refused; each read is an entry and moves nothing", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  const h = await testHost(t);
  h.mailbox("david", h.ownerId);
  h.instance("alpha");
  await h.router.start();
  await h.install("alpha", [CHAT_APP]); // #83: the chat loop is an app
  const alpha = h.db.get("alpha")!.identity!;
  // Something to look at: a chat, answered into david's mailbox.
  await new RawBox(h.owner, h.origin("alpha")).send(alpha, "chat", { text: "hi" });
  await until("the answer", async () => (await new RawBox(h.owner, h.origin("david")).list("chat"))[0]);
  await h.router.settled();

  const af = new AuthFetch(h.owner);
  const get = async (path: string, f: AuthFetch = af) => {
    const r = await f.fetch(`${h.origin("alpha")}${path}`, { method: "GET" });
    return { status: r.status, v: await r.json() as Obj };
  };
  const top = await get("/explore");
  assert.equal(top.status, 200);
  await h.router.settled();
  const n0 = await h.entries("alpha");
  assert.ok(link(top.v.state) && link(top.v.log), "the state and the log tip");
  const heads = top.v.heads as Obj;
  assert.ok(Object.keys(heads).length > 0, `the heads (${Object.keys(heads)})`);

  const log = await get("/explore/log?limit=2");
  const entries = log.v.entries as Array<{ n: number; entry: unknown; record: Obj }>;
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.n, n0, "newest first: this very request, appended before the read");
  assert.equal((entries[0]!.record as { transport?: string }).transport, "http", "a request as received");
  const older = await get(`/explore/log?before=1`);
  assert.deepEqual((older.v.entries as Array<{ n: number; record: Obj }>).map((e) => [e.n, "genesis" in e.record]), [[0, true]], "before=1: the genesis");

  const threads = (await get("/explore/threads")).v.threads as Array<{ at: number; origin: unknown }>;
  assert.ok(threads.length > 0);
  const one = await get(`/explore/thread/${link(threads[0]!.origin)}`);
  assert.equal(one.status, 200);
  const ups = one.v.updates as Array<{ seq: number; record: Obj }>;
  assert.equal((one.v.chain as { kind: string }).kind, "thread");
  assert.ok(ups.length > 0 && ups[0]!.seq === 1 && link(ups[0]!.record.origin) === link(threads[0]!.origin), "the thread's updates in order (seq 0 is its origin)");

  const head = await get(`/explore/head/${Object.keys(heads)[0]}`);
  assert.equal(head.status, 200);
  const rec = await get(`/explore/record/${link(entries.at(-1)!.entry)}`);
  assert.equal(rec.status, 200);
  assert.equal(rec.v.kind, "log", "a record as DAG-JSON");
  assert.equal((await get("/explore/record/bafyreiabc")).status, 400);
  assert.equal((await get("/explore/nothing")).status, 404);

  // Each read was one entry (its request); none moved a head.
  await h.router.settled();
  const after = (await get("/explore")).v;
  assert.equal(await h.entries("alpha"), n0 + 9, "eight reads since, and this one: an entry each");
  assert.deepEqual(after.heads, heads, "no head moved");

  // Not the owner: refused by the read rule (403), signed by the instance all the same; recorded, nothing moved.
  const stranger = await get("/explore", new AuthFetch(ephemeralWallet(PrivateKey.fromRandom())));
  assert.equal(stranger.status, 403);
  await h.router.settled();
  assert.equal(await h.entries("alpha"), n0 + 11, "the stranger's handshake and its refused read");
  const last = (await get("/explore")).v;
  assert.deepEqual(Object.keys(last.heads as Obj).sort(), Object.keys(heads).sort(), "the heads are the same ones");
  for (const [k, v] of Object.entries(heads)) if (k !== "frontdoor/sessions") assert.deepEqual((last.heads as Obj)[k], v, `head ${k} unmoved`);

  // The reads' fuel is charged to the identity the front door verified (H13): the owner's, never another's.
  h.router.flushLedger();
  const ledger = h.db.ledger("alpha");
  assert.ok(ledger.length > 0 && ledger.every((r) => r.caller === h.ownerId && r.fuel > 0), `the ledger: ${JSON.stringify(ledger.map((r) => [r.caller.slice(0, 8), r.op]))}`);
});

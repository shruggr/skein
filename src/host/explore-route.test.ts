// The explorer's read route (#40): the front door's `explore` behind the
// read op `explore` (the stock reads: the owner), over a live instance
// through the router — its log, threads, one thread, a head, a record, as
// DAG-JSON; a stranger refused; nothing written by any of it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { AuthFetch, PrivateKey } from "@bsv/sdk";
import { RawBox } from "../client/raw.ts";
import { ephemeralWallet } from "../wallet.ts";
import { KERNEL_BIN } from "./kernel.ts";
import { testHost, until } from "./testhost.ts";

type Obj = Record<string, unknown>;
const link = (v: unknown) => (v as { "/": string })["/"];

test("explore: the owner reads the log, threads, a thread, a head and a record; a stranger is refused; nothing is written", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  const h = await testHost(t);
  h.mailbox("david", h.ownerId);
  const alpha = h.agent("alpha");
  await h.router.start();
  // Something to look at: a chat, answered into david's mailbox.
  await new RawBox(h.owner, h.origin("alpha")).send(alpha, "chat", { text: "hi" });
  await until("the answer", async () => (await new RawBox(h.owner, h.origin("david")).list("chat"))[0]);
  await h.router.settled();

  const af = new AuthFetch(h.owner);
  const get = async (path: string, f: AuthFetch = af) => {
    const r = await f.fetch(`${h.origin("alpha")}${path}`, { method: "GET" });
    return { status: r.status, v: await r.json() as Obj };
  };
  // The first request shakes hands (a session in memory: no write); nothing is written.
  const top = await get("/explore");
  assert.equal(top.status, 200);
  await h.router.settled();
  const n0 = await h.entries("alpha"), s0 = h.storeSize("alpha");
  assert.ok(link(top.v.state) && link(top.v.log), "the state and the log tip");
  assert.ok(Object.keys(top.v.heads as Obj).length > 0, `the heads (${Object.keys(top.v.heads as Obj)})`);

  const log = await get("/explore/log?limit=2");
  const entries = log.v.entries as Array<{ n: number; entry: unknown; record: Obj }>;
  assert.equal(entries.length, 2, "the genesis and the chat (a handshake writes nothing)");
  assert.equal(entries[0]!.n, n0 - 1, "newest first");
  const older = await get(`/explore/log?before=1`);
  assert.deepEqual((older.v.entries as Array<{ n: number; record: Obj }>).map((e) => [e.n, "genesis" in e.record]), [[0, true]], "before=1: the genesis");

  const threads = (await get("/explore/threads")).v.threads as Array<{ at: number; origin: unknown }>;
  assert.ok(threads.length > 0);
  const one = await get(`/explore/thread/${link(threads[0]!.origin)}`);
  assert.equal(one.status, 200);
  const ups = one.v.updates as Array<{ seq: number; record: Obj }>;
  assert.equal((one.v.chain as { kind: string }).kind, "thread");
  assert.ok(ups.length > 0 && ups[0]!.seq === 1 && link(ups[0]!.record.origin) === link(threads[0]!.origin), "the thread's updates in order (seq 0 is its origin)");

  const head = await get(`/explore/head/${Object.keys(top.v.heads as Obj)[0]}`);
  assert.equal(head.status, 200);
  const rec = await get(`/explore/record/${link(entries.at(-1)!.entry)}`);
  assert.equal(rec.status, 200);
  assert.equal(rec.v.kind, "log", "a record as DAG-JSON");
  assert.equal((await get("/explore/record/bafyreiabc")).status, 400);
  assert.equal((await get("/explore/nothing")).status, 404);

  await h.router.settled();
  assert.equal(await h.entries("alpha"), n0, "explore wrote no entry");
  assert.equal(h.storeSize("alpha"), s0, "explore wrote no byte");

  // Not the owner: refused by the read rule (403), signed by the instance all the same; its handshake writes nothing.
  const stranger = await get("/explore", new AuthFetch(ephemeralWallet(PrivateKey.fromRandom())));
  assert.equal(stranger.status, 403);
  await h.router.settled();
  assert.equal(await h.entries("alpha"), n0, "the stranger's handshake: no entry");
  assert.equal(h.storeSize("alpha"), s0, "the stranger's handshake: no byte");
});

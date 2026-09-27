// Subscriptions as a chain: the chain operations on both stores, then end to
// end — the genesis seed is the chain's first updates; the owner adds a
// sender at runtime (box `subscribe`) and its `chat` routes, removes it and
// it does not; a non-owner cannot subscribe until the owner delegates; a
// program is registered by subscribing a box to its CID; replay with no
// wallet writes the same chain and routes the same way.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { seal } from "../envelope.ts";
import { bundlesOf, collect, installWasm, instance, iso, send, type Instance } from "../testkit.ts";
import { ephemeralWallet } from "../wallet.ts";
import { encode, fmt } from "./cid.ts";
import { headTree } from "./heads.ts";
import { copyLog, defaultSubscriptions } from "./log.ts";
import { memoryStore } from "./memory.ts";
import { MODULES, PROGRAM_CIDS } from "./programs.ts";
import { program, type Subscription } from "./records.ts";
import { Runtime, witnessFrom } from "./scheduler.ts";
import { openStore } from "./sqlite.ts";
import type { Store } from "./store.ts";
import { currentSubscriptions, subscribe, subscriptionsOrigin, subscriptionUpdates, type SubscriptionUpdate } from "./subscriptions.ts";
import type { ThreadOrigin, ThreadUpdate } from "./types.ts";

const stores: Array<[string, () => Store]> = [["memory", memoryStore], ["sqlite", () => openStore(":memory:")]];
const rows = (xs: Subscription[]) => xs.map((s) => [s.match.sender ?? "*", s.match.box, fmt(s.handler)]);

for (const [name, make] of stores) {
  test(`subscriptions (${name}): none until opened; add appends, remove deletes; no-op changes write nothing`, async () => {
    const s = make();
    const a = await s.put({ kind: "blob", n: 1 }), b = await s.put({ kind: "blob", n: 2 });
    const by = { input: await s.put({ kind: "blob", n: 3 }), at: 7 };
    const who = PrivateKey.fromRandom().toPublicKey().toString();
    assert.equal(await currentSubscriptions(s), undefined);
    assert.ok(subscriptionsOrigin().equals(encode({ kind: "subscriptions" }).cid), "the origin is the same record everywhere");

    const u1 = await subscribe(s, { op: "add", box: "chat", handler: a }, by);
    const u2 = await subscribe(s, { op: "add", sender: who, box: "run", handler: b }, { ...by, thread: b });
    assert.deepEqual(rows((await currentSubscriptions(s))!), [["*", "chat", fmt(a)], [who, "run", fmt(b)]]);
    assert.equal(await subscribe(s, { op: "add", box: "chat", handler: a }, by), undefined, "already listed: nothing written");
    assert.equal(await subscribe(s, { op: "remove", box: "chat", handler: b }, by), undefined, "not listed: nothing written");
    const u3 = await subscribe(s, { op: "remove", box: "chat", handler: a }, { ...by, at: 9 });
    assert.deepEqual(rows((await currentSubscriptions(s))!), [[who, "run", fmt(b)]]);
    const r = await s.get(u2!) as unknown as SubscriptionUpdate;
    assert.deepEqual({ ...r, origin: fmt(r.origin), prev: fmt(r.prev), handler: fmt(r.handler), thread: fmt(r.thread!), input: fmt(r.input) },
      { origin: fmt(subscriptionsOrigin()), prev: fmt(u1!), seq: 2, op: "add", sender: who, box: "run", handler: fmt(b), thread: fmt(b), input: fmt(by.input), at: 7 });
    assert.deepEqual((await subscriptionUpdates(s))!.map((x) => fmt(x.cid)), [u1, u2, u3].map((c) => fmt(c!)));

    await assert.rejects(subscribe(s, { op: "add", box: "", handler: a }, by), /box/);
    await assert.rejects(subscribe(s, { op: "add", sender: "nope", box: "x", handler: a }, by), /sender/);
    await assert.rejects(subscribe(s, { op: "swap" as never, box: "x", handler: a }, by), /op/);
    await s.close();
  });
}

/** Collect and process twice (a box subscribed in the first is collected in the second), then move the clock on a second. */
async function settle(i: Instance) {
  for (let n = 0; n < 2; n++) { await i.delivery.poll(); await i.rt.idle(); }
  i.clock.set([i.clock.now()[0] + 1, 0]);
}

/** `who` seals `body` to the instance and delivers it into `box`. */
async function sendAs(i: Instance, who: PrivateKey, box: string, body: unknown): Promise<void> {
  const env = await seal(ephemeralWallet(who), { recipient: { identityKey: i.identity, handle: "skein", domain: "localhost" }, body: dagCbor.encode(body), created: iso(i.clock.now()) });
  await i.hub.as(who.toPublicKey().toString()).send({ recipient: i.identity, box, body: env });
}

const threadsOf = (s: Store, p: CID) => collect(s.edges.query({ kind: "thread", program: p }));
const tipOf = async (s: Store, t: CID) => s.get<ThreadUpdate & { subscriptions?: CID[] }>(await s.chains.tip(t));
const now = async (i: Instance) => rows((await currentSubscriptions(i.store))!);

test("subscriptions: the seed is the chain; the owner adds and removes a sender at runtime; delegation; registering a program; replay with no wallet", async (t) => {
  const i = await instance();
  const stranger = PrivateKey.fromRandom(), strangerId = stranger.toPublicKey().toString();
  const me = i.owner.identity;
  await i.rt.idle();

  // The genesis seed is the chain's first updates, written by no thread.
  assert.deepEqual(await now(i), rows(defaultSubscriptions(me)));
  assert.ok((await subscriptionUpdates(i.store))!.every(({ u }) => u.op === "add" && u.thread === undefined));

  // A stranger's chat: no subscription, recorded, nothing runs.
  await sendAs(i, stranger, "chat", { text: "hello?" });
  await settle(i);
  assert.equal((await threadsOf(i.store, PROGRAM_CIDS.loop)).length, 0);
  assert.ok(i.lines.some((l) => / in chat from .*no subscription; recorded, nothing runs/.test(l)), i.lines.join("\n"));

  // The owner subscribes the stranger's chat to the loop: now it routes.
  await send(i, "subscribe", { op: "add", sender: strangerId, box: "chat", handler: PROGRAM_CIDS.loop });
  await settle(i);
  const [sub1] = await threadsOf(i.store, PROGRAM_CIDS["subscribe-handler"]);
  const u = await tipOf(i.store, sub1);
  assert.equal(u.state, "finished", i.lines.join("\n"));
  const change = await i.store.get(u.subscriptions![0]) as unknown as SubscriptionUpdate;
  assert.ok(change.thread!.equals(sub1) && change.origin.equals(subscriptionsOrigin()), "the step lists the change it wrote, which names the step's thread");
  assert.deepEqual((await now(i)).at(-1), [strangerId, "chat", fmt(PROGRAM_CIDS.loop)]);
  await sendAs(i, stranger, "chat", { text: "hello again" });
  await settle(i);
  const [loop] = await threadsOf(i.store, PROGRAM_CIDS.loop);
  assert.ok(loop, "the stranger's chat launched the loop");
  assert.equal((await i.store.get<ThreadOrigin>(loop)).args && ((await i.store.get<ThreadOrigin>(loop)).args as { sender: string }).sender, strangerId);

  // Removed: recorded, nothing runs.
  await send(i, "subscribe", { op: "remove", sender: strangerId, box: "chat", handler: PROGRAM_CIDS.loop });
  await settle(i);
  assert.deepEqual(await now(i), rows(defaultSubscriptions(me)));
  await sendAs(i, stranger, "chat", { text: "still there?" });
  await settle(i);
  assert.equal((await threadsOf(i.store, PROGRAM_CIDS.loop)).length, 1, "no new loop thread");

  // A non-owner cannot subscribe: its `subscribe` is recorded, nothing runs.
  const before = (await subscriptionUpdates(i.store))!.length;
  await sendAs(i, stranger, "subscribe", { op: "add", sender: strangerId, box: "run", handler: PROGRAM_CIDS["run-handler"] });
  await settle(i);
  assert.equal((await subscriptionUpdates(i.store))!.length, before);
  assert.equal((await threadsOf(i.store, PROGRAM_CIDS["subscribe-handler"])).length, 2, "only the owner's two");

  // Delegated: the owner subscribes the stranger to `subscribe`; now it can.
  await send(i, "subscribe", { op: "add", sender: strangerId, box: "subscribe", handler: PROGRAM_CIDS["subscribe-handler"] });
  await settle(i);
  await sendAs(i, stranger, "subscribe", { op: "add", sender: strangerId, box: "run", handler: PROGRAM_CIDS["run-handler"] });
  await settle(i);
  assert.deepEqual((await now(i)).slice(-2), [[strangerId, "subscribe", fmt(PROGRAM_CIDS["subscribe-handler"])], [strangerId, "run", fmt(PROGRAM_CIDS["run-handler"])]]);

  // Registering a program: its record arrives through `objects` (the module is
  // head-handler's, already in the store), then a box is subscribed to its CID.
  const mover = program({ name: "mover", code: { wasm: MODULES["head-handler"] }, inputs: { envelope: "cid", body: "cid" }, services: [], description: "test: head-handler's module under another name" });
  const moverCid = encode(mover).cid;
  await send(i, "subscribe", { op: "add", sender: me, box: "move", handler: moverCid });
  await settle(i);
  const refused = await tipOf(i.store, (await threadsOf(i.store, PROGRAM_CIDS["subscribe-handler"]))[0]);
  assert.equal(refused.state, "errored", "a handler not in the store is refused");
  assert.ok(!(await now(i)).some(([, box]) => box === "move"));

  const d = await fs.mkdtemp(join(tmpdir(), "skein-subs-"));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  await fs.writeFile(join(d, "a.txt"), "alpha\n");
  const { root, bundles } = await bundlesOf(d);
  for (const b of bundles) await send(i, "objects", b);
  await send(i, "objects", { records: [{ cid: moverCid, bytes: encode(mover).bytes }] });
  await send(i, "subscribe", { op: "add", sender: me, box: "move", handler: moverCid });
  await settle(i);
  assert.deepEqual((await now(i)).at(-1), [me, "move", fmt(moverCid)]);
  await send(i, "move", { name: "feature", tree: root });
  await settle(i);
  const [moved] = await threadsOf(i.store, moverCid);
  assert.equal((await tipOf(i.store, moved)).state, "finished", i.lines.join("\n"));
  assert.ok((await headTree(i.store, "feature"))!.equals(root), "the registered program ran for its box");
  t.diagnostic(i.lines.join("\n"));

  // Replay: the log alone, no wallet; the chain and every thread come back identical.
  await i.rt.stop();
  const fresh = memoryStore();
  await installWasm(fresh);
  await copyLog(i.store, fresh);
  const rt = new Runtime({ store: fresh, witness: await witnessFrom(i.store), outbox: { send: () => {} } });
  await rt.start();
  await rt.idle();
  assert.ok((await fresh.chains.tip(subscriptionsOrigin())).equals(await i.store.chains.tip(subscriptionsOrigin())), "the subscriptions chain replays to the same tip");
  for (const th of await collect(i.store.edges.query({ kind: "thread" }))) assert.ok((await fresh.chains.tip(th)).equals(await i.store.chains.tip(th)), `thread ${fmt(th)}`);
  assert.equal((await collect(fresh.edges.query({ kind: "thread" }))).length, (await collect(i.store.edges.query({ kind: "thread" }))).length, "the same threads, no more");
  await rt.stop();
});

test("subscriptions: a store whose log predates the chain refuses to start", async () => {
  const i = await instance();
  await i.rt.idle();
  await i.rt.stop();
  // Simulate an old store: the same log, processed, with no chain.
  const old = memoryStore();
  await installWasm(old);
  await copyLog(i.store, old);
  await old.live.cursor.set(1);
  await assert.rejects(new Runtime({ store: old }).start(), /predates the subscriptions chain/);
});

// The host's holder map and the gossip `admit` it publishes (skein next, SPEC 8), without a kernel: the facts
// reach the router as a kernel's emit notices do (Providers.deliver, transport `event`, with the place), and
// the router follows them — `chain/tx/<txid>` pending/seen remembers the instance, mined forgets it, a
// reorg's `seen` remembers it again; the map is rebuilt at a start from the instances' event indexes with no
// kernel started; the overlay's `admitted` fact with `topics` is announced once per topic.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as dagCbor from "@ipld/dag-cbor";
import { PrivateKey } from "@bsv/sdk";
import { CID } from "multiformats/cid";
import { encode } from "../runtime/cid.ts";
import { ephemeralWallet } from "../wallet.ts";
import type { Delivered } from "./events.ts";
import { HostDb } from "./instances.ts";
import { Router } from "./router.ts";
import { Signer } from "./signer.ts";
import { admitOf } from "./sync.ts";

const X = "aa".repeat(32), Y = "bb".repeat(32);
const THREAD = CID.parse("bafkreibilg3pxsatmgycfce6gpl4lfzrwjcqxkpjf7jitz6grn3e6nrxo4");

async function host(t: { after(f: () => unknown): void }, o: { p2p?: boolean } = {}) {
  const home = await fs.mkdtemp(join(tmpdir(), "skein-holders-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const db = new HostDb(join(home, "host.db"));
  for (const h of ["a", "b", "c"]) db.add(h, { store: join(home, `${h}.db`) });
  const signer = new Signer(PrivateKey.fromRandom());
  const r = new Router({
    db, walletFor: () => ephemeralWallet(PrivateKey.fromRandom()), home, idleMs: 0, ledgerMs: 60_000,
    ...(o.p2p ? { peerKeyFor: (h: string) => signer.peerKey(h), libp2p: { listen: ["/ip4/127.0.0.1/tcp/0"], bootstrap: [], dht: "off" as const, relays: [], mdns: false } } : {}),
  });
  t.after(async () => { await r.close(); db.close(); });
  let s = 0;
  /** A fact from `handle`, handed over as its kernel's emit notice is (after its step's commit). */
  const fact = (handle: string, rec: Record<string, unknown>) => {
    const message = { kind: "event", ...rec };
    r.providers.deliver(handle, { message: message as never, body: new Uint8Array(), transport: "event", address: String(rec.event), place: { s: ++s, i: 0, thread: THREAD } });
  };
  return { r, db, fact };
}

test("holders (SPEC 8): chain/tx facts — pending remembers, mined forgets, a reorg's seen remembers again; rejected changes nothing; only enabled instances", async (t) => {
  const { r, db, fact } = await host(t);
  assert.deepEqual(r.holdersOf(X), []);
  fact("a", { event: `chain/tx/${X}`, status: "pending" });
  fact("b", { event: `chain/tx/${X}`, status: "pending" });
  fact("c", { event: `chain/tx/${Y}`, status: "pending" });
  assert.deepEqual(r.holdersOf(X).sort(), ["a", "b"]);
  assert.deepEqual(r.holdersOf(X.toUpperCase()).sort(), ["a", "b"], "a txid in either case");
  assert.deepEqual(r.holdersOf(Y), ["c"]);

  fact("a", { event: `chain/tx/${X}`, status: "mined", height: 103 });
  assert.deepEqual(r.holdersOf(X), ["b"], "mined: a forgets it");
  fact("b", { event: `chain/tx/${X}`, status: "mined", height: 103 });
  assert.deepEqual(r.holdersOf(X), []);
  assert.ok(!r.holding.has(X), "settled everywhere: nothing kept");

  // A reorg: the block left the best chain; the chain app says `seen` (reason reorged).
  fact("a", { event: `chain/tx/${X}`, status: "seen", reason: "reorged" });
  assert.deepEqual(r.holdersOf(X), ["a"], "un-mined by a reorg: remembered again");
  fact("a", { event: `chain/tx/${X}`, status: "mined", height: 104 });
  assert.deepEqual(r.holdersOf(X), []);

  // rejected: not one of the three SPEC 8 names — the map is left as it stands (plan-host C8 open).
  fact("c", { event: `chain/tx/${Y}`, status: "rejected", reason: "double-spend" });
  assert.deepEqual(r.holdersOf(Y), ["c"]);
  // Other facts, and a txid that is no txid, are not followed.
  fact("a", { event: `chain/output/${X}.0`, state: "spent" });
  fact("a", { event: "chain/tx/nope", status: "pending" });
  fact("a", { event: `amm/tx/${X}`, status: "pending" });
  assert.deepEqual(r.holdersOf(X), []);
  // A disabled instance is no holder.
  db.setStatus("c", "disabled");
  assert.deepEqual(r.holdersOf(Y), []);
  db.setStatus("c", "enabled");
  // Handed over again (a kernel's start re-offers): the same state.
  fact("c", { event: `chain/tx/${Y}`, status: "pending" });
  assert.deepEqual(r.holdersOf(Y), ["c"]);
  assert.equal(r.loaded.size, 0, "no kernel was started for any of it");
});

test("holders (SPEC 8): rebuilt at a start from each enabled instance's event index (its latest chain/tx/ fact per txid), no kernel started", async (t) => {
  const { r, db } = await host(t);
  db.setStatus("c", "disabled");
  const index: Record<string, Array<{ txid: string; status: string }>> = {
    a: [{ txid: X, status: "pending" }, { txid: Y, status: "mined" }],
    b: [{ txid: X, status: "seen" }, { txid: Y, status: "pending" }],
    c: [{ txid: X, status: "pending" }],
  };
  const asked: Array<{ handle: string; q: unknown }> = [];
  // The store read (EventStreams.read: the instance's store file read-only, events.test.ts covers it), recorded.
  r.events.read = async (handle, q) => {
    asked.push({ handle, q });
    return (index[handle] ?? []).map((x, i): Delivered => ({ id: `${i + 1}.0.${THREAD}`, event: `chain/tx/${x.txid}`, data: JSON.stringify({ kind: "event", event: `chain/tx/${x.txid}`, status: x.status }) }));
  };
  r.holding.set("cc".repeat(32), new Set(["a"])); // what a previous run held in memory: gone at a rebuild
  await r.rebuildHolders();
  assert.deepEqual(asked, [{ handle: "a", q: { name: "chain/tx/", prefix: true, latest: true } }, { handle: "b", q: { name: "chain/tx/", prefix: true, latest: true } }], "each enabled instance's index, the latest per txid");
  assert.deepEqual(r.holdersOf(X).sort(), ["a", "b"]);
  assert.deepEqual(r.holdersOf(Y), ["b"], "a's Y is mined: not held");
  assert.ok(!r.holding.has("cc".repeat(32)));
  assert.equal(r.loaded.size, 0, "no kernel started");
});

test("admit (SPEC 7/8): the overlay's `admitted` fact with `topics` — the host publishes the gossip admit per topic, once; a fact without topics (skein-overlay v0.28.1) or another verdict publishes nothing", async (t) => {
  const { r, fact } = await host(t, { p2p: true });
  const published: Array<{ handle: string; topic: string; body: Uint8Array }> = [];
  r.p2p!.publish = async (handle, topic, body) => { published.push({ handle, topic, body }); return { seqno: new Uint8Array(8), recipients: 1 }; };
  const settle = () => r.settled();

  fact("a", { event: `ovl/topic/tx/${X}`, verdict: "admitted" });
  fact("a", { event: `ovl/topic/tx/${Y}`, verdict: "undecided", topics: { tm_a: { outputsToAdmit: [0], coinsToRetain: [] } } });
  await settle();
  assert.equal(published.length, 0, "no topics (today's overlay: it publishes itself through the provider), or not admitted: nothing");

  fact("a", { event: `ovl/topic/tx/${X}`, verdict: "admitted", topics: { tm_a: { outputsToAdmit: [0, 2], coinsToRetain: [1] }, tm_b: { outputsToAdmit: [1], coinsToRetain: [] } } });
  await settle();
  assert.deepEqual(published.map((p) => [p.handle, p.topic]), [["a", "tm_a"], ["a", "tm_b"]], "one publish per topic, from the instance's node");
  const body = dagCbor.decode(published[0]!.body) as Record<string, unknown>;
  assert.deepEqual(body, { kind: "admit", txid: X, topics: { tm_a: { outputsToAdmit: [0, 2], coinsToRetain: [1] } } }, "gossip.zig admitBody's shape, that topic's entry alone");
  assert.equal(admitOf("tm_a", published[0]!.body), X, "the sync side reads it back");
  assert.equal(admitOf("tm_b", published[1]!.body), X);
  assert.deepEqual(encode(body).bytes, published[0]!.body, "canonical dag-cbor");

  // Handed over again: not published again; another instance's admission of the same transaction is its own.
  fact("a", { event: `ovl/topic/tx/${X}`, verdict: "admitted", topics: { tm_a: { outputsToAdmit: [0, 2], coinsToRetain: [1] } } });
  fact("b", { event: `ovl/topic/tx/${X}`, verdict: "admitted", topics: { tm_a: { outputsToAdmit: [0, 2], coinsToRetain: [1] } } });
  await settle();
  assert.deepEqual(published.map((p) => [p.handle, p.topic]), [["a", "tm_a"], ["a", "tm_b"], ["b", "tm_a"]]);

  // A malformed entry is not announced (a line says so); a failed publish may go again.
  fact("a", { event: `ovl/topic/tx/${Y}`, verdict: "admitted", topics: { tm_a: { outputsToAdmit: "0" } } });
  await settle();
  assert.equal(published.length, 3);
  let fail = true;
  r.p2p!.publish = async (handle, topic, body) => { if (fail) { fail = false; throw new Error("no peers"); } published.push({ handle, topic, body }); return { seqno: new Uint8Array(8), recipients: 1 }; };
  fact("c", { event: `ovl/topic/tx/${Y}`, verdict: "admitted", topics: { tm_c: { outputsToAdmit: [0], coinsToRetain: [] } } });
  await settle();
  assert.equal(published.length, 3, "the failed publish");
  fact("c", { event: `ovl/topic/tx/${Y}`, verdict: "admitted", topics: { tm_c: { outputsToAdmit: [0], coinsToRetain: [] } } });
  await settle();
  assert.deepEqual(published.at(-1)!.topic, "tm_c", "handed over again after a failure: published");
});

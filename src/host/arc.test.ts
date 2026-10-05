// The host's broadcaster (#58, #65, arc.ts) against a fake Arcade
// (fake-arcade.ts), without a kernel: the durable queue (a broadcast event's
// Atomic BEEF posted as Extended Format under the host's token; Arcade's
// answer a status — RECEIVED, a duplicate's, a 400's REJECTED; a 503 or no
// answer tried again with backoff, the queue taken up by a new process;
// given up a day on), the routing table (the broadcasters, a sweep of every
// instance at a txid's first status, then the running ones only; every
// holder gets each — a proof as an event in box `chain`, any other status as
// the status provider's message; a redelivery, stream or webhook, writes
// nothing), and the subscription's resume across a restart with
// Last-Event-ID from host.db. With a router: no broadcast route any more, a
// host with no Arcade drops a broadcast event and names no status provider
// (kernel-zig/equiv/wallet.ts and overlay.ts run it all with a kernel).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MerklePath, P2PKH, PrivateKey, Transaction, UnlockingScript } from "@bsv/sdk";
import type { CID } from "multiformats/cid";
import { arcadeBody, Broadcaster, hostArcConfig, type ArcConfig } from "./arc.ts";
import { FakeArcade } from "./fake-arcade.ts";
import { txCid } from "./feeds.ts";
import { resolveSystem } from "./genesis.ts";
import { HostDb } from "./instances.ts";
import { Router } from "./router.ts";

const until = async <T>(what: string, f: () => T | undefined, ms = 5000): Promise<T> => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    const v = f();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out: ${what}`);
};
const TOKEN = "host-token";

/** A funded transaction (its source proven at 101) spending to a key, as the wallet would post it. */
async function spend(n: number): Promise<{ tx: Transaction; beef: Uint8Array }> {
  const k = new PrivateKey(0x1000 + n);
  const fund = new Transaction();
  fund.addInput({ sourceTXID: n.toString(16).padStart(64, "0"), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex("51"), sequence: 0xffffffff });
  fund.addOutput({ lockingScript: new P2PKH().lock(k.toPublicKey().toHash()), satoshis: 10_000 });
  fund.merklePath = new MerklePath(101, [[{ offset: 0, hash: fund.id("hex"), txid: true }]]);
  const tx = new Transaction();
  tx.addInput({ sourceTransaction: fund, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(k), sequence: 0xffffffff });
  tx.addOutput({ lockingScript: new P2PKH().lock(k.toPublicKey().toHash()), satoshis: 9_000 });
  await tx.sign();
  return { tx, beef: Uint8Array.from(tx.toAtomicBEEF()) };
}

function home(t: { after(f: () => void): void }): string {
  const d = mkdtempSync(join(tmpdir(), "skein-arc-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

test("arc: the host config (SKEIN_ARC_*, from the environment or host.env); a BEEF to Extended Format", async (t) => {
  const h = home(t);
  assert.equal(hostArcConfig({}, h), undefined);
  assert.throws(() => hostArcConfig({ SKEIN_ARC_URL: "http://a" }, h), /SKEIN_ARC_TOKEN/);
  writeFileSync(join(h, "host.env"), "SKEIN_ARC_URL=https://arcade.test/\nexport SKEIN_ARC_TOKEN='tok'\nSKEIN_ARC_EVENTS_URL=https://arcade.test:8082/events\nOTHER=1\n");
  assert.deepEqual(hostArcConfig({}, h), { url: "https://arcade.test", token: "tok", events: "https://arcade.test:8082/events" });
  assert.deepEqual(hostArcConfig({ SKEIN_ARC_TOKEN: "env", SKEIN_ARC_CALLBACK_URL: "https://me/arc/callback" }, h), { url: "https://arcade.test", token: "env", events: "https://arcade.test:8082/events", callbackUrl: "https://me/arc/callback" });

  const { tx, beef } = await spend(1);
  const b = arcadeBody(beef);
  assert.equal(b.txid, tx.id("hex"));
  assert.deepEqual([...b.bytes], tx.toEF(), "the Atomic BEEF's subject, in Extended Format");
  const raw = Uint8Array.from(tx.toBinary());
  assert.deepEqual(arcadeBody(raw), { txid: tx.id("hex"), bytes: raw }, "a raw transaction goes as it came");
});

/** A broadcaster over a fake Arcade with instances a..d: `holding` is who holds what, `running` who runs. */
function broadcaster(arc: ArcConfig, db: HostDb, holding: Map<string, Set<string>>, running: Set<string>, o: { now?: () => number; giveUpMs?: number } = {}) {
  /** What reached each instance: [handle, how ("proof" event in box chain | "status" message), txid, txStatus]. */
  const admitted: Array<[string, string, string, string]> = [];
  const asked: Array<[string, string]> = [];
  const b = new Broadcaster({
    arc, db, backoff: { min: 20, max: 100 }, retry: { min: 20, max: 100 }, ...(o.now ? { now: o.now } : {}), ...(o.giveUpMs ? { giveUpMs: o.giveUpMs } : {}),
    admit: async (h, box, ev) => {
      assert.equal(box, "chain");
      assert.equal(ev.kind, "proof");
      assert.ok(ev.path instanceof Uint8Array && (ev.subject as CID).equals(txCid(String(ev.txid))), "a proof event: its path, about the transaction");
      admitted.push([h, "proof", String(ev.txid), "MINED"]);
    },
    status: async (h, body, subject) => {
      assert.equal(body.kind, "status");
      assert.ok(subject.equals(txCid(String(body.txid))), "a status message about the transaction");
      assert.equal(body.merklePath, undefined, "never a path: that is a proof's");
      admitted.push([h, "status", String(body.txid), String(body.txStatus)]);
    },
    instances: () => ({ all: ["a", "b", "c", "d"], running: [...running] }),
    holds: async (h, txid) => { asked.push([h, txid]); running.add(h); return holding.get(h)?.has(txid) ?? false; },
  });
  return { b, admitted, asked };
}

test("arc: the queue — a broadcast event posted under the host's token, Arcade's answer a status; refused, REJECTED; not taken, tried again; a new process takes up the queue; given up", async (t) => {
  const arcade = await FakeArcade.start();
  t.after(() => arcade.close());
  const db = new HostDb(join(home(t), "host.db"));
  t.after(() => db.close());
  const arc = { url: arcade.url, token: TOKEN, events: arcade.eventsUrl };
  const { tx, beef } = await spend(2);
  const X = tx.id("hex");
  const raw = Uint8Array.from(tx.toBinary());
  const one = broadcaster(arc, db, new Map(), new Set(["a"]));
  t.after(() => one.b.stop());

  assert.equal(one.b.enqueue("a", raw, beef), X);
  await until("posted and answered", () => one.admitted.length === 1 || undefined);
  assert.deepEqual([...arcade.posts.at(-1)!], tx.toEF(), "Arcade received the transaction in Extended Format (the BEEF's ancestry)");
  const h = arcade.postHeaders.at(-1)!;
  assert.equal(h["x-callbacktoken"], TOKEN);
  assert.equal(h["x-fullstatusupdates"], "true");
  assert.equal(h["x-callbackurl"], undefined, "no webhook without a callback URL");
  assert.deepEqual(one.admitted, [["a", "status", X, "RECEIVED"]], "Arcade's 202 is a status for the broadcaster (it holds the transaction)");
  assert.deepEqual(one.b.queued(), [], "answered: off the queue");

  // The same again (a kernel's start hands over what a thread still awaits): a duplicate, its current status.
  arcade.emit(X, { txStatus: "SEEN_ON_NETWORK" });
  one.b.enqueue("a", raw, beef);
  await until("the duplicate's status", () => one.admitted.some(([, , , st]) => st === "SEEN_ON_NETWORK") || undefined);
  // A raw transaction (no BEEF in the event) goes as it came.
  const two = await spend(3);
  arcade.mode = "reject";
  one.b.enqueue("a", Uint8Array.from(two.tx.toBinary()));
  await until("the refusal", () => one.admitted.some(([, , x]) => x === two.tx.id("hex")) || undefined);
  assert.deepEqual([...arcade.posts.at(-1)!], two.tx.toBinary());
  assert.deepEqual(one.admitted.find(([, , x]) => x === two.tx.id("hex")), ["a", "status", two.tx.id("hex"), "REJECTED"], "Arcade's 400 is a REJECTED status");
  arcade.mode = "ok";

  // Backpressure: not taken — kept, tried again (backoff), taken.
  const three = await spend(4);
  arcade.mode = "busy";
  const posts = arcade.posts.length;
  one.b.enqueue("a", Uint8Array.from(three.tx.toBinary()), Uint8Array.from(three.tx.toAtomicBEEF()));
  await until("tried again", () => arcade.posts.length >= posts + 2 || undefined);
  assert.equal(one.b.queued()[0]?.txid, three.tx.id("hex"), "still queued");
  assert.ok(one.b.queued()[0]!.attempts >= 1);
  arcade.mode = "ok";
  await until("taken", () => one.admitted.some(([, , x]) => x === three.tx.id("hex")) || undefined);
  assert.deepEqual(one.b.queued(), []);
  await one.b.stop();

  // Arcade unreachable: kept in host.db; a new process (nothing in memory) takes the queue up and posts it.
  const four = await spend(5);
  const down = broadcaster({ ...arc, url: "http://127.0.0.1:9" }, db, new Map(), new Set(["a"]));
  down.b.enqueue("a", Uint8Array.from(four.tx.toBinary()), Uint8Array.from(four.tx.toAtomicBEEF()));
  await until("not answered", () => (down.b.queued()[0]?.attempts ?? 0) >= 1 || undefined);
  await down.b.stop();
  assert.equal(db.broadcasts()[0]?.txid, four.tx.id("hex"));
  const back = broadcaster(arc, db, new Map(), new Set(["a"]));
  t.after(() => back.b.stop());
  back.b.start();
  await until("the queue taken up", () => back.admitted.some(([, , x]) => x === four.tx.id("hex")) || undefined);
  assert.deepEqual(back.admitted.find(([, , x]) => x === four.tx.id("hex")), ["a", "status", four.tx.id("hex"), "RECEIVED"], "its broadcaster known from the queue row");

  // Given up a day after it was queued.
  let clock = 1_000;
  const gone = broadcaster({ ...arc, url: "http://127.0.0.1:9" }, db, new Map(), new Set(["a"]), { now: () => clock, giveUpMs: 5_000 });
  t.after(() => gone.b.stop());
  const five = await spend(6);
  gone.b.enqueue("a", Uint8Array.from(five.tx.toBinary()));
  await until("tried", () => (gone.b.queued()[0]?.attempts ?? 0) >= 1 || undefined);
  clock += 5_000;
  db.retryBroadcast(five.tx.id("hex"), 0, "now");
  gone.b.enqueue("a", Uint8Array.from(five.tx.toBinary()));
  await until("given up", () => gone.b.queued().length === 0 || undefined);
});

test("arc: with a router — no broadcast route; a host with no Arcade drops a broadcast event; the status provider in the address book", async (t) => {
  const db = new HostDb(join(home(t), "host.db"));
  t.after(() => db.close());
  const arcade = await FakeArcade.start();
  t.after(() => arcade.close());
  const lines: string[] = [];
  const owner = PrivateKey.fromRandom().toPublicKey().toString();
  const router = new Router({ db, owner, walletFor: () => { throw new Error("none"); }, arc: { url: arcade.url, token: TOKEN, events: arcade.eventsUrl }, log: (s, l) => lines.push(`[${s}] ${l}`) });
  t.after(() => router.stop());
  assert.deepEqual(router.addressSeed().map((e) => e.address), ["fetch", "waker", "cron", "status"], "a new genesis names the status provider (#65): this host has an Arcade");
  const { beef } = await spend(7);
  const post = async (r: Router, path: string) => (await r.dispatch({ method: "POST", url: `http://127.0.0.1:1${path}`, headers: {}, body: beef })).status;
  assert.equal(await post(router, "/arc/v1/tx"), 404, "the broadcast route is gone (#65): a broadcast is an event");
  assert.equal(await post(router, "/arc/callback"), 401, "Arcade's webhook stays (the host token as bearer)");
  const none = new Router({ db, owner, walletFor: () => { throw new Error("none"); }, log: (s, l) => lines.push(`[${s}] ${l}`) });
  t.after(() => none.stop());
  assert.deepEqual(none.addressSeed().map((e) => e.address), ["fetch", "waker", "cron"], "no Arcade: no status provider");
  assert.equal(await post(none, "/arc/callback"), 404);
  none.providers.deliver("x", { message: { kind: "broadcast", tx: txCid("ab".repeat(32)) } as never, body: new Uint8Array(), transport: "event", address: "broadcast" });
  assert.ok(lines.some((l) => l === "[x] broadcast: this host has no Arcade (SKEIN_ARC_URL): dropped"));

  // A row from the status provider is written `$status` (the host's key); on a host with none it is left out.
  const me = PrivateKey.fromRandom().toPublicKey().toString();
  const handler = txCid("cd".repeat(32));
  const subs = [{ sender: "$status", box: "status", handler: "wallet" }];
  const programs = { wallet: handler };
  const withArc = resolveSystem({ ...router.genesisConfig({ handle: "w", domain: "localhost" }, me), owner }, programs, subs);
  const boxRows = (s: { dispatch: Array<{ transport: string; address: string; sender: unknown; program: unknown }> }) => s.dispatch.filter((r) => r.transport === "mailbox" && r.program !== "kernel").map((r) => [Buffer.from(r.sender as Uint8Array).toString("hex"), r.address]);
  assert.deepEqual(boxRows(withArc), [[router.providers.key("status"), "status"]]);
  const warned: string[] = [];
  const without = resolveSystem({ ...none.genesisConfig({ handle: "w", domain: "localhost" }, me), owner, warn: (l) => warned.push(l) }, programs, subs);
  assert.deepEqual(boxRows(without), []);
  assert.deepEqual(warned, ["a dispatch row from $status is left out: this host has no such provider"]);
  assert.throws(() => resolveSystem({ identity: me, owner, handle: "w", domain: "localhost" }, programs, [], { jobs: [] } as never), /`jobs` are gone \(#69\)/, "etc/config.json's jobs are refused");
});

test("arc: every instance holding the transaction gets each status — a proof as an event, the rest as the status provider's messages; the broadcaster, a sweep, then only the running; a redelivery writes nothing", async (t) => {
  const arcade = await FakeArcade.start();
  t.after(() => arcade.close());
  const db = new HostDb(join(home(t), "host.db"));
  t.after(() => db.close());
  const { tx, beef } = await spend(5);
  const X = tx.id("hex");
  const holding = new Map([["b", new Set([X])], ["c", new Set([X])]]);
  const running = new Set(["a", "b"]);
  const { b, admitted, asked } = broadcaster({ url: arcade.url, token: TOKEN, events: arcade.eventsUrl }, db, holding, running);
  t.after(() => b.stop());

  // `a` broadcasts it (the queue notes the broadcaster): Arcade's RECEIVED; the stream brings SEEN_ON_NETWORK.
  b.enqueue("a", Uint8Array.from(tx.toBinary()), beef);
  await until("posted", () => b.stats.routed === 1 || undefined);
  assert.deepEqual(asked.map(([h]) => h).sort(), ["b", "c", "d"], "the first status of a txid: every other enabled instance is read (c hydrated for it)");
  assert.deepEqual(admitted.map(([h, how, , s]) => [h, how, s]).sort(), [["a", "status", "RECEIVED"], ["b", "status", "RECEIVED"], ["c", "status", "RECEIVED"]]);
  admitted.length = 0;
  b.start();
  await until("subscribed", () => arcade.streams || undefined);
  arcade.emit(X, { txStatus: "SEEN_ON_NETWORK" });
  await until("routed", () => b.stats.routed === 2 || undefined);
  assert.deepEqual(admitted.map(([h, how, , s]) => [h, how, s]).sort(), [["a", "status", "SEEN_ON_NETWORK"], ["b", "status", "SEEN_ON_NETWORK"], ["c", "status", "SEEN_ON_NETWORK"]]);

  // A later holder (d, running now) is found at the next status; the others are not asked again.
  holding.set("d", new Set([X]));
  asked.length = 0;
  const bump = new MerklePath(103, [[{ offset: 0, hash: X, txid: true }]]).toHex();
  arcade.emit(X, { txStatus: "MINED", blockHash: "11".repeat(32), blockHeight: 103, merklePath: bump });
  await until("the MINED status", () => b.stats.routed === 3 || undefined);
  assert.deepEqual(asked.map(([h]) => h), ["d"], "only the running instance not yet known");
  assert.deepEqual(admitted.filter(([, , , s]) => s === "MINED").map(([h, how]) => [h, how]).sort(), [["a", "proof"], ["b", "proof"], ["c", "proof"], ["d", "proof"]], "MINED with its path: a proof event, unsigned");

  // Arcade's webhook: the host token only; the same MINED again writes nothing; a new status goes the same path.
  const hook = (auth: string, body: unknown) => b.callback({ authorization: auth }, new TextEncoder().encode(JSON.stringify(body)));
  assert.equal((await hook("Bearer wrong", arcade.webhookBody(X))).status, 401);
  assert.equal((await hook(`Bearer ${TOKEN}`, { txid: X })).status, 400);
  const n = admitted.length;
  assert.equal((await hook(`Bearer ${TOKEN}`, arcade.webhookBody(X))).status, 200);
  assert.equal(admitted.length, n, "a redelivered MINED: nothing admitted");
  assert.equal(b.stats.duplicates, 1);
  assert.equal((await hook(`Bearer ${TOKEN}`, { timestamp: "t", txid: X, txStatus: "IMMUTABLE", blockHash: "11".repeat(32), blockHeight: 103 })).status, 200);
  assert.deepEqual(admitted.slice(n).map(([h, how, , s]) => [h, how, s]).sort(), [["a", "status", "IMMUTABLE"], ["b", "status", "IMMUTABLE"], ["c", "status", "IMMUTABLE"], ["d", "status", "IMMUTABLE"]], "IMMUTABLE with no path: a status message");

  // A reorg: MINED in another block is a new status (its block hash differs).
  arcade.emit(X, { txStatus: "SEEN_ON_NETWORK" });
  await new Promise((r) => setTimeout(r, 100));
  arcade.emit(X, { txStatus: "MINED", blockHash: "22".repeat(32), blockHeight: 104, merklePath: bump });
  await until("the re-proof", () => admitted.filter(([, , , s]) => s === "MINED").length === 8 || undefined);
  assert.equal(admitted.filter(([, , , s]) => s === "SEEN_ON_NETWORK").length, 3, "SEEN_ON_NETWORK again after the reorg: a redelivery, dropped");
  assert.equal(b.stats.proofs, 8);
});

test("arc: a restart resumes the stream after the last event id taken (host.db): nothing missed, nothing twice", async (t) => {
  const arcade = await FakeArcade.start();
  t.after(() => arcade.close());
  const db = new HostDb(join(home(t), "host.db"));
  t.after(() => db.close());
  const arc = { url: arcade.url, token: TOKEN, events: arcade.eventsUrl };
  const { tx, beef } = await spend(6);
  const X = tx.id("hex");
  const holding = new Map([["a", new Set([X])]]);

  const one = broadcaster(arc, db, holding, new Set(["a"]));
  one.b.enqueue("a", Uint8Array.from(tx.toBinary()), beef);
  one.b.start();
  await until("subscribed", () => arcade.streams || undefined);
  assert.deepEqual(arcade.connects, [undefined], "the first connection: no id");
  arcade.emit(X, { txStatus: "SEEN_ON_NETWORK" });
  const id2 = arcade.emit(X, { txStatus: "SEEN_ON_MULTIPLE_NODES" });
  await until("three routed (RECEIVED, and two from the stream)", () => one.b.stats.routed === 3 || undefined);
  assert.equal(db.cursor(arcade.eventsUrl), id2, "the last id taken, in host.db");

  // A network blip: the same process reconnects with the id it holds.
  arcade.drop();
  await until("reconnected", () => arcade.connects.length === 2 || undefined);
  assert.equal(arcade.connects[1], id2);
  await one.b.stop();

  // Down: Arcade moves on. Up again (a new process: nothing in memory): resumed after id2.
  const id3 = arcade.emit(X, { txStatus: "MINED", blockHash: "33".repeat(32), blockHeight: 103, merklePath: new MerklePath(103, [[{ offset: 0, hash: X, txid: true }]]).toHex() });
  const two = broadcaster(arc, db, holding, new Set(["a"]));
  t.after(() => two.b.stop());
  two.b.start();
  await until("the missed status", () => two.admitted.length === 1 || undefined);
  assert.equal(arcade.connects[2], id2, "Last-Event-ID from host.db");
  assert.deepEqual(two.admitted, [["a", "proof", X, "MINED"]], "exactly the one missed while down");
  assert.equal(db.cursor(arcade.eventsUrl), id3);
  assert.ok(two.asked.some(([h, x]) => h === "a" && x === X), "a new process knows nothing: the holders are read again");
  assert.ok(txCid(X).toString().startsWith("bag"), "the read is of the transaction's CID");
});

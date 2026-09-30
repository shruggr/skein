// The host's broadcaster (#58, arc.ts) against a fake Arcade (fake-arcade.ts),
// without a kernel: the route (an Atomic BEEF posted as Extended Format under
// the host's token, Arcade's answer as is — 202, a duplicate's status, 400,
// 503 + Retry-After, unreachable → 503; GET passed through, 404 included; no
// Arcade → 503), the routing table (the asker, a sweep of every instance at a
// txid's first status, then the running ones only; every holder gets each
// status; a redelivery — stream or webhook — writes nothing), and the
// subscription's resume across a restart with Last-Event-ID from host.db.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MerklePath, P2PKH, PrivateKey, Transaction, UnlockingScript } from "@bsv/sdk";
import { arcadeBody, Broadcaster, hostArcConfig, type ArcConfig } from "./arc.ts";
import { FakeArcade } from "./fake-arcade.ts";
import { txCid } from "./feeds.ts";
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

test("arc: the route proxies to Arcade under the host's token and answers what Arcade answered", async (t) => {
  const arcade = await FakeArcade.start();
  t.after(() => arcade.close());
  const db = new HostDb(join(home(t), "host.db"));
  t.after(() => db.close());
  const lines: string[] = [];
  const router = new Router({ db, walletFor: () => { throw new Error("no instance here"); }, arc: { url: arcade.url, token: TOKEN, events: arcade.eventsUrl }, log: (s, l) => lines.push(`[${s}] ${l}`) });
  t.after(() => router.stop());
  await router.listen(0, "127.0.0.1");
  const o = router.origin();
  const call = async (method: string, path: string, body?: Uint8Array, from?: string) => {
    const r = await router.dispatch({ method, url: `${o}${path}`, headers: {}, body: body ?? new Uint8Array(), ...(from ? { from } : {}) });
    return { status: r.status, headers: r.headers, json: JSON.parse(new TextDecoder().decode(r.body)) as Record<string, unknown> };
  };
  assert.equal(router.arcRoute(), `${o}/arc`, "what a new genesis names as walletArc");

  const { tx, beef } = await spend(2);
  const txid = tx.id("hex");
  let r = await call("POST", "/arc/v1/tx", beef, "w1");
  assert.equal(r.status, 202);
  assert.deepEqual(r.json, { txid, status: 202, txStatus: "RECEIVED" });
  assert.deepEqual([...arcade.posts.at(-1)!], tx.toEF(), "Arcade received the transaction in Extended Format");
  const h = arcade.postHeaders.at(-1)!;
  assert.equal(h["x-callbacktoken"], TOKEN);
  assert.equal(h["x-fullstatusupdates"], "true");
  assert.equal(h["x-callbackurl"], undefined, "no webhook without a callback URL");
  assert.ok(lines.some((l) => l.startsWith(`[w1] broadcast ${txid.slice(0, 8)} → Arcade: HTTP 202 RECEIVED`)));

  arcade.emit(txid, { txStatus: "SEEN_ON_NETWORK" });
  r = await call("POST", "/arc/v1/tx", beef, "w1");
  assert.deepEqual([r.status, r.json.txStatus], [202, "SEEN_ON_NETWORK"], "a duplicate: its current status");
  r = await call("GET", `/arc/v1/tx/${txid}`);
  assert.deepEqual([r.status, r.json.txStatus], [200, "SEEN_ON_NETWORK"]);
  r = await call("GET", `/arc/v1/tx/${"ab".repeat(32)}`);
  assert.equal(r.status, 404, "Arcade never took it: its 404, as is");
  assert.equal((await call("GET", "/arc/v1/tx/nope")).status, 400);

  arcade.mode = "reject";
  r = await call("POST", "/arc/v1/tx", (await spend(3)).beef);
  assert.deepEqual([r.status, r.json.reason], [400, "rejected by the test"]);
  arcade.mode = "busy";
  r = await call("POST", "/arc/v1/tx", (await spend(4)).beef);
  assert.deepEqual([r.status, r.headers["retry-after"]], [503, "1"], "backpressure: Arcade's 503 and Retry-After");
  arcade.mode = "ok";

  // Arcade unreachable: a 503 with no txStatus (the wallet's transient failure).
  const down = new Router({ db, walletFor: () => { throw new Error("none"); }, arc: { url: "http://127.0.0.1:9", token: TOKEN, events: "http://127.0.0.1:9/events" }, feeds: { backoff: { min: 1000, max: 1000 } } });
  t.after(() => down.stop());
  const d = await down.dispatch({ method: "POST", url: "http://127.0.0.1:1/arc/v1/tx", headers: {}, body: beef });
  const dj = JSON.parse(new TextDecoder().decode(d.body)) as Record<string, unknown>;
  assert.deepEqual([d.status, dj.title, dj.txStatus], [503, "Arcade unreachable", undefined]);

  // A host without an Arcade: 503 to a wallet, 404 for the webhook.
  const none = new Router({ db, walletFor: () => { throw new Error("none"); } });
  t.after(() => none.stop());
  assert.equal((await none.dispatch({ method: "POST", url: "http://127.0.0.1:1/arc/v1/tx", headers: {}, body: beef })).status, 503);
  assert.equal((await none.dispatch({ method: "POST", url: "http://127.0.0.1:1/arc/callback", headers: {}, body: new Uint8Array() })).status, 404);
  assert.equal((await none.dispatch({ method: "POST", url: "http://127.0.0.1:1/callback/w1", headers: {}, body: new Uint8Array() })).status, 404, "the per-instance callback is gone");
});

/** A broadcaster over a fake Arcade with instances a..d: `holding` is who holds what, `running` who runs. */
function broadcaster(arc: ArcConfig, db: HostDb, holding: Map<string, Set<string>>, running: Set<string>) {
  const admitted: Array<[string, string, string, string]> = [];
  const asked: Array<[string, string]> = [];
  const b = new Broadcaster({
    arc, db, backoff: { min: 20, max: 100 },
    admit: async (h, box, ev) => { admitted.push([h, box, String(ev.txid), String(ev.txStatus)]); },
    instances: () => ({ all: ["a", "b", "c", "d"], running: [...running] }),
    holds: async (h, txid) => { asked.push([h, txid]); running.add(h); return holding.get(h)?.has(txid) ?? false; },
  });
  return { b, admitted, asked };
}

test("arc: every instance holding the transaction gets each status; the asker, a sweep, then only the running; a redelivery writes nothing", async (t) => {
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

  // `a` broadcasts it (the route notes the asker); the stream brings SEEN_ON_NETWORK.
  assert.equal((await b.submit(beef, "a")).status, 202);
  b.start();
  await until("subscribed", () => arcade.streams || undefined);
  arcade.emit(X, { txStatus: "SEEN_ON_NETWORK" });
  await until("routed", () => b.stats.routed === 1 || undefined);
  assert.deepEqual(asked.map(([h]) => h).sort(), ["b", "c", "d"], "the first status of a txid: every other enabled instance is read (c hydrated for it)");
  assert.deepEqual(admitted.map(([h, box, , s]) => [h, box, s]).sort(), [["a", "chain", "SEEN_ON_NETWORK"], ["b", "chain", "SEEN_ON_NETWORK"], ["c", "chain", "SEEN_ON_NETWORK"]]);

  // A later holder (d, running now) is found at the next status; the others are not asked again.
  holding.set("d", new Set([X]));
  asked.length = 0;
  const bump = new MerklePath(103, [[{ offset: 0, hash: X, txid: true }]]).toHex();
  arcade.emit(X, { txStatus: "MINED", blockHash: "11".repeat(32), blockHeight: 103, merklePath: bump });
  await until("the MINED status", () => b.stats.routed === 2 || undefined);
  assert.deepEqual(asked.map(([h]) => h), ["d"], "only the running instance not yet known");
  assert.deepEqual(admitted.filter(([, , , s]) => s === "MINED").map(([h]) => h).sort(), ["a", "b", "c", "d"]);

  // Arcade's webhook: the host token only; the same MINED again writes nothing; a new status goes the same path.
  const hook = (auth: string, body: unknown) => b.callback({ authorization: auth }, new TextEncoder().encode(JSON.stringify(body)));
  assert.equal((await hook("Bearer wrong", arcade.webhookBody(X))).status, 401);
  assert.equal((await hook(`Bearer ${TOKEN}`, { txid: X })).status, 400);
  const n = admitted.length;
  assert.equal((await hook(`Bearer ${TOKEN}`, arcade.webhookBody(X))).status, 200);
  assert.equal(admitted.length, n, "a redelivered MINED: nothing admitted");
  assert.equal(b.stats.duplicates, 1);
  assert.equal((await hook(`Bearer ${TOKEN}`, { timestamp: "t", txid: X, txStatus: "IMMUTABLE", blockHash: "11".repeat(32), blockHeight: 103 })).status, 200);
  assert.deepEqual(admitted.slice(n).map(([h, , , s]) => [h, s]).sort(), [["a", "IMMUTABLE"], ["b", "IMMUTABLE"], ["c", "IMMUTABLE"], ["d", "IMMUTABLE"]]);

  // A reorg: MINED in another block is a new status (its block hash differs).
  arcade.emit(X, { txStatus: "SEEN_ON_NETWORK" });
  await new Promise((r) => setTimeout(r, 100));
  arcade.emit(X, { txStatus: "MINED", blockHash: "22".repeat(32), blockHeight: 104, merklePath: bump });
  await until("the re-proof", () => admitted.filter(([, , , s]) => s === "MINED").length === 8 || undefined);
  assert.equal(admitted.filter(([, , , s]) => s === "SEEN_ON_NETWORK").length, 3, "SEEN_ON_NETWORK again after the reorg: a redelivery, dropped");
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
  await one.b.submit(beef, "a");
  one.b.start();
  await until("subscribed", () => arcade.streams || undefined);
  assert.deepEqual(arcade.connects, [undefined], "the first connection: no id");
  arcade.emit(X, { txStatus: "SEEN_ON_NETWORK" });
  const id2 = arcade.emit(X, { txStatus: "SEEN_ON_MULTIPLE_NODES" });
  await until("two routed", () => one.b.stats.routed === 2 || undefined);
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
  assert.deepEqual(two.admitted, [["a", "chain", X, "MINED"]], "exactly the one missed while down");
  assert.equal(db.cursor(arcade.eventsUrl), id3);
  assert.ok(two.asked.some(([h, x]) => h === "a" && x === X), "a new process knows nothing: the holders are read again");
  assert.ok(txCid(X).toString().startsWith("bag"), "the read is of the transaction's CID");
});

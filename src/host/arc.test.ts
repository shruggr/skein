// The host's broadcaster (#58, #65, arc.ts) against a fake Arcade
// (fake-arcade.ts), without a kernel: the durable queue (a broadcast event's
// Atomic BEEF posted as Extended Format under the host's token, never anything
// else; Arcade's answers by one table — RECEIVED, a duplicate's, an invalid
// transaction's REJECTED, our payload at fault an error and no status, not
// final yet or a 503 or no answer tried again with backoff, the queue taken up
// by a new process; given up a day on), the routing table (skein 0.9.0: only a
// proof — an event in box `chain` — and a REJECTED — the status provider's
// message — go in, to the broadcasters, a sweep of every instance at a txid's
// first routed status, then the running ones only; every other status is the
// host's; a redelivery, stream or webhook, writes nothing), the answers held
// on this host's broadcast (rule 10), and the subscription's resume across a restart with
// Last-Event-ID from host.db. With a router: no broadcast route any more, a
// host with no Arcade drops a broadcast event and names no status provider
// (kernel-zig/equiv/overlay.ts runs it all with a kernel).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Beef, MerklePath, P2PKH, PrivateKey, Transaction, UnlockingScript } from "@bsv/sdk";
import type { CID } from "multiformats/cid";
import { answerOf, arcadeBody, ARC_CODES, Broadcaster, hostArcConfig, type ArcConfig } from "./arc.ts";
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
  assert.equal(hostArcConfig({ SKEIN_ARC_URL: "off" }, h), undefined, "off: none");
  assert.equal(hostArcConfig({ SKEIN_NETWORK: "regtest" }, h), undefined, "regtest: no default");
  assert.equal(existsSync(join(h, "host.env")), false, "nothing written without an Arcade");
  assert.throws(() => hostArcConfig({ SKEIN_ARC_URL: "http://a" }, h), /SKEIN_ARC_TOKEN/, "a named Arcade needs its named token");
  writeFileSync(join(h, "host.env"), "SKEIN_ARC_URL=https://arcade.test/\nexport SKEIN_ARC_TOKEN='tok'\nSKEIN_ARC_EVENTS_URL=https://arcade.test:8082/events\nOTHER=1\n");
  assert.deepEqual(hostArcConfig({}, h), { url: "https://arcade.test", token: "tok", events: "https://arcade.test:8082/events" });
  assert.deepEqual(hostArcConfig({ SKEIN_ARC_TOKEN: "env", SKEIN_ARC_CALLBACK_URL: "https://me/arc/callback" }, h), { url: "https://arcade.test", token: "env", events: "https://arcade.test:8082/events", callbackUrl: "https://me/arc/callback" });

  const { tx, beef } = await spend(1);
  const b = arcadeBody(beef);
  assert.ok("bytes" in b);
  assert.equal(b.txid, tx.id("hex"));
  assert.deepEqual([...b.bytes], tx.toEF(), "the Atomic BEEF's subject, in Extended Format");
});

test("arc: no Extended Format, nothing to post — a raw transaction, an input with no source, a bundle that proves its subject", async () => {
  const { tx } = await spend(11);
  const X = tx.id("hex");
  assert.deepEqual(arcadeBody(Uint8Array.from(tx.toBinary())), { why: "the body is not a BEEF or an Atomic BEEF" }, "a raw transaction is never posted");
  // The subject alone in the bundle: its input's source is missing.
  const bare = new Beef();
  bare.mergeRawTx(tx.toBinary());
  const noSource = arcadeBody(Uint8Array.from(bare.toBinaryAtomic(X)));
  assert.equal(noSource.txid, X);
  assert.match((noSource as { why: string }).why, new RegExp(`^input 0 \\(${tx.inputs[0]!.sourceTXID ?? tx.inputs[0]!.sourceTransaction!.id("hex")}\\.0\\) has no source transaction in the bundle$`));
  // The subject proven in its own bundle: mined, not broadcastable.
  const mined = Transaction.fromAtomicBEEF(tx.toAtomicBEEF());
  mined.merklePath = new MerklePath(120, [[{ offset: 0, hash: X, txid: true }, { offset: 1, hash: "ab".repeat(32) }]]);
  const m = arcadeBody(Uint8Array.from(mined.toAtomicBEEF()));
  assert.deepEqual(m, { txid: X, mined: true, why: "the bundle proves this transaction (a merkle path at 120): it is mined, not broadcastable" });
});

test("arc: Arcade's answers by the one table — invalid, ours (467 differs by source), not final, retried; 2xx as given", () => {
  const cls = (http: number, v: Record<string, unknown> = {}) => answerOf(http, v).class;
  for (const c of [461, 462, 463, 464, 465, 466, 471, 472, 473, 474]) {
    const a = answerOf(400, { status: c, reason: "r" });
    assert.equal(a.class, "invalid", `${c}`);
    assert.deepEqual(a.status, { txStatus: "REJECTED", extraInfo: "r" });
  }
  for (const c of [460, 467, 468, 469, 475]) assert.equal(cls(400, { status: c }), "ours", `${c} at intake`);
  assert.equal(cls(400, { error: "failed to parse transaction" }), "ours", "400 with no ARC code: our request");
  assert.equal(cls(400, { status: 400 }), "ours", "400 whose status is the HTTP code: no ARC code");
  for (const h of [401, 403, 404]) assert.equal(cls(h), "ours", `${h}`);
  assert.equal(cls(400, { status: 476 }), "not-final");
  for (const h of [0, 408, 425, 429, 500, 503]) assert.equal(cls(h), "retry", `${h}`);
  assert.deepEqual(answerOf(202, { txStatus: "SEEN_ON_NETWORK", status: 202 }).status, { txStatus: "SEEN_ON_NETWORK", status: 202 }, "a 2xx: as given");
  assert.equal(answerOf(202, {}).status!.txStatus, "RECEIVED");
  assert.equal(cls(202, { txStatus: "REJECTED", status: 460 }), "ours", "a duplicate's REJECTED with our code: no verdict");
  assert.equal(cls(202, { txStatus: "REJECTED", status: 465 }), "status", "a duplicate's REJECTED for an invalid transaction: as given");
  assert.equal(ARC_CODES[467]!.stream, "invalid", "467 on the stream: the network's TX_INVALID, a verdict");
});

test("arc: unset, the network's Arcade (DEFAULT_ARC); its token made once into host.env (made if absent) and read after", (t) => {
  const h = home(t);
  const made: string[] = [];
  const a = hostArcConfig({ SKEIN_NETWORK: "test" }, h, { made: (f) => made.push(f) })!;
  assert.equal(a.url, "https://testnet.arcade.1sat.app");
  assert.match(a.token, /^[0-9a-f]{64}$/);
  assert.equal(a.events, undefined, "events: <url>/events (the broadcaster's default)");
  assert.equal(a.callbackUrl, undefined, "SSE only");
  assert.deepEqual(made, [join(h, "host.env")]);
  assert.equal(readFileSync(join(h, "host.env"), "utf8").match(/^SKEIN_ARC_TOKEN=(.*)$/m)?.[1], a.token);
  assert.equal((statSync(join(h, "host.env")).mode & 0o777), 0o600, "a new host.env is the operator's only");
  const b = hostArcConfig({ SKEIN_NETWORK: "test" }, h, { made: (f) => made.push(f) })!;
  assert.equal(b.token, a.token, "read back, not made again");
  assert.equal(made.length, 1);
  assert.equal(hostArcConfig({}, h)!.url, "https://arcade.1sat.app", "mainnet (the default network): its Arcade, the same token");
  // An existing host.env: the token appended, its lines kept; a network named in it is read.
  const g = home(t);
  writeFileSync(join(g, "host.env"), "SKEIN_NETWORK=test\nSKEIN_KEY_FILE=/k");
  const c = hostArcConfig({}, g)!;
  assert.equal(c.url, "https://testnet.arcade.1sat.app", "host.env's network");
  assert.match(readFileSync(join(g, "host.env"), "utf8"), new RegExp(`^SKEIN_NETWORK=test\nSKEIN_KEY_FILE=/k\n# .*\nSKEIN_ARC_TOKEN=${c.token}\n$`));
  assert.equal(hostArcConfig({ SKEIN_ARC_TOKEN: "env" }, g)!.token, "env", "the environment's token wins");
  assert.throws(() => hostArcConfig({ SKEIN_NETWORK: "test" }), /no SKEIN_HOME/);
});

/** A broadcaster over a fake Arcade with instances a..d: `holding` is who holds what, `running` who runs. */
function broadcaster(arc: ArcConfig, db: HostDb, holding: Map<string, Set<string>>, running: Set<string>, o: { now?: () => number; giveUpMs?: number } = {}) {
  /** What reached each instance: [handle, how ("proof" event in box chain | "status" message), txid, txStatus]. */
  const admitted: Array<[string, string, string, string]> = [];
  const asked: Array<[string, string]> = [];
  const lines: string[] = [];
  const b = new Broadcaster({
    arc, db, log: (s, l) => lines.push(`[${s}] ${l}`), backoff: { min: 20, max: 100 }, retry: { min: 20, max: 100 }, ...(o.now ? { now: o.now } : {}), ...(o.giveUpMs ? { giveUpMs: o.giveUpMs } : {}),
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
  return { b, admitted, asked, lines };
}

test("arc: the queue — a broadcast event posted under the host's token, Arcade's answer a status; no BEEF, nothing posted; invalid, REJECTED; not taken, tried again; a new process takes up the queue; given up", async (t) => {
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
  await until("posted and answered", () => db.hasStatus(X, "RECEIVED ") || undefined);
  assert.deepEqual([...arcade.posts.at(-1)!], tx.toEF(), "Arcade received the transaction in Extended Format (the BEEF's ancestry)");
  const h = arcade.postHeaders.at(-1)!;
  assert.equal(h["x-callbacktoken"], TOKEN);
  assert.equal(h["x-fullstatusupdates"], "true");
  assert.equal(h["x-callbackurl"], undefined, "no webhook without a callback URL");
  assert.equal(one.admitted.length, 0, "Arcade's 202 (RECEIVED) is the host's: recorded, into no instance (skein 0.9.0, rule 8)");
  assert.deepEqual(one.b.queued(), [], "answered: off the queue");

  // The same again (a kernel's start hands over what a thread still awaits): a duplicate, its current status.
  arcade.emit(X, { txStatus: "SEEN_ON_NETWORK" });
  one.b.enqueue("a", raw, beef);
  await until("the duplicate's status", () => db.hasStatus(X, "SEEN_ON_NETWORK ") || undefined);
  assert.equal(one.admitted.length, 0, "a duplicate's current status (SEEN_ON_NETWORK): the host's");
  // No BEEF in the event: nothing is posted, nothing queued, the instance told nothing; a host error on its log.
  const two = await spend(3);
  const before = arcade.posts.length;
  assert.equal(one.b.enqueue("a", Uint8Array.from(two.tx.toBinary())), undefined);
  assert.equal(arcade.posts.length, before, "no raw post");
  assert.deepEqual(one.b.queued(), []);
  assert.ok(one.lines.includes(`[a] ERROR broadcast ${two.tx.id("hex")}: not posted: the event carries no BEEF (a host defect: the chain app sends one)`));
  // An invalid transaction (ARC 465 in Arcade's 400): a REJECTED status, off the queue.
  arcade.mode = "reject";
  one.b.enqueue("a", Uint8Array.from(two.tx.toBinary()), two.beef);
  await until("the refusal", () => one.admitted.some(([, , x]) => x === two.tx.id("hex")) || undefined);
  assert.deepEqual([...arcade.posts.at(-1)!], two.tx.toEF());
  assert.deepEqual(one.admitted.find(([, , x]) => x === two.tx.id("hex")), ["a", "status", two.tx.id("hex"), "REJECTED"], "an invalid transaction is a REJECTED status");
  assert.deepEqual(one.b.queued(), []);
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
  await until("taken", () => db.hasStatus(three.tx.id("hex"), "RECEIVED ") || undefined);
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
  await until("the queue taken up", () => db.hasStatus(four.tx.id("hex"), "RECEIVED ") || undefined);
  assert.deepEqual(back.b.queued(), [], "taken: off the queue");

  // Given up a day after it was queued.
  let clock = 1_000;
  const gone = broadcaster({ ...arc, url: "http://127.0.0.1:9" }, db, new Map(), new Set(["a"]), { now: () => clock, giveUpMs: 5_000 });
  t.after(() => gone.b.stop());
  const five = await spend(6);
  gone.b.enqueue("a", Uint8Array.from(five.tx.toBinary()), five.beef);
  await until("tried", () => (gone.b.queued()[0]?.attempts ?? 0) >= 1 || undefined);
  clock += 5_000;
  db.retryBroadcast(five.tx.id("hex"), 0, "now");
  gone.b.enqueue("a", Uint8Array.from(five.tx.toBinary()), five.beef);
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

  // #143: a box's route names no sender — the status provider's box is a route like any other, on any host.
  const me = PrivateKey.fromRandom().toPublicKey().toString();
  const handler = txCid("cd".repeat(32));
  const specs = [{ address: "status", program: "watcher" }];
  const programs = { watcher: handler };
  const boxRows = (s: { dispatch: Array<{ transport: string; address: string; program?: unknown }> }) => s.dispatch.filter((r) => r.transport === "mailbox" && r.program !== "kernel").map((r) => r.address);
  assert.deepEqual(boxRows(resolveSystem({ ...router.genesisConfig({ handle: "w", domain: "localhost" }, me), root: [owner] }, programs, {}, undefined, specs)), ["status"]);
  assert.deepEqual(boxRows(resolveSystem({ ...none.genesisConfig({ handle: "w", domain: "localhost" }, me), root: [owner] }, programs, {}, undefined, specs)), ["status"]);
  assert.throws(() => resolveSystem({ ...router.genesisConfig({ handle: "w", domain: "localhost" }, me) }, programs, {}, undefined, [{ address: "status", sender: "$status", program: "watcher" }]), /`sender` is gone \(#143/);
  assert.throws(() => resolveSystem({ identity: me, root: [owner], handle: "w", domain: "localhost" }, programs, { jobs: [] } as never), /`jobs` are gone \(#69\)/, "etc/config.json's jobs are refused");
});

test("arc: into the instances holding the transaction go only proofs (events) and REJECTED (the status provider's messages); every other status is the host's; the broadcaster, a sweep, then only the running; a redelivery writes nothing", async (t) => {
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

  // `a` broadcasts it (the queue notes the broadcaster): Arcade's RECEIVED; the stream's intermediate statuses. All the host's.
  b.enqueue("a", Uint8Array.from(tx.toBinary()), beef);
  await until("posted", () => db.hasStatus(X, "RECEIVED ") || undefined);
  b.start();
  await until("subscribed", () => arcade.streams || undefined);
  for (const st of ["SENT_TO_NETWORK", "ACCEPTED_BY_NETWORK", "SEEN_ON_NETWORK", "SEEN_MULTIPLE_NODES", "DOUBLE_SPEND_ATTEMPTED"]) arcade.emit(X, { txStatus: st });
  await until("seen", () => db.hasStatus(X, "DOUBLE_SPEND_ATTEMPTED ") || undefined);
  assert.equal(admitted.length, 0, "RECEIVED, SENT/ACCEPTED/SEEN…, DOUBLE_SPEND_ATTEMPTED: into no instance (rule 8, 9)");
  assert.equal(asked.length, 0, "and no instance is read for them");
  assert.equal(b.stats.routed, 0);

  // The proof: every holder — the broadcaster, then a sweep of every other enabled instance (c hydrated for it).
  const bump = new MerklePath(103, [[{ offset: 0, hash: X, txid: true }]]).toHex();
  arcade.emit(X, { txStatus: "MINED", blockHash: "11".repeat(32), blockHeight: 103, merklePath: bump });
  await until("the MINED status", () => b.stats.routed === 1 || undefined);
  assert.deepEqual(asked.map(([h]) => h).sort(), ["b", "c", "d"], "the first routed status of a txid: every other enabled instance is read");
  assert.deepEqual(admitted.map(([h, how]) => [h, how]).sort(), [["a", "proof"], ["b", "proof"], ["c", "proof"]], "MINED with its path: a proof event, unsigned");

  // Arcade's webhook: the host token only; the same MINED again writes nothing; IMMUTABLE with no path is the host's.
  const hook = (auth: string, body: unknown) => b.callback({ authorization: auth }, new TextEncoder().encode(JSON.stringify(body)));
  assert.equal((await hook("Bearer wrong", arcade.webhookBody(X))).status, 401);
  assert.equal((await hook(`Bearer ${TOKEN}`, { txid: X })).status, 400);
  const n = admitted.length;
  assert.equal((await hook(`Bearer ${TOKEN}`, arcade.webhookBody(X))).status, 200);
  assert.equal(admitted.length, n, "a redelivered MINED: nothing admitted");
  assert.equal((await hook(`Bearer ${TOKEN}`, { timestamp: "t", txid: X, txStatus: "IMMUTABLE", blockHash: "11".repeat(32), blockHeight: 103 })).status, 200);
  assert.equal(admitted.length, n, "IMMUTABLE with no path: the host's");
  assert.ok(db.hasStatus(X, `IMMUTABLE ${"11".repeat(32)}`));

  // A reorg: MINED in another block is a new proof; a later holder (d, running now) is found, the others not asked again.
  holding.set("d", new Set([X]));
  asked.length = 0;
  arcade.emit(X, { txStatus: "SEEN_ON_NETWORK" });
  await new Promise((r) => setTimeout(r, 100));
  arcade.emit(X, { txStatus: "MINED", blockHash: "22".repeat(32), blockHeight: 104, merklePath: bump });
  await until("the re-proof", () => admitted.filter(([, how]) => how === "proof").length === 7 || undefined);
  assert.deepEqual(asked.map(([h]) => h), ["d"], "only the running instance not yet known");
  assert.equal(admitted.filter(([, how]) => how === "status").length, 0, "no status message for any of it");
  assert.equal(b.stats.proofs, 7);
});

test("arc: the answers held on this host's broadcast (rule 10) — released at Arcade's 2xx; at a REJECTED with its reason; at once for a status seen; dropped with the signal", async (t) => {
  const arcade = await FakeArcade.start();
  t.after(() => arcade.close());
  const db = new HostDb(join(home(t), "host.db"));
  t.after(() => db.close());
  const one = broadcaster({ url: arcade.url, token: TOKEN, events: arcade.eventsUrl }, db, new Map(), new Set(["a"]));
  t.after(() => one.b.stop());

  // Held before the broadcast is queued (the step's answer is read before its broadcast event is posted): released at the 2xx.
  const { tx, beef } = await spend(60);
  const X = tx.id("hex");
  let got: unknown;
  const held = one.b.taken(X).then((v) => { got = v; return v; });
  assert.equal(one.b.held(X), 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(got, undefined, "nothing posted: still held");
  one.b.enqueue("a", Uint8Array.from(tx.toBinary()), beef);
  assert.deepEqual(await held, { taken: true }, "Arcade took it (RECEIVED): released");
  assert.equal(one.b.held(X), 0);
  assert.equal(one.admitted.length, 0, "and the instance heard nothing");
  assert.deepEqual(await one.b.taken(X), { taken: true }, "a status already seen: at once");

  // Not taken yet (busy): held across the retries; released when it is taken.
  const busy = await spend(61);
  arcade.mode = "busy";
  const posts = arcade.posts.length;
  const h2 = one.b.taken(busy.tx.id("hex"));
  one.b.enqueue("a", Uint8Array.from(busy.tx.toBinary()), busy.beef);
  await until("tried again", () => arcade.posts.length >= posts + 2 || undefined);
  assert.equal(one.b.held(busy.tx.id("hex")), 1, "still held while Arcade does not take it");
  arcade.mode = "ok";
  assert.deepEqual(await h2, { taken: true });

  // Refused as invalid (ARC 465): released as a refusal with Arcade's reason; the instance hears REJECTED.
  const bad = await spend(62);
  arcade.mode = "reject";
  const h3 = one.b.taken(bad.tx.id("hex"));
  one.b.enqueue("a", Uint8Array.from(bad.tx.toBinary()), bad.beef);
  const r3 = await h3;
  assert.equal(r3?.taken, false);
  assert.ok(r3 && !r3.taken && r3.reason.length > 0, "Arcade's reason");
  assert.deepEqual(one.admitted.filter(([, , x]) => x === bad.tx.id("hex")), [["a", "status", bad.tx.id("hex"), "REJECTED"]]);
  assert.deepEqual(await one.b.taken(bad.tx.id("hex")), { taken: false, reason: "REJECTED" }, "a REJECTED already seen: at once");
  arcade.mode = "ok";

  // Our payload at fault (no verdict): not released; the requester's connection closing drops the hold.
  const ours = await spend(63);
  arcade.answer = { status: 400, body: { status: 460 } };
  const ac = new AbortController();
  const h4 = one.b.taken(ours.tx.id("hex"), ac.signal);
  one.b.enqueue("a", Uint8Array.from(ours.tx.toBinary()), ours.beef);
  await until("dropped from the queue", () => (one.b.queued().length === 0 && !one.b.busy()) || undefined);
  assert.equal(one.b.held(ours.tx.id("hex")), 1, "an \"ours\" refusal is no verdict: still held");
  ac.abort();
  assert.equal(await h4, undefined, "the signal: dropped");
  assert.equal(one.b.held(ours.tx.id("hex")), 0);
  arcade.answer = undefined;
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
  await until("three seen (RECEIVED, and two from the stream)", () => (db.hasStatus(X, "RECEIVED ") && db.hasStatus(X, "SEEN_ON_MULTIPLE_NODES ") && db.cursor(arcade.eventsUrl) === id2) || undefined);
  assert.equal(one.admitted.length, 0, "none of them goes into the instance");
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

test("arc: our payload or request at fault — an error on the instance's log, off the queue, no status; not final (476) kept and tried again", async (t) => {
  const arcade = await FakeArcade.start();
  t.after(() => arcade.close());
  const db = new HostDb(join(home(t), "host.db"));
  t.after(() => db.close());
  const one = broadcaster({ url: arcade.url, token: TOKEN, events: arcade.eventsUrl }, db, new Map(), new Set(["a"]));
  t.after(() => one.b.stop());
  let n = 20;
  for (const [status, body] of [[400, { error: "failed to parse transaction" }], [400, { status: 460, reason: "missing input source data: input 0" }], [400, { status: 467, reason: "SCRIPT_ERR_CGO_EXCEPTION" }], [400, { status: 468 }], [404, { title: "Not Found" }], [403, {}]] as const) {
    const { tx, beef } = await spend(n++);
    const X = tx.id("hex");
    arcade.answer = { status, body };
    const posts = arcade.posts.length;
    one.b.enqueue("a", Uint8Array.from(tx.toBinary()), beef);
    await until(`answered ${status} ${JSON.stringify(body)}`, () => (arcade.posts.length > posts && !one.b.busy() && one.b.queued().length === 0) || undefined);
    assert.ok(FakeArcade.isEF(arcade.posts.at(-1)!), "Extended Format posted");
    assert.equal(arcade.posts.length, posts + 1, `${status} ${JSON.stringify(body)}: posted once, not tried again`);
    assert.deepEqual(one.admitted.filter(([, , x]) => x === X), [], `${status} ${JSON.stringify(body)}: the instance is told nothing`);
    assert.ok(one.lines.some((l) => l.startsWith(`[a] ERROR broadcast ${X}: Arcade refused our request (`) && l.endsWith("a host defect, not a verdict on the transaction — dropped from the queue, its status unchanged")), `${status}: the error on the instance's log`);
  }
  // 476 (not final yet): no verdict, kept, tried again; once Arcade takes it, a status.
  const { tx, beef } = await spend(40);
  const X = tx.id("hex");
  arcade.answer = { status: 400, body: { status: 476, reason: "non-final" } };
  const posts = arcade.posts.length;
  one.b.enqueue("a", Uint8Array.from(tx.toBinary()), beef);
  await until("tried again", () => arcade.posts.length >= posts + 2 || undefined);
  assert.equal(one.b.queued()[0]?.txid, X, "still queued");
  assert.deepEqual(one.admitted.filter(([, , x]) => x === X), [], "no status while not final");
  arcade.answer = undefined;
  await until("taken", () => db.hasStatus(X, "RECEIVED ") || undefined);
  assert.deepEqual(one.admitted.filter(([, , x]) => x === X), [], "taken: RECEIVED, the host's");
});

test("arc: the stream's REJECTED — with our code (460) or 476 not routed; 467 (the network's TX_INVALID) and no code routed as given", async (t) => {
  const arcade = await FakeArcade.start();
  t.after(() => arcade.close());
  const db = new HostDb(join(home(t), "host.db"));
  t.after(() => db.close());
  const txs = await Promise.all([50, 51, 52, 53].map(spend));
  const ids = txs.map((x) => x.tx.id("hex"));
  const holding = new Map([["a", new Set(ids)]]);
  const one = broadcaster({ url: arcade.url, token: TOKEN, events: arcade.eventsUrl }, db, holding, new Set(["a"]));
  t.after(() => one.b.stop());
  for (const x of txs) one.b.enqueue("a", Uint8Array.from(x.tx.toBinary()), x.beef);
  await until("posted", () => ids.every((x) => db.hasStatus(x, "RECEIVED ")) || undefined);
  assert.equal(one.admitted.length, 0);
  one.b.start();
  await until("subscribed", () => arcade.streams || undefined);
  arcade.emit(ids[0]!, { txStatus: "REJECTED", status: 460, extraInfo: "missing input source data: input 0" });
  arcade.emit(ids[1]!, { txStatus: "REJECTED", status: 476, extraInfo: "non-final" });
  arcade.emit(ids[2]!, { txStatus: "REJECTED", status: 467, extraInfo: "TX_INVALID" });
  arcade.emit(ids[3]!, { txStatus: "REJECTED", extraInfo: "PROCESSING" });
  await until("two routed", () => one.admitted.length === 2 || undefined);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(one.admitted.map(([h, how, x, s]) => [h, how, ids.indexOf(x), s]).sort(), [["a", "status", 2, "REJECTED"], ["a", "status", 3, "REJECTED"]], "467 and no code: REJECTED as given");
  assert.ok(one.lines.some((l) => l.startsWith(`[a] ERROR arcade stream: ${ids[0]!.slice(0, 8)} REJECTED with ARC 460 (not extended format)`) && l.endsWith("not routed")), "460: our payload, an error, not routed");
  assert.ok(one.lines.some((l) => l === `[a] arcade stream: ${ids[1]!.slice(0, 8)} REJECTED with ARC 476 (not final): non-final: not final yet, no verdict — not routed`), "476: logged, not routed");
});

test("arc: a stream frame's answer (Router.heldAnswer, rule 10) — one carrying a signed transaction held until this host's broadcast is taken; a refusal when Arcade answers invalid; one carrying none at once", async (t) => {
  const db = new HostDb(join(home(t), "host.db"));
  t.after(() => db.close());
  const arcade = await FakeArcade.start();
  t.after(() => arcade.close());
  const owner = PrivateKey.fromRandom().toPublicKey().toString();
  const router = new Router({ db, owner, walletFor: () => { throw new Error("none"); }, arc: { url: arcade.url, token: TOKEN, events: arcade.eventsUrl }, log: () => {} });
  t.after(() => router.stop());
  const { encode, decode } = await import("@ipld/dag-cbor");

  // The instance's one-step answer (a stub): {ok, tx, txid, beef}; its broadcast event reaches the broadcaster after.
  const { tx, beef } = await spend(70);
  const raw = Uint8Array.from(tx.toBinary());
  const reply = encode({ ok: true, tx: raw, txid: tx.id("hex"), beef });
  let out: Uint8Array | undefined;
  const p = router.heldAnswer("x", reply).then((b) => { out = b; });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(out, undefined, "held: this host has not broadcast it yet");
  router.arc!.enqueue("x", raw, beef);
  await p;
  assert.deepEqual(out, reply, "taken by Arcade: the answer as the instance gave it");

  // Arcade refuses it as invalid: the requester's answer is the refusal, Arcade's reason as its detail.
  const bad = await spend(71);
  arcade.mode = "reject";
  const q = router.heldAnswer("x", encode({ ok: true, tx: Uint8Array.from(bad.tx.toBinary()), txid: bad.tx.id("hex"), beef: bad.beef }));
  router.arc!.enqueue("x", Uint8Array.from(bad.tx.toBinary()), bad.beef);
  assert.deepEqual(decode(await q), { ok: false, reason: "rejected", detail: "fee is too low" });
  arcade.mode = "ok";

  // A refusal (no signed transaction: nothing broadcast): at once.
  const refusal = encode({ ok: false, reason: "pool_spent", beef: bad.beef });
  assert.deepEqual(await router.heldAnswer("x", refusal), refusal);
  assert.deepEqual(await router.heldAnswer("x", encode({ kind: "error", message: "m" })), encode({ kind: "error", message: "m" }), "an answer that is not a map with tx: at once");
});

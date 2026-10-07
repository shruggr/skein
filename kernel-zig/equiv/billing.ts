// Billing (#130) end to end on a local host (src/host/testhost.ts), the Zig
// kernel and the wallet program, over a regtest chain from a fake SSE header
// feed and a fake Arcade (as equiv/wallet.ts):
//
//   - two skeins from the default image (#89: the wallet in it since #130/#116,
//     and the funding row /wallet/fund), each claimed by the owner's signed
//     claim and given the chain app (shruggr/skein-chain, wallet.ts's pin);
//   - alice: the owner grants the host (`skein host`: the host row, the
//     host's key from /.well-known/skein-host, a tiny X); the host ticks her
//     at once (billing starts, its free allowance her allocation); a funding
//     delivered to the host (POST /fund/alice) is handed in on her funding
//     row (the door's `beef` filter, the wallet internalizes);
//   - usage (requests: each an entry and a front-door step, its fuel at the
//     row's rate) consumes the allocation: the kernel's pay step pays the host
//     X — a `payment` event the host keeps and broadcasts, its output to the
//     host's BRC-29 key, its other output the checkpoint (the state record's
//     CID, recomputed here by replaying her log to that entry) — again and
//     again, then all the wallet has (less than X), then nothing: asleep;
//   - asleep: a request is 402, a tick is not sent, an owner's `head` message
//     for `billing` and a forged tick are not taken; a second funding through
//     the host wakes her (the pay step on the new funds); requests are served;
//   - bob: no host row — nothing billed, no billing head, served as before; an
//     app (programs/test/app-demo) emitting `payment` is refused;
//   - both stores replay to themselves exactly (equiv/replays.ts), the store
//     measurements at the ticks served from the source.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/billing.ts

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KeyDeriver, MerklePath, P2PKH, PrivateKey, ProtoWallet, Transaction, UnlockingScript } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { planHost } from "../../src/client/admin.ts";
import { RawBox, signClaim } from "../../src/client/raw.ts";
import { FakeArcade } from "../../src/host/fake-arcade.ts";
import { MESSAGE_KEY_ID, MESSAGE_PROTOCOL } from "../../src/host/providers.ts";
import type { SignedClaim } from "../../src/host/router.ts";
import { testHost, until } from "../../src/host/testhost.ts";
import { encode } from "../../src/runtime/cid.ts";
import { openStoreFile } from "../../src/runtime/index-store.ts";
import { installApp, ownerCli, sendPlan } from "../../src/testapps.ts";
import { stateOf, type BillingConfig } from "../../src/host/billing.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CHAIN_REPO = "https://github.com/shruggr/skein-chain";
const CHAIN_REV = process.env.SKEIN_CHAIN_REV ?? "01e68b4f814d1293016ff5002782af48a439bb43";
const report: Record<string, unknown> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };

// ---------------------------------------------------------------- regtest (as wallet.ts)

const sha256d = (b: Uint8Array) => createHash("sha256").update(createHash("sha256").update(b).digest()).digest();
const internal = (displayHex: string) => Buffer.from(displayHex, "hex").reverse();
const REGTEST_GENESIS = Buffer.from("0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4adae5494dffff7f2002000000", "hex");
const TARGET = 0x7fffffn << BigInt(8 * (0x20 - 3));
function mine(prev: Uint8Array, merkleRoot: Uint8Array, time: number): Uint8Array {
  const h = Buffer.alloc(80);
  h.writeInt32LE(1, 0);
  Buffer.from(prev).copy(h, 4);
  Buffer.from(merkleRoot).copy(h, 36);
  h.writeUInt32LE(time, 68);
  h.writeUInt32LE(0x207fffff, 72);
  for (let nonce = 0; ; nonce++) {
    h.writeUInt32LE(nonce, 76);
    if (BigInt("0x" + Buffer.from(sha256d(h)).reverse().toString("hex")) <= TARGET) return new Uint8Array(h);
  }
}

const arcade = await FakeArcade.start();
const sse: ServerResponse[] = [];
const sseServer = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": headers\n\n"); sse.push(res); });
await new Promise<void>((r) => sseServer.listen(0, "127.0.0.1", r));
const SSE_URL = `http://127.0.0.1:${(sseServer.address() as { port: number }).port}/headers`;
let sseId = 0;
const feedHeader = async (raw: Uint8Array) => {
  for (let i = 0; !sse.length && i < 400; i++) await sleep(25);
  for (const s of sse) s.write(`id: ${++sseId}\ndata: ${Buffer.from(raw).toString("hex")}\n\n`);
};

// The host's terms, tiny. A request's bytes served are what costs here (the host's amount, on its tick:
// it ticks early when they would take the tally to the allocation); fuel is cheap, so a pay step
// costs far less than X.
const BILLING: BillingConfig = { x: 150, rates: { fuel: 100, storage: 1, served: 100_000, fetch: 1, authfetch: 1, publish: 1 }, allowance: 40, tickMs: 3_600_000, graceMs: 1 };
const ownerKey = new PrivateKey("2222", 16);
const ownerId = ownerKey.toPublicKey().toString();
const afters: Array<() => unknown> = [];
const h = await testHost({ after: (f) => afters.push(f) }, {
  ownerKey, arc: { url: arcade.url, token: "the-host-arcade-token", events: arcade.eventsUrl }, arcRetry: { min: 300, max: 1000 },
  genesis: { defaults: { walletNetwork: "regtest", walletFeeRate: "100" }, feeds: [{ kind: "headers", url: SSE_URL }] },
  billing: BILLING,
});
const owner = h.owner;

type Billing = NonNullable<ReturnType<typeof stateOf>>;
/** The kernel's billing state, read as the host reads it (the head and its record). */
async function billingOf(handle: string): Promise<Billing | undefined> {
  const k = (await h.router.hydrate(handle)).kernel;
  const root = await k.call("head", "billing") as CID | null;
  return root ? stateOf(await k.store.get(root)) : undefined;
}
/** A request no row takes (a 404 from the front door, or 402 at the gate): an entry and a step. */
async function poke(handle: string): Promise<number> {
  const r = await fetch(`${h.base}/@${handle}/nothing-here`);
  await r.arrayBuffer();
  await h.router.settled();
  return r.status;
}

// The owner's coins, mined at 101: two outputs, one for each funding.
const coin = new Transaction();
coin.addInput({ sourceTXID: "11".repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex("51"), sequence: 0xffffffff });
coin.addOutput({ lockingScript: new P2PKH().lock(ownerKey.toPublicKey().toHash()), satoshis: 20_000 });
coin.addOutput({ lockingScript: new P2PKH().lock(ownerKey.toPublicKey().toHash()), satoshis: 20_000 });
const coinTxid = coin.id("hex");
coin.merklePath = new MerklePath(101, [[{ offset: 0, hash: coinTxid, txid: true }]]);

/** A BRC-29 payment from the owner to `to` (its identity), spending the coin's output `vout`: the Atomic BEEF and the outputs header. */
async function funding(to: string, vout: number, sats: number, tag: string) {
  const prefix = Buffer.from(`${tag}-prefix`).toString("base64"), suffix = Buffer.from(`${tag}-suffix`).toString("base64");
  const key = new KeyDeriver(ownerKey).derivePublicKey([2, "3241645161d8"], `${prefix} ${suffix}`, to, false);
  const tx = new Transaction();
  tx.addInput({ sourceTransaction: coin, sourceOutputIndex: vout, unlockingScriptTemplate: new P2PKH().unlock(ownerKey), sequence: 0xffffffff });
  tx.addOutput({ lockingScript: new P2PKH().lock(key.toHash()), satoshis: sats });
  await tx.sign();
  const outputs = JSON.stringify([{ outputIndex: 0, protocol: "wallet payment", paymentRemittance: { derivationPrefix: prefix, derivationSuffix: suffix, senderIdentityKey: ownerId } }]);
  return { beef: new Uint8Array(tx.toAtomicBEEF()), outputs, txid: tx.id("hex") };
}
/** The funding delivered to the host (#130 decided 7): POST /fund/<handle>. */
async function fundAtHost(handle: string, f: { beef: Uint8Array; outputs: string }) {
  const r = await fetch(`${h.base}/fund/${handle}`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-skein-outputs": f.outputs }, body: Buffer.from(f.beef) });
  const text = await r.text();
  await h.router.settled();
  return { status: r.status, text };
}

let aliceDb = "", bobDb = "";
try {
  await h.router.start();
  const hostTerms = await (await fetch(`${h.base}/.well-known/skein-host`)).json() as { billing?: { key: string; x: number; rates: Record<string, number>; allowance: number } };
  report.published = !!hostTerms.billing && hostTerms.billing.key === h.router.providers.key("billing") && hostTerms.billing.x === BILLING.x;

  // Two skeins from the default image, each claimed by the owner's own signed claim (#127).
  const alice = (await h.router.createInstance("alice", ownerId, { claim: await signClaim(owner) as SignedClaim })).identity;
  const bob = (await h.router.createInstance("bob", ownerId, { claim: await signClaim(owner) as SignedClaim })).identity;
  aliceDb = h.db.get("alice")!.store;
  bobDb = h.db.get("bob")!.store;
  const g = await (await h.router.hydrate("alice")).kernel.genesis() as { programs: Record<string, CID>; dispatch: Array<{ address: string; fn?: string; filter?: string }> };
  report.image = { wallet: !!g.programs.wallet, fundRow: g.dispatch.some((r) => r.address === "/wallet/fund" && r.fn === "fund" && Array.isArray((r as { filters?: unknown }).filters) && ((r as { filters: string[] }).filters).includes("kernel.beef")) };

  // The chain app in both (the door's `beef` filter and the wallet's SPV read its headers).
  const chainDir = process.env.SKEIN_CHAIN_DIR ?? (() => {
    const dir = join(h.home, "skein-chain");
    for (const args of [["clone", "-q", CHAIN_REPO, dir], ["-C", dir, "checkout", "-q", CHAIN_REV]]) {
      const r = spawnSync("git", args, { stdio: ["ignore", "ignore", "inherit"] });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: exit ${r.status}`);
    }
    return dir;
  })();
  for (const inst of ["alice", "bob"]) {
    const { code, err } = await ownerCli({ home: h.home, port: h.router.port!, owner, settled: () => h.router.settled() }, ["install", chainDir, "--instance", inst]);
    if (code !== 0) throw new Error(`install skein-chain into ${inst}: ${err.join(" ")}`);
  }
  const headers: Uint8Array[] = [];
  let prev: Uint8Array = sha256d(REGTEST_GENESIS);
  for (let n = 1; n <= 102; n++) {
    headers.push(mine(prev, n === 101 ? internal(coinTxid) : sha256d(Buffer.from(`filler ${n}`)), 1_790_000_000 + n * 600));
    prev = sha256d(headers.at(-1)!);
  }
  for (const raw of headers) await feedHeader(raw);
  await sleep(500);
  await h.router.settled();

  // No host row yet: nothing billed.
  report.beforeTerms = { billing: (await billingOf("alice")) === undefined, open: h.router.closed("alice") === undefined };

  // The owner funds alice through the host, before granting it: the funding row takes it as any time (#135: the host hands it in signed, with its billing key).
  const f1 = await funding(alice, 0, 700, "one");
  // Until her chain app has taken header 101 (the door checks the BUMP against it: before, a refusal).
  const r1 = await until("the funding taken", async () => { const r = await fundAtHost("alice", f1); return r.status === 200 ? r : (await sleep(250), undefined); }, 60_000);
  report.funded = [r1.status, JSON.parse(r1.text).txid === f1.txid];
  // #143: the funding route's one filter is kernel.beef — the same funding sent to it directly, unsigned, is taken too (the payment validates itself; already internalized, nothing new).
  report.fundDirect = (await fetch(`${h.base}/@alice/wallet/fund`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-bsv-skein-outputs": f1.outputs }, body: Buffer.from(f1.beef) })).status;

  // The owner grants the host (#130 decided 1): the host row, with the terms the host publishes.
  await sendPlan({ port: h.router.port!, owner, settled: () => h.router.settled() }, "alice", planHost(alice, "add", { key: hostTerms.billing!.key, x: BILLING.x, rates: BILLING.rates }));
  const started = await until("billing starts (the host's first tick)", async () => { await h.router.settled(); return await billingOf("alice"); }, 30_000);
  report.started = { host: started.host === h.router.providers.key("billing"), allowance: Number(started.allowance), tally0: started.tally >= 0n, ticks: started.ticks, bytes: started.bytes > 0 };

  // Usage until the allocation is consumed and paid for, then until it sleeps.
  const kernelLines = () => h.lines.filter((l) => l.startsWith("[alice]"));
  let pokes = 0;
  const paidOnce = await until("the first payment", async () => {
    pokes++;
    if ((await poke("alice")) === 402) throw new Error("asleep before any payment");
    const b = await billingOf("alice");
    return b && b.payments >= 1 ? b : undefined;
  }, 120_000);
  report.firstPayment = { pokes, paid: Number(paidOnce.paid), x: BILLING.x, under: paidOnce.tally < (paidOnce.allowance + paidOnce.paid) * 1_000_000_000n };
  const pays1 = h.db.billingPayments("alice");
  const p1 = pays1[0];
  report.hostTook = { n: pays1.length, amount: p1?.amount, ours: p1?.ours, checkpoint: !!p1?.checkpoint };
  // The payment transaction: its output pays the host, its other output commits the checkpoint, Arcade has it.
  if (p1) {
    const beef = (h.db.db.prepare("SELECT beef FROM billing_payments WHERE txid = ?").get(p1.txid) as { beef: Uint8Array }).beef;
    const tx = Transaction.fromAtomicBEEF([...beef]);
    const cp = tx.outputs.find((o) => o.satoshis === 0)!;
    const script = cp.lockingScript.toBinary();
    const cid = CID.decode(Uint8Array.from(script.slice(3)));
    report.checkpoint = {
      opReturn: script[0] === 0 && script[1] === 0x6a, sameCid: cid.toString() === p1.checkpoint,
      broadcast: await until("the payment at Arcade", async () => { await h.router.settled(); return arcade.posts.some((x) => FakeArcade.txOf(x).id("hex") === p1.txid) ? true : undefined; }, 30_000),
    };
    // The CID is the state record of her log up to the entry before the trigger: recomputed from her log alone.
    const v = openStoreFile(aliceDb, { readOnly: true });
    try {
      const rec = await v.get(cid).catch(() => undefined) as { kind?: string; cursor?: number; log?: CID } | undefined;
      report.checkpoint = { ...report.checkpoint as object, stored: rec?.kind === "skein-state", cursorEntry: rec ? (await v.get(rec.log!) as { n: number }).n === rec.cursor! - 1 : "not stored (a host that had admitted ahead)" };
    } finally { await v.close(); }
  }

  // Drain: the wallet pays X while it can, then what it has, then nothing — asleep.
  const asleep = await until("asleep", async () => {
    pokes++;
    const s = await poke("alice");
    if (s === 402) return await billingOf("alice");
    return undefined;
  }, 240_000);
  const pays = h.db.billingPayments("alice");
  report.drained = {
    asleep: asleep.asleep, overspent: asleep.tally >= (asleep.allowance + asleep.paid) * 1_000_000_000n,
    paidSum: pays.reduce((n, p) => n + p.amount, 0) === Number(asleep.paid), payments: asleep.payments === pays.length,
    fullX: pays.filter((p) => p.amount === BILLING.x).length, partial: pays.some((p) => p.amount < BILLING.x), allOurs: pays.every((p) => p.ours),
  };
  report.hostDb = { asleepSince: h.db.billing("alice")?.asleep_since !== null };
  // The gate: a request 402, no tick, the reclaim bookkeeping lists her past the grace (nothing deleted here).
  const gate = await fetch(`${h.base}/@alice/nothing-here`);
  report.gate = { status: gate.status, code: (await gate.json() as { code: string }).code, tick: await h.router.billingTick("alice") === undefined, reclaimable: h.db.reclaimable(Date.now() + 10, BILLING.graceMs).some((r) => r.instance === "alice") };
  const frozen = (await billingOf("alice"))!.tally;

  // The owner too is held at the gate: an admin message is 402.
  const held = await sendPlan({ port: h.router.port!, owner, settled: () => h.router.settled() }, "alice", planHost(alice, "add", { key: hostTerms.billing!.key, x: BILLING.x, rates: BILLING.rates })).then(() => 200, (e: Error) => /402/.test(e.message) ? 402 : 0);
  report.ownerHeld = held;

  // The second funding, delivered to the host: past the gate; the pay step fires on it; she is awake.
  const f2 = await funding(alice, 1, 900, "two");
  const r2 = await fundAtHost("alice", f2);
  const awake = await until("awake again", async () => { await h.router.settled(); const b = await billingOf("alice"); return b && !b.asleep ? b : undefined; }, 60_000);
  report.woke = { funded: r2.status, frozenWhileAsleep: awake.tally >= frozen, paidMore: awake.paid > asleep.paid, open: h.router.closed("alice") === undefined, served: await poke("alice") };
  report.hostDbAwake = h.db.billing("alice")?.asleep_since === null;

  // Not the owner's to touch: an owner's `head` message for `billing` is refused (the kernel's own).
  const before = await (await h.router.hydrate("alice")).kernel.call("head", "billing") as CID;
  await sendPlan({ port: h.router.port!, owner, settled: () => h.router.settled() }, "alice", { prompt: [], recipient: alice, messages: [{ box: "head", body: { name: "billing", tree: before } }] });
  report.headRefused = kernelLines().some((l) => /kernel head refused: the head billing is the kernel's own/.test(l));

  // A tick now: storage for the time since the last, the host's amounts (the bytes it served), the period's log record kept.
  const t0 = (await billingOf("alice"))!;
  await h.router.billingTick("alice");
  await h.router.settled();
  const t1 = (await billingOf("alice"))!;
  const ticks = h.db.billingTicks("alice");
  const last = ticks.at(-1)!;
  const rec = dagCbor.decode(last.record) as { kind: string; lines: Array<{ bytes: number }> };
  report.tick = { counted: t1.ticks === t0.ticks + 1, logCid: encode(rec).cid.toString() === last.log, kind: rec.kind, lines: rec.lines.length > 0, tallied: t1.tally > t0.tally };

  // A tick signed by another key: not the host row's `host` (#143: one route per box, no sender — the tick checks its key) — refused.
  const stranger = new PrivateKey("7777", 16);
  const body = { kind: "tick", at: Date.now(), allowance: 1_000_000, fuel: 0, served: 0 };
  const bodyBytes = dagCbor.encode(body);
  const unsigned = { kind: "mail", op: "put", sender: Uint8Array.from(Buffer.from(stranger.toPublicKey().toString(), "hex")), recipient: Uint8Array.from(Buffer.from(alice, "hex")), box: "billing", body: encode(body).cid, nonce: Uint8Array.from(Buffer.alloc(16, 7)) };
  const { signature } = await new ProtoWallet(stranger).createSignature({ protocolID: MESSAGE_PROTOCOL, keyID: MESSAGE_KEY_ID, counterparty: "anyone", data: [...dagCbor.encode(unsigned)] });
  await h.router.appendLocal("alice", { kind: "message", message: { ...unsigned, signature: Uint8Array.from(signature) }, body: bodyBytes });
  await h.router.settled();
  report.strangerTick = { refused: kernelLines().some((l) => /kernel tick refused: the host is the first tick row's key/.test(l)), unchanged: (await billingOf("alice"))!.host === t1.host };

  // bob: no host row — not billed, served as before; an app emitting `payment` is refused.
  for (let i = 0; i < 5; i++) await poke("bob");
  report.bob = { billing: (await billingOf("bob")) === undefined, served: await poke("bob"), hostDb: h.db.billing("bob") === undefined };
  await installApp({ home: h.home, port: h.router.port!, owner, settled: () => h.router.settled() }, "bob", join(here, "../../programs/test/app-demo"));
  await new RawBox(owner, `${h.base}/@bob`).send(bob, "app-demo", { kind: "app-demo-event", event: "payment", amount: 1 });
  await h.router.settled();
  report.appPayment = h.lines.some((l) => l.startsWith("[bob]") && /emit: payment: only the kernel's pay step emits it/.test(l));

  report.ok = true;
} catch (e) {
  report.error = (e as Error).stack ?? String(e);
}
await h.router.settled().catch(() => {});
const [removeHome, ...rest] = afters;
for (const f of rest.reverse()) await f();
for (const s of sse) s.end();
sseServer.close();
await arcade.close();

const eq = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
check(report.ok === true, `the scenario ran${report.error ? `: ${report.error}` : ""}`);
check(report.published === true, "the host publishes its terms at /.well-known/skein-host (its billing key, X, the rates)");
check(eq(report.image, { wallet: true, fundRow: true }), `the default image carries the wallet and the funding route /wallet/fund (#143: kernel.beef — the payment validates itself) (${JSON.stringify(report.image)})`);
check(eq(report.beforeTerms, { billing: true, open: true }), "no host row: no billing state, the host forwards as usual");
check(report.fundDirect === 200, `#143: the funding route directly, unsigned: taken (kernel.beef only; the payment validates itself) (${String(report.fundDirect)})`);
check(eq(report.funded, [200, true]), `a funding delivered to the host (POST /fund/alice) is handed in on the funding row and internalized (${JSON.stringify(report.funded)})`);
const st = (report.started ?? {}) as Record<string, unknown>;
check(st.host === true && st.allowance === BILLING.allowance && st.ticks === 1 && st.bytes === true, `the owner's host row: the host ticks at once, billing starts — the host's key, its allowance the allocation, the store measured (${JSON.stringify(st)})`);
const fp = (report.firstPayment ?? {}) as Record<string, unknown>;
check(fp.paid === BILLING.x && fp.under === true, `usage reaches the allocation: the kernel's pay step pays X at once; the allocation is ahead of the tally again (${JSON.stringify(fp)})`);
check(eq(report.hostTook, { n: 1, amount: BILLING.x, ours: true, checkpoint: true }), `the host takes the payment event: kept, its output the host's BRC-29 key (${JSON.stringify(report.hostTook)})`);
const cp = (report.checkpoint ?? {}) as Record<string, unknown>;
check(cp.opReturn === true && cp.sameCid === true && cp.broadcast === true, `the payment's other output is OP_FALSE OP_RETURN <the state record CID>; Arcade has it (${JSON.stringify(cp)})`);
check(cp.stored === true ? cp.cursorEntry === true : typeof cp.cursorEntry === "string", `the checkpoint names her state as it stood after the entry before the trigger (${JSON.stringify(cp)})`);
const dr = (report.drained ?? {}) as Record<string, unknown>;
check(dr.asleep === true && dr.overspent === true && dr.paidSum === true && dr.payments === true && (dr.fullX as number) >= 1 && dr.partial === true && dr.allOurs === true, `drained: X while it could, then all it had (less than X), then nothing — asleep, consumed ≥ allocation (${JSON.stringify(dr)})`);
check(eq(report.hostDb, { asleepSince: true }), "the host records when it went asleep (the grace counts from it)");
check(eq(report.gate, { status: 402, code: "ERR_PAYMENT_REQUIRED", tick: true, reclaimable: true }), `asleep: a request is 402, no tick is sent, past the grace it is reclaimable (nothing deleted) (${JSON.stringify(report.gate)})`);
check(report.ownerHeld === 402, `asleep, the owner's messages are held at the gate too: 402 (${report.ownerHeld})`);
check(report.headRefused === true, "the owner's `head` message for `billing` is refused: the kernel's own");
const wk = (report.woke ?? {}) as Record<string, unknown>;
check(wk.funded === 200 && wk.frozenWhileAsleep === true && wk.paidMore === true && wk.open === true && wk.served === 404, `a second funding through the host: past the gate, the pay step fires on it, she is awake and served (${JSON.stringify(wk)})`);
check(report.hostDbAwake === true, "awake: host.db clears the asleep time");
check(eq(report.tick, { counted: true, logCid: true, kind: "host-log", lines: true, tallied: true }), `a tick: storage and the host's amounts on the tally, the period's log record kept, its CID the tick's (${JSON.stringify(report.tick)})`);
check(eq(report.strangerTick, { refused: true, unchanged: true }), `a tick from a key that is not the host row's (the first tick row) is refused (${JSON.stringify(report.strangerTick)})`);
check(eq(report.bob, { billing: true, served: 404, hostDb: true }), `no host row: nothing billed, served as before (${JSON.stringify(report.bob)})`);
check(report.appPayment === true, "an app that emits `payment` is refused: only the kernel's pay step does");

if (aliceDb && bobDb) {
  const r = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), aliceDb, bobDb], { encoding: "utf8" });
  process.stdout.write(r.stdout);
  if (r.status !== 0) process.stdout.write(r.stderr);
  check(r.status === 0 && (r.stdout.match(/identical .*the source store reproduced exactly/g) ?? []).length === 2, "both stores replay to themselves exactly: fuel, the pay steps, the ticks' measurements served from the source");
}
if (!process.env.KEEP) await removeHome?.();
process.stdout.write(failures ? `billing: ${failures} FAILED\n` : "billing: all ok\n");
process.exit(failures ? 1 : 0);

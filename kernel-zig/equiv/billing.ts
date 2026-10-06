// Billing (#130) end to end on a local host (src/host/testhost.ts), the Zig
// kernel and the wallet program, over a regtest chain from a fake SSE header
// feed and a fake Arcade (as equiv/wallet.ts):
//
//   - a host with no pricing: it publishes no terms and bills no one. Two skeins
//     from the default image (#89: the wallet and the funding row), each claimed
//     by the owner's signed claim and given the chain app; a funding delivered to
//     the host (POST /fund/alice, the BEEF alone) pays alice's funding key (the
//     pre-set BRC-29 rule, counterparty anyone): validated, broadcast, accepted by
//     Arcade, then handed in and internalized; junk (paying another key) is refused
//     and nothing reaches her. Her owner grants the host (`skein plan host`): no
//     billing on a host that does not bill;
//   - the same host started again with pricing: it publishes its terms; bob, with
//     no host row, is not served (402); alice gets the host's first wake (billing
//     starts on its allowance). Usage — each request an entry, its door verify and
//     the bytes served attested by the host on a later entry — consumes the
//     allocation; when what the host has not attested would reach it, the host
//     wakes her (the computed wake) and her kernel's pay step pays the host X — a
//     `payment` event the host validates against its key for the pair (the pre-set
//     rule), keeps and broadcasts; its other output the checkpoint (the state
//     record's CID, recomputed here by replaying her log to that entry) — again and
//     again, then all the wallet has, then nothing: asleep;
//   - unpaid: a request is 402, her owner held too, no wake, reclaimable past the
//     grace; a second funding through the host wakes her; an owner's head message
//     for `billing` and a stranger's wake refused; an app's `payment` event is not
//     refused (any app may pay);
//   - a payment Arcade rejects is not received: the host does not serve on it,
//     and wakes her with what it did receive; a funding whose transaction is
//     rejected later takes her back to sleep;
//   - both stores replay to themselves exactly (equiv/replays.ts): the storage the
//     kernel counted, the attestations, the pay steps.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/billing.ts

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MerklePath, P2PKH, PrivateKey, ProtoWallet, Transaction, UnlockingScript, type PublicKey } from "@bsv/sdk";
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
import { fundingKey, hostingKey, paying, stateOf, type BillingConfig } from "../../src/host/billing.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CHAIN_REPO = "https://github.com/shruggr/skein-chain";
const CHAIN_REV = process.env.SKEIN_CHAIN_REV ?? "e8d21021182ae02c673e2a2809cea5e1988bd47a";
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

// The host's pricing, tiny (set only when the host is started again with it). A request's door verify
// and the bytes served are what costs here (the host's amounts, attested); X a few requests' worth.
const BILLING: BillingConfig = { x: 150, rates: { fuel: 100, storage: 1, served: 100_000, fetch: 1, authfetch: 1, publish: 1 }, allowance: 40, graceMs: 1, checkMs: 25 };
const ownerKey = new PrivateKey("2222", 16);
const ownerId = ownerKey.toPublicKey().toString();
const afters: Array<() => unknown> = [];
const h = await testHost({ after: (f) => afters.push(f) }, {
  ownerKey, arc: { url: arcade.url, token: "the-host-arcade-token", events: arcade.eventsUrl }, arcRetry: { min: 300, max: 1000 },
  genesis: { defaults: { walletNetwork: "regtest", walletFeeRate: "100" }, feeds: [{ kind: "headers", url: SSE_URL }] },
});
const owner = h.owner;

type Billing = NonNullable<ReturnType<typeof stateOf>>;
/** The kernel's billing state, read as the host reads it (the head and its record). */
async function billingOf(handle: string): Promise<Billing | undefined> {
  const k = (await h.router.hydrate(handle)).kernel;
  const root = await k.call("head", "billing") as CID | null;
  return root ? stateOf(await k.store.get(root)) : undefined;
}
const tipOf = async (handle: string) => (await (await h.router.hydrate(handle)).kernel.store.log.tip())!.toString();
/** Until the host's computed wakes due now are sent and done, and everything settled. */
async function wakesDone(handle: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    await h.router.settled();
    const due = h.db.billing(handle)?.due ?? null;
    if (due === null || due > Date.now() + 50) return;
    await sleep(30);
  }
}
/** A request no row takes (a 404 from the front door, or 402 at the gate): an entry and a step. */
async function poke(handle: string): Promise<number> {
  const r = await fetch(`${h.base}/@${handle}/nothing-here`);
  await r.arrayBuffer();
  await wakesDone(handle);
  return r.status;
}
const lines = (handle: string) => h.lines.filter((l) => l.startsWith(`[${handle}] `)).map((l) => l.slice(handle.length + 3));
/** Payments a host's wake brought (the kernel's pay step under the wake's entry): "the host's wake", then "paid", before the next entry. */
function wakePaid(handle: string): number {
  let wake = false, n = 0;
  for (const l of lines(handle)) {
    if (/^#\d+ /.test(l)) wake = false;
    if (/^kernel billing: the host's wake/.test(l)) wake = true;
    if (wake && /^billing: paid \d+ sats/.test(l)) n++;
  }
  return n;
}

// The owner's coins, mined at 101: one output per funding.
const coin = new Transaction();
coin.addInput({ sourceTXID: "11".repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex("51"), sequence: 0xffffffff });
for (let i = 0; i < 4; i++) coin.addOutput({ lockingScript: new P2PKH().lock(ownerKey.toPublicKey().toHash() as number[]), satoshis: 20_000 });
const coinTxid = coin.id("hex");
coin.merklePath = new MerklePath(101, [[{ offset: 0, hash: coinTxid, txid: true }]]);

/** A payment from the owner to `to` (a key), spending the coin's output `vout`: the Atomic BEEF alone. */
async function funding(to: PublicKey, vout: number, sats: number) {
  const tx = new Transaction();
  tx.addInput({ sourceTransaction: coin, sourceOutputIndex: vout, unlockingScriptTemplate: new P2PKH().unlock(ownerKey), sequence: 0xffffffff });
  tx.addOutput({ lockingScript: new P2PKH().lock(to.toHash() as number[]), satoshis: sats });
  await tx.sign();
  return { beef: new Uint8Array(tx.toAtomicBEEF()), txid: tx.id("hex") };
}
/** The funding delivered to the host (#130): POST /fund/<handle>, the body the BEEF and nothing else. */
async function fundAtHost(handle: string, f: { beef: Uint8Array }) {
  const r = await fetch(`${h.base}/fund/${handle}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: Buffer.from(f.beef) });
  const text = await r.text();
  await h.router.settled();
  return { status: r.status, text };
}

let aliceDb = "", bobDb = "";
try {
  await h.router.start();
  const hostKey = h.router.providers.key("billing");

  // ---- a host with no pricing
  report.unpriced = (await (await fetch(`${h.base}/.well-known/skein-host`)).json() as { billing?: unknown }).billing === undefined;

  // Two skeins from the default image, each claimed by the owner's own signed claim (#127).
  const alice = (await h.router.createInstance("alice", ownerId, { claim: await signClaim(owner) as SignedClaim })).identity;
  const bob = (await h.router.createInstance("bob", ownerId, { claim: await signClaim(owner) as SignedClaim })).identity;
  aliceDb = h.db.get("alice")!.store;
  bobDb = h.db.get("bob")!.store;
  const g = await (await h.router.hydrate("alice")).kernel.genesis() as { programs: Record<string, CID>; dispatch: Array<{ address: string; fn?: string; filter?: string }> };
  report.image = { wallet: !!g.programs.wallet, fundRow: g.dispatch.some((r) => r.address === "/wallet/fund" && r.fn === "fund" && r.filter === "beef") };

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
  // app-demo in alice: an app that emits a `payment` event (any app may pay, #130).
  await installApp({ home: h.home, port: h.router.port!, owner, settled: () => h.router.settled() }, "alice", join(here, "../../programs/test/app-demo"));
  const headers: Uint8Array[] = [];
  let prev: Uint8Array = sha256d(REGTEST_GENESIS);
  for (let n = 1; n <= 102; n++) {
    headers.push(mine(prev, n === 101 ? internal(coinTxid) : sha256d(Buffer.from(`filler ${n}`)), 1_790_000_000 + n * 600));
    prev = sha256d(headers.at(-1)!);
  }
  for (const raw of headers) await feedHeader(raw);
  await sleep(500);
  await h.router.settled();
  report.beforeTerms = { billing: (await billingOf("alice")) === undefined, open: h.router.closed("alice") === undefined };

  // Junk: a BEEF paying another key than alice's funding key — refused, not broadcast, nothing reaches her.
  const junk = await funding(new PrivateKey(99).toPublicKey(), 0, 500);
  const tip0 = await tipOf("alice");
  const rj = await fundAtHost("alice", junk);
  report.junk = { status: rj.status, posted: arcade.posts.some((x) => FakeArcade.txOf(x).id("hex") === junk.txid), reached: (await tipOf("alice")) !== tip0 };

  // The owner funds alice through the host: her funding key (BRC-29, the pre-set rule, counterparty anyone).
  const f1 = await funding(fundingKey(alice), 0, 700);
  // Until her chain app has taken header 101 (the door checks the BUMP against it: before, a refusal).
  const r1 = await until("the funding taken", async () => { const r = await fundAtHost("alice", f1); return r.status === 200 ? r : (await sleep(250), undefined); }, 60_000);
  const a1 = JSON.parse(r1.text) as { txid: string; outputs: number };
  report.funded = { status: r1.status, txid: a1.txid === f1.txid, outputs: a1.outputs, broadcastFirst: arcade.txs.has(f1.txid) };

  // The owner grants the host (#130 decided 1): the host row, with the host's key and its terms.
  await sendPlan({ port: h.router.port!, owner, settled: () => h.router.settled() }, "alice", planHost(alice, "add", { key: hostKey, x: BILLING.x, rates: BILLING.rates }));
  report.unbilled = { billing: (await billingOf("alice")) === undefined, served: (await fetch(`${h.base}/@alice/nothing-here`)).status };

  // ---- the same host, with pricing
  await h.restart(BILLING);
  const published = await (await fetch(`${h.base}/.well-known/skein-host`)).json() as { billing?: { key: string; x: number; rates: Record<string, number>; allowance: number } };
  report.published = published.billing?.key === hostKey && published.billing?.x === BILLING.x && published.billing?.allowance === BILLING.allowance;
  // bob: no host row on a host that bills — not served (#130: a terms mismatch).
  await h.router.hydrate("bob");
  const rb = await fetch(`${h.base}/@bob/nothing-here`);
  report.bob = { status: rb.status, why: (await rb.json() as { description: string }).description.split(":")[0], billing: (await billingOf("bob")) === undefined };

  // alice: the host's first wake starts billing.
  const started = await until("billing starts (the host's first wake)", async () => { await h.router.settled(); return await billingOf("alice"); }, 30_000);
  report.started = { host: started.host === hostKey, allowance: Number(started.allowance), paid: Number(started.paid) };

  // Usage until the allocation is consumed and paid for, then until it sleeps.
  let pokes = 0;
  const paidOnce = await until("the first payment", async () => {
    pokes++;
    if ((await poke("alice")) === 402 && !(await billingOf("alice"))?.payments) throw new Error("held before any payment");
    const b = await billingOf("alice");
    return b && b.payments >= 1 ? b : undefined;
  }, 120_000);
  report.firstPayment = { pokes, paid: Number(paidOnce.paid), x: BILLING.x, under: paidOnce.tally < (paidOnce.allowance + paidOnce.paid) * 1_000_000_000n, bytes: paidOnce.bytes > 0 };
  report.attested = lines("alice").filter((l) => /^billing: the host attests \d+ fuel, \d+ bytes served/.test(l)).length;
  const pays1 = h.db.billingPayments("alice");
  const p1 = pays1[0];
  report.hostTook = { n: pays1.length, amount: p1?.amount, ours: p1?.ours, status: p1?.status, checkpoint: !!p1?.checkpoint };
  // The payment transaction: its output pays the host's key for the pair (the pre-set rule), its other output commits the checkpoint, Arcade has it.
  if (p1) {
    const beef = (h.db.db.prepare("SELECT beef FROM billing_payments WHERE txid = ?").get(p1.txid) as { beef: Uint8Array }).beef;
    const tx = Transaction.fromAtomicBEEF([...beef]);
    const toHost = paying(tx, hostingKey(h.router["providerKey"]("billing"), alice).toPublicKey());
    const cp = tx.outputs.find((o) => o.satoshis === 0)!;
    const script = cp.lockingScript.toBinary();
    const cid = CID.decode(Uint8Array.from(script.slice(3)));
    report.checkpoint = {
      rule: toHost.length === 1 && toHost[0]!.satoshis === p1.amount,
      opReturn: script[0] === 0 && script[1] === 0x6a, sameCid: cid.toString() === p1.checkpoint,
      broadcast: arcade.posts.some((x) => FakeArcade.txOf(x).id("hex") === p1.txid),
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
    await poke("alice");
    const b = await billingOf("alice");
    return b?.asleep ? b : undefined;
  }, 300_000);
  const pays = h.db.billingPayments("alice");
  report.drained = {
    asleep: asleep.asleep, overspent: asleep.tally >= (asleep.allowance + asleep.paid) * 1_000_000_000n,
    paidSum: pays.reduce((n, p) => n + p.amount, 0) === Number(asleep.paid), payments: asleep.payments === pays.length,
    fullX: pays.filter((p) => p.amount === BILLING.x).length, partial: pays.some((p) => p.amount < BILLING.x), allOurs: pays.every((p) => p.ours), allAccepted: pays.every((p) => p.status === "accepted"),
    byWake: wakePaid("alice"), grew: asleep.bytes > paidOnce.bytes,
  };
  report.hostDb = { asleepSince: h.db.billing("alice")?.asleep_since !== null };
  // The gate: a request 402, no wake, the reclaim bookkeeping lists her past the grace (nothing deleted here).
  const gate = await fetch(`${h.base}/@alice/nothing-here`);
  const gateBody = await gate.json() as { code: string; description: string };
  report.gate = { status: gate.status, code: gateBody.code, unpaid: /^unpaid/.test(gateBody.description), wake: await h.router.billingWake("alice") === undefined, reclaimable: h.db.reclaimable(Date.now() + 10, BILLING.graceMs!).some((r) => r.instance === "alice") };
  const frozen = (await billingOf("alice"))!.tally;
  // The owner too is held at the gate: an admin message is 402.
  report.ownerHeld = await sendPlan({ port: h.router.port!, owner, settled: () => h.router.settled() }, "alice", planHost(alice, "add", { key: hostKey, x: BILLING.x, rates: BILLING.rates })).then(() => 200, (e: Error) => /402/.test(e.message) ? 402 : 0);

  // The second funding, delivered to the host: past the gate; the pay step fires on it; she is served.
  const f2 = await funding(fundingKey(alice), 1, 900);
  const r2 = await fundAtHost("alice", f2);
  const awake = await until("awake again", async () => { await wakesDone("alice"); const b = await billingOf("alice"); return b && !b.asleep && h.router.closed("alice") === undefined ? b : undefined; }, 60_000);
  report.woke = { funded: r2.status, frozenWhileAsleep: awake.tally >= frozen, paidMore: awake.paid > asleep.paid, served: await poke("alice") };
  report.hostDbAwake = h.db.billing("alice")?.asleep_since === null;

  // Not the owner's to touch: an owner's `head` message for `billing` is refused (the kernel's own).
  const before = await (await h.router.hydrate("alice")).kernel.call("head", "billing") as CID;
  await sendPlan({ port: h.router.port!, owner, settled: () => h.router.settled() }, "alice", { prompt: [], recipient: alice, messages: [{ box: "head", body: { name: "billing", tree: before } }] });
  report.headRefused = lines("alice").some((l) => /kernel head refused: the head billing is the kernel's own/.test(l));

  // A wake signed by another key: not the host row's (a second billing row for that key, added by the owner) — refused.
  const stranger = new PrivateKey("7777", 16);
  await sendPlan({ port: h.router.port!, owner, settled: () => h.router.settled() }, "alice", planHost(alice, "add", { key: stranger.toPublicKey().toString(), x: BILLING.x, rates: BILLING.rates }));
  const body = { kind: "wake", allowance: 1_000_000, received: 1_000_000 };
  const bodyBytes = dagCbor.encode(body);
  const unsigned = { kind: "mail", op: "put", sender: Uint8Array.from(Buffer.from(stranger.toPublicKey().toString(), "hex")), recipient: Uint8Array.from(Buffer.from(alice, "hex")), box: "billing", body: encode(body).cid, nonce: Uint8Array.from(Buffer.alloc(16, 7)) };
  const { signature } = await new ProtoWallet(stranger).createSignature({ protocolID: MESSAGE_PROTOCOL, keyID: MESSAGE_KEY_ID, counterparty: "anyone", data: [...dagCbor.encode(unsigned)] });
  await h.router.appendLocal("alice", { kind: "message", message: { ...unsigned, signature: Uint8Array.from(signature) }, body: bodyBytes });
  await wakesDone("alice");
  const sAfter = (await billingOf("alice"))!;
  report.strangerWake = { refused: lines("alice").some((l) => /kernel billing refused: the host is the first billing row's key/.test(l)), unchanged: sAfter.host === hostKey && sAfter.allowance === BigInt(BILLING.allowance) && sAfter.paid < 1_000_000n };

  // Any app may pay (#130): an app's `payment` event is not refused; the host takes only what pays its key.
  await new RawBox(owner, `${h.base}/@alice`).send(alice, "app-demo", { kind: "app-demo-event", event: "payment", amount: 1 });
  await wakesDone("alice");
  report.appPayment = { refused: lines("alice").some((l) => /emit: payment:/.test(l)), hostSaw: lines("alice").some((l) => /billing: a payment event without its transaction: ignored/.test(l)) };

  // A payment Arcade rejects is not received: the host serves on what it received, and wakes her with it.
  const receivedBefore = h.db.received("alice");
  const paymentsBefore = (await billingOf("alice"))!.payments;
  arcade.mode = "reject";
  await until("a payment Arcade rejected", async () => { await poke("alice"); return h.db.billingPayments("alice").some((p) => p.status === "rejected") || undefined; }, 120_000);
  const held = await until("held for want of payment", async () => { await poke("alice"); const c = h.router.closed("alice"); return c && /^unpaid/.test(c) && h.db.billingPayments("alice").every((p) => p.status !== "pending") ? c : undefined; }, 120_000);
  const sr = (await billingOf("alice"))!;
  report.rejected = {
    paidByKernel: sr.payments > paymentsBefore && sr.paid > h.db.received("alice"), notReceived: h.db.received("alice") === receivedBefore, held: /^unpaid/.test(held),
    asleepByKernel: sr.asleep, status: (await fetch(`${h.base}/@alice/nothing-here`)).status,
  };

  // A funding Arcade accepts: handed in, then the host's wake tells the kernel what it received — it pays again, and is served.
  arcade.mode = "ok";
  const f3 = await funding(fundingKey(alice), 2, 600);
  const r3 = await fundAtHost("alice", f3);
  await until("served on the third funding", async () => { await wakesDone("alice"); return h.router.closed("alice") === undefined || undefined; }, 60_000);
  const s3 = (await billingOf("alice"))!;
  report.thirdFunding = {
    status: r3.status, open: h.router.closed("alice") === undefined, paidFollows: s3.paid === h.db.received("alice"),
    corrected: lines("alice").some((l) => /kernel billing: the host's wake \(.*\): it received \d+ sats; this skein's pay steps counted \d+/.test(l)),
  };
  // Then Arcade rejects it later — and the fees paid from those coins die with it: she sleeps again.
  const after3 = h.db.billingPayments("alice").filter((p) => p.status === "accepted" && p.at >= h.db.billingPayments("alice").find((x) => x.status === "rejected")!.at);
  arcade.mode = "reject";
  arcade.emit(f3.txid, { txStatus: "REJECTED" });
  for (const p of after3) if (arcade.txs.has(p.txid)) arcade.emit(p.txid, { txStatus: "REJECTED" });
  const slept = await until("asleep again", async () => { await wakesDone("alice"); const c = h.router.closed("alice"); return c && /^unpaid/.test(c) ? c : undefined; }, 120_000);
  report.laterRejection = { held: /^unpaid/.test(slept), status: (await fetch(`${h.base}/@alice/nothing-here`)).status };
  arcade.mode = "ok";

  report.ok = true;
} catch (e) {
  report.error = (e as Error).stack ?? String(e);
}
await h.router.settled().catch(() => {});
if (process.env.BILLING_LINES) (await import("node:fs")).writeFileSync(process.env.BILLING_LINES, h.lines.join("\n"));
const [removeHome, ...rest] = afters;
for (const f of rest.reverse()) await f();
for (const s of sse) s.end();
sseServer.close();
await arcade.close();

const eq = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
check(report.ok === true, `the scenario ran${report.error ? `: ${report.error}` : ""}`);
check(report.unpriced === true, "a host with no pricing publishes no terms at /.well-known/skein-host");
check(eq(report.image, { wallet: true, fundRow: true }), `the default image carries the wallet and the funding row /wallet/fund (open, the beef filter) (${JSON.stringify(report.image)})`);
check(eq(report.beforeTerms, { billing: true, open: true }), "no host row, no pricing: no billing state, served as usual");
check(eq(report.junk, { status: 400, posted: false, reached: false }), `a funding paying another key than her funding key: refused, not broadcast, nothing reaches her (${JSON.stringify(report.junk)})`);
check(eq(report.funded, { status: 200, txid: true, outputs: 1, broadcastFirst: true }), `a funding paying her funding key (counterparty anyone), the BEEF alone: broadcast, accepted, handed in, internalized (${JSON.stringify(report.funded)})`);
check(eq(report.unbilled, { billing: true, served: 404 }), `her host row on a host that does not bill: never woken, nothing billed (${JSON.stringify(report.unbilled)})`);
check(report.published === true, "started again with pricing: the host publishes its terms (its billing key, X, the allowance)");
check(eq(report.bob, { status: 402, why: "no host row", billing: true }), `bob, with no host row, is not served on a host that bills (${JSON.stringify(report.bob)})`);
const st = (report.started ?? {}) as Record<string, unknown>;
check(eq(st, { host: true, allowance: BILLING.allowance, paid: 0 }), `the host's first wake: billing starts on its allowance (${JSON.stringify(st)})`);
const fp = (report.firstPayment ?? {}) as Record<string, unknown>;
check(fp.paid === BILLING.x && fp.under === true && fp.bytes === true, `usage reaches the allocation: the pay step pays X; the allocation is ahead again; the storage counted (${JSON.stringify(fp)})`);
check((report.attested as number) > 0, `the host's attestations (its calls' fuel, the bytes served) taken by the kernel (${report.attested})`);
check(eq(report.hostTook, { n: 1, amount: BILLING.x, ours: true, status: "accepted", checkpoint: true }), `the host takes the payment: its key for the pair, broadcast, accepted (${JSON.stringify(report.hostTook)})`);
const cp = (report.checkpoint ?? {}) as Record<string, unknown>;
check(cp.rule === true && cp.opReturn === true && cp.sameCid === true && cp.broadcast === true, `the payment pays the host's key by the pre-set rule; its other output is OP_FALSE OP_RETURN <the state record CID>; Arcade has it (${JSON.stringify(cp)})`);
check(cp.stored === true ? cp.cursorEntry === true : typeof cp.cursorEntry === "string", `the checkpoint names her state as it stood after the entry before the trigger (${JSON.stringify(cp)})`);
const dr = (report.drained ?? {}) as Record<string, unknown>;
check(dr.asleep === true && dr.overspent === true && dr.paidSum === true && dr.payments === true && (dr.fullX as number) >= 1 && dr.partial === true && dr.allOurs === true && dr.allAccepted === true && dr.grew === true, `drained: X while it could, then all it had (less than X), then nothing — asleep, consumed ≥ allocation (${JSON.stringify(dr)})`);
check((dr.byWake as number) >= 1, `the host's computed wake brings payments: what it had not attested would reach the allocation, it woke her, her pay step paid (${dr.byWake} by a wake)`);
check(eq(report.hostDb, { asleepSince: true }), "the host records when its gate first held her unpaid (the grace counts from it)");
check(eq(report.gate, { status: 402, code: "ERR_PAYMENT_REQUIRED", unpaid: true, wake: true, reclaimable: true }), `unpaid: a request is 402, no wake is sent, past the grace she is reclaimable (nothing deleted) (${JSON.stringify(report.gate)})`);
check(report.ownerHeld === 402, `unpaid, the owner's messages are held at the gate too: 402 (${report.ownerHeld})`);
const wk = (report.woke ?? {}) as Record<string, unknown>;
check(wk.funded === 200 && wk.frozenWhileAsleep === true && wk.paidMore === true && wk.served === 404, `a second funding through the host: past the gate, the pay step fires on it, she is served (${JSON.stringify(wk)})`);
check(report.hostDbAwake === true, "served again: host.db clears the unpaid time");
check(report.headRefused === true, "the owner's `head` message for `billing` is refused: the kernel's own");
check(eq(report.strangerWake, { refused: true, unchanged: true }), `a wake from a key that is not the host row's (the first billing row) is refused (${JSON.stringify(report.strangerWake)})`);
check(eq(report.appPayment, { refused: false, hostSaw: true }), `an app's payment event is not refused (any app may pay); the host takes only what pays its key (${JSON.stringify(report.appPayment)})`);
const rj2 = (report.rejected ?? {}) as Record<string, unknown>;
check(eq(rj2, { paidByKernel: true, notReceived: true, held: true, asleepByKernel: false, status: 402 }), `a payment Arcade rejects is not received: her kernel counts it paid (not asleep), the host does not serve on it (${JSON.stringify(rj2)})`);
check(eq(report.thirdFunding, { status: 200, open: true, paidFollows: true, corrected: true }), `a funding Arcade accepts: the host's wake after it sets her kernel's paid to what the host received, she pays again and is served (${JSON.stringify(report.thirdFunding)})`);
check(eq(report.laterRejection, { held: true, status: 402 }), `rejected later (the funding, and the fee paid from it): she sleeps again (${JSON.stringify(report.laterRejection)})`);

if (aliceDb && bobDb) {
  const r = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), aliceDb, bobDb], { encoding: "utf8" });
  process.stdout.write(r.stdout);
  if (r.status !== 0) process.stdout.write(r.stderr);
  check(r.status === 0 && (r.stdout.match(/identical .*the source store reproduced exactly/g) ?? []).length === 2, "both stores replay to themselves exactly: fuel, the storage counted, the attestations, the pay steps");
}
if (!process.env.KEEP) await removeHome?.();
process.stdout.write(failures ? `billing: ${failures} FAILED\n` : "billing: all ok\n");
process.exit(failures ? 1 : 0);

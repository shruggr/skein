// Billing (#130): the host's side (billing.ts) unit by unit — its pricing (none unless the host
// defines it), the host row's terms and the mismatch, the kernel's state record as the host reads it,
// the computed wake, the gate on what the host received, the period's log record and the attestation
// it signs, the pre-set derivations (funding: counterparty anyone; hosting: the pair), host.db's
// bookkeeping, the owner's plan (`skein plan host`) — and, with the real Zig kernel and a fake Arcade,
// an instance with no wallet: its host row starts billing at the host's first wake; an attestation
// rides on an entry only when the host has external cost unreported, and the kernel takes it;
// storage alone brings the computed wake, which fires at its time; consumed ≥ allocation with nothing
// to pay with, and the host serves nothing but a funding and the instance's own messages; a funding
// not paying the skein's funding key is refused before anything reaches it, one Arcade rejects too,
// one Arcade takes is handed in; an instance with no host row is not served on a host that bills.
// (The whole loop — payments, the checkpoint, funding, waking — is kernel-zig/equiv/billing.ts.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyDeriver, MerklePath, P2PKH, PrivateKey, ProtoWallet, Transaction, UnlockingScript, type PublicKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { planHost } from "../client/admin.ts";
import { encode } from "../runtime/cid.ts";
import { sendPlan } from "../testapps.ts";
import { allocation, attestationPreimage, BRC29_PROTOCOL, billingConfig, closedBy, dueAt, FUNDING_PREFIX, FUNDING_SUFFIX, fundingKey, HOSTING_PREFIX, HOSTING_SUFFIX, hostingKey, mismatch, NSAT, paying, Period, periodRecord, priceHost, priceStorage, stateOf, termsOf, type BillingConfig, type BillingState, type Rates } from "./billing.ts";
import { controlRequest, listenControl } from "./control.ts";
import { FakeArcade } from "./fake-arcade.ts";
import { HostDb } from "./instances.ts";
import { KERNEL_BIN } from "./kernel.ts";
import { testHost, until } from "./testhost.ts";

const key = (n: number) => new PrivateKey(n).toPublicKey().toString();
const NO_RATES: Rates = { fuel: 0, storage: 0, served: 0, fetch: 0, authfetch: 0, publish: 0 };

test("billing: pricing only where the host defines it — none without SKEIN_BILLING_X; no default rate, allowance or grace", () => {
  assert.equal(billingConfig({}), undefined, "no pricing: no billing");
  assert.equal(billingConfig({ SKEIN_BILLING_RATES: JSON.stringify({ fuel: 7 }), SKEIN_BILLING_ALLOWANCE: "5" }), undefined, "rates without X: still none");
  assert.deepEqual(billingConfig({ SKEIN_BILLING_X: "5" }), { x: 5, rates: NO_RATES, allowance: 0 });
  const c = billingConfig({ SKEIN_BILLING_X: "5", SKEIN_BILLING_RATES: JSON.stringify({ fuel: 7 }), SKEIN_BILLING_ALLOWANCE: "10", SKEIN_BILLING_GRACE_MS: "1000", SKEIN_BILLING_CHECK_MS: "50" })!;
  assert.deepEqual(c, { x: 5, rates: { ...NO_RATES, fuel: 7 }, allowance: 10, graceMs: 1000, checkMs: 50 });
  assert.throws(() => billingConfig({ SKEIN_BILLING_X: "0" }), /at least 1/);
  assert.throws(() => billingConfig({ SKEIN_BILLING_X: "1", SKEIN_BILLING_RATES: JSON.stringify({ fuels: 1 }) }), /a rate is one of/);
  assert.throws(() => billingConfig({ SKEIN_BILLING_X: "1", SKEIN_BILLING_ALLOWANCE: "-1" }), /whole number/);
});

test("billing: the host row's terms — the first billing row; the mismatch with what the host supports", () => {
  const host = key(11), other = key(12);
  const row = (k: string, x: unknown, rates?: unknown) => ({ transport: "mailbox" as const, address: "billing", sender: Uint8Array.from(Buffer.from(k, "hex")), program: "kernel" as const, fn: "billing", x, ...(rates ? { rates } : {}) });
  assert.equal(termsOf([]), undefined);
  assert.equal(termsOf([{ ...row(host, 5), fn: "tick" }]), undefined, "the tick row is gone: not a host row");
  const t = termsOf([row(host, 300, { fuel: 2, publish: 9 }), row(other, 1)])!;
  assert.deepEqual([t.host, t.x, t.address], [host, 300, "billing"]);
  assert.deepEqual(t.rates, { ...NO_RATES, fuel: 2, publish: 9 });
  assert.equal(termsOf([row(host, undefined)]), undefined, "no x: no terms");
  const cfg: BillingConfig = { x: 300, rates: { ...NO_RATES, fuel: 2, publish: 9 }, allowance: 0 };
  assert.equal(mismatch(cfg, host, t), undefined);
  assert.match(mismatch(cfg, other, t)!, /not this host's key/);
  assert.match(mismatch({ ...cfg, x: 301 }, host, t)!, /x 300 is below/);
  assert.match(mismatch({ ...cfg, rates: { ...cfg.rates, publish: 10 } }, host, t)!, /publish rate 9 is below/);
  assert.equal(mismatch({ ...cfg, x: 1 }, host, t), undefined, "more than the host asks is served");
});

test("billing: the kernel's state as the host reads it; prices; the computed wake", () => {
  const host = key(11);
  const rec = { kind: "billing", host: Uint8Array.from(Buffer.from(host, "hex")), allowance: 40, paid: 150, tally: 9_007_199_254_740_993n, lastCharge: 5, bytes: 4096, payments: 1, asleep: false };
  const s = stateOf(dagCbor.decode(dagCbor.encode(rec)))!;
  assert.deepEqual([s.host, s.lastCharge, s.bytes], [host, 5, 4096]);
  assert.equal(s.tally, 9_007_199_254_740_993n, "a tally past 2^53 nanosats is a bigint");
  assert.equal(allocation(s), 190n * NSAT);
  assert.equal(stateOf({ ...rec, kind: "other" }), undefined);
  assert.equal(stateOf({ ...rec, asleep: "no" }), undefined);
  const r: Rates = { ...NO_RATES, fuel: 2, served: 3, storage: 1 };
  assert.equal(priceHost(r, 1_000_000_000, 1_000_000), 5n * NSAT, "two sats of call fuel and three of bytes served (billing.zig priceHost)");
  assert.equal(priceStorage(r, 1_000_000, 86_400_000), NSAT, "a MB for a day at 1 sat (billing.zig priceStorage)");

  // The computed wake: when tally + unattested + storage accruing reaches the allocation.
  const st: BillingState = { host, allowance: 1n, paid: 0n, tally: 0n, lastCharge: 1_000, bytes: 1_000_000, payments: 0, asleep: false };
  // 1 sat of storage on 10^6 bytes at 1 sat per MB-day: a day after the last charge.
  assert.equal(dueAt(st, r, 0n, 2_000), 1_000 + 86_400_000);
  assert.equal(priceStorage(r, st.bytes, dueAt(st, r, 0n, 2_000)! - st.lastCharge), NSAT, "at the due time, storage is exactly the allocation");
  assert.equal(priceStorage(r, st.bytes, dueAt(st, r, 0n, 2_000)! - st.lastCharge - 1) < NSAT, true, "a ms before, not yet");
  // Half of it unattested: half a day.
  assert.equal(dueAt(st, r, NSAT / 2n, 2_000), 1_000 + 43_200_000);
  // Already reached: now. No storage rate, or no bytes: none. Asleep: none (a funding wakes it).
  assert.equal(dueAt({ ...st, tally: NSAT }, r, 0n, 2_000), 2_000);
  assert.equal(dueAt(st, r, NSAT, 2_000), 2_000);
  assert.equal(dueAt(st, NO_RATES, 0n, 2_000), undefined);
  assert.equal(dueAt({ ...st, bytes: 0 }, r, 0n, 2_000), undefined);
  assert.equal(dueAt({ ...st, asleep: true }, r, NSAT, 2_000), undefined);
});

test("billing: the gate serves on what the host received — no view open; no host row, other terms closed; the kernel's own `paid` is not read", () => {
  const host = key(11);
  const terms = termsOf([{ transport: "mailbox", address: "billing", sender: Uint8Array.from(Buffer.from(host, "hex")), program: "kernel", fn: "billing", x: 5 }])!;
  const s: BillingState = { host, allowance: 10n, paid: 0n, tally: 0n, lastCharge: 0, bytes: 0, payments: 0, asleep: false };
  assert.equal(closedBy(undefined, 0n, "u"), undefined, "not read yet (a host that does not bill reads nothing): open");
  assert.match(closedBy({}, 0n, "u")!, /^no host row/, "a host that bills: no host row is a terms mismatch");
  assert.match(closedBy({ terms, mismatch: "x 1 is below this host's 5" }, 0n, "u")!, /does not serve these terms/);
  assert.equal(closedBy({ terms }, 0n, "u"), undefined, "billing not started yet (the first wake is on its way)");
  assert.equal(closedBy({ terms, state: { ...s, tally: 10n * NSAT - 1n } }, 0n, "u"), undefined, "within the allowance");
  assert.match(closedBy({ terms, state: { ...s, tally: 10n * NSAT } }, 0n, "http://h/fund/a")!, /^unpaid: .*POST http:\/\/h\/fund\/a/);
  // The kernel says it paid 150 (its pay step), the host received none of it: held all the same.
  assert.match(closedBy({ terms, state: { ...s, paid: 150n, payments: 1, tally: 100n * NSAT } }, 0n, "u")!, /^unpaid/, "a payment the host did not receive keeps nothing open");
  assert.equal(closedBy({ terms, state: { ...s, tally: 100n * NSAT } }, 150n, "u"), undefined, "what it received does");
  assert.match(closedBy({ terms, state: { ...s, tally: 160n * NSAT, asleep: false } }, 150n, "u")!, /^unpaid/);
  assert.equal(closedBy({ terms, state: { ...s, host: key(12), tally: 999n * NSAT } }, 0n, "u"), undefined, "another host's state: billing by this host has not started");
});

test("billing: the period's log record and the attestation the host signs (the bytes billing.zig verifies)", async () => {
  const p = new Period(100);
  assert.ok(!p.owing);
  p.add({ at: 101, op: "GET /explore", caller: key(13), fuel: 500, bytes: 20 });
  p.add({ at: 102, op: "door verify", fuel: 0, bytes: 0 });
  assert.deepEqual([p.fuel, p.served, p.owing], [500, 20, true]);
  const q = new Period(103);
  q.add({ at: 104, op: "GET /x", fuel: 1, bytes: 7 });
  p.absorb(q);
  assert.deepEqual([p.fuel, p.served, p.lines.length], [501, 27, 3]);
  const empty = new Period(5);
  empty.add({ at: 6, op: "door verify", fuel: 0, bytes: 0 });
  assert.ok(!empty.owing, "a line with no amount owes nothing");
  const r = periodRecord(key(14), p, 105);
  assert.equal(r.cid.toString(), encode(r.record).cid.toString());
  const back = dagCbor.decode(r.bytes) as { kind: string; from: number; to: number; lines: Array<{ caller?: Uint8Array }> };
  assert.deepEqual([back.kind, back.from, back.to, back.lines.length], ["host-log", 100, 105, 3]);
  // The preimage is byte for byte billing.zig's (its test's fixture): {kind, instance, fuel, served, log}.
  const inst = new PrivateKey("2222222222222222222222222222222222222222222222222222222222222222", 16).toPublicKey().toString();
  const pre = attestationPreimage(inst, 5, 7, encode("a host log").cid);
  assert.equal(Buffer.from(pre).toString("hex"), "a5636c6f67d82a582500017112205d4fb1da1bcac84abd10fec47c73513adeb4f44e21ab8ae4809f04bf127a8b85646675656c05646b696e646b6174746573746174696f6e667365727665640768696e7374616e6365582102466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27");
});

test("billing: the pre-set derivations — a funding pays the skein's key by counterparty anyone; a hosting payment the host's key for the pair", async () => {
  const skein = new PrivateKey(31), host = new PrivateKey(32);
  const id = skein.toPublicKey().toString();
  // Funding: anyone derives the key from the identity alone; the skein's signer derives the same (forSelf, counterparty anyone).
  const f = fundingKey(id);
  const mine = await new ProtoWallet(skein).getPublicKey({ protocolID: BRC29_PROTOCOL, keyID: `${FUNDING_PREFIX} ${FUNDING_SUFFIX}`, counterparty: "anyone", forSelf: true });
  assert.equal(f.toString(), mine.publicKey);
  assert.equal(new KeyDeriver(skein).derivePrivateKey(BRC29_PROTOCOL, `${FUNDING_PREFIX} ${FUNDING_SUFFIX}`, "anyone").toPublicKey().toString(), f.toString(), "only the skein holds its private key");
  assert.deepEqual([FUNDING_PREFIX, FUNDING_SUFFIX, HOSTING_PREFIX, HOSTING_SUFFIX].map((x) => Buffer.from(x, "base64").toString()), ["skein", "funding", "skein", "hosting"]);
  // Hosting: what the skein pays (its signer, counterparty the host) is the key the host derives (counterparty the skein).
  const paid = await new ProtoWallet(skein).getPublicKey({ protocolID: BRC29_PROTOCOL, keyID: `${HOSTING_PREFIX} ${HOSTING_SUFFIX}`, counterparty: host.toPublicKey().toString() });
  assert.equal(hostingKey(host, id).toPublicKey().toString(), paid.publicKey);
  assert.notEqual(hostingKey(host, key(33)).toPublicKey().toString(), paid.publicKey, "one key per pair");
  // paying(): the outputs of a transaction to a key.
  const tx = new Transaction();
  tx.addOutput({ lockingScript: new P2PKH().lock(f.toHash()), satoshis: 70 });
  tx.addOutput({ lockingScript: new P2PKH().lock(skein.toPublicKey().toHash()), satoshis: 5 });
  tx.addOutput({ lockingScript: new P2PKH().lock(f.toHash()), satoshis: 30 });
  assert.deepEqual(paying(tx, f), [{ vout: 0, satoshis: 70 }, { vout: 2, satoshis: 30 }]);
});

test("billing: host.db — unpaid since the first time seen, the due wake, the grace, periods, payments and what was received (taken, not rejected)", () => {
  const dir = mkdtempSync(join(tmpdir(), "skein-billing-"));
  try {
    const db = new HostDb(join(dir, "host.db"));
    db.setBilling("a", { host: key(1), tally: 5n, allocation: 4n, asleep: true }, 1000);
    db.setBilling("a", { host: key(1), tally: 6n, allocation: 4n, asleep: true }, 5000);
    assert.equal(db.billing("a")!.asleep_since, 1000, "unpaid since the first time seen");
    assert.equal(db.billing("a")!.tally, "6");
    db.setBilling("b", { host: key(1), asleep: false, due: 7000 }, 1000);
    assert.equal(db.billing("b")!.asleep_since, null);
    assert.deepEqual(db.billingDue(6999), []);
    assert.deepEqual(db.billingDue(7000), ["b"], "due: read only");
    db.setDue("b", undefined);
    assert.deepEqual(db.billingDue(1e12), []);
    db.setDue("b", 8000);
    assert.equal(db.billing("b")!.due, 8000);
    assert.deepEqual(db.reclaimable(1500, 1000).map((r) => r.instance), [], "within the grace");
    assert.deepEqual(db.reclaimable(2000, 1000).map((r) => r.instance), ["a"], "past it");
    db.setBilling("a", { host: key(1), asleep: false }, 6000);
    assert.equal(db.billing("a")!.asleep_since, null, "served again: cleared");
    const p = { instance: "a", txid: "ab".repeat(32), amount: 150, at: 7, beef: new Uint8Array([1, 2]), remittance: { derivationPrefix: "p" }, ours: true, checkpoint: "bafy" };
    assert.equal(db.billingPayment(p), true);
    assert.equal(db.billingPayment(p), false, "a payment is taken once");
    db.billingPayment({ ...p, txid: "cd".repeat(32), amount: 0, ours: false });
    assert.equal(db.received("a"), 150n, "taken (paying this host's key) and not rejected: received, while Arcade has not answered");
    assert.deepEqual(db.paymentStatus("ab".repeat(32), "accepted"), ["a"]);
    assert.deepEqual(db.paymentStatus("ab".repeat(32), "accepted"), [], "no change");
    assert.deepEqual(db.paymentStatus("cd".repeat(32), "accepted"), ["a"]);
    assert.equal(db.received("a"), 150n, "accepted; one not paying this host's key is never received");
    assert.deepEqual(db.paymentStatus("ab".repeat(32), "rejected"), ["a"]);
    assert.equal(db.received("a"), 0n, "rejected later: not received");
    assert.deepEqual(db.paymentStatus("ef".repeat(32), "accepted"), [], "not a payment");
    assert.deepEqual(db.billingPayments("a").map((x) => [x.amount, x.ours, x.status, x.checkpoint]), [[150, true, "rejected", "bafy"], [0, false, "accepted", "bafy"]]);
    db.billingPeriod("a", 9, "bafylog", new Uint8Array([3]));
    db.billingPeriod("a", 10, "bafylog2", new Uint8Array([4]));
    db.dropBillingPeriod("a", 10);
    assert.deepEqual(db.billingPeriods("a").map((x) => [x.at, x.log]), [[9, "bafylog"]]);
    db.forgetBilling("a");
    assert.equal(db.billing("a"), undefined);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("billing: the control socket's reclaim; the owner's plan for the host row", async () => {
  const dir = mkdtempSync(join(tmpdir(), "skein-billing-"));
  try {
    const sock = join(dir, "host.sock");
    const asked: string[] = [];
    const server = await listenControl(sock, { event: async () => "", reclaim: async (h) => { asked.push(h); if (h === "host") throw new Error("the host skein"); } });
    assert.deepEqual(await controlRequest(sock, { op: "reclaim", handle: "alice" }), { ok: true, entry: "" });
    assert.deepEqual(await controlRequest(sock, { op: "reclaim", handle: "host" }), { ok: false, error: "the host skein" });
    assert.deepEqual(asked, ["alice", "host"]);
    await new Promise<void>((r) => server.close(() => r()));
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const host = key(21), me = key(22);
  const p = planHost(me, "add", { key: host, x: 300, rates: { fuel: 2 } });
  assert.equal(p.messages.length, 1);
  const m = p.messages[0]!;
  assert.equal(m.box, "dispatch");
  const row = (m.body as { op: string; row: Record<string, unknown> }).row;
  assert.deepEqual([row.transport, row.address, row.program, row.fn, row.x, row.rates], ["mailbox", "billing", "kernel", "billing", 300, { fuel: 2 }]);
  assert.equal(Buffer.from(row.sender as Uint8Array).toString("hex"), host);
  assert.equal((planHost(me, "remove", { key: host, x: 1 }).messages[0]!.body as { row: { x?: number } }).row.x, undefined, "a removal names the row's key only");
  assert.throws(() => planHost(me, "add", { key: "nope", x: 1 }), /not the host's key/);
  assert.throws(() => planHost(me, "add", { key: host, x: 0 }), /x:/);
});

test("billing: a host that bills needs its Arcade", async (t) => {
  await assert.rejects(testHost(t, { billing: { x: 1, rates: NO_RATES, allowance: 0 } }), /needs the host's Arcade/);
});

test("billing with the real kernel — the first wake, attestations only when owed, the computed wake by storage, the gate, fundings, no host row", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  const arcade = await FakeArcade.start();
  t.after(() => arcade.close());
  // An allowance of 1 sat, consumed by storage alone (no other rate): the computed wake brings it.
  // 2·10^7 sats per MB-day on the few KB the kernel keeps: due in about a second.
  const billing: BillingConfig = { x: 10, rates: { ...NO_RATES, storage: 20_000_000 }, allowance: 1, checkMs: 20 };
  const h = await testHost(t, { billing, arc: { url: arcade.url, token: "tok", events: arcade.eventsUrl }, arcRetry: { min: 100, max: 500 } });
  const a = h.instance("a");
  h.instance("b");
  await h.router.start();
  const hostKey = h.router.providers.key("billing");
  const k = async (handle: string) => (await h.router.hydrate(handle)).kernel;
  const state = async (handle: string) => {
    const kk = await k(handle);
    const root = await kk.call("head", "billing") as CID | null;
    return root ? stateOf(await kk.store.get(root)) : undefined;
  };
  const entries = async (handle: string) => {
    const kk = await k(handle);
    const out: Array<Record<string, unknown>> = [];
    for (let c = await kk.store.log.tip(); c;) { const e = await kk.store.get(c) as Record<string, unknown>; out.unshift(e); c = (e.prev as CID | null) ?? undefined; }
    return out;
  };
  const lines = (handle: string) => h.lines.filter((l) => l.startsWith(`[${handle}]`));
  const tip = async (handle: string) => (await (await k(handle)).store.log.tip())!.toString();

  // b: no host row, on a host that bills — not served (a terms mismatch, #130).
  await h.router.hydrate("b");
  const rb = await fetch(`${h.base}/@b/anything`);
  assert.equal(rb.status, 402);
  assert.match((await rb.json() as { description: string }).description, /^no host row/);
  assert.equal(await state("b"), undefined);

  // a: no host row yet, so not served either. Its owner's host row is written here as a code genesis's owner
  // message would be, before the host bills (the gate holds the owner too: equiv/billing.ts sets it up
  // on a host that does not bill yet), then the host is started again with its pricing.
  await h.restart(undefined);
  await h.router.hydrate("a");
  await sendPlan({ port: h.router.port, owner: h.owner, settled: () => h.router.settled() }, "a", planHost(a, "add", { key: hostKey, x: billing.x, rates: billing.rates }));
  assert.equal(await state("a"), undefined, "a host that does not bill never wakes it: no billing state");
  assert.equal((await fetch(`${h.base}/.well-known/skein-host`).then((r) => r.json()) as { billing?: unknown }).billing, undefined, "and publishes no terms");
  await h.restart(billing);
  const published = await fetch(`${h.base}/.well-known/skein-host`).then((r) => r.json()) as { billing?: { key: string; x: number; rates: Rates; allowance: number } };
  assert.deepEqual([published.billing?.key, published.billing?.x, published.billing?.allowance], [hostKey, billing.x, billing.allowance]);

  // The first wake: billing starts on the host's allowance; no attestation rides on it (nothing owed yet).
  const started = await until("billing starts", async () => { await h.router.settled(); return await state("a"); });
  assert.deepEqual([started.host, started.allowance, started.paid], [hostKey, 1n, 0n]);
  assert.ok(lines("a").some((l) => /kernel billing: host .*: billing starts/.test(l)));
  const wake = (await entries("a")).at(-1)!;
  assert.equal(wake.attest, undefined, "the first wake owes nothing");

  // A request: its door verify and the bytes served are the host's external cost, attested on the next entry.
  assert.equal((await fetch(`${h.base}/@a/anything`)).status, 404);
  await h.router.settled();
  await h.router.admitEvent("a", "nobody", { kind: "probe", n: 1 }); // an event: no door, so nothing owed after it
  await h.router.settled();
  await h.router.admitEvent("a", "nobody", { kind: "probe", n: 2 });
  await h.router.settled();
  const es = await entries("a");
  const [e1, e2] = es.slice(-2) as Array<{ attest?: { fuel: number; served: number; log: CID; signature: Uint8Array } }>;
  assert.ok(e1!.attest && e1!.attest.fuel > 0 && e1!.attest.served > 0, "the entry after the request carries the host's attestation");
  assert.equal(e2!.attest, undefined, "nothing owed since: nothing attached");
  const periods = h.db.billingPeriods("a");
  assert.equal(periods.at(-1)!.log, e1!.attest!.log.toString(), "its log is the period record host.db keeps");
  assert.ok(lines("a").some((l) => /billing: the host attests \d+ fuel, \d+ bytes served/.test(l)), "the kernel took it");

  // Storage alone: the computed wake, due when the bytes kept × the time reach the allocation; the host wakes it then.
  const s0 = (await state("a"))!;
  assert.ok(s0.bytes > 0, "the kernel counts what it stores");
  const due = h.db.billing("a")!.due!;
  assert.ok(due >= dueAt(s0, billing.rates, 0n, 0)!, "host.db holds the computed wake (from the state last read)");
  const before = (await entries("a")).length;
  const asleep = await until("woken at the due time: asleep (no wallet to pay with)", async () => { await h.router.settled(); const s = await state("a"); return s?.asleep ? s : undefined; }, 30_000);
  const woke = (await entries("a")).slice(before);
  const wakeAt = (woke[0]!.time as [number, number])[0] * 1000 + Math.floor((woke[0]!.time as [number, number])[1] / 1e6);
  assert.ok(wakeAt >= due, `the wake came at its due time (${wakeAt} ≥ ${due})`);
  assert.ok(asleep.tally >= allocation(asleep));
  assert.ok(lines("a").some((l) => /billing: the genesis has no wallet program: nothing pays/.test(l)));

  // The gate: unpaid — a request is 402; a provider's message is not carried in; the instance's own message to itself is.
  const r = await fetch(`${h.base}/@a/anything`);
  assert.equal(r.status, 402);
  assert.match((await r.json() as { description: string }).description, /^unpaid/);
  await assert.rejects(h.router.cronEvent("a", "anything", {}), /not forwarded \(#130\)/);
  const self = Uint8Array.from(Buffer.from(a, "hex"));
  const loop = { kind: "mail", op: "put", sender: self, recipient: self, box: "nobody", body: encode({ hello: 1 }).cid, nonce: new Uint8Array(16) };
  assert.ok(await h.router.appendLocal("a", { kind: "message", message: loop, body: dagCbor.encode({ hello: 1 }) }), "the loopback passes the gate");
  await h.router.settled();
  assert.equal(await h.router.billingWake("a"), undefined, "no wake while the gate holds it");
  assert.ok(h.db.billing("a")!.asleep_since !== null);

  // Fundings: a body that is no Atomic BEEF, or one paying nothing to a's funding key, never reaches it.
  const tipBefore = await tip("a");
  assert.equal((await fetch(`${h.base}/fund/a`, { method: "POST", body: Buffer.from([1, 2, 3]) })).status, 400);
  const coin = new Transaction();
  coin.addInput({ sourceTXID: "11".repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex("51"), sequence: 0xffffffff });
  coin.addOutput({ lockingScript: new P2PKH().lock(new PrivateKey(41).toPublicKey().toHash()), satoshis: 5000 });
  coin.addOutput({ lockingScript: new P2PKH().lock(new PrivateKey(41).toPublicKey().toHash()), satoshis: 5000 });
  coin.addOutput({ lockingScript: new P2PKH().lock(new PrivateKey(41).toPublicKey().toHash()), satoshis: 5000 });
  coin.merklePath = new MerklePath(101, [[{ offset: 0, hash: coin.id("hex"), txid: true }]]);
  const funding = (vout: number, to: PublicKey) => {
    const tx = new Transaction();
    tx.addInput({ sourceTransaction: coin, sourceOutputIndex: vout, unlockingScript: UnlockingScript.fromHex("51"), sequence: 0xffffffff });
    tx.addOutput({ lockingScript: new P2PKH().lock(to.toHash() as number[]), satoshis: 4000 });
    return { beef: Buffer.from(tx.toAtomicBEEF()), txid: tx.id("hex") };
  };
  const junk = funding(0, new PrivateKey(42).toPublicKey());
  const rj = await fetch(`${h.base}/fund/a`, { method: "POST", body: junk.beef });
  assert.equal(rj.status, 400);
  assert.match((await rj.json() as { description: string }).description, /pays nothing to a's funding key/);
  assert.ok(!arcade.posts.some((x) => FakeArcade.txOf(x).id("hex") === junk.txid), "not broadcast");
  assert.equal(await tip("a"), tipBefore, "nothing reached the skein");
  // One Arcade rejects: refused, nothing reaches it.
  arcade.mode = "reject";
  const bad = funding(1, fundingKey(a));
  const rr = await fetch(`${h.base}/fund/a`, { method: "POST", body: bad.beef });
  assert.equal(rr.status, 400);
  assert.equal((await rr.json() as { code: string }).code, "ERR_FUNDING_REJECTED");
  assert.equal(await tip("a"), tipBefore, "a rejected funding never wakes it");
  // One Arcade takes: handed in on the funding row (a code genesis has none: its front door answers 404), past the gate.
  arcade.mode = "ok";
  const good = funding(2, fundingKey(a));
  const rg = await fetch(`${h.base}/fund/a`, { method: "POST", body: good.beef });
  assert.equal(rg.status, 404, "past the gate, to the instance (which has no funding row)");
  assert.ok(arcade.txs.has(good.txid), "broadcast first");
  assert.notEqual(await tip("a"), tipBefore, "the funding is an entry: it wakes the skein (its pay step tries again)");
  assert.equal((await fetch(`${h.base}/fund/nobody`, { method: "POST", body: good.beef })).status, 404);

  // The owner removes the host row: on a host that bills, that is no service at all (not free).
  await h.restart(undefined);
  // (The row as added: the kernel checks a host row's settings on a removal too, so `skein plan host remove`, which names the key only, is refused — reported on #130.)
  const removal = planHost(a, "add", { key: hostKey, x: billing.x, rates: billing.rates });
  (removal.messages[0]!.body as { op: string }).op = "remove";
  await sendPlan({ port: h.router.port, owner: h.owner, settled: () => h.router.settled() }, "a", removal);
  await h.restart(billing);
  await h.router.hydrate("a");
  const rn = await fetch(`${h.base}/@a/anything`);
  assert.equal(rn.status, 402);
  assert.match((await rn.json() as { description: string }).description, /^no host row/);
});

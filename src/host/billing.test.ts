// Billing (#130): the host's side (billing.ts) unit by unit — its config, the host row's terms and
// the mismatch, the kernel's state record as the host reads it, the gate's reason, the period's log
// record, host.db's bookkeeping (asleep since, the grace, payments), the owner's plan (`skein plan
// host`) — and, with the real Zig kernel, the meter and the gate on an instance with no wallet: its
// host row starts billing at the host's first tick; a tick from another key is refused; consumed ≥
// allocation with nothing to pay with is asleep, and then the host forwards nothing but a payment
// and the instance's own messages; an instance with no host row is untouched. (The whole loop —
// payments, the checkpoint, funding, waking — is kernel-zig/equiv/billing.ts.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKey, ProtoWallet } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { planHost } from "../client/admin.ts";
import { encode } from "../runtime/cid.ts";
import { sendPlan } from "../testapps.ts";
import { billingConfig, closedBy, DEV_BILLING, mismatch, NSAT, Period, periodRecord, priceHost, stateOf, termsOf, type BillingConfig } from "./billing.ts";
import { controlRequest, listenControl } from "./control.ts";
import { HostDb } from "./instances.ts";
import { KERNEL_BIN } from "./kernel.ts";
import { MESSAGE_KEY_ID, MESSAGE_PROTOCOL } from "./providers.ts";
import { testHost, until } from "./testhost.ts";

const key = (n: number) => new PrivateKey(n).toPublicKey().toString();

test("billing: the host's config — off, dev defaults, the environment over them, refusals", () => {
  assert.equal(billingConfig({ SKEIN_BILLING: "off" }), undefined);
  assert.deepEqual(billingConfig({}), DEV_BILLING);
  const c = billingConfig({ SKEIN_BILLING_X: "5", SKEIN_BILLING_RATES: JSON.stringify({ fuel: 7 }), SKEIN_BILLING_ALLOWANCE: "0", SKEIN_BILLING_TICK_MS: "1000" })!;
  assert.equal(c.x, 5);
  assert.equal(c.rates.fuel, 7);
  assert.equal(c.rates.storage, DEV_BILLING.rates.storage, "a rate the environment leaves is the default's");
  assert.equal(c.allowance, 0);
  assert.equal(c.tickMs, 1000);
  assert.throws(() => billingConfig({ SKEIN_BILLING_X: "0" }), /at least 1/);
  assert.throws(() => billingConfig({ SKEIN_BILLING_RATES: JSON.stringify({ fuels: 1 }) }), /a rate is one of/);
  assert.throws(() => billingConfig({ SKEIN_BILLING_ALLOWANCE: "-1" }), /whole number/);
});

test("billing: the host row's terms — the first tick row; the mismatch with what the host supports", () => {
  const host = key(11), other = key(12);
  const row = (k: string | Uint8Array, x: unknown, rates?: unknown) => ({ transport: "mailbox" as const, address: "billing", sender: typeof k === "string" ? Uint8Array.from(Buffer.from(k, "hex")) : k, program: "kernel" as const, fn: "tick", x, ...(rates ? { rates } : {}) });
  assert.equal(termsOf([]), undefined);
  assert.equal(termsOf([{ transport: "mailbox", address: "dispatch", sender: "*", program: "kernel", fn: "dispatch" }]), undefined);
  const t = termsOf([row(host, 300, { fuel: 2, publish: 9 }), row(other, 1)])!;
  assert.equal(t.host, host);
  assert.equal(t.x, 300);
  assert.deepEqual(t.rates, { fuel: 2, storage: 0, served: 0, fetch: 0, authfetch: 0, publish: 9 });
  assert.equal(termsOf([row(host, undefined)]), undefined, "no x: no terms");
  const cfg: BillingConfig = { ...DEV_BILLING, x: 300, rates: { fuel: 2, storage: 0, served: 0, fetch: 0, authfetch: 0, publish: 9 } };
  assert.equal(mismatch(cfg, host, t), undefined);
  assert.match(mismatch(cfg, other, t)!, /not this host's key/);
  assert.match(mismatch({ ...cfg, x: 301 }, host, t)!, /x 300 is below/);
  assert.match(mismatch({ ...cfg, rates: { ...cfg.rates, publish: 10 } }, host, t)!, /publish rate 9 is below/);
  assert.equal(mismatch({ ...cfg, x: 1 }, host, t), undefined, "more than the host asks is served");
});

test("billing: the kernel's state as the host reads it; allocation, the host's amounts, the gate's reason", () => {
  const host = key(11);
  const rec = { kind: "billing", host: Uint8Array.from(Buffer.from(host, "hex")), allowance: 40, paid: 150, tally: 9_007_199_254_740_993n, lastTick: 5, ticks: 2, tick: encode("x").cid, bytes: 4096, payments: 1, asleep: false };
  const s = stateOf(dagCbor.decode(dagCbor.encode(rec)))!;
  assert.equal(s.host, host);
  assert.equal(s.tally, 9_007_199_254_740_993n, "a tally past 2^53 nanosats is a bigint");
  assert.equal(s.allowance + s.paid, 190n);
  assert.equal(stateOf({ ...rec, kind: "other" }), undefined);
  assert.equal(stateOf({ ...rec, asleep: "no" }), undefined);
  assert.equal(priceHost({ fuel: 2, storage: 0, served: 3, fetch: 0, authfetch: 0, publish: 0 }, 1_000_000_000, 1_000_000), 5n * NSAT, "two sats of read fuel and three of bytes served (billing.zig priceHost)");
  const terms = termsOf([{ transport: "mailbox", address: "billing", sender: Uint8Array.from(Buffer.from(host, "hex")), program: "kernel", fn: "tick", x: 5 }])!;
  assert.equal(closedBy(undefined, "u"), undefined, "no view: open");
  assert.equal(closedBy({}, "u"), undefined, "no host row: open (not billed)");
  assert.equal(closedBy({ terms, state: s }, "u"), undefined);
  assert.match(closedBy({ terms, state: { ...s, asleep: true } }, "http://h/fund/a")!, /^asleep: .*POST http:\/\/h\/fund\/a/);
  assert.match(closedBy({ terms, mismatch: "x 1 is below this host's 5" }, "u")!, /does not serve these terms/);
  assert.equal(closedBy({ terms, state: { ...s, host: key(12), asleep: true } }, "u"), undefined, "another host's state is not this host's to gate on");
});

test("billing: the period's log record — what the tick commits to (its CID)", () => {
  const p = new Period(100);
  assert.ok(p.empty);
  p.add({ at: 101, op: "GET /explore", caller: key(13), fuel: 500, bytes: 20 });
  p.add({ at: 102, op: "GET /nothing", fuel: 0, bytes: 7 });
  assert.equal(p.fuel, 500);
  assert.equal(p.served, 27);
  const r = periodRecord(key(14), p, 103);
  assert.equal(r.cid.toString(), encode(r.record).cid.toString());
  const back = dagCbor.decode(r.bytes) as { kind: string; from: number; to: number; lines: Array<{ caller?: Uint8Array }> };
  assert.equal(back.kind, "host-log");
  assert.deepEqual([back.from, back.to, back.lines.length], [100, 103, 2]);
  assert.ok(back.lines[0]!.caller instanceof Uint8Array && !("caller" in back.lines[1]!));
});

test("billing: host.db — asleep since the first time seen, the grace, payments once", () => {
  const dir = mkdtempSync(join(tmpdir(), "skein-billing-"));
  try {
    const db = new HostDb(join(dir, "host.db"));
    db.setBilling("a", { host: key(1), tally: 5n, allocation: 4n, asleep: true }, 1000);
    db.setBilling("a", { host: key(1), tally: 6n, allocation: 4n, asleep: true }, 5000);
    assert.equal(db.billing("a")!.asleep_since, 1000, "asleep since the first time seen");
    assert.equal(db.billing("a")!.tally, "6");
    db.setBilling("b", { host: key(1), asleep: false }, 1000);
    assert.equal(db.billing("b")!.asleep_since, null);
    assert.deepEqual(db.reclaimable(1500, 1000).map((r) => r.instance), [], "within the grace");
    assert.deepEqual(db.reclaimable(2000, 1000).map((r) => r.instance), ["a"], "past it");
    db.setBilling("a", { host: key(1), asleep: false }, 6000);
    assert.equal(db.billing("a")!.asleep_since, null, "awake: cleared");
    assert.deepEqual(db.reclaimable(1e12, 0), []);
    const p = { instance: "a", txid: "ab".repeat(32), amount: 150, at: 7, beef: new Uint8Array([1, 2]), remittance: { derivationPrefix: "p" }, ours: true, checkpoint: "bafy" };
    assert.equal(db.billingPayment(p), true);
    assert.equal(db.billingPayment(p), false, "a payment is taken once");
    assert.deepEqual(db.billingPayments("a").map((x) => [x.amount, x.ours, x.checkpoint]), [[150, true, "bafy"]]);
    db.billingTick("a", 9, "bafylog", new Uint8Array([3]));
    assert.deepEqual(db.billingTicks("a").map((x) => [x.at, x.log]), [[9, "bafylog"]]);
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
  assert.deepEqual([row.transport, row.address, row.program, row.fn, row.x, row.rates], ["mailbox", "billing", "kernel", "tick", 300, { fuel: 2 }]);
  assert.equal(Buffer.from(row.sender as Uint8Array).toString("hex"), host);
  assert.equal((planHost(me, "remove", { key: host, x: 1 }).messages[0]!.body as { row: { x?: number } }).row.x, undefined, "a removal names the row's key only");
  assert.throws(() => planHost(me, "add", { key: "nope", x: 1 }), /not the host's key/);
  assert.throws(() => planHost(me, "add", { key: host, x: 0 }), /x:/);
});

test("billing: the meter and the gate with the real kernel — no wallet to pay with: asleep; a stranger's tick refused; no host row untouched", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  // An allowance of 0: the first entry after billing starts consumes it, and a code genesis has no wallet program.
  const billing: BillingConfig = { ...DEV_BILLING, x: 10, allowance: 0, tickMs: 3_600_000 };
  const h = await testHost(t, { billing });
  const a = h.instance("a");
  h.instance("b");
  await h.router.start();
  await h.router.hydrate("a");
  await h.router.hydrate("b");
  const hostKey = h.router.providers.key("billing");
  const state = async (handle: string) => {
    const k = (await h.router.hydrate(handle)).kernel;
    const root = await k.call("head", "billing") as CID | null;
    return root ? stateOf(await k.store.get(root)) : undefined;
  };
  const lines = (handle: string) => h.lines.filter((l) => l.startsWith(`[${handle}]`));

  // The owner's host row; the host ticks at once; billing starts; the first entry after it consumes the allowance (0): asleep.
  await sendPlan({ port: h.router.port, owner: h.owner, settled: () => h.router.settled() }, "a", planHost(a, "add", { key: hostKey, x: billing.x, rates: billing.rates }));
  const asleep = await until("asleep", async () => { await h.router.settled(); const s = await state("a"); return s?.asleep ? s : undefined; });
  assert.equal(asleep.host, hostKey);
  assert.equal(asleep.allowance, 0n);
  assert.equal(asleep.paid, 0n);
  assert.ok(asleep.tally > 0n, "the steps' fuel since billing started is on the tally");
  assert.ok(lines("a").some((l) => /billing: the genesis has no wallet program: nothing pays/.test(l)));
  assert.match(h.router.closed("a")!, /^asleep/);
  assert.ok(h.db.billing("a")!.asleep_since !== null);

  // The gate: a request is 402; a provider's message is not carried in; the instance's own message to itself is.
  const r = await fetch(`${h.base}/@a/anything`);
  assert.equal(r.status, 402);
  assert.equal((await r.json() as { code: string }).code, "ERR_PAYMENT_REQUIRED");
  await assert.rejects(h.router.cronEvent("a", "anything", {}), /not forwarded \(#130\)/);
  const self = Uint8Array.from(Buffer.from(a, "hex"));
  const bodyBytes = dagCbor.encode({ hello: 1 });
  const loop = { kind: "mail", op: "put", sender: self, recipient: self, box: "nobody", body: encode({ hello: 1 }).cid, nonce: new Uint8Array(16) };
  assert.ok(await h.router.appendLocal("a", { kind: "message", message: loop, body: bodyBytes }), "the loopback passes the gate");
  // Frozen: what it used asleep is not metered.
  await h.router.settled();
  assert.equal((await state("a"))!.tally, asleep.tally, "the tally is frozen while asleep");
  // No tick is sent to it.
  assert.equal(await h.router.billingTick("a"), undefined);
  // The funding endpoint reaches it even so (a code genesis has no funding row: its front door answers 404).
  const f = await fetch(`${h.base}/fund/a`, { method: "POST", headers: { "x-skein-outputs": "[]" }, body: Buffer.from([1, 2, 3]) });
  assert.equal(f.status, 404, "past the gate, to the instance (which has no funding row)");
  assert.equal((await fetch(`${h.base}/fund/a`, { method: "POST", body: Buffer.from([1]) })).status, 400, "a funding names its outputs");
  assert.equal((await fetch(`${h.base}/fund/nobody`, { method: "POST", headers: { "x-skein-outputs": "[]" }, body: Buffer.from([1]) })).status, 404);

  // b: no host row — no billing state, served, nothing in host.db; a tick signed by a stranger finds no row there.
  assert.equal(await state("b"), undefined);
  assert.equal((await fetch(`${h.base}/@b/anything`)).status, 404);
  assert.equal(h.db.billing("b"), undefined);
  const stranger = new PrivateKey(77);
  const tick = { kind: "tick", at: Date.now(), allowance: 1_000_000, fuel: 0, served: 0 };
  const unsigned = { kind: "mail", op: "put", sender: Uint8Array.from(Buffer.from(stranger.toPublicKey().toString(), "hex")), recipient: Uint8Array.from(Buffer.from(h.db.get("b")!.identity!, "hex")), box: "billing", body: encode(tick).cid, nonce: new Uint8Array(16) };
  const { signature } = await new ProtoWallet(stranger).createSignature({ protocolID: MESSAGE_PROTOCOL, keyID: MESSAGE_KEY_ID, counterparty: "anyone", data: [...dagCbor.encode(unsigned)] });
  await h.router.appendLocal("b", { kind: "message", message: { ...unsigned, signature: Uint8Array.from(signature) }, body: dagCbor.encode(tick) });
  await h.router.settled();
  assert.equal(await state("b"), undefined, "no host row: a tick runs nothing");
  assert.ok(lines("b").some((l) => /in billing from .*: no dispatch row; recorded, nothing runs/.test(l)));
});

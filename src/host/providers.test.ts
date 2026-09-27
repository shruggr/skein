// Providers per interface: the runtime takes finished, host-signed entries
// through `admit` from whatever delivers them. Here a mock delivery with no
// messagebox (and no wire encryption: the signed part and the plaintext are
// all an entry needs), a second provider racing it, entries the runtime must
// refuse, and the tick provider on a real timer.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { contentHash, open, sign, signedPart, verify, type Envelope, type Signed } from "../envelope.ts";
import { faultyHub, instance, iso, messageBoxHub, noAccount, results, T0, type Instance } from "../testkit.ts";
import { encode } from "../runtime/cid.ts";
import { nextEntry, readLog, verifyEntry } from "../runtime/log.ts";
import { PROGRAM_CIDS } from "../runtime/programs.ts";
import { Rejected } from "../runtime/store.ts";
import type { Outbound } from "../runtime/scheduler.ts";
import type { ThreadUpdate } from "../runtime/types.ts";
import { admitEntry, signEntry } from "./entry.ts";
import { Delivery, sendFailure } from "./messagebox.ts";

/** A delivery with no transport: the owner's signed part and body, straight into the runtime. */
async function deliver(i: Instance, box: string, value: unknown): Promise<{ signed: Signed; body: Uint8Array; entry: CID }> {
  const body = dagCbor.encode(value);
  const signed = await sign(i.owner.wallet, { recipient: { identityKey: i.identity, handle: "skein", domain: "localhost" }, body, created: iso(i.clock.now()) });
  const entry = await admitEntry(i.rt, i.host.wallet, { envelope: encode(signed).cid, box, body: encode(value).cid }, { envelope: signed, body }, i.clock.now());
  return { signed, body, entry };
}

test("mock delivery: a host-signed entry admitted with no messagebox runs its handler; the emit reaches the mock outbox", async () => {
  const i = await instance();
  const sent: Outbound[] = [];
  i.rt.outbox = { send: (o) => { sent.push(o); } };
  const { signed, entry } = await deliver(i, "run", { cmd: "echo hi", tree: encode({}).cid });
  await i.rt.idle();
  const [, e] = await readLog(i.store);
  assert.ok(e.cid.equals(entry) && verifyEntry(e.entry, i.host.identity));
  assert.ok(e.entry.envelope!.equals(encode(signedPart(signed)).cid));
  const [h] = await (async () => { const o: CID[] = []; for await (const t of i.store.edges.query({ kind: "thread", program: PROGRAM_CIDS["run-handler"] })) o.push(t); return o; })();
  assert.ok(h, i.lines.join("\n"));
  assert.equal(sent.length, 1, "run-handler replied");
  assert.equal(sent[0].box, "results");
  assert.equal(sent[0].to, i.owner.identity);
  const env = sent[0].envelope as unknown as Envelope, bytes = await i.store.bytes(sent[0].body);
  assert.equal(env.contentHash, contentHash(bytes), "the reply's signed part carries its body's hash");
  assert.ok(verify(env) && env.sender.identityKey === i.identity, "signed by the instance, in the step");
  assert.deepEqual((await open(i.owner.wallet, env)).body, bytes, "encrypted to the owner in the step: the outbox gets it complete");
  assert.ok(encode(signedPart(env)).cid.equals(sent[0].cid), "the message id is its signed part's CID");
  await i.rt.stop();
});

test("admit: refuses an entry not signed by the genesis's host, records that do not match, a genesis, and a stale tip; two providers racing both get in", async () => {
  const i = await instance();
  const value = { name: "x" };
  const body = dagCbor.encode(value);
  const signed = await sign(i.owner.wallet, { recipient: { identityKey: i.identity, handle: "skein", domain: "localhost" }, body, created: iso(T0) });
  const env = { envelope: encode(signed).cid, box: "mail", body: encode(value).cid };

  // Signed by the instance wallet, not the host: the runtime refuses it.
  const byInstance = await signEntry(i.wallet, await nextEntry(i.store, env, T0));
  await assert.rejects(i.rt.admit(byInstance, { envelope: signed, body }), (e) => e instanceof Rejected && e.reason === "bad-signature");
  // Host-signed, but the records are not the ones it names.
  const good = await signEntry(i.host.wallet, await nextEntry(i.store, env, T0));
  await assert.rejects(i.rt.admit(good, { envelope: signed, body: dagCbor.encode({ name: "y" }) }), /contentHash/);
  await assert.rejects(i.rt.admit(good, {}), /needs its envelope and body/);
  await assert.rejects(i.rt.admit({ ...good, envelope: undefined, body: undefined, box: undefined, genesis: env.body }), /want a signed envelope, wake or outcome entry/);
  assert.equal((await readLog(i.store)).length, 1, "nothing admitted");

  // A wake built on a tip that has since moved: out of order.
  const stale = await signEntry(i.host.wallet, await nextEntry(i.store, { wake: encode({}).cid }, T0));
  await i.rt.admit(good, { envelope: signed, body });
  await assert.rejects(i.rt.admit(stale), (e) => e instanceof Rejected && e.reason === "out-of-order");

  // Two providers at once (the delivery and the tick): each re-signs on the new tip and gets in.
  const [a, b] = await Promise.all([
    admitEntry(i.rt, i.host.wallet, { wake: encode({ a: 1 }).cid }, {}, T0),
    admitEntry(i.rt, i.host.wallet, { wake: encode({ b: 1 }).cid }, {}, T0),
  ]);
  const log = await readLog(i.store);
  assert.deepEqual(log.map(({ entry }) => entry.n), [0, 1, 2, 3]);
  assert.ok(log.some(({ cid }) => cid.equals(a)) && log.some(({ cid }) => cid.equals(b)));
  for (const { entry } of log) assert.ok(verifyEntry(entry, i.host.identity));
  await i.rt.stop();
});

test("tick: started, it reads the next deadline and admits one host-signed wake when it comes; then nothing more", async () => {
  const i = await instance();
  i.tick.start();
  await deliver(i, "run", { cmd: "sleep 2; echo up", tree: encode({}).cid });
  await i.rt.idle();
  const [{ until }] = i.rt.sleepersDue();
  i.clock.set([Math.ceil(until / 1000) + 1, 0]); // the host's clock passes the deadline
  i.tick.schedule();
  for (let n = 0; n < 200 && i.rt.sleeping; n++) await new Promise((r) => setTimeout(r, 10));
  await i.rt.idle();
  const log = await readLog(i.store);
  const wakes = log.filter(({ entry }) => entry.wake);
  assert.equal(wakes.length, 1, i.lines.join("\n"));
  assert.ok(verifyEntry(wakes[0].entry, i.host.identity));
  const [sh] = await (async () => { const o: CID[] = []; for await (const t of i.store.edges.query({ kind: "thread", program: PROGRAM_CIDS.shell })) o.push(t); return o; })();
  assert.equal((await i.store.get<ThreadUpdate>(await i.store.chains.tip(sh))).state, "finished");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await readLog(i.store)).filter(({ entry }) => entry.wake).length, 1, "no idle ticks");
  await i.tick.stop();
  await i.rt.stop();
});

// ---------------------------------------------------------------- outcomes (#10)

const outcomes = async (i: Instance) => (await readLog(i.store)).filter(({ entry }) => entry.outcome).map(({ entry }) => entry.outcome!);

test("outcome: success is one `delivered` entry, host-signed, naming the emit; the runtime refuses a second outcome for it, or one for a record that is not an emit", async () => {
  const i = await instance();
  await deliver(i, "run", { cmd: "echo hi", tree: encode({}).cid });
  await i.rt.idle();
  const log = await readLog(i.store);
  const last = log.at(-1)!;
  assert.equal(last.entry.outcome?.status, "delivered", i.lines.join("\n"));
  assert.equal(last.entry.outcome?.reason, undefined);
  assert.ok(verifyEntry(last.entry, i.host.identity), "the host's word, like a wake");
  const [th] = await (async () => { const o: CID[] = []; for await (const t of i.store.edges.query({ kind: "thread", program: PROGRAM_CIDS["run-handler"] })) o.push(t); return o; })();
  const tip = await i.store.get<ThreadUpdate & { emits: CID[] }>(await i.store.chains.tip(th));
  assert.ok(last.entry.outcome!.emit.equals(tip.emits[0]));
  assert.ok((await i.store.log.outcomeOf(tip.emits[0]))!.equals(last.cid));
  assert.equal((await results(i)).length, 1);
  await assert.rejects(admitEntry(i.rt, i.host.wallet, { outcome: { emit: tip.emits[0], status: "failed", reason: "late" } }, {}, T0), (e) => e instanceof Rejected && e.reason === "duplicate-outcome");
  await assert.rejects(admitEntry(i.rt, i.host.wallet, { outcome: { emit: th, status: "delivered" } }, {}, T0), /not an emit/);
  assert.equal((await outcomes(i)).length, 1);
  await i.rt.stop();
});

test("outcome: transient failures are retried after a backoff, then `delivered` once; past the attempts they are `failed`; a permanent refusal fails at once; nothing awaits a run's reply, so nothing runs", async () => {
  // Down twice (no HTTP answer), then up.
  let down = 2;
  const hub = faultyHub(messageBoxHub(), (m) => m.box === "results" && down-- > 0 ? new Error("Failed to send message.") : undefined);
  const i = await instance({ hub });
  await deliver(i, "run", { cmd: "echo hi", tree: encode({}).cid });
  await i.rt.idle();
  assert.deepEqual(await outcomes(i), [], "not yet: queued");
  assert.equal(i.delivery.pending, 1);
  await i.delivery.poll();
  assert.equal(hub.sent.get(i.owner.identity), 1, "not due before its backoff (1 s)");
  i.clock.set([T0[0] + 1, T0[1]]);
  await i.delivery.poll();
  assert.equal(hub.sent.get(i.owner.identity), 2);
  i.clock.set([T0[0] + 2, T0[1]]);
  await i.delivery.poll();
  assert.equal(hub.sent.get(i.owner.identity), 2, "the second backoff is 2 s");
  i.clock.set([T0[0] + 3, T0[1]]);
  await i.delivery.poll();
  await i.rt.idle();
  assert.equal(hub.sent.get(i.owner.identity), 3);
  assert.deepEqual((await outcomes(i)).map((o) => o.status), ["delivered"], i.lines.join("\n"));
  assert.equal((await results(i)).length, 1);
  assert.equal(i.delivery.pending, 0);
  await i.rt.stop();

  // Always down, two attempts allowed: `failed`, saying so.
  const hub2 = faultyHub(messageBoxHub(), (m) => m.box === "results" ? Object.assign(new Error("bad gateway"), { status: 502 }) : undefined);
  const j = await instance({ hub: hub2 });
  const d = new Delivery({ runtime: j.rt, wallet: j.wallet, host: j.host.wallet, box: hub2.as(j.identity), now: j.clock.now, retry: { attempts: 2, backoffMs: 0 }, log: (l) => j.lines.push(l) });
  j.rt.outbox = d;
  await deliver(j, "run", { cmd: "echo hi", tree: encode({}).cid });
  await j.rt.idle();
  await d.poll();
  await j.rt.idle();
  const [o] = await outcomes(j);
  assert.deepEqual([o.status, o.reason], ["failed", "bad gateway (gave up after 2 attempts)"], j.lines.join("\n"));
  await d.poll();
  assert.equal(hub2.sent.get(j.owner.identity), 2, "no retry after `failed`");
  assert.ok(j.lines.some((l) => /outcome failed for emit .*: no thread awaits it; recorded, nothing runs/.test(l)), j.lines.join("\n"));
  await j.rt.stop();

  // No account: failed at the first attempt.
  const hub3 = faultyHub(messageBoxHub(), (m) => m.box === "results" ? noAccount() : undefined);
  const k = await instance({ hub: hub3 });
  await deliver(k, "run", { cmd: "echo hi", tree: encode({}).cid });
  await k.rt.idle();
  assert.deepEqual((await outcomes(k)).map((x) => [x.status, x.reason]), [["failed", "Message Box send failed with HTTP 403 (ERR_ACCOUNT_REQUIRED)."]]);
  assert.equal(k.delivery.pending, 0);
  await k.rt.stop();
});

test("sendFailure: 4xx is permanent except 408/425/429; 5xx, 429 and no answer are transient; a request the client cannot make is permanent", () => {
  const f = (m: string, status?: number) => sendFailure(Object.assign(new Error(m), status ? { status } : {})).permanent;
  assert.equal(f("Message Box send failed with HTTP 403 (ERR_ACCOUNT_REQUIRED)."), true);
  assert.equal(f("Message Box send failed with HTTP 400."), true);
  assert.equal(f("Message Box send failed with HTTP 429."), false);
  assert.equal(f("Message Box send failed with HTTP 408."), false);
  assert.equal(f("Message Box send failed with HTTP 503."), false);
  assert.equal(f("Failed to send message."), false);
  assert.equal(f("nope", 404), true);
  assert.equal(f("nope", 500), false);
  assert.equal(sendFailure(new TypeError("Encrypted Message Box body must not exceed 1 bytes")).permanent, true);
});

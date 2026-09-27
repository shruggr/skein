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
import { instance, iso, T0, type Instance } from "../testkit.ts";
import { encode } from "../runtime/cid.ts";
import { nextEntry, readLog, verifyEntry } from "../runtime/log.ts";
import { PROGRAM_CIDS } from "../runtime/programs.ts";
import { Rejected } from "../runtime/store.ts";
import type { Outbound } from "../runtime/scheduler.ts";
import type { ThreadUpdate } from "../runtime/types.ts";
import { admitEntry, signEntry } from "./entry.ts";

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
  await assert.rejects(i.rt.admit({ ...good, envelope: undefined, body: undefined, box: undefined, genesis: env.body }), /want a signed envelope or wake entry/);
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

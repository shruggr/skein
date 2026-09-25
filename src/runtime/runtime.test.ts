// The runtime's own stamps and signatures: the log as a hash chain of entries
// signed by the instance identity; pure time and randomness inside a thread.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKey } from "@bsv/sdk";
import { bundlesOf, instance, results, send, T0 } from "../testkit.ts";
import { encode } from "./cid.ts";
import { anyoneKey } from "./identity.ts";
import { appendEntry, copyLog, entryBytes, LOG_KEY_ID, LOG_PROTOCOL, readLog, verifyEntry } from "./log.ts";
import { memoryStore } from "./memory.ts";
import { openStore } from "./sqlite.ts";
import { stampNs, ThreadClock } from "./syscalls.ts";
import type { LogEntry, Store } from "./store.ts";
import { ephemeralWallet } from "../wallet.ts";

const text = (b: unknown) => Buffer.from(b as Uint8Array).toString("utf8");

test("log: entries chain, are stamped (never backwards) and signed by the instance identity; tampering shows", async () => {
  const i = await instance();
  const env = await send(i, "run", { cmd: "true", tree: encode({}).cid });
  i.clock.set([T0[0] - 100, 0]); // an earlier clock reading…
  await i.edge.poll();
  await i.rt.idle();
  const log = await readLog(i.store);
  assert.equal(log.length, 2);
  assert.equal(log[0].entry.prev, null);
  assert.ok(log[1].entry.prev!.equals(log[0].cid));
  assert.deepEqual(log[1].entry.n, 1);
  assert.deepEqual(log[1].entry.time, T0, "…is raised to the previous stamp");
  assert.ok(log[1].entry.envelope!.equals(encode(env).cid));

  for (const { entry } of log) {
    assert.ok(verifyEntry(entry, i.identity));
    // The scheme, from @bsv/sdk alone: the "anyone" child of the identity key under [2, "skein log"], key "1".
    const { Signature } = await import("@bsv/sdk");
    assert.ok(anyoneKey(i.identity, LOG_PROTOCOL, LOG_KEY_ID).verify([...entryBytes(entry)], Signature.fromDER([...entry.sig])));
  }
  const e = log[1].entry;
  for (const bad of [{ ...e, box: "objects" }, { ...e, time: [e.time[0] + 1, 0] }, { ...e, n: 2 }, { ...e, sig: new Uint8Array(e.sig).fill(1, 10, 12) }] as LogEntry[]) {
    assert.equal(verifyEntry(bad, i.identity), false);
  }
  assert.equal(verifyEntry(e, PrivateKey.fromRandom().toPublicKey().toString()), false, "another identity's key");

  // The store refuses an entry that does not extend the tip, and a second admission of an envelope.
  await assert.rejects(i.store.log.append({ ...e }), /already admitted/);
  await assert.rejects(i.store.log.append({ kind: "log", prev: log[0].cid, n: 1, time: T0, wake: encode({}).cid, sig: e.sig }), /does not extend the tip/);
  await assert.rejects(appendEntry(i.store, i.wallet, { envelope: e.envelope!, box: "run", key: e.key! }), /already admitted/);

  // copyLog verifies every signature; a store holding a forged entry does not copy.
  const fresh = memoryStore();
  await copyLog(i.store, fresh);
  assert.ok((await fresh.log.tip())!.equals((await i.store.log.tip())!));
  const forged = memoryStore();
  await copyLog(i.store, forged);
  const other = await appendEntry(forged, ephemeralWallet(), { wake: encode({}).cid });
  assert.ok(other);
  await assert.rejects(copyLog(forged, memoryStore()), /bad signature/);
  await i.rt.stop();
});

test("log: the sqlite store keeps the same chain", async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), "skein-log-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const s: Store = openStore(join(dir, "db"));
  const i = await instance();
  await copyLog(i.store, s);
  await s.close();
  const again = openStore(join(dir, "db"));
  assert.ok((await again.log.tip())!.equals((await i.store.log.tip())!));
  assert.ok(await again.log.byEnvelope(encode({ nope: 1 }).cid) === undefined);
  await again.close();
  await i.rt.stop();
});

test("clock: consecutive reads differ by exactly 1 ns; the base only moves forward", () => {
  const c = new ThreadClock();
  c.drive(1_000n);
  assert.equal(c.read(), 1_000n);
  assert.equal(c.read(), 1_001n);
  assert.equal(c.read(), 1_002n);
  c.drive(500n); // an older entry cannot move time back
  assert.equal(c.read(), 1_003n);
  c.drive(2_000n);
  assert.equal(c.peek(), 2_000n);
  assert.equal(c.read(), 2_000n);
  assert.equal(c.read(), 2_001n);
});

test("time and random inside: the run entry's stamp is now, +1 ns per read; $RANDOM from the entry", async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), "skein-rt-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(join(dir, "README"), "hello\n");
  const i = await instance();
  const { root, bundles } = await bundlesOf(dir);
  for (const b of bundles) await send(i, "objects", b);
  i.clock.set([1_790_000_123, 400_000_000]);
  await send(i, "run", { cmd: "date -u +%s; ls; echo $RANDOM; echo $RANDOM; date +%s%N; date +%s%N", tree: root });
  await i.edge.poll();
  await i.rt.idle();
  const [{ body }] = await results(i);
  const out = text(body.stdout).trim().split("\n");
  t.diagnostic(JSON.stringify(out));
  assert.equal(body.exitCode, 0, text(body.stderr));
  assert.equal(out[0], "1790000123");
  assert.equal(out[1], "README");
  assert.notEqual(out[2], out[3]);
  const [n1, n2] = [BigInt(out[4]), BigInt(out[5])];
  assert.ok(n1 >= stampNs([1_790_000_123, 400_000_000]));
  assert.equal(n2 - n1, 1n);
  await i.rt.stop();
});

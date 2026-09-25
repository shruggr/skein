// The message layer end to end, in process: the owner's client seals envelopes
// into a fake messagebox; the edge screens and admits them with their message
// keys; subscriptions route them to the Go handler programs; run-handler
// decrypts purely, reveals (signed), runs the shell, and replies in `results`;
// objects-handler stores a directory's git objects. Then: restart mid-handler,
// and replay with no wallet at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { envelopeCid } from "../client/client.ts";
import { seal } from "../envelope.ts";
import { bundlesOf, collect, installWasm, instance, iso, results, send, T0, type Instance } from "../testkit.ts";
import { ephemeralWallet } from "../wallet.ts";
import { encode, fmt } from "./cid.ts";
import { verifyAnyone } from "./identity.ts";
import { appendEntry, copyLog, readLog, verifyEntry } from "./log.ts";
import { memoryStore } from "./memory.ts";
import { PROGRAM_CIDS } from "./programs.ts";
import type { Attested } from "./records.ts";
import { REVEAL_KEY_ID, REVEAL_PROTOCOL, Runtime, witnessFrom, type Outbound } from "./scheduler.ts";
import type { Store } from "./store.ts";
import type { ThreadOrigin, ThreadUpdate } from "./types.ts";

const text = (b: unknown) => Buffer.from(b as Uint8Array).toString("utf8");

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await fs.mkdtemp(join(tmpdir(), "skein-h-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(join(dir, "src"));
  await fs.writeFile(join(dir, "src/a.txt"), "alpha\n");
  await fs.writeFile(join(dir, "README"), "hello\n");
  return dir;
}

async function threads(store: Store): Promise<CID[]> {
  return (await collect(store.edges.query({ kind: "thread" }))).reverse();
}
async function history(store: Store, thread: CID): Promise<ThreadUpdate[]> {
  const out: ThreadUpdate[] = [];
  for await (const c of store.chains.history(thread)) if (!c.equals(thread)) out.push(await store.get<ThreadUpdate>(c));
  return out;
}
const tipOf = async (store: Store, th: CID) => store.get<ThreadUpdate>(await store.chains.tip(th));
async function byProgram(store: Store, name: keyof typeof PROGRAM_CIDS): Promise<CID[]> {
  return collect(store.edges.query({ kind: "thread", program: PROGRAM_CIDS[name] }));
}

/** Import `dir` (objects) and run `cmd` over it, as the client does; process everything. */
async function importAndRun(i: Instance, dir: string, cmd: string): Promise<{ root: CID; run: CID }> {
  const { root, bundles } = await bundlesOf(dir);
  for (const b of bundles) await send(i, "objects", b);
  const env = await send(i, "run", { cmd, tree: root });
  await i.edge.poll();
  await i.rt.idle();
  return { root, run: await envelopeCid(env) };
}

/** Replay: the log alone into a fresh store, a runtime with NO wallet, answers from the witness. Every chain must match. */
async function replayMatches(store: Store): Promise<Outbound[]> {
  const fresh = memoryStore();
  await installWasm(fresh);
  await copyLog(store, fresh);
  assert.ok((await fresh.log.tip())!.equals((await store.log.tip())!), "identical chain of inputs");
  const sent: Outbound[] = [];
  const rt = new Runtime({ store: fresh, witness: await witnessFrom(store), outbox: { send: (o) => { sent.push(o); } } });
  await rt.start();
  await rt.idle();
  const ths = await threads(store);
  assert.ok(ths.length > 0);
  for (const o of ths) assert.ok((await fresh.chains.tip(o)).equals(await store.chains.tip(o)), `thread ${fmt(o)} replays to the same tip`);
  await rt.stop();
  return sent;
}

test("run-handler: sealed run → messagebox → admitted with its key → decrypted purely → reveal signed → shell → result envelope to the owner", async (t) => {
  const dir = await fixture(t);
  const i = await instance();
  const { root, run } = await importAndRun(i, dir, "cat README; ls | head -3; date -u +%s");
  t.diagnostic(i.lines.join("\n"));

  // The owner's results box: one envelope from the instance, which the owner opens.
  const rs = await results(i);
  assert.equal(rs.length, 1);
  const [{ env, body }] = rs;
  assert.equal(env.sender.identityKey, i.identity);
  assert.equal(body.exitCode, 0, text(body.stderr));
  assert.equal(text(body.stdout), `hello\nREADME\nsrc\n${T0[0]}\n`, "the shell saw the imported tree and the run entry's stamp");
  assert.ok((body.replyTo as CID).equals(run), "replyTo is the run envelope's CID as the client computes it");
  assert.ok((body.tree as CID).equals(root), "nothing written: the tree is unchanged");

  // The log: genesis, the objects envelope, the run envelope — each signed by the instance.
  const log = await readLog(i.store);
  assert.deepEqual(log.map(({ entry }) => entry.genesis ? "genesis" : entry.box), ["genesis", "objects", "run"]);
  for (const { entry } of log) assert.ok(verifyEntry(entry, i.identity), `entry #${entry.n} verifies against the instance identity`);
  const runEntry = log[2].entry;
  assert.ok(runEntry.envelope!.equals(run), "the envelope record's CID is the client's envelope CID");
  const key = await i.store.get<{ kind: string; envelope: CID; key: Uint8Array }>(runEntry.key!);
  assert.equal(key.kind, "message-key");
  assert.equal(key.key.length, 32);

  // The handler thread: step 1 reveals and launches the shell; step 2 emits.
  const [h] = await byProgram(i.store, "run-handler");
  const steps = await history(i.store, h);
  assert.deepEqual(steps.map((u) => u.state), ["waiting", "finished"]);
  const [s1, s2] = steps as Array<ThreadUpdate & { calls?: CID[]; reveals?: CID[]; launched?: CID[]; emits?: CID[] }>;
  assert.equal(s1.reveals!.length, 1);
  const reveal = await i.store.get(s1.reveals![0]) as Record<string, unknown>;
  assert.deepEqual({ ...reveal, of: String(reveal.of), tree: String(reveal.tree) }, { kind: "reveal", of: String(run), cmd: "cat README; ls | head -3; date -u +%s", tree: String(root) });
  const [call] = await Promise.all(s1.calls!.map((c) => i.store.get<Attested>(c)));
  assert.equal(call.op, "reveal", "the only attested call is the reveal signature: decryption is pure");
  assert.ok(verifyAnyone(i.identity, REVEAL_PROTOCOL, REVEAL_KEY_ID, await i.store.bytes(s1.reveals![0]), call.result), "the reveal is signed by the instance identity");
  const shell = await i.store.get<ThreadOrigin>(s1.launched![0]);
  assert.ok(shell.program.equals(PROGRAM_CIDS.shell) && shell.launchedBy!.equals(h));
  assert.ok(encode(shell.args).cid.equals(s1.reveals![0]), "the shell runs on exactly the revealed record");
  assert.equal(s2.emits!.length, 1);
  assert.equal(i.hub.pending(i.identity, "run").length + i.hub.pending(i.identity, "objects").length, 0, "every inbound message acknowledged");

  await i.rt.stop();
  const again = await replayMatches(i.store);
  assert.equal(again.length, 1, "replay recomputes the one emit");
  assert.deepEqual(again[0].bytes, await i.store.bytes(again[0].body), "…with the same body");
});

test("objects-handler: a directory in 1-record bundles lands as the same git objects, and a run over it works", async (t) => {
  const dir = await fixture(t);
  await fs.writeFile(join(dir, "src/b.bin"), Buffer.alloc(3000, 7));
  const i = await instance();
  const { root, bundles, records } = await bundlesOf(dir, 100); // tiny limit: one record per bundle
  assert.equal(bundles.length, records);
  for (const b of bundles) await send(i, "objects", b);
  await i.edge.poll();
  await i.rt.idle();
  t.diagnostic(i.lines.join("\n"));
  const hs = await byProgram(i.store, "objects-handler");
  assert.equal(hs.length, records);
  for (const h of hs) {
    const [u] = await history(i.store, h) as Array<ThreadUpdate & { reveals?: CID[] }>;
    assert.equal(u.state, "finished", text((u.result as { stderr: Uint8Array }).stderr));
    const r = await i.store.get<{ kind: string; count: number }>(u.reveals![0]);
    assert.deepEqual([r.kind, r.count], ["reveal", 1]);
  }
  assert.ok(await i.store.has(root), "the root tree is in the store");

  await send(i, "run", { cmd: "wc -c < src/b.bin; cat src/a.txt", tree: root });
  await i.edge.poll();
  await i.rt.idle();
  const [{ body }] = await results(i);
  assert.equal(text(body.stdout), "3000\nalpha\n");

  // A record whose bytes do not hash to its CID is refused: the handler errors, nothing is stored.
  const bad = dagCbor.encode({ records: [{ cid: root, bytes: new Uint8Array([1, 2, 3]) }] });
  await send(i, "objects", bad);
  await i.edge.poll();
  await i.rt.idle();
  const last = (await byProgram(i.store, "objects-handler"))[0];
  const u = await tipOf(i.store, last);
  assert.equal(u.state, "errored");
  assert.match(u.error!.message, /do not hash/);
  await i.rt.stop();
  await replayMatches(i.store);
});

test("sleep: the shell rests until a wake entry, one per wake; the handler replies after it", async (t) => {
  const dir = await fixture(t);
  const i = await instance();
  await importAndRun(i, dir, "sleep 1; date +%s");
  const [sh] = await byProgram(i.store, "shell");
  let u = await tipOf(i.store, sh);
  assert.equal(u.state, "waiting");
  assert.equal(i.rt.sleeping, 1);
  const [due] = i.rt.sleepersDue();
  assert.ok(due.thread.equals(sh));
  assert.equal(due.until, u.until);
  assert.equal((await results(i)).length, 0);

  i.clock.set([T0[0] + 5, 0]);
  const w = await i.rt.wake(sh);
  await i.rt.idle();
  const e = (await readLog(i.store)).at(-1)!.entry;
  assert.ok(e.wake!.equals(sh) && e.envelope === undefined && w!.equals((await i.store.log.tip())!), "a wake entry names the thread and nothing else");
  assert.ok(verifyEntry(e, i.identity));
  u = await tipOf(i.store, sh);
  assert.equal(u.state, "finished");
  const [{ body }] = await results(i);
  assert.equal(text(body.stdout), `${T0[0] + 5}\n`, "woken by the wake entry: its stamp is the new now");
  assert.equal(await i.rt.wake(sh), undefined, "no second wake for a thread not sleeping");
  await i.rt.stop();
  await replayMatches(i.store);
});

test("restart mid-handler: dropped while the shell sleeps, the wake logged while down; a new runtime finishes identically; replay needs no wallet", async (t) => {
  const dir = await fixture(t);
  const CMD = "date +%s%N; echo $RANDOM; sleep 1; date +%s%N; echo $RANDOM; echo x > made.txt; ls";

  // Reference: no crash.
  const ref = await instance();
  await importAndRun(ref, dir, CMD);
  const [refShell] = await byProgram(ref.store, "shell");
  ref.clock.set([T0[0] + 5, 0]);
  await ref.rt.wake(refShell);
  await ref.rt.idle();
  await ref.rt.stop();
  const [refResult] = await results(ref);

  // Same keys, same clock; crash mid-sleep. Re-send the reference's exact
  // envelopes (a fresh hub), so the inputs are byte-identical.
  const a = await instance({ instanceKey: ref.instanceKey, ownerKey: ref.owner.key });
  for (const { entry } of (await readLog(ref.store)).slice(1)) {
    if (!entry.envelope) continue;
    const env = await ref.store.get(entry.envelope);
    await a.hub.as(a.owner.identity).send({ recipient: a.identity, box: entry.box!, body: env });
  }
  await a.edge.poll();
  await a.rt.idle();
  const [sh] = await byProgram(a.store, "shell");
  assert.ok(sh.equals(refShell), "same shell thread");
  assert.equal((await tipOf(a.store, sh)).state, "waiting");
  await a.rt.stop();
  await appendEntry(a.store, a.wallet, { wake: sh }, [T0[0] + 5, 0]); // the timer fired while nothing ran

  const b = await instance({ store: a.store, instanceKey: a.instanceKey, ownerKey: a.owner.key, hub: a.hub, clock: a.clock });
  await b.rt.idle();
  t.diagnostic(b.lines.join("\n"));
  assert.ok(b.lines.some((l) => l.includes("re-executing")));
  for (const th of await threads(ref.store)) assert.ok((await b.store.chains.tip(th)).equals(await ref.store.chains.tip(th)), `thread ${fmt(th)} identical to the reference`);
  assert.ok((await b.store.log.tip())!.equals((await ref.store.log.tip())!), "identical log");
  const [r] = await results(b);
  assert.deepEqual(r.body, refResult.body, "identical result body");
  await b.rt.stop();

  // A second restart after it all finished does nothing.
  const c = await instance({ store: a.store, instanceKey: a.instanceKey, ownerKey: a.owner.key, hub: a.hub, clock: a.clock });
  await c.rt.idle();
  assert.ok(!c.lines.some((l) => l.includes("re-executing") || l.includes("stepping")));
  await c.rt.stop();

  await replayMatches(b.store);
});

test("restart before processing: entries admitted, runtime gone before it stepped anything; the next one does it all", async (t) => {
  const dir = await fixture(t);
  const i = await instance({ start: false });
  const { root, bundles } = await bundlesOf(dir);
  for (const bb of bundles) await send(i, "objects", bb);
  await send(i, "run", { cmd: "ls", tree: root });
  await i.edge.poll(); // admits (signs entries) but the runtime never started
  assert.equal((await readLog(i.store)).length, 3);
  assert.equal((await threads(i.store)).length, 0);
  const j = await instance({ store: i.store, instanceKey: i.instanceKey, ownerKey: i.owner.key, hub: i.hub, clock: i.clock });
  await j.rt.idle();
  const [{ body }] = await results(j);
  assert.equal(text(body.stdout), "README\nsrc\n");
  await j.rt.stop();
});

test("routing: an envelope from a stranger is admitted and logged but runs nothing; an unrouted box is not collected", async () => {
  const i = await instance();
  const stranger = ephemeralWallet();
  const sk = (await stranger.getPublicKey({ identityKey: true })).publicKey;
  const env = await seal(stranger, { recipient: { identityKey: i.identity, handle: "skein", domain: "localhost" }, body: dagCbor.encode({ cmd: "ls", tree: encode({}).cid }), created: iso(i.clock.now()) });
  await i.hub.as(sk).send({ recipient: i.identity, box: "run", body: env });
  await send(i, "mail", { hello: 1 });
  await i.edge.poll();
  await i.rt.idle();
  const log = await readLog(i.store);
  assert.deepEqual(log.map((x) => x.entry.box ?? "genesis"), ["genesis", "run"], "the stranger's run is in the log");
  assert.equal((await threads(i.store)).length, 0, "…and nothing ran");
  assert.ok(i.lines.some((l) => l.includes("no subscription")));
  assert.equal(i.hub.pending(i.identity, "mail").length, 1, "`mail` is routed nowhere, so it is not collected");
  await i.rt.stop();
});

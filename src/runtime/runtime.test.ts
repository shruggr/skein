// The runtime end to end: stamped log entries, pure time and randomness, sleep,
// restart re-execution and replay — and no messages exchanged for any of it.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CID } from "multiformats/cid";
import { encode, fmt } from "./cid.ts";
import { admit, copyLog, ensureGenesis, readLog } from "./log.ts";
import { memoryStore } from "./memory.ts";
import { signMessage, type Message } from "./records.ts";
import { Runtime } from "./scheduler.ts";
import type { Store } from "./store.ts";
import { stampNs, ThreadClock, type Stamp } from "./syscalls.ts";
import { Transport } from "./transport.ts";
import type { ThreadOrigin, ThreadUpdate } from "./types.ts";
import { scan } from "../dev/scan.ts";
import { connectAs, run } from "../dev/admin.ts";
import { collect, installWasm } from "../testkit.ts";
import { ephemeralWallet, signerFor, type Signer, type WalletInterface } from "../wallet.ts";

const T0: Stamp = [1_790_000_000, 250_000_000];
const text = (b: unknown) => Buffer.from(b as Uint8Array).toString("utf8");
type Result = { exitCode: number; stdout: Uint8Array; stderr: Uint8Array; tree: CID };

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await fs.mkdtemp(join(tmpdir(), "skein-rt-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(join(dir, "src"));
  await fs.writeFile(join(dir, "src/a.txt"), "alpha\n");
  await fs.writeFile(join(dir, "README"), "hello\n");
  return dir;
}

/** A store with the modules, the tree, and a genesis stamped T0. */
async function prepared(wallet: WalletInterface, dir: string): Promise<{ store: Store; tree: CID }> {
  const store = memoryStore();
  await installWasm(store);
  const tree = await scan(store, dir);
  await ensureGenesis(store, wallet, "skein", T0);
  return { store, tree };
}

/** A settable clock for admission stamps. */
function scriptClock(start: Stamp = T0) {
  let now: Stamp = start;
  return { now: () => now, set(s: Stamp) { now = s; } };
}

async function threads(store: Store): Promise<CID[]> {
  return (await collect(store.edges.query({ kind: "thread" }))).reverse();
}

async function history(store: Store, thread: CID): Promise<ThreadUpdate[]> {
  const out: ThreadUpdate[] = [];
  for await (const c of store.chains.history(thread)) if (!c.equals(thread)) out.push(await store.get<ThreadUpdate>(c));
  return out;
}

async function tip(store: Store, thread: CID): Promise<ThreadUpdate> {
  return store.get<ThreadUpdate>(await store.chains.tip(thread));
}

async function runMsg(admin: Signer, store: Store, cmd: string, tree: CID, at = 5000): Promise<Message> {
  return signMessage(admin, { seq: (await readLog(store)).filter((x) => x.message.from === admin.identity).length, at, body: { kind: "run", cmd, tree } });
}

/** Replay: the log (messages and stamps) into a fresh store, a fresh runtime with no peers; compare every chain. */
async function replayMatches(wallet: WalletInterface, store: Store, dir: string): Promise<Message[]> {
  const fresh = memoryStore();
  await installWasm(fresh);
  await scan(fresh, dir);
  await copyLog(store, fresh);
  assert.ok((await fresh.log.tip())!.equals((await store.log.tip())!), "identical chain of inputs");
  const sent: Message[] = [];
  const rt = new Runtime({ store: fresh, wallet, outbox: { send: (m) => sent.push(m) } });
  await rt.start();
  await rt.idle();
  for (const o of await threads(store)) assert.ok((await fresh.chains.tip(o)).equals(await store.chains.tip(o)), `thread ${fmt(o)} replays to the same tip`);
  await rt.stop();
  return sent;
}

// ---------------------------------------------------------------- the log chain

test("log: every admitted message moves the state hash and is stamped; stamps never go back", async (t) => {
  const wallet = ephemeralWallet();
  const { store, tree } = await prepared(wallet, await fixture(t));
  const g = await readLog(store);
  assert.equal(g[0].entry.prev, null);
  for (let i = 1; i < g.length; i++) {
    assert.ok(g[i].entry.prev!.equals(g[i - 1].cid), "each entry links the previous");
    assert.equal(g[i].entry.n, i);
  }
  assert.deepEqual(g[0].entry.time, T0);
  const admin = await signerFor(wallet, "admin");
  const before = await store.log.tip();
  const m = await runMsg(admin, store, "echo hi > out.txt", tree, 1000);
  const entry = await admit(store, m, [T0[0] - 100, 0]); // an earlier clock reading…
  assert.ok(!entry.equals(before!), "state hash changed");
  assert.deepEqual((await readLog(store)).at(-1)!.entry.time, T0, "…is raised to the previous stamp");
  assert.ok((await admit(store, m)).equals(entry), "admitting the same message again is a no-op");

  const sent: Message[] = [];
  const rt = new Runtime({ store, wallet, outbox: { send: (x) => sent.push(x) } });
  await rt.start();
  await rt.idle();
  const [th] = await threads(store);
  const o = await store.get<ThreadOrigin>(th);
  assert.ok(o.input!.equals(entry), "the thread origin names the entry that launched it");
  const hs = await history(store, th);
  assert.deepEqual(hs.map((u) => u.state), ["running", "finished"]);
  assert.ok(hs.every((u) => u.input!.equals(entry) && u.at === 1000), "input and log time on every record");
  assert.deepEqual(sent.map((x) => (x.body as { kind: string }).kind), ["result"], "the only message out is the result");
  await rt.stop();
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

// ---------------------------------------------------------------- end to end over the socket, no peers

test("end to end: `date; ls | head -3` over the socket with no peer connected; replay is exact", async (t) => {
  const wallet = ephemeralWallet();
  const dir = await fixture(t);
  const { store, tree } = await prepared(wallet, dir);
  const sock = join(dir, "..", `skein-${process.pid}-${encode({ t: dir }).cid.toString().slice(-8)}.sock`);
  const clock = scriptClock([1_790_000_123, 400_000_000]);
  const sent: Message[] = [];
  const rt = new Runtime({ store, wallet, now: clock.now });
  const transport = new Transport({ get identity() { return rt.identity; }, admit: (m) => rt.admit(m), nextSeq: (id) => rt.nextSeq(id) });
  rt.outbox = { send: (m) => { sent.push(m); transport.send(m); } };
  await rt.start();
  await transport.listen(sock);
  t.after(() => transport.close());
  const admin = await connectAs(wallet, "admin", sock);
  t.after(() => admin.close());

  const r = await run(admin, { cmd: "date -u +%s; date; ls | head -3; echo $RANDOM; echo $RANDOM; date +%s%N; date +%s%N", tree });
  await rt.idle();
  const res = r.result.body as Result;
  const out = text(res.stdout).trim().split("\n");
  t.diagnostic(JSON.stringify(out));
  assert.equal(res.exitCode, 0, text(res.stderr));
  assert.equal(out[0], "1790000123", "date is the run entry's stamp (plus a few ns)");
  assert.equal(out[2], "README");
  assert.equal(out[3], "src");
  assert.notEqual(out[4], out[5], "two different $RANDOM values");
  const [n1, n2] = [BigInt(out[6]), BigInt(out[7])];
  assert.ok(n2 > n1 && n1 >= stampNs([1_790_000_123, 400_000_000]), "time moves forward from the stamp");
  assert.equal(n2 - n1, 1n, "two reads of the clock in a row differ by exactly 1 ns");
  assert.deepEqual(sent.map((m) => (m.body as { kind: string }).kind), ["result"], "no time or random messages at all");
  await rt.stop();

  assert.deepEqual((await replayMatches(wallet, store, dir)).map((m) => (m.body as { kind: string }).kind), ["result"]);
});

// ---------------------------------------------------------------- sleep

test("sleep: `sleep 1` rests the thread until an entry stamped past the deadline", async (t) => {
  const wallet = ephemeralWallet();
  const dir = await fixture(t);
  const { store, tree } = await prepared(wallet, dir);
  const admin = await signerFor(wallet, "admin");
  const timer = await signerFor(wallet, "timer");
  const clock = scriptClock(T0);
  const rt = new Runtime({ store, wallet, now: clock.now });
  await rt.start();
  await rt.admit(await runMsg(admin, store, "sleep 1; date +%s", tree));
  await rt.idle();
  const [th] = await threads(store);
  let u = await tip(store, th);
  assert.equal(u.state, "waiting");
  assert.equal(u.until, 1_790_000_001_251, "deadline = the run entry's stamp + 1 s (+ a few ns of reads), in ms rounded up");
  assert.equal(rt.sleeping, 1);

  clock.set([1_790_000_000, 750_000_000]);
  await rt.admit(await signMessage(timer, { seq: 0, at: 0, body: { kind: "tick" } }));
  await rt.idle();
  assert.equal((await tip(store, th)).state, "waiting", "half a second is not enough");

  clock.set([1_790_000_002, 0]);
  await rt.admit(await signMessage(timer, { seq: 1, at: 0, body: { kind: "tick" } }));
  await rt.idle();
  u = await tip(store, th);
  assert.equal(u.state, "finished");
  assert.equal(text((u.result as Result).stdout), "1790000002\n", "woken by the later entry: its stamp is the new now");
  assert.equal(rt.sleeping, 0);
  await rt.stop();
});

// ---------------------------------------------------------------- restart

test("restart: a runtime dropped mid-sleep, the waking entry already logged; a new one re-executes and finishes identically", async (t) => {
  const wallet = ephemeralWallet();
  const dir = await fixture(t);
  const admin = await signerFor(wallet, "admin");
  const timer = await signerFor(wallet, "timer");
  const CMD = "date +%s%N; echo $RANDOM; sleep 1; date +%s%N; echo $RANDOM; echo x > made.txt";
  const tick = (seq: number) => signMessage(timer, { seq, at: 0, body: { kind: "tick" } });

  // Reference: no crash.
  const ref = await prepared(wallet, dir);
  const c1 = scriptClock();
  const a = new Runtime({ store: ref.store, wallet, now: c1.now });
  await a.start();
  await a.admit(await runMsg(admin, ref.store, CMD, ref.tree));
  await a.idle();
  c1.set([T0[0] + 5, 0]);
  await a.admit(await tick(0));
  await a.idle();
  await a.stop();
  const [refThread] = await threads(ref.store);
  const refFin = await tip(ref.store, refThread);
  assert.equal(refFin.state, "finished");

  // Crash mid-sleep; the tick lands in the log while nothing is running.
  const s = await prepared(wallet, dir);
  const c2 = scriptClock();
  const b = new Runtime({ store: s.store, wallet, now: c2.now });
  await b.start();
  await b.admit(await runMsg(admin, s.store, CMD, s.tree));
  await b.idle();
  const [th] = await threads(s.store);
  assert.equal((await tip(s.store, th)).state, "waiting");
  await b.stop();
  await admit(s.store, await tick(0), [T0[0] + 5, 0]);

  const lines: string[] = [];
  const sent: Message[] = [];
  const c = new Runtime({ store: s.store, wallet, outbox: { send: (m) => sent.push(m) }, log: (l) => lines.push(l) });
  await c.start();
  await c.idle();
  t.diagnostic(lines.join("\n"));
  const fin = await tip(s.store, th);
  assert.equal(fin.state, "finished");
  assert.ok(th.equals(refThread), "same thread origin");
  assert.deepEqual((fin.result as Result).stdout, (refFin.result as Result).stdout, "identical stdout");
  assert.ok((fin.result as Result).tree.equals((refFin.result as Result).tree), "identical tree");
  assert.ok((await s.store.chains.tip(th)).equals(await ref.store.chains.tip(refThread)), "identical chain");
  assert.deepEqual(sent.map((m) => (m.body as { kind: string }).kind), ["result"], "no time or random messages");
  await c.stop();

  // And a second restart after it finished re-executes nothing.
  const d = new Runtime({ store: s.store, wallet, log: (l) => lines.push(l) });
  lines.length = 0;
  await d.start();
  assert.ok(!lines.some((l) => l.includes("re-executing")));
  await d.stop();

  assert.deepEqual((await replayMatches(wallet, s.store, dir)).map((m) => (m.body as { kind: string }).kind), ["result"]);
});

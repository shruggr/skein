// The runtime end to end: log chain, attested syscalls through a real clock
// peer over the socket, restart re-execution, and replay.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CID } from "multiformats/cid";
import { encode, fmt } from "./cid.ts";
import { admit, ensureGenesis, readLog } from "./log.ts";
import { memoryStore } from "./memory.ts";
import { signMessage, type Message } from "./records.ts";
import { Runtime } from "./scheduler.ts";
import type { Store } from "./store.ts";
import { Transport } from "./transport.ts";
import type { ThreadOrigin, ThreadUpdate } from "./types.ts";
import { scan } from "../dev/scan.ts";
import { connectAs, run } from "../dev/admin.ts";
import { startClock } from "../peers/clock.ts";
import { collect, installWasm } from "../testkit.ts";
import { ephemeralWallet, signerFor, type Signer, type WalletInterface } from "../wallet.ts";

const CMD = "date +%s; echo $RANDOM; echo $RANDOM";
const text = (b: unknown) => Buffer.from(b as Uint8Array).toString("utf8");

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await fs.mkdtemp(join(tmpdir(), "skein-rt-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(join(dir, "src"));
  await fs.writeFile(join(dir, "src/a.txt"), "alpha\n");
  await fs.writeFile(join(dir, "README"), "hello\n");
  return dir;
}

/** A store with the modules, the tree, and a genesis. */
async function prepared(wallet: WalletInterface, dir: string): Promise<{ store: Store; tree: CID }> {
  const store = memoryStore();
  await installWasm(store);
  const tree = await scan(store, dir);
  await ensureGenesis(store, wallet);
  return { store, tree };
}

async function until<T>(fn: () => Promise<T | undefined> | T | undefined, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function threads(store: Store): Promise<CID[]> {
  return (await collect(store.edges.query({ kind: "thread" }))).reverse();
}

async function history(store: Store, thread: CID): Promise<ThreadUpdate[]> {
  const out: ThreadUpdate[] = [];
  for await (const c of store.chains.history(thread)) if (!c.equals(thread)) out.push(await store.get<ThreadUpdate>(c));
  return out;
}

async function finished(store: Store, thread: CID): Promise<ThreadUpdate | undefined> {
  const tip = await store.chains.tip(thread);
  if (tip.equals(thread)) return undefined;
  const u = await store.get<ThreadUpdate>(tip);
  return u.state === "finished" || u.state === "errored" ? u : undefined;
}

type Result = { exitCode: number; stdout: Uint8Array; stderr: Uint8Array; tree: CID };

/** Signs replies the way the clock peer does, but with fixed times/seed and fixed `at`: deterministic records. */
function scriptedClock(clock: Signer) {
  let seq = 0;
  const times: number[] = [];
  return {
    times,
    async answer(req: Message): Promise<Message> {
      const b = req.body as { kind: string; state: CID };
      const refs = [{ to: encode(req).cid, rel: "replies-to" }];
      let body: unknown;
      if (b.kind === "time") {
        const time = 1_790_000_000_000 + 1000 * (times.length + 1);
        times.push(time);
        body = { kind: "time", time, state: b.state };
      } else body = { kind: "random", seed: new Uint8Array(32).fill(7), state: b.state };
      return signMessage(clock, { to: req.from, seq: seq++, at: 1_790_000_000_000 + seq, body, refs });
    },
  };
}

// ---------------------------------------------------------------- the log chain

test("log: every admitted message moves the state hash; records carry their input entry", async (t) => {
  const wallet = ephemeralWallet();
  const { store, tree } = await prepared(wallet, await fixture(t));
  const g = await readLog(store);
  assert.equal(g[0].entry.prev, null);
  for (let i = 1; i < g.length; i++) {
    assert.ok(g[i].entry.prev!.equals(g[i - 1].cid), "each entry links the previous");
    assert.equal(g[i].entry.n, i);
  }
  const before = await store.log.tip();
  const admin = await signerFor(wallet, "admin");
  const m = await signMessage(admin, { seq: g.length, at: 1000, body: { kind: "run", cmd: "echo hi > out.txt", tree } });
  const entry = await admit(store, m);
  assert.ok(!entry.equals(before!), "state hash changed");
  assert.ok((await store.log.tip())!.equals(entry));
  assert.ok((await admit(store, m)).equals(entry), "admitting the same message again is a no-op");

  const sent: Message[] = [];
  const rt = new Runtime({ store, wallet, outbox: { send: (x) => sent.push(x) } });
  await rt.start();
  await rt.idle();
  const [th] = await threads(store);
  const o = await store.get<ThreadOrigin>(th);
  assert.ok(o.input!.equals(entry), "the thread origin names the entry that launched it");
  assert.ok(o.launchedBy!.equals(encode(m).cid));
  const hs = await history(store, th);
  assert.ok(hs.length >= 2 && hs.every((u) => u.input !== undefined));
  assert.ok(hs[0].input!.equals(entry));
  assert.equal(hs[0].at, 1000, "log time, not a clock");
  // The first attested request is bound to the state that asked.
  const req = sent.find((x) => (x.body as { kind?: string }).kind === "random")!;
  assert.ok((req.body as { state: CID }).state.equals(entry));
  await rt.stop();
});

// ---------------------------------------------------------------- end to end over the socket

test("end to end: runtime + clock peer; date and $RANDOM are attested", async (t) => {
  const wallet = ephemeralWallet();
  const dir = await fixture(t);
  const { store, tree } = await prepared(wallet, dir);
  const sock = join(dir, "..", `skein-${process.pid}-${Math.floor(Math.random() * 1e9)}.sock`);

  const sent: Array<{ m: Message; tip: CID | undefined }> = [];
  const lines: string[] = [];
  const rt = new Runtime({ store, wallet, log: (l) => lines.push(l) });
  const transport = new Transport({ get identity() { return rt.identity; }, admit: (m) => rt.admit(m), nextSeq: (id) => rt.nextSeq(id) });
  // Capture the log tip at the moment of sending: the memory store computes tip() before its first await.
  const captured: Promise<unknown>[] = [];
  rt.outbox = { send: (m) => { captured.push(store.log.tip().then((tip) => sent.push({ m, tip }))); transport.send(m); } };
  await rt.start();
  await transport.listen(sock);
  t.after(() => transport.close());

  let now = 1_790_000_000_123;
  const times: number[] = [];
  const clock = await startClock({ wallet, path: sock, now: () => { times.push((now += 1000)); return now; } });
  t.after(() => clock.close());
  const admin = await connectAs(wallet, "admin", sock);
  t.after(() => admin.close());

  const r = await run(admin, { cmd: CMD, tree });
  await rt.idle();
  await Promise.all(captured);
  const res = r.result.body as Result;
  const out = text(res.stdout).trim().split("\n");
  t.diagnostic(`stdout ${JSON.stringify(out)} stderr ${JSON.stringify(text(res.stderr))}`);
  t.diagnostic(lines.join("\n"));
  assert.equal(res.exitCode, 0, text(res.stderr));

  const timeReqs = sent.filter((s) => (s.m.body as { kind?: string }).kind === "time");
  const randReqs = sent.filter((s) => (s.m.body as { kind?: string }).kind === "random");
  assert.ok(timeReqs.length >= 1, "a time request was emitted");
  for (const s of timeReqs) assert.ok((s.m.body as { state: CID }).state.equals(s.tip!), "request bound to the log tip at that moment");
  assert.equal(randReqs.length, 1, "one random request per thread");
  assert.equal(out[0], String(Math.floor(times[times.length - 1] / 1000)), "date prints the attested time");
  assert.equal(out.length, 3);
  assert.notEqual(out[1], out[2], "two different $RANDOM values");

  const [th] = await threads(store);
  const states = (await history(store, th)).map((u) => u.state);
  t.diagnostic(`states ${states.join(" → ")}`);
  assert.deepEqual(states.slice(-3), ["waiting", "running", "finished"]);
  assert.ok(states.filter((s) => s === "waiting").length === timeReqs.length + 1);
  assert.equal(states[0], "running");
  const fin = (await finished(store, th))!;
  assert.deepEqual((fin.result as Result).stdout, res.stdout);
  assert.ok((fin.result as Result).tree.equals(res.tree));
  await rt.stop();

  // ---- replay: the whole log into a fresh store, no peers → the same chains and output
  const fresh = memoryStore();
  await installWasm(fresh);
  assert.ok((await scan(fresh, dir)).equals(tree));
  for (const { message } of await readLog(store)) await admit(fresh, message);
  assert.ok((await fresh.log.tip())!.equals((await store.log.tip())!), "identical chain of inputs");
  const replaySent: Message[] = [];
  const rt2 = new Runtime({ store: fresh, wallet, outbox: { send: (m) => replaySent.push(m) } });
  await rt2.start();
  await rt2.idle();
  assert.deepEqual(replaySent.filter((m) => (m.body as { kind?: string }).kind !== "result").length, 0, "every attested reply came from the log");
  for (const o of await threads(store)) {
    assert.ok((await fresh.chains.tip(o)).equals(await store.chains.tip(o)), `thread ${fmt(o)} replays to the same tip`);
  }
  const fin2 = (await finished(fresh, th))!;
  assert.deepEqual((fin2.result as Result).stdout, res.stdout);
  await rt2.stop();
});

// ---------------------------------------------------------------- restart

test("restart: a runtime dropped mid-wait, the reply already logged; a new one re-executes and finishes identically", async (t) => {
  const wallet = ephemeralWallet();
  const dir = await fixture(t);
  const clockSigner = await signerFor(wallet, "clock");
  const admin = await signerFor(wallet, "admin");

  // Drive a runtime, answering its requests with a scripted clock, until `stopWhen` says stop.
  async function drive(store: Store, tree: CID, o: { dropBeforeTime?: boolean }) {
    const clock = scriptedClock(clockSigner);
    const queue: Message[] = [];
    const rt = new Runtime({ store, wallet, outbox: { send: (m) => queue.push(m) } });
    await rt.start();
    const g = await readLog(store);
    await rt.admit(await signMessage(admin, { seq: g.length, at: 5000, body: { kind: "run", cmd: CMD, tree } }));
    for (;;) {
      await rt.idle();
      const req = queue.shift();
      if (!req || (req.body as { kind: string }).kind === "result") break;
      const reply = await clock.answer(req);
      if (o.dropBeforeTime && (req.body as { kind: string }).kind === "time") {
        await rt.stop();              // the process dies with the thread suspended…
        await admit(store, reply);    // …and the reply lands in the log (another process admitted it)
        return { rt, clock, dropped: true };
      }
      await rt.admit(reply);
    }
    await rt.stop();
    return { rt, clock, dropped: false };
  }

  // Reference: no crash.
  const ref = await prepared(wallet, dir);
  await drive(ref.store, ref.tree, {});
  const [refThread] = await threads(ref.store);
  const refFin = (await finished(ref.store, refThread))!;
  assert.equal(refFin.state, "finished");

  // Crash mid-wait.
  const s = await prepared(wallet, dir);
  const d = await drive(s.store, s.tree, { dropBeforeTime: true });
  assert.ok(d.dropped);
  const [th] = await threads(s.store);
  assert.equal((await s.store.get<ThreadUpdate>(await s.store.chains.tip(th))).state, "waiting");

  // A new runtime on the same store.
  const lines: string[] = [];
  const sent: Message[] = [];
  const rt = new Runtime({ store: s.store, wallet, outbox: { send: (m) => sent.push(m) }, log: (l) => lines.push(l) });
  await rt.start();
  await rt.idle();
  const answered = new Set((await readLog(s.store)).flatMap(({ message }) => message.refs.filter((r) => r.rel === "replies-to").map((r) => String(r.to))));
  assert.ok(sent.every((m) => !answered.has(String(encode(m).cid))), "nothing already answered in the log is asked again");
  // Keep answering (the command reads the clock more than once) with the same scripted clock.
  for (let i = 0; i < sent.length; i++) {
    if ((sent[i].body as { kind: string }).kind === "result") continue;
    await rt.admit(await d.clock.answer(sent[i]));
    await rt.idle();
  }
  t.diagnostic(lines.join("\n"));
  const fin = await until(() => finished(s.store, th));
  assert.equal(fin.state, "finished");
  assert.ok(th.equals(refThread), "same thread origin");
  assert.deepEqual((fin.result as Result).stdout, (refFin.result as Result).stdout, "identical stdout");
  assert.ok((fin.result as Result).tree.equals((refFin.result as Result).tree), "identical tree");
  assert.ok((await s.store.chains.tip(th)).equals(await ref.store.chains.tip(refThread)), "identical chain");
  await rt.stop();
});

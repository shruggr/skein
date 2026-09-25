// Messages, v2 records and the index over them, on both stores.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CID, encode, fmt } from "./cid.ts";
import { memoryStore } from "./memory.ts";
import { genesis, program, signMessage, type Message } from "./records.ts";
import { openStore } from "./sqlite.ts";
import { Rejected, type Filter, type Store } from "./store.ts";
import { collect } from "./testkit.ts";
import type { ThreadOrigin } from "./types.ts";
import { ephemeralWallet, rootIdentity, signerFor, type Signer } from "./wallet.ts";

const stores: Array<[string, () => Store]> = [["memory", memoryStore], ["sqlite", () => openStore(":memory:")]];
const strs = (cs: CID[]) => cs.map(fmt);

async function actors() {
  const w = ephemeralWallet();
  return { w, david: await signerFor(w, "david"), admin: await signerFor(w, "admin"), clock: await signerFor(w, "clock") };
}

const send = (s: Signer, seq: number, at: number, to?: string, body: unknown = { kind: "line", seq }) =>
  signMessage(s, { to, seq, body, at });

for (const [name, open] of stores) {
  test(`${name}: putMessage verifies, stores the record as signed, rejects tampering and a reused seq`, async () => {
    const s = open();
    const { david, admin } = await actors();
    const m = await send(david, 0, 10, admin.identity);
    const cid = await s.putMessage(m);
    assert.ok(cid.equals(encode(m).cid));
    const back = await s.get<Message>(cid);
    assert.deepEqual(back, m);
    assert.ok((await s.putMessage(back)).equals(cid)); // the same record again is a no-op

    const tampered = { ...m, seq: 1, body: { kind: "line", text: "forged" } };
    await assert.rejects(s.putMessage(tampered), (e) => e instanceof Rejected && e.reason === "bad-signature");
    assert.equal(await s.has(encode(tampered).cid), false);

    const again = await send(david, 0, 11, admin.identity, { kind: "line", text: "second at seq 0" });
    await assert.rejects(s.putMessage(again), (e) => e instanceof Rejected && e.reason === "duplicate-seq");
    assert.equal(await s.has(encode(again).cid), false);
    assert.deepEqual(strs(await collect(s.edges.query({ kind: "message" }))), strs([cid]));
    await s.close();
  });

  test(`${name}: query messages by from, to, time, limit — newest first, apart from chains`, async () => {
    const s = open();
    const { david, admin, clock } = await actors();
    const d0 = await s.putMessage(await send(david, 0, 100, admin.identity));
    const d1 = await s.putMessage(await send(david, 1, 300, admin.identity));
    const c0 = await s.putMessage(await send(clock, 0, 200));
    const a0 = await s.putMessage(await send(admin, 0, 250, david.identity));
    const t = await s.chains.open({ kind: "thread", runner: "loop", spec: {}, at: 150 });

    const q = async (f: Filter) => strs(await collect(s.edges.query(f)));
    assert.deepEqual(await q({ kind: "message" }), strs([d1, a0, c0, d0]));
    assert.deepEqual(await q({ kind: "message", from: david.identity }), strs([d1, d0]));
    assert.deepEqual(await q({ from: david.identity }), strs([d1, d0]));  // from/to imply messages
    assert.deepEqual(await q({ to: admin.identity }), strs([d1, d0]));
    assert.deepEqual(await q({ to: david.identity }), strs([a0]));
    assert.deepEqual(await q({ kind: "message", since: 200, before: 300 }), strs([a0, c0]));
    assert.deepEqual(await q({ kind: "message", limit: 2 }), strs([d1, a0]));
    assert.deepEqual(await q({ from: david.identity, to: david.identity }), []);
    assert.deepEqual(await q({}), strs([t]));                              // chains only, as before
    await s.close();
  });

  test(`${name}: threads by program; waitingFrom; a thread launched by a message`, async () => {
    const s = open();
    const { david, admin } = await actors();
    const shell = await s.put(program({ name: "shell", code: { ts: "…" }, inputs: {}, services: ["execution"], description: "" }));
    const other = await s.put(program({ name: "model", code: { ts: "…" }, inputs: {}, services: ["inference"], description: "" }));
    const line = await s.putMessage(await send(david, 0, 1, admin.identity));
    const t1 = await s.chains.open({ kind: "thread", runner: "program", spec: null, program: shell, args: { cmd: "ls" }, launchedBy: line, at: 2 } satisfies ThreadOrigin);
    const t2 = await s.chains.open({ kind: "thread", runner: "program", spec: null, program: other, at: 3 } satisfies ThreadOrigin);
    const t3 = await s.chains.open({ kind: "thread", runner: "loop", spec: {}, at: 4 } satisfies ThreadOrigin);

    const q = async (f: Filter) => strs(await collect(s.edges.query(f)));
    assert.deepEqual(await q({ kind: "thread", program: shell }), strs([t1]));
    assert.deepEqual(await q({ kind: "thread", program: other }), strs([t2]));
    assert.deepEqual(await q({ kind: "thread", parentless: false }), strs([t1]));
    const launch = name === "sqlite" ? await s.edges.refsFrom(t1) : await s.edges.refsFrom(line); // the stores index it facing opposite ways
    assert.deepEqual(launch.map((r) => [String(r.to), r.rel]), name === "sqlite" ? [[fmt(line), "launched-by"]] : [[fmt(t1), "launched"]]);

    await s.chains.append(t1, { state: "waiting", waitingFrom: david.identity });
    await s.chains.append(t3, { state: "waiting", waitingFrom: david.identity, waitingOn: [t2] });
    await s.chains.append(t2, { state: "waiting", waitingFrom: admin.identity });
    const from = async (id: string) => strs(await collect(s.live.waitingFrom(id)));
    assert.deepEqual(await from(david.identity), strs([t1, t3]));
    assert.deepEqual(await from(admin.identity), strs([t2]));
    await s.chains.append(t1, { state: "running" }); // only the tip counts
    assert.deepEqual(await from(david.identity), strs([t3]));
    assert.deepEqual(strs(await collect(s.live.waitersOn(t2))), strs([t3]));

    await s.edges.rebuild();
    assert.deepEqual(await from(david.identity), strs([t3]));
    assert.deepEqual(await q({ kind: "thread", program: shell }), strs([t1]));
    assert.deepEqual(await q({ kind: "message" }), strs([line]));
    await s.close();
  });

  test(`${name}: program and genesis records round-trip with stable CIDs`, async () => {
    const s = open();
    const wasm = encode({ kind: "blob" }).cid;
    const p = program({ name: "grep", code: { wasm }, inputs: { type: "object", properties: { pattern: { type: "string" } } }, services: [], description: "search" });
    const g = genesis(await rootIdentity(ephemeralWallet()), "ripper", 42);
    for (const r of [p, g]) {
      const cid = await s.put(r);
      assert.ok(cid.equals(encode(r).cid));             // same CID in either store and from cid.ts
      assert.ok((await s.put(structuredClone(r))).equals(cid));
      assert.ok(encode(await s.get(cid)).cid.equals(cid));
    }
    await s.close();
  });
}

test("sqlite: rebuild reproduces the messages table and skips unsigned look-alikes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "skein-"));
  const path = join(dir, "skein.db");
  const s = openStore(path);
  const raw = new DatabaseSync(path);
  const snap = () => ["chains", "messages"].map((t) => raw.prepare(`SELECT * FROM ${t} ORDER BY 1`).all());
  try {
    const { david, admin, clock } = await actors();
    const line = await s.putMessage(await send(david, 0, 1, admin.identity));
    await s.putMessage(await send(david, 1, 2));
    await s.putMessage(await send(clock, 7, 3, admin.identity));
    const t = await s.chains.open({ kind: "thread", runner: "program", spec: null, program: encode({ kind: "p" }).cid, launchedBy: line, at: 4 } satisfies ThreadOrigin);
    await s.chains.append(t, { state: "waiting", waitingFrom: david.identity });
    const fake = { ...(await send(david, 2, 5)), body: { kind: "line", text: "forged" } };
    await s.put(fake); // in the blocks, never in the index

    const want = snap();
    assert.equal(want[1].length, 3);
    raw.exec("DELETE FROM messages; DELETE FROM edges; DELETE FROM updates; DELETE FROM chains;");
    await s.edges.rebuild();
    assert.deepEqual(snap(), want);
    assert.deepEqual(strs(await collect(s.live.waitingFrom(david.identity))), strs([t]));
  } finally {
    raw.close(); await s.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test("sqlite: a file from before messages/program/waiting_from is migrated on open", async () => {
  const dir = mkdtempSync(join(tmpdir(), "skein-"));
  const path = join(dir, "skein.db");
  try {
    const s = openStore(path);
    const { david } = await actors();
    const m = await s.putMessage(await send(david, 0, 1));
    const prog = encode({ kind: "p" }).cid;
    const t = await s.chains.open({ kind: "thread", runner: "program", spec: null, program: prog, at: 2 } satisfies ThreadOrigin);
    await s.chains.append(t, { state: "waiting", waitingFrom: david.identity });
    await s.close();

    const raw = new DatabaseSync(path);
    raw.exec(`DROP TABLE messages; DROP INDEX chains_program; DROP INDEX chains_waiting_from;
      ALTER TABLE chains DROP COLUMN program; ALTER TABLE chains DROP COLUMN waiting_from;`);
    raw.close();

    const again = openStore(path);
    assert.deepEqual(strs(await collect(again.edges.query({ kind: "message" }))), strs([m]));
    assert.deepEqual(strs(await collect(again.edges.query({ kind: "thread", program: prog }))), strs([t]));
    assert.deepEqual(strs(await collect(again.live.waitingFrom(david.identity))), strs([t]));
    await again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The host's management database and one process running many instances
// (#23): rows in host.db and the skein-host CLI; a row's genesis (its handle,
// the open `chat` subscription); two instances started from two rows, sharing
// a messagebox hub and the host wallet and nothing else.

import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { seal } from "../envelope.ts";
import { collect, installWasm, messageBoxHub, scriptClock, iso, T0 } from "../testkit.ts";
import { genesisOf, readLog, verifyEntry } from "../runtime/log.ts";
import { memoryStore } from "../runtime/memory.ts";
import { PROGRAM_CIDS } from "../runtime/programs.ts";
import type { Subscription } from "../runtime/records.ts";
import type { Store } from "../runtime/store.ts";
import type { ThreadOrigin } from "../runtime/types.ts";
import { ephemeralWallet } from "../wallet.ts";
import { main } from "./cli.ts";
import { configFor, hostResolver, startInstance, type HostOptions, type Running } from "./host.ts";
import { HostDb, knowsColumn, knowsOf, type InstanceRow } from "./instances.ts";

async function tmp(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "skein-host-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test("host.db: add (defaults, then an update of given fields), get, list by status, enable/disable, remove", async (t) => {
  const db = new HostDb(join(await tmp(t), "host.db"));
  const a = db.add("martha", { store: "/s/martha.db", wallet_url: "http://127.0.0.1:3401" }, new Date(0));
  assert.deepEqual(a, { handle: "martha", domain: "localhost", identity: null, wallet_url: "http://127.0.0.1:3401", wallet_originator: "skein", store: "/s/martha.db", tree: null, source: null, knows: null, status: "enabled", created_at: "1970-01-01T00:00:00.000Z" });
  db.add("kurt", { store: "/s/kurt.db", domain: "example.com" }, new Date(1));
  const updated = db.add("martha", { identity: "02" + "a".repeat(64), tree: "bafy" });
  assert.equal(updated.identity, "02" + "a".repeat(64));
  assert.equal(updated.store, "/s/martha.db", "fields not given keep their value");
  assert.equal(updated.created_at, a.created_at);
  assert.throws(() => db.add("nobody", {}), /needs a store/);
  assert.throws(() => db.add("Bad Handle", { store: "/x" }), /bad handle/);
  assert.deepEqual(db.list().map((r) => r.handle), ["martha", "kurt"]);
  assert.ok(db.setStatus("kurt", "disabled"));
  assert.deepEqual(db.list("enabled").map((r) => r.handle), ["martha"]);
  assert.throws(() => db.add("kurt", { status: "paused" as never }), /CHECK/);
  assert.ok(db.remove("kurt"));
  assert.ok(!db.remove("kurt") && !db.setStatus("kurt", "enabled"));
  assert.deepEqual(db.list().map((r) => r.handle), ["martha"]);
  db.close();
});

test("host.db: `knows` — a list of handles, [\"*\"] for everyone, null for nobody; an older file gains the column", async (t) => {
  const dir = await tmp(t);
  const old = new DatabaseSync(join(dir, "host.db"));
  old.exec("CREATE TABLE instances (handle TEXT PRIMARY KEY, domain TEXT NOT NULL DEFAULT 'localhost', identity TEXT, wallet_url TEXT, wallet_originator TEXT NOT NULL DEFAULT 'skein', store TEXT NOT NULL, tree TEXT, status TEXT NOT NULL DEFAULT 'enabled', created_at TEXT NOT NULL)");
  old.exec("INSERT INTO instances (handle, store, created_at) VALUES ('martha', '/s/m.db', '1970-01-01T00:00:00.000Z')");
  old.close();
  const db = new HostDb(join(dir, "host.db"));
  assert.equal(db.get("martha")!.knows, null);
  assert.deepEqual(knowsOf(db.get("martha")!), []);
  assert.ok(db.setKnows("martha", "all"));
  assert.equal(db.get("martha")!.knows, '["*"]');
  assert.equal(knowsOf(db.get("martha")!), "all");
  db.add("kurt", { store: "/s/k.db", knows: knowsColumn(["martha", "martha"]) });
  assert.deepEqual(knowsOf(db.get("kurt")!), ["martha"]);
  assert.equal(knowsColumn(["a", "*"]), '["*"]');
  assert.ok(db.setKnows("kurt", []));
  assert.equal(db.get("kurt")!.knows, null);
  assert.ok(!db.setKnows("nobody", ["kurt"]));
  db.close();
});

test("skein-host: add / list / disable / enable / remove through the CLI, store defaulting under $SKEIN_HOME", async (t) => {
  const home = await tmp(t);
  const out: string[] = [], err: string[] = [];
  const cli = (...argv: string[]) => main(argv, { vars: { SKEIN_HOME: home }, out: (l) => out.push(l), err: (l) => err.push(l) });
  assert.equal(await cli("add", "martha", "--wallet-url", "http://127.0.0.1:3401"), 0);
  assert.equal(await cli("add", "martha", "--tree", "bafytree"), 0, "again: an update");
  assert.equal(await cli("disable", "martha"), 0);
  out.length = 0;
  assert.equal(await cli("list"), 0);
  assert.deepEqual(out, [["martha@localhost", "disabled", "-", "http://127.0.0.1:3401", join(home, "instances/martha/runtime.db"), "bafytree"].join("\t")]);
  assert.equal(await cli("enable", "martha"), 0);
  assert.equal(await cli("remove", "martha"), 0);
  assert.equal(await cli("remove", "martha"), 1);
  assert.equal(await cli("add"), 2);
  assert.equal(await cli("frob"), 2);
});

// ---------------------------------------------------------------- instances from rows

const row = (handle: string): InstanceRow => ({
  handle, domain: "localhost", identity: null, wallet_url: null, wallet_originator: "skein", store: `mem:${handle}`, tree: null, source: null, knows: null, status: "enabled", created_at: iso(T0),
});

/** Host options over memory stores and in-process wallets: one host key, one wallet key per handle. */
async function hostFor(hub = messageBoxHub()) {
  const hostKey = PrivateKey.fromRandom();
  const ownerKey = PrivateKey.fromRandom();
  const keys = new Map<string, PrivateKey>();
  const stores = new Map<string, Store>();
  const lines: string[] = [];
  const clock = scriptClock();
  const o: HostOptions = {
    host: ephemeralWallet(hostKey),
    owner: ownerKey.toPublicKey().toString(),
    wallet: async (r) => { if (!keys.has(r.handle)) keys.set(r.handle, PrivateKey.fromRandom()); return ephemeralWallet(keys.get(r.handle)!); },
    store: async (r) => {
      if (!stores.has(r.handle)) { const s = memoryStore(); await installWasm(s); stores.set(r.handle, s); }
      return stores.get(r.handle)!;
    },
    box: (r) => hub.as(keys.get(r.handle)!.toPublicKey().toString()), // wallet(r) came first
    pollMs: 0,
    log: (h, l) => lines.push(`[${h}] ${l}`),
    now: clock.now,
  };
  return { o, hub, hostKey, ownerKey, keys, stores, lines, clock };
}

test("genesis from a row: its handle and domain, the owner's boxes, then `chat` from any sender → loop", async () => {
  const { o } = await hostFor();
  const c = configFor({ handle: "martha", domain: "bopen.ai" }, { owner: o.owner!, infer: undefined });
  const r = await startInstance({ ...row("martha"), domain: "bopen.ai" }, o);
  const g = await genesisOf(r.store);
  assert.equal(g.handle, "martha");
  assert.equal(g.domain, "bopen.ai");
  assert.equal(g.identity, r.identity);
  const subs = (xs: Subscription[]) => xs.map((s) => ({ ...s.match, handler: s.handler.toString() }));
  assert.deepEqual(subs(g.subscriptions), subs(c.subscriptions!));
  assert.deepEqual(subs(g.subscriptions).at(-1), { box: "chat", handler: PROGRAM_CIDS.loop.toString() }, "the open subscription names no sender");
  assert.deepEqual(g.subscriptions.slice(0, 4).map((s) => [s.match.sender, s.match.box]), [[o.owner, "run"], [o.owner, "objects"], [o.owner, "head"], [o.owner, "chat"]]);
  assert.deepEqual(await r.runtime.boxes(), ["run", "objects", "head", "chat", "completions"]);
  await r.stop();
});

const loopThreads = async (s: Store) => Promise.all((await collect(s.edges.query({ kind: "thread", program: PROGRAM_CIDS.loop }))).map((c) => s.get<ThreadOrigin>(c)));
const runThreads = async (s: Store) => collect(s.edges.query({ kind: "thread", program: PROGRAM_CIDS["run-handler"] }));

test("two rows, one host: a chat from a stranger to A is admitted and routed to A's loop; the owner's chat to B too; nothing crosses", async () => {
  const h = await hostFor();
  const a: Running = await startInstance(row("martha"), h.o);
  const b: Running = await startInstance(row("kurt"), h.o);
  assert.notEqual(a.identity, b.identity);
  assert.notEqual(a.store, b.store);
  assert.notEqual(a.runtime, b.runtime);
  const hostId = h.hostKey.toPublicKey().toString();
  assert.equal((await genesisOf(a.store)).host, hostId);
  assert.equal((await genesisOf(b.store)).host, hostId, "one host wallet signs for both");

  // A stranger — no row, no peer, never seen — opens a conversation with A; and tries A's `run`.
  const stranger = ephemeralWallet(PrivateKey.fromRandom());
  const strangerId = (await stranger.getPublicKey({ identityKey: true })).publicKey;
  const to = async (w: typeof stranger, i: Running, box: string, body: unknown) => {
    const env = await seal(w, { recipient: { identityKey: i.identity, handle: i.row.handle, domain: "localhost" }, body: dagCbor.encode(body), created: iso(h.clock.now()) });
    await h.hub.as((await w.getPublicKey({ identityKey: true })).publicKey).send({ recipient: i.identity, box, body: env });
  };
  await to(stranger, a, "chat", { text: "hello martha" });
  await to(stranger, a, "run", { cmd: "echo no" });
  // The owner — a known peer — chats with B.
  await to(ephemeralWallet(h.ownerKey), b, "chat", { text: "hello kurt" });

  const admittedA = await a.delivery!.poll();
  await a.runtime.idle();
  const admittedB = await b.delivery!.poll();
  await b.runtime.idle();
  assert.deepEqual(admittedA.map((x) => x.box).sort(), ["chat", "run"], h.lines.join("\n"));
  assert.deepEqual(admittedB.map((x) => x.box), ["chat"]);

  const [la] = await loopThreads(a.store);
  assert.equal(la?.args && (la.args as { sender: string }).sender, strangerId, "the stranger's chat opened A's loop");
  assert.equal((await loopThreads(a.store)).length, 1);
  assert.equal((await runThreads(a.store)).length, 0, "the open subscription is `chat` only: a stranger's run is recorded, nothing runs");
  assert.ok(h.lines.some((l) => l.startsWith("[martha]") && /in run from .*: no subscription/.test(l)), h.lines.join("\n"));

  const lb = await loopThreads(b.store);
  assert.equal(lb.length, 1);
  assert.equal((lb[0].args as { sender: string }).sender, h.o.owner, "the owner's chat still routes (its own subscription, first)");

  // Isolation: each log holds only its own entries, every one signed by the one host.
  for (const [r, n] of [[a, 3], [b, 2]] as const) {
    const log = await readLog(r.store);
    assert.equal(log.length, n);
    for (const { entry } of log) assert.ok(verifyEntry(entry, hostId));
  }
  assert.ok(h.lines.filter((l) => l.includes("hello")).length === 0, "bodies are not logged");
  assert.ok(h.lines.some((l) => l.startsWith("[kurt] ")) && h.lines.some((l) => l.startsWith("[martha] ")), "lines are prefixed by handle");
  await a.stop();
  await b.stop();
});

test("a row is refused when its wallet is not its genesis's identity, or the host wallet is not its genesis's host", async () => {
  const h = await hostFor();
  const a = await startInstance(row("martha"), h.o);
  await a.stop();
  h.keys.set("martha", PrivateKey.fromRandom()); // a different wallet behind the same row
  await assert.rejects(startInstance(row("martha"), h.o), /not this instance's identity/);
  await assert.rejects(startInstance({ ...row("martha"), identity: "02" + "b".repeat(64) }, h.o), /not the recorded identity/);
  await assert.rejects(startInstance(row("kurt"), { ...h.o, owner: undefined }), /needs the owner's identity key/);
  const other = { ...h.o, host: ephemeralWallet(PrivateKey.fromRandom()) };
  h.keys.delete("martha");
  h.stores.delete("martha");
  await (await startInstance(row("martha"), h.o)).stop();
  await assert.rejects(startInstance(row("martha"), other), /not this instance's host/);
});

test("resolver: the host's rows first, then the messagebox's paymail PKI; \"\" when neither knows the handle; wired into each runtime", async (t) => {
  const db = new HostDb(join(await tmp(t), "host.db"));
  const martha = "02" + "a".repeat(64), david = "03" + "d".repeat(64);
  db.add("martha", { store: "/s", identity: martha });
  db.add("kurt", { store: "/s" }); // no identity yet
  const asked: string[] = [];
  const f = (async (url: string) => {
    asked.push(url);
    return url.endsWith("/bsvalias/id/david@localhost") ? Response.json({ bsvalias: "1.0", handle: "david@localhost", pubkey: david }) : Response.json({ error: "paymail not found" }, { status: 404 });
  }) as unknown as typeof fetch;
  const resolve = hostResolver((h, d) => db.identityOf(h, d), "http://127.0.0.1:8100/messagebox", f);
  assert.equal(await resolve("martha", "localhost"), martha);
  assert.deepEqual(asked, [], "a row answers without the network");
  assert.equal(await resolve("david", "localhost"), david);
  assert.equal(await resolve("kurt", "localhost"), "");
  assert.equal(await resolve("martha", "elsewhere.example"), "", "the domain is part of the handle");
  assert.deepEqual(asked, ["http://127.0.0.1:8100/bsvalias/id/david@localhost", "http://127.0.0.1:8100/bsvalias/id/kurt@localhost", "http://127.0.0.1:8100/bsvalias/id/martha@elsewhere.example"]);
  assert.equal(await hostResolver(() => undefined)("david", "localhost"), "", "no messagebox: rows only");

  const h = await hostFor();
  const r = await startInstance(row("martha"), { ...h.o, resolve });
  assert.equal(await (r.runtime as unknown as { resolver: { resolve: typeof resolve } }).resolver.resolve("martha", "localhost"), martha);
  await r.stop();
  db.close();
});

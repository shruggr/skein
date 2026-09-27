// Deployment via `objects` (#23) and the front end's roster (#24): the host
// sends a filtered directory into an instance as the owner; the first root
// sets main, a changed directory moves it through `head`, an unchanged one
// sends nothing; the loop's next new conversation reads the new SOUL.md. The
// roster reads IDENTITY.md from the deployed tree.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { seal } from "../envelope.ts";
import { InferPeer } from "../peers/infer.ts";
import { collect, installWasm, iso, messageBoxHub, scriptClock, T0 } from "../testkit.ts";
import { headTree, MAIN } from "../runtime/heads.ts";
import { readLog, stampMs } from "../runtime/log.ts";
import { memoryStore } from "../runtime/memory.ts";
import { PROGRAM_CIDS } from "../runtime/programs.ts";
import type { Store } from "../runtime/store.ts";
import { readFile, readTree, walk } from "../runtime/tree.ts";
import { ephemeralWallet } from "../wallet.ts";
import { main } from "./cli.ts";
import { deploy, onlyIgnore } from "./deploy.ts";
import { startInstance, type HostOptions, type Running } from "./host.ts";
import { HostDb, type InstanceRow } from "./instances.ts";
import { parseIdentity, roster, serveRoster } from "./roster.ts";

type Json = Record<string, unknown>;

async function tmp(t: { after(fn: () => Promise<void>): void }, prefix = "skein-deploy-"): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const SOUL = "You are Martha, the front desk.\n";
const IDENTITY = "# IDENTITY\n\n- Name: Martha\n- Emoji: :woman_office_worker:\n- Theme: front desk\n- Description: Organization front desk and directory service.\n";

/** An agent directory as in b-open-io/prompts/.agents/<name>/, with the code around it. */
async function agentDir(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const d = await tmp(t);
  await fs.writeFile(join(d, "SOUL.md"), SOUL);
  await fs.writeFile(join(d, "IDENTITY.md"), IDENTITY);
  await fs.mkdir(join(d, "skills"));
  await fs.writeFile(join(d, "skills/x.md"), "# a skill\n");
  await fs.mkdir(join(d, "node_modules/junk"), { recursive: true });
  await fs.writeFile(join(d, "node_modules/junk/index.js"), "junk\n");
  await fs.mkdir(join(d, "src"));
  await fs.writeFile(join(d, "src/index.ts"), "code\n");
  await fs.writeFile(join(d, "bun.lock"), "lock\n");
  await fs.writeFile(join(d, "package.json"), "{}\n");
  return d;
}

const answer = (content: string) => ({ choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 1, completion_tokens: 1 }, model: "qwen38" });

/** One host over memory stores, the owner's wallet and an infer peer answering from a script. */
async function setup() {
  const hub = messageBoxHub();
  const clock = scriptClock();
  const hostKey = PrivateKey.fromRandom(), ownerKey = PrivateKey.fromRandom(), inferKey = PrivateKey.fromRandom();
  const keys = new Map<string, PrivateKey>();
  const stores = new Map<string, Store>();
  const lines: string[] = [];
  const o: HostOptions = {
    host: ephemeralWallet(hostKey),
    owner: ownerKey.toPublicKey().toString(),
    infer: inferKey.toPublicKey().toString(),
    wallet: async (r) => { if (!keys.has(r.handle)) keys.set(r.handle, PrivateKey.fromRandom()); return ephemeralWallet(keys.get(r.handle)!); },
    store: async (r) => {
      if (!stores.has(r.handle)) { const s = memoryStore(); await installWasm(s); stores.set(r.handle, s); }
      return stores.get(r.handle)!;
    },
    box: (r) => hub.as(keys.get(r.handle)!.toPublicKey().toString()),
    pollMs: 0,
    log: (h, l) => lines.push(`[${h}] ${l}`),
    now: clock.now,
  };
  const requests: Json[] = [];
  const answers: Json[] = [];
  const f = (async (_url: string, init: { body: string }) => {
    requests.push(JSON.parse(init.body));
    return Response.json(answers.shift() ?? answer("ok"));
  }) as unknown as typeof fetch;
  const inferId = inferKey.toPublicKey().toString();
  const peer = new InferPeer({ wallet: ephemeralWallet(inferKey), box: hub.as(inferId), providers: { ripper: { baseUrl: "http://ripper.test/v1", apiKey: "k" } }, fetch: f, now: () => stampMs(clock.now()) });
  const owner = { wallet: ephemeralWallet(ownerKey), box: hub.as(ownerKey.toPublicKey().toString()), identity: ownerKey.toPublicKey().toString() };
  return { hub, clock, o, owner, peer, requests, answers, lines, stores };
}

const rowOf = (handle: string, identity: string | null = null, tree: string | null = null): InstanceRow => ({
  handle, domain: "localhost", identity, wallet_url: null, wallet_originator: "skein", store: `mem:${handle}`, tree, source: null, status: "enabled", created_at: iso(T0),
});

async function settle(r: Running) { await r.delivery!.poll(); await r.runtime.idle(); }

/** Every path in a tree, "/"-separated, files only. */
async function paths(store: Store, tree: CID): Promise<string[]> {
  const out: string[] = [];
  for await (const e of walk(store, tree, "")) out.push(e.path);
  return out.sort();
}

test("onlyIgnore: named files and everything under a named directory, directories on the way, never node_modules; * within a segment", async (t) => {
  const d = await agentDir(t);
  await fs.mkdir(join(d, "data"));
  const ig = onlyIgnore(d, ["SOUL.md", "IDENTITY.md", "skills", "data/*.json"]);
  assert.deepEqual(["SOUL.md", "IDENTITY.md", "skills", "skills/x.md", "data", "data/r.json"].filter(ig), []);
  assert.deepEqual(["bun.lock", "src", "src/index.ts", "node_modules", "package.json", "data/r.txt", "SOUL.md.bak"].filter((p) => !ig(p)), []);
  assert.ok(onlyIgnore(d, ["*"])("node_modules"), "node_modules is never kept");
  assert.ok(!onlyIgnore(d, ["*"])("src/index.ts"));
});

test("deploy: the filtered tree through `objects` as the owner sets main; the same directory again sends nothing; an edited SOUL.md moves main and the next new conversation reads it", async (t) => {
  const h = await setup();
  const r = await startInstance(rowOf("martha"), h.o);
  const dir = await agentDir(t);
  let row = rowOf("martha", r.identity);

  // First deploy: the instance's store is given (read-only use), no main yet → objects only.
  const d1 = await deploy({ row, dir, owner: h.owner.wallet, box: h.owner.box, store: r.store });
  assert.equal(d1.unchanged, false);
  assert.equal(d1.head, false, "no main yet: objects-handler sets it from the root");
  assert.equal(d1.records, 5, "SOUL.md, IDENTITY.md, skills/x.md, skills/, the root");
  assert.ok(h.hub.pending(r.identity, "objects").every((m) => m.sender === h.owner.identity), "sent as the owner");
  await settle(r);
  const root1 = CID.parse(d1.root);
  assert.ok((await headTree(r.store, MAIN))?.equals(root1), h.lines.join("\n"));
  assert.deepEqual(await paths(r.store, root1), ["IDENTITY.md", "SOUL.md", "skills/x.md"]);
  assert.deepEqual((await readTree(r.store, root1)).map((e) => e.name), ["IDENTITY.md", "SOUL.md", "skills"]);
  const log = await readLog(r.store);
  assert.deepEqual(log.slice(1).map((x) => x.entry.box), ["objects"], "one bundle, admitted as a host-signed entry");
  row = { ...row, tree: d1.root };

  // The same directory: nothing sent.
  const d2 = await deploy({ row, dir, owner: h.owner.wallet, box: h.owner.box, store: r.store });
  assert.deepEqual(d2, { root: d1.root, unchanged: true, records: 0, bundles: 0, head: false });
  assert.equal(h.hub.pending(r.identity, "objects").length + h.hub.pending(r.identity, "head").length, 0);

  // Edited SOUL.md: only what the store lacks (the new blob, the new root), then `head main`.
  await fs.writeFile(join(dir, "SOUL.md"), "You are Martha, now at the back office.\n");
  const d3 = await deploy({ row, dir, owner: h.owner.wallet, box: h.owner.box, store: r.store });
  assert.equal(d3.records, 2);
  assert.equal(d3.head, true);
  await settle(r);
  const root3 = CID.parse(d3.root);
  assert.ok((await headTree(r.store, MAIN))?.equals(root3), h.lines.join("\n"));
  assert.deepEqual((await readLog(r.store)).slice(1).map((x) => x.entry.box), ["objects", "objects", "head"]);

  // A new conversation (no tree: main's) gets the new prompt.
  const env = await seal(h.owner.wallet, { recipient: { identityKey: r.identity, handle: "martha", domain: "localhost" }, body: dagCbor.encode({ text: "who are you?" }), created: iso(h.clock.now()) });
  await h.owner.box.send({ recipient: r.identity, box: "chat", body: env });
  await settle(r);
  assert.equal(await h.peer.poll(), 1, h.lines.join("\n"));
  assert.equal((h.requests[0].messages as Json[])[0].content, `You are Martha, now at the back office.\n\n${IDENTITY}`);
  await settle(r);
  assert.equal((await collect(r.store.edges.query({ kind: "thread", program: PROGRAM_CIDS.loop }))).length, 1);
  await r.stop();
});

test("deploy: before the instance ever ran (no store), a second deploy queued behind the first moves main by `head` once both are admitted", async (t) => {
  const h = await setup();
  const r = await startInstance(rowOf("kurt"), h.o);
  const dir = await agentDir(t);
  const row = rowOf("kurt", r.identity);
  const d1 = await deploy({ row, dir, owner: h.owner.wallet, box: h.owner.box });
  await fs.writeFile(join(dir, "IDENTITY.md"), "- Name: Kurt\n");
  const d2 = await deploy({ row: { ...row, tree: d1.root }, dir, owner: h.owner.wallet, box: h.owner.box });
  assert.equal(d2.head, true, "an earlier deploy is on its way to setting main");
  assert.equal(d2.records, 5, "no store to ask: everything goes");
  await settle(r);
  assert.ok((await headTree(r.store, MAIN))?.equals(CID.parse(d2.root)), h.lines.join("\n"));
  await r.stop();
});

test("deploy: refused when the store's genesis owner is not the owner wallet, or the row has no identity", async (t) => {
  const h = await setup();
  const r = await startInstance(rowOf("martha"), h.o);
  const dir = await agentDir(t);
  const stranger = ephemeralWallet(PrivateKey.fromRandom());
  await assert.rejects(deploy({ row: rowOf("martha", r.identity), dir, owner: stranger, box: h.owner.box, store: r.store }), /genesis owner/);
  await assert.rejects(deploy({ row: rowOf("martha"), dir, owner: h.owner.wallet, box: h.owner.box }), /no identity/);
  await r.stop();
});

test("skein-host deploy: records the root and source in the row; again: unchanged; --all redeploys rows with a source", async (t) => {
  const h = await setup();
  const r = await startInstance(rowOf("martha"), h.o);
  const home = await tmp(t);
  const dir = await agentDir(t);
  const out: string[] = [], err: string[] = [];
  const env = { vars: { SKEIN_HOME: home, SKEIN_OWNER: h.owner.identity }, out: (l: string) => out.push(l), err: (l: string) => err.push(l), owner: h.owner, store: () => r.store };
  const cli = (...argv: string[]) => main(argv, env);
  assert.equal(await cli("add", "martha", "--identity", r.identity, "--store", "mem:martha"), 0);
  assert.equal(await cli("add", "kurt", "--store", "mem:kurt"), 0);
  assert.equal(await cli("deploy", "martha", dir), 0, err.join("\n"));
  const db = new HostDb(join(home, "host.db"));
  const tree = db.get("martha")!.tree!;
  assert.equal(db.get("martha")!.source, dir);
  assert.match(out.at(-1)!, new RegExp(`^martha: deployed ${tree} · 5 objects in 1 envelope\\(s\\) to objects$`));
  await settle(r);
  assert.equal(await cli("deploy", "martha", dir), 0);
  assert.equal(out.at(-1), `martha: unchanged ${tree}`);
  assert.equal(await cli("deploy", "--all"), 0);
  assert.deepEqual(out.slice(-2), ["kurt: never deployed (no source directory); skipped", `martha: unchanged ${tree}`]);
  assert.equal(await cli("deploy", "nobody", dir), 1);
  assert.equal(await main(["deploy", "martha", dir], { ...env, vars: { ...env.vars, SKEIN_OWNER: "02" + "e".repeat(64) } }), 1);
  assert.match(err.at(-1)!, /not SKEIN_OWNER/);
  db.close();
  await r.stop();
});

// ---------------------------------------------------------------- the roster

test("parseIdentity: the `- Key: value` lines of IDENTITY.md", () => {
  assert.deepEqual(parseIdentity(IDENTITY), { displayName: "Martha", emoji: ":woman_office_worker:", description: "Organization front desk and directory service." });
  assert.deepEqual(parseIdentity("# Identity\n\n- Name: Kurt\n- Role: account-manager\n- Avatar: https://x/k.png\n"), { displayName: "Kurt", description: "", avatar: "https://x/k.png" });
  assert.deepEqual(parseIdentity(""), { displayName: "", description: "" });
});

test("roster: a deployed row has its IDENTITY.md fields; one not deployed has empty ones; live per the host process; served as /roster.json with CORS *", async (t) => {
  const h = await setup();
  const a = await startInstance(rowOf("martha"), h.o);
  const b = await startInstance(rowOf("kurt"), h.o);
  const db = new HostDb(join(await tmp(t), "host.db"));
  db.add("martha", { store: "mem:martha", identity: a.identity }, new Date(0));
  db.add("kurt", { store: "mem:kurt", identity: b.identity }, new Date(1));
  const dir = await agentDir(t);
  const d = await deploy({ row: db.get("martha")!, dir, owner: h.owner.wallet, box: h.owner.box, store: a.store });
  db.add("martha", { tree: d.root });
  await settle(a);
  const stores: Record<string, Store> = { martha: a.store, kurt: b.store };
  const get = () => roster(db.list("enabled"), async (row) => ({ blocks: stores[row.handle] }), (row) => row.handle === "martha");
  const expected = [
    { handle: "martha", domain: "localhost", identity: a.identity, displayName: "Martha", description: "Organization front desk and directory service.", emoji: ":woman_office_worker:", status: "live" },
    { handle: "kurt", domain: "localhost", identity: b.identity, displayName: "", description: "", status: "idle" },
  ];
  assert.deepEqual(await get(), expected);
  assert.equal(new TextDecoder().decode(await readFile(a.store, CID.parse(d.root), "IDENTITY.md")), IDENTITY);

  const server = await serveRoster(0, get);
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const res = await fetch(`http://127.0.0.1:${port}/roster.json`, { headers: { origin: "http://elsewhere.example" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(await res.json(), expected);
  assert.equal((await fetch(`http://127.0.0.1:${port}/roster.json`, { method: "OPTIONS" })).status, 204);
  assert.equal((await fetch(`http://127.0.0.1:${port}/other`)).status, 404);

  // A tree the store does not have yet (deploy queued, not admitted): empty fields, not an error.
  db.add("kurt", { tree: d.root });
  assert.equal((await get())[1].displayName, "");
  db.close();
  await a.stop();
  await b.stop();
});

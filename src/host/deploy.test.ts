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
import { currentSubscriptions } from "../runtime/subscriptions.ts";
import { gitCid, readFile, readTree, walk } from "../runtime/tree.ts";
import { ephemeralWallet } from "../wallet.ts";
import { main } from "./cli.ts";
import { hashDir } from "../client/client.ts";
import { DEFAULT_ONLY, deploy, deployFiles, onlyIgnore } from "./deploy.ts";
import { startInstance, type HostOptions, type Running } from "./host.ts";
import { HostDb, type InstanceRow } from "./instances.ts";
import { parseIdentity, roster, rosterFor, serveRoster } from "./roster.ts";

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
  handle, domain: "localhost", identity, wallet_url: null, wallet_originator: "skein", store: `mem:${handle}`, tree, source: null, knows: null, status: "enabled", created_at: iso(T0),
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

test("skein-host subscribe: a `subscribe` message as the owner changes a running instance's subscriptions; no new genesis", async (t) => {
  const h = await setup();
  const r = await startInstance(rowOf("martha"), h.o);
  const home = await tmp(t);
  const out: string[] = [], err: string[] = [];
  const env = { vars: { SKEIN_HOME: home, SKEIN_OWNER: h.owner.identity }, out: (l: string) => out.push(l), err: (l: string) => err.push(l), owner: h.owner, store: () => r.store };
  const cli = (...argv: string[]) => main(argv, env);
  assert.equal(await cli("add", "martha", "--identity", r.identity, "--store", "mem:martha"), 0);
  const genesis = (await readLog(r.store))[0].cid;
  const peer = PrivateKey.fromRandom().toPublicKey().toString();
  const last = async () => (await currentSubscriptions(r.store))!.at(-1)!;

  assert.equal(await cli("subscribe", "martha", "add", "--sender", peer, "run", "run-handler"), 0, err.join("\n"));
  await settle(r);
  assert.deepEqual([(await last()).match, String((await last()).handler)], [{ sender: peer, box: "run" }, String(PROGRAM_CIDS["run-handler"])]);
  assert.equal(await cli("subscribe", "martha", "remove", "--sender", peer, "run", String(PROGRAM_CIDS["run-handler"])), 0);
  await settle(r);
  assert.equal((await last()).match.box, "chat", "removed: the open chat is last again");
  assert.ok((await readLog(r.store))[0].cid.equals(genesis), "the same genesis");

  assert.equal(await cli("subscribe", "martha", "swap", "run", "loop"), 2);
  assert.equal(await cli("subscribe", "nobody", "add", "run", "loop"), 1);
  assert.equal(await cli("subscribe", "martha", "add", "run", "no-such-program"), 1);
  assert.match(err.at(-1)!, /not a program name/);
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

// ---------------------------------------------------------------- each agent's ROSTER.md (#27)

const KURT = "# IDENTITY\n\n- Name: Kurt\n- Description: Account manager for\n";

test("rosterFor: the rows a row knows, in row order, never itself; `- @handle@domain — Name: description`; no name → the handle; knows nobody → no file", async () => {
  const rows = [
    { ...rowOf("martha"), knows: '["*"]' },
    { ...rowOf("kurt"), knows: '["martha", "ghost"]' },
    { ...rowOf("flow"), domain: "bopen.ai" },
  ];
  const fields: Record<string, { displayName: string; description: string }> = {
    martha: { displayName: "Martha", description: "Organization front desk and directory service." },
    kurt: { displayName: "Kurt", description: "Account manager." },
    flow: { displayName: "", description: "" },
  };
  const f = async (r: InstanceRow) => fields[r.handle]!;
  assert.equal(await rosterFor(rows[0]!, rows, f), "## Colleagues\n\n- @kurt@localhost — Kurt: Account manager.\n- @flow@bopen.ai — flow\n");
  assert.equal(await rosterFor(rows[1]!, rows, f), "## Colleagues\n\n- @martha@localhost — Martha: Organization front desk and directory service.\n");
  assert.equal(await rosterFor(rows[2]!, rows, f), undefined);
  assert.equal(await rosterFor({ ...rowOf("solo"), knows: '["*"]' }, [], f), undefined);
});

test("deploy with files: ROSTER.md joins the tree (not the directory); the same again is unchanged; a roster change alone moves main; null removes it; deployFiles does it from the store alone", async (t) => {
  const h = await setup();
  const r = await startInstance(rowOf("martha"), h.o);
  const dir = await agentDir(t);
  let row = rowOf("martha", r.identity);
  const deployWith = (roster: string | null) => deploy({ row, dir, owner: h.owner.wallet, box: h.owner.box, store: r.store, files: { "ROSTER.md": roster } });

  const d1 = await deployWith("## Colleagues\n\n- @kurt@localhost — Kurt\n");
  assert.equal(d1.records, 6, "SOUL.md, IDENTITY.md, ROSTER.md, skills/x.md, skills/, the root");
  await settle(r);
  const root1 = CID.parse(d1.root);
  assert.ok((await headTree(r.store, MAIN))?.equals(root1));
  assert.deepEqual(await paths(r.store, root1), ["IDENTITY.md", "ROSTER.md", "SOUL.md", "skills/x.md"]);
  assert.equal(new TextDecoder().decode(await readFile(r.store, root1, "ROSTER.md")), "## Colleagues\n\n- @kurt@localhost — Kurt\n");
  assert.equal(await fs.stat(join(dir, "ROSTER.md")).catch(() => undefined), undefined, "nothing written into the directory");
  row = { ...row, tree: d1.root };

  assert.equal((await deployWith("## Colleagues\n\n- @kurt@localhost — Kurt\n")).unchanged, true);

  const d2 = await deployWith("## Colleagues\n\n- @kurt@localhost — Kurt: Account manager.\n");
  assert.deepEqual([d2.unchanged, d2.records, d2.head], [false, 2, true], "the new ROSTER.md and root, then head");
  await settle(r);
  assert.ok((await headTree(r.store, MAIN))?.equals(CID.parse(d2.root)));
  row = { ...row, tree: d2.root };

  const d3 = await deployWith(null);
  await settle(r);
  assert.deepEqual(await paths(r.store, CID.parse(d3.root)), ["IDENTITY.md", "SOUL.md", "skills/x.md"]);
  assert.equal(d3.root, (await hashDir(dir, { ignore: onlyIgnore(dir, DEFAULT_ONLY) })).root.toString(), "no ROSTER.md: the directory's own tree");
  row = { ...row, tree: d3.root };

  // No directory: the deployed tree from the store, ROSTER.md set; same root as deploying the directory with it.
  const f1 = await deployFiles({ row, owner: h.owner.wallet, box: h.owner.box, store: r.store, files: { "ROSTER.md": "## Colleagues\n\n- @kurt@localhost — Kurt\n" } });
  assert.deepEqual([f1.root, f1.records, f1.head], [d1.root, 0, true], "the store has every object already: only head");
  await settle(r);
  assert.ok((await headTree(r.store, MAIN))?.equals(root1));
  assert.equal((await deployFiles({ row: { ...row, tree: f1.root }, owner: h.owner.wallet, box: h.owner.box, store: r.store, files: { "ROSTER.md": "## Colleagues\n\n- @kurt@localhost — Kurt\n" } })).unchanged, true);
  // A new store (the instance was reset: a new genesis) that lacks the row's tree: not unchanged.
  const fresh = await startInstance(rowOf("martha2"), h.o);
  const again = await deploy({ row: { ...rowOf("martha2", fresh.identity), tree: d1.root }, dir, owner: h.owner.wallet, box: h.owner.box, store: fresh.store, files: { "ROSTER.md": "## Colleagues\n\n- @kurt@localhost — Kurt\n" } });
  assert.deepEqual([again.root, again.unchanged, again.records], [d1.root, false, 6]);
  await settle(fresh);
  assert.ok((await headTree(fresh.store, MAIN))?.equals(root1), h.lines.join("\n"));
  await fresh.stop();
  await assert.rejects(deployFiles({ row: { ...row, tree: gitCid("0".repeat(40)).toString() }, owner: h.owner.wallet, box: h.owner.box, store: r.store, files: {} }), /does not have the deployed tree/);
  await r.stop();
});

test("skein-host knows / roster --for / deploy / roster --deploy: each agent's ROSTER.md from host.db and the deployed IDENTITY.md; only a changed roster redeploys", async (t) => {
  const h = await setup();
  const m = await startInstance(rowOf("martha"), h.o);
  const k = await startInstance(rowOf("kurt"), h.o);
  const home = await tmp(t);
  const mdir = await agentDir(t);
  const kdir = await agentDir(t);
  await fs.writeFile(join(kdir, "IDENTITY.md"), KURT);
  const stores: Record<string, Store> = { martha: m.store, kurt: k.store };
  const out: string[] = [], err: string[] = [];
  const env = { vars: { SKEIN_HOME: home, SKEIN_OWNER: h.owner.identity }, out: (l: string) => out.push(l), err: (l: string) => err.push(l), owner: h.owner, store: (row: InstanceRow) => stores[row.handle] };
  const cli = (...argv: string[]) => main(argv, env);
  const rosterOf = async (r: Running) => new TextDecoder().decode(await readFile(r.store, (await headTree(r.store, MAIN))!, "ROSTER.md"));
  assert.equal(await cli("add", "martha", "--identity", m.identity, "--store", "mem:martha"), 0);
  assert.equal(await cli("add", "kurt", "--identity", k.identity, "--store", "mem:kurt", "--knows", "martha"), 0);
  assert.equal(await cli("knows", "martha", "--all"), 0);
  assert.equal(out.at(-1), "martha knows everyone");
  assert.equal(await cli("knows", "kurt"), 0);
  assert.equal(out.at(-1), "kurt knows martha");

  // Before anything is deployed: the handle stands in for the name.
  assert.equal(await cli("roster", "--for", "martha"), 0);
  assert.equal(out.at(-1), "## Colleagues\n\n- @kurt@localhost — kurt");

  // Martha first (Kurt has no IDENTITY.md anywhere yet), then Kurt (Martha's is in her store).
  assert.equal(await cli("deploy", "martha", mdir), 0, err.join("\n"));
  assert.equal(await cli("deploy", "kurt", kdir), 0, err.join("\n"));
  await settle(m); await settle(k);
  assert.equal(await rosterOf(m), "## Colleagues\n\n- @kurt@localhost — kurt\n");
  assert.equal(await rosterOf(k), "## Colleagues\n\n- @martha@localhost — Martha: Organization front desk and directory service.\n");
  assert.equal(await fs.stat(join(mdir, "ROSTER.md")).catch(() => undefined), undefined);

  // Kurt's IDENTITY.md is deployed now: only Martha's roster changed.
  const db = new HostDb(join(home, "host.db"));
  const kurtTree = db.get("kurt")!.tree!;
  assert.equal(await cli("roster", "--deploy"), 0, err.join("\n"));
  const [kl, ml] = out.slice(-2).sort(); // rows in created_at order: the same ms here
  assert.equal(kl, `kurt: unchanged ${kurtTree}`);
  assert.match(ml!, /^martha: deployed \S+ · 2 objects in 1 envelope\(s\) to objects · head main$/);
  await settle(m);
  assert.equal(await rosterOf(m), "## Colleagues\n\n- @kurt@localhost — Kurt: Account manager for\n");
  assert.equal((await headTree(m.store, MAIN))!.toString(), db.get("martha")!.tree);
  assert.equal(await cli("roster", "--for", "martha"), 0);
  assert.equal(out.at(-1), "## Colleagues\n\n- @kurt@localhost — Kurt: Account manager for");

  // Again, and deploy --all from the source directories: all unchanged.
  const trees = () => [db.get("martha")!.tree, db.get("kurt")!.tree];
  const before = trees();
  assert.equal(await cli("roster", "--deploy"), 0);
  assert.deepEqual(out.slice(-2).sort(), [`kurt: unchanged ${before[1]}`, `martha: unchanged ${before[0]}`]);
  assert.equal(await cli("deploy", "--all"), 0);
  assert.deepEqual(out.slice(-2).sort(), [`kurt: unchanged ${before[1]}`, `martha: unchanged ${before[0]}`]);

  // Kurt knows nobody now: his tree loses ROSTER.md.
  assert.equal(await cli("knows", "kurt", "--none"), 0);
  assert.equal(await cli("roster", "--for", "kurt"), 0);
  assert.equal(err.at(-1), "kurt knows nobody: no ROSTER.md");
  assert.equal(await cli("roster", "--deploy"), 0);
  assert.equal(out.slice(-2).sort()[1], `martha: unchanged ${before[0]}`);
  assert.match(out.slice(-2).sort()[0]!, /^kurt: deployed \S+ · 1 objects in 1 envelope\(s\) to objects · head main$/);
  await settle(k);
  assert.deepEqual(await paths(k.store, (await headTree(k.store, MAIN))!), ["IDENTITY.md", "SOUL.md", "skills/x.md"]);

  assert.equal(await cli("knows", "nobody", "--all"), 1);
  assert.equal(await cli("knows", "kurt", "martha", "--all"), 2);
  db.close();
  await m.stop();
  await k.stop();
});

// Deployment via `objects` (#23) and the front end's roster (#24), with the
// real Zig kernel behind a router (testhost.ts): the host sends a filtered
// directory into an instance as the owner; the first root sets main, a
// changed directory moves it through `head`, an unchanged one sends nothing;
// the loop's next new conversation reads the new SOUL.md. The roster reads
// IDENTITY.md from the deployed tree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKey } from "@bsv/sdk";
import { CID } from "multiformats/cid";
import { RawBox } from "../client/raw.ts";
import { hashDir } from "../client/client.ts";
import { InferPeer } from "../peers/infer.ts";
import { headTree, MAIN } from "../runtime/heads.ts";
import { openStoreFile } from "../runtime/index-store.ts";
import type { Store } from "../runtime/store.ts";
import { currentSubscriptions } from "../runtime/subscriptions.ts";
import { gitCid, readFile, readTree, walk } from "../runtime/tree.ts";
import { collect, iso, T0 } from "../testkit.ts";
import { ephemeralWallet } from "../wallet.ts";
import { main } from "./cli.ts";
import { DEFAULT_ONLY, deploy, deployFiles, onlyIgnore } from "./deploy.ts";
import { HostDb, type InstanceRow } from "./instances.ts";
import { KERNEL_BIN } from "./kernel.ts";
import { parseIdentity, roster, rosterFor, serveRoster } from "./roster.ts";
import { messagesIn, testHost, until } from "./testhost.ts";

type Json = Record<string, unknown>;
const skip = !existsSync(KERNEL_BIN) && "kernel-zig not built";

async function tmp(t: { after(fn: () => unknown): void }, prefix = "skein-deploy-"): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const SOUL = "You are Martha, the front desk.\n";
const IDENTITY = "# IDENTITY\n\n- Name: Martha\n- Emoji: :woman_office_worker:\n- Theme: front desk\n- Description: Organization front desk and directory service.\n";

/** An agent directory as in b-open-io/prompts/.agents/<name>/, with the code around it. */
async function agentDir(t: { after(fn: () => unknown): void }): Promise<string> {
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

/**
 * A test host with the owner's and the inference peer's mailboxes and the
 * agents `handles`, started; the owner's sessions with each front door; an
 * infer peer answering from a script; each agent's store file, read-only.
 */
async function setup(t: { after(fn: () => unknown): void }, handles: string[]) {
  const inferKey = PrivateKey.fromRandom(), inferId = inferKey.toPublicKey().toString();
  const h = await testHost(t, { infer: inferId });
  h.mailbox("david", h.ownerId);
  h.mailbox("infer", inferId);
  for (const x of handles) h.agent(x);
  await h.router.start();
  const requests: Json[] = [];
  const f = (async (_url: string, init: { body: string }) => {
    requests.push(JSON.parse(init.body));
    return Response.json(answer("ok"));
  }) as unknown as typeof fetch;
  const w = ephemeralWallet(inferKey);
  const peer = new InferPeer({
    wallet: w, providers: { ripper: { baseUrl: "http://ripper.test/v1", apiKey: "k" } }, fetch: f, log: (l) => h.lines.push(`[infer] ${l}`),
    raw: {
      inbox: new RawBox(w, `${h.base}/@infer`),
      outbox: (url) => new RawBox(w, url),
      addressOf: (k) => { const r = h.db.list().find((x) => x.identity === k && x.kind !== "mailbox"); return r && h.origin(r.handle); },
    },
  });
  const owner = { wallet: h.owner, box: (row: { handle: string }) => new RawBox(h.owner, `${h.base}/@${row.handle}`) };
  const stores = new Map<string, Store>();
  const store = async (handle: string): Promise<Store> => {
    let s = stores.get(handle);
    if (!s) {
      await h.router.hydrate(handle);
      s = openStoreFile(h.db.get(handle)!.store, { readOnly: true });
      stores.set(handle, s);
      t.after(() => s!.close());
    }
    return s;
  };
  const env = (vars: Record<string, string> = {}) => {
    const out: string[] = [], err: string[] = [];
    return {
      out, err,
      env: {
        vars: { SKEIN_HOME: h.home, SKEIN_OWNER: h.ownerId, SKEIN_ROUTER_PORT: String(h.router.port), SKEIN_MASTER_KEY: "11".repeat(32), ...vars },
        out: (l: string) => out.push(l), err: (l: string) => err.push(l), owner,
      },
    };
  };
  return { h, peer, requests, owner, store, env };
}

/** The boxes of the messages the instance took in after the genesis (routed from its requests, #68), in order. */
async function boxes(store: Store): Promise<string[]> {
  return (await messagesIn(store)).map((m) => String(m.box));
}

/** The genesis's programs: name → program record CID. */
async function programsOf(store: Store): Promise<Record<string, CID>> {
  for await (const { entry } of store.log.entries(0)) return (await store.get(entry.genesis!) as Json).programs as Record<string, CID>;
  throw new Error("no genesis");
}

const mainIs = (store: Store, root: string) => until(`main at ${root}`, async () => (await headTree(store, MAIN))?.toString() === root ? true : undefined);

const rowOf = (handle: string, identity: string | null = null, tree: string | null = null): InstanceRow => ({
  handle, domain: "localhost", identity, wallet_url: null, wallet_originator: "skein", store: `${handle}.db`, tree, source: null, knows: null, status: "enabled", created_at: iso(T0),
});

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

test("deploy: the filtered tree through `objects` as the owner sets main; the same directory again sends nothing; an edited SOUL.md moves main and the next new conversation reads it", { skip }, async (t) => {
  const { h, peer, requests, owner, store } = await setup(t, ["martha"]);
  const s = await store("martha");
  const dir = await agentDir(t);
  let row = h.db.get("martha")!;

  // First deploy: the instance's store is given (read-only use), no main yet → objects only.
  const d1 = await deploy({ row, dir, owner: owner.wallet, box: owner.box(row), store: s });
  assert.equal(d1.unchanged, false);
  assert.equal(d1.head, false, "no main yet: objects-handler sets it from the root");
  assert.equal(d1.records, 5, "SOUL.md, IDENTITY.md, skills/x.md, skills/, the root");
  await mainIs(s, d1.root);
  const root1 = CID.parse(d1.root);
  assert.deepEqual(await paths(s, root1), ["IDENTITY.md", "SOUL.md", "skills/x.md"]);
  assert.deepEqual((await readTree(s, root1)).map((e) => e.name), ["IDENTITY.md", "SOUL.md", "skills"]);
  assert.deepEqual(await boxes(s), ["objects"], "one bundle, one message");
  for (const m of await messagesIn(s)) assert.equal(Buffer.from(m.sender as Uint8Array).toString("hex"), h.ownerId, "sent as the owner");
  row = { ...row, tree: d1.root };

  // The same directory: nothing sent.
  const d2 = await deploy({ row, dir, owner: owner.wallet, box: owner.box(row), store: s });
  assert.deepEqual(d2, { root: d1.root, unchanged: true, records: 0, bundles: 0, head: false });
  await h.router.settled();
  assert.deepEqual(await boxes(s), ["objects"]);

  // Edited SOUL.md: only what the store lacks (the new blob, the new root), then `head main`.
  await fs.writeFile(join(dir, "SOUL.md"), "You are Martha, now at the back office.\n");
  const d3 = await deploy({ row, dir, owner: owner.wallet, box: owner.box(row), store: s });
  assert.equal(d3.records, 2);
  assert.equal(d3.head, true);
  await mainIs(s, d3.root);
  assert.deepEqual(await boxes(s), ["objects", "objects", "head"]);

  // A new conversation (no tree: main's) gets the new prompt.
  await owner.box(row).send(row.identity!, "chat", { text: "who are you?" });
  await until("the inference request", async () => { await peer.poll(); return requests.length ? true : undefined; });
  const system = String((requests[0]!.messages as Json[])[0]!.content);
  assert.ok(system.includes("You are Martha, now at the back office.") && system.includes(IDENTITY), system);
  await h.router.settled();
  assert.equal((await collect(s.edges.query({ kind: "thread", program: (await programsOf(s)).loop }))).length, 1);
});

test("deploy: before the store is asked (none given), a second deploy queued behind the first moves main by `head` once both are admitted", { skip }, async (t) => {
  const { h, owner, store } = await setup(t, ["kurt"]);
  const dir = await agentDir(t);
  const row = h.db.get("kurt")!;
  const d1 = await deploy({ row, dir, owner: owner.wallet, box: owner.box(row) });
  await fs.writeFile(join(dir, "IDENTITY.md"), "- Name: Kurt\n");
  const d2 = await deploy({ row: { ...row, tree: d1.root }, dir, owner: owner.wallet, box: owner.box(row) });
  assert.equal(d2.head, true, "an earlier deploy is on its way to setting main");
  assert.equal(d2.records, 5, "no store to ask: everything goes");
  await mainIs(await store("kurt"), d2.root);
});

test("deploy: refused when the store's genesis owner is not the owner wallet, or the row has no identity", { skip }, async (t) => {
  const { h, owner, store } = await setup(t, ["martha"]);
  const dir = await agentDir(t);
  const stranger = ephemeralWallet(PrivateKey.fromRandom());
  const row = h.db.get("martha")!;
  await assert.rejects(deploy({ row, dir, owner: stranger, box: owner.box(row), store: await store("martha") }), /genesis owner/);
  await assert.rejects(deploy({ row: rowOf("martha"), dir, owner: owner.wallet, box: owner.box(row) }), /no identity/);
});

test("skein-host deploy: records the root and source in the row; again: unchanged; --all redeploys rows with a source", { skip }, async (t) => {
  const { h, env, store } = await setup(t, ["martha", "kurt"]);
  const dir = await agentDir(t);
  const e = env();
  const cli = (...argv: string[]) => main(argv, e.env);
  const mine = (l: string[], handle: string) => l.filter((x) => x.startsWith(`${handle}: `));
  assert.equal(await cli("deploy", "martha", dir), 0, e.err.join("\n"));
  const tree = h.db.get("martha")!.tree!;
  assert.equal(h.db.get("martha")!.source, dir);
  assert.match(mine(e.out, "martha").at(-1)!, new RegExp(`^martha: deployed ${tree} · 5 objects in 1 message\\(s\\) to objects$`));
  await mainIs(await store("martha"), tree);
  assert.equal(await cli("deploy", "martha", dir), 0);
  assert.equal(mine(e.out, "martha").at(-1), `martha: unchanged ${tree}`);
  const n = e.out.length;
  assert.equal(await cli("deploy", "--all"), 0);
  assert.deepEqual([...mine(e.out.slice(n), "kurt"), ...mine(e.out.slice(n), "martha")], ["kurt: never deployed (no source directory); skipped", `martha: unchanged ${tree}`]);
  assert.equal(await cli("deploy", "nobody", dir), 1);
  const other = env({ SKEIN_OWNER: "02" + "e".repeat(64) });
  assert.equal(await main(["deploy", "martha", dir], other.env), 1);
  assert.match(other.err.at(-1)!, /not SKEIN_OWNER/);
});

test("skein-host subscribe: a `subscribe` message as the owner changes a running instance's subscriptions, a handler named from its genesis; no new genesis", { skip }, async (t) => {
  const { env, store } = await setup(t, ["martha"]);
  const s = await store("martha");
  const e = env();
  const cli = (...argv: string[]) => main(argv, e.env);
  const genesis = (await collect(s.log.entries(0)))[0]!.cid;
  const before = await until("the genesis processed (its seed rules)", () => currentSubscriptions(s));
  const runHandler = (await programsOf(s))["run-handler"]!;
  const peer = PrivateKey.fromRandom().toPublicKey().toString();
  const last = async () => (await currentSubscriptions(s))!.at(-1)!;

  assert.equal(await cli("subscribe", "martha", "add", "--sender", peer, "run", "run-handler"), 0, e.err.join("\n"));
  await until("the new rule", async () => (await last()).match.sender === peer ? true : undefined);
  assert.deepEqual([(await last()).match, String((await last()).handler)], [{ sender: peer, box: "run" }, String(runHandler)]);
  assert.equal(await cli("subscribe", "martha", "remove", "--sender", peer, "run", String(runHandler)), 0);
  await until("the rule removed", async () => (await currentSubscriptions(s))!.length === before!.length ? true : undefined);
  assert.deepEqual(await currentSubscriptions(s), before, "removed: the rules as they were");
  assert.ok((await collect(s.log.entries(0)))[0]!.cid.equals(genesis), "the same genesis");

  assert.equal(await cli("subscribe", "martha", "swap", "run", "loop"), 2);
  assert.equal(await cli("subscribe", "nobody", "add", "run", "loop"), 1);
  assert.equal(await cli("subscribe", "martha", "add", "run", "no-such-program"), 1);
  assert.match(e.err.at(-1)!, /not a CID or a program name/);
});

// ---------------------------------------------------------------- the roster

test("parseIdentity: the `- Key: value` lines of IDENTITY.md", () => {
  assert.deepEqual(parseIdentity(IDENTITY), { displayName: "Martha", emoji: ":woman_office_worker:", description: "Organization front desk and directory service." });
  assert.deepEqual(parseIdentity("# Identity\n\n- Name: Kurt\n- Role: account-manager\n- Avatar: https://x/k.png\n"), { displayName: "Kurt", description: "", avatar: "https://x/k.png" });
  assert.deepEqual(parseIdentity(""), { displayName: "", description: "" });
});

test("roster: a deployed row has its IDENTITY.md fields; one not deployed has empty ones; live per the host process; served as /roster.json with CORS *", { skip }, async (t) => {
  const { h, owner, store } = await setup(t, ["martha", "kurt"]);
  const a = h.db.get("martha")!, b = h.db.get("kurt")!;
  const db = new HostDb(join(await tmp(t), "host.db"));
  t.after(() => db.close());
  db.add("martha", { store: a.store, identity: a.identity! }, new Date(0));
  db.add("kurt", { store: b.store, identity: b.identity! }, new Date(1));
  const dir = await agentDir(t);
  const d = await deploy({ row: db.get("martha")!, dir, owner: owner.wallet, box: owner.box(a), store: await store("martha") });
  db.add("martha", { tree: d.root });
  await mainIs(await store("martha"), d.root);
  const stores: Record<string, Store> = { martha: await store("martha"), kurt: await store("kurt") };
  const get = () => roster(db.list("enabled"), async (row) => ({ blocks: stores[row.handle] }), (row) => row.handle === "martha");
  const expected = [
    { handle: "martha", domain: "localhost", identity: a.identity, displayName: "Martha", description: "Organization front desk and directory service.", emoji: ":woman_office_worker:", status: "live" },
    { handle: "kurt", domain: "localhost", identity: b.identity, displayName: "", description: "", status: "idle" },
  ];
  assert.deepEqual(await get(), expected);
  assert.equal(new TextDecoder().decode(await readFile(stores.martha!, CID.parse(d.root), "IDENTITY.md")), IDENTITY);

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
  assert.equal((await get())[1]!.displayName, "");
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

test("deploy with files: ROSTER.md joins the tree (not the directory); the same again is unchanged; a roster change alone moves main; null removes it; deployFiles does it from the store alone", { skip }, async (t) => {
  const { h, owner, store } = await setup(t, ["martha", "martha2"]);
  const s = await store("martha");
  const dir = await agentDir(t);
  let row = h.db.get("martha")!;
  const box = owner.box(row);
  const deployWith = (roster: string | null) => deploy({ row, dir, owner: owner.wallet, box, store: s, files: { "ROSTER.md": roster } });

  const d1 = await deployWith("## Colleagues\n\n- @kurt@localhost — Kurt\n");
  assert.equal(d1.records, 6, "SOUL.md, IDENTITY.md, ROSTER.md, skills/x.md, skills/, the root");
  await mainIs(s, d1.root);
  const root1 = CID.parse(d1.root);
  assert.deepEqual(await paths(s, root1), ["IDENTITY.md", "ROSTER.md", "SOUL.md", "skills/x.md"]);
  assert.equal(new TextDecoder().decode(await readFile(s, root1, "ROSTER.md")), "## Colleagues\n\n- @kurt@localhost — Kurt\n");
  assert.equal(await fs.stat(join(dir, "ROSTER.md")).catch(() => undefined), undefined, "nothing written into the directory");
  row = { ...row, tree: d1.root };

  assert.equal((await deployWith("## Colleagues\n\n- @kurt@localhost — Kurt\n")).unchanged, true);

  const d2 = await deployWith("## Colleagues\n\n- @kurt@localhost — Kurt: Account manager.\n");
  assert.deepEqual([d2.unchanged, d2.records, d2.head], [false, 2, true], "the new ROSTER.md and root, then head");
  await mainIs(s, d2.root);
  row = { ...row, tree: d2.root };

  const d3 = await deployWith(null);
  await mainIs(s, d3.root);
  assert.deepEqual(await paths(s, CID.parse(d3.root)), ["IDENTITY.md", "SOUL.md", "skills/x.md"]);
  assert.equal(d3.root, (await hashDir(dir, { ignore: onlyIgnore(dir, DEFAULT_ONLY) })).root.toString(), "no ROSTER.md: the directory's own tree");
  row = { ...row, tree: d3.root };

  // No directory: the deployed tree from the store, ROSTER.md set; same root as deploying the directory with it.
  const f1 = await deployFiles({ row, owner: owner.wallet, box, store: s, files: { "ROSTER.md": "## Colleagues\n\n- @kurt@localhost — Kurt\n" } });
  assert.deepEqual([f1.root, f1.records, f1.head], [d1.root, 0, true], "the store has every object already: only head");
  await mainIs(s, d1.root);
  assert.equal((await deployFiles({ row: { ...row, tree: f1.root }, owner: owner.wallet, box, store: s, files: { "ROSTER.md": "## Colleagues\n\n- @kurt@localhost — Kurt\n" } })).unchanged, true);
  // Another store (as after a reset: a new genesis) that lacks the row's tree: not unchanged.
  const other = h.db.get("martha2")!;
  const fresh = await store("martha2");
  const again = await deploy({ row: { ...other, tree: d1.root }, dir, owner: owner.wallet, box: owner.box(other), store: fresh, files: { "ROSTER.md": "## Colleagues\n\n- @kurt@localhost — Kurt\n" } });
  assert.deepEqual([again.root, again.unchanged, again.records], [d1.root, false, 6]);
  await mainIs(fresh, d1.root);
  await assert.rejects(deployFiles({ row: { ...row, tree: gitCid("0".repeat(40)).toString() }, owner: owner.wallet, box, store: s, files: {} }), /does not have the deployed tree/);
});

test("skein-host knows / roster --for / deploy / roster --deploy: each agent's ROSTER.md from host.db and the deployed IDENTITY.md; only a changed roster redeploys", { skip }, async (t) => {
  const { h, env, store } = await setup(t, ["martha", "kurt"]);
  const mdir = await agentDir(t);
  const kdir = await agentDir(t);
  await fs.writeFile(join(kdir, "IDENTITY.md"), KURT);
  const e = env();
  const cli = (...argv: string[]) => main(argv, e.env);
  // What each command said about the agents (not the address-book lines roster --deploy also writes).
  const said = (from: number) => e.out.slice(from).filter((l) => /^(martha|kurt): (deployed|unchanged)/.test(l)).sort();
  const rosterOf = async (handle: string) => { const s = await store(handle); return new TextDecoder().decode(await readFile(s, (await headTree(s, MAIN))!, "ROSTER.md")); };
  // Not --all: the host's mailbox instances (david, infer) are rows too.
  assert.equal(await cli("knows", "martha", "kurt"), 0);
  assert.equal(e.out.at(-1), "martha knows kurt");
  assert.equal(await cli("knows", "kurt", "martha"), 0);
  assert.equal(await cli("knows", "kurt"), 0);
  assert.equal(e.out.at(-1), "kurt knows martha");

  // Before anything is deployed: the handle stands in for the name.
  assert.equal(await cli("roster", "--for", "martha"), 0);
  assert.equal(e.out.at(-1), "## Colleagues\n\n- @kurt@localhost — kurt");

  // Martha first (Kurt has no IDENTITY.md anywhere yet), then Kurt (Martha's is in her store).
  assert.equal(await cli("deploy", "martha", mdir), 0, e.err.join("\n"));
  await mainIs(await store("martha"), h.db.get("martha")!.tree!);
  assert.equal(await cli("deploy", "kurt", kdir), 0, e.err.join("\n"));
  await mainIs(await store("kurt"), h.db.get("kurt")!.tree!);
  assert.equal(await rosterOf("martha"), "## Colleagues\n\n- @kurt@localhost — kurt\n");
  assert.equal(await rosterOf("kurt"), "## Colleagues\n\n- @martha@localhost — Martha: Organization front desk and directory service.\n");
  assert.equal(await fs.stat(join(mdir, "ROSTER.md")).catch(() => undefined), undefined);

  // Kurt's IDENTITY.md is deployed now: only Martha's roster changed.
  const kurtTree = h.db.get("kurt")!.tree!;
  let n = e.out.length;
  assert.equal(await cli("roster", "--deploy"), 0, e.err.join("\n"));
  const [kl, ml] = said(n);
  assert.equal(kl, `kurt: unchanged ${kurtTree}`);
  assert.match(ml!, /^martha: deployed \S+ · 2 objects in 1 message\(s\) to objects · head main$/);
  await mainIs(await store("martha"), h.db.get("martha")!.tree!);
  assert.equal(await rosterOf("martha"), "## Colleagues\n\n- @kurt@localhost — Kurt: Account manager for\n");
  assert.equal(await cli("roster", "--for", "martha"), 0);
  assert.equal(e.out.at(-1), "## Colleagues\n\n- @kurt@localhost — Kurt: Account manager for");

  // Again, and deploy --all from the source directories: all unchanged.
  const before = [h.db.get("martha")!.tree, h.db.get("kurt")!.tree];
  n = e.out.length;
  assert.equal(await cli("roster", "--deploy"), 0);
  assert.deepEqual(said(n), [`kurt: unchanged ${before[1]}`, `martha: unchanged ${before[0]}`]);
  n = e.out.length;
  assert.equal(await cli("deploy", "--all"), 0);
  assert.deepEqual(said(n), [`kurt: unchanged ${before[1]}`, `martha: unchanged ${before[0]}`]);

  // Kurt knows nobody now: his tree loses ROSTER.md.
  assert.equal(await cli("knows", "kurt", "--none"), 0);
  assert.equal(await cli("roster", "--for", "kurt"), 0);
  assert.equal(e.err.at(-1), "kurt knows nobody: no ROSTER.md");
  n = e.out.length;
  assert.equal(await cli("roster", "--deploy"), 0);
  const [k2, m2] = said(n);
  assert.equal(m2, `martha: unchanged ${before[0]}`);
  assert.match(k2!, /^kurt: deployed \S+ · 1 objects in 1 message\(s\) to objects · head main$/);
  await mainIs(await store("kurt"), h.db.get("kurt")!.tree!);
  const ks = await store("kurt");
  assert.deepEqual(await paths(ks, (await headTree(ks, MAIN))!), ["IDENTITY.md", "SOUL.md", "skills/x.md"]);

  assert.equal(await cli("knows", "nobody", "--all"), 1);
  assert.equal(await cli("knows", "kurt", "martha", "--all"), 2);
});

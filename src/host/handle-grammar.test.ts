// One handle grammar (a hostname label) for every row (`add`, the manager's
// create, a mailbox instance), and the reserved names: `id`, `host`, and the first label of the router's own origin, which
// no instance may take and which never routes to one — unless the operator names it in SKEIN_MANAGER_FOR. No kernel needed: each
// refusal comes before anything is booted.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKey } from "@bsv/sdk";
import { ephemeralWallet } from "../wallet.ts";
import { HostDb } from "./instances.ts";
import { hostDomain, Router } from "./router.ts";

test("handles: one grammar for add, mailbox and create; the reserved names and the router's own label", async (t) => {
  const home = await fs.mkdtemp(join(tmpdir(), "skein-handles-"));
  const db = new HostDb(join(home, "host.db"));
  const router = new Router({ db, walletFor: () => ephemeralWallet(PrivateKey.fromRandom()), home, origin: "https://id.example.test", idleMs: 0, ledgerMs: 60_000 });
  t.after(async () => { await router.stop(); db.close(); await fs.rm(home, { recursive: true, force: true }); });
  const key = PrivateKey.fromRandom().toPublicKey().toString();

  for (const bad of ["a.b", "a_b", "Alice", "-a", "a-", "x".repeat(64)]) {
    assert.throws(() => db.add(bad, { store: join(home, `${bad}.db`) }), /hostname label/, `add ${bad}`);
    await assert.rejects(router.createInstance(bad, key, { image: "mailbox" }), /hostname label/, `mailbox ${bad}`);
    await assert.rejects(router.createInstance(bad, key), /hostname label/, `create ${bad}`);
  }
  db.add("alice", { store: join(home, "alice.db") });

  assert.equal(router.ownLabel(), "id");
  for (const r of ["id", "host"]) {
    assert.ok(router.reserved(r));
    await assert.rejects(router.createInstance(r, key, { image: "mailbox" }), /reserved/, `mailbox ${r}`);
    await assert.rejects(router.createInstance(r, key), /reserved/, `create ${r}`);
  }
  assert.ok(!router.reserved("alice"));

  // A row named like the router's origin (an older host.db) still never takes the router's requests.
  db.add("id", { store: join(home, "id.db") });
  assert.equal(router.target(new URL("https://id.example.test/manifest.json")), undefined);
  assert.deepEqual(router.target(new URL("https://alice.example.test/x")), { handle: "alice", route: "/x" });

  // #161: a token id is a path-only handle: added, reached by /@<handle> only, its origin the host's /@<handle>.
  const tok = `${"ab".repeat(32)}_0`;
  db.add(tok, { store: join(home, "tok.db"), status: "disabled" });
  assert.equal(router.originOf(tok), `https://id.example.test/@${tok}`);
  assert.equal(router.target(new URL(`https://id.example.test/@${tok}/x`)), undefined, "disabled: not routed");
  db.setStatus(tok, "enabled");
  assert.deepEqual(router.target(new URL(`https://id.example.test/@${tok}/x`)), { handle: tok, route: "/x" });
  assert.equal(router.target(new URL(`https://${tok}.example.test/x`)), undefined, "never by host name");
  for (const bad of [`${"AB".repeat(32)}_0`, `${"ab".repeat(31)}_0`, `${"ab".repeat(32)}_`, `${"ab".repeat(32)}.0`]) assert.throws(() => db.add(bad, { store: join(home, "x.db") }), /hostname label/, `add ${bad}`);

  // The router's own label as an instance: only one the operator names in SKEIN_MANAGER_FOR (managerFor).
  const own = new Router({ db, walletFor: () => ephemeralWallet(PrivateKey.fromRandom()), home, origin: "https://swap.example.test", managerFor: ["swap"], idleMs: 0, ledgerMs: 60_000 });
  t.after(() => own.stop());
  assert.equal(own.ownLabel(), "swap");
  assert.ok(!own.reserved("swap") && own.ownLabelInstance("swap"));
  assert.ok(own.reserved("id") && own.reserved("host"));
  db.add("swap", { store: join(home, "swap.db") });
  assert.deepEqual(own.target(new URL("https://swap.example.test/amm/tokens")), { handle: "swap", route: "/amm/tokens" });
  assert.deepEqual(own.target(new URL(`https://swap.example.test/@${tok}/x`)), { handle: tok, route: "/x" }, "/@<handle> at the shared name");
  const notNamed = new Router({ db, walletFor: () => ephemeralWallet(PrivateKey.fromRandom()), home, origin: "https://swap.example.test", idleMs: 0, ledgerMs: 60_000 });
  t.after(() => notNamed.stop());
  assert.ok(notNamed.reserved("swap"));
  assert.equal(notNamed.target(new URL("https://swap.example.test/amm/tokens")), undefined, "not named in managerFor: never routed");

  // A router at a loopback address has no label of its own.
  const local = new Router({ db, walletFor: () => ephemeralWallet(PrivateKey.fromRandom()), home, idleMs: 0, ledgerMs: 60_000 });
  t.after(() => local.stop());
  assert.equal(local.ownLabel(), undefined);
  // No root instance: the bare root is nobody's.
  assert.equal((await local.dispatch({ method: "GET", url: "http://127.0.0.1:1/", headers: {}, body: new Uint8Array() })).status, 404);

  // SKEIN_ROOT_INSTANCE (rootInstance): the host's own paths still come first at a hostname that is no instance's.
  const rooted = new Router({ db, walletFor: () => ephemeralWallet(PrivateKey.fromRandom()), home, rootInstance: "swap", idleMs: 0, ledgerMs: 60_000 });
  t.after(() => rooted.stop());
  const wk = await rooted.dispatch({ method: "GET", url: "http://127.0.0.1:1/.well-known/skein-host", headers: {}, body: new Uint8Array() });
  assert.equal(wk.status, 200, "the host's own .well-known, not the root instance's");
  assert.equal((await rooted.dispatch({ method: "GET", url: "http://127.0.0.1:1/skeins?key=zz", headers: {}, body: new Uint8Array() })).status, 400, "the host's own /skeins");
  db.add("swap", { status: "disabled" });
  assert.equal((await rooted.dispatch({ method: "GET", url: "http://127.0.0.1:1/", headers: {}, body: new Uint8Array() })).status, 404, "a disabled root instance serves nothing");
  // An enabled root instance takes every other path at that hostname — the BRC-103 handshake and the app's
  // manifest included (they were the host skein's BRC-169 set before: the handshake's session then lived in the
  // wrong instance and every signed request to the root instance came back unsigned).
  db.setStatus("swap", "enabled");
  const went: Array<{ handle: string; route: string }> = [];
  (rooted as unknown as { forward: (h: string, route: string) => Promise<unknown> }).forward = async (handle, route) => { went.push({ handle, route }); return { status: 200, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify({ handle, route })) }; };
  for (const [method, path] of [["POST", "/.well-known/auth"], ["GET", "/manifest.json"], ["POST", "/sendMessage"], ["GET", "/amm/tokens"]] as const) {
    const r = await rooted.dispatch({ method, url: `http://127.0.0.1:1${path}`, headers: {}, body: new Uint8Array() });
    assert.equal(r.status, 200, `${method} ${path} → the root instance`);
  }
  assert.deepEqual(went, [{ handle: "swap", route: "/.well-known/auth" }, { handle: "swap", route: "/manifest.json" }, { handle: "swap", route: "/sendMessage" }, { handle: "swap", route: "/amm/tokens" }]);
  assert.equal((await rooted.dispatch({ method: "GET", url: "http://127.0.0.1:1/.well-known/skein-host", headers: {}, body: new Uint8Array() })).status, 200, "the router's own .well-known stays its own");
  assert.equal((await rooted.dispatch({ method: "GET", url: "http://127.0.0.1:1/skeins?key=zz", headers: {}, body: new Uint8Array() })).status, 400, "the router's own /skeins stays its own");
});

test("the host's domain (H4): from its origin when no onboarding app names one", async (t) => {
  const home = await fs.mkdtemp(join(tmpdir(), "skein-domain-"));
  const db = new HostDb(join(home, "host.db"));
  const router = new Router({ db, walletFor: () => ephemeralWallet(PrivateKey.fromRandom()), home, origin: "https://id.example.test", idleMs: 0, ledgerMs: 60_000 });
  t.after(async () => { await router.stop(); db.close(); await fs.rm(home, { recursive: true, force: true }); });
  assert.equal(router.domain(), "id.example.test");
  assert.equal(await router.handleDomain(), "id.example.test", "no host skein: the origin's host name, not localhost");
  assert.equal(hostDomain("http://127.0.0.1:{port}"), "localhost");
  const r = await router.dispatch({ method: "GET", url: "https://id.example.test/.well-known/skein-host", headers: {}, body: new Uint8Array() });
  assert.deepEqual(JSON.parse(new TextDecoder().decode(r.body)), { origin: "https://id.example.test", domain: "id.example.test" });
});

test("overlay requests by topic (#137, #161): a token's names to its path-only instance; any other name to the instance whose row names it (no libp2p, never stepped)", async (t) => {
  const home = await fs.mkdtemp(join(tmpdir(), "skein-topics-"));
  const db = new HostDb(join(home, "host.db"));
  const router = new Router({ db, walletFor: () => ephemeralWallet(PrivateKey.fromRandom()), home, origin: "https://swap.example.test", idleMs: 0, ledgerMs: 60_000 });
  t.after(async () => { await router.stop(); db.close(); await fs.rm(home, { recursive: true, force: true }); });
  const A = `${"a".repeat(64)}_0`, B = `${"b".repeat(64)}_0`;
  // The names the instance manager's create named (host.db `topics`). No libp2p node here, and no row ever stepped.
  const topics: Record<string, string[] | undefined> = {
    [A]: [`tm_color_${A}`, `ls_color_${A}`],
    [B]: [`tm_color_${B}`, `ls_color_${B}`],
    discovery: ["tm_color", "ls_color", "tm_twice"],
    other: ["tm_twice"],
    off: ["tm_off", "ls_color"],
    plain: undefined,
  };
  for (const [h, ts] of Object.entries(topics)) db.add(h, { store: join(home, `${h}.db`), ...(ts ? { topics: JSON.stringify(ts) } : {}) });
  db.setStatus("off", "disabled");
  const submit = (x: string) => router.overlayTarget("/submit", { method: "POST", url: "https://swap.example.test/submit", headers: { "x-topics": x }, body: new Uint8Array() } as never);
  const lookup = (body: unknown) => router.overlayTarget("/lookup", { method: "POST", url: "https://swap.example.test/lookup", headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) } as never);

  assert.deepEqual(submit(`tm_color_${A}`), { handle: A }, "a token's topic: its instance");
  assert.deepEqual(submit("tm_color"), { handle: "discovery" }, "tm_color: the row whose topics name it");
  assert.deepEqual(submit(JSON.stringify(["tm_color"])), { handle: "discovery" });
  assert.deepEqual(lookup({ service: "ls_color", query: {} }), { handle: "discovery" }, "ls_color: the row naming it (the disabled one naming it too is not asked)");
  assert.deepEqual(lookup({ service: "ls_color", query: { topic: "tm_color" } }), { handle: "discovery" });
  assert.deepEqual(lookup({ service: `ls_color_${B}`, query: {} }), { handle: B });
  assert.deepEqual(lookup({ service: "ls_amm", query: {} }), {}, "a name no row names: no instance (the hostname's, as before)");
  assert.deepEqual(submit("tm_off"), {}, "a disabled instance is not asked");
  assert.deepEqual(submit("tm_nobody"), {}, "nothing maps: no instance");
  const two = submit("tm_twice");
  assert.ok("problem" in two && /2 instances here take tm_twice/.test(two.problem), JSON.stringify(two));
  assert.ok("problem" in submit(`tm_color,tm_color_${A}`), "names mapping to two instances: a problem");
  assert.ok("problem" in submit("tm_color,tm_nobody"), "a name mapping nowhere beside one that maps: a problem");
  // A start's `topics` replaces the row's (Router.manage "start" → setTopics).
  assert.ok(db.setTopics("other", ["tm_other"]));
  assert.deepEqual(submit("tm_twice"), { handle: "discovery" }, "after other's topics are replaced, tm_twice is discovery's alone");
  assert.deepEqual(submit("tm_other"), { handle: "other" });
  // The manager's create refuses malformed `topics` before it makes anything.
  const manage = (router as unknown as { manage: (box: string, b: Record<string, unknown>) => Promise<unknown> }).manage.bind(router);
  for (const bad of ["tm_color", [""], ["tm_color", "tm_color"], [1]]) {
    await assert.rejects(manage("create", { handle: "newone", owner: "02" + "1".repeat(64), topics: bad }), /topics:/, JSON.stringify(bad));
  }
  assert.equal(db.get("newone"), undefined);
});

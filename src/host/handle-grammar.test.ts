// One handle grammar (a hostname label) for every row (`add`, the manager's
// create, the dev agents' mailbox), and the reserved names: `id`, `host`, and the first label of the router's own origin, which
// no instance may take and which never routes to one. No kernel needed: each
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

test("handles: one grammar for add, mailbox and create; no image mailbox (#131); the reserved names and the router's own label", async (t) => {
  const home = await fs.mkdtemp(join(tmpdir(), "skein-handles-"));
  const db = new HostDb(join(home, "host.db"));
  const router = new Router({ db, walletFor: () => ephemeralWallet(PrivateKey.fromRandom()), home, origin: "https://id.example.test", idleMs: 0, ledgerMs: 60_000 });
  t.after(async () => { await router.stop(); db.close(); await fs.rm(home, { recursive: true, force: true }); });
  const key = PrivateKey.fromRandom().toPublicKey().toString();

  for (const bad of ["a.b", "a_b", "Alice", "-a", "a-", "x".repeat(64)]) {
    assert.throws(() => db.add(bad, { store: join(home, `${bad}.db`) }), /hostname label/, `add ${bad}`);
    await assert.rejects(router.addMailbox(bad, key), /hostname label/, `mailbox ${bad}`);
    await assert.rejects(router.createInstance(bad, key), /hostname label/, `create ${bad}`);
  }
  db.add("alice", { store: join(home, "alice.db") });
  // #131: no mailbox-only instance from the manager's create: a handle is registered from a skein.
  await assert.rejects(router.createInstance("mel", key, { image: "mailbox" }), /the default image \(#131/);

  assert.equal(router.ownLabel(), "id");
  for (const r of ["id", "host"]) {
    assert.ok(router.reserved(r));
    await assert.rejects(router.addMailbox(r, key), /reserved/, `mailbox ${r}`);
    await assert.rejects(router.createInstance(r, key), /reserved/, `create ${r}`);
  }
  assert.ok(!router.reserved("alice"));

  // A row named like the router's origin (an older host.db) still never takes the router's requests.
  db.add("id", { store: join(home, "id.db") });
  assert.equal(router.target(new URL("https://id.example.test/manifest.json")), undefined);
  assert.deepEqual(router.target(new URL("https://alice.example.test/x")), { handle: "alice", route: "/x" });

  // A router at a loopback address has no label of its own.
  const local = new Router({ db, walletFor: () => ephemeralWallet(PrivateKey.fromRandom()), home, idleMs: 0, ledgerMs: 60_000 });
  t.after(() => local.stop());
  assert.equal(local.ownLabel(), undefined);
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

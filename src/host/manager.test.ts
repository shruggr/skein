// The host's own actions on its instances (skein next, SPEC 8): start and stop; a create born owned or
// claimed (SPEC 3: the claim row, kernel.claim) or the router's own label; /.well-known/skein and /skeins.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { signClaim } from "../client/raw.ts";
import { ephemeralWallet } from "../wallet.ts";
import { testHost } from "./testhost.ts";
import { DoorAnswered } from "./door-answer.ts";

const skip = false;
const hex = (b: unknown) => b instanceof Uint8Array ? Buffer.from(b).toString("hex") : String(b);

test("skein next (SPEC 8): Router.stopInstance / startInstance — the host's own actions: unpublished, the kernel stopped, its event streams closed; published again, the topics replaced", { skip, timeout: 120_000 }, async (t) => {
  const h = await testHost(t);
  await h.instance("alice");
  await h.router.start();
  const k = (await h.router.hydrate("alice")).kernel;
  h.db.setTopics("alice", ["tm_a"]);
  let closed = 0;
  await h.router.events.subscribe("alice", { name: "x/", prefix: true }, () => {}, () => { closed++; });
  assert.equal(h.router.events.count("alice"), 1);

  assert.deepEqual(await h.router.stopInstance("alice"), { handle: "alice", stopped: true });
  assert.equal(h.db.get("alice")!.status, "disabled");
  assert.ok(k.gone, "its kernel stopped");
  assert.ok(!h.router.loaded.has("alice"));
  assert.equal(closed, 1, "its event stream closed");
  assert.equal(h.router.events.count("alice"), 0);
  assert.equal((await fetch(`${h.base}/@alice/.well-known/skein`)).status, 404, "unpublished");

  const started = await h.router.startInstance("alice", { topics: ["tm_b", "ls_b"] });
  assert.deepEqual(started, { handle: "alice", started: true, url: h.origin("alice") });
  assert.equal(h.db.get("alice")!.status, "enabled");
  assert.deepEqual(JSON.parse(h.db.get("alice")!.topics!), ["tm_b", "ls_b"], "the topics replaced");
  assert.ok(h.router.loaded.get("alice") && !h.router.loaded.get("alice")!.kernel.gone, "hydrated again");
  assert.equal((await fetch(`${h.base}/@alice/.well-known/skein`)).status, 200, "published again");
  await h.router.stopInstance("alice");
  await h.router.startInstance("alice");
  assert.deepEqual(JSON.parse(h.db.get("alice")!.topics!), ["tm_b", "ls_b"], "no topics given: kept");

  await assert.rejects(h.router.startInstance("nobody"), /no instance nobody/);
  await assert.rejects(h.router.stopInstance("nobody"), /no instance nobody/);
  await assert.rejects(h.router.startInstance("alice", { topics: ["a", "a"] }), /topics:/);
});

test("#164: an owned create — born owned: root its owner's from the genesis, no claim and no claim row; root's request runs, another key's is refused with nothing written", { skip, timeout: 120_000 }, async (t) => {
  const h = await testHost(t);
  const owner = h.ownerId;
  await assert.rejects(h.router.createInstance("tok", owner, { owned: true, claim: await signClaim(h.owner, key0()) }), /born owned/, "an owned create takes no claim");
  await assert.rejects(h.router.createInstance("tok", owner, { owned: true, needsClaim: true }), /born owned/);
  const c = await h.router.createInstance("tok", owner, { owned: true });
  assert.equal(h.db.get("tok")!.status, "enabled", "published");
  const k = (await h.router.hydrate("tok")).kernel;
  const g = await k.genesis() as { grants?: Record<string, unknown[]> };
  assert.deepEqual(g.grants?.root?.map((x) => hex(x)), [owner], "its genesis grants root");
  assert.deepEqual(g.grants?.["chain.status"]?.map((x) => hex(x)), [h.router.statusKey()], "and chain.status to the host's status service key");
  const rows = (await k.routes()).rows as Array<Record<string, unknown>>;
  assert.deepEqual(rows.map((r) => r.handler), ["kernel.objects", "kernel.head", "kernel.route", "kernel.grant"], "the kernel rows, no claim row");
  assert.equal(await h.entries("tok"), 1, "the genesis only");
  // A root request (the kernel's route operation): another key's is refused (nothing written); the owner's runs and returns data.
  const row = { kind: "request", path: "/x", role: "user", handler: "x.main.f" };
  const stranger = PrivateKey.fromRandom();
  await assert.rejects(h.request("tok", "POST", "/kernel/route", { op: "add", row }, stranger), (e) => e instanceof DoorAnswered && e.answer.status === 403, "the gate: root's row");
  assert.equal(await h.entries("tok"), 1, "nothing written");
  const r = await h.request("tok", "POST", "/kernel/route", { op: "add", row });
  assert.deepEqual(dagCbor.decode(r.answer.body), { done: { op: "add", changed: true } }, "a kernel operation returns data");
  assert.ok(((await k.routes()).rows as Array<Record<string, unknown>>).some((x) => x.path === "/x"));
  void c;
});

test("GET /.well-known/skein: an unclaimed image instance answers claimed:false; the first claim (a request to /kernel/claim) makes its sender root — claimed:true, /skeins?key= lists it; a second claim is refused", { skip, timeout: 120_000 }, async (t) => {
  const h = await testHost(t);
  const creator = PrivateKey.fromRandom().toPublicKey().toString();
  const c = await h.router.createInstance("ex", creator, {});
  const card = async (path = `${h.base}/@ex/.well-known/skein`) => { const r = await fetch(path); return { status: r.status, body: await r.json() as Record<string, unknown> }; };
  assert.deepEqual(await card(), { status: 200, body: { handle: "ex", identity: c.identity, origin: h.origin("ex"), claimed: false } });
  assert.equal((await card(`${h.base}/@nobody/.well-known/skein`)).status, 404);
  const held = async (key: string) => (await (await fetch(`${h.base}/skeins?key=${key}`)).json()) as Array<{ handle: string }>;
  assert.deepEqual(await held(creator), []);

  const firstKey = PrivateKey.fromRandom(), first = firstKey.toPublicKey().toString();
  const a = await h.router.messageLocal("ex", await signClaim(ephemeralWallet(firstKey), c.identity));
  assert.equal(hex((dagCbor.decode(a.answer.body) as { done: { root: Uint8Array } }).done.root), first, "the claim returns its root");
  assert.equal((await card()).body.claimed, true);
  assert.deepEqual((await held(first)).map((x) => x.handle), ["ex"]);
  const k = (await h.router.hydrate("ex")).kernel;
  assert.ok(!((await k.routes()).rows as Array<Record<string, unknown>>).some((r) => r.handler === "kernel.claim"), "the claim row removed in the same step");

  const secondKey = PrivateKey.fromRandom(), second = secondKey.toPublicKey().toString();
  await assert.rejects(h.router.messageLocal("ex", await signClaim(ephemeralWallet(secondKey), c.identity)), (e) => e instanceof DoorAnswered && e.answer.status === 404, "no claim row: refused at CHECK");
  assert.deepEqual(await held(second), []);
});

test("createInstance with a forwarded claim (the owner's signed request): claimed before it is published; another key's claim refused", { skip, timeout: 120_000 }, async (t) => {
  const h = await testHost(t);
  // The instance's identity is the signer's (the host derives it): the test host's key for the handle.
  const id = h.keyOf("bob").toPublicKey().toString();
  await assert.rejects(h.router.createInstance("bob", h.ownerId, { claim: await signClaim(ephemeralWallet(PrivateKey.fromRandom()), id) }), /its sender is not the owner/);
  const c = await h.router.createInstance("bob2", h.ownerId, { claim: await signClaim(h.owner, h.keyOf("bob2").toPublicKey().toString()) });
  assert.equal(h.db.get("bob2")!.status, "enabled");
  assert.deepEqual((await (await fetch(`${h.base}/skeins?key=${h.ownerId}`)).json() as Array<{ handle: string }>).map((x) => x.handle), ["bob2"]);
  void c;
});

const key0 = () => PrivateKey.fromRandom().toPublicKey().toString();

test("skein next (planner's call): createInstance of the router's own first label succeeds for the root instance (Open Exchange's swap at swap.skein.nexus, SKEIN_ROOT_INSTANCE=swap), and is refused for any other", { skip, timeout: 120_000 }, async (t) => {
  const h = await testHost(t);
  h.router.o.origin = "https://swap.example.test";
  assert.equal(h.router.ownLabel(), "swap");
  await assert.rejects(h.router.createInstance("swap", h.ownerId, { owned: true }), /handle swap is reserved/, "no root instance: reserved");
  h.router.o.rootInstance = "swap";
  const c = await h.router.createInstance("swap", h.ownerId, { owned: true });
  assert.equal(c.handle, "swap");
  assert.equal(h.db.get("swap")!.status, "enabled");
  assert.deepEqual(h.router.target(new URL("https://swap.example.test/amm/x")), { handle: "swap", route: "/amm/x" }, "its hostname routes to it");
  // The router's own paths there stay the router's.
  const sk = await h.router.dispatch({ method: "GET", url: `https://swap.example.test/skeins?key=${h.ownerId}`, headers: {}, body: new Uint8Array() });
  assert.equal(sk.status, 200);
  assert.deepEqual((JSON.parse(new TextDecoder().decode(sk.body)) as Array<{ handle: string }>).map((x) => x.handle), ["swap"]);
});

// The router's libp2p host (#51, p2p.ts) on its own, no kernel: the peer key
// and its peer ID both ways, the host-wide settings, and two nodes on
// loopback — a topic message judged by the validator (the front-door call is
// a stand-in here), a stream round trip (the libp2p provider's publish, dial,
// send, close; #70) whose frames come back through `frames`, and a frame on
// /skein/message/1.0.0, which every node serves; a node declared again
// following its instance's config (#72: the routes an install adds and removes).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKey, ProtoWallet } from "@bsv/sdk";
import { CID } from "multiformats/cid";
import { INSTANCE_PROTOCOL, Signer } from "./signer.ts";
import { foldSubscriptions, hostP2PConfig, keyOfPeerId, libp2pConfig, libp2pOf, MESSAGE_PROTOCOL, P2PHost, peerIdOf, subscribedTopics, subscriptionEvent, topicCid, type Frame, type InboundAnswer, type InboundCall } from "./p2p.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => T | undefined | false, what: string, ms = 15_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
    await sleep(25);
  }
}

test("p2p: the peer key is a child of the master (key ID libp2p:<handle>), and the peer ID carries its compressed key", async () => {
  const master = PrivateKey.fromHex("33".repeat(32));
  const o = new Signer(master);
  const k = o.peerKey("martha");
  const { publicKey } = await new ProtoWallet(master).getPublicKey({ protocolID: INSTANCE_PROTOCOL, keyID: "libp2p:martha", counterparty: "self" });
  assert.equal(k.toPublicKey().toString(), publicKey, "[2, \"skein instance\"] / libp2p:martha / self");
  assert.notEqual(k.toPublicKey().toString(), o.identity("martha"), "never the instance's root key");
  const id = peerIdOf(k);
  assert.equal(keyOfPeerId(id.toString()), publicKey, "peer ID → key");
  assert.equal(Buffer.from(id.toMultihash().bytes).toString("hex"), `0025080212${"21"}${publicKey}`, "identity multihash of protobuf {secp256k1, 33 bytes}");
  assert.equal(peerIdOf(o.peerKey("martha")).toString(), id.toString(), "stable");
  assert.notEqual(peerIdOf(o.peerKey("kurt")).toString(), id.toString(), "one per instance");
});

test("p2p: host-wide settings from the environment, else host.env; an instance's config from its genesis", async (t) => {
  const home = await fs.mkdtemp(join(tmpdir(), "skein-p2p-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const d = hostP2PConfig({}, home);
  assert.deepEqual(d, { listen: ["/ip4/127.0.0.1/tcp/0", "/ip4/127.0.0.1/tcp/0/ws"], bootstrap: [], dht: "off", relays: [], mdns: false });
  await fs.writeFile(join(home, "host.env"), "OTHER=x\nSKEIN_LIBP2P_LISTEN=/ip4/0.0.0.0/tcp/4001,/ip4/0.0.0.0/tcp/4002/ws\nexport SKEIN_LIBP2P_DHT=server\nSKEIN_LIBP2P_MDNS=on\nSKEIN_LIBP2P_BOOTSTRAP=\"/ip4/1.2.3.4/tcp/4001/p2p/x\"\n");
  const c = hostP2PConfig({ SKEIN_LIBP2P_DHT: "client" }, home);
  assert.deepEqual(c, { listen: ["/ip4/0.0.0.0/tcp/4001", "/ip4/0.0.0.0/tcp/4002/ws"], bootstrap: ["/ip4/1.2.3.4/tcp/4001/p2p/x"], dht: "client", relays: [], mdns: true });
  assert.throws(() => hostP2PConfig({ SKEIN_LIBP2P_DHT: "maybe" }, home), /off \| client \| server/);
  assert.equal(libp2pOf({}), undefined, "no libp2p in the genesis: no node");
  assert.deepEqual(libp2pOf({ libp2p: { topics: ["a", 3], protocols: ["/p/1"] } }), { topics: ["a"], protocols: ["/p/1"] });
  // go-libp2p's nsToCid: CID v1, raw, sha2-256 of the name.
  assert.equal((await topicCid("hello")).toString(), CID.parse("bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq").toString());
});

test("p2p: two nodes — a topic message through the validator, a stream round trip whose frames come back through `frames`, a message on /skein/message/1.0.0 needing no declaration", async (t) => {
  const master = PrivateKey.fromHex("44".repeat(32));
  const o = new Signer(master);
  const calls: Array<{ handle: string; call: InboundCall }> = [];
  const inbound = async (handle: string, call: InboundCall): Promise<InboundAnswer> => {
    calls.push({ handle, call });
    if (call.protocol === "/skein/echo/1") return { verdict: "accept", body: new TextEncoder().encode(`echo: ${new TextDecoder().decode(call.body)}`) };
    return { verdict: new TextDecoder().decode(call.body).startsWith("bad") ? "reject" : "accept" };
  };
  const mk = (bootstrap: string[] = []) => new P2PHost({
    host: { listen: ["/ip4/127.0.0.1/tcp/0"], bootstrap, dht: "off", relays: [], mdns: false },
    keyOf: (h) => o.peerKey(h), inbound, discoveryMs: 300,
  });
  const a = mk();
  t.after(() => a.stop());
  await a.declare("alpha", { topics: ["demo"], protocols: [] });
  const b = mk(a.addrs("alpha"));
  t.after(() => b.stop());
  await b.declare("beta", { topics: ["demo"], protocols: ["/skein/echo/1"] });
  assert.equal(a.peerId("alpha"), a.node("alpha")!.peerId.toString(), "the node runs as the derived peer ID");

  // Gossip: beta finds alpha by bootstrap; alpha's topic mesh then includes beta.
  const ps = (h: P2PHost, x: string) => (h.node(x)!.services as { pubsub: { getSubscribers(t: string): unknown[] } }).pubsub;
  await until(() => ps(a, "alpha").getSubscribers("demo").length > 0, "alpha sees beta on the topic");
  await sleep(1200); // a heartbeat: beta in alpha's mesh
  const pub = await a.publish("alpha", "demo", new TextEncoder().encode("hello"));
  assert.equal(pub.seqno.length, 8, "publish → an 8-byte seqno");
  const got = await until(() => calls.find((c) => c.call.topic === "demo"), "beta's validator is called");
  assert.equal(got.handle, "beta");
  assert.equal(Buffer.from(got.call.seqno!).toString("hex"), Buffer.from(pub.seqno).toString("hex"), "the seqno published is the one validated");
  assert.equal(keyOfPeerId(got.call.from), o.peerKey("alpha").toPublicKey().toString(), "from: alpha's peer ID");
  assert.equal(new TextDecoder().decode(got.call.body), "hello");
  assert.ok(got.call.signature && got.call.signature.length > 60, "the GossipSub signature");

  // A stream: dial, send; the echo's frame comes back through `frames` (the libp2p provider makes it a message, #70), then close.
  const frames: Frame[] = [];
  const id = await a.dial("alpha", b.peerId("beta"), "/skein/echo/1", (f) => frames.push(f));
  assert.equal(typeof id, "number");
  await a.send("alpha", id, new TextEncoder().encode("ping"));
  await until(() => frames.length, "the echo's frame");
  assert.equal(new TextDecoder().decode((frames[0] as { body: Uint8Array }).body), "echo: ping");
  const s = calls.find((c) => c.call.protocol === "/skein/echo/1");
  assert.equal(keyOfPeerId(s!.call.from), o.peerKey("alpha").toPublicKey().toString(), "a stream frame's from: the remote peer");
  await a.close("alpha", id);
  await assert.rejects(a.send("alpha", id, new Uint8Array([1])), /no stream/);
  await assert.rejects(a.dial("alpha", "/ip4/127.0.0.1/tcp/1/p2p/" + b.peerId("beta"), "/x", () => {}));
  await assert.rejects(a.publish("nobody", "demo", new Uint8Array()), /no libp2p node/);

  // Every node serves MESSAGE_PROTOCOL (#70): a frame there goes to the front door with no protocol declared.
  const m = await a.dial("alpha", b.peerId("beta"), MESSAGE_PROTOCOL, () => {});
  await a.send("alpha", m, new TextEncoder().encode("a package"));
  await until(() => calls.find((c) => c.call.protocol === MESSAGE_PROTOCOL), "beta's front door gets the message frame");
  await a.close("alpha", m);
});

test("p2p: subscriptions (#119) — the topics the apps subscribed; keyed by (app, topic), folded in order; a libp2p row is exact", () => {
  const rows = [
    { transport: "libp2p", address: "tm_mine", program: "P-other" },
    { transport: "libp2p", address: "/proto/1", program: "P-overlay" },
    { transport: "http", address: "/tm_", prefix: true, program: "P-other" },
  ];
  assert.deepEqual(libp2pConfig({}, rows), { topics: ["tm_mine"], protocols: ["/proto/1"] }, "the rows' topic and protocol");
  assert.equal(libp2pConfig({}, []), undefined, "nothing: no node");
  assert.deepEqual(libp2pConfig({}, [], ["tm_ab"]), { topics: ["tm_ab"], protocols: [] }, "a subscribed topic starts one");
  assert.deepEqual(libp2pConfig({}, rows, ["tm_ab", "tm_mine"]), { topics: ["tm_mine", "tm_ab"], protocols: ["/proto/1"] }, "a topic both a row and a subscription take: once");
  const sub = (app: string, topic: string, fn = "submit") => ({ event: "subscribe" as const, sub: { app, topic, program: "engine", fn } });
  const unsub = (app: string, topic: string) => ({ event: "unsubscribe" as const, app, topic });
  const subs = foldSubscriptions([
    sub("overlay", "tm_ab"),
    sub("overlay", "tm_cd"),
    sub("other", "tm_ab", "theirs"),
    sub("overlay", "tm_ab", "peerAdmit"),
    unsub("overlay", "tm_cd"),
    unsub("other", "tm_zz"),
  ]);
  assert.deepEqual(subs.map((s) => `${s.app} ${s.topic} ${s.fn}`), ["overlay tm_ab peerAdmit", "other tm_ab theirs"], "in order: an app's subscribe replaces its own in place; another app's is its own; an unsubscribe removes only the app's");
  assert.deepEqual(subscribedTopics(subs), ["tm_ab"], "each topic once");
  assert.deepEqual(subscribedTopics(foldSubscriptions([unsub("overlay", "tm_ab")], subs)), ["tm_ab"], "other's still takes it");
  assert.deepEqual(subscriptionEvent({ kind: "event", event: "subscribe", app: "overlay", topic: "tm_ab", program: "engine", fn: "submit" }), sub("overlay", "tm_ab"));
  assert.deepEqual(subscriptionEvent({ kind: "event", event: "unsubscribe", app: "overlay", topic: "tm_ab" }), unsub("overlay", "tm_ab"));
  assert.ok("refused" in subscriptionEvent({ kind: "event", event: "subscribe", topic: "tm_ab", program: "engine", fn: "submit" }), "no app (an uninstalled record's event): ignored");
  assert.ok("refused" in subscriptionEvent({ kind: "event", event: "subscribe", app: "overlay", topic: "tm_ab" }), "no program or fn (the shape before the subscription named them): ignored");
  assert.ok("refused" in subscriptionEvent({ kind: "event", event: "subscribe", app: "overlay", topic: "/proto/1", program: "engine", fn: "submit" }), "a /protocol: not by event");
  assert.ok("refused" in subscriptionEvent({ kind: "event", event: "made-up", app: "overlay" }), "another event: not the node's");
});

test("p2p: an instance's config as its dispatch table's libp2p rows ask (#72, #77), and a node declared again follows it — subscribed, unsubscribed, handled, unhandled, stopped — with no restart", async (t) => {
  assert.equal(libp2pConfig({}, []), undefined, "no libp2p in the genesis, no libp2p row: no node");
  const rows = [{ transport: "http", address: "/overlay/submit" }, { transport: "libp2p", address: "tm_demo" }, { transport: "libp2p", address: "tm_demo-admit" }, { transport: "libp2p", address: "/amm/1/swap" }, { transport: "mailbox", address: "x" }];
  assert.deepEqual(libp2pConfig({}, rows), { topics: ["tm_demo", "tm_demo-admit"], protocols: ["/amm/1/swap"] }, "libp2p rows alone start a node");
  assert.deepEqual(libp2pConfig({ libp2p: { topics: ["tm_demo", "g"], listen: ["/ip4/127.0.0.1/tcp/1"] } }, rows), { topics: ["tm_demo", "g", "tm_demo-admit"], protocols: ["/amm/1/swap"], listen: ["/ip4/127.0.0.1/tcp/1"] }, "the genesis's, then the rows', once each");
  assert.deepEqual(libp2pConfig({ libp2p: { topics: ["g"] }, dispatch: [{ transport: "libp2p", address: "tm_demo" }] }, rows), { topics: ["g", "tm_demo-admit"], protocols: ["/amm/1/swap"] }, "a genesis row alone subscribes nothing: the tree's config.libp2p says what the node takes");

  const o = new Signer(PrivateKey.fromHex("45".repeat(32)));
  const calls: InboundCall[] = [];
  const mk = (bootstrap: string[] = []) => new P2PHost({
    host: { listen: ["/ip4/127.0.0.1/tcp/0"], bootstrap, dht: "off", relays: [], mdns: false },
    keyOf: (h) => o.peerKey(h), inbound: async (_h, call) => { calls.push(call); return { verdict: "accept" }; }, discoveryMs: 300,
  });
  const a = mk();
  t.after(() => a.stop());
  await a.declare("alpha", { topics: ["one"], protocols: [] });
  const b = mk(a.addrs("alpha"));
  t.after(() => b.stop());
  await b.declare("beta", { topics: ["one"], protocols: [] });
  const subs = (h: P2PHost, x: string, topic: string) => (h.node(x)!.services as { pubsub: { getSubscribers(t: string): unknown[] } }).pubsub.getSubscribers(topic).length;
  await until(() => subs(a, "alpha", "one") > 0, "alpha sees beta on one");
  const node = b.node("beta");

  // Declared again: `two` subscribed and a protocol handled, on the same node.
  await b.declare("beta", { topics: ["one", "two"], protocols: ["/p/1"] });
  assert.equal(b.node("beta"), node, "the same node: no restart");
  assert.deepEqual(b.served("beta"), { topics: ["one", "two"], protocols: ["/p/1"] });
  await until(() => subs(a, "alpha", "two") > 0, "alpha sees beta on two");
  await sleep(1200); // a heartbeat: beta in alpha's mesh for two
  await a.publish("alpha", "two", new TextEncoder().encode("on two"));
  await until(() => calls.find((c) => c.topic === "two"), "beta's validator is called on two");
  const s = await a.dial("alpha", b.peerId("beta"), "/p/1", () => {});
  await a.send("alpha", s, new TextEncoder().encode("frame"));
  await until(() => calls.find((c) => c.protocol === "/p/1"), "beta serves /p/1");
  await a.close("alpha", s).catch(() => {});

  // Declared again without them: unsubscribed, unhandled.
  await b.declare("beta", { topics: ["one"], protocols: [] });
  assert.deepEqual(b.served("beta"), { topics: ["one"], protocols: [] });
  await until(() => subs(a, "alpha", "two") === 0, "alpha sees beta leave two");
  await assert.rejects(a.dial("alpha", b.peerId("beta"), "/p/1", () => {}), "/p/1 is no longer served");

  // No config: the node stops.
  await b.declare("beta", undefined);
  assert.equal(b.node("beta"), undefined);
});


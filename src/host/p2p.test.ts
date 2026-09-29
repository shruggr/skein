// The router's libp2p host (#51, p2p.ts) on its own, no kernel: the peer key
// and its peer ID both ways, the host-wide settings, and two nodes on
// loopback — a topic message judged by the validator (the front-door call is
// a stand-in here), and a stream round trip with a `receive` that rests and
// is woken by the frame.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKey, ProtoWallet } from "@bsv/sdk";
import { CID } from "multiformats/cid";
import { INSTANCE_PROTOCOL, Oracle } from "./oracle.ts";
import { hostP2PConfig, keyOfPeerId, libp2pOf, P2PHost, peerIdOf, topicCid, type InboundAnswer, type InboundCall } from "./p2p.ts";

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
  const o = new Oracle(master);
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

test("p2p: two nodes — a topic message through the validator, a stream round trip with receive resting and woken", async (t) => {
  const master = PrivateKey.fromHex("44".repeat(32));
  const o = new Oracle(master);
  const calls: Array<{ handle: string; call: InboundCall }> = [];
  const wakes: Array<{ handle: string; thread: string }> = [];
  const inbound = async (handle: string, call: InboundCall): Promise<InboundAnswer> => {
    calls.push({ handle, call });
    if (call.protocol) return { verdict: "accept", body: new TextEncoder().encode(`echo: ${new TextDecoder().decode(call.body)}`) };
    return { verdict: new TextDecoder().decode(call.body).startsWith("bad") ? "reject" : "accept" };
  };
  const mk = (bootstrap: string[] = []) => new P2PHost({
    host: { listen: ["/ip4/127.0.0.1/tcp/0"], bootstrap, dht: "off", relays: [], mdns: false },
    keyOf: (h) => o.peerKey(h), inbound, discoveryMs: 300,
    wake: (handle, thread) => wakes.push({ handle, thread: thread.toString() }),
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
  const pub = await a.request("alpha", { op: "publish", topic: "demo", body: new TextEncoder().encode("hello") });
  assert.ok(pub.seqno instanceof Uint8Array && pub.seqno.length === 8, `publish → an 8-byte seqno (${JSON.stringify(pub)})`);
  const got = await until(() => calls.find((c) => c.call.topic === "demo"), "beta's validator is called");
  assert.equal(got.handle, "beta");
  assert.equal(Buffer.from(got.call.seqno!).toString("hex"), Buffer.from(pub.seqno as Uint8Array).toString("hex"), "the seqno published is the one validated");
  assert.equal(keyOfPeerId(got.call.from), o.peerKey("alpha").toPublicKey().toString(), "from: alpha's peer ID");
  assert.equal(new TextDecoder().decode(got.call.body), "hello");
  assert.ok(got.call.signature && got.call.signature.length > 60, "the GossipSub signature");

  // A stream: dial, send, receive (pending, then woken), receive the answer, the end.
  const thread = CID.parse("bafyreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy");
  const d = await a.request("alpha", { op: "dial", peer: b.peerId("beta"), protocol: "/skein/echo/1" });
  assert.equal(typeof d.stream, "number", `dial → a stream id (${JSON.stringify(d)})`);
  const id = d.stream as number;
  assert.deepEqual(await a.request("alpha", { op: "receive", stream: id }, thread), { pending: true }, "nothing yet: pending, the thread rests");
  assert.deepEqual(await a.request("alpha", { op: "send", stream: id, body: new TextEncoder().encode("ping") }), {});
  await until(() => wakes.length, "the frame wakes the resting thread");
  assert.deepEqual(wakes, [{ handle: "alpha", thread: thread.toString() }]);
  const r = await a.request("alpha", { op: "receive", stream: id });
  assert.equal(new TextDecoder().decode(r.body as Uint8Array), "echo: ping", "the frame, on the next receive");
  const s = calls.find((c) => c.call.protocol);
  assert.equal(keyOfPeerId(s!.call.from), o.peerKey("alpha").toPublicKey().toString(), "a stream frame's from: the remote peer");
  assert.deepEqual(await a.request("alpha", { op: "close", stream: id }), {});
  assert.match(String((await a.request("alpha", { op: "receive", stream: id })).error), /no stream/);
  assert.match(String((await a.request("alpha", { op: "dial", peer: "/ip4/127.0.0.1/tcp/1/p2p/" + b.peerId("beta"), protocol: "/x" })).error), /^dial: /, "a failed dial is an answer ({error}), recorded like any");
  assert.match(String((await a.request("nobody", { op: "publish", topic: "demo", body: new Uint8Array() })).error), /no libp2p node/);
});

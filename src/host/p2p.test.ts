// The router's libp2p host (#51, p2p.ts) on its own, no kernel: the peer key
// and its peer ID both ways, the host-wide settings, and two nodes on
// loopback — a topic message judged by the validator (the front-door call is
// a stand-in here), a stream round trip (the libp2p provider's publish, dial,
// send, close; #70) whose frames come back through `frames`, and a frame on
// /skein/message/1.0.0, which every node serves.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKey, ProtoWallet } from "@bsv/sdk";
import { CID } from "multiformats/cid";
import { INSTANCE_PROTOCOL, Oracle } from "./oracle.ts";
import { hostP2PConfig, keyOfPeerId, libp2pOf, MESSAGE_PROTOCOL, P2PHost, peerIdOf, topicCid, type Frame, type InboundAnswer, type InboundCall } from "./p2p.ts";

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

test("p2p: two nodes — a topic message through the validator, a stream round trip whose frames come back through `frames`, a message on /skein/message/1.0.0 needing no declaration", async (t) => {
  const master = PrivateKey.fromHex("44".repeat(32));
  const o = new Oracle(master);
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


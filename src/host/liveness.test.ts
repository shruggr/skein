// The liveness tool (#138, liveness.ts) on its own: the events read and
// folded; the set — verified beats only, the latest per sender, newer than
// the window (the app's own window at read), a beat dated far ahead not
// believed; topics dropped as liveness goes.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as dagCbor from "@ipld/dag-cbor";
import { PrivateKey } from "@bsv/sdk";
import { Signer } from "./signer.ts";
import { MESSAGE_KEY_ID, MESSAGE_PROTOCOL as SIGN_PROTOCOL } from "./providers.ts";
import { beaconFrame } from "./p2p.ts";
import { foldLiveness, livenessEvent, Liveness, type LivenessEvent } from "./liveness.ts";

const o = new Signer(PrivateKey.fromHex("55".repeat(32)));
const keyOf = (h: string) => Uint8Array.from(Buffer.from(o.identity(h), "hex"));
const frame = async (h: string, topic: string, at: number, body = `${h} lives`) => {
  const w = o.wallet(h);
  return await beaconFrame(topic, new TextEncoder().encode(body), at, keyOf(h), async (d) => Uint8Array.from((await w.createSignature({ protocolID: SIGN_PROTOCOL, keyID: MESSAGE_KEY_ID, counterparty: "anyone", data: [...d] })).signature));
};

test("liveness: the events read as the kernel records them, folded by (app, topic)", () => {
  const ev = (r: Record<string, unknown>) => livenessEvent({ kind: "event", ...r }) as LivenessEvent;
  assert.deepEqual(ev({ event: "liveness", app: "amm", topic: "tm_a-live", window: 30_000 }), { event: "liveness", live: { app: "amm", topic: "tm_a-live", window: 30_000 } });
  assert.deepEqual(ev({ event: "liveness", app: "amm", topic: "tm_a-live", window: 30_000n }), { event: "liveness", live: { app: "amm", topic: "tm_a-live", window: 30_000 } });
  for (const bad of [{ event: "liveness", topic: "t", window: 5000 }, { event: "liveness", app: "a", topic: "/p/1", window: 5000 }, { event: "liveness", app: "a", topic: "t", window: 999 }, { event: "liveness", app: "a", topic: "t", window: 86_400_001 }, { event: "liveness", app: "a", topic: "t" }, { event: "beacon", app: "a", topic: "t" }]) {
    assert.ok("refused" in livenessEvent({ kind: "event", ...bad }), JSON.stringify(bad));
  }
  const l = foldLiveness([
    ev({ event: "liveness", app: "amm", topic: "a", window: 5000 }),
    ev({ event: "liveness", app: "other", topic: "a", window: 2000 }),
    ev({ event: "liveness", app: "amm", topic: "a", window: 9000 }),
    ev({ event: "liveness", app: "amm", topic: "b", window: 9000 }),
    ev({ event: "unliveness", app: "amm", topic: "b" }),
    ev({ event: "unliveness", app: "amm", topic: "c" }),
  ]);
  assert.deepEqual(l, [{ app: "amm", topic: "a", window: 9000 }, { app: "other", topic: "a", window: 2000 }]);
});

test("liveness: verified beats only, the latest per sender, newer than the window; read per app; dropped as liveness goes", async () => {
  let now = 100_000;
  const live = new Liveness(() => now);
  assert.equal(live.observe("x", "t", await frame("ann", "t", now), "peerA"), "ignore", "no liveness for the topic: nothing kept");
  live.set("x", [{ app: "amm", topic: "t", window: 10_000 }, { app: "short", topic: "t", window: 2000 }]);
  assert.deepEqual(live.topics("x"), ["t"]);
  assert.deepEqual(live.read("x", "amm", "t"), []);
  assert.equal(live.read("x", "amm", "u"), undefined, "the app keeps no liveness for u");
  assert.equal(live.read("x", "nobody", "t"), undefined);

  assert.equal(live.observe("x", "t", await frame("ann", "t", now - 5000), "peerA"), "accept");
  assert.equal(live.observe("x", "t", await frame("ann", "t", now - 1000, "ann newer"), "peerA"), "accept");
  assert.equal(live.observe("x", "t", await frame("ann", "t", now - 3000, "ann older"), "peerA"), "accept", "an older beat verifies, but the latest stays");
  assert.equal(live.observe("x", "t", await frame("bob", "t", now - 4000), "peerB"), "accept");
  // Bad: another topic's frame (the topic is signed), a forged sender, not a frame.
  assert.equal(live.observe("x", "t", await frame("cat", "u", now), "peerC"), "reject");
  const forged = dagCbor.decode(await frame("cat", "t", now)) as Record<string, unknown>;
  assert.equal(live.observe("x", "t", dagCbor.encode({ ...forged, sender: keyOf("dan") }), "peerC"), "reject");
  assert.equal(live.observe("x", "t", new TextEncoder().encode("hello"), "peerC"), "reject");
  // Stale, and dated more than a window ahead: not kept.
  assert.equal(live.observe("x", "t", await frame("eve", "t", now - 10_000), "peerE"), "ignore");
  assert.equal(live.observe("x", "t", await frame("eve", "t", now + 10_001), "peerE"), "ignore");

  const r = live.read("x", "amm", "t")!;
  assert.deepEqual(r.map((b) => [b.sender, b.at, new TextDecoder().decode(b.body), b.from]), [
    [o.identity("ann"), now - 1000, "ann newer", "peerA"],
    [o.identity("bob"), now - 4000, "bob lives", "peerB"],
  ]);
  assert.deepEqual(live.read("x", "short", "t")!.map((b) => b.sender), [o.identity("ann")], "the app's own window at read");

  now += 7000;
  assert.deepEqual(live.read("x", "amm", "t")!.map((b) => b.sender), [o.identity("ann")], "bob's beat aged out");
  now += 10_000;
  assert.deepEqual(live.read("x", "amm", "t"), []);

  assert.equal(live.observe("x", "t", await frame("ann", "t", now), "peerA"), "accept");
  live.set("x", [{ app: "amm", topic: "u", window: 10_000 }]);
  assert.equal(live.read("x", "amm", "t"), undefined, "unliveness: the app keeps none for t");
  live.set("x", [{ app: "amm", topic: "t", window: 10_000 }]);
  assert.deepEqual(live.read("x", "amm", "t"), [], "the beats went with it");
  live.set("x", []);
  assert.deepEqual(live.topics("x"), []);
});

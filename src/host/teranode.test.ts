// #156: the headers tracker over the Teranode P2P network (teranode.ts), on a
// fake mesh (fake-teranode.ts: one gossipsub publisher on the regtest block
// topic and a data hub serving a mined regtest chain), through the router's
// one intake into the image chain and the host chain (the wasm kernel's
// holder over the host's SQLite database).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { FakeTeranode, mineHeader } from "./fake-teranode.ts";
import { hubBack, parseAnnouncement } from "./teranode.ts";
import { testHost, until } from "./testhost.ts";

const sha256d = (b: Uint8Array) => createHash("sha256").update(createHash("sha256").update(b).digest()).digest();
const display = (h: Uint8Array) => Buffer.from(h).reverse().toString("hex");
const regtest = { genesis: { defaults: { walletNetwork: "regtest" } } };

test("teranode: an announcement read from the bus envelope or bare; anything else dropped", () => {
  const h = mineHeader(sha256d(Buffer.from("x")), 1);
  const msg = { PeerID: "p", ClientName: "c", DataHubURL: "https://hub.example/api/v1/", Hash: display(sha256d(h)), Height: 7, Header: h.toString("hex"), Coinbase: "" };
  const env = Buffer.from(JSON.stringify({ name: "n", data: Buffer.from(JSON.stringify(msg)).toString("base64") }));
  const a = parseAnnouncement(env)!;
  assert.equal(a.hash, display(sha256d(h)));
  assert.equal(a.height, 7);
  assert.equal(a.hub, "https://hub.example/api/v1");
  assert.deepEqual(Buffer.from(a.header), h);
  assert.equal(parseAnnouncement(Buffer.from(JSON.stringify(msg)))?.height, 7, "a bare BlockMessage too");
  assert.equal(parseAnnouncement(Buffer.from(JSON.stringify({ ...msg, Hash: "00".repeat(32) }))), undefined, "a Hash that is not the header's");
  assert.equal(parseAnnouncement(Buffer.from(JSON.stringify({ ...msg, Header: "ab" }))), undefined, "a header that is not 80 bytes");
  assert.equal(parseAnnouncement(Uint8Array.from([0x0a, 0x24, 1, 2, 3])), undefined, "not JSON");
  assert.equal(parseAnnouncement(Buffer.from(JSON.stringify({ ...msg, Height: -1 }))), undefined, "no height");
  assert.equal(parseAnnouncement(Buffer.from(JSON.stringify({ ...msg, DataHubURL: "file:///etc" })))?.hub, undefined, "a hub that is not http(s): none");
});

test("teranode: a hub's page is checked — its first header the one asked, every link, no redirect", async (t) => {
  const f = await FakeTeranode.start();
  t.after(() => f.stop());
  f.mineTo(20);
  const tip = display(sha256d(f.chain[20]!));
  const got = await hubBack(f.hub, tip, 5);
  assert.equal(got.length, 5);
  assert.equal(display(sha256d(got[4]!)), display(sha256d(f.chain[16]!)));
  // A hub that lies: a page whose links break, and one that redirects.
  const bad = createServer((req, res) => {
    if (req.url?.startsWith("/r/")) return void res.writeHead(302, { location: `${f.hub}/headers/${tip}?n=5` }).end();
    res.writeHead(200).end(Buffer.concat([f.chain[20]!, f.chain[18]!]));
  });
  await new Promise<void>((r) => bad.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => bad.close(r)));
  const base = `http://127.0.0.1:${(bad.address() as { port: number }).port}`;
  await assert.rejects(hubBack(base, tip, 5), /not header 0's parent/);
  await assert.rejects(hubBack(`${base}/r`, tip, 5), /fetch failed|redirect/);
});

test("teranode: an empty host syncs the whole chain from the hub before an instance steps; announcements extend it; a gap is crawled from the announcer's hub; a reorg replaces; junk is dropped", async (t) => {
  const f = await FakeTeranode.start();
  t.after(() => f.stop());
  f.mineTo(3000);
  const h = await testHost(t, { sqlite: true, ...regtest, teranode: { bootstrap: [f.addr()], hub: f.hub, dht: false, discoveryMs: 300, bulkPage: 1000 } });
  h.instance("alice");
  await h.router.start();
  const tips = async () => (await h.router.hostChainTips())[0]?.tip;
  // (iii) the first sync, then the host chain imported, then alice hydrated.
  assert.equal(h.router.image.tip()?.height, 3000);
  assert.equal(h.router.image.tip()?.hash, display(sha256d(f.chain[3000]!)));
  assert.equal((await tips())?.height, 3000, "the host chain filled from the image chain at start");
  const at = (re: RegExp) => h.lines.findIndex((l) => re.test(l));
  assert.ok(at(/headers: initial sync 1000\/3001/) >= 0, "a progress line per page");
  assert.ok(at(/headers: initial sync done: 3001 headers to 3000/) >= 0);
  assert.ok(at(/host chain: 3001 headers imported from the image chain \(tip 3000/) > at(/headers: initial sync 3001\/3001/), "imported once the sync had the whole chain");
  assert.ok(at(/hydrated alice/) > at(/imported from the image chain/), "and before alice was hydrated");
  // (i) an announcement extends both.
  await until("the tracker on the block topic", () => f.subscribers() > 0 || undefined, 15_000);
  f.mineTo(3001);
  await f.announce(3001);
  await until("3001 held", async () => ((await tips())?.height === 3001 && h.router.image.tip()?.height === 3001) || undefined, 10_000);
  assert.equal((await tips())?.hash, display(sha256d(f.chain[3001]!)));
  assert.equal(h.router.tracker!.stats.taken, 1);
  // (ii) a gap: 3002 and 3003 never announced; 3004's parent unknown → crawled back from its hub.
  f.mineTo(3004);
  await f.announce(3004);
  await until("3004 held", async () => (await tips())?.height === 3004 || undefined, 10_000);
  assert.equal(h.router.image.tip()?.hash, display(sha256d(f.chain[3004]!)));
  assert.ok(f.asked.includes(`/headers/${display(sha256d(f.chain[3004]!))}?n=2000`), `crawled from the hub: ${f.asked.slice(-2).join(" ")}`);
  assert.equal(h.router.tracker!.stats.crawled, 3, "3002…3004");
  // Known again: nothing.
  await f.announce(3004);
  await until("the repeat seen", () => h.router.tracker!.stats.known >= 1 || undefined, 10_000);
  // Junk on the topic: dropped.
  const dropped = h.router.tracker!.stats.dropped;
  await f.announce(3004, { raw: "not json at all" });
  await f.announce(3004, { raw: { Hash: "00".repeat(32), Height: 3004, Header: f.chain[3004]!.toString("hex") } });
  await until("two dropped", () => h.router.tracker!.stats.dropped >= dropped + 2 || undefined, 10_000);
  // A reorg: a heavier branch from 3003 (two headers on 3003 beat one).
  const alt4 = mineHeader(sha256d(f.chain[3003]!), "alt4"), alt5 = mineHeader(sha256d(alt4), "alt5");
  f.chain = [...f.chain.slice(0, 3004), alt4, alt5];
  await f.announce(3005);
  await until("the branch held", async () => (await tips())?.hash === display(sha256d(alt5)) || undefined, 10_000);
  assert.equal(h.router.image.tip()?.height, 3005);
  assert.equal(h.router.image.tip()?.hash, display(sha256d(alt5)), "the image chain replaced from 3004");
});

test("teranode: a host whose host chain stayed empty (an instance created with no chain) fills it at its next start; a host that was down catches up from the hub at start", async (t) => {
  const f = await FakeTeranode.start();
  t.after(() => f.stop());
  f.mineTo(500);
  // Tonight's case: no headers source at all when the instance was made — the image chain and the host chain empty.
  const h1 = await testHost(t, { sqlite: true, ...regtest });
  h1.instance("alice");
  await h1.router.start();
  await h1.router.hydrate("alice");
  assert.equal(h1.router.image.tip(), undefined);
  assert.equal((await h1.router.hostChainTips())[0]?.tip, undefined, "empty");
  await h1.router.stop();
  // The next start, with the tracker: the first sync, then the empty host chain imports it, then alice.
  const h2 = await testHost(t, { sqlite: true, ...regtest, ownerKey: h1.ownerKey, reuse: { home: h1.home, keyOf: h1.keyOf }, teranode: { bootstrap: [f.addr()], hub: f.hub, dht: false, discoveryMs: 300 } });
  await h2.router.start();
  assert.equal((await h2.router.hostChainTips())[0]?.tip?.height, 500);
  assert.ok(h2.lines.findIndex((l) => /hydrated alice/.test(l)) > h2.lines.findIndex((l) => /imported from the image chain/.test(l)));
  // Down while ten blocks came (and no announcement reached it): the next start catches up from the hub.
  await h2.router.stop();
  f.mineTo(510);
  const h3 = await testHost(t, { sqlite: true, ...regtest, ownerKey: h1.ownerKey, reuse: { home: h1.home, keyOf: h1.keyOf }, teranode: { bootstrap: [f.addr()], hub: f.hub, dht: false, discoveryMs: 300 } });
  await h3.router.start();
  assert.equal((await h3.router.hostChainTips())[0]?.tip?.height, 510);
  assert.ok(h3.lines.some((l) => /headers: caught up from .*: 10 headers to 510/.test(l)), h3.lines.filter((l) => /headers/.test(l)).join("\n"));
});

test("teranode: no hub for the network: the first sync waits for the first announcement and reads ITS hub", async (t) => {
  const f = await FakeTeranode.start();
  t.after(() => f.stop());
  f.mineTo(100);
  const h = await testHost(t, { sqlite: true, ...regtest, teranode: { bootstrap: [f.addr()], dht: false, discoveryMs: 300 } });
  await h.router.start();
  assert.equal(h.router.image.tip(), undefined, "nothing yet");
  assert.ok(h.lines.some((l) => /waiting for the first block announcement/.test(l)));
  await until("the tracker on the block topic", () => f.subscribers() > 0 || undefined, 15_000);
  await f.announce(100);
  await until("synced from its hub", async () => (await h.router.hostChainTips())[0]?.tip?.height === 100 || undefined, 15_000);
  assert.equal(h.router.image.tip()?.height, 100);
});

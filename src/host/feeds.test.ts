// The router-held feeds (feeds.ts) without a kernel: a fake SSE header feed
// (hex and JSON events, a dropped connection resumed with Last-Event-ID after
// a backoff), fan-out to every subscriber, the bounded queue, and the status
// record Arcade's JSON becomes (with the transaction's CID). The per-instance
// arc-callback feed is gone (#58): a genesis's is ignored, a config's refused.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { Feeds, feedsOf, headerOfFields, headersOf, statusOf, txCid } from "./feeds.ts";

const hdr = (n: number) => Buffer.alloc(80, n).toString("hex");
const until = async <T>(what: string, f: () => T | undefined, ms = 5000): Promise<T> => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    const v = f();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out: ${what}`);
};

test("feeds: header parsing, the genesis's feeds, Arcade's status record", () => {
  assert.deepEqual(headersOf(hdr(1)).map((b) => b[0]), [1]);
  assert.deepEqual(headersOf(JSON.stringify({ header: hdr(2), height: 7 })).map((b) => b[0]), [2]);
  assert.deepEqual(headersOf(JSON.stringify([{ raw: hdr(3) }, hdr(4)])).map((b) => b[0]), [3, 4]);
  assert.deepEqual(headersOf(JSON.stringify({ headers: [{ hex: hdr(5) }] })).map((b) => b[0]), [5]);
  assert.deepEqual(headersOf("nonsense"), []);
  assert.deepEqual(feedsOf({ feeds: [{ kind: "headers", url: "http://x/sse" }, { kind: "arc-callback", token: "t", box: "b" }, { kind: "?" }] }),
    [{ kind: "headers", url: "http://x/sse" }]);
  const txid = "aa".repeat(31) + "01";
  const s = statusOf({ txid, txStatus: "MINED", merklePath: "fe01", blockHeight: 103 }) as Record<string, unknown>;
  assert.ok((s.subject as ReturnType<typeof txCid>).equals(txCid(txid)));
  assert.equal(txCid(txid).code, 0xb1);
  assert.deepEqual([...(s.merklePath as Uint8Array)], [0xfe, 0x01]);
  assert.equal(s.txStatus, "MINED");
  assert.equal(statusOf({ txStatus: "MINED" }), "no txid");
});

test("feeds: chaintracks' JSON (Arcade's tip stream, #102) — the 80 bytes from the fields, the hash checked", () => {
  // Mainnet block 1: its fields as chaintracks sends them (hashes in display order), and its serialized header.
  const block1 = {
    version: 1, previousHash: "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f",
    merkleRoot: "0e3e2357e806b6cdb1f70b54c3a3a17b6714ee1f0e68bebb44a74b1efd512098",
    time: 1231469665, bits: 486604799, nonce: 2573394689, height: 1, hash: "00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048",
  };
  const raw = "010000006fe28c0ab6f1b372c1a6a246ae63f74f931e8365e15a089c68d6190000000000982051fd1e4ba744bbbe680e1fee14677ba1a3c3540bf7b1cdb606e857233e0e61bc6649ffff001d01e36299";
  assert.equal(Buffer.from(headerOfFields(block1) as Uint8Array).toString("hex"), raw);
  const why: string[] = [];
  assert.deepEqual(headersOf(JSON.stringify(block1), (w) => why.push(w)).map((b) => Buffer.from(b).toString("hex")), [raw]);
  const { hash: _, ...unhashed } = block1;
  assert.deepEqual(headersOf(JSON.stringify(unhashed)).map((b) => Buffer.from(b).toString("hex")), [raw], "no hash: nothing to check");
  assert.equal(why.length, 0, "nothing dropped");
  const wrong = { ...block1, nonce: block1.nonce + 1 };
  assert.ok(headerOfFields(wrong) instanceof Error);
  assert.deepEqual(headersOf(JSON.stringify([wrong, block1]), (w) => why.push(w)).map((b) => b.length), [80], "the mismatch dropped, the rest kept");
  assert.match(why.join("\n"), /^header 1: its hash 00000000839a.* is not its fields' \([0-9a-f]{64}\): dropped$/);
  assert.equal(headerOfFields({ ...block1, previousHash: "00" }), undefined, "not that form");
});

test("feeds: declared in a system's etc/config.json, carried by its genesis; the session default", async () => {
  const { resolveSystem, genesisRecord } = await import("./genesis.ts");
  const k = "02" + "11".repeat(32);
  const c = { identity: k, owner: k, handle: "w", domain: "localhost" };
  const feeds = [{ kind: "headers" as const, url: "http://ct.test/sse" }];
  const g = genesisRecord(c, resolveSystem(c, {}, [], { feeds }));
  assert.deepEqual(feedsOf(g), feeds);
  assert.equal((g.defaults as Record<string, string>).sessionTtlMs, "86400000");
  assert.throws(() => resolveSystem(c, {}, [], { feeds: [{ kind: "headers" } as never] }), /a feed is/);
  assert.throws(() => resolveSystem(c, {}, [], { feeds: [{ kind: "arc-callback", token: "t" } as never] }), /arc-callback feed is gone/);
  assert.equal(genesisRecord(c, resolveSystem(c, {}, [])).feeds, undefined);
});

test("feeds: an SSE header feed fanned out to its subscribers, resumed after a drop, bounded", async (t) => {
  const conns: ServerResponse[] = [];
  const lastIds: Array<string | undefined> = [];
  const server = createServer((req, res) => {
    lastIds.push(req.headers["last-event-id"] as string | undefined);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": hello\n\n");
    conns.push(res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/headers`;

  const got: Array<[string, string, number]> = [];
  let gate: Promise<void> | undefined;
  const lines: string[] = [];
  const feeds = new Feeds({
    admit: async (h, box, ev) => { if (gate) await gate; got.push([h, box, (ev.raw as Uint8Array)?.[0] ?? -1]); },
    log: (_s, l) => lines.push(l), maxQueue: 3, backoff: { min: 20, max: 100 },
  });
  t.after(() => feeds.stop());
  feeds.declare("w1", [{ kind: "headers", url }]);
  feeds.declare("w2", [{ kind: "headers", url, box: "headers" }]);
  await until("connected", () => conns[0]);
  assert.equal(conns.length, 1, "one connection per URL");

  conns[0]!.write(`id: 1\ndata: ${hdr(1)}\n\n`);
  conns[0]!.write(`id: 2\ndata: {"header":"${hdr(2)}"}\n\n`);
  await until("two headers to both", () => got.length === 4 || undefined);
  assert.deepEqual(got.filter(([h]) => h === "w1"), [["w1", "chain", 1], ["w1", "chain", 2]]);
  assert.deepEqual(got.filter(([h]) => h === "w2"), [["w2", "headers", 1], ["w2", "headers", 2]]);

  // The server drops the stream: the feed reconnects after its backoff, with the last event id.
  conns[0]!.end();
  await until("reconnected", () => conns[1]);
  assert.equal(lastIds[1], "2");
  conns[1]!.write(`id: 3\ndata: ${hdr(3)}\n\n`);
  await until("the third", () => got.length === 6 || undefined);

  // Admission stalls: at most 3 wait per instance; the oldest go.
  let open!: () => void;
  gate = new Promise((r) => { open = r; });
  for (let i = 10; i < 16; i++) conns[1]!.write(`data: ${hdr(i)}\n\n`);
  await until("queued", () => feeds.pending("w1") === 3 || undefined);
  open(); gate = undefined;
  await until("drained", () => feeds.pending("w1") === 0 && feeds.pending("w2") === 0 || undefined);
  const w1 = got.filter(([h]) => h === "w1").map(([, , n]) => n);
  assert.deepEqual(w1.slice(3), [10, 13, 14, 15], "the one being admitted, then the newest three");
  assert.ok(lines.some((l) => /queue full \(3\)/.test(l)));

  // Undeclared: the connection goes when its last subscriber does.
  feeds.declare("w1", []);
  feeds.declare("w2", []);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(conns.length, 2, "no reconnect after the last subscriber left");
});

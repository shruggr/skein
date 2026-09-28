// The router-held feeds (feeds.ts) without a kernel: a fake SSE header feed
// (hex and JSON events, a dropped connection resumed with Last-Event-ID after
// a backoff), fan-out to every subscriber, the bounded queue, and ARC's
// callbacks (token, shape, the status record with the transaction's CID).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { Feeds, feedsOf, headersOf, statusOf, txCid } from "./feeds.ts";

const hdr = (n: number) => Buffer.alloc(80, n).toString("hex");
const until = async <T>(what: string, f: () => T | undefined, ms = 5000): Promise<T> => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    const v = f();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out: ${what}`);
};

test("feeds: header parsing, the genesis's feeds, ARC's status record", () => {
  assert.deepEqual(headersOf(hdr(1)).map((b) => b[0]), [1]);
  assert.deepEqual(headersOf(JSON.stringify({ header: hdr(2), height: 7 })).map((b) => b[0]), [2]);
  assert.deepEqual(headersOf(JSON.stringify([{ raw: hdr(3) }, hdr(4)])).map((b) => b[0]), [3, 4]);
  assert.deepEqual(headersOf(JSON.stringify({ headers: [{ hex: hdr(5) }] })).map((b) => b[0]), [5]);
  assert.deepEqual(headersOf("nonsense"), []);
  assert.deepEqual(feedsOf({ feeds: [{ kind: "headers", url: "http://x/sse" }, { kind: "arc-callback", token: "t", box: "b" }, { kind: "?" }] }),
    [{ kind: "headers", url: "http://x/sse" }, { kind: "arc-callback", box: "b", token: "t" }]);
  const txid = "aa".repeat(31) + "01";
  const s = statusOf({ txid, txStatus: "MINED", merklePath: "fe01", blockHeight: 103 }) as Record<string, unknown>;
  assert.ok((s.subject as ReturnType<typeof txCid>).equals(txCid(txid)));
  assert.equal(txCid(txid).code, 0xb1);
  assert.deepEqual([...(s.merklePath as Uint8Array)], [0xfe, 0x01]);
  assert.equal(s.txStatus, "MINED");
  assert.equal(statusOf({ txStatus: "MINED" }), "no txid");
});

test("feeds: an SSE header feed fanned out to its subscribers, resumed after a drop, bounded; ARC callbacks", async (t) => {
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
  feeds.declare("w2", [{ kind: "headers", url, box: "headers" }, { kind: "arc-callback", token: "s3cret" }]);
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

  // ARC's callbacks: only for a declared feed, with its token; the status record goes to the queue.
  const txid = "ab".repeat(32);
  assert.equal(feeds.callback("w1", {}, new TextEncoder().encode("{}")).status, 404);
  assert.equal(feeds.callback("w2", {}, new TextEncoder().encode(JSON.stringify({ txid, txStatus: "MINED" }))).status, 401);
  assert.equal(feeds.callback("w2", { authorization: "Bearer s3cret" }, new TextEncoder().encode("{")).status, 400);
  const before = got.length;
  assert.equal(feeds.callback("w2", { authorization: "Bearer s3cret" }, new TextEncoder().encode(JSON.stringify({ txid, txStatus: "MINED" }))).status, 200);
  await until("the status admitted", () => got.length === before + 1 || undefined);
  assert.deepEqual(got.at(-1), ["w2", "chain", -1]);

  // Undeclared: the connection goes when its last subscriber does.
  feeds.declare("w1", []);
  feeds.declare("w2", []);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(conns.length, 2, "no reconnect after the last subscriber left");
});

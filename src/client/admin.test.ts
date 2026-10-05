// The owner's admin messages as files (#124, admin.ts): the JSON body the
// messagebox reads as DAG-JSON is the same record the page sends as dag-cbor;
// the files in order; delivery stops at the first answer that is not 2xx;
// the wallet's command (`1sat authfetch … --json`) read through its notices.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as dagCbor from "@ipld/dag-cbor";
import * as dagJson from "@ipld/dag-json";
import { encode } from "../runtime/cid.ts";
import { authfetchPoster, authfetchReader, deliver, messageJson, oversized, planDispatch, planFiles, planPeers, writePlan, type AdminPlan } from "./admin.ts";

const KEY = `02${"ab".repeat(32)}`;

test("messageJson: the /sendMessage JSON body; its body read as DAG-JSON is the dag-cbor record the page sends", () => {
  const rec = encode({ kind: "x", n: 1 } as never);
  const body = { records: [{ cid: rec.cid, bytes: rec.bytes }], root: rec.cid };
  const json = messageJson(KEY, { box: "objects", body });
  const v = JSON.parse(json) as { message: { recipient: string; messageBox: string; body: unknown } };
  assert.deepEqual([v.message.recipient, v.message.messageBox], [KEY, "objects"]);
  const back = dagJson.decode(new TextEncoder().encode(JSON.stringify(v.message.body)));
  assert.deepEqual(dagCbor.encode(back), dagCbor.encode(body));
});

test("planDispatch / planPeers: the kernel's bodies (sender and key as bytes)", () => {
  const p = planDispatch(KEY, { op: "add", sender: KEY, box: "register", handler: String(encode({ kind: "program" } as never).cid) });
  const row = (p.messages[0]!.body as { row: { sender: Uint8Array; transport: string } }).row;
  assert.equal(p.messages[0]!.box, "dispatch");
  assert.deepEqual([row.transport, Buffer.from(row.sender).toString("hex")], ["mailbox", KEY]);
  const q = planPeers(KEY, [{ op: "add", key: KEY, transport: "mailbox", address: "https://x.example", handle: "bob", domain: "example.com" }, { op: "remove", key: KEY }]);
  assert.deepEqual(q.messages.map((m) => (m.body as { op: string }).op), ["add", "remove"]);
  assert.ok((q.messages[1]!.body as { key: unknown }).key instanceof Uint8Array);
  assert.throws(() => planPeers(KEY, [{ op: "remove", key: "02ab" }]), /not an identity key/);
});

test("planDispatch --http (#125): the owner's http row (prefix, fn, the handler's settings; no app); refusals", () => {
  const prog = encode({ kind: "program" } as never).cid;
  const p = planDispatch(KEY, { op: "add", box: "/", handler: "site.site", http: { prefix: true, fn: "get", settings: { root: "www" } } }, { "site.site": prog });
  const row = (p.messages[0]!.body as { row: Record<string, unknown> }).row;
  assert.deepEqual({ ...row, program: String(row.program) }, { transport: "http", address: "/", prefix: true, sender: "*", program: String(prog), fn: "get", root: "www" });
  assert.equal(p.prompt[0], `dispatch add http /* from anyone → site.site.get (${prog}) (root www)`);
  const s = planDispatch(KEY, { op: "add", box: "/x", sender: "session", handler: String(prog), http: { fn: "get" } });
  assert.deepEqual([(s.messages[0]!.body as { row: { sender: unknown; prefix?: unknown } }).row.sender, (s.messages[0]!.body as { row: { prefix?: unknown } }).row.prefix], ["session", undefined]);
  assert.throws(() => planDispatch(KEY, { op: "add", box: "x", handler: String(prog), http: { fn: "get" } }), /a path/);
  assert.throws(() => planDispatch(KEY, { op: "add", box: "/a/../b", handler: String(prog), http: { fn: "get" } }), /a path/);
  assert.throws(() => planDispatch(KEY, { op: "add", box: "/", handler: String(prog), http: { fn: "" } }), /--fn/);
  assert.throws(() => planDispatch(KEY, { op: "add", box: "/", handler: String(prog), http: { fn: "get", settings: { app: "site" } } }), /the row's own/);
  assert.throws(() => planDispatch(KEY, { op: "add", box: "x", sender: "session", handler: String(prog) }), /an http row's/);
});

test("writePlan / planFiles / deliver: numbered files in order, an earlier plan's removed; delivery stops at the first non-2xx", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "skein-admin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const plan = (n: number): AdminPlan => ({ prompt: ["a plan"], recipient: KEY, messages: Array.from({ length: n }, (_, i) => ({ box: i % 2 ? "head" : "objects", body: { i } })) });
  writePlan(dir, plan(12));
  writePlan(dir, plan(3));
  assert.deepEqual(readdirSync(dir).sort(), ["001-objects.json", "002-head.json", "003-objects.json", "prompt.txt"]);
  assert.equal(readFileSync(join(dir, "prompt.txt"), "utf8"), "a plan\n");
  const seen: number[] = [];
  const done = await deliver(planFiles(dir), async (json) => {
    const i = (JSON.parse(json) as { message: { body: { i: number } } }).message.body.i;
    seen.push(i);
    return { status: i === 1 ? 403 : 200, text: "" };
  });
  assert.deepEqual(seen, [0, 1], "stopped at the 403");
  assert.deepEqual(done.map((d) => d.status), [200, 403]);
  assert.deepEqual(oversized(plan(1), 10).map((b) => b.index), [0]);
});

test("the wallet's command: `<cmd> <method> <url> [--body @file] --json`, its dotenv notices skipped; 404 is no record", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "skein-authfetch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = join(dir, "authfetch");
  writeFileSync(fake, `#!/usr/bin/env bash
echo "$@" >> "${join(dir, "calls")}"
echo "◇ injected env (0) from .env"
case "$2" in
  */explore) echo '{"status": 200, "ok": true, "headers": {}, "body": "{\\"heads\\":{}}"}' ;;
  */explore/record/*) echo '{"status": 404, "ok": false, "headers": {}, "body": "not found"}'; exit 1 ;;
  */sendMessage) echo '{"status": 200, "ok": true, "headers": {}, "body": {"status": "success"}}' ;;
esac
`);
  chmodSync(fake, 0o755);
  const read = authfetchReader("http://x.localhost:1/", [fake]);
  assert.deepEqual(await read(""), { heads: {} });
  assert.equal(await read("/record/bafy"), undefined);
  const f = join(dir, "001-head.json");
  writeFileSync(f, "{}");
  assert.deepEqual(await authfetchPoster("http://x.localhost:1", [fake])("{}", f), { status: 200, text: '{"status":"success"}' });
  assert.deepEqual(readFileSync(join(dir, "calls"), "utf8").trim().split("\n"), [
    "GET http://x.localhost:1/explore --json",
    "GET http://x.localhost:1/explore/record/bafy --json",
    `POST http://x.localhost:1/sendMessage --body @${f} --json`,
  ]);
});

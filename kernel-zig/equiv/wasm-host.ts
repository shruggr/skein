// The host loads the kernel (the settled split, 2026-10-31), end to end on the WASM host: every
// instance a set of its host's one SQLite database, run by kernel-zig/zig-out/web/skein-kernel.wasm
// on a worker of the node host's own process — and every store it wrote replayed by the NATIVE
// reference (`skein-kernel replay`) to the same state CID: the two kernels agree (requirement 1).
//
//   (a) the one-key host scenario (equiv/onekey.ts, SKEIN_EQUIV_STORE=wasm): two token-id instances
//       and alice on one node and one key, the bare-host routing, the instance manager's creates
//       from an image (the overlay, the chain app: admits, beats), discovery born from it, D's pull
//       of tm_color_T0 from T0 between two hosts — its stores replayed natively;
//   (b) the overlay sync between two hosts on one topic (equiv/sync.ts, wasm) — replayed natively;
//   (c) #157, a messagebox delivery as an emit: alpha (the chat app) answers the owner into the
//       owner's mailbox instance — its delivery thread emits `deliver`, the host carries the
//       BRC-104 exchange, the server's signed answer is an entry in box `deliver` (status 200),
//       the delivery thread finished; then a FORGED answer (the same record, its status changed),
//       one naming no deliver event, and one with a bad signature: each refused at the door
//       (400 ERR_DELIVERY), nothing written (the log's tip unchanged);
//   (d) every store of (c) replayed natively: the same state CID as the wasm kernel wrote;
//   (e) timings: front-door steps per second (one BRC-103 handshake = one entry, one step, two
//       signer calls) on the wasm host vs the native process kernel (a serve per file store, and
//       the one-process RocksDB kernel: the rack's shape).
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/wasm-host.ts

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";
import { RawBox } from "../../src/client/raw.ts";
import { InferPeer } from "../../src/peers/infer.ts";
import { ephemeralWallet } from "../../src/wallet.ts";
import { CHAT_APP } from "../../src/testapps.ts";
import { testHost, until } from "../../src/host/testhost.ts";
import { storeSpec } from "../../src/runtime/index-store.ts";
import { openStoreFile } from "../../src/host/stores.ts";
import { encode } from "../../src/runtime/cid.ts";
import { CID } from "multiformats/cid";
import { DatabaseSync } from "node:sqlite";
import { decode as dagCborDecode } from "@ipld/dag-cbor";
import { parseSqliteSpec } from "../../src/runtime/index-store.ts";
import { exportSet } from "../../src/host/store-sqlite.ts";

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };
const node = (args: string[], env: Record<string, string> = {}) => spawnSync("node", ["--experimental-strip-types", "--no-warnings", ...args], { encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 1 << 28 });

/** A test context for testHost outside node:test: its after() hooks run at the end. */
function ctx() {
  const hooks: Array<() => unknown> = [];
  return { after: (f: () => unknown) => { hooks.push(f); }, done: async () => { for (const f of hooks.reverse()) await f(); } };
}

/** The native reference's replay of a wasm host's set (replays.ts: exported, replayed twice, reproduced exactly); its state CID. */
function replayNative(spec: string, label: string): void {
  const q = parseSqliteSpec(spec)!;
  const db = new DatabaseSync(q.db, { readOnly: true });
  const ptr = db.prepare(`SELECT cid FROM pointers WHERE "set" = ? AND name = 'state'`).get(q.set) as { cid: Uint8Array } | undefined;
  db.close();
  const wasmState = ptr ? CID.decode(new Uint8Array(ptr.cid)).toString() : "none";
  // The native reference's own replay of the exported set: its state record's CID.
  const work = mkdtempSync(join(tmpdir(), "skein-wh-"));
  exportSet(q.db, q.set, join(work, "src.db"));
  const n = spawnSync(join(here, "../zig-out/bin/skein-kernel"), ["replay", join(work, "src.db"), join(work, "z.db")], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (process.env.SKEIN_WH_DIFF) {
    const a = new DatabaseSync(join(work, "src.db"), { readOnly: true }), b = new DatabaseSync(join(work, "z.db"), { readOnly: true });
    const keys = (d: DatabaseSync) => new Map((d.prepare("SELECT cid, bytes FROM blocks").all() as Array<{ cid: Uint8Array; bytes: Uint8Array }>).map((r) => [Buffer.from(r.cid).toString("hex"), r.bytes]));
    const ka = keys(a), kb = keys(b);
    for (const [k, v] of ka) if (!kb.has(k)) { const c = CID.decode(Buffer.from(k, "hex")); let txt = ""; try { txt = JSON.stringify(dagCborDecode(new Uint8Array(v)), (_k, x) => (x instanceof Uint8Array ? `bytes(${x.length})` : x?.["/"] ? x : x)).slice(0, 400); } catch { txt = `raw ${v.length}`; } process.stdout.write(`  only in the wasm store: ${c} ${txt}\n`); }
    a.close(); b.close();
  }
  rmSync(work, { recursive: true, force: true });
  const nativeState = n.status === 0 ? (JSON.parse(n.stdout) as { index: { record: string } }).index.record : `replay failed: ${n.stderr.slice(0, 200)}`;
  const r = node([join(here, "replays.ts"), spec]);
  const line = r.stdout.trim().split("\n").find((l) => l.includes("identical")) ?? r.stdout.trim() + r.stderr.trim();
  if (!/identical .*the source store reproduced exactly/.test(r.stdout)) process.stdout.write(r.stdout.split("\n").filter((l) => !/^\s+"baf/.test(l)).join("\n").slice(0, 1500) + "\n");
  check(r.status === 0 && /identical .*the source store reproduced exactly/.test(r.stdout) && wasmState === nativeState, `${label}: state written by the wasm kernel ${wasmState} = the native replay's ${nativeState} — ${line.slice(0, 200)}`);
}

// ---------------------------------------------------------------- (a), (b)

const ONLY = process.env.SKEIN_WH_ONLY; // a, c, e: one part (development)
for (const [name, file] of ONLY && ONLY !== "a" ? [] : [["onekey", "onekey.ts"], ["sync", "sync.ts"]] as const) {
  const t0 = Date.now();
  const r = node([join(here, file)], { SKEIN_EQUIV_STORE: "wasm" });
  const out = (r.stdout + r.stderr).trim().split("\n");
  const fails = out.filter((l) => l.startsWith("FAIL"));
  for (const l of fails.slice(0, 20)) process.stdout.write(`  ${l}\n`);
  const native = out.filter((l) => /replays to itself exactly|replayed/.test(l) && l.startsWith("ok")).length;
  check(r.status === 0 && out.some((l) => l === `${name} (wasm): all ok`), `(${name === "onekey" ? "a" : "b"}) ${file} on the wasm host: ${out.at(-1)} (${out.filter((l) => l.startsWith("ok")).length} ok, ${native} store replays, ${Date.now() - t0} ms)`);
}

// ---------------------------------------------------------------- (c), (d): #157 on the wasm host

if (!ONLY || ONLY === "c") {
  const t = ctx();
  try {
    const inferKey = PrivateKey.fromRandom(), inferId = inferKey.toPublicKey().toString();
    const h = await testHost(t, { infer: inferId, sqlite: true });
    h.mailbox("david", h.ownerId);
    h.mailbox("infer", inferId);
    const alpha = h.instance("alpha");
    await h.router.start();
    await h.install("alpha", [CHAT_APP]);
    const reply = { choices: [{ message: { role: "assistant", content: "hello from alpha" } }], usage: { prompt_tokens: 1, completion_tokens: 1 }, model: "q" };
    const w = ephemeralWallet(inferKey);
    const peer = new InferPeer({
      wallet: w, providers: { ripper: { baseUrl: "http://ripper.test/v1" } }, log: (l) => h.lines.push(`[infer] ${l}`),
      fetch: (async () => new Response(JSON.stringify(reply), { status: 200 })) as unknown as typeof fetch,
      raw: { inbox: new RawBox(w, `${h.base}/@infer`), outbox: (url) => new RawBox(w, url), addressOf: (k) => { const r = h.db.list().find((x) => x.identity === k && x.kind !== "mailbox"); return r && h.origin(r.handle); } },
    });
    await new RawBox(h.owner, `${h.base}/@alpha`).send(alpha, "chat", { text: "hi" });
    const mine = new RawBox(h.owner, `${h.base}/@david`);
    const got = await until("alpha's answer in the owner's mailbox", async () => { await peer.poll(); return (await mine.list("chat")).find((m) => (m.value as { text?: string }).text === "hello from alpha"); }, 60_000);
    await h.router.settled();
    check(got.sender === alpha, "(c) alpha's answer reached the owner's mailbox instance: sent by alpha (its delivery carried by the host)");
    check(h.lines.some((l) => l.includes("wasm kernel, worker")), "(c) the instances ran on the wasm kernel (a worker each)");
    const spec = storeSpec(h.db.get("alpha")!);
    const s = openStoreFile(spec, { readOnly: true });
    let ans: Record<string, unknown> | undefined, deliverEvent: Record<string, unknown> | undefined, answerCid: CID | undefined;
    try {
      for await (const { entry } of s.log.entries(0)) {
        const e = entry as Record<string, unknown>;
        if (e.box === "deliver") answerCid = e.event as CID;
      }
    } finally { s.close(); }
    // The records as the kernel keeps them (the reader above shows bytes for people).
    const k = (await h.router.hydrate("alpha")).kernel;
    if (answerCid) ans = await k.store.get(answerCid) as unknown as Record<string, unknown>;
    if (ans) deliverEvent = await k.store.get(ans.replyTo as CID) as unknown as Record<string, unknown>;
    if (process.env.VERBOSE) process.stdout.write(`answer record: ${JSON.stringify(Object.fromEntries(Object.entries(ans ?? {}).map(([k, v]) => [k, v instanceof Uint8Array ? `bytes(${v.length})` : String(v)])))}\n`);
    check(!!ans && ans.kind === "delivery" && Number(ans.status) === 200, `(c) the server's answer is an entry in box \`deliver\`: {kind: delivery, status ${ans?.status}, peer ${Buffer.from((ans?.peer as Uint8Array) ?? []).toString("hex").slice(0, 16)}…}`);
    check(deliverEvent?.event === "deliver" && (deliverEvent.nonce as Uint8Array)?.length === 32, "(c) it answers the delivery thread's `deliver` intention (its 32-byte nonce the request id)");
    check(h.lines.some((l) => /delivery|deliver/.test(l) && /finished/.test(l)) || h.lines.some((l) => l.includes("the signed answer admitted")), "(c) the delivery thread is stepped by it");
    // Forged answers: each refused at the door, nothing written.
    const tipOf = async () => { const v = openStoreFile(spec, { readOnly: true }); try { return (await v.log.tip())?.toString(); } finally { v.close(); } };
    const before = await tipOf();
    const refused = async (rec: Record<string, unknown>, what: string) => {
      let why = "";
      try { await h.router.admitEvent("alpha", "deliver", rec); why = "admitted"; } catch (e) { why = (e as Error).message; }
      await h.router.settled();
      check(why !== "admitted" && /ERR_DELIVERY|turned away|400/.test(why) && (await tipOf()) === before, `(c) ${what}: refused at the door (${why.slice(0, 120)}), nothing written`);
    };
    await refused({ ...ans!, status: 500 }, "a forged answer (its status changed)");
    await refused({ ...ans!, body: new TextEncoder().encode("{}") }, "a forged answer (its body changed)");
    await refused({ ...ans!, signature: Uint8Array.from((ans!.signature as Uint8Array).map((b, i) => (i === 10 ? b ^ 1 : b))) }, "a bad signature");
    await refused({ ...ans!, replyTo: encode({ kind: "event", event: "fetch" }).cid }, "an answer naming no deliver event of alpha's");
    await h.router.close();
    for (const hh of ["alpha", "david", "infer"]) replayNative(storeSpec(h.db.get(hh)!), `(d) ${hh}`);
  } finally { await t.done(); }
}

// ---------------------------------------------------------------- (e) timings

const N = Number(process.env.SKEIN_EQUIV_STEPS ?? 200);
const timings: string[] = [];
for (const mode of ONLY && ONLY !== "e" ? [] : ["wasm", "file", "rocksdb"] as const) {
  if (mode !== "wasm" && !existsSync(join(here, "../zig-out/bin/skein-kernel"))) continue;
  const t = ctx();
  try {
    const h = await testHost(t, { sqlite: mode === "wasm", rocks: mode === "rocksdb" });
    h.instance("bench");
    await h.router.start();
    await h.router.hydrate("bench");
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      // A new client each time: its BRC-103 handshake is one entry and one front-door step (two signer calls).
      await new RawBox(ephemeralWallet(PrivateKey.fromRandom()), `${h.base}/@bench`).list("inbox").catch(() => {});
    }
    await h.router.settled();
    const ms = performance.now() - t0;
    const s = openStoreFile(storeSpec(h.db.get("bench")!), { readOnly: true });
    let entries = 0;
    try { for await (const _ of s.log.entries(1)) entries++; } finally { s.close(); }
    timings.push(`${mode === "wasm" ? "wasm host (SQLite set, a worker)" : mode === "file" ? "native serve (a file per instance)" : "native one process (RocksDB, the rack's)"}: ${entries} entries (handshake steps) in ${ms.toFixed(0)} ms = ${(entries / (ms / 1000)).toFixed(1)} steps/s`);
    process.stdout.write(`timing: ${timings.at(-1)}\n`);
  } finally { await t.done(); }
}

process.stdout.write(failures ? `wasm-host: ${failures} FAILED\n` : "wasm-host: all ok\n");
process.exit(failures ? 1 : 0);

// Overlay services in the VM (issue #36) end to end on the Zig kernel,
// driven through the router (src/host/overlay.ts) by the stock @bsv/sdk
// overlay clients: an instance booted from a system tree (#4) whose bin/
// holds the overlay engine, the tm_demo topic and the ls_demo lookup
// (programs/overlay), its config naming them. Headers are fed as plain
// `header` entries (a regtest chain from its genesis, the funding mined at
// height 1); a token transaction is broadcast with TopicBroadcaster (POST
// /submit, SHIP's wire form) and found with LookupResolver (POST /lookup,
// the aggregated octet-stream form) — its BEEF verifies against the headers;
// the token is spent into a new one (the old retained for history); then a
// `status` entry rejects the spend and the first token is live again. The
// listings and documentation routes answer from the program records. The
// store then replays to itself exactly (equiv/replays.ts).
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/overlay.ts

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HTTPSOverlayBroadcastFacilitator, LookupResolver, MerklePath, P2PKH, PrivateKey, Script, TopicBroadcaster, Transaction, UnlockingScript, Utils, type ChainTracker } from "@bsv/sdk";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import { dirSource } from "../../src/host/boot.ts";
import { HostDb } from "../../src/host/instances.ts";
import { Router } from "../../src/host/router.ts";
import { ephemeralWallet } from "../../src/wallet.ts";

const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
const overlayBin = join(here, "../../programs/overlay/zig-out/bin");
const home = mkdtempSync(join(tmpdir(), "skein-kz-overlay-"));
const db = join(home, "instances/overlay/runtime.db");
const key = (h: string) => new PrivateKey(h, 16);
const report: Record<string, unknown> = {};
let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };
const eq = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);

// ---------------------------------------------------------------- the system tree

const sys = join(home, "system");
mkdirSync(join(sys, "bin"), { recursive: true });
mkdirSync(join(sys, "etc"), { recursive: true });
for (const p of ["overlay", "topic-demo", "lookup-demo"]) copyFileSync(join(overlayBin, `${p}.wasm`), join(sys, `bin/${p}.wasm`));
const handler = { event: "cid", box: "string" };
writeFileSync(join(sys, "bin/overlay.json"), JSON.stringify({ inputs: handler, description: "The overlay engine: BRC-22 submit, BRC-24 lookup, the chain feed." }));
writeFileSync(join(sys, "bin/topic-demo.json"), JSON.stringify({ inputs: {}, description: "Demo tokens: outputs whose script starts <\"tm_demo\"> OP_DROP.\n\nEvery such output is admitted; the tokens a transaction spends are retained when it admits one." }));
writeFileSync(join(sys, "bin/lookup-demo.json"), JSON.stringify({ inputs: {}, description: "Demo token lookup: {topic}, {scriptHash, topic?}, {txid, outputIndex, topic}." }));
writeFileSync(join(sys, "etc/config.json"), JSON.stringify({ defaults: { walletNetwork: "regtest", overlayTopics: JSON.stringify({ tm_demo: "topic-demo" }), overlayLookups: JSON.stringify({ ls_demo: "lookup-demo" }) } }));
writeFileSync(join(sys, "etc/subscriptions.json"), JSON.stringify([{ box: "submit", handler: "overlay" }, { box: "lookup", handler: "overlay" }, { box: "chain", handler: "overlay" }]));
writeFileSync(join(sys, "README.md"), "An overlay node: tm_demo and ls_demo.\n");

// ---------------------------------------------------------------- regtest

const sha256d = (b: Uint8Array) => createHash("sha256").update(createHash("sha256").update(b).digest()).digest();
const internal = (displayHex: string) => Buffer.from(displayHex, "hex").reverse();
const REGTEST_GENESIS = Buffer.from("0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4adae5494dffff7f2002000000", "hex");
const TARGET = 0x7fffffn << BigInt(8 * (0x20 - 3));
function mine(prev: Uint8Array, merkleRoot: Uint8Array, time: number): Uint8Array {
  const h = Buffer.alloc(80);
  h.writeInt32LE(1, 0);
  Buffer.from(prev).copy(h, 4);
  Buffer.from(merkleRoot).copy(h, 36);
  h.writeUInt32LE(time, 68);
  h.writeUInt32LE(0x207fffff, 72);
  for (let nonce = 0; ; nonce++) {
    h.writeUInt32LE(nonce, 76);
    if (BigInt("0x" + Buffer.from(sha256d(h)).reverse().toString("hex")) <= TARGET) return new Uint8Array(h);
  }
}
const txCid = (txid: string) => CID.createV1(0xb1, Digest.create(0x56, internal(txid)));

// ---------------------------------------------------------------- the router

const hostDb = new HostDb(join(home, "host.db"));
hostDb.add("overlay", { store: db });
const owner = key("2222").toPublicKey().toString();
const router = new Router({
  db: hostDb, walletFor: () => ephemeralWallet(key("1111")), authWallet: ephemeralWallet(), owner, idleMs: 0,
  kernel: { command: kernel, env: { SKEIN_HOME: home } },
  log: (s, l) => { if (process.env.VERBOSE) process.stdout.write(`  | [${s}] ${l}\n`); },
});

try {
  const src = await dirSource(sys);
  await router.bootRow("overlay", { kind: "tree", root: src.root, objects: src.objects });
  const server = await router.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  // The chain: the funding transaction mined alone at 1, then 2 and 3, as plain header entries.
  const alice = key("3333");
  const fund = new Transaction();
  fund.addInput({ sourceTXID: "11".repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex("51"), sequence: 0xffffffff });
  fund.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 50_000 });
  const fundTxid = fund.id("hex");
  // Second in its block (a transaction at offset 0 is a coinbase, which the SDK holds to 100 blocks' maturity).
  const cb = "cb".repeat(32);
  fund.merklePath = new MerklePath(1, [[{ offset: 0, hash: cb }, { offset: 1, hash: fundTxid, txid: true }]]);
  const root1 = sha256d(Buffer.concat([internal(cb), internal(fundTxid)]));
  const headers: Uint8Array[] = [];
  let prev: Uint8Array = sha256d(REGTEST_GENESIS);
  for (let h = 1; h <= 3; h++) {
    headers.push(mine(prev, h === 1 ? root1 : sha256d(Buffer.from(`filler ${h}`)), 1_790_000_000 + h * 600));
    prev = sha256d(headers.at(-1)!);
  }
  for (const raw of headers) await router.admitEvent("overlay", "chain", { kind: "header", raw });
  await router.settled();
  const roots = new Map<number, string>(headers.map((h, i) => [i + 1, Buffer.from(h.subarray(36, 68)).reverse().toString("hex")]));
  const tracker: ChainTracker = { isValidRootForHeight: async (root, height) => roots.get(height) === root, currentHeight: async () => headers.length };

  // A token: <"tm_demo"> OP_DROP + P2PKH to alice.
  const tokenScript = (k: PrivateKey) => Script.fromBinary([0x07, ...Buffer.from("tm_demo"), 0x75, ...new P2PKH().lock(k.toPublicKey().toHash()).toBinary()]);
  const t1 = new Transaction();
  t1.addInput({ sourceTransaction: fund, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(alice), sequence: 0xffffffff });
  t1.addOutput({ lockingScript: tokenScript(alice), satoshis: 1 });
  t1.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 49_000 });
  await t1.sign();

  // The stock broadcaster, its facilitator pointed at the router (the local preset only knows :8080).
  const steaks: unknown[] = [];
  const facilitator = { send: async (_url: string, tagged: Parameters<HTTPSOverlayBroadcastFacilitator["send"]>[1]) => { const s = await new HTTPSOverlayBroadcastFacilitator(fetch, true).send(base, tagged); steaks.push(s); return s; } };
  const broadcaster = new TopicBroadcaster(["tm_demo"], { networkPreset: "local", facilitator });
  const b1 = await broadcaster.broadcast(t1);
  report.submit1 = { status: b1.status, steak: steaks.at(-1) };

  // The stock resolver: aggregated octet-stream answers, BEEF per output.
  const resolver = new LookupResolver({ networkPreset: "local", hostOverrides: { ls_demo: [base] } });
  const look = async (query: unknown) => {
    const a = await resolver.query({ service: "ls_demo", query }) as { type: string; outputs: Array<{ beef: number[]; outputIndex: number }> };
    const out = [];
    for (const o of a.outputs) {
      const tx = Transaction.fromBEEF(o.beef);
      let verifies: unknown;
      try { verifies = await tx.verify(tracker); } catch (e) {
        const walk = (t: Transaction): unknown => ({ id: t.id("hex"), mp: t.merklePath ? [t.merklePath.blockHeight, t.merklePath.computeRoot(t.id("hex"))] : null, ins: t.inputs.map((i) => i.sourceTransaction ? walk(i.sourceTransaction) : i.sourceTXID) });
        verifies = `${(e as Error).message} ${JSON.stringify(walk(tx))} roots ${JSON.stringify([...roots])} fund ${fundTxid}`;
      }
      out.push({ txid: tx.id("hex"), outputIndex: o.outputIndex, verifies });
    }
    return out;
  };
  const name = (txid: string) => txid === t1.id("hex") ? "t1" : txid === t2.id("hex") ? "t2" : "?";
  const t2 = new Transaction();
  t2.addInput({ sourceTransaction: t1, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(alice), sequence: 0xffffffff });
  t2.addOutput({ lockingScript: tokenScript(alice), satoshis: 1 });
  // (T2 pays no fee: nothing here broadcasts to the network, and SPV does not check fees.)
  await t2.sign();

  report.lookup1 = (await look({ topic: "tm_demo" })).map((o) => [name(o.txid), o.outputIndex, o.verifies]);
  const sh = createHash("sha256").update(Buffer.from(tokenScript(alice).toBinary())).digest("hex");
  report.byScript = (await look({ scriptHash: sh, topic: "tm_demo" })).map((o) => [name(o.txid), o.outputIndex]);
  // The plain JSON form too.
  const json = await (await fetch(`${base}/lookup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service: "ls_demo", query: { topic: "tm_demo" } }) })).json() as { type: string; outputs: Array<{ beef: number[]; outputIndex: number }> };
  report.lookupJson = { type: json.type, outputs: json.outputs.map((o) => [name(Transaction.fromBEEF(o.beef).id("hex")), o.outputIndex]) };

  // A resubmission is a dupe: nothing new.
  const dupe = await new HTTPSOverlayBroadcastFacilitator(fetch, true).send(base, { beef: t1.toBEEF(), topics: ["tm_demo", "tm_other"] });
  report.dupe = dupe;

  // T2 spends the token into a new one (X-Topics as a JSON array, Atomic BEEF): the old one is retained.
  const r2 = await fetch(`${base}/submit`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-topics": JSON.stringify(["tm_demo"]) }, body: new Uint8Array(t2.toAtomicBEEF()) });
  report.submit2 = await r2.json();
  report.lookup2 = (await look({ topic: "tm_demo" })).map((o) => [name(o.txid), o.outputIndex, o.verifies]);
  report.withSpent = (await look({ topic: "tm_demo", includeSpent: true })).map((o) => [name(o.txid), o.outputIndex]).sort();

  // ARC says T2 was double spent (a plain status entry for its CID): its admittance vanishes, T1's token is live again.
  await router.admitEvent("overlay", "chain", { kind: "status", subject: txCid(t2.id("hex")), txid: t2.id("hex"), txStatus: "DOUBLE_SPEND_ATTEMPTED" });
  await router.settled();
  report.afterReject = (await look({ topic: "tm_demo" })).map((o) => [name(o.txid), o.outputIndex, o.verifies]);
  const again = await fetch(`${base}/submit`, { method: "POST", headers: { "x-topics": "tm_demo" }, body: new Uint8Array(t2.toAtomicBEEF()) });
  report.resubmitRejected = [again.status, ((await again.json()) as { message?: string }).message];

  // Refusals, listings, documentation.
  const bad = await fetch(`${base}/submit`, { method: "POST", headers: { "x-topics": "tm_demo" }, body: new Uint8Array([1, 2, 3]) });
  report.badBeef = [bad.status, ((await bad.json()) as { message?: string }).message];
  const unknown = await fetch(`${base}/lookup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service: "ls_nope", query: {} }) });
  report.unknownService = unknown.status;
  report.topics = await (await fetch(`${base}/listTopicManagers`)).json();
  report.lookups = await (await fetch(`${base}/listLookupServiceProviders`)).json();
  const doc = await fetch(`${base}/getDocumentationForTopicManager?manager=tm_demo`);
  report.doc = [doc.headers.get("content-type"), (await doc.text()).split("\n")[0]];
  report.ok = true;
} catch (e) {
  report.error = (e as Error).stack ?? String(e);
}
await router.stop();
hostDb.close();

process.stdout.write("== overlay services (#36)\n");
check(report.ok === true, `the scenario ran${report.error ? `: ${report.error}` : ""}`);
check(eq(report.submit1, { status: "success", steak: { tm_demo: { outputsToAdmit: [0], coinsToRetain: [], coinsRemoved: [] } } }), `TopicBroadcaster → POST /submit: the token admitted (${JSON.stringify(report.submit1)})`);
check(eq(report.lookup1, [["t1", 0, true]]), `LookupResolver → POST /lookup (aggregated): the token, its BEEF verifying against the headers (${JSON.stringify(report.lookup1)})`);
check(eq(report.byScript, [["t1", 0]]), `a lookup by script hash (${JSON.stringify(report.byScript)})`);
check(eq(report.lookupJson, { type: "output-list", outputs: [["t1", 0]] }), `the JSON answer form (${JSON.stringify(report.lookupJson)})`);
check(eq(report.dupe, { tm_demo: { outputsToAdmit: [], coinsToRetain: [], coinsRemoved: [] } }), `a resubmission is a dupe; an unserved topic is left out (${JSON.stringify(report.dupe)})`);
check(eq(report.submit2, { tm_demo: { outputsToAdmit: [0], coinsToRetain: [0], coinsRemoved: [] } }), `the spend: a new token admitted, the old retained (${JSON.stringify(report.submit2)})`);
check(eq(report.lookup2, [["t2", 0, true]]) && eq(report.withSpent, [["t1", 0], ["t2", 0]]), `the live set moves to the new token; the old one stays for history (${JSON.stringify([report.lookup2, report.withSpent])})`);
check(eq(report.afterReject, [["t1", 0, true]]), `a status entry rejects the spend: its admittance vanishes, the consumed token is restored (${JSON.stringify(report.afterReject)})`);
check(Array.isArray(report.resubmitRejected) && report.resubmitRejected[0] === 400 && report.resubmitRejected[1] === "TransactionRejected", `a rejected transaction is refused on resubmission (${JSON.stringify(report.resubmitRejected)})`);
check(Array.isArray(report.badBeef) && report.badBeef[0] === 400 && report.unknownService === 400, `refusals: a bad BEEF, an unknown service (${JSON.stringify([report.badBeef, report.unknownService])})`);
check(eq(report.topics, { tm_demo: { name: "tm_demo", shortDescription: "Demo tokens: outputs whose script starts <\"tm_demo\"> OP_DROP." } }) && (report.lookups as Record<string, unknown>)?.ls_demo !== undefined, `the listings, from the program records (${JSON.stringify([report.topics, report.lookups])})`);
check(Array.isArray(report.doc) && String(report.doc[0]).startsWith("text/markdown"), `documentation (${JSON.stringify(report.doc)})`);

const r = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), db], { encoding: "utf8" });
process.stdout.write(r.stdout);
if (r.status !== 0) process.stdout.write(r.stderr);
check(r.status === 0 && /identical .*the source store reproduced exactly/.test(r.stdout), "the store replays to itself exactly");

if (process.env.KEEP) process.stdout.write(`kept ${home}\n`); else rmSync(home, { recursive: true, force: true });
process.stdout.write(failures ? `overlay: ${failures} FAILED\n` : "overlay: all ok\n");
process.exit(failures ? 1 : 0);

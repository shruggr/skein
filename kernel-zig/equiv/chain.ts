// The chain module (#78) end to end: shruggr/skein-chain at a pinned commit
// (or $SKEIN_CHAIN_DIR), installed as the owner's messages (`skein install`, sent to /sendMessage, #124)
// into an instance of the stock system on a router with an Arcade (so a
// broadcaster and a `$status` provider), called by the instance's owner (a
// mailbox of its own on the same host; #79: the chain app takes calls from
// `$owner` and `$self`, not from anyone):
//
//   - the install asks for the rows `chain` from `event` (the host's events),
//     from `$self` and from `$owner`, and `status` (box chain/status, #128) from $status (optional),
//     and the head chain/app; chain/state is its writes; a stranger's call
//     routes nowhere;
//   - the host's chain feed (a `header` event in box chain) reaches it;
//   - ingest proven ({fn: "ingest", args: {beef}} in box chain): recorded,
//     answered at once (state proven, the block's CID);
//   - ingest unproven: recorded, broadcast (the host's Arcade gets it — from
//     the chain app, the only thing that emits it here); every status is the
//     fact chain/tx/<txid> (read at the host's event route; skein-chain 0.11.0's
//     words): pending at intake, seen (the status provider's RECEIVED), mined
//     (the proof Arcade reports once mined; the header first); a second ingest
//     of it while pending is answered accepted at once (and its status, seen,
//     raised again);
//   - ingest unproven that Arcade refuses as invalid: pending, then the fact
//     rejected; its proof later is the latest fact — mined, status proven;
//   - the reads `status` and `proof` answer CIDs; a bad BEEF is an error;
//   - nothing unproven is at rest without a registered broadcast;
//   - the same reads as a kernel call; ingest is refused there (it writes: a step's);
//   - D8 (skein 0.6.0): the stock scopes name no `chain` — the chain app is
//     never a genesis-wired system program;
//   - a reorg (0.7.1, the settled overlay sync design): a heavier branch
//     without the proven child turns it back to unproven and broadcasts
//     nothing (the fact seen, reason reorged); the child mined in the new
//     branch, Arcade's status for the new block is the proof event — the fact
//     mined again, with the new height.
//
// Both stores then replay to themselves exactly.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/chain.ts

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MerklePath, P2PKH, PrivateKey, Transaction, UnlockingScript } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { RawBox } from "../../src/client/raw.ts";
import { dirSource, stockSystemFiles } from "../../src/host/boot.ts";
import { main } from "../../src/host/cli.ts";
import { ownerCli } from "../../src/testapps.ts";
import { FakeArcade } from "../../src/host/fake-arcade.ts";
import { testHost, until } from "../../src/host/testhost.ts";
import { ephemeralWallet } from "../../src/wallet.ts";
import { storeSpec } from "../../src/runtime/index-store.ts";
import { openStoreFile } from "../../src/host/stores.ts";
import { emittedEvents } from "../../src/host/p2p.ts";
import { BACKEND, ROCKS_MODE } from "./backend.ts";
import { txCid } from "../../src/host/feeds.ts";

// The app under test: SKEIN_CHAIN_DIR names a checkout, else this commit.
const CHAIN_REPO = "https://github.com/shruggr/skein-chain";
const CHAIN_REV = process.env.SKEIN_CHAIN_REV ?? "v0.11.0"; // skein-chain 0.11.0: a saved merkle path links every transaction it covers; status by subscription
const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };

// ---------------------------------------------------------------- regtest (as equiv/overlay.ts)

const sha256d = (b: Uint8Array) => createHash("sha256").update(createHash("sha256").update(b).digest()).digest();
const internal = (displayHex: string) => Buffer.from(displayHex, "hex").reverse();
const display = (h: Uint8Array) => Buffer.from(h).reverse().toString("hex");
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

const arcade = await FakeArcade.start();
const afters: Array<() => unknown> = [];
// The caller is the instance's owner (#79: the chain app's rows admit $owner and $self).
const callerKey = PrivateKey.fromRandom(), callerId = callerKey.toPublicKey().toString();
const h = await testHost({ after: (f) => afters.push(f) }, { ownerKey: callerKey, genesis: { defaults: { walletNetwork: "regtest" } }, arc: { url: arcade.url, token: "the-chain-arcade-token", events: arcade.eventsUrl }, arcRetry: { min: 300, max: 1000 }, rocks: ROCKS_MODE });
let store = "";
const bootStores: string[] = [];
/** The app's checkout at the pinned commit (for its bin/chain.wasm in a system tree). */
function cloneChain(home: string): string {
  const dir = join(home, "skein-chain");
  for (const args of [["clone", "-q", CHAIN_REPO, dir], ["-C", dir, "checkout", "-q", CHAIN_REV]]) {
    const r = spawnSync("git", args, { stdio: ["ignore", "ignore", "inherit"] });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: exit ${r.status}`);
  }
  return dir;
}
try {
  const callerWallet = ephemeralWallet(callerKey);
  const callerMailbox = await h.inbox(callerKey, "caller");
  const inst = h.instance("ch");
  await h.router.start();
  const owner = new RawBox(h.owner, `${h.base}/@ch`);
  await owner.send(inst, "peers", { op: "add", key: callerId, url: callerMailbox });
  await h.router.settled();
  store = storeSpec(h.db.get("ch")!);
  const k = async () => (await h.router.hydrate("ch")).kernel;
  const record = async (name: string) => {
    const kk = await k();
    const root = await kk.call("head", name) as CID | null;
    return root ? await kk.store.get(root) as Record<string, unknown> : undefined;
  };

  // ------------------------------------------------ install
  const out: string[] = [], err: string[] = [];
  const cli = async (...args: string[]) => {
    out.length = 0; err.length = 0;
    // #124: install/uninstall are the owner's messages, planned and sent on the owner's session (src/testapps.ts ownerCli).
    const o = args[0] === "install" || args[0] === "uninstall" ? await ownerCli({ home: h.home, port: h.router.port!, owner: h.owner, settled: () => h.router.settled() }, args) : undefined;
    if (o) { out.push(...o.out); err.push(...o.err); }
    const code = o ? o.code : await main(args, {
      vars: { SKEIN_HOME: h.home, HOME: h.home }, out: (l) => out.push(l), err: (l) => err.push(l),
    });
    await h.router.settled();
    if (process.env.VERBOSE) for (const l of [...out, ...err]) process.stdout.write(`  | ${l}\n`);
    return code;
  };
  const spec = process.env.SKEIN_CHAIN_DIR ?? `${CHAIN_REPO}#${CHAIN_REV}`;
  const code = await cli("install", spec, "--instance", "ch");
  check(code === 0, `skein install skein-chain: exit ${code} ${err.join(" ")}`);
  const routeLines = out.filter((l) => /^ {2}route /.test(l)).map((l) => l.trim().replace(/\s+/g, " "));
  check(routeLines.some((l) => l.startsWith("route event chain ")) && routeLines.some((l) => l.startsWith("route mailbox chain [kernel.beef] ")) && routeLines.some((l) => l.startsWith("route mailbox chain/status ")) && routeLines.length === 3,
    `the prompt shows its routes (#143: no sender; the BEEF decoded at the door): ${routeLines.join(" | ")}`);
  const app = await record("chain/app");
  check(app?.kind === "app" && app.name === "chain" && app.version === "0.11.0", `the head chain/app is the app record (0.11.0: ${String(app?.version)})`);
  const rows = ((await (await k()).dispatch()).rows as Array<Record<string, unknown>>).filter((r) => r.app === "chain");
  check(rows.length === 3 && rows.every((r) => !("sender" in r) && !("optional" in r)) && rows.map((r) => `${r.transport} ${r.address}`).join(",") === "event chain,mailbox chain,mailbox chain/status"
    && JSON.stringify(rows[1]!.filters) === '["kernel.beef"]',
  `its routes in the table (#143: event chain; mailbox chain with kernel.beef; mailbox chain/status): ${rows.map((r) => `${r.transport} ${r.address} ${JSON.stringify(r.filters ?? [])}`).join(", ")}`);

  // ------------------------------------------------ the chain: block 1 holds the funding alone
  const alice = PrivateKey.fromRandom();
  const fund = new Transaction();
  fund.addInput({ sourceTXID: "72".repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex("51"), sequence: 0xffffffff });
  for (let i = 0; i < 3; i++) fund.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 10_000 });
  const fundTxid = fund.id("hex");
  fund.merklePath = new MerklePath(1, [[{ offset: 0, hash: fundTxid, txid: true }]]);
  const h1 = mine(sha256d(REGTEST_GENESIS), internal(fundTxid), 1_790_200_000);
  await h.router.chainHeaders("ch", "chain", [h1]);
  await h.router.settled();
  const state = async () => {
    const r = await record("chain/state") as { kind?: string; network?: string } | undefined;
    return r;
  };
  const st1 = await state();
  check(st1?.kind === "chain-state" && st1.network === "regtest", `the feed's header reached the chain app: chain/state is a chain-state on regtest (${JSON.stringify(st1 && { kind: st1.kind, network: st1.network })})`);

  // ------------------------------------------------ calls by message, answers in the caller's mailbox
  const callerBox = new RawBox(callerWallet, `${h.base}/@ch`);
  const mine_ = new RawBox(callerWallet, callerMailbox);
  type Answer = { fn: string; request?: CID; replyTo?: CID; result?: Record<string, unknown>; error?: { code: string; message: string } };
  const answersTo = async (id: string) => (await mine_.list("chain")).map((x) => x.value as Answer).filter((v) => String(v.request) === id);
  const send = async (body: Record<string, unknown>) => (await callerBox.send(inst, "chain", body)).id.toString();
  const answers = async (id: string, n: number, what: string) => await until(what, async () => { await h.router.settled(); const a = await answersTo(id); return a.length >= n ? a : undefined; }, 30_000);

  // skein-chain 0.8.0: every status of a transaction is the fact chain/tx/<txid> (the event index, read by the host route).
  const facts = async (txid: string) => {
    const res = await fetch(`${h.base}/@ch/events/chain/tx/${txid}`);
    if (res.status !== 200) throw new Error(`GET /events/chain/tx/${txid}: ${res.status}`);
    return (await res.json() as Array<{ record: Record<string, unknown> }>).map((x) => x.record);
  };
  const statuses = async (txid: string) => (await facts(txid)).map((r) => `${String(r.status)}${r.height !== undefined ? `@${String(r.height)}` : ""}${r.status === "seen" && r.reason !== undefined ? `(${String(r.reason)})` : ""}`).join(",");
  const factsAre = async (txid: string, want: string, what: string) => await until(what, async () => { await h.router.settled(); return (await statuses(txid)) === want || undefined; }, 30_000).then(() => true, () => false);

  // A stranger's call is admitted (#143: a route has no sender; chain's functions are ungated — no `roles`).
  const strangerWallet = ephemeralWallet(PrivateKey.fromRandom());
  const refused = await new RawBox(strangerWallet, `${h.base}/@ch`).send(inst, "chain", { fn: "status", args: { txid: "00".repeat(32) } }).then(() => "sent", (e: Error) => e.message);
  check(refused === "sent", `a stranger's call to the chain app is admitted: its functions are ungated (#143) (${refused})`);

  // Proven in: answered at once.
  const postsBefore = arcade.posts.length;
  const r1 = await send({ fn: "ingest", args: { beef: new Uint8Array(fund.toBEEF()) } });
  const a1 = (await answers(r1, 1, "the proven ingest's answer"))[0]!;
  check(a1.fn === "ingest" && a1.result?.state === "proven" && a1.result.txid === fundTxid && String(a1.result.block) !== "undefined" && a1.result.height === 1 && String(a1.replyTo) === r1, `ingest proven: answered at once, {state: proven, block, height: 1} (${JSON.stringify(a1.result && { state: a1.result.state, height: a1.result.height })})`);
  check(arcade.posts.length === postsBefore, "a proven transaction is not broadcast");

  // Unproven in: broadcast; accepted, then proven.
  const child = new Transaction();
  child.addInput({ sourceTransaction: fund, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(alice), sequence: 0xffffffff });
  child.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 9_000 });
  await child.sign();
  const childTxid = child.id("hex");
  const r2 = await send({ fn: "ingest", args: { beef: new Uint8Array(child.toBEEF()) } });
  const posted = await until("the broadcast reaches the Arcade", () => arcade.posts.find((b) => FakeArcade.txOf(b).id("hex") === childTxid), 20_000).catch(() => undefined);
  check(!!posted, "ingest unproven: broadcast (the host's Arcade got it, from the chain app)");
  // 0.8.0: no watchers — an ingest is answered once, at the ingest, when there is a status (here none: only broadcast).
  check(await factsAre(childTxid, "pending,seen", "seen"), `pending at intake, seen on the status provider's first status: the facts chain/tx/<child> (${await statuses(childTxid)})`);
  check((await answersTo(r2)).length === 0, "the unproven ingest answered nothing (0.8.0: no watchers; the fact carries its status)");
  // While it is pending, another ingest of it: answered accepted at once (its status at the ingest).
  const r3 = await send({ fn: "chain.ingest", args: { beef: new Uint8Array(child.toBEEF()) } });
  const a3 = await answers(r3, 1, "the second ingest's answer");
  check(a3[0]?.fn === "chain.ingest" && a3[0].result?.state === "accepted", `a second ingest while it is pending: accepted at once (${a3[0]?.result?.state})`);
  const st = await (await k()).store.get((await (await k()).call("head", "chain/state")) as CID) as { maps: Record<string, CID | null> };
  check(!!st.maps.unproven && !!st.maps.broadcasts, "at rest unproven: the broadcast registered (maps unproven and broadcasts)");
  // Mined at 2: the header, then Arcade's MINED with its path.
  const h2 = mine(sha256d(h1), internal(childTxid), 1_790_200_600);
  await h.router.chainHeaders("ch", "chain", [h2]);
  await h.router.settled();
  const path = new MerklePath(2, [[{ offset: 0, hash: childTxid, txid: true }]]);
  arcade.emit(childTxid, { txStatus: "MINED", blockHash: display(sha256d(h2)), blockHeight: 2, merklePath: path.toHex() });
  check(await factsAre(childTxid, "pending,seen,seen,mined@2", "mined"), `then mined on Arcade's proof: the fact mined {height: 2} (${await statuses(childTxid)})`);

  // Unproven that Arcade refuses as invalid (its 400 with ARC 465): rejected (the fact).
  const child2 = new Transaction();
  child2.addInput({ sourceTransaction: fund, sourceOutputIndex: 1, unlockingScriptTemplate: new P2PKH().unlock(alice), sequence: 0xffffffff });
  child2.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 8_000 });
  await child2.sign();
  const c2 = child2.id("hex");
  arcade.mode = "reject";
  await send({ fn: "ingest", args: { beef: new Uint8Array(child2.toBEEF()) } });
  check(await factsAre(c2, "pending,rejected", "rejected"), `ingest unproven, refused by Arcade as invalid: pending, then the fact rejected (${await statuses(c2)})`);
  arcade.mode = "ok";
  const r4s = await send({ fn: "status", args: { txid: c2 } });
  const a4 = (await answers(r4s, 1, "status of the rejected"))[0]!;
  check(a4.result?.state === "rejected" && a4.result.reason === "REJECTED" && String(a4.result.settlement) !== "undefined", `its status: rejected, the settlement record says why (${JSON.stringify(a4.result && { state: a4.result.state, reason: a4.result.reason })})`);

  // Reads: CIDs.
  const r5 = await send({ fn: "status", args: { txid: childTxid } });
  const a5 = (await answers(r5, 1, "status"))[0]!;
  check(a5.result?.state === "proven" && String(a5.result.tx).length > 10 && a5.result.height === 2, `status: proven, the tx and block CIDs (${a5.result?.state})`);
  const r6 = await send({ fn: "proof", args: { txid: childTxid } });
  const a6 = (await answers(r6, 1, "proof"))[0]!;
  check(a6.result?.height === 2 && a6.result.depth === 1 && a6.result.position === 0, `proof: block, height, depth, position (${JSON.stringify(a6.result && { height: a6.result.height, depth: a6.result.depth, position: a6.result.position })})`);
  const r7 = await send({ fn: "status", args: { txid: "00".repeat(32) } });
  check((await answers(r7, 1, "unknown"))[0]?.result?.state === "unknown", "status of a transaction it does not hold: unknown");
  const r8 = await send({ fn: "ingest", args: { beef: new Uint8Array([1, 2, 3]) } });
  const a8 = (await answers(r8, 1, "bad beef"))[0]!;
  check(a8.error?.code === "failed" && /InvalidBeef/.test(a8.error.message), `a bad BEEF: an error answer (${JSON.stringify(a8.error)})`);
  const r9 = await send({ fn: "nope", args: {} });
  check((await answers(r9, 1, "unknown fn"))[0]?.error?.code === "unknown-fn", "an unknown function: unknown-fn");

  // The same reads as a kernel call (no entry, no writes): dag-cbor in and out; ingest writes, so a step's only.
  const prog = (app!.programs as Record<string, CID>).chain!;
  const kc = await (await k()).invoke(prog, "status", dagCbor.encode({ txid: childTxid }));
  const kv = kc.ok ? dagCbor.decode(kc.result) as Record<string, unknown> : undefined;
  check(kv?.state === "proven" && kv.height === 2, `a kernel call of status: ${kc.ok ? JSON.stringify({ state: kv?.state, height: kv?.height }) : kc.error}`);
  const ki = await (await k()).invoke(prog, "ingest", dagCbor.encode({ beef: new Uint8Array(child.toBEEF()) }));
  check(!ki.ok && /ingest writes: call it from a step/.test(ki.error), `a kernel call of ingest is refused (it writes: a message, or an in-VM call from a step): ${ki.ok ? "ok?" : ki.error}`);

  // At rest: nothing unproven, no broadcast registered.
  const fin = await (await k()).store.get((await (await k()).call("head", "chain/state")) as CID) as { maps: Record<string, CID | null> };
  check(fin.maps.unproven === null && fin.maps.broadcasts === null, "at rest: nothing unproven, no broadcast left registered");
  const dumped = dagCbor.encode(fin);
  check(dumped.length > 0, "chain/state readable by CID");

  // ------------------------------------------------ D8 (skein 0.6.0): never a genesis-wired system program
  // The stock system names no `chain` scope: the chain app is in a genesis only as an app (#141), updatable by a
  // logged install (the boot-time system-tree chain program of 0.7.x is gone).
  const stock = JSON.parse((await stockSystemFiles(await k()))["etc/config.json"]!) as { scopes?: Record<string, string[]> };
  check(stock.scopes?.chain === undefined, `the stock scopes name no chain (D8): ${JSON.stringify(Object.keys(stock.scopes ?? {}))}`);

  // ------------------------------------------------ 0.9.0 (skein-sdk 0.18.0): a proof after a rejection is the latest fact
  const h3 = mine(sha256d(h2), internal(c2), 1_790_201_200);
  await h.router.chainHeaders("ch", "chain", [h3]);
  await h.router.settled();
  await h.router.admitEvent("ch", "chain", { kind: "proof", subject: txCid(c2), txid: c2, path: Uint8Array.from(new MerklePath(3, [[{ offset: 0, hash: c2, txid: true }]]).toBinary()) });
  check(await factsAre(c2, "pending,rejected,mined@3", "mined after rejected"), `rejected, then its proof: the fact mined {height: 3} (${await statuses(c2)})`);
  const r4b = await send({ fn: "status", args: { txid: c2 } });
  const a4b = (await answers(r4b, 1, "status after the proof"))[0]!;
  check(a4b.result?.state === "proven" && a4b.result.height === 3, `its status now proven at 3 (${JSON.stringify(a4b.result && { state: a4b.result.state, height: a4b.result.height })})`);

  // ------------------------------------------------ a reorg (0.7.1): reverted, nothing broadcast; the new proof by the status feed
  const postsOf = (txid: string) => arcade.posts.filter((b) => FakeArcade.txOf(b).id("hex") === txid).length;
  const childPosts = postsOf(childTxid);
  const fork: Uint8Array[] = [];
  for (let i = 0; i < 3; i++) fork.push(mine(sha256d(fork.at(-1) ?? h1), Buffer.alloc(32, 0x61 + i), 1_790_300_000 + i * 600));
  await h.router.chainHeaders("ch", "chain", fork); // one run from the fork point (the host chain takes the heavier branch)
  await h.router.settled();
  const rs1 = await send({ fn: "status", args: { txid: childTxid } });
  const s1 = (await answers(rs1, 1, "status after the reorg"))[0]!;
  check(s1.result?.state === "unproven", `a heavier branch (to 4) without it: the child unproven again (${s1.result?.state})`);
  await sleep(1500);
  await h.router.settled();
  check(postsOf(childTxid) === childPosts, `the reorg broadcast nothing: no new post of the child reached the Arcade (${postsOf(childTxid)} vs ${childPosts})`);
  const chainResults = async () => {
    const v = openStoreFile(store, { readOnly: true });
    try { return await emittedEvents(v, (rec) => rec.event === "broadcast" ? rec : undefined); } finally { await v.close(); }
  };
  const broadcastsBefore = (await chainResults()).length;
  const h5x = mine(sha256d(fork.at(-1)!), internal(childTxid), 1_790_302_000);
  await h.router.chainHeaders("ch", "chain", [h5x]);
  await h.router.settled();
  arcade.emit(childTxid, { txStatus: "MINED", blockHash: display(sha256d(h5x)), blockHeight: 5, merklePath: new MerklePath(5, [[{ offset: 0, hash: childTxid, txid: true }]]).toHex() });
  check(await factsAre(childTxid, "pending,seen,seen,mined@2,seen(reorged),mined@5", "mined again after the reorg"), `reorged, then the new proof by the status feed (a new blockHash, the same token's stream): the fact mined at 5 (${await statuses(childTxid)})`);
  check((await chainResults()).length === broadcastsBefore && postsOf(childTxid) === childPosts, "still no broadcast of it: the proof came without a resubmit");
} catch (e) {
  check(false, `threw: ${(e as Error).stack}`);
} finally {
  const [removeHome, ...rest] = afters;
  for (const f of rest.reverse()) await f();
  await arcade.close();
  for (const s of [store, ...bootStores]) {
    if (!s) continue;
    const rp = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), s], { encoding: "utf8" });
    process.stdout.write(rp.stdout);
    if (rp.status !== 0) process.stdout.write(rp.stderr);
    check(rp.status === 0 && /identical .*the source store reproduced exactly/.test(rp.stdout), `${s === store ? "the installed" : "the booted"} instance's store replays to itself exactly`);
  }
  if (!process.env.KEEP) await removeHome?.();
}
process.stdout.write(failures ? `chain (${BACKEND}): ${failures} FAILED\n` : `chain (${BACKEND}): all ok\n`);
process.exit(failures ? 1 : 0);

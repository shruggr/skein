// AUDIT (door-audit branch, not for merge): does kernel.beef admit an UNANCHORED BEEF?
// An Atomic BEEF with NO BUMP whose subject's parent is neither in the BEEF nor held, through
// (1) an event route, (2) an http route, (3) a mailbox route — each naming kernel.beef — on an
// instance whose chain/state holds block 170's header. Controls: no chain state; a bad BUMP.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/door-audit.ts

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import * as dagJson from "@ipld/dag-json";
import type { CID } from "multiformats/cid";
import { signMessage } from "../../src/client/raw.ts";
import { appendRequest, cidOf, httpRecord } from "../../src/host/frontdoor.ts";
import { admit2, writeGenesis } from "../../src/host/genesis.ts";
import { DoorAnswered, Kernel } from "../../src/host/kernel.ts";
import { beef170, chainState170, TX_170 } from "../../src/host/testbeef.ts";
import { BITCOIN_TX, hashCid } from "../../src/runtime/bitcoin.ts";
import { rawCid } from "../../src/runtime/programs.ts";
import { ephemeralWallet } from "../../src/wallet.ts";
import { specFor } from "./backend.ts";

const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
const home = mkdtempSync(join(tmpdir(), "skein-door-audit-"));
const handle = "dooraudit";
const key = new PrivateKey("e7e7", 16), identity = key.toPublicKey().toString();
const ownerKey = new PrivateKey("0e0e", 16), owner = ownerKey.toPublicKey().toString();
const out = (l: string) => process.stdout.write(l + "\n");
const sha256d = (b: Uint8Array) => Uint8Array.from(createHash("sha256").update(createHash("sha256").update(b).digest()).digest());
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** TX_170 with its last byte of locktime changed: a distinct, well-formed tx; its parent (0437cd7f…:0) is in no BEEF and not held. */
function variant(n: number): Uint8Array { const t = Uint8Array.from(TX_170); t[t.length - 1] = n; return t; }
/** Atomic BEEF (BRC-95) over BEEF V1: zero BUMPs, one raw transaction, no BUMP marker. */
function atomicNoBump(raw: Uint8Array): Uint8Array {
  return Uint8Array.from([1, 1, 1, 1, ...sha256d(raw), 1, 0, 0xbe, 0xef, 0, 1, ...raw, 0]);
}
const txCid = (raw: Uint8Array) => hashCid(BITCOIN_TX, sha256d(raw));

const spec = specFor(home, handle);
mkdirSync(dirname(spec), { recursive: true });
const k = new Kernel({ db: spec, handle, domain: "localhost", wallet: ephemeralWallet(key), command: kernel, env: { SKEIN_HOME: home }, log: (l) => { if (/door/.test(l)) out(`  | kernel: ${l}`); } });
const tip = async () => (await k.store.log.tip())?.toString();
let last: CID | undefined;
const tryAdmit = async (p: Promise<CID>): Promise<string> => {
  try { const c = await p; last = c; return `ADMITTED entry ${c}`; } catch (e) { return e instanceof DoorAnswered ? `REFUSED ${e.answer.status} ${e.answer.code} "${e.answer.reason}"` : `ERROR ${(e as Error).message}`; }
};
const showEntry = async (_c: string) => {
  const e = await k.store.get(last!) as Record<string, unknown>;
  out(`  entry   ${dagJson.stringify({ ...e, prev: "…" })}`);
  return e;
};
const showPointer = async (env: { beef?: CID } | undefined) => {
  if (!env?.beef) { out("  (no envelope)"); return; }
  out(`  envelope ${dagJson.stringify(env)}`);
  out(`  pointer  ${dagJson.stringify(await k.store.get(env.beef))}`);
};

try {
  const probeWasm = readFileSync(join(here, "../test/call/probe.wasm"));
  const pm = rawCid(probeWasm);
  await k.putBlock(pm, probeWasm);
  const probe = (await k.store.put({ kind: "program", name: "probe", code: { wasm: pm }, inputs: {}, services: [], description: "the call probe" } as never) as CID).toString();
  await writeGenesis(k, {
    identity, root: [owner], handle, domain: "localhost",
    dispatch: [
      { transport: "event", address: "deploy", filters: ["kernel.beef"], program: probe },
      { transport: "http", address: "/submit", filters: ["kernel.beef"], program: probe },
      { transport: "mailbox", address: "admin", filters: ["kernel.beef"], program: probe },
    ],
    scopes: { probe: ["probe"] },
  });
  await k.start();
  await k.idle();

  const A = variant(0x01), B = variant(0x02), C = variant(0x03), Z = variant(0x09);
  out(`unproven txs (no BUMP, parent 0437cd7f…:0 absent): A ${hex(sha256d(A))} B ${hex(sha256d(B))} C ${hex(sha256d(C))}`);

  out("\n[control 0] event route, NO chain/state, unproven Atomic BEEF:");
  const z = { kind: "deploy", beef: atomicNoBump(Z) };
  const t0 = await tip();
  out(`  door: ${await tryAdmit(admit2(k, { box: "deploy", event: cidOf(z) } as never, { event: z }))}`);
  out(`  log tip moved: ${await tip() !== t0}; tx block stored: ${await k.hasBlock(txCid(Z))}`);

  const cs = chainState170();
  const admin = async (box: string, body: unknown) => {
    const m = await signMessage(ephemeralWallet(ownerKey), { recipient: identity, box, body: dagCbor.encode(body) });
    const c = await appendRequest(k, "local", { kind: "message", ...m });
    await k.idle();
    return c;
  };
  await admin("objects", { records: cs.blocks.map((b) => ({ cid: b.cid, bytes: b.bytes })) });
  await admin("head", { name: "chain/state", tree: cs.state });
  out(`\nchain/state set (block 170 header only): ${((await k.call("head", "chain/state")) as CID | null)?.toString()}`);

  out("\n[1] event route `deploy` [kernel.beef], record {kind:deploy, beef: Atomic BEEF A, no BUMP}:");
  const ev = { kind: "deploy", beef: atomicNoBump(A) };
  let t = await tip();
  let r = await tryAdmit(admit2(k, { box: "deploy", event: cidOf(ev) } as never, { event: ev }));
  out(`  door: ${r}`);
  await k.idle();
  out(`  log tip moved: ${await tip() !== t}; tx A stored as bitcoin-tx block: ${await k.hasBlock(txCid(A))}`);
  if (r.startsWith("ADMITTED")) {
    const e = await showEntry(r.split(" ")[2]!);
    const rec = await k.store.get(e.event as CID) as { beef?: { beef?: CID } };
    out(`  record  ${dagJson.stringify(rec)}`);
    await showPointer(rec.beef);
    out(`  handler stepped on it (head probe = the record): ${((await k.call("head", "probe")) as CID | null)?.equals(e.event as CID) === true}`);
  }

  out("\n[2] http route POST /submit [kernel.beef], unsigned, body = Atomic BEEF B, no BUMP:");
  t = await tip();
  const req = httpRecord({ method: "POST", path: "/submit", query: "", headers: { "content-type": "application/octet-stream" }, body: atomicNoBump(B) } as never);
  r = await tryAdmit(appendRequest(k, "http", req));
  out(`  door: ${r}`);
  await k.idle();
  out(`  log tip moved: ${await tip() !== t}; tx B stored as bitcoin-tx block: ${await k.hasBlock(txCid(B))}`);
  if (r.startsWith("ADMITTED")) {
    const e = await showEntry(r.split(" ")[2]!);
    const rec = await k.store.get(e.request as CID) as { body?: { beef?: CID } };
    out(`  request.body ${dagJson.stringify(rec.body)}`);
    await showPointer(rec.body);
  }

  out("\n[3] mailbox route `admin` [kernel.beef], root-signed message body {fn:enable, beef: Atomic BEEF C, no BUMP}:");
  t = await tip();
  r = await tryAdmit(admin("admin", { fn: "enable", args: { beef: atomicNoBump(C) } }));
  out(`  door: ${r}`);
  out(`  log tip moved: ${await tip() !== t}; tx C stored as bitcoin-tx block: ${await k.hasBlock(txCid(C))}`);
  if (r.startsWith("ADMITTED")) await showEntry(r.split(" ")[2]!);

  out("\n[control 4] event route, BEEF V1 with a BUMP that does not check:");
  const bad = { kind: "deploy", beef: beef170({ bad: true }) };
  t = await tip();
  out(`  door: ${await tryAdmit(admit2(k, { box: "deploy", event: cidOf(bad) } as never, { event: bad }))}`);
  out(`  log tip moved: ${await tip() !== t}`);
} catch (err) {
  out(`SCENARIO ERROR ${(err as Error).stack}`);
} finally {
  await k.stop();
}
rmSync(home, { recursive: true, force: true });

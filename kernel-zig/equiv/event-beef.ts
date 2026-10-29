// The BEEF intake on an event route (#121, #164): a genesis whose event route `deploy` names
// kernel.beef (the probe its handler, kernel-zig/test/call/probe.zig: a "deploy" event's step moves
// the head `probe` to the record it read) and whose route `plain` names no filter. Before any chain
// state: a deploy event refused at the door ("no chain state"), nothing written. Root's `head`
// message sets chain/state (block 170's header, src/host/testbeef.ts); then {kind: "deploy", beef}
// with the record sent beside the entry: admitted, the entry naming the record as the door handed it
// back — the envelope where the bytes were, its pointer record and the `bitcoin-tx` block held, the
// record as received never stored, the step reading the envelope; a BUMP that does not check and a record with no BEEF refused (DoorAnswered), nothing
// written; the same event in `plain`: admitted as it is, the bytes in its record. Replayed. On
// SQLite (serve) and, with SKEIN_EQUIV_STORE=rocksdb, on RocksDB (the one-process kernel).
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/event-beef.ts

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import * as dagJson from "@ipld/dag-json";
import type { CID } from "multiformats/cid";
import { signMessage } from "../../src/client/raw.ts";
import { appendRequest, cidOf } from "../../src/host/frontdoor.ts";
import { writeGenesis } from "../../src/host/genesis.ts";
import { DoorAnswered, Kernel, KernelHost } from "../../src/host/kernel.ts";
import { beef170, chainState170, TX_170_CID } from "../../src/host/testbeef.ts";
import { rawCid } from "../../src/runtime/programs.ts";
import { ephemeralWallet } from "../../src/wallet.ts";
import { BACKEND, ROCKS_MODE, specFor } from "./backend.ts";

const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
const home = mkdtempSync(join(tmpdir(), "skein-kz-evbeef-"));
const handle = "evbeef";
const key = new PrivateKey("e7e7", 16), identity = key.toPublicKey().toString();
const ownerKey = new PrivateKey("0e0e", 16), owner = ownerKey.toPublicKey().toString();

let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };
const log = (l: string) => { if (process.env.VERBOSE) process.stdout.write(`  | [${handle}] ${l}\n`); };

const spec = specFor(home, handle);
let host: KernelHost | undefined;
let k: Kernel;
if (ROCKS_MODE) {
  host = KernelHost.acquire(join(home, "store-rocksdb"), { command: kernel, env: { SKEIN_HOME: home }, log });
  k = await host.open({ db: spec, handle, domain: "localhost", wallet: ephemeralWallet(key), log }) as unknown as Kernel;
} else {
  mkdirSync(dirname(spec), { recursive: true });
  k = new Kernel({ db: spec, handle, domain: "localhost", wallet: ephemeralWallet(key), command: kernel, env: { SKEIN_HOME: home }, log });
}

const tip = async () => (await k.store.log.tip())?.toString();
const refused = async (p: Promise<unknown>, re: RegExp): Promise<string> => {
  try { await p; return "admitted"; } catch (e) { return e instanceof DoorAnswered && re.test(e.answer.reason ?? "") ? "ok" : `${(e as Error).message}`; }
};
type Envelope = { form?: string; beef?: CID; subject?: CID };

try {
  const probeWasm = readFileSync(join(here, "../test/call/probe.wasm"));
  const pm = rawCid(probeWasm);
  await k.putBlock(pm, probeWasm);
  const probe = await k.store.put({ kind: "program", name: "probe", code: { wasm: pm }, inputs: {}, services: [], description: "the call probe" } as never) as CID;
  await writeGenesis(k, {
    identity, root: [owner], handle, domain: "localhost",
    dispatch: [
      { transport: "event", address: "deploy", filters: ["kernel.beef"], program: probe.toString() },
      { transport: "event", address: "plain", program: probe.toString() },
    ],
    scopes: { probe: ["probe"] },
  });
  await k.start();
  await k.idle();
  const rows = (await k.dispatch()).rows;
  check(rows.some((r) => r.transport === "event" && r.address === "deploy" && JSON.stringify(r.filters) === '["kernel.beef"]'), "the genesis's event route names kernel.beef (dispatch.zig: an event route may)");

  const good = { kind: "deploy", beef: beef170() };
  // No chain state yet: refused at the door, nothing written.
  const t0 = await tip();
  check(await refused(k.admit({ box: "deploy", event: cidOf(good) } as never, { event: good }), /no chain state/) === "ok", "before any chain state: refused at the door (no chain state)");
  check(await tip() === t0, "nothing written");

  // Root's messages: the chain state's blocks (`objects`), then the head chain/state.
  const cs = chainState170();
  const admin = async (box: string, body: unknown) => {
    const m = await signMessage(ephemeralWallet(ownerKey), { recipient: identity, box, body: dagCbor.encode(body) });
    await appendRequest(k, "local", { kind: "message", ...m });
    await k.idle();
  };
  await admin("objects", { records: cs.blocks.map((b) => ({ cid: b.cid, bytes: b.bytes })) });
  await admin("head", { name: "chain/state", tree: cs.state });
  check(((await k.call("head", "chain/state")) as CID | null)?.equals(cs.state) === true, "root's head message set chain/state (block 170's header)");

  // A good BEEF, the record beside the entry: admitted, the record rewritten.
  const entry = await k.admit({ box: "deploy", event: cidOf(good) } as never, { event: good });
  await k.idle();
  const e = await k.store.get(entry) as Record<string, unknown> & { event: CID; box: string };
  const rec = await k.store.get(e.event) as { kind?: string; beef?: Envelope };
  process.stdout.write(`  entry  ${dagJson.stringify({ ...e, prev: "…" })}\n  record ${dagJson.stringify(rec)}\n`);
  check(!e.event.equals(cidOf(good)), "the entry names the record as the door handed it back, not the one received");
  check(e.box === "deploy" && e.door === undefined && e.request === undefined, `an event entry's shape: {kind, prev, n, time, event, box} (keys: ${Object.keys(e).sort().join(", ")})`);
  check(rec.kind === "deploy" && rec.beef?.form === "beef" && !!rec.beef.beef && !(rec.beef as unknown instanceof Uint8Array), `the record carries the envelope where the bytes were (${JSON.stringify(Object.keys(rec.beef ?? {}))})`);
  const ptr = rec.beef?.beef ? await k.store.get(rec.beef.beef) as { kind?: string; txs?: CID[]; bumps?: Array<{ block?: CID | null }> } : undefined;
  check(ptr?.kind === "beef" && ptr.txs?.length === 1 && ptr.txs[0]!.equals(TX_170_CID) && !!ptr.bumps?.[0]?.block, "its pointer record: the transaction, the BUMP checked against block 170's header");
  check(await k.hasBlock(TX_170_CID), "the transaction held as its bitcoin-tx block");
  check(!(await k.hasBlock(cidOf(good))), "the record as received (the BEEF's bytes) is never stored");
  check(((await k.call("head", "probe")) as CID | null)?.equals(e.event) === true, "the route's program stepped on the event: it read the envelope (head probe → the record it read)");

  // A BUMP that does not check; a record with no BEEF: refused, nothing written.
  const t1 = await tip();
  const bad = { kind: "deploy", beef: beef170({ bad: true }) };
  check(await refused(k.admit({ box: "deploy", event: cidOf(bad) } as never, { event: bad }), /merkle root/) === "ok", "a BUMP whose root is not the header's: refused (DoorAnswered, the door's reason)");
  const none = { kind: "deploy", note: "no BEEF here" };
  check(await refused(k.admit({ box: "deploy", event: cidOf(none) } as never, { event: none }), /nothing to validate/) === "ok", "a record with no BEEF: refused (nothing to validate: an event has no principal)");
  check(await tip() === t1, "nothing written for either");
  check(!(await k.hasBlock(cidOf(bad))) && !(await k.hasBlock(cidOf(none))), "neither record stored");

  // The same event into a box whose route names no filter: admitted as it is (the bytes in its record).
  await k.idle();
  const entry3 = await k.admit({ box: "plain", event: cidOf(good) } as never, { event: good });
  await k.idle();
  const e3 = await k.store.get(entry3) as { event: CID };
  const rec3 = await k.store.get(e3.event) as { beef?: unknown };
  check(e3.event.equals(cidOf(good)) && rec3.beef instanceof Uint8Array, "no filter on the route: the record as received, the BEEF's bytes in it (as today)");
  check(((await k.call("head", "probe")) as CID | null)?.equals(e3.event) === true, "its step read the record as is");
} catch (err) {
  check(false, `the scenario ran: ${(err as Error).stack}`);
} finally {
  await k.stop();
  await host?.release();
}

const r = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), spec], { encoding: "utf8", env: { ...process.env, SKEIN_KERNEL_BIN: kernel } });
process.stdout.write(r.stdout);
if (r.status !== 0) process.stdout.write(r.stderr);
check(r.status === 0, `the store replays to itself exactly (${BACKEND})`);

rmSync(home, { recursive: true, force: true });
process.stdout.write(failures ? `event-beef (${BACKEND}): ${failures} FAILED\n` : `event-beef (${BACKEND}): all ok\n`);
process.exit(failures ? 1 : 0);

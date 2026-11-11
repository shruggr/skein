// An event's place identifies exactly one event: one router, one instance `ep`, two apps from
// programs/test/perm-probe's module (`pa`, `pb`). In ONE step pa emits facts, calls pb in-VM (pb
// emits facts in pa's step), emits more — and, in a second case, rests its thread on its own first
// fact, so that delivering that fact steps the same thread again before the step's later facts
// are handed over:
//
//   - every fact of the step reaches a live stream (GET /@ep/events/ as text/event-stream), each
//     with a place of its own, the same places the index holds (GET /@ep/events/);
//   - a stream opened with Last-Event-ID at one of them resumes right after it: the later ones,
//     no earlier, no repeat;
//   - the store replays to itself exactly.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/event-place.ts

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { RawBox } from "../../src/client/raw.ts";
import { ownerCli } from "../../src/testapps.ts";
import { HostDb } from "../../src/host/instances.ts";
import { Signer } from "../../src/host/signer.ts";
import { Router } from "../../src/host/router.ts";
import { openStoreFile } from "../../src/host/stores.ts";
import type { IndexStore } from "../../src/runtime/index-store.ts";
import { ephemeralWallet } from "../../src/wallet.ts";
import { BACKEND, routerStore, specFor, storeFor } from "./backend.ts";

const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
const home = mkdtempSync(join(tmpdir(), "skein-kz-place-"));
let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const wasm = join(here, "../../programs/test/perm-probe/bin/perm-probe.wasm");
function appTree(name: string): string {
  const at = join(home, "apps", name);
  mkdirSync(join(at, "bin"), { recursive: true });
  mkdirSync(join(at, "etc"), { recursive: true });
  copyFileSync(wasm, join(at, "bin/perm-probe.wasm"));
  writeFileSync(join(at, "etc/app.json"), JSON.stringify({
    kind: "app", name, version: "0.1.0", programs: { probe: "bin/perm-probe.wasm" }, provides: [], requires: [],
    routes: [{ address: "", handler: "probe" }], description: `the event-place test app ${name}`,
  }, null, 2));
  return at;
}

const ownerKey = new PrivateKey("5555", 16);
const owner = ownerKey.toPublicKey().toString();
const ownerWallet = ephemeralWallet(ownerKey);
const signer = new Signer(new PrivateKey("a1a2a3", 16));
const handle = "ep";
const hdb = new HostDb(join(home, "host.db"));
hdb.add(handle, { store: storeFor(home, handle) });
const r = new Router({
  db: hdb, home, owner, idleMs: 0, walletFor: (row: { handle: string }) => signer.wallet(row.handle),
  providerKeyFor: (n: string) => signer.providerKey(n), peerKeyFor: (x: string) => signer.peerKey(x), answerWaitMs: 6000,
  kernel: { command: kernel, env: { SKEIN_HOME: home } }, ...routerStore(home),
  log: (s: string, l: string) => { if (process.env.VERBOSE) process.stdout.write(`  | [${s}] ${l}\n`); },
});

type Ev = { id: string; event: string };
/** An open text/event-stream on `path`: the events it has delivered so far. */
async function stream(base: string, path: string, last?: string): Promise<{ got: Ev[]; close(): void }> {
  const ctl = new AbortController();
  const res = await fetch(`${base}/events/${path}`, { headers: { accept: "text/event-stream", ...(last ? { "last-event-id": last } : {}) }, signal: ctl.signal });
  if (res.status !== 200) throw new Error(`stream /events/${path}: ${res.status}`);
  const got: Ev[] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let k: number;
        while ((k = buf.indexOf("\n\n")) >= 0) {
          const msg = buf.slice(0, k);
          buf = buf.slice(k + 2);
          const id = /^id: (.*)$/m.exec(msg)?.[1];
          const event = /^event: (.*)$/m.exec(msg)?.[1];
          if (id && event) got.push({ id, event });
        }
      }
    } catch { /* closed */ }
  })();
  return { got, close: () => ctl.abort() };
}

try {
  await r.listen(0);
  const identity = (await r.hydrate(handle)).identity;
  const base = `http://127.0.0.1:${r.port}/@${handle}`;
  for (const app of ["pa", "pb"]) {
    const o = await ownerCli({ home, port: r.port!, owner: ownerWallet, settled: () => r.settled() }, ["install", appTree(app), "--instance", handle]);
    await r.settled();
    check(o.code === 0, `skein install ${app}: exit ${o.code} ${o.err.join(" ")}`);
  }
  const spec = specFor(home, handle);
  const withStore = async <T>(f: (st: IndexStore) => Promise<T>): Promise<T> => {
    const st = openStoreFile(spec, { readOnly: true }) as unknown as IndexStore;
    try { return await f(st); } finally { st.close(); }
  };
  const pb = await withStore(async (st) => {
    const root = st.heads().find((x) => x.name === "pb/app")!.root;
    return ((dagCbor.decode(await st.bytes(root)) as { programs: Record<string, CID> }).programs).probe!;
  });
  const indexed = async (prefix: string): Promise<Ev[]> => {
    const res = await fetch(`${base}/events/${prefix}`);
    return (await res.json() as Array<{ id: string; event: string }>).map((x) => ({ id: x.id, event: x.event }));
  };
  const box = new RawBox(ownerWallet, base);

  for (const [k, rest] of [["one", undefined], ["two", "pa/two/b1"]] as const) {
    const names = { before: [`pa/${k}/b1`, `pa/${k}/b2`], call: [`pb/${k}/c1`, `pb/${k}/c2`], after: [`pa/${k}/a1`] };
    const want = [...names.before, ...names.call, ...names.after];
    const live = await stream(base, "");
    await sleep(200);
    await box.send(identity, "pa", { kind: "probe", op: "facts", before: names.before, call: { prog: pb, names: names.call }, after: names.after, ...(rest ? { rest } : {}) });
    await r.settled();
    await sleep(500);
    live.close();
    const mine = live.got.filter((e) => e.event.includes(`/${k}/`));
    const ix = (await indexed("")).filter((e) => e.event.includes(`/${k}/`));
    const what = rest ? "the caller rests on its own first fact (delivered: the same thread stepped again before the rest are handed over)" : "caller and in-VM callee both emit";
    check(JSON.stringify(ix.map((e) => e.event)) === JSON.stringify(want), `${k}: the index holds the step's ${want.length} facts in emit order (${ix.map((e) => e.event).join(", ")})`);
    check(new Set(ix.map((e) => e.id)).size === ix.length, `${k}: each at a place of its own in the index (${ix.map((e) => e.id.split(".").slice(0, 2).join(".")).join(" ")})`);
    check(JSON.stringify(mine.map((e) => `${e.event} ${e.id}`)) === JSON.stringify(ix.map((e) => `${e.event} ${e.id}`)), `${k}: ${what}: the live stream delivers every fact, at the index's places (live: ${mine.map((e) => `${e.event}@${e.id.split(".").slice(0, 2).join(".")}`).join(", ")})`);
    // Resume right after the second fact.
    const resumed = await stream(base, "", ix[1]!.id);
    await sleep(500);
    resumed.close();
    const after = resumed.got.filter((e) => e.event.includes(`/${k}/`));
    check(JSON.stringify(after.map((e) => e.id)) === JSON.stringify(ix.slice(2).map((e) => e.id)), `${k}: Last-Event-ID at the second fact resumes with the ${ix.length - 2} after it, no repeat (${after.map((e) => e.event).join(", ")})`);
  }
} catch (e) {
  check(false, `threw: ${(e as Error).stack}`);
} finally {
  await r.stop();
  hdb.close();
  const rp = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), specFor(home, handle)], { encoding: "utf8", env: { ...process.env, SKEIN_KERNEL_BIN: kernel } });
  process.stdout.write(rp.stdout);
  if (rp.status !== 0) process.stdout.write(rp.stderr);
  check(rp.status === 0 && /identical .*the source store reproduced exactly/.test(rp.stdout), `the store replays to itself exactly (${BACKEND})`);
}

if (process.env.KEEP) process.stdout.write(`kept ${home}\n`); else rmSync(home, { recursive: true, force: true });
process.stdout.write(failures ? `event-place (${BACKEND}): ${failures} FAILED\n` : `event-place (${BACKEND}): all ok\n`);
process.exit(failures ? 1 : 0);

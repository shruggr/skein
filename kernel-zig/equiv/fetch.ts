// wasi:http end to end (issue #15): the `fetch` component (programs/fetch,
// Zig, a WASI 0.2 component that imports standard wasi:http) as the handler
// of a box, run by the Zig kernel the router drives. The owner sends
// {url}; the component GETs it over wasi:http/outgoing-handler; the kernel
// serializes the request into the recorded-call shape and the router's http
// handler (a stand-in for the network) answers it; the body comes back on
// the step's stdout. The step's update records the call — request and
// response — and a replay of the store (equiv/replays.ts: no router, no
// http handler) reproduces it exactly from that record, so the handler is
// never asked again: replay never touches the network.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/fetch.ts
//
// Needs the component: kernel-zig/test/components/fetch.wasm (committed), or
// $SKEIN_FETCH_COMPONENT.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { RawBox } from "../../src/client/raw.ts";
import { HostDb } from "../../src/host/instances.ts";
import type { HttpRequest, HttpResponse } from "../../src/host/kernel.ts";
import { Router } from "../../src/host/router.ts";
import { encode } from "../../src/runtime/cid.ts";
import { openStoreFile } from "../../src/runtime/index-store.ts";
import { rawCid } from "../../src/runtime/programs.ts";
import { program } from "../../src/runtime/records.ts";
import { collect } from "../../src/testkit.ts";
import { ephemeralWallet } from "../../src/wallet.ts";

const here = dirname(fileURLToPath(import.meta.url));
const component = process.env.SKEIN_FETCH_COMPONENT ?? join(here, "../test/components/fetch.wasm");
process.env.SKEIN_EXTRA_MODULES = component; // the kernel the router spawns installs it (not pinned)
const FETCH = program({
  name: "fetch",
  code: { wasm: rawCid(readFileSync(component)) },
  inputs: { envelope: "cid", body: "cid", box: "string", sender: "identity" },
  services: ["http"],
  description: "The `fetch` box: GET the body's {url} over wasi:http, the response body on stdout.",
});
const FETCH_CID = encode(FETCH).cid;
const kernel = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
const home = mkdtempSync(join(tmpdir(), "skein-kz-fetch-"));
const db = join(home, "instances/fetchtest/runtime.db");
const ownerKey = new PrivateKey("2222", 16);
const owner = ephemeralWallet(ownerKey);
const ownerId = ownerKey.toPublicKey().toString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };

// ---------------------------------------------------------------- the "network"

const asked: HttpRequest[] = [];
async function network(r: HttpRequest): Promise<HttpResponse> {
  asked.push(r);
  if (r.url === "https://files.test/hello.txt") return { status: 200, headers: { "content-type": "text/plain" }, body: new TextEncoder().encode("hello from the network\n") };
  return { status: 404, headers: {}, body: new TextEncoder().encode("not here\n") };
}

const hostDb = new HostDb(join(home, "host.db"));
hostDb.add("fetchtest", { store: db });
const router = new Router({
  db: hostDb, walletFor: () => ephemeralWallet(new PrivateKey("1111", 16)), home,
  owner: ownerId, idleMs: 0, http: network, kernel: { command: kernel, env: { SKEIN_HOME: home } },
  genesis: { subscriptions: [{ box: "fetch", sender: ownerId, handler: FETCH_CID }] },
  log: (s, l) => { if (process.env.VERBOSE) process.stdout.write(`  | [${s}] ${l}\n`); },
});
await router.listen(0);
const box = new RawBox(owner, `http://127.0.0.1:${router.port}/@fetchtest`);

type Update = { state: string; step: number; calls?: CID[]; result?: { stdout: Uint8Array; stderr: Uint8Array }; error?: { message: string } };
let view!: ReturnType<typeof openStoreFile>;
const seen = new Set<string>();

async function nextStep(what: string, ms = 30_000): Promise<Update> {
  const t0 = Date.now();
  for (;;) {
    for (const t of await collect(view.edges.query({ kind: "thread", program: FETCH_CID }))) {
      for (const u of (await collect(view.chains.history(t))).slice(1)) {
        const up = await view.get(u) as Update;
        const k = `${t}/${up.step}`;
        if (seen.has(k) || up.state === "running") continue;
        seen.add(k);
        return up;
      }
    }
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

async function fetchVia(identity: string, url: string): Promise<Update> {
  await box.send(identity, "fetch", { url });
  return nextStep(url);
}

const text = (b?: Uint8Array) => Buffer.from(b ?? []).toString();

try {
  const { kernel: k, identity } = await router.hydrate("fetchtest");
  await k.store.put(FETCH as never);
  view = openStoreFile(db, { readOnly: true });

  const ok = await fetchVia(identity, "https://files.test/hello.txt");
  check(ok.state === "finished" && text(ok.result?.stdout) === "hello from the network\n", `a GET over wasi:http: the body on stdout (${ok.state}, ${JSON.stringify(text(ok.result?.stdout))})`);
  check(asked.length === 1 && asked[0].method === "GET" && asked[0].url === "https://files.test/hello.txt" && asked[0].body === undefined, `the host was asked once, in the recorded-call shape (${JSON.stringify(asked[0])})`);
  const calls = ok.calls ?? [];
  const rec = calls.length === 1 ? await view.get(calls[0]) as { op: string; request: Uint8Array; result: Uint8Array } : undefined;
  const req = rec ? dagCbor.decode(rec.request) as HttpRequest : undefined;
  const res = rec ? dagCbor.decode(rec.result) as HttpResponse : undefined;
  check(rec?.op === "http" && req?.method === "GET" && req.url === "https://files.test/hello.txt" && res?.status === 200 && text(res.body) === "hello from the network\n",
    `the update records the call: request and response (op ${rec?.op}, ${req?.method} ${req?.url} → ${res?.status})`);

  const nf = await fetchVia(identity, "https://files.test/missing");
  check(nf.state === "errored" && text(nf.result?.stdout) === "not here\n" && /HTTP 404/.test(text(nf.result?.stderr)), `a 404: the body comes back, fetch exits 1 (${nf.state}: ${text(nf.result?.stderr).trim()})`);
  check(asked.length === 2, `two steps, two requests (${asked.length})`);
} catch (e) {
  check(false, `the scenario ran: ${(e as Error).stack}`);
} finally {
  await router.stop();
}

// Replay without the router: the answers come from the recorded calls.
const before = asked.length;
const r = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), db], { encoding: "utf8" });
process.stdout.write(r.stdout);
if (r.status !== 0) process.stdout.write(r.stderr);
check(r.status === 0 && /identical .*the source store reproduced exactly/.test(r.stdout), "the store replays to itself exactly, twice over, with no host to ask: the http answers come from the recorded calls");
// (The replay's kernel has no router at all: an http call it could not find in the record would end the step "no wallet and no recorded answer".)
check(asked.length === before, `replay never touched the network (${asked.length - before} requests during replay)`);

rmSync(home, { recursive: true, force: true });
process.stdout.write(failures ? `fetch: ${failures} FAILED\n` : "fetch: all ok\n");
process.exit(failures ? 1 : 0);

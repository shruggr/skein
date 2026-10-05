// A component's emit end to end (issues #15, #70, #67): the `fetch`
// component (programs/test/fetch, Zig, a WASI 0.2 component, a test fixture) as
// the handler of a box, run by the Zig kernel the router drives. The owner
// sends {url}; the component emits {method: "GET", url} to the address
// book's `fetch` provider (the host's HTTP proxy, whose network here is a
// stand-in) and its step ends waiting; the provider's answer — a signed
// message, {replyTo, status, headers, body}, appended as a `local` request —
// steps the thread again, and the body comes back on that step's stdout.
// The first step's update lists the message it emitted; nothing of the
// network is recorded but the answer's entry. A replay of the store
// (equiv/replays.ts: no router, no provider) reproduces it exactly: replay
// never touches the network.
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
import type { CID } from "multiformats/cid";
import { RawBox } from "../../src/client/raw.ts";
import { HostDb } from "../../src/host/instances.ts";
import type { HttpRequest, HttpResponse } from "../../src/host/providers.ts";
import { Router } from "../../src/host/router.ts";
import { Signer } from "../../src/host/signer.ts";
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
  inputs: { message: "cid", body: "cid", box: "string", sender: "identity" },
  services: ["fetch"],
  description: "The `fetch` box: GET the body's {url} through the fetch provider, the response body on stdout.",
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
const providers = new Signer(new PrivateKey("a77e57", 16));
const router = new Router({
  db: hostDb, walletFor: () => ephemeralWallet(new PrivateKey("1111", 16)), home, providerKeyFor: (n) => providers.providerKey(n),
  owner: ownerId, idleMs: 0, http: network, kernel: { command: kernel, env: { SKEIN_HOME: home } },
  genesis: { subscriptions: [{ box: "fetch", sender: ownerId, handler: FETCH_CID }] },
  log: (s, l) => { if (process.env.VERBOSE) process.stdout.write(`  | [${s}] ${l}\n`); },
});
await router.listen(0);
const box = new RawBox(owner, `http://127.0.0.1:${router.port}/@fetchtest`);

type Update = { state: string; step: number; emitted?: CID[]; result?: { stdout: Uint8Array; stderr: Uint8Array }; error?: { message: string } };
let view!: ReturnType<typeof openStoreFile>;
const done = new Set<string>();

/** A fetch thread's updates once it has come to rest (finished or errored): the next one not seen. */
async function nextRun(what: string, ms = 30_000): Promise<Update[]> {
  const t0 = Date.now();
  for (;;) {
    for (const t of await collect(view.edges.query({ kind: "thread", program: FETCH_CID }))) {
      if (done.has(t.toString())) continue;
      const ups = await Promise.all((await collect(view.chains.history(t))).slice(1).map(async (u) => await view.get(u) as Update));
      const last = ups.at(-1);
      if (last && (last.state === "finished" || last.state === "errored")) {
        done.add(t.toString());
        return ups;
      }
    }
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

async function fetchVia(identity: string, url: string): Promise<Update[]> {
  await box.send(identity, "fetch", { url });
  return nextRun(url);
}

const text = (b?: Uint8Array) => Buffer.from(b ?? []).toString();

try {
  const { kernel: k, identity } = await router.hydrate("fetchtest");
  await k.store.put(FETCH as never);
  view = openStoreFile(db, { readOnly: true });

  const ok = await fetchVia(identity, "https://files.test/hello.txt");
  const [first, last] = [ok[0]!, ok.at(-1)!];
  check(ok.length === 2 && first.state === "waiting", `step 1 emits and waits (${ok.map((u) => u.state).join(" → ")})`);
  check(last.state === "finished" && text(last.result?.stdout) === "hello from the network\n", `step 2, on the provider's answer: the body on stdout (${last.state}, ${JSON.stringify(text(last.result?.stdout))})`);
  check(asked.length === 1 && asked[0]!.method === "GET" && asked[0]!.url === "https://files.test/hello.txt" && asked[0]!.body === undefined, `the provider asked its network once (${JSON.stringify(asked[0])})`);
  const sent = first.emitted?.length === 1 ? await view.get(first.emitted[0]!) as { kind: string; box: string; body: CID; signature?: Uint8Array } : undefined;
  const req = sent ? await view.get(sent.body) as { method?: string; url?: string } : undefined;
  check(sent?.kind === "mail" && sent.box === "fetch" && (sent.signature?.length ?? 0) > 60 && req?.method === "GET" && req.url === "https://files.test/hello.txt",
    `the update lists the signed message it emitted: GET in box fetch (${sent?.kind} ${sent?.box}, signature ${sent?.signature?.length}, ${req?.method} ${req?.url})`);

  const nf = await fetchVia(identity, "https://files.test/missing");
  const nl = nf.at(-1)!;
  check(nl.state === "errored" && text(nl.result?.stdout) === "not here\n" && /HTTP 404/.test(text(nl.result?.stderr)), `a 404: the body comes back, fetch exits 1 (${nl.state}: ${text(nl.result?.stderr).trim()})`);
  check(asked.length === 2, `two fetches, two requests (${asked.length})`);
} catch (e) {
  check(false, `the scenario ran: ${(e as Error).stack}`);
} finally {
  await router.stop();
}

// Replay without the router: the answers are entries in the log; nothing asks the network.
const before = asked.length;
const r = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), db], { encoding: "utf8" });
process.stdout.write(r.stdout);
if (r.status !== 0) process.stdout.write(r.stderr);
check(r.status === 0 && /identical .*the source store reproduced exactly/.test(r.stdout), "the store replays to itself exactly, twice over, with no host: the provider's answers are entries");
check(asked.length === before, `replay never touched the network (${asked.length - before} requests during replay)`);

rmSync(home, { recursive: true, force: true });
process.stdout.write(failures ? `fetch: ${failures} FAILED\n` : "fetch: all ok\n");
process.exit(failures ? 1 : 0);

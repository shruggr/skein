// Host-signed recorded calls (#62). An http call through `serve` — the
// `fetch` component's GET over wasi:http, answered by the router's http
// handler — is recorded with the router's attestation: signed by its attest
// key over {op, instance, sha256(request), sha256(response), stamp}, the key
// named by the genesis. The attestation verifies from the store alone
// (checkAttestations, what `skein-dev log` prints) and the store replays to
// itself exactly (equiv/replays.ts). A tampered response — the record's bytes
// changed under the same CID — fails: the store reader reports it, and
// `skein-kernel replay` reports the step DIVERGED; so does a record whose
// attestation was stripped.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { RawBox } from "../client/raw.ts";
import { attestProblem, checkAttestations } from "../runtime/attest.ts";
import { encode } from "../runtime/cid.ts";
import { openStoreFile } from "../runtime/index-store.ts";
import { rawCid } from "../runtime/programs.ts";
import { program, type Attested } from "../runtime/records.ts";
import { collect } from "../testkit.ts";
import { ephemeralWallet } from "../wallet.ts";
import { HostDb } from "./instances.ts";
import { KERNEL_BIN, type HttpRequest, type HttpResponse } from "./kernel.ts";
import { Oracle } from "./oracle.ts";
import { Router } from "./router.ts";
import { until } from "./testhost.ts";
import { render } from "../dev/explore/server.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const COMPONENT = join(ROOT, "kernel-zig/test/components/fetch.wasm");
const FETCH = program({
  name: "fetch",
  code: { wasm: rawCid(readFileSync(COMPONENT)) },
  inputs: { envelope: "cid", body: "cid", box: "string", sender: "identity" },
  services: ["http"],
  description: "The `fetch` box: GET the body's {url} over wasi:http, the response body on stdout.",
});
const FETCH_CID = encode(FETCH).cid;

type Update = { state: string; calls?: CID[]; result?: { stdout: Uint8Array } };

/** A block as stored. */
function storedBytes(db: string, cid: CID): Uint8Array {
  const s = new DatabaseSync(db, { readOnly: true });
  try { return (s.prepare("SELECT bytes FROM blocks WHERE cid = ?").get(cid.bytes) as { bytes: Uint8Array }).bytes; } finally { s.close(); }
}

/** Replace one block's bytes under its CID (what a tampered store would hold). */
function rewrite(db: string, cid: CID, value: unknown): void {
  const s = new DatabaseSync(db);
  try { s.prepare("UPDATE blocks SET bytes = ? WHERE cid = ?").run(dagCbor.encode(value), cid.bytes); } finally { s.close(); }
}

/** `skein-kernel replay` of a copy of `db`: its log lines. */
async function replayLines(home: string, db: string, name: string): Promise<string[]> {
  const out = join(home, `${name}.replay.db`);
  const r = spawnSync(KERNEL_BIN, ["replay", db, out], { encoding: "utf8", env: { ...process.env, SKEIN_WASM_DIR: join(ROOT, "wasm") } });
  assert.equal(r.status, 0, `replay ${name}: ${r.stderr}`);
  return (JSON.parse(r.stdout) as { lines: string[] }).lines;
}

test("#62: an http call through serve is recorded with the router's attestation; it verifies, and a tampered response fails", { timeout: 120_000 }, async (t) => {
  const home = await fs.mkdtemp(join(tmpdir(), "skein-attest-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const db = join(home, "instances/fetchtest/runtime.db");
  const hostDb = new HostDb(join(home, "host.db"));
  hostDb.add("fetchtest", { store: db });
  const ownerKey = PrivateKey.fromRandom(), ownerId = ownerKey.toPublicKey().toString();
  const attestKey = new Oracle(PrivateKey.fromRandom()).attestKey();
  const asked: HttpRequest[] = [];
  const network = async (r: HttpRequest): Promise<HttpResponse> => {
    asked.push(r);
    return { status: 200, headers: { "content-type": "text/plain" }, body: new TextEncoder().encode("hello from the network\n") };
  };
  const router = new Router({
    db: hostDb, walletFor: () => ephemeralWallet(PrivateKey.fromRandom()), home, owner: ownerId, idleMs: 0, ledgerMs: 60_000,
    http: network, attestKey, kernel: { env: { SKEIN_HOME: home, SKEIN_EXTRA_MODULES: COMPONENT } },
    genesis: { subscriptions: [{ box: "fetch", sender: ownerId, handler: FETCH_CID }] },
  });
  let closed = false;
  t.after(async () => { if (!closed) await router.close(); hostDb.close(); });
  await router.listen(0);
  const { kernel, identity } = await router.hydrate("fetchtest");
  await kernel.store.put(FETCH as never);
  const genesis = await kernel.genesis() as { attest?: Uint8Array; handle?: string };
  assert.deepEqual(genesis.attest, Uint8Array.from(attestKey.toPublicKey().encode(true) as number[]), "the genesis names the router's attest key");

  await new RawBox(ephemeralWallet(ownerKey), `http://127.0.0.1:${router.port}/@fetchtest`).send(identity, "fetch", { url: "https://files.test/hello.txt" });
  const view = openStoreFile(db, { readOnly: true });
  const step = await until("the fetch step", async () => {
    for (const th of await collect(view.edges.query({ kind: "thread", program: FETCH_CID }))) {
      for (const u of (await collect(view.chains.history(th))).slice(1)) {
        const up = await view.get(u) as unknown as Update;
        if (up.state === "finished" || up.state === "errored") return up;
      }
    }
    return undefined;
  });
  assert.equal(step.state, "finished");
  assert.equal(Buffer.from(step.result!.stdout).toString(), "hello from the network\n");
  assert.equal(asked.length, 1);
  const callCid = step.calls![0]!;
  // The record as stored (the TS readers show keys and signatures as hex: index-store.ts display).
  const rec = dagCbor.decode(storedBytes(db, callCid)) as Attested;
  assert.equal(rec.op, "http");
  assert.ok(rec.attest, "the record carries the attestation");
  assert.deepEqual(rec.attest.key, genesis.attest);
  assert.equal(attestProblem(genesis, rec), undefined, "it verifies against the genesis key");
  const report = await checkAttestations(view);
  assert.equal(report.verified, 1);
  assert.deepEqual(report.bad, []);
  const thread = (await collect(view.edges.query({ kind: "thread", program: FETCH_CID })))[0]!;
  assert.match((await render(view, new URL(`/t/${thread}`, "http://x"))).body, /attested by the host at/, "the explorer shows the verified attestation");
  await view.close();
  await router.close();
  closed = true;

  // The store replays to itself exactly, attestations verified on the way (a bad one would be DIVERGED).
  const r = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(ROOT, "kernel-zig/equiv/replays.ts"), db], { encoding: "utf8", env: { ...process.env, SKEIN_KERNEL: KERNEL_BIN } });
  assert.equal(r.status, 0, `replays: ${r.stdout}\n${r.stderr}`);

  // A tampered response under the same CID: the reader and the replay both refuse it.
  const copy = async (name: string) => {
    const p = join(home, `${name}.db`);
    copyFileSync(db, p);
    if (existsSync(`${db}-wal`)) copyFileSync(`${db}-wal`, `${p}-wal`);
    return p;
  };
  const response = dagCbor.decode(rec.result) as HttpResponse;
  const forged = { ...rec, result: dagCbor.encode({ ...response, body: new TextEncoder().encode("forged\n") }) };
  assert.equal(attestProblem(genesis, forged), "the attestation does not verify");
  const tampered = await copy("tampered");
  rewrite(tampered, callCid, forged);
  const ts = openStoreFile(tampered, { readOnly: true });
  const bad = await checkAttestations(ts);
  const page = await render(ts, new URL(`/t/${thread}`, "http://x"));
  await ts.close();
  assert.match(page.body, /DIVERGED: the attestation does not verify/, "the explorer shows the divergence");
  const log = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(ROOT, "src/dev/cli.ts"), "log"], { encoding: "utf8", env: { ...process.env, SKEIN_DB: tampered } });
  assert.equal(log.status, 1, `skein-dev log exits 1 on a divergence: ${log.stdout}${log.stderr}`);
  assert.match(log.stdout, /DIVERGED .* call 0 \(http\) .*: the attestation does not verify/);
  assert.equal(bad.verified, 0);
  assert.equal(bad.bad.length, 1);
  assert.equal(bad.bad[0]!.why, "the attestation does not verify");
  const tl = await replayLines(home, tampered, "tampered");
  assert.ok(tl.some((l) => /DIVERGED.*\(http\): the attestation does not verify/.test(l)), `replay reports the divergence:\n${tl.join("\n")}`);

  // An attestation stripped from the record: refused, because the genesis names the key.
  const { attest: _, ...bare } = rec;
  const stripped = await copy("stripped");
  rewrite(stripped, callCid, bare);
  const sl = await replayLines(home, stripped, "stripped");
  assert.ok(sl.some((l) => /DIVERGED.*\(http\): no attestation/.test(l)), `replay refuses an unattested call:\n${sl.join("\n")}`);
});

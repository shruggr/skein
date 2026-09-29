// The front door (#40) at the kernel, no router: the stock AuthFetch shakes
// hands with the instance, its signed requests verify inside the VM and the
// answers verify at the client. Sessions are not state: the handshake writes
// nothing (no entry, no byte) — the session lives in the kernel process's
// in-memory table — and polls write nothing. A new kernel process (or a
// dropped table, or an expired session) is a 401, and the stock client shakes
// hands again by itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as dagCbor from "@ipld/dag-cbor";
import { AuthFetch, PrivateKey } from "@bsv/sdk";
import type { CID } from "multiformats/cid";
import { ephemeralWallet } from "../wallet.ts";
import { rawCid } from "./boot.ts";
import { frontDoorFetch, type FrontAnswer } from "./frontdoor.ts";
import { writeGenesis } from "./genesis.ts";
import { Kernel, KERNEL_BIN } from "./kernel.ts";

const PROBE = new URL("../../kernel-zig/test/call/probe.wasm", import.meta.url);

test("front door: the handshake writes nothing (the session is in memory); signed requests verify both ways; polls write nothing; a restart is a 401 the stock client recovers from", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  const home = await fs.mkdtemp(join(tmpdir(), "skein-front-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const key = PrivateKey.fromRandom(), clientKey = PrivateKey.fromRandom();
  const identity = key.toPublicKey().toString(), client = clientKey.toPublicKey().toString();
  const db = join(home, "runtime.db");
  const open = () => new Kernel({ db, handle: "alpha", domain: "localhost", wallet: ephemeralWallet(key), env: { SKEIN_HOME: home } });
  let k = open();
  t.after(() => k.stop());
  const wasm = readFileSync(PROBE);
  await k.putBlock(rawCid(wasm), wasm);
  const probe = await k.store.put({ kind: "program", name: "probe", code: { wasm: rawCid(wasm) }, inputs: {}, services: [], description: "the call probe" } as never) as CID;
  await writeGenesis(k, {
    identity, owner: client, handle: "alpha", domain: "localhost",
    routes: [{ path: "/whoami", program: probe.toString(), fn: "whoami" }, { path: "/open", program: probe.toString(), fn: "whoami", auth: "none" }],
  });
  await k.start();
  await k.idle();

  const entries = async () => (await k.store.get((await k.store.log.tip())!) as unknown as { n: number }).n;
  const size = () => statSync(db).size + (existsSync(`${db}-wal`) ? statSync(`${db}-wal`).size : 0);
  // The client's transport follows whichever kernel process is current; it counts the answers by status.
  const statuses: number[] = [];
  const door: typeof fetch = (input, init) => frontDoorFetch(k, { onAnswer: (a: FrontAnswer) => statuses.push(a.status) })(input, init);
  const af = new AuthFetch(ephemeralWallet(clientKey), undefined, undefined, undefined, {}, door);
  const whoami = async () => {
    const r = await af.fetch("http://alpha.test/whoami", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 200, await r.clone().text());
    return Buffer.from(await r.arrayBuffer()).toString("hex");
  };

  const n0 = await entries(), s0 = size();
  assert.equal(await whoami(), client, "the handler sees the authenticated caller; the client verified the signed answer");
  await k.idle();
  assert.equal(await entries(), n0, "the handshake writes no entry");
  assert.equal(size(), s0, "the handshake writes no byte");
  assert.equal(k.scratch.size, 1, "the session is in the kernel's in-memory table");
  const [nonce, rec] = [...k.scratch.entries()][0]!;
  const s = dagCbor.decode(rec) as { peer: Uint8Array; peerNonce: string; created: number };
  assert.equal(Buffer.from(s.peer).toString("hex"), client);
  assert.ok(nonce.length > 0 && s.peerNonce.length > 0 && s.created > 0);
  const boxes = await k.boxes();
  assert.ok(!boxes.includes(":sessions"), `no :sessions box (${boxes})`);
  assert.equal(await k.call("head", "sessions"), null, "no sessions head");

  // Unsigned: a plain 401 on an authenticated route; an open route answers without auth.
  assert.equal((await frontDoorFetch(k)("http://alpha.test/whoami", { method: "POST" })).status, 401);
  assert.equal((await frontDoorFetch(k)("http://alpha.test/open", { method: "POST" })).status, 200);
  assert.equal((await frontDoorFetch(k)("http://alpha.test/nowhere", { method: "POST" })).status, 404);

  // Polls: nothing is written.
  await k.idle();
  const n1 = await entries(), s1 = size();
  for (let i = 0; i < 200; i++) await whoami();
  assert.equal(await entries(), n1, "200 polls: no entry");
  assert.equal(size(), s1, "200 polls: no byte");
  assert.equal(k.scratch.size, 1, "polls add no session");

  // The table dropped: a 401, and the stock client shakes hands again by itself.
  k.scratch.clear();
  statuses.length = 0;
  assert.equal(await whoami(), client);
  assert.deepEqual(statuses, [401, 200, 200], "401, the handshake, the request again");
  assert.equal(k.scratch.size, 1);

  // Expiry is judged against the in-memory record's stamp (`sessionTtlMs`, a day).
  const [n2, r2] = [...k.scratch.entries()][0]!;
  k.scratch.set(n2, dagCbor.encode({ ...(dagCbor.decode(r2) as object), created: Date.now() - 86_400_001 }));
  statuses.length = 0;
  assert.equal(await whoami(), client);
  assert.deepEqual(statuses, [401, 200, 200], "an expired session: 401, the handshake, the request again");
  assert.equal(k.scratch.size, 1, "the handshake dropped the expired session");

  // A new kernel process: hydration starts with an empty table; the same client recovers by itself.
  await k.stop();
  k = open();
  await k.start();
  await k.idle();
  assert.equal(k.scratch.size, 0, "a new process starts with no sessions");
  const n3 = await entries(), s3 = size();
  statuses.length = 0;
  assert.equal(await whoami(), client);
  assert.deepEqual(statuses, [401, 200, 200], "after a restart: 401, the handshake, the request again");
  await k.idle();
  assert.equal(await entries(), n3, "the re-handshake writes no entry");
  assert.equal(size(), s3, "the re-handshake writes no byte");
});

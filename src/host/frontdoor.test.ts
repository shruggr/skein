// The front door (#40) at the kernel, no router: the stock AuthFetch shakes
// hands with the instance (one session record: the one auth write), its
// signed requests verify inside the VM and the answers verify at the client;
// polls write nothing — no entry, no byte.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthFetch, PrivateKey } from "@bsv/sdk";
import type { CID } from "multiformats/cid";
import { ephemeralWallet } from "../wallet.ts";
import { rawCid } from "./boot.ts";
import { frontDoorFetch } from "./frontdoor.ts";
import { writeGenesis } from "./genesis.ts";
import { Kernel, KERNEL_BIN } from "./kernel.ts";

const PROBE = new URL("../../kernel-zig/test/call/probe.wasm", import.meta.url);

test("front door: handshake = one session record; signed requests verify both ways; polls write nothing", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  const home = await fs.mkdtemp(join(tmpdir(), "skein-front-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const key = PrivateKey.fromRandom(), clientKey = PrivateKey.fromRandom();
  const identity = key.toPublicKey().toString(), client = clientKey.toPublicKey().toString();
  const db = join(home, "runtime.db");
  const k = new Kernel({ db, handle: "alpha", domain: "localhost", wallet: ephemeralWallet(key), env: { SKEIN_HOME: home } });
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
  const n0 = await entries();
  const af = new AuthFetch(ephemeralWallet(clientKey), undefined, undefined, undefined, {}, frontDoorFetch(k));

  const first = await af.fetch("http://alpha.test/whoami", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal(Buffer.from(await first.arrayBuffer()).toString("hex"), client, "the handler sees the authenticated caller; the client verified the signed answer");
  assert.equal(await entries(), n0 + 1, "the handshake is one entry");
  await k.idle();
  const sessions = await k.store.get(await k.call("head", "sessions") as CID) as unknown as { sessions: Array<{ session: CID }> };
  assert.equal(sessions.sessions.length, 1);
  const s = await k.store.get(sessions.sessions[0]!.session) as { kind: string; peer: Uint8Array };
  assert.equal(s.kind, "session");
  assert.equal(Buffer.from(s.peer).toString("hex"), client);

  // Unsigned: a plain 401 on an authenticated route; an open route answers without auth.
  assert.equal((await frontDoorFetch(k)("http://alpha.test/whoami", { method: "POST" })).status, 401);
  assert.equal((await frontDoorFetch(k)("http://alpha.test/open", { method: "POST" })).status, 200);
  assert.equal((await frontDoorFetch(k)("http://alpha.test/nowhere", { method: "POST" })).status, 404);

  // Polls: nothing is written.
  await k.idle();
  const n1 = await entries(), s1 = size();
  for (let i = 0; i < 200; i++) {
    const r = await af.fetch("http://alpha.test/whoami", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 200);
    await r.arrayBuffer();
  }
  assert.equal(await entries(), n1, "200 polls: no entry");
  assert.equal(size(), s1, "200 polls: no byte");
});

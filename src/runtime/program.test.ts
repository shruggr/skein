// The wallet wire import: a Go program (programs/wire-probe) calls the
// instance wallet through go-sdk's WalletWireTransceiver; each call is an
// attested record in its step, and replay with no wallet serves them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CID } from "multiformats/cid";
import { instance, send } from "../testkit.ts";
import { decode, encode } from "./cid.ts";
import { verifyAnyone } from "./identity.ts";
import { copyLog } from "./log.ts";
import { memoryStore } from "./memory.ts";
import { rawCid } from "./programs.ts";
import { program, type Attested } from "./records.ts";
import { Runtime, witnessFrom } from "./scheduler.ts";
import type { ThreadUpdate } from "./types.ts";

test("wallet wire: a Go program's getPublicKey and createSignature are attested records; replay with no wallet serves them", async () => {
  const bytes = await readFile(new URL("../../wasm/wire-probe.wasm", import.meta.url));
  const mod = rawCid(bytes);
  const probe = program({ name: "wire-probe", code: { wasm: mod }, inputs: {}, services: ["wallet"], description: "test" });
  const probeCid = encode(probe).cid;
  const i = await instance({ config: { subscriptions: [{ match: { box: "probe" }, handler: probeCid }] } });
  await i.store.putBlock(mod, bytes);
  await i.store.put(probe);
  await i.rt.stop();
  // The genesis above routed `probe`; restart so the runtime reads it with the program present.
  const j = await instance({ store: i.store, instanceKey: i.instanceKey, ownerKey: i.owner.key, hub: i.hub, clock: i.clock });
  await send(j, "probe", { hi: 1 });
  await j.edge.poll();
  await j.rt.idle();
  const [th] = await (async () => { const out: CID[] = []; for await (const t of j.store.edges.query({ kind: "thread", program: probeCid })) out.push(t); return out; })();
  const u = await j.store.get<ThreadUpdate & { calls: CID[] }>(await j.store.chains.tip(th));
  assert.equal(u.state, "finished", Buffer.from((u.result as { stderr: Uint8Array }).stderr).toString());
  const calls = await Promise.all(u.calls.map((c) => j.store.get<Attested>(c)));
  assert.deepEqual(calls.map((c) => [c.op, (c.request as Uint8Array)[0]]), [["wallet", 8], ["wallet", 15]], "getPublicKey then createSignature, as wire frames");
  const out = Buffer.from((u.result as { stdout: Uint8Array }).stdout).toString().trim();
  const rec = decode<{ kind: string; identityKey: string; signature: Uint8Array }>(await j.store.bytes(CID.decode(Buffer.from(out, "hex"))));
  assert.equal(rec.identityKey, j.identity);
  assert.ok(verifyAnyone(j.identity, [2, "skein probe"], "1", u.input!.bytes, rec.signature), "signed through the wire by the instance wallet");
  await j.rt.stop();

  // Replay: no wallet, answers from the witness; the chain comes out the same.
  const fresh = memoryStore();
  await fresh.putBlock(mod, bytes);
  await fresh.put(probe);
  await copyLog(j.store, fresh);
  const rt = new Runtime({ store: fresh, witness: await witnessFrom(j.store) });
  await rt.start();
  await rt.idle();
  assert.ok((await fresh.chains.tip(th)).equals(await j.store.chains.tip(th)));
  await rt.stop();

  // And with neither a wallet nor a witness, the step cannot run and nothing is recorded.
  const bare = memoryStore();
  await bare.putBlock(mod, bytes);
  await bare.put(probe);
  await copyLog(j.store, bare);
  const lines: string[] = [];
  const rt2 = new Runtime({ store: bare, log: (l) => lines.push(l) });
  await rt2.start();
  await rt2.idle();
  assert.ok(lines.some((l) => l.includes("cannot run") && l.includes("no wallet and no recorded answer")));
  assert.ok((await bare.chains.tip(th)).equals(th), "no update written");
  await rt2.stop();
});

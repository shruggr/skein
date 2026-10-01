// The kernel's `call` (#40): a program's function over the current state —
// no entry, no writes, fuel limited and reported — and the in-VM call from a
// step, whose writes are the step's. The probe is kernel-zig/test/call/probe.zig.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { ephemeralWallet } from "../wallet.ts";
import { rawCid } from "./boot.ts";
import { admit2, writeGenesis } from "./genesis.ts";
import { Kernel, KERNEL_BIN } from "./kernel.ts";

const PROBE = new URL("../../kernel-zig/test/call/probe.wasm", import.meta.url);

test("kernel call: a function over the state, no entry and no writes, fuel reported; an in-VM call from a step writes as the step", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  const home = await fs.mkdtemp(join(tmpdir(), "skein-call-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const key = PrivateKey.fromRandom();
  const identity = key.toPublicKey().toString();
  const db = join(home, "runtime.db");
  const k = new Kernel({ db, handle: "probe", domain: "localhost", wallet: ephemeralWallet(key), env: { SKEIN_HOME: home } });
  t.after(() => k.stop());

  const wasm = readFileSync(PROBE);
  const mod = rawCid(wasm);
  await k.putBlock(mod, wasm);
  const probe = await k.store.put({ kind: "program", name: "probe", code: { wasm: mod }, inputs: {}, services: [], description: "the call probe" } as never) as CID;
  await writeGenesis(k, {
    identity, owner: identity, handle: "probe", domain: "localhost",
    defaults: { callFuelLimit: "5000000" },
    subscriptions: [{ box: "probe", handler: probe }],
    // #77: a genesis-wired program writes only the heads its genesis scopes name.
    scopes: { probe: ["probe"] },
  });
  await k.start();
  await k.idle();

  const tip = await k.store.log.tip();
  const size = () => statSync(db).size + (existsSync(`${db}-wal`) ? statSync(`${db}-wal`).size : 0);
  const before = size();

  const echo = await k.invoke(probe, "echo", new TextEncoder().encode("hello"));
  assert.ok(echo.ok, JSON.stringify(echo));
  assert.equal(new TextDecoder().decode(echo.ok ? echo.result : undefined), "hello");
  assert.ok(echo.fuel > 0, "fuel is reported");

  // put keeps the record for the call only: it reads back inside, and the store never has it.
  const rec = dagCbor.encode({ kind: "scratch", n: 1 });
  const put = await k.invoke(probe, "put", rec);
  assert.ok(put.ok, JSON.stringify(put));
  const cid = CID.decode(put.ok ? put.result.subarray(0, 36) : new Uint8Array());
  assert.deepEqual(put.ok ? put.result.subarray(36) : undefined, rec, "the record reads back inside the call");
  assert.equal(await k.hasBlock(cid), false, "a call's put is not written");

  // Writes are refused; errors come back with the fuel used.
  const adv = await k.invoke(probe, "advance", new TextEncoder().encode("x"));
  assert.equal(adv.ok, false);
  assert.match(adv.ok ? "" : adv.error, /a call reads only/);
  assert.equal(await k.call("head", "probe"), null, "no head moved");

  const failed = await k.invoke(probe, "fail", new Uint8Array());
  assert.deepEqual(failed.ok ? undefined : failed.error, "probe: asked to fail");

  // Fuel is limited by the genesis's callFuelLimit.
  const spin = await k.invoke(probe, "spin", new Uint8Array());
  assert.equal(spin.ok, false);
  assert.equal(spin.ok ? "" : spin.error, "fuel exhausted");
  assert.equal(spin.fuel, 5_000_000);

  // A call within a call; by name from the genesis's programs too (the loop is one).
  const nest = await k.invoke(probe, "nest", probe.bytes);
  assert.equal(new TextDecoder().decode(nest.ok ? nest.result : undefined), "nested");
  const byName = await k.invoke("loop", "anything", new Uint8Array());
  assert.equal(byName.ok, false, "a program that is not written for calls fails, and nothing breaks");

  // The input: the call, the caller, the instance.
  const inp = await k.invoke(probe, "input", new Uint8Array([1, 2]), { caller: Uint8Array.from(key.toPublicKey().encode(true) as number[]), now: 1234 });
  const input = dagCbor.decode(inp.ok ? inp.result : new Uint8Array()) as Record<string, unknown>;
  assert.equal(input.kind, "call");
  assert.equal(input.fn, "input");
  assert.equal(input.now, 1234);
  assert.deepEqual(input.arg, new Uint8Array([1, 2]));
  assert.equal(Buffer.from(input.caller as Uint8Array).toString("hex"), identity);
  assert.equal(Buffer.from((input.self as { identity: Uint8Array }).identity).toString("hex"), identity);
  assert.deepEqual(input.pending, [], "nothing admitted and unprocessed");
  assert.ok(CID.asCID(input.state), "the committed state record");
  assert.ok(Array.isArray(input.dispatch) && (input.dispatch as unknown[]).length > 0, "the dispatch rows (#77)");

  // Nothing above wrote: the log is where it was, the file the same size.
  assert.ok((await k.store.log.tip())!.equals(tip!), "no entry");
  assert.equal(size(), before, "no bytes written");

  // From a step: the probe, as the `probe` box's handler, calls itself to advance a head — the step's move.
  const ev = await k.store.put({ kind: "probe-event", probe } as never);
  await admit2(k, { box: "probe", event: ev } as never);
  await k.idle();
  const moved = await k.call("head", "probe") as CID | null;
  assert.ok(moved, "the in-VM call's head move is written when the step ends");
  assert.deepEqual(await k.store.get(moved!), { kind: "probe", arg: "from a step" });
});

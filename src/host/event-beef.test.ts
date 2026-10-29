// The BEEF intake on an event route, through the host (#121, #164): root adds an event route
// `deploy` naming kernel.beef and sets chain/state (block 170's header, testbeef.ts) by message;
// Router.admitEvent sends the record beside the entry — a good BEEF admitted, the entry naming the
// record the door rewrote (the envelope where the bytes were), the bytes never stored; a BUMP that
// does not check, and a record with no BEEF, refused: admitEvent throws the door's answer
// (DoorAnswered), nothing written. A record put first (a host that puts before it admits) goes
// through the door all the same. An event route naming kernel.brc104 is refused by the kernel.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { signMessage } from "../client/raw.ts";
import { encode } from "../runtime/cid.ts";
import { rawCid } from "../runtime/programs.ts";
import { cidOf } from "./frontdoor.ts";
import { DoorAnswered, KERNEL_BIN } from "./kernel.ts";
import { beef170, chainState170, TX_170_CID } from "./testbeef.ts";
import { testHost } from "./testhost.ts";

const PROBE = new URL("../../kernel-zig/test/call/probe.wasm", import.meta.url);

test("admitEvent through an event route naming kernel.beef: validated and rewritten, or refused with the door's reason", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built", timeout: 120_000 }, async (t) => {
  const h = await testHost(t);
  const identity = h.instance("alpha");
  const l = await h.router.hydrate("alpha");
  const k = l.kernel;
  const admin = async (box: string, body: unknown) => {
    const m = await signMessage(h.owner, { recipient: identity, box, body: dagCbor.encode(body) });
    await h.router.messageLocal("alpha", dagCbor.encode(m.message), m.body);
    await h.router.settled();
    await k.idle();
  };
  const wasm = readFileSync(PROBE);
  const program = encode({ kind: "program", name: "probe", code: { wasm: rawCid(wasm) }, inputs: {}, services: [], description: "the call probe" });
  const cs = chainState170();
  await admin("objects", { records: [{ cid: rawCid(wasm), bytes: wasm }, { cid: program.cid, bytes: program.bytes }, ...cs.blocks] });
  await admin("head", { name: "chain/state", tree: cs.state });
  await admin("dispatch", { op: "add", row: { transport: "event", address: "deploy", filters: ["kernel.beef"], program: program.cid } });
  // #164: kernel.beef is the one filter an event route may name.
  await admin("dispatch", { op: "add", row: { transport: "event", address: "signed", filters: ["kernel.brc104"], program: program.cid } });
  const rows = (await k.dispatch()).rows;
  assert.ok(rows.some((r) => r.transport === "event" && r.address === "deploy"), "root's event route naming kernel.beef is taken");
  assert.ok(!rows.some((r) => r.address === "signed"), "an event route naming kernel.brc104 is refused");

  const good = { kind: "deploy", beef: beef170() };
  const entry = await h.router.admitEvent("alpha", "deploy", good);
  const e = await k.store.get(entry) as unknown as { event: CID; box: string };
  const rec = await k.store.get(e.event) as { kind: string; beef: { form: string; beef: CID } };
  assert.notEqual(e.event.toString(), cidOf(good).toString(), "the entry names the record the door handed back");
  assert.equal(rec.kind, "deploy");
  assert.equal(rec.beef.form, "beef", "the envelope where the bytes were");
  assert.equal((await k.store.get(rec.beef.beef) as { kind: string }).kind, "beef", "its pointer record");
  assert.ok(await k.hasBlock(TX_170_CID), "the transaction held as its bitcoin-tx block");
  assert.ok(!(await k.hasBlock(cidOf(good))), "the record as received is never stored");

  const tip = (await k.store.log.tip())!.toString();
  const bad = { kind: "deploy", beef: beef170({ bad: true }) };
  await assert.rejects(h.router.admitEvent("alpha", "deploy", bad), (x: unknown) => x instanceof DoorAnswered && x.answer.status === 400 && /merkle root/.test(x.answer.reason ?? ""), "a bad BUMP: thrown, the door's reason");
  await assert.rejects(h.router.admitEvent("alpha", "deploy", { kind: "deploy", note: "no BEEF" }), (x: unknown) => x instanceof DoorAnswered && /nothing to validate/.test(x.answer.reason ?? ""), "no BEEF: thrown");
  assert.equal((await k.store.log.tip())!.toString(), tip, "nothing written");

  // A record put first, the entry naming it: the door runs on it all the same.
  const first = { kind: "deploy", beef: beef170(), n: 2 };
  await k.store.put(first as never);
  const e2 = await k.store.get(await k.admit({ box: "deploy", event: cidOf(first) } as never)) as unknown as { event: CID };
  assert.notEqual(e2.event.toString(), cidOf(first).toString());
  assert.equal((await k.store.get(e2.event) as unknown as { beef: { form: string } }).beef.form, "beef", "put first: rewritten as well");
});

// The ways into a kernel's log (K24): the host's `append` frame writes the
// genesis entry and nothing else, and only as the log's first entry; every
// other entry comes in through `admit`, with its checks. And (K2) no message
// is the host's word: `admit` takes no mail entry; a message comes in as the
// signed package a `local` request carries, which the front door verifies.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { encode } from "../runtime/cid.ts";
import { nextEntry } from "../runtime/log.ts";
import { ephemeralWallet } from "../wallet.ts";
import { now as clockNow } from "./clock.ts";
import { appendRequest } from "./frontdoor.ts";
import { admit2, keyBytes, writeGenesis } from "./genesis.ts";
import { DoorAnswered, Kernel, KERNEL_BIN } from "./kernel.ts";
import { MESSAGE_KEY_ID, MESSAGE_PROTOCOL } from "./providers.ts";

async function kernel(t: { after(f: () => unknown): void }) {
  const home = await fs.mkdtemp(join(tmpdir(), "skein-admission-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const key = PrivateKey.fromRandom(), identity = key.toPublicKey().toString();
  const ownerKey = PrivateKey.fromRandom(), owner = ownerKey.toPublicKey().toString();
  const k = new Kernel({ db: join(home, "runtime.db"), handle: "adm", domain: "localhost", wallet: ephemeralWallet(key), env: { SKEIN_HOME: home } });
  t.after(() => k.stop());
  return { k, identity, owner, ownerKey };
}

test("append: the genesis entry only, as the log's first; every other entry is admitted", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  const { k, identity, owner } = await kernel(t);
  const event = await k.store.put({ kind: "note", text: "from the host" } as never);
  // Before any genesis: an event entry through `append` is refused (it would skip admit's checks).
  await assert.rejects(k.store.log.append(await nextEntry(k.store, { event, box: "notes" } as never, clockNow()) as never), /append: only the genesis entry is appended/);
  assert.ok(!(await k.store.log.tip()), "nothing written");
  await writeGenesis(k, { identity, root: [owner], handle: "adm", domain: "localhost" });
  await k.start();
  await k.idle();
  const tip = await k.store.log.tip();
  // A second genesis, and any other entry, are refused once the log has its genesis.
  const g2 = await k.store.put({ kind: "genesis", identity: Buffer.from(identity, "hex"), handle: "adm2", domain: "localhost", programs: {}, dispatch: [] } as never);
  await assert.rejects(k.store.log.append(await nextEntry(k.store, { genesis: g2 } as never, clockNow()) as never), /append: the log has its genesis already/);
  await assert.rejects(k.store.log.append(await nextEntry(k.store, { event, box: "notes" } as never, clockNow()) as never), /append: only the genesis entry is appended/);
  assert.ok((await k.store.log.tip())?.equals(tip!), "the log is as it was");
});

test("admit: no mail entry from the host (K2); the signed message as a `local` request is verified by the front door and routed", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  const { k, identity, owner, ownerKey } = await kernel(t);
  await writeGenesis(k, { identity, root: [owner], handle: "adm", domain: "localhost" });
  await k.start();
  await k.idle();
  const tree = await k.store.put({ kind: "note", text: "the owner's" } as never);
  const bodyBytes = dagCbor.encode({ name: "notes/x", tree });
  const unsigned = { kind: "mail", op: "put", sender: keyBytes(owner), recipient: keyBytes(identity), box: "head", body: encode(dagCbor.decode(bodyBytes)).cid, nonce: new Uint8Array(16) };

  // The host's word: a mail entry naming an unsigned record is refused at admission.
  const mail = await k.store.put(unsigned as never);
  await assert.rejects(admit2(k, { mail } as never, { body: bodyBytes }), /admit: a message is not admitted as a mail entry/);
  // A forged signature, as a local request: turned away at the door by the transport's check (#143: no entry).
  await assert.rejects(appendRequest(k, "local", { kind: "message", message: { ...unsigned, signature: new Uint8Array(70) }, body: bodyBytes }), DoorAnswered);
  await k.idle();
  assert.equal(await k.call("head", "notes/x"), null, "a message whose signature does not verify runs nothing");
  // Signed by root: the front door checks it, and the gate passes it to the kernel's `head` route (root's).
  const { signature } = await ephemeralWallet(ownerKey).createSignature({ protocolID: MESSAGE_PROTOCOL, keyID: MESSAGE_KEY_ID, counterparty: "anyone", data: [...dagCbor.encode(unsigned)] });
  await appendRequest(k, "local", { kind: "message", message: { ...unsigned, signature: Uint8Array.from(signature) }, body: bodyBytes });
  await k.idle();
  assert.ok(((await k.call("head", "notes/x")) as CID | null)?.equals(tree), "the owner's signed message moved the head");
  // #126 step 4: unsigned, from anyone but the instance itself to itself, is not a `local` package.
  await assert.rejects(appendRequest(k, "local", { kind: "message", message: unsigned, body: bodyBytes }), /admit: a request record in its transport's shape/);
  // The loopback's shape (the instance to itself), unsigned, but no record the instance emitted: the door turns it away.
  const self = { ...unsigned, sender: keyBytes(identity) };
  await assert.rejects(appendRequest(k, "local", { kind: "message", message: self, body: bodyBytes }), (e: unknown) => e instanceof DoorAnswered && /not a message this instance emitted/.test(e.answer.reason ?? ""), "an unsigned loopback is admitted only as the instance's own emit");
});

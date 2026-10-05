// The ways into a kernel's log (K24): the host's `append` frame writes the
// genesis entry and nothing else, and only as the log's first entry; every
// other entry comes in through `admit`, with its checks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKey } from "@bsv/sdk";
import { ephemeralWallet } from "../wallet.ts";
import { now as clockNow } from "./clock.ts";
import { writeGenesis } from "./genesis.ts";
import { Kernel, KERNEL_BIN } from "./kernel.ts";
import { nextEntry } from "../runtime/log.ts";

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
  await writeGenesis(k, { identity, owner, handle: "adm", domain: "localhost" });
  await k.start();
  await k.idle();
  const tip = await k.store.log.tip();
  // A second genesis, and any other entry, are refused once the log has its genesis.
  const g2 = await k.store.put({ kind: "genesis", identity: Buffer.from(identity, "hex"), handle: "adm2", domain: "localhost", programs: {}, dispatch: [] } as never);
  await assert.rejects(k.store.log.append(await nextEntry(k.store, { genesis: g2 } as never, clockNow()) as never), /append: the log has its genesis already/);
  await assert.rejects(k.store.log.append(await nextEntry(k.store, { event, box: "notes" } as never, clockNow()) as never), /append: only the genesis entry is appended/);
  assert.ok((await k.store.log.tip())?.equals(tip!), "the log is as it was");
});

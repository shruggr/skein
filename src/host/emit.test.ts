// A deadline is an intention (#126) end to end with the real kernel: the step
// records the event {kind: "event", event: "deadline", at, thread, step, app?}
// on its update (listed as emitted, awaited — no signer call in the step);
// the host signs the request for it with the instance's key and gives it to
// its waker, which at `at` answers with a signed message naming the event
// (`replyTo`) and carrying that request; the thread steps with `woke`.
// Across a host restart the event goes out again (the kernel hands over what
// a waiting thread still awaits at its start), so the new host's waker keeps
// the deadline. A signed message naming the event without the instance's
// signed request for it is not a wake: nothing runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey, ProtoWallet } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { encode } from "../runtime/cid.ts";
import { dirSource } from "./boot.ts";
import { HostDb } from "./instances.ts";
import { KERNEL_BIN } from "./kernel.ts";
import { Signer } from "./signer.ts";
import { MESSAGE_KEY_ID, MESSAGE_PROTOCOL, type MailRecord } from "./providers.ts";
import { Router } from "./router.ts";
import { until } from "./testhost.ts";
import { openStoreFile } from "../runtime/index-store.ts";
import { collect } from "../testkit.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEMO_WASM = join(ROOT, "programs/test/cron-demo/cron-demo.wasm");
const skip = !existsSync(KERNEL_BIN) && "kernel-zig not built";


test("deadline: an event on the step, kept by the host's waker across a restart, answered by its signed message carrying the instance's signed request; a message without it wakes nothing", { skip, timeout: 120_000 }, async (t) => {
  const home = await fs.mkdtemp(join(tmpdir(), "skein-emit-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const dir = join(home, "tree");
  await fs.mkdir(join(dir, "bin"), { recursive: true });
  await fs.mkdir(join(dir, "etc"));
  await fs.writeFile(join(dir, "bin/cron-demo.wasm"), readFileSync(DEMO_WASM));
  await fs.writeFile(join(dir, "etc/subscriptions.json"), JSON.stringify([{ box: "tick", handler: "cron-demo" }]));
  const db = new HostDb(join(home, "host.db"));
  t.after(() => db.close());
  const signer = new Signer(PrivateKey.fromRandom());
  const owner = PrivateKey.fromRandom().toPublicKey().toString();
  const lines: string[] = [];
  const make = () => new Router({
    db, walletFor: (row) => signer.wallet(row.handle), providerKeyFor: (n) => signer.providerKey(n), owner, home, idleMs: 0, cron: false,
    kernel: { env: { SKEIN_HOME: home } }, log: (s, l) => { lines.push(`[${s}] ${l}`); if (process.env.VERBOSE) console.log(`[${s}] ${l}`); },
  });
  db.add("w", { store: join(home, "instances/w/runtime.db"), identity: signer.identity("w") });
  let router = make();
  t.after(() => router.stop());
  const d = await dirSource(dir);
  await router.bootRow("w", { kind: "tree", root: d.root, objects: d.objects });
  await router.start();

  // A tick from the cron provider (#69: `skein-host event`'s message, a tick due now) starts cron-demo, which rests 4 s.
  await router.cronEvent("w", "tick", { name: "one", rest: 4000 });
  await router.settled();
  const k = (await router.hydrate("w")).kernel;
  const rested = lines.find((l) => /^\[w\] \S+ cron-demo step 1 → waiting · emitted \S+ · awaits \S+$/.test(l));
  assert.ok(rested, `step 1 recorded its deadline (no signer call) and awaits it:\n${lines.filter((l) => l.startsWith("[w]")).join("\n")}`);
  const [emitted, awaited] = [/emitted (\S+)/.exec(rested!)![1], /awaits (\S+)/.exec(rested!)![1]];
  assert.equal(emitted, awaited, "it awaits the event it recorded");

  // The event: {kind: "event", event: "deadline", at, thread, step}.
  const evCid = await deadlineOf(join(home, "instances/w/runtime.db"));
  assert.ok(evCid.toString().endsWith(emitted!), "the record the step listed");
  const ev = await k.store.get(evCid) as unknown as { kind: string; event: string; at: number; thread: CID; step: number };
  assert.equal(ev.kind, "event");
  assert.equal(ev.event, "deadline");
  assert.equal(ev.step, 1);
  assert.ok(typeof ev.at === "number" && ev.at > Date.now(), "its time is ahead");

  // A signed message naming the event as what it answers, without the instance's request for it, is not a wake: nothing runs.
  const tip = await k.store.log.tip();
  const tipEntry = await k.store.get(tip!) as unknown as { n: number };
  const forger = new ProtoWallet(PrivateKey.fromRandom());
  const fkey = Uint8Array.from(Buffer.from((await forger.getPublicKey({ identityKey: true })).publicKey, "hex"));
  const fbody = dagCbor.encode({ replyTo: evCid, at: Date.now() });
  const unsigned = { kind: "mail" as const, op: "put" as const, sender: fkey, recipient: Uint8Array.from(Buffer.from(signer.identity("w"), "hex")), box: "wake", body: encode(dagCbor.decode(fbody)).cid, nonce: new Uint8Array(16) };
  const { signature } = await forger.createSignature({ protocolID: MESSAGE_PROTOCOL, keyID: MESSAGE_KEY_ID, counterparty: "anyone", data: [...dagCbor.encode(unsigned)] });
  await router.appendLocal("w", { kind: "message", message: { ...unsigned, signature: Uint8Array.from(signature) } as MailRecord, body: fbody });
  await router.settled();
  const afterForge = await k.store.get((await k.store.log.tip())!) as unknown as { n: number };
  assert.equal(afterForge.n, tipEntry.n + 1, "the message is one entry");
  assert.ok(!lines.some((l) => /cron-demo step 2/.test(l)), "and nothing woke");

  // The host restarts before the deadline: the new host's waker has it because the kernel handed the event over again.
  await router.stop();
  assert.ok(!lines.some((l) => /cron-demo step 2/.test(l)), "not woken before the restart");
  const restarted = lines.length;
  router = make();
  await router.start();
  await until("the thread woke after the restart", () => lines.slice(restarted).some((l) => /^\[w\] \S+ cron-demo step 2 → finished/.test(l)) || undefined, 20_000);
  const woke = lines.find((l) => /^\[w\] #\d+ message \S+ in wake from \S+: wake → \S+$/.test(l));
  assert.ok(woke, "the waker's signed answer, carrying the instance's signed request, is the wake");
  await router.stop();
});

/** The deadline event cron-demo's first step recorded: the CID its update lists in `emitted`, read from the store file. */
async function deadlineOf(file: string): Promise<CID> {
  const s = openStoreFile(file, { readOnly: true });
  try {
    for (const t of await collect(s.edges.query({ kind: "thread" }))) {
      const o = await s.get(t) as unknown as { program: CID };
      if ((await s.get(o.program) as unknown as { name?: string }).name !== "cron-demo") continue;
      const [, first] = await collect(s.chains.history(t));
      const u = await s.get(first!) as unknown as { emitted?: CID[] };
      const cid = u.emitted![0]!;
      return cid;
    }
  } finally { await s.close(); }
  throw new Error("no cron-demo thread");
}

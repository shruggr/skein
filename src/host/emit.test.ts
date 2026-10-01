// emit (#70, #67) end to end with the real kernel: a deadline is a wake-me
// message to the address book's waker, signed by the instance; the step's
// update lists it as emitted and awaits it; the waker's signed answer comes
// in as a `local` request, the front door checks it, and the thread steps
// with `woke`. Across a host restart the message goes out again (the
// kernel offers what a waiting thread still awaits at its start), so the new
// host's waker keeps the deadline. A signed answer from a key that is not the
// waker's — or tampered with — is refused at the front door, and nothing runs.

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
import { Oracle } from "./oracle.ts";
import { MESSAGE_KEY_ID, MESSAGE_PROTOCOL, type MailRecord } from "./providers.ts";
import { Router } from "./router.ts";
import { until } from "./testhost.ts";
import { openStoreFile } from "../runtime/index-store.ts";
import { collect } from "../testkit.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEMO_WASM = join(ROOT, "programs/test/cron-demo/cron-demo.wasm");
const skip = !existsSync(KERNEL_BIN) && "kernel-zig not built";


test("emit: a deadline is a signed wake-me to the waker, kept across a host restart; a forged answer is refused", { skip, timeout: 120_000 }, async (t) => {
  const home = await fs.mkdtemp(join(tmpdir(), "skein-emit-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const dir = join(home, "tree");
  await fs.mkdir(join(dir, "bin"), { recursive: true });
  await fs.mkdir(join(dir, "etc"));
  await fs.writeFile(join(dir, "bin/cron-demo.wasm"), readFileSync(DEMO_WASM));
  await fs.writeFile(join(dir, "etc/subscriptions.json"), JSON.stringify([{ box: "tick", handler: "cron-demo" }]));
  const db = new HostDb(join(home, "host.db"));
  t.after(() => db.close());
  const oracle = new Oracle(PrivateKey.fromRandom());
  const owner = PrivateKey.fromRandom().toPublicKey().toString();
  const lines: string[] = [];
  const make = () => new Router({
    db, walletFor: (row) => oracle.wallet(row.handle), providerKeyFor: (n) => oracle.providerKey(n), owner, home, idleMs: 0, cron: false,
    kernel: { env: { SKEIN_HOME: home } }, log: (s, l) => { lines.push(`[${s}] ${l}`); if (process.env.VERBOSE) console.log(`[${s}] ${l}`); },
  });
  db.add("w", { store: join(home, "instances/w/runtime.db"), identity: oracle.identity("w") });
  let router = make();
  t.after(() => router.stop());
  const d = await dirSource(dir);
  await router.bootRow("w", { kind: "tree", root: d.root, objects: d.objects });
  await router.start();

  // A tick from the cron provider (#69: `skein-host event`'s message, a tick due now) starts cron-demo, which rests 4 s.
  await router.cronEvent("w", "tick", { name: "one", rest: 4000 });
  await router.settled();
  const k = (await router.hydrate("w")).kernel;
  const rested = lines.find((l) => /^\[w\] \S+ cron-demo step 1 → waiting · 1 oracle · emitted \S+ · awaits \S+$/.test(l));
  assert.ok(rested, `step 1 signed (one oracle call) and emitted its wake-me, and awaits it:\n${lines.filter((l) => l.startsWith("[w]")).join("\n")}`);
  const [emitted, awaited] = [/emitted (\S+)/.exec(rested!)![1], /awaits (\S+)/.exec(rested!)![1]];
  assert.equal(emitted, awaited, "it awaits the message it emitted");

  // The wake-me: a mail record from the instance to the waker, box `wake`, signed BRC-169's way.
  const peersRoot = await k.call("head", "peers") as CID;
  const book = await k.store.get(peersRoot) as unknown as { peers: Array<{ peer: CID }> };
  const entries = await Promise.all(book.peers.map(async (p) => await k.store.get(p.peer) as unknown as { key: Uint8Array; role?: string; transport: string; address: string; source: string }));
  const waker = entries.find((e) => e.role === "waker")!;
  assert.ok(waker && waker.transport === "local" && waker.address === "waker" && waker.source === "genesis", "the genesis seeded the host's waker");
  assert.equal(Buffer.from(waker.key).toString("hex"), oracle.providerKey("waker").toPublicKey().toString(), "the waker's key: the host's provider key");

  // A forged answer — signed by another key, claiming to be the waker's — is refused; nothing runs.
  const tip = await k.store.log.tip();
  const tipEntry = await k.store.get(tip!) as unknown as { n: number };
  const wakeCid = await wakeMeOf(join(home, "instances/w/runtime.db"));
  const wakeMe = { cid: wakeCid, message: await k.store.get(wakeCid) as unknown as MailRecord };
  assert.equal(wakeMe.message.box, "wake");
  assert.ok(Buffer.from(wakeMe.message.recipient).equals(Buffer.from(waker.key)), "to the waker");
  assert.ok(wakeMe.cid.toString().endsWith(emitted!), "the message the step emitted");
  const signedOk = await new ProtoWallet("anyone").verifySignature({ protocolID: MESSAGE_PROTOCOL, keyID: MESSAGE_KEY_ID, counterparty: oracle.identity("w"), data: [...dagCbor.encode(Object.fromEntries(Object.entries(wakeMe.message).filter(([key]) => key !== "signature")))], signature: [...wakeMe.message.signature] });
  assert.ok(signedOk.valid, "signed by the instance, BRC-169's way (anyone can check it)");
  const forger = new ProtoWallet(PrivateKey.fromRandom());
  const fbody = dagCbor.encode({ replyTo: wakeMe.cid, at: Date.now() });
  const unsigned = { kind: "mail" as const, op: "put" as const, sender: waker.key, recipient: Uint8Array.from(Buffer.from(oracle.identity("w"), "hex")), box: "wake", body: encode(dagCbor.decode(fbody)).cid, nonce: new Uint8Array(16) };
  const { signature } = await forger.createSignature({ protocolID: MESSAGE_PROTOCOL, keyID: MESSAGE_KEY_ID, counterparty: "anyone", data: [...dagCbor.encode(unsigned)] });
  await router.appendLocal("w", { kind: "message", message: { ...unsigned, signature: Uint8Array.from(signature) } as MailRecord, body: fbody });
  await router.settled();
  const afterForge = await k.store.get((await k.store.log.tip())!) as unknown as { n: number };
  assert.equal(afterForge.n, tipEntry.n + 1, "the forged answer is one entry");
  assert.ok(!lines.some((l) => /cron-demo step 2/.test(l)), "and nothing woke");

  // The host restarts before the deadline: the new host's waker has it because the kernel offered the wake-me again.
  await router.stop();
  assert.ok(!lines.some((l) => /cron-demo step 2/.test(l)), "not woken before the restart");
  const restarted = lines.length;
  router = make();
  await router.start();
  await until("the thread woke after the restart", () => lines.slice(restarted).some((l) => /^\[w\] \S+ cron-demo step 2 → finished/.test(l)) || undefined, 20_000);
  const woke = lines.find((l) => /^\[w\] #\d+ message \S+ in wake from \S+: wake → \S+$/.test(l));
  assert.ok(woke, "the waker's answer is routed as the wake");
  await router.stop();
});

/** The wake-me cron-demo's first step emitted: the CID its update lists in `emitted`, read from the store file. */
async function wakeMeOf(file: string): Promise<CID> {
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

// The address book by configuration (#40, #124): `skein plan peers add |
// remove` writes the owner's messages to an agent's `peers` box as files,
// delivered to its /sendMessage on the owner's session (as `skein send` does
// with a wallet); `skein-host peers <handle> list` reads it back from the
// store. With the real Zig kernel behind a router.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKey } from "@bsv/sdk";
import { planMain } from "../client/admin-cli.ts";
import { sendDir } from "../testapps.ts";
import { main } from "./cli.ts";
import { KERNEL_BIN } from "./kernel.ts";
import { testHost, until } from "./testhost.ts";

test("skein plan peers: add / remove as the owner's messages to the `peers` box, sent to /sendMessage; skein-host peers list reads them back", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  const h = await testHost(t);
  h.mailbox("david", h.ownerId);
  h.instance("alpha");
  await h.router.start();
  await h.router.settled();
  const out: string[] = [], err: string[] = [];
  const env = { vars: { SKEIN_HOME: h.home, SKEIN_ROUTER_PORT: String(h.router.port), SKEIN_MASTER_KEY: "11".repeat(32) }, out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
  const list = async (handle: string) => { await h.router.settled(); const n = out.length; assert.equal(await main(["peers", handle, "list"], env), 0, err.join("\n")); return out.slice(n).filter((l) => !l.endsWith("\tgenesis")); }; // the genesis seeds the providers and the owner (#70)
  const work = mkdtempSync(join(tmpdir(), "skein-peers-"));
  const store = h.db.get("alpha")!.store;
  let n = 0;
  const plan = async (...argv: string[]) => { const dir = join(work, String(++n)); return { code: await planMain(["peers", ...argv, "--store", store, "--out", dir], env), dir }; };
  const send = (dir: string) => sendDir({ port: h.router.port!, owner: h.owner, settled: () => h.router.settled() }, "alpha", dir);

  const bob = PrivateKey.fromRandom().toPublicKey().toString();
  let p = await plan("add", bob, "https://mail.example/bob", "--handle", "bob@example.com");
  assert.equal(p.code, 0, err.join("\n"));
  assert.ok(out.includes(`peers add ${bob} → mailbox https://mail.example/bob (@bob@example.com)`), out.join("\n"));
  assert.equal(await send(p.dir), 1);
  const got = await until("bob in alpha's address book", async () => { const l = await list("alpha"); return l.length ? l : undefined; });
  assert.deepEqual(got, [[bob, "mailbox", "https://mail.example/bob", "bob@example.com", "admin"].join("\t")]);
  p = await plan("add", bob, "https://other.example/bob");
  await send(p.dir);
  await until("the new URL", async () => (await list("alpha"))[0]?.includes("https://other.example/bob\t-\tadmin") ? true : undefined);
  p = await plan("remove", bob);
  await send(p.dir);
  await until("bob removed", async () => (await list("alpha")).length === 0 ? true : undefined);

  // --recipient alone: no reads, the same message.
  const id = h.db.get("alpha")!.identity!;
  const dir = join(work, "r");
  assert.equal(await planMain(["peers", "add", bob, "https://mail.example/bob", "--recipient", id, "--out", dir], env), 0, err.join("\n"));
  await sendDir({ port: h.router.port!, owner: h.owner, settled: () => h.router.settled() }, "alpha", dir);
  await until("bob again", async () => (await list("alpha")).length === 1 ? true : undefined);

  // Another key's messages are refused: no admin row admits it.
  const stranger = (await import("../wallet.ts")).ephemeralWallet(PrivateKey.fromRandom());
  await assert.rejects(sendDir({ port: h.router.port!, owner: h.owner, settled: () => h.router.settled() }, "alpha", join(work, "3"), stranger), /403/);

  // Wrong shapes, unknown rows, a mailbox instance, a key that is not one.
  const bad = async (...argv: string[]) => await planMain(["peers", ...argv, "--recipient", id], env);
  assert.equal(await bad("add", bob), 2);
  assert.equal(await bad("remove", bob, "https://x"), 2);
  assert.equal(await bad("swap", bob), 2);
  assert.equal(await bad("remove", bob, "--handle", "b@c"), 2);
  assert.equal(await bad("add", "02abc", "https://x"), 1);
  assert.equal(await bad("add", bob, "mail.example"), 2);
  assert.equal(await main(["peers", "alpha", "add", bob, "https://x"], env), 2, "skein-host writes no address book");
  assert.equal(await main(["peers", "nobody", "list"], env), 1);
  assert.equal(await main(["peers", "david", "list"], env), 1);
  assert.match(err.at(-1)!, /mailbox instance/);
});

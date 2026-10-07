// The address book by configuration (#40, #124, #142): `skein peers add |
// remove` sends the owner's messages to an agent's `peers` box — signed in the
// client's process with the operator's key, delivered over the host's control
// socket (`--instance`) or on one BRC-104 session (an origin); `--dry-run` and
// `--store` print them. `skein-host peers <handle> list` reads it back from
// the store. With the real Zig kernel behind a router.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PrivateKey } from "@bsv/sdk";
import { adminMain } from "../client/admin-cli.ts";
import { main } from "./cli.ts";
import { KERNEL_BIN } from "./kernel.ts";
import { testHost, until } from "./testhost.ts";

test("skein peers: add / remove as the owner's messages to the `peers` box, over the control socket and on a session; skein-host peers list reads them back", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  const h = await testHost(t);
  h.mailbox("david", h.ownerId);
  h.instance("alpha");
  await h.router.start();
  await h.router.listenControl(join(h.home, "host.sock"));
  await h.router.settled();
  const keyFile = join(h.home, "operator.key");
  writeFileSync(keyFile, `${h.ownerKey.toHex()}\n`, { mode: 0o600 });
  const out: string[] = [], err: string[] = [];
  const env = { vars: { SKEIN_HOME: h.home, SKEIN_ROUTER_PORT: String(h.router.port), SKEIN_MASTER_KEY: "11".repeat(32), SKEIN_OPERATOR_KEY: keyFile }, out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
  const list = async (handle: string) => { await h.router.settled(); const n = out.length; assert.equal(await main(["peers", handle, "list"], env), 0, err.join("\n")); return out.slice(n).filter((l) => !l.endsWith("\tgenesis")); }; // the genesis seeds the providers and the owner (#70)
  const skein = async (...argv: string[]) => { const code = await adminMain("peers", argv, env); await h.router.settled(); return code; };

  const bob = PrivateKey.fromRandom().toPublicKey().toString();
  assert.equal(await skein("add", bob, "https://mail.example/bob", "--handle", "bob@example.com", "--instance", "alpha"), 0, err.join("\n"));
  assert.ok(out.includes(`peers add ${bob} → mailbox https://mail.example/bob (@bob@example.com)`), out.join("\n"));
  assert.match(out.at(-1)!, /^alpha \(this host\): 1 message sent/);
  const got = await until("bob in alpha's address book", async () => { const l = await list("alpha"); return l.length ? l : undefined; });
  assert.deepEqual(got, [[bob, "mailbox", "https://mail.example/bob", "bob@example.com", "admin"].join("\t")]);
  // On a session with the instance's origin: the same message.
  const origin = `${h.base}/@alpha`;
  assert.equal(await skein("add", bob, "https://other.example/bob", origin), 0, err.join("\n"));
  await until("the new URL", async () => (await list("alpha"))[0]?.includes("https://other.example/bob\t-\tadmin") ? true : undefined);
  // --dry-run and --store: printed, not sent.
  let n = out.length;
  assert.equal(await skein("remove", bob, "--instance", "alpha", "--dry-run"), 0, err.join("\n"));
  assert.match(out.slice(n).join("\n"), /"messageBox":"peers"[\s\S]*1 message to .* \(not sent\)/);
  n = out.length;
  assert.equal(await skein("remove", bob, "--store", h.db.get("alpha")!.store), 0, err.join("\n"));
  assert.match(out.slice(n).join("\n"), /\(not sent\)/);
  assert.equal((await list("alpha")).length, 1, "nothing sent by a dry run");
  assert.equal(await skein("remove", bob, "--instance", "alpha"), 0, err.join("\n"));
  await until("bob removed", async () => (await list("alpha")).length === 0 ? true : undefined);

  // Another key's messages are refused on the session: no admin row admits it.
  const stranger = join(h.home, "stranger.key");
  writeFileSync(stranger, `${PrivateKey.fromRandom().toHex()}\n`);
  assert.equal(await adminMain("peers", ["add", bob, "https://x.example", origin], { ...env, vars: { ...env.vars, SKEIN_OPERATOR_KEY: stranger } }), 1);
  assert.match(err.at(-1)!, /403/);

  // Wrong shapes, unknown rows, a mailbox instance, a key that is not one.
  const bad = async (...argv: string[]) => await adminMain("peers", [...argv, "--instance", "alpha"], env);
  assert.equal(await bad("add", bob), 2);
  assert.equal(await bad("remove", bob, "https://x"), 1, "an origin and --instance: two places");
  assert.match(err.at(-1)!, /one\)/);
  assert.equal(await bad("swap", bob), 2);
  assert.equal(await bad("remove", bob, "--handle", "b@c"), 2);
  assert.equal(await bad("add", "02abc", "https://x"), 1);
  assert.equal(await bad("add", bob, "mail.example"), 2);
  assert.equal(await adminMain("peers", ["add", bob, "https://x"], env), 1, "no instance named");
  assert.equal(await main(["peers", "alpha", "add", bob, "https://x"], env), 2, "skein-host writes no address book");
  assert.equal(await main(["peers", "nobody", "list"], env), 1);
  assert.equal(await main(["peers", "david", "list"], env), 1);
  assert.match(err.at(-1)!, /mailbox instance/);
});

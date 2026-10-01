// The address book by configuration (#40): `skein-host peers <handle> add |
// remove | list` writes an agent's address book through its `peers` box as
// the owner (the admin), and reads it back from the store; `roster --deploy`
// writes the other agents' keys and origins the same way. With the real Zig
// kernel behind a router.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { PrivateKey } from "@bsv/sdk";
import { RawBox } from "../client/raw.ts";
import { main } from "./cli.ts";
import { KERNEL_BIN } from "./kernel.ts";
import { testHost, until } from "./testhost.ts";

test("skein-host peers: add / list / remove through the `peers` box as the owner; an unchanged entry is not sent again; roster --deploy writes the other agents", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  const h = await testHost(t);
  h.mailbox("david", h.ownerId);
  const alpha = h.agent("alpha");
  const beta = h.agent("beta");
  await h.router.start();
  const out: string[] = [], err: string[] = [];
  const env = {
    vars: { SKEIN_HOME: h.home, SKEIN_OWNER: h.ownerId, SKEIN_ROUTER_PORT: String(h.router.port), SKEIN_MASTER_KEY: "11".repeat(32) },
    out: (l: string) => out.push(l), err: (l: string) => err.push(l),
    owner: { wallet: h.owner, box: (row: { handle: string }) => new RawBox(h.owner, `${h.base}/@${row.handle}`) },
  };
  const cli = (...argv: string[]) => main(argv, env);
  const list = async (handle: string) => { await h.router.settled(); const n = out.length; assert.equal(await cli("peers", handle, "list"), 0, err.join("\n")); return out.slice(n).filter((l) => !l.endsWith("\tgenesis")); }; // the genesis seeds the providers and the owner (#70)

  const bob = PrivateKey.fromRandom().toPublicKey().toString();
  assert.equal(await cli("peers", "alpha", "add", bob, "https://mail.example/bob", "--handle", "bob@example.com"), 0, err.join("\n"));
  assert.equal(out.at(-1), `alpha: peers add ${bob.slice(-8)} → https://mail.example/bob (@bob@example.com): sent`);
  const got = await until("bob in alpha's address book", async () => { const l = await list("alpha"); return l.length ? l : undefined; });
  assert.deepEqual(got, [[bob, "mailbox", "https://mail.example/bob", "-", "bob@example.com", "admin"].join("\t")]);
  assert.equal(await cli("peers", "alpha", "add", bob, "https://mail.example/bob", "--handle", "bob@example.com"), 0);
  assert.match(out.at(-1)!, /: unchanged/, "the same entry again is not sent");
  assert.equal(await cli("peers", "alpha", "add", bob, "https://other.example/bob"), 0);
  assert.match(out.at(-1)!, /→ https:\/\/other\.example\/bob: sent$/, "a changed URL is");
  await until("the new URL", async () => (await list("alpha"))[0]?.includes("https://other.example/bob\t-\t-\tadmin") ? true : undefined);
  assert.equal(await cli("peers", "alpha", "remove", bob), 0);
  assert.match(out.at(-1)!, /: sent$/);
  await until("bob removed", async () => (await list("alpha")).length === 0 ? true : undefined);
  assert.equal(await cli("peers", "alpha", "remove", bob), 0);
  assert.match(out.at(-1)!, /: unchanged/, "removing a key it does not have sends nothing");

  // Wrong shapes, unknown rows, a mailbox instance, a key that is not one.
  assert.equal(await cli("peers", "alpha", "add", bob), 2);
  assert.equal(await cli("peers", "alpha", "remove", bob, "https://x"), 2);
  assert.equal(await cli("peers", "alpha", "list", bob), 2);
  assert.equal(await cli("peers", "alpha", "swap", bob), 2);
  assert.equal(await cli("peers", "alpha", "remove", bob, "--handle", "b@c"), 2);
  assert.equal(await cli("peers", "alpha", "add", "02abc", "https://x"), 2);
  assert.equal(await cli("peers", "alpha", "add", bob, "mail.example"), 2);
  assert.equal(await cli("peers", "nobody", "list"), 1);
  assert.equal(await cli("peers", "david", "list"), 1);
  assert.match(err.at(-1)!, /mailbox instance/);

  // The roster step: every other agent's key and origin, as the admin; again: nothing sent.
  assert.equal(await cli("roster", "--deploy"), 0, err.join("\n"));
  assert.ok(out.includes("alpha: address book: beta written") && out.includes("beta: address book: alpha written"), out.join("\n"));
  const origin = (x: string) => `http://${x}.localhost:${h.router.port}`;
  await until("the roster's entries", async () => (await list("alpha")).length && (await list("beta")).length ? true : undefined);
  assert.deepEqual(await list("alpha"), [[beta, "mailbox", origin("beta"), "-", "beta@localhost", "admin"].join("\t")]);
  assert.deepEqual(await list("beta"), [[alpha, "mailbox", origin("alpha"), "-", "alpha@localhost", "admin"].join("\t")]);
  const n = out.length;
  assert.equal(await cli("roster", "--deploy"), 0);
  assert.ok(!out.slice(n).some((l) => l.includes("address book")), "unchanged: nothing sent");
});

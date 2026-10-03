// Delivery to another host (#40): the instance's messagebox program delivers
// over http to a URL that is not its host's — a second host, a real server on
// another port — on a BRC-104 session of its own. Where it delivers is its
// peer table, written only by its own programs: here the owner, as admin,
// adds the peer (box `peers`, the resolve program), and removes it again.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import type { CID } from "multiformats/cid";
import { RawBox } from "../client/raw.ts";
import { KERNEL_BIN } from "./kernel.ts";
import { fetchHttp } from "./router.ts";
import { testHost, until } from "./testhost.ts";
import { SHELL_APP } from "../testapps.ts";

test("remote delivery: an admin peer record; the run's result delivered over http to the owner's mailbox on another host; the peer removed", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  // Host B keeps the owner's mailbox; host A runs the agent. The same owner.
  const b = await testHost(t);
  b.mailbox("david", b.ownerId);
  const wire: string[] = [];
  const a = await testHost(t, {
    ownerKey: b.ownerKey,
    http: async (req) => { wire.push(`${req.method} ${req.url}`); return await fetchHttp(req); },
  });
  const alpha = a.agent("alpha");
  await a.router.start();
  await b.router.start();
  await a.install("alpha", [SHELL_APP]); // #83: `run` is the shell app's
  const toAlpha = new RawBox(a.owner, a.origin("alpha"));

  // The owner, as admin, tells alpha where the owner's mailbox is.
  const url = b.origin("david");
  await toAlpha.send(alpha, "peers", { op: "add", key: Uint8Array.from(Buffer.from(a.ownerId, "hex")), url });
  await a.router.settled();
  const k = (await a.router.hydrate("alpha")).kernel;
  const table = async () => {
    const root = await k.call("head", "peers") as CID | null;
    if (!root) return [];
    const tab = await k.store.get(root) as unknown as { peers: Array<{ peer: CID }> };
    const all = await Promise.all(tab.peers.map(async (p) => await k.store.get(p.peer) as unknown as { key: Uint8Array; transport: string; address: string; source: string }));
    return all.filter((p) => p.source !== "genesis"); // the genesis seeds the host's providers (#70)
  };
  const added = await table();
  assert.equal(added.length, 1);
  assert.equal(Buffer.from(added[0]!.key).toString("hex"), a.ownerId);
  assert.equal(added[0]!.address, url);
  assert.equal(added[0]!.transport, "mailbox");
  assert.equal(added[0]!.source, "admin");

  // A run: its result goes to the owner — over the wire, to host B.
  const sent = await toAlpha.send(alpha, "run", { cmd: "echo remote" });
  const mine = new RawBox(a.owner, url);
  const results = await until("the result on host B", async () => { const r = await mine.list("results"); return r.length ? r : undefined; });
  const r = results[0]!.value as { exitCode: number; replyTo: CID; stdout: Uint8Array };
  assert.equal(results[0]!.sender, alpha, "the sender is alpha: its own session with host B's mailbox");
  assert.equal(r.exitCode, 0);
  assert.equal(r.replyTo.toString(), sent.id.toString());
  assert.equal(new TextDecoder().decode(r.stdout), "remote\n");
  assert.ok(wire.some((w) => w.startsWith(`POST ${url}/.well-known/auth`)), `a handshake over the wire (${wire})`);
  assert.ok(a.lines.some((l) => l.startsWith("[alpha] deliver results for ") && l.endsWith(`→ ${url}/sendMessage (remote): 200 delivered`)), "the delivery's log line: remote");
  assert.ok(wire.some((w) => w === `POST ${url}/sendMessage`), `the delivery over the wire (${wire})`);

  // Removed: the table is empty again.
  await toAlpha.send(alpha, "peers", { op: "remove", key: Uint8Array.from(Buffer.from(a.ownerId, "hex")) });
  await a.router.settled();
  assert.deepEqual(await table(), []);
});

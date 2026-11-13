// The router's control socket (#60 follow-up, control.ts): `skein-host run`
// listens on $SKEIN_HOME/host.sock (mode 0600); a second router cannot take
// the socket; it takes one op, `message`, and refuses anything else; `close()`
// removes it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { main, runHost } from "./cli.ts";
import { CONTROL_SOCKET, controlRequest, listenControl } from "./control.ts";
import { HostDb } from "./instances.ts";
import { KERNEL_BIN } from "./kernel.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const skip = !existsSync(KERNEL_BIN) && "kernel-zig not built";

test("the control socket while the router runs: the owner's only, one router, `message` only; gone at close", { skip, timeout: 120_000 }, async (t) => {
  const home = await fs.mkdtemp(join(tmpdir(), "skein-ctl-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const tree = join(home, "tree");
  await fs.mkdir(join(tree, "bin"), { recursive: true });
  await fs.mkdir(join(tree, "etc"));
  await fs.writeFile(join(tree, "bin/cron-demo.wasm"), readFileSync(join(ROOT, "programs/test/cron-demo/cron-demo.wasm")));
  await fs.writeFile(join(tree, "etc/dispatch.json"), JSON.stringify([{ address: "tick", program: "cron-demo" }]));
  const vars: Record<string, string | undefined> = {
    HOME: home, SKEIN_HOME: home, SKEIN_MASTER_KEY: "77".repeat(32), SKEIN_OWNER: PrivateKey.fromRandom().toPublicKey().toString(),
    SKEIN_ROUTER_PORT: "0", SKEIN_HOST_PORT: "0", PATH: process.env.PATH,
  };
  const out: string[] = [], err: string[] = [];
  const env = { vars, out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
  assert.equal(await main(["add", "evt", "--boot", tree], env), 0, err.join("\n"));
  const sock = join(home, CONTROL_SOCKET);
  assert.ok(!existsSync(sock), "no socket while the host is down");

  // The host up: the socket is there, the owner's only.
  const db = new HostDb(join(home, "host.db"));
  const host = await runHost(db, { ...env, vars: { ...env.vars, SKEIN_TERANODE: "off", SKEIN_ARC_URL: "off" } });
  let stopped = false;
  t.after(async () => { if (!stopped) await host.stop(); db.close(); });
  assert.ok(existsSync(sock), "the running router listens on $SKEIN_HOME/host.sock");
  assert.ok(statSync(sock).isSocket());
  assert.equal(statSync(sock).mode & 0o777, 0o600);
  await assert.rejects(listenControl(sock, { message: async () => "" }), /another router answers on it/, "a second router cannot take it");

  // The `event` op is gone with the cron provider; the claim never came through here (#127).
  const want = { ok: false, error: "want {op: \"message\", handle, message, body}" };
  assert.deepEqual(await controlRequest(sock, { op: "event", handle: "evt", box: "tick", event: {} } as never), want);
  assert.deepEqual(await controlRequest(sock, { op: "claim", handle: "evt", owner: "02" + "ab".repeat(32) } as never), want);
  // #142: a `message` is a signed one; anything else is refused before it reaches an instance.
  assert.deepEqual(await controlRequest(sock, { op: "message", handle: "evt", message: Buffer.from(dagCbor.encode({ kind: "mail" })).toString("base64"), body: "" }), { ok: false, error: "not a signed message (a mail record with its signature)" });
  assert.deepEqual(await controlRequest(sock, { op: "message", handle: "nope", message: "", body: "" }), { ok: false, error: "no instance nope" });

  await host.stop();
  stopped = true;
  assert.ok(!existsSync(sock), "close() removes the socket");
});

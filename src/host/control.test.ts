// The router's control socket (#60 follow-up, control.ts): `skein-host run`
// listens on $SKEIN_HOME/host.sock (mode 0600) and `skein-host event` sends
// its event there, sent by the running router with the kernel it holds as a
// message from its cron provider, a tick due now (cronEvent, #69); a second
// router cannot take the socket; `close()` removes it, and with the host down
// `event` falls back to a router of its own — also past a socket file nobody
// answers on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { main, runHost } from "./cli.ts";
import { CONTROL_SOCKET, controlRequest, listenControl } from "./control.ts";
import { HostDb } from "./instances.ts";
import { KERNEL_BIN } from "./kernel.ts";
import { until } from "./testhost.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const skip = !existsSync(KERNEL_BIN) && "kernel-zig not built";

type Entry = { prev?: CID; request?: CID; transport?: string };
type Pkg = { kind: string; message?: { box: string; sender: Uint8Array }; body?: Uint8Array };
/** The bodies of the messages in box `tick` an instance's log took in (`local` requests: the providers'), oldest first, with their senders. */
async function events(store: { get(c: CID): Promise<unknown>; log: { tip(): Promise<CID | undefined> } }): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (let c = await store.log.tip(); c;) {
    const e = await store.get(c) as Entry;
    if (e.request && e.transport === "local") {
      const r = await store.get(e.request) as Pkg;
      if (r.kind === "message" && r.message?.box === "tick" && r.body) out.unshift({ ...dagCbor.decode(r.body) as Record<string, unknown>, sender: Buffer.from(r.message.sender).toString("hex") });
    }
    c = e.prev;
  }
  return out;
}

test("skein-host event over the control socket while the router runs; a router of its own when it does not", { skip, timeout: 120_000 }, async (t) => {
  const home = await fs.mkdtemp(join(tmpdir(), "skein-ctl-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const tree = join(home, "tree");
  await fs.mkdir(join(tree, "bin"), { recursive: true });
  await fs.mkdir(join(tree, "etc"));
  await fs.writeFile(join(tree, "bin/cron-demo.wasm"), readFileSync(join(ROOT, "programs/test/cron-demo/cron-demo.wasm")));
  await fs.writeFile(join(tree, "etc/subscriptions.json"), JSON.stringify([{ box: "tick", handler: "cron-demo" }]));
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
  const host = await runHost(db, env);
  let stopped = false;
  t.after(async () => { if (!stopped) await host.stop(); db.close(); });
  assert.ok(existsSync(sock), "the running router listens on $SKEIN_HOME/host.sock");
  assert.ok(statSync(sock).isSocket());
  assert.equal(statSync(sock).mode & 0o777, 0o600);
  await assert.rejects(listenControl(sock, { event: async () => "" }), /another router answers on it/, "a second router cannot take it");

  // The event goes to the running router, which sends it with its own kernel: a message from its cron provider.
  assert.equal(await main(["event", "evt", "tick", "{\"name\":\"live\",\"rest\":1}"], env), 0, err.join("\n"));
  assert.match(out.at(-1)!, /^evt: cron from the cron provider into tick as \S+ \(by the running router\)$/);
  const k = (await host.router.hydrate("evt")).kernel;
  await until("the handler's step", () => out.some((l) => /^\[evt\] \S+ cron-demo step 1 → waiting/.test(l)) || undefined);
  const live = await events(k.store as never);
  assert.equal(live.length, 1);
  assert.equal(live[0]!.name, "live");
  assert.equal(live[0]!.kind, "cron");
  assert.equal(typeof live[0]!.due, "number", "a tick due now");
  assert.equal(live[0]!.sender, host.router.providers.key("cron"), "from the cron provider's key");
  // The router's refusal comes back as the command's error.
  assert.deepEqual(await controlRequest(sock, { op: "event", handle: "nope", box: "tick", event: {} }), { ok: false, error: "no enabled instance nope" });
  // #127: no claim through the socket — the owner of an instance is the claim's sender, the owner's wallet.
  assert.deepEqual(await controlRequest(sock, { op: "claim", handle: "evt", owner: "02" + "ab".repeat(32) } as never), { ok: false, error: "want {op: \"event\", handle, box, event}" });

  // Closed: the socket is gone, and `event` goes through a router of its own.
  await host.stop();
  stopped = true;
  assert.ok(!existsSync(sock), "close() removes the socket");
  assert.equal(await main(["event", "evt", "tick", "{\"name\":\"down\",\"rest\":1}"], env), 0, err.join("\n"));
  assert.match(out.at(-1)!, /^evt: cron from the cron provider into tick as \S+$/);
  // A socket file nobody answers on (a router that died) is no router: the same fallback.
  writeFileSync(sock, "");
  assert.equal(await main(["event", "evt", "tick", "{\"name\":\"stale\",\"rest\":1}"], env), 0, err.join("\n"));
  assert.match(out.at(-1)!, /^evt: cron from the cron provider into tick as \S+$/);

  const { openStoreFile } = await import("../runtime/index-store.ts");
  const s = openStoreFile(join(home, "instances/evt/runtime.db"), { readOnly: true });
  try {
    assert.deepEqual((await events(s as never)).map((e) => e.name), ["live", "down", "stale"]);
  } finally { s.close(); }
});

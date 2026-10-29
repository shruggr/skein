// #164: an application host's wiring — an emitted event whose name no stock wiring takes is handed
// to the Providers' (and the Router's) `appEvent`, once, after its step's commit; without it, a log
// line ("this host has no wiring for: ignored"). The stock names never reach it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PrivateKey } from "@bsv/sdk";
import { Providers, type Outgoing } from "./providers.ts";
import { Router } from "./router.ts";
import { HostDb } from "./instances.ts";

const ev = (event: string, fields: Record<string, unknown> = {}): Outgoing => ({
  message: { kind: "event", event, app: "amm", ...fields } as never, body: new Uint8Array(), transport: "event", address: event,
});

function providers(appEvent?: (h: string, r: Record<string, unknown>) => void) {
  const lines: string[] = [];
  const keys = new Map<string, PrivateKey>();
  const p = new Providers({
    keyOf: (n) => { let k = keys.get(n); if (!k) keys.set(n, (k = PrivateKey.fromRandom())); return k; },
    identity: async () => undefined, append: async () => undefined, sign: async () => new Uint8Array(),
    fetch: async () => ({ status: 404, headers: {}, body: new Uint8Array() }),
    topicEvent: () => { lines.push("topicEvent"); },
    ...(appEvent ? { appEvent } : {}),
    now: () => Date.now(), log: (s, l) => lines.push(`[${s}] ${l}`),
  });
  return { p, lines };
}

test("an event no stock wiring takes goes to appEvent, with its record; nothing logged as ignored", () => {
  const got: Array<[string, Record<string, unknown>]> = [];
  const { p, lines } = providers((h, r) => got.push([h, r]));
  p.deliver("swap", ev("token-enabled", { tokenId: "aa_0", beef: new Uint8Array([1, 2]) }));
  p.deliver("swap", ev("discovery-on"));
  assert.equal(got.length, 2);
  assert.equal(got[0]![0], "swap");
  assert.equal(got[0]![1].event, "token-enabled");
  assert.equal(got[0]![1].tokenId, "aa_0");
  assert.deepEqual(got[0]![1].beef, new Uint8Array([1, 2]));
  assert.equal(got[1]![1].event, "discovery-on");
  assert.ok(!lines.some((l) => /no wiring for/.test(l)), lines.join("\n"));
});

test("the stock names never reach appEvent: the libp2p node's go to topicEvent", () => {
  const got: string[] = [];
  const { p, lines } = providers((_h, r) => got.push(String(r.event)));
  p.deliver("tok", ev("beacon", { topic: "t", every: 1000, body: new Uint8Array() }));
  p.deliver("tok", ev("subscribe", { topic: "t", program: "x", fn: "y" }));
  assert.deepEqual(got, []);
  assert.equal(lines.filter((l) => l === "topicEvent").length, 2);
});

test("a throwing appEvent is logged, not thrown into the kernel's notice", () => {
  const { p, lines } = providers(() => { throw new Error("boom"); });
  p.deliver("swap", ev("token-disabled", { tokenId: "aa_0" }));
  assert.ok(lines.some((l) => /token-disabled: the host's wiring: boom/.test(l)), lines.join("\n"));
});

test("without appEvent: logged as ignored, as before", () => {
  const { p, lines } = providers();
  p.deliver("swap", ev("token-enabled", { tokenId: "aa_0" }));
  assert.ok(lines.some((l) => /an event token-enabled this host has no wiring for: ignored/.test(l)), lines.join("\n"));
});

test("Router: its appEvent option is the Providers'", async () => {
  const db = new HostDb(":memory:");
  const seen: string[] = [];
  const r = new Router({ db, walletFor: () => { throw new Error("unused"); }, cron: false, appEvent: (h, rec) => seen.push(`${h} ${String(rec.event)}`) });
  try {
    r.providers.deliver("swap", ev("token-enabled", { tokenId: "aa_0" }));
    assert.deepEqual(seen, ["swap token-enabled"]);
  } finally {
    await r.close();
    db.close();
  }
});

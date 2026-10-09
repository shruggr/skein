// An app's emitted events served to its page (#148, events.ts): GET
// /<app>/.events?event=<name>&topic=<t>… on the instance's origin, a
// Server-Sent Events stream — first the last event per topic (or, with
// Last-Event-ID, every one after it, folded from the log), then each as its
// step is committed; only that app's events of that name on those topics;
// nothing logged; closed at the app's uninstall. The apps are
// programs/test/app-demo's module under other names: a message {kind:
// "app-demo-event", event, …} in the app's box makes it emit that event.

import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RawBox } from "../client/raw.ts";
import { installApp, uninstallApp } from "../testapps.ts";
import { CID } from "multiformats/cid";
import { backlog, EventStreams, eventsQuery, placeOf, type Delivered } from "./events.ts";
import { SseStream, type SseEvent } from "./feeds.ts";
import { KERNEL_BIN } from "./kernel.ts";
import { testHost, until } from "./testhost.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("events: the query (event, topic repeated, Last-Event-ID) and what is sent first — the last per topic, or every one after the place", () => {
  const q = (s: string, last?: string) => eventsQuery("amm", new URLSearchParams(s), last);
  assert.deepEqual(q("event=price&topic=a&topic=b&topic=a"), { app: "amm", event: "price", topics: ["a", "b"] });
  assert.ok("problem" in q("topic=a"), "no event");
  assert.ok("problem" in q("event=price"), "no topic");
  assert.ok("problem" in q("event=price&topic="), "an empty topic");
  assert.ok("problem" in q("event=price&event=volume&topic=a"), "two names");
  assert.ok("problem" in q("event=price&topic=a", "nonsense"), "a Last-Event-ID that is no place");
  assert.equal((q("event=price&topic=a", "7.2.0.bafyabc") as { after: string }).after, "7.2.0.bafyabc");
  assert.deepEqual(placeOf("7.2.1.bafyabc"), { n: 7, seq: 2, i: 1, thread: "bafyabc" });

  const ev = (n: number, app: string, event: string, topic: string, i = 0): Delivered => ({ id: `${n}.1.${i}.bafyt${n}`, n, event, app, topic, data: JSON.stringify({ n, topic }) });
  const all = [ev(1, "amm", "price", "a"), ev(2, "amm", "price", "b"), ev(3, "amm", "price", "a"), ev(4, "other", "price", "a"), ev(5, "amm", "volume", "a"), ev(6, "amm", "price", "c"), ev(7, "amm", "price", "b"), ev(7, "amm", "price", "a", 1)];
  const ids = (ds: Delivered[]) => ds.map((d) => d.id);
  const base = { app: "amm", event: "price", topics: ["a", "b"] };
  assert.deepEqual(ids(backlog(all.slice(0, 6), base)), ["2.1.0.bafyt2", "3.1.0.bafyt3"], "the last per topic, in log order; other apps, names and topics left out");
  assert.deepEqual(ids(backlog(all, { ...base, topics: ["z"] })), [], "a topic with none: nothing");
  assert.deepEqual(ids(backlog(all, { ...base, after: "2.1.0.bafyt2" })), ["3.1.0.bafyt3", "7.1.0.bafyt7", "7.1.1.bafyt7"], "after the place: every one that matches");
  assert.deepEqual(ids(backlog(all, { ...base, after: "5.9.9.bafygone" })), ["7.1.0.bafyt7", "7.1.1.bafyt7"], "a place not in the log: the later entries'");
});

test("events: a live event is sent from the notice, its id from its place — no log read; one handed over again not sent again; one during the backlog after it", async () => {
  let opens = 0;
  const streams = new EventStreams({ open: () => { opens++; return undefined; } });
  const thread = CID.parse("bafyreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy");
  const rec = (topic: string, value: number) => ({ kind: "event", event: "price", app: "amm", topic, value });
  const got: string[] = [];
  const q = { app: "amm", event: "price", topics: ["a"] };
  const p = streams.subscribe("x", q, (d) => got.push(`${d.id} ${d.data}`), () => {});
  streams.emitted("x", rec("a", 1), { n: 5, seq: 2, i: 0, thread }); // while the backlog is read
  await p;
  streams.emitted("x", rec("a", 2), { n: 6, seq: 3, i: 0, thread });
  streams.emitted("x", rec("a", 2), { n: 6, seq: 3, i: 0, thread }); // handed over again (a start)
  streams.emitted("x", rec("b", 3), { n: 7, seq: 4, i: 0, thread });
  streams.emitted("x", { ...rec("a", 4), app: "other" }, { n: 7, seq: 4, i: 1, thread });
  assert.equal(opens, 1, "the log opened once, for the backlog");
  assert.deepEqual(got, [
    `5.2.0.${thread} {"app":"amm","event":"price","kind":"event","topic":"a","value":1}`,
    `6.3.0.${thread} {"app":"amm","event":"price","kind":"event","topic":"a","value":2}`,
  ]);
});

/** app-demo's module as app `name` (its box takes the owner's messages). */
function appTree(home: string, name: string): string {
  const dir = join(home, "apps", name);
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "etc"), { recursive: true });
  copyFileSync(join(ROOT, "programs/test/app-demo/bin/app-demo.wasm"), join(dir, "bin/app-demo.wasm"));
  writeFileSync(join(dir, "etc/app.json"), JSON.stringify({
    kind: "app", name, version: "0.1.0", programs: { demo: "bin/app-demo.wasm" }, provides: [], requires: [],
    routes: [{ address: "", handler: "demo" }],
    description: `#148's test app ${name}: app-demo's module, emitting the events it is asked to`,
  }));
  return dir;
}

test("events: GET /<app>/.events — the current value per topic, then live; only the app's, the name's, the topics'; Last-Event-ID resumes from the log; nothing logged; closed at uninstall", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built", timeout: 180_000 }, async (t) => {
  const h = await testHost(t);
  const alpha = h.instance("alpha");
  await h.router.start();
  await h.router.hydrate("alpha");
  const host = { home: h.home, port: h.router.port, owner: h.owner, settled: () => h.router.settled() };
  await installApp(host, "alpha", appTree(h.home, "ev-a"));
  await installApp(host, "alpha", appTree(h.home, "ev-b"));
  await h.router.settled();
  const box = new RawBox(h.owner, h.origin("alpha"));
  const emit = async (app: string, event: string, topic: string, value: number) => {
    await box.send(alpha, app, { kind: "app-demo-event", event, topic, value });
    await h.router.settled();
  };
  const url = (q: string, app = "ev-a") => `${h.base}/@alpha/${app}/.events?${q}`;

  // Before anyone listens: the log has them.
  await emit("ev-a", "price", "tok1", 1);
  await emit("ev-a", "price", "tok2", 2);
  await emit("ev-a", "price", "tok1", 3);
  await emit("ev-a", "price", "tok3", 9);

  // Refusals, answered without a stream.
  assert.equal((await fetch(url("topic=tok1"))).status, 400, "no event: 400");
  assert.equal((await fetch(url("event=price"))).status, 400, "no topic: 400");
  assert.equal((await fetch(url("event=price&topic=tok1"), { headers: { "last-event-id": "x" } })).status, 400, "a Last-Event-ID that is no place: 400");
  assert.equal((await fetch(url("event=price&topic=tok1", "ev-none"))).status, 404, "an app not installed: 404");

  type Got = { id: string; event: string; data: Record<string, unknown> };
  const got: Got[] = [];
  const opened = (into: Got[], q: string, o: { lastId?: string; app?: string } = {}) => {
    const s = new SseStream(url(q, o.app), (e: SseEvent) => { into.push({ id: e.id!, event: e.event!, data: JSON.parse(e.data) as Record<string, unknown> }); }, { backoff: { min: 100, max: 100 }, ...(o.lastId ? { lastId: o.lastId } : {}) }).start();
    t.after(() => s.stop());
    return s;
  };
  const vals = (gs: Got[]) => gs.map((g) => `${g.data.topic}=${g.data.value}`);
  const n0 = await h.entries("alpha");
  const s1 = opened(got, "event=price&topic=tok1&topic=tok2");
  await until("the current values", () => got.length >= 2 || undefined);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(vals(got), ["tok2=2", "tok1=3"], "first the last per topic, in log order (tok3 not asked for)");
  const [first] = got;
  assert.equal(first!.event, "price");
  assert.match(first!.id, /^\d+\.\d+\.\d+\.b[a-z2-7]+$/, `the id is the event's place <n>.<seq>.<i>.<thread>: ${first!.id}`);
  assert.deepEqual(first!.data, { kind: "event", event: "price", app: "ev-a", topic: "tok2", value: 2 }, "the record, as DAG-JSON");
  assert.equal(h.router.events.count("alpha"), 1, "one subscription open");
  assert.equal(await h.entries("alpha"), n0, "nothing logged for a subscription");

  // Live: only ev-a's price events on tok1 / tok2.
  await emit("ev-a", "price", "tok1", 4);
  await emit("ev-a", "price", "tok3", 5);
  await emit("ev-b", "price", "tok1", 101);
  await emit("ev-a", "volume", "tok1", 7);
  await emit("ev-a", "price", "tok2", 6);
  await until("the live events", () => got.length >= 4 || undefined);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(vals(got), ["tok2=2", "tok1=3", "tok1=4", "tok2=6"], "as each step is committed; another app's, another name's, another topic's not sent");
  const ids = got.map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length, "each id once");

  // A new subscription's current values (folded from the log) carry the ids the live ones had.
  const again: Got[] = [];
  const sa = opened(again, "event=price&topic=tok1&topic=tok2");
  await until("the current values again", () => again.length >= 2 || undefined);
  assert.deepEqual(again.map((g) => g.id), [got[2]!.id, got[3]!.id], "a live id is the log's id");
  await sa.stop();

  // Another app's stream: its own events only.
  const gotB: Got[] = [];
  const sb = opened(gotB, "event=price&topic=tok1", { app: "ev-b" });
  await until("ev-b's current value", () => gotB.length >= 1 || undefined);
  assert.deepEqual(gotB.map((g) => [g.data.app, g.data.value]), [["ev-b", 101]]);
  await sb.stop();

  // Disconnected: the next events are in the log; Last-Event-ID resumes after the one last seen.
  await s1.stop();
  await until("the subscription forgotten", () => h.router.events.count("alpha") === 0 || undefined, 5000);
  const lastSeen = got.find((g) => g.data.value === 4)!.id;
  await emit("ev-a", "price", "tok1", 8);
  const resumed: Got[] = [];
  const s2 = opened(resumed, "event=price&topic=tok1&topic=tok2", { lastId: lastSeen });
  await until("the events after the place", () => resumed.length >= 2 || undefined);
  await emit("ev-a", "price", "tok2", 10);
  await until("then live", () => resumed.length >= 3 || undefined);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(vals(resumed), ["tok2=6", "tok1=8", "tok2=10"], "after tok1=4: tok2=6 and tok1=8 from the log, then tok2=10 live");
  await s2.stop();

  // The app's uninstall closes its streams.
  const r = await fetch(url("event=price&topic=tok1"));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "text/event-stream");
  const text = (async () => { let s = ""; for await (const c of r.body as unknown as AsyncIterable<Uint8Array>) s += new TextDecoder().decode(c); return s; })();
  await until("open", () => h.router.events.count("alpha") === 1 || undefined, 5000);
  await uninstallApp(host, "alpha", "ev-a");
  await h.router.settled();
  const body = await Promise.race([text, new Promise<string>((_, rej) => setTimeout(() => rej(new Error("the stream stayed open after the uninstall")), 10_000))]);
  assert.match(body, /data: .*"value":8/, "it had the current value first");
  assert.equal(h.router.events.count("alpha"), 0, "dropped from the registry");
  assert.equal((await fetch(url("event=price&topic=tok1"))).status, 404, "uninstalled: 404");
});

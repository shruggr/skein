// The event index served by the host (0.5.0, events.ts): GET
// /events/<name path>?after&limit&latest on the instance's origin — the
// index read from the store, as JSON; with Accept: text/event-stream the same
// read, then live. Nothing logged. The apps are programs/test/app-demo's
// module under other names: a message {kind: "app-demo-event", event, …} in
// the app's box makes it emit that event (its name under the app's own).

import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RawBox } from "../client/raw.ts";
import { installApp } from "../testapps.ts";
import { CID } from "multiformats/cid";
import { EventStreams, eventsPath, eventsQuery, placeOf } from "./events.ts";
import { SseStream, type SseEvent } from "./feeds.ts";
import { KERNEL_BIN } from "./kernel.ts";
import { testHost, until } from "./testhost.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const T = "bafyreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";

test("events: the path (a name, or a prefix with a trailing /) and the query (after, limit, latest; Last-Event-ID)", () => {
  assert.equal(eventsPath("/amm/pools"), undefined, "not the host's");
  assert.deepEqual(eventsPath("/events/amm/pool/x"), { name: "amm/pool/x", prefix: false });
  assert.deepEqual(eventsPath("/events/amm/pool/"), { name: "amm/pool/", prefix: true });
  assert.deepEqual(eventsPath("/events/"), { name: "", prefix: true }, "every name");
  assert.deepEqual(eventsPath("/events/amm/a%2Fb"), { name: "amm/a/b", prefix: false }, "segments decoded");
  assert.ok("problem" in eventsPath("/events/amm//x")!, "an empty segment");
  assert.ok("problem" in eventsPath("/events/amm/a%20b")!, "a space");
  const q = (route: string, s: string, last?: string) => eventsQuery(route, new URLSearchParams(s), last);
  assert.deepEqual(q("/events/amm/pool/", "limit=5&latest=1"), { name: "amm/pool/", prefix: true, limit: 5, latest: true });
  assert.ok("problem" in q("/events/amm/x", "limit=0")!, "limit 0");
  assert.ok("problem" in q("/events/amm/x", "latest=yes")!, "latest");
  assert.ok("problem" in q("/events/amm/x", "after=nonsense")!, "an after that is no place");
  const after = q("/events/amm/x", "after=1.1." + T, `7.0.${T}`) as unknown as { after: { s: number } };
  assert.equal(after.after.s, 7, "Last-Event-ID wins over after");
  assert.deepEqual(placeOf(`7.1.${T}`), { s: 7, i: 1, thread: CID.parse(T) });
  assert.equal(placeOf(`7.2.1.${T}`), undefined, "0.8.0: a four-part id (n.seq.i.thread) of before is no place");
});

test("events: a live event is sent from the notice, its id from its place — no store read; an intention or another name not; one handed over again not sent again; one during the read after it", async () => {
  let opens = 0;
  const streams = new EventStreams({ open: () => { opens++; return undefined; } });
  const thread = CID.parse(T);
  const rec = (event: string, value: number, app = "amm") => ({ kind: "event", event, app, value });
  const got: string[] = [];
  const p = streams.subscribe("x", { name: "amm/price/", prefix: true }, (d) => got.push(`${d.id} ${d.event} ${d.data}`), () => {});
  streams.emitted("x", rec("amm/price/a", 1), { s: 5, i: 0, thread }); // while the read runs
  await p;
  streams.emitted("x", rec("amm/price/a", 2), { s: 6, i: 0, thread });
  streams.emitted("x", rec("amm/price/a", 2), { s: 6, i: 0, thread }); // handed over again (a start)
  streams.emitted("x", rec("amm/volume/a", 3), { s: 7, i: 0, thread });
  streams.emitted("x", rec("subscribe", 4), { s: 7, i: 1, thread });
  streams.emitted("x", rec("amm/price/b", 5, "other"), { s: 7, i: 2, thread }); // not under its app: no fact
  assert.equal(opens, 1, "the store opened once, for the read");
  assert.deepEqual(got, [
    `5.0.${thread} amm/price/a {"app":"amm","event":"amm/price/a","kind":"event","value":1}`,
    `6.0.${thread} amm/price/a {"app":"amm","event":"amm/price/a","kind":"event","value":2}`,
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
    description: `0.5.0's test app ${name}: app-demo's module, emitting the events it is asked to`,
  }));
  return dir;
}

test("events: GET /events/<name path> — the index read from the store (name, prefix, after, limit, latest), the same as a stream then live, Last-Event-ID resumes; nothing logged", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built", timeout: 180_000 }, async (t) => {
  const h = await testHost(t);
  const alpha = h.instance("alpha");
  await h.router.start();
  await h.router.hydrate("alpha");
  const host = { home: h.home, port: h.router.port, owner: h.owner, settled: () => h.router.settled() };
  await installApp(host, "alpha", appTree(h.home, "eva"));
  await installApp(host, "alpha", appTree(h.home, "evb"));
  await h.router.settled();
  const box = new RawBox(h.owner, h.origin("alpha"));
  const emit = async (app: string, event: string, value: number) => {
    await box.send(alpha, app, { kind: "app-demo-event", event, value });
    await h.router.settled();
  };
  const url = (path: string, q = "") => `${h.base}/@alpha/events/${path}${q ? `?${q}` : ""}`;
  type Row = { id: string; event: string; record: Record<string, unknown> };
  const read = async (path: string, q = ""): Promise<Row[]> => { const r = await fetch(url(path, q)); assert.equal(r.status, 200, `${path}?${q}`); return await r.json() as Row[]; };
  const vals = (rs: Array<{ event: string; record?: Record<string, unknown>; data?: Record<string, unknown> }>) => rs.map((r) => `${r.event}=${(r.record ?? r.data)!.value}`);

  await emit("eva", "eva/price/tok1", 1);
  await emit("eva", "eva/price/tok2", 2);
  await emit("eva", "eva/price/tok1", 3);
  await emit("evb", "evb/price/tok1", 9);

  const n0 = await h.entries("alpha");
  assert.deepEqual(vals(await read("eva/price/tok1")), ["eva/price/tok1=1", "eva/price/tok1=3"], "a name: its events, newest last");
  assert.deepEqual(vals(await read("eva/price/")), ["eva/price/tok1=1", "eva/price/tok2=2", "eva/price/tok1=3"], "a prefix: every name it starts, in log order");
  assert.deepEqual(vals(await read("eva/price/", "latest=1")), ["eva/price/tok2=2", "eva/price/tok1=3"], "latest: the last per name");
  assert.deepEqual(vals(await read("", "limit=2")), ["eva/price/tok1=1", "eva/price/tok2=2"], "every name, the first two");
  const all = await read("eva/");
  assert.match(all[0]!.id, /^\d+\.\d+\.b[a-z2-7]+$/, `the id is the event's place <s>.<i>.<thread>: ${all[0]!.id}`);
  assert.deepEqual(all[0]!.record, { kind: "event", event: "eva/price/tok1", app: "eva", value: 1 }, "the record, as DAG-JSON");
  assert.deepEqual(vals(await read("eva/", `after=${all[0]!.id}`)), ["eva/price/tok2=2", "eva/price/tok1=3"], "after the place");
  assert.equal((await fetch(url("eva//x"))).status, 400, "a bad name: 400");
  assert.equal((await fetch(url("eva/x", "after=nope"))).status, 400, "an after that is no place: 400");
  assert.deepEqual(await read("nobody/"), [], "no events: none");
  assert.equal(await h.entries("alpha"), n0, "nothing logged for a read");

  // The stream: the same read, then live.
  type Got = { id: string; event: string; data: Record<string, unknown> };
  const opened = (into: Got[], path: string, q = "", lastId?: string) => {
    const s = new SseStream(url(path, q), (e: SseEvent) => { into.push({ id: e.id!, event: e.event!, data: JSON.parse(e.data) as Record<string, unknown> }); }, { backoff: { min: 100, max: 100 }, ...(lastId ? { lastId } : {}) }).start();
    t.after(() => s.stop());
    return s;
  };
  const got: Got[] = [];
  const s1 = opened(got, "eva/price/", "latest=1");
  await until("the current values", () => got.length >= 2 || undefined);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(vals(got), ["eva/price/tok2=2", "eva/price/tok1=3"]);
  assert.equal(h.router.events.count("alpha"), 1, "one stream open");
  await emit("eva", "eva/price/tok1", 4);
  await emit("eva", "eva/volume/tok1", 5);
  await emit("evb", "evb/price/tok1", 101);
  await emit("eva", "eva/price/tok2", 6);
  await until("the live events", () => got.length >= 4 || undefined);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(vals(got), ["eva/price/tok2=2", "eva/price/tok1=3", "eva/price/tok1=4", "eva/price/tok2=6"], "live: only the names under the prefix");
  const live = await read("eva/price/");
  assert.deepEqual(live.slice(-2).map((r) => r.id), [got[2]!.id, got[3]!.id], "a live id is the index's id");
  await s1.stop();
  await until("the stream forgotten", () => h.router.events.count("alpha") === 0 || undefined, 5000);
  await emit("eva", "eva/price/tok1", 8);
  const resumed: Got[] = [];
  const s2 = opened(resumed, "eva/price/", "", got[2]!.id);
  await until("the events after the place", () => resumed.length >= 2 || undefined);
  await emit("eva", "eva/price/tok2", 10);
  await until("then live", () => resumed.length >= 3 || undefined);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(vals(resumed), ["eva/price/tok2=6", "eva/price/tok1=8", "eva/price/tok2=10"], "after tok1=4: from the index, then live");
  await s2.stop();
});

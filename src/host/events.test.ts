// The event index served by the host (0.5.0, events.ts): GET
// /events/<name path>?after&limit&latest on the instance's origin — the
// index read from the store, as JSON; with Accept: text/event-stream the same
// read, then live. Nothing logged. The app is programs/test/next-app: its
// handler at the root row /ping emits the fact next/ping.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { CID } from "multiformats/cid";
import { EventStreams, eventsPath, eventsQuery, placeOf } from "./events.ts";
import { SseStream, type SseEvent } from "./feeds.ts";
import { imageTree, NEXT_APP, testHost, until } from "./testhost.ts";

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

test("events: GET /events/<name path> — the index read from the store (name, prefix, after, limit, latest), the same as a stream then live, Last-Event-ID resumes; nothing logged", { timeout: 180_000 }, async (t) => {
  const h = await testHost(t);
  // The test app (its handle emits next/ping at the root row /ping).
  const img = await imageTree(join(h.home, "img"), { apps: [NEXT_APP], appRoutes: [{ kind: "request", path: "/ping", role: "user", handler: "next.main.handle" }] });
  await h.instance("alpha", img);
  await h.router.start();
  const emit = async () => { await h.request("alpha", "POST", "/ping", {}); await h.router.settled(); };
  const url = (path: string, q = "") => `${h.base}/@alpha/events/${path}${q ? `?${q}` : ""}`;
  type Row = { id: string; event: string; record: Record<string, unknown> };
  const read = async (path: string, q = ""): Promise<Row[]> => { const r = await fetch(url(path, q)); assert.equal(r.status, 200, `${path}?${q}`); return await r.json() as Row[]; };

  for (let i = 0; i < 3; i++) await emit();
  const n0 = await h.entries("alpha");
  const all = await read("next/ping");
  assert.equal(all.length, 3, "a name: its events");
  assert.equal((await read("next/")).length, 3, "a prefix: every name it starts");
  assert.equal((await read("next/", "latest=1")).length, 1, "latest: the last per name");
  assert.equal((await read("", "limit=2")).length, 2);
  assert.match(all[0]!.id, /^\d+\.\d+\.b[a-z2-7]+$/, `the id is the event's place <s>.<i>.<thread>: ${all[0]!.id}`);
  assert.deepEqual(all[0]!.record, { kind: "event", event: "next/ping", app: "next" }, "the record, as DAG-JSON");
  assert.deepEqual((await read("next/", `after=${all[0]!.id}`)).map((r) => r.id), all.slice(1).map((r) => r.id), "after the place");
  assert.equal((await fetch(url("next//x"))).status, 400);
  assert.equal((await fetch(url("next/x", "after=nope"))).status, 400);
  assert.deepEqual(await read("nobody/"), []);
  assert.equal(await h.entries("alpha"), n0, "nothing logged for a read");

  // The stream: the same read, then live; Last-Event-ID resumes.
  const got: SseEvent[] = [];
  const s1 = new SseStream(url("next/"), (e: SseEvent) => { got.push(e); }, { backoff: { min: 100, max: 100 } }).start();
  t.after(() => s1.stop());
  await until("the current events", () => got.length >= 3 || undefined);
  assert.equal(h.router.events.count("alpha"), 1, "one stream open");
  await emit();
  await until("the live event", () => got.length >= 4 || undefined);
  assert.equal(got[3]!.id, (await read("next/ping")).at(-1)!.id, "a live id is the index's id");
  await s1.stop();
  await until("the stream forgotten", () => h.router.events.count("alpha") === 0 || undefined, 5000);
  const resumed: SseEvent[] = [];
  const s2 = new SseStream(url("next/"), (e: SseEvent) => { resumed.push(e); }, { backoff: { min: 100, max: 100 }, lastId: got[1]!.id! }).start();
  t.after(() => s2.stop());
  await until("the events after the place", () => resumed.length >= 2 || undefined);
  assert.deepEqual(resumed.map((e) => e.id), got.slice(2, 4).map((e) => e.id));
  await s2.stop();
});

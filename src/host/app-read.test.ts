// An application host's reads (RouterOptions.appRead, open-exchange 0.11.0): a GET for an instance is
// offered to the host after the host's own reads there and before the instance's program; undefined
// falls through (forwarded as before); an answer with `stream` is held open on a socket.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router, type RouterRequest } from "./router.ts";
import { HostDb } from "./instances.ts";

const enc = (s: string) => new TextEncoder().encode(s);

function host(appRead: NonNullable<ConstructorParameters<typeof Router>[0]["appRead"]>) {
  const home = mkdtempSync(join(tmpdir(), "skein-app-read-"));
  const db = new HostDb(join(home, "host.db"));
  db.add("alpha", { store: join(home, "alpha.db") });
  const r = new Router({ db, walletFor: () => { throw new Error("unused"); }, cron: false, home, rootInstance: "alpha", appRead });
  return { r, db, done: async () => { await r.close(); db.close(); rmSync(home, { recursive: true, force: true }); } };
}

const get = (r: Router, path: string): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }> =>
  r.dispatch({ method: "GET", url: `${r.origin()}${path}`, headers: {}, body: new Uint8Array() });

test("appRead answers its route (at /@<handle>/ and at the root instance's hostname); another route falls through to the instance", async () => {
  const asked: Array<[string, string, string]> = [];
  const h = host(async (handle, route, url, req: RouterRequest) => {
    asked.push([handle, route, req.method]);
    if (route === "/amm/pools") return { status: 200, headers: { "content-type": "application/json" }, body: enc(JSON.stringify({ handle, q: url.searchParams.get("q") })) };
    return undefined;
  });
  try {
    const a = await get(h.r, "/@alpha/amm/pools?q=1");
    assert.equal(a.status, 200);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(a.body)), { handle: "alpha", q: "1" });
    const b = await get(h.r, "/amm/pools");
    assert.equal(b.status, 200, "the root instance's hostname: the same read");
    // Not the host's: forwarded to the instance (which has no store here: the forward's own 503, not appRead's answer).
    const c = await get(h.r, "/@alpha/amm/other");
    assert.notEqual(c.status, 200);
    assert.deepEqual(asked.map((x) => x[1]), ["/amm/pools", "/amm/pools", "/amm/other"]);
    // A POST is never offered; nor are the host's own reads (the instance card).
    await h.r.dispatch({ method: "POST", url: `${h.r.origin()}/@alpha/amm/pools`, headers: {}, body: new Uint8Array() });
    await get(h.r, "/@alpha/.well-known/skein");
    assert.equal(asked.length, 3);
  } finally { await h.done(); }
});

test("an answer with `stream`: held open on a socket, chunks written as sent, forgotten when the client goes", async () => {
  let sendNow: ((c: string) => void) | undefined;
  let forgotten = 0;
  const h = host(async (_handle, route) => {
    if (route !== "/amm/pools") return undefined;
    return {
      status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }, body: new Uint8Array(),
      stream: (send) => { send("event: pools\ndata: 1\n\n"); sendNow = send; return () => { forgotten++; }; },
    };
  });
  try {
    await h.r.listen(0);
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${h.r.port}/@alpha/amm/pools`, { headers: { accept: "text/event-stream" }, signal: ac.signal });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.equal(first, "event: pools\ndata: 1\n\n");
    sendNow!("event: pools\ndata: 2\n\n");
    assert.equal(new TextDecoder().decode((await reader.read()).value), "event: pools\ndata: 2\n\n");
    ac.abort();
    for (let i = 0; i < 50 && !forgotten; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(forgotten, 1, "the stream forgotten once the client went");
  } finally { await h.done(); }
});

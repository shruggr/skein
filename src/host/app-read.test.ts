// An application host's requests (RouterOptions.appRead, open-exchange 0.11.0; every method since
// 0.3.2, with req.signal on a socket's request): a request for an instance is
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
    // 0.3.2: every method is offered (the hook reads req.method); the host's own reads (the instance card) are not.
    await h.r.dispatch({ method: "POST", url: `${h.r.origin()}/@alpha/amm/pools`, headers: {}, body: new Uint8Array() });
    await get(h.r, "/@alpha/.well-known/skein");
    assert.deepEqual(asked.slice(3), [["alpha", "/amm/pools", "POST"]]);
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

test("0.3.2: a POST served by the application host on a socket; req.signal unfired after its answer, fired when the client goes first", async () => {
  const seen: Array<{ method: string; body: string; signal?: AbortSignal }> = [];
  let release: (() => void) | undefined;
  const h = host(async (_handle, route, _url, req) => {
    if (route === "/amm/swap" && req.method === "POST") {
      seen.push({ method: req.method, body: new TextDecoder().decode(req.body), signal: req.signal });
      return { status: 200, headers: { "content-type": "application/json" }, body: enc(JSON.stringify({ ok: true })) };
    }
    if (route === "/amm/hold" && req.method === "POST") {
      seen.push({ method: req.method, body: new TextDecoder().decode(req.body), signal: req.signal });
      await new Promise<void>((r) => { release = r; req.signal?.addEventListener("abort", () => r()); });
      return { status: 200, headers: { "content-type": "text/plain" }, body: enc("late") };
    }
    return undefined;
  });
  try {
    await h.r.listen(0);
    const res = await fetch(`http://127.0.0.1:${h.r.port}/@alpha/amm/swap`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ funding: "x" }) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(seen[0]!.body, JSON.stringify({ funding: "x" }));
    assert.ok(seen[0]!.signal, "a socket's request carries a signal");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(seen[0]!.signal!.aborted, false, "unfired after a normal answer");
    // A client that leaves before the answer: the signal fires.
    const ac = new AbortController();
    const p = fetch(`http://127.0.0.1:${h.r.port}/@alpha/amm/hold`, { method: "POST", body: "y", signal: ac.signal }).catch((e: Error) => e);
    for (let i = 0; i < 100 && seen.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(seen.length, 2, "the held request reached the hook");
    assert.equal(seen[1]!.signal!.aborted, false);
    ac.abort();
    await p;
    for (let i = 0; i < 100 && !seen[1]!.signal!.aborted; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(seen[1]!.signal!.aborted, true, "fired when the client's connection closed first");
    assert.match(String((seen[1]!.signal!.reason as Error).message), /the client closed the connection/);
    release?.();
    // In process: no signal.
    let inProc: AbortSignal | undefined | null = null;
    const h2 = host(async (_h, _r, _u, req) => { inProc = req.signal; return { status: 204, headers: {}, body: new Uint8Array() }; });
    try { await h2.r.dispatch({ method: "POST", url: `${h2.r.origin()}/@alpha/amm/swap`, headers: {}, body: new Uint8Array() }); } finally { await h2.done(); }
    assert.equal(inProc, undefined);
  } finally { await h.done(); }
});

// The router's real HTTP (SKEIN_HTTP=fetch, fetchHttp) applies a wasi:http
// request's options (#15): they are recorded with the request in
// nanoseconds; connect + first-byte bound the wait for the response head,
// between-bytes each read of the body. Against a local server only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fetchHttp } from "./router.ts";

const MS = 1_000_000;

test("fetchHttp: a plain request, and the options' timeouts", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/slow-head") { setTimeout(() => res.end("late"), 500); return; }
    if (req.url === "/stall") { res.write("first "); setTimeout(() => res.end("second"), 500); return; }
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => { res.setHeader("x-echo", req.headers["x-test"] ?? ""); res.end(`${req.method} ${body}`); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const ok = await fetchHttp({ method: "POST", url: `${base}/echo`, headers: { "x-test": "yes" }, body: new TextEncoder().encode("hi") });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers["x-echo"], "yes");
    assert.equal(Buffer.from(ok.body).toString(), "POST hi");

    await assert.rejects(fetchHttp({ method: "GET", url: `${base}/slow-head`, options: { firstByteTimeout: 50 * MS } }));
    const patient = await fetchHttp({ method: "GET", url: `${base}/slow-head`, options: { firstByteTimeout: 5000 * MS } });
    assert.equal(Buffer.from(patient.body).toString(), "late");

    await assert.rejects(fetchHttp({ method: "GET", url: `${base}/stall`, options: { betweenBytesTimeout: 50 * MS } }), /between bytes/);
    const whole = await fetchHttp({ method: "GET", url: `${base}/stall`, options: { betweenBytesTimeout: 5000 * MS } });
    assert.equal(Buffer.from(whole.body).toString(), "first second");
  } finally {
    server.close();
  }
});

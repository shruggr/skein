// The HTTP proxy's real network (#70: the `fetch` provider; SKEIN_HTTP=fetch,
// fetchHttp): a request as a program emits it, {method, url, headers?, body?,
// timeoutMs?, maxBytes?}; `timeoutMs` bounds the whole exchange, `maxBytes`
// (#91) the response body. Against a local server only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fetchHttp } from "./router.ts";

test("fetchHttp: a plain request, its timeout, its maxBytes", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/slow") { setTimeout(() => res.end("late"), 500); return; }
    if (req.url === "/big") { res.write("x".repeat(64 * 1024)); res.end("y".repeat(64 * 1024)); return; }
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

    await assert.rejects(fetchHttp({ method: "GET", url: `${base}/slow`, timeoutMs: 50 }));
    const patient = await fetchHttp({ method: "GET", url: `${base}/slow`, timeoutMs: 5000 });
    assert.equal(Buffer.from(patient.body).toString(), "late");

    // maxBytes: a body over it is refused, one at it carried whole.
    await assert.rejects(fetchHttp({ method: "GET", url: `${base}/big`, maxBytes: 100_000 }), /larger than maxBytes \(100000 bytes\)/);
    const whole = await fetchHttp({ method: "GET", url: `${base}/big`, maxBytes: 128 * 1024 });
    assert.equal(whole.body.length, 128 * 1024);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

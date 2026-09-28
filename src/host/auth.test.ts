import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { test } from "node:test";
import { AuthFetch, PrivateKey } from "@bsv/sdk";
import { ephemeralWallet } from "../wallet.ts";
import { AuthServer, send } from "./auth.ts";

test("BRC-104: AuthFetch against the router's auth server, JSON and binary bodies", async () => {
  const auth = new AuthServer(ephemeralWallet(PrivateKey.fromRandom()));
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      void auth.handle(req, res, new Uint8Array(Buffer.concat(chunks)), async (r) => {
        if (r.path === "/echo") return { status: 200, body: { who: r.identityKey, got: new TextDecoder().decode(r.body) } };
        if (r.path === "/bin") return { status: 200, type: "application/cbor", body: Uint8Array.of(...r.body, 0xff) };
        return { status: 404, body: { status: "error" } };
      }).catch((e) => send(res, { status: 500, body: String(e) }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const clientKey = PrivateKey.fromRandom();
    const f = new AuthFetch(ephemeralWallet(clientKey));
    const r1 = await f.fetch(`http://127.0.0.1:${port}/echo?x=1`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ a: 1 }) });
    assert.equal(r1.status, 200);
    assert.deepEqual(await r1.json(), { who: clientKey.toPublicKey().toString(), got: '{"a":1}' });
    const r2 = await f.fetch(`http://127.0.0.1:${port}/bin`, { method: "POST", headers: { "content-type": "application/cbor" }, body: Uint8Array.of(1, 2, 3) });
    assert.deepEqual([...new Uint8Array(await r2.arrayBuffer())], [1, 2, 3, 0xff]);
    const r3 = await fetch(`http://127.0.0.1:${port}/echo`, { method: "POST" });
    assert.equal(r3.status, 401);
  } finally {
    server.close();
  }
});

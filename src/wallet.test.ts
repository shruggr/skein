import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PrivateKey, ProtoWallet } from "@bsv/sdk";
import { signMessage, verifyMessage } from "./runtime/records.ts";
import { connectWallet, ephemeralWallet, identityOf, remoteWallet, rootIdentity, signerFor } from "./wallet.ts";

const HEX = /^0[23][0-9a-f]{64}$/;

test("wallet: identities are stable, distinct per name, and not the root", async () => {
  const w = await connectWallet({ kind: "ephemeral" });
  const a = await identityOf(w, "inference");
  assert.match(a, HEX);
  assert.equal(await identityOf(w, "inference"), a);
  assert.equal(identityOf(w, "inference"), identityOf(w, "inference")); // memoised: one lookup per name
  const b = await identityOf(w, "execution");
  const root = await rootIdentity(w);
  assert.match(root, HEX);
  assert.equal(new Set([a, b, root]).size, 3);
  assert.notEqual(await identityOf(ephemeralWallet(), "inference"), a); // another key, another identity

  const s = await signerFor(w, "inference");
  assert.equal(s.identity, a);
  await assert.rejects(w.createAction({ description: "nope, not here", outputs: [] }), /not supported/);
});

// The wallet-api wire protocol (`1sat serve wallet-api`): POST /<method>, JSON
// in and out, refusals as 400 {"error"}. Backed here by a ProtoWallet.
function walletApi(backing: ProtoWallet, deny?: string) {
  const origins: string[] = [];
  const server: Server = createServer(async (req, res) => {
    origins.push(String(req.headers.origin));
    let body = "";
    for await (const c of req) body += c;
    const method = (req.url ?? "/").slice(1) as keyof ProtoWallet;
    res.setHeader("content-type", "application/json");
    try {
      if (deny) throw new Error(deny);
      const out = await (backing[method] as (a: unknown) => Promise<unknown>).call(backing, body ? JSON.parse(body) : {});
      res.end(JSON.stringify(out));
    } catch (e) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  });
  return new Promise<{ url: string; origins: string[]; close(): Promise<void> }>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      origins,
      close: () => new Promise((r) => server.close(() => r())),
    })));
}

test("wallet: remote BRC-100 endpoint end to end — same identities as the backing wallet, signatures verify", async () => {
  const backing = new ProtoWallet(PrivateKey.fromRandom());
  const api = await walletApi(backing);
  try {
    const w = await connectWallet({ kind: "remote", url: api.url });
    const id = await identityOf(w, "admin");
    assert.equal(id, await identityOf(backing, "admin"));
    assert.equal(await rootIdentity(w), await rootIdentity(backing));
    assert.equal(await identityOf(remoteWallet(api.url), "admin"), id); // stable across reconnects

    const m = await signMessage(await signerFor(w, "admin"), { seq: 0, body: { kind: "tick" }, at: 1 });
    assert.equal(m.from, id);
    assert.equal(await verifyMessage(m), true);
    // Deterministic (RFC 6979): the remote and the local wallet sign identically.
    const local = await signMessage(await signerFor(backing, "admin"), { seq: 0, body: { kind: "tick" }, at: 1 });
    assert.deepEqual(local.sig, m.sig);
    assert.ok(api.origins.every((o) => o === "http://skein"));
  } finally {
    await api.close();
  }
});

test("wallet: a remote refusal keeps its message", async () => {
  const deny = "permission denied for skein: run `1sat permissions grant skein --protocol skein --level 1` and retry";
  const api = await walletApi(new ProtoWallet(PrivateKey.fromRandom()), deny);
  try {
    const w = remoteWallet(api.url);
    await assert.rejects(identityOf(w, "admin"), (e: Error) => e.message === `wallet: ${deny}`);
    await assert.rejects(identityOf(w, "admin"), /permission denied/); // the failure was not memoised
  } finally {
    await api.close();
  }
});

test("wallet: node wallet wants a key from the host", async () => {
  const had = process.env.PRIVATE_KEY_WIF;
  delete process.env.PRIVATE_KEY_WIF;
  try {
    await assert.rejects(connectWallet({ kind: "node", storage: ":memory:" }), /PRIVATE_KEY_WIF/);
  } finally {
    if (had !== undefined) process.env.PRIVATE_KEY_WIF = had;
  }
});

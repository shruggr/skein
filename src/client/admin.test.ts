// Root's requests (skein next, admin.ts): the kernel operations' bodies at their rows; host.env and the
// operator's key; a request signed in the client's own process (the `signed` scheme).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { PrivateKey, ProtoWallet } from "@bsv/sdk";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planClaim, planGrant, planGrantCalls, planRoute } from "./admin.ts";
import { requestPayload, signedPreimage, signRequest } from "./raw.ts";
import { identityOf, operatorKey, withHostEnv } from "../host/hostenv.ts";
import { keyWallet } from "../wallet.ts";

const KEY = `02${"ab".repeat(32)}`;

/** A view with no store: what the plans read of an instance (the route table, the heads). */
const view = (dispatch: unknown[] = []) => ({ store: { get: async () => { throw new Error("none"); }, has: async () => false, bytes: async () => { throw new Error("none"); }, putBlock: async () => {} }, identity: KEY, heads: [], dispatch }) as never;

test("planRoute / planGrant / planClaim: the kernel operations' bodies at their rows (a key as bytes)", async () => {
  const row = { kind: "read", path: "/", prefix: true, role: "anyone", handler: "kernel.route" };
  await assert.rejects(planRoute(view(), "add", row as never), /a kernel operation is a request row's/);
  const g = await planGrant(view(), KEY, { role: "next.admin" });
  assert.deepEqual(g.requests.map((r) => r.path), ["/kernel/grant"]);
  assert.deepEqual(g.requests[0]!.body, { op: "add", role: "next.admin", principal: Uint8Array.from(Buffer.from(KEY, "hex")) });
  const c = planGrantCalls(view(), "amm", "signer", "*");
  assert.deepEqual(c.requests[0]!.body, { op: "add", calls: { caller: "amm", callee: "signer", name: "*" } });
  assert.deepEqual(planClaim(KEY, { handle: "h", domain: "d" }).requests, [{ path: "/kernel/claim", body: { handle: "h", domain: "d" } }]);
  const rem = await planRoute(view([{ kind: "request", path: "/x", role: "user", handler: "a.f" }]), "remove", { kind: "request", path: "/x", role: "user", handler: "a.f" } as never);
  assert.deepEqual(rem.requests.map((r) => [r.path, (r.body as { op: string }).op]), [["/kernel/route", "remove"]]);
});

test("host.env (#142): every SKEIN_* line, quotes and comments stripped, the environment wins; the operator's key made once, 0600", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "skein-hostenv-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, "host.env"), "# the host\nSKEIN_ROUTER_ORIGIN=https://id.example.com\nexport SKEIN_HANDLE_DOMAIN='example.com'\nSKEIN_HOST_NAME=\"A host\"\nSKEIN_ROUTER_PORT=8100 # the port\nOTHER=1\n");
  const v = withHostEnv({ SKEIN_HOME: home, SKEIN_ROUTER_PORT: "9000" });
  assert.deepEqual([v.SKEIN_ROUTER_ORIGIN, v.SKEIN_HANDLE_DOMAIN, v.SKEIN_HOST_NAME, v.SKEIN_ROUTER_PORT, v.OTHER], ["https://id.example.com", "example.com", "A host", "9000", undefined]);
  assert.throws(() => operatorKey(v), /no operator key/);
  const made = operatorKey(v, { create: true });
  assert.equal(made.made, true);
  assert.equal(statSync(made.path).mode & 0o777, 0o600);
  const again = operatorKey(v, { create: true });
  assert.deepEqual([again.made, identityOf(again.key)], [false, identityOf(made.key)]);
  const wif = join(home, "wif.key");
  writeFileSync(wif, `${made.key.toWif()}\n`);
  assert.equal(identityOf(operatorKey({ SKEIN_HOME: home, SKEIN_OPERATOR_KEY: wif }).key), identityOf(made.key), "a WIF key file reads as the same key");
});

test("signRequest (SPEC 2, the `signed` scheme): sender, recipient, nonce, payload — signed by the key over {sender, recipient, nonce, payload}, BRC-169's way", async () => {
  const key = PrivateKey.fromRandom();
  const r = await signRequest(keyWallet(key), { recipient: KEY, payload: requestPayload("POST", "/kernel/grant", { op: "add" }) });
  const sig = r.signature as { scheme: string; sender: Uint8Array; recipient: Uint8Array; nonce: Uint8Array; signature: Uint8Array };
  assert.deepEqual([sig.scheme, Buffer.from(sig.sender).toString("hex"), Buffer.from(sig.recipient).toString("hex"), sig.nonce.length], ["signed", key.toPublicKey().toString(), KEY, 16]);
  assert.equal(r.payload.headers["content-type"], "application/cbor");
  const ok = await new ProtoWallet("anyone").verifySignature({ protocolID: [2, "metanet handles envelope"], keyID: "send", counterparty: key.toPublicKey().toString(), data: [...signedPreimage(sig.sender, sig.recipient, sig.nonce, r.payload)], signature: [...sig.signature], forSelf: false });
  assert.equal(ok.valid, true);
});

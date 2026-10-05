// The host skein, the instance manager and the onboarding app (#90), end to
// end on a host as `skein-host run` runs it (runHost: the signer over a
// master secret, the control socket, the providers):
//
//   `skein-host init --owner <operator>` creates the host skein from the
//   default image, claimed for the operator, the instance manager in its
//   address book; a second `init` only says which it is; `skein-host list`
//   names it `host`. The operator installs the onboarding app
//   (shruggr/skein-onboard at src/testapps.ts's pinned commit, or
//   $SKEIN_ONBOARD_DIR) into it as the owner's messages (`skein plan install`, #124).
//
//   A client — a wallet with a BRC-104 session to the host skein, nothing
//   else — POSTs {fn: "onboard.create", args: {handle: "alice"}} to
//   /onboard/call. The answer {handle, identity, url} comes on the same
//   connection: the onboarding app's thread asked the instance manager, which
//   created alice from the default image and delivered the client's claim
//   (alice's first entry after its genesis) before publishing her hostname.
//   alice serves the management site at her URL, is claimed for the client's key,
//   and the client installs programs/test/app-demo into her and calls it. The
//   host skein records her under onboard/instances/alice (the manager's
//   answer record). A second create of "alice" is refused (409, the
//   manager's answer); a request with no session is refused. alice's address
//   book has no instance manager. alice resolves by BRC-169 (#100, #113):
//   the host skein's app answers it from its record of her certificate (the
//   create's thread had the certifier sign it); the manifest names the
//   certifier key, and the SDK verifies the certificate.
//
// Both stores then replay to themselves exactly.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/host.ts

import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Certificate, PrivateKey } from "@bsv/sdk";
import type { CID } from "multiformats/cid";
import { RawBox } from "../../src/client/raw.ts";
import { main, runHost, type Env } from "../../src/host/cli.ts";
import { HostDb } from "../../src/host/instances.ts";
import { masterKey, Signer } from "../../src/host/signer.ts";
import { openStoreFile } from "../../src/runtime/index-store.ts";
import { appCheckout, ONBOARD_APP, ownerCli } from "../../src/testapps.ts";
import { ephemeralWallet } from "../../src/wallet.ts";
import type { WalletInterface } from "@bsv/sdk";

const here = dirname(fileURLToPath(import.meta.url));
const demoDir = join(here, "../../programs/test/app-demo");
let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };
const hex = (b: unknown) => b instanceof Uint8Array ? Buffer.from(b).toString("hex") : String(b);

/** A free TCP port on the loopback (the host's port is fixed before init: a genesis names its origin). */
const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});

const home = await fs.mkdtemp(join(tmpdir(), "skein-host-"));
const port = await freePort();
const operatorKey = PrivateKey.fromRandom(), operatorId = operatorKey.toPublicKey().toString();
const operator = ephemeralWallet(operatorKey);
const clientKey = PrivateKey.fromRandom(), clientId = clientKey.toPublicKey().toString();
const client = ephemeralWallet(clientKey);
const base = `http://127.0.0.1:${port}`;
const vars: Env["vars"] = {
  SKEIN_HOME: home, HOME: home, SKEIN_ROUTER_PORT: String(port), SKEIN_HOST_PORT: "0",
  // An instance's origin in the /@<handle> form: what the manager answers as its url, fetchable here.
  SKEIN_INSTANCE_ORIGIN: "http://127.0.0.1:{port}/@{handle}",
};
const lines: string[] = [];
const out = (l: string) => { lines.push(l); if (process.env.VERBOSE) process.stdout.write(`  | ${l}\n`); };
/** `skein-host <args>` as `who` (the owner's wallet for install/deploy), with SKEIN_OWNER = who's key. */
const cli = async (args: string[], who?: { wallet: WalletInterface; id: string }) => {
  const o: string[] = [], e: string[] = [];
  // #124: install/uninstall are the owner's messages, planned (`skein plan`) and sent by who's wallet to /sendMessage.
  if (who && (args[0] === "install" || args[0] === "uninstall")) {
    const r = await ownerCli({ home, port, owner: who.wallet, settled: () => host!.router.settled() }, args);
    for (const l of [...r.out, ...r.err]) out(l);
    return r;
  }
  const code = await main(args, {
    vars: { ...vars, ...(who ? { SKEIN_OWNER: who.id } : {}) }, out: (l) => { o.push(l); out(l); }, err: (l) => { e.push(l); out(l); },
  });
  return { code, out: o, err: e };
};

const stores: string[] = [];
let host: Awaited<ReturnType<typeof runHost>> | undefined;
const db = new HostDb(join(home, "host.db"));
try {
  // ------------------------------------------------ init: the host skein
  let r = await cli(["init", "--owner", operatorId]);
  const said = r.out.find((l) => /^host: the host skein .* claimed by .* the instance manager in its address book/.test(l));
  check(r.code === 0 && !!said, `skein-host init --owner <operator>: exit ${r.code} ${said ?? [...r.out, ...r.err].join(" ")}`);
  r = await cli(["init"]);
  check(r.code === 0 && r.out.some((l) => /^the host skein: host@localhost/.test(l)), `a second init says which instance is the host skein: ${r.out.join(" ")}`);
  r = await cli(["list"]);
  check(r.out.some((l) => /^host@localhost\thost\tenabled\t/.test(l)), "skein-host list names it: kind host, enabled");
  stores.push(db.get("host")!.store);

  host = await runHost(db, { vars: { ...vars, SKEIN_OWNER: operatorId }, out, err: out });
  const router = host.router;
  const k = async (handle: string) => (await router.hydrate(handle)).kernel;
  const genesisBook = async (handle: string) => (((await (await k(handle)).genesis()) as { addressBook?: Array<{ role?: string }> }).addressBook ?? []).map((e) => e.role);
  check((await genesisBook("host")).includes("manager"), "the host skein's address book names the instance manager");
  const hostRows = ((await (await k("host")).dispatch()).rows as Array<Record<string, unknown>>).filter((x) => x.program === "kernel");
  check(hostRows.length === 4 && hostRows.every((x) => hex(x.sender) === operatorId), "the host skein is claimed for the operator: its four admin rows");

  // ------------------------------------------------ the operator installs the onboarding app
  // #113: the handle domain and the host's origin (where the manifest says resolve is) in the app's config.
  r = await cli(["install", appCheckout(ONBOARD_APP), "--instance", "host", "--config", JSON.stringify({ onboard: { domain: "localhost", origin: base } })], { wallet: operator, id: operatorId });
  await router.settled();
  check(r.code === 0 && r.out.some((l) => /onboard 0\.2\.0 installed/.test(l)), `skein plan install skein-onboard --origin host --config {onboard: {domain, origin}}: exit ${r.code} ${r.err.join(" ")}`);
  check(r.out.some((l) => /row +http \/onboard\/call from session → onboard\.call/.test(l)) && r.out.some((l) => /row +http \/onboard\/register from anyone → onboard\.register/.test(l)), "its rows: /onboard/call from any session → onboard.call; /onboard/register (and resolve, search, the manifest, profile, paymail) from anyone");

  // ------------------------------------------------ a client creates a skein
  const create = async (handle: string, w = client) => {
    const res = await new RawBox(w, `${base}/@host`).af.fetch(`${base}/@host/onboard/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fn: "onboard.create", args: { handle } }) });
    const text = await res.text();
    let v: { fn?: string; result?: { handle: string; identity: string; url: string }; error?: { code: string; message: string } } = {};
    try { v = JSON.parse(text); } catch { /* not JSON: the check below says so */ }
    return { status: res.status, v, text };
  };
  let c = await create("alice");
  const res = c.v.result;
  check(c.status === 200 && res?.handle === "alice" && res.url === `${base}/@alice`, `POST /onboard/call create alice → ${c.status} ${c.text}`);
  const alice = db.get("alice");
  check(!!alice && alice.status === "enabled" && alice.identity === res?.identity, `alice exists, published, her identity as answered (${alice?.identity?.slice(0, 8)})`);
  const aliceRows = ((await (await k("alice")).dispatch()).rows as Array<Record<string, unknown>>).filter((x) => x.program === "kernel");
  check(aliceRows.map((x) => `${x.address}<-${hex(x.sender)}`).join(",") === ["objects", "head", "dispatch", "peers"].map((o) => `${o}<-${clientId}`).join(","), "alice is claimed for the client's key, her claim row gone");
  stores.push(alice!.store);
  const s = openStoreFile(alice!.store, { readOnly: true });
  const first: Array<Record<string, unknown>> = [];
  try { for await (const { entry } of s.log.entries(1)) { first.push(entry as Record<string, unknown>); break; } } finally { s.close(); }
  check(first[0]?.transport === "local", "the claim is alice's first entry after her genesis: her hostname was published after it");
  check(!(await genesisBook("alice")).includes("manager"), "alice's address book has no instance manager");
  const page = await fetch(`${res?.url}/`);
  check(page.status === 200 && (await page.text()).includes('src="site/app.js"'), `alice answers at her url with the management site: GET ${res?.url}/ → ${page.status}`);
  const rec = await (await k("host")).call("head", "onboard/instances/alice") as CID | null;
  const answer = rec ? await (await k("host")).store.get(rec) as { handle?: string; identity?: unknown; url?: string; replyTo?: unknown } : undefined;
  check(answer?.handle === "alice" && hex(answer.identity) === res?.identity && answer.url === res?.url && !!answer.replyTo, "the host skein records her: onboard/instances/alice → the instance manager's answer record");

  // ------------------------------------------------ BRC-169: alice resolves (#100)
  // What 1sat-sdk's resolveHandle checks (the manifest's metanet.handles.version major 1, the certificate's
  // subject = the identityKey), and the certificate itself: the SDK verifies it, its certifier is the
  // manifest's trust key, the signer's certifier key.
  const manifest = await (await fetch(`${base}/manifest.json`)).json() as { metanet?: { trust?: { publicKey?: string }; handles?: { version?: string; resolve?: string } } };
  const certifierKey = new Signer(masterKey(vars, home)).certifierKey().toPublicKey().toString();
  check(manifest.metanet?.handles?.version?.split(".")[0] === "1" && manifest.metanet.trust?.publicKey === certifierKey, `the manifest: metanet.handles.version ${manifest.metanet?.handles?.version}, metanet.trust.publicKey the signer's certifier key`);
  const rs = await fetch(`${manifest.metanet?.handles?.resolve}?handle=alice`);
  const ra = await rs.json() as { metanetHandles?: string; identityKey?: string; messagebox?: string; ttl?: number; revoked?: boolean; certificate?: Certificate };
  check(rs.status === 200 && ra.metanetHandles === "1.0" && ra.identityKey === res?.identity && ra.messagebox === res?.url && typeof ra.ttl === "number" && ra.revoked === false, `GET <resolve>?handle=alice: §5.2's answer (${rs.status})`);
  check(!!ra.certificate && ra.certificate.subject === ra.identityKey, "its certificate's subject is the identityKey (resolveHandle's check)");
  const cert = ra.certificate!;
  check(cert.certifier === certifierKey && await new Certificate(cert.type, cert.serialNumber, cert.subject, cert.certifier, cert.revocationOutpoint, cert.fields, cert.signature).verify(), "the certificate verifies with the SDK, issued by the certifier key");

  // ------------------------------------------------ the client installs an app in its skein
  r = await cli(["install", demoDir, "--instance", "alice"], { wallet: client, id: clientId });
  await router.settled();
  check(r.code === 0, `the client installs app-demo into alice: exit ${r.code} ${r.err.join(" ")}`);
  const call = await new RawBox(client, `${base}/@alice`).af.fetch(`${base}/@alice/app-demo/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fn: "demo.counter.add", args: { by: 3 } }) });
  const cv = JSON.parse(await call.text()) as { result?: { count: number } };
  check(call.status === 200 && cv.result?.count === 3, `POST /app-demo/call add {by: 3} on alice: ${call.status} ${JSON.stringify(cv)}`);

  // ------------------------------------------------ refusals
  c = await create("alice", ephemeralWallet(PrivateKey.fromRandom()));
  check(c.status === 409 && c.v.error?.code === "refused" && /handle alice is taken/.test(c.v.error.message), `a second create of alice is refused: ${c.status} ${c.text}`);
  c = await create("Not_A_Label");
  check(c.status === 409 && /hostname label/.test(c.v.error?.message ?? ""), `a handle that is no hostname label is refused: ${c.status} ${c.text}`);
  const open = await fetch(`${base}/@host/onboard/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fn: "onboard.create", args: { handle: "mallory" } }) });
  check(open.status === 401 && !db.get("mallory"), `no session, no create: ${open.status}`);
  const bad = await new RawBox(client, `${base}/@host`).af.fetch(`${base}/@host/onboard/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fn: "onboard.create", args: { handle: "x", owner: operatorId } }) });
  check(bad.status === 400 && /not in the shape/.test(await bad.text()), `the owner is the session's key, not an argument: ${bad.status}`);
} catch (e) {
  check(false, `threw: ${(e as Error).stack}`);
} finally {
  await host?.stop();
  db.close();
  for (const store of stores) {
    const rp = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), store], { encoding: "utf8" });
    process.stdout.write(rp.stdout);
    if (rp.status !== 0) process.stdout.write(rp.stderr);
    check(rp.status === 0 && /identical .*the source store reproduced exactly/.test(rp.stdout), `${store.split("/").at(-2)}'s store replays to itself exactly`);
  }
  if (failures && process.env.VERBOSE !== undefined) for (const l of lines.slice(-80)) process.stdout.write(`  | ${l}\n`);
  if (!process.env.KEEP) await fs.rm(home, { recursive: true, force: true });
}
process.stdout.write(failures ? `host: ${failures} FAILED\n` : "host: all ok\n");
process.exit(failures ? 1 : 0);

// The host skein, the instance manager and the onboarding app (#90), end to
// end on a host as `skein-host run` runs it (runHost: the signer over a
// master secret, the control socket, the providers):
//
//   #142: `skein-host init` (the first run's part of `run`) creates the host
//   skein from the host image (the default image and the onboarding app in
//   images/host), its genesis's `root` the operator's key
//   ($SKEIN_HOME/operator.key) (#143): the admin routes, no claim route (a
//   claim finds none); the onboarding app's
//   config (domain, origin) from the settings; the instance manager in its
//   address book; published at once. A second `init` only says which it is;
//   `skein-host list` names it `host`.
//
//   A client — a wallet with a BRC-104 session to the host skein, nothing
//   else — POSTs {fn: "onboard.create", args: {handle: "alice", claim}} to
//   /onboard/call, `claim` its own signed claim naming no recipient (#127).
//   The answer {handle, identity, url} comes on the same connection: the
//   onboarding app's thread asked the instance manager, which created alice
//   from the default image and forwarded the client's claim (alice's first
//   entry after its genesis) before publishing her hostname; the host signed
//   nothing for the client. A create with no claim, or another key's, is refused.
//   alice answers at her URL (no page there, #125), is claimed for the client's key,
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
import * as dagJson from "@ipld/dag-json";
import { RawBox, signClaim } from "../../src/client/raw.ts";
import { planClaim } from "../../src/client/admin.ts";
import { main, runHost, type Env } from "../../src/host/cli.ts";
import { HostDb } from "../../src/host/instances.ts";
import { masterKey, Signer } from "../../src/host/signer.ts";
import { openStoreFile } from "../../src/runtime/index-store.ts";
import { ownerCli, sendPlan } from "../../src/testapps.ts";
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
  // #124: install/uninstall are the owner's messages, planned and sent on who's session.
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
  // ------------------------------------------------ init: the host skein, owned by the operator's key at birth
  await fs.writeFile(join(home, "operator.key"), `${operatorKey.toHex()}\n`, { mode: 0o600 });
  let r = await cli(["init"]);
  const said = r.out.find((l) => /first run — the host skein host .* owned by the operator's key /.test(l) && l.includes(operatorId));
  check(r.code === 0 && !!said, `skein-host init: exit ${r.code} ${said ?? [...r.out, ...r.err].join(" ")}`);
  r = await cli(["init"]);
  check(r.code === 0 && r.out.some((l) => /^the host skein: host@localhost/.test(l)), `a second init says which instance is the host skein: ${r.out.join(" ")}`);
  r = await cli(["list"]);
  check(r.out.some((l) => /^host@localhost\thost\tenabled\t/.test(l)), "skein-host list names it: kind host, enabled");
  stores.push(db.get("host")!.store);

  host = await runHost(db, { vars, out, err: out });
  const router = host.router;
  const k = async (handle: string) => (await router.hydrate(handle)).kernel;
  const genesisBook = async (handle: string) => (((await (await k(handle)).genesis()) as { addressBook?: Array<{ address?: string }> }).addressBook ?? []).map((e) => e.address);
  check((await genesisBook("host")).includes("manager"), "the host skein's address book names the instance manager");
  const allRows = async (handle: string) => ((await (await k(handle)).dispatch()).rows as Array<Record<string, unknown>>);
  const kernelRows = async (handle: string) => (await allRows(handle)).filter((x) => x.program === "kernel");
  /** A role's holders (hex) as the head `grants` names them (#143). */
  const holders = async (handle: string, role = "root") => {
    const c = await (await k(handle)).call("head", "grants") as CID | null;
    return c ? ((((await (await k(handle)).store.get(c)) as { roles?: Record<string, Uint8Array[]> }).roles?.[role] ?? []).map(hex)) : [];
  };
  const hostRows = await kernelRows("host");
  check(hostRows.map((x) => x.address).join(",") === "objects,head,dispatch,peers,grant", "the host skein's kernel routes are the admin routes: no claim route");
  check((await holders("host")).join(",") === operatorId, "#143: root is the operator's key, from the genesis");
  const rows = await allRows("host");
  check(rows.some((x) => x.address === "/explore" && x.fn === "explore") && rows.some((x) => x.app === "git" && x.address === "git") && rows.every((x) => x.sender === undefined), "the explorer route, git's route; no route names a sender");
  const hostId = db.get("host")!.identity!;
  const late = await sendPlan({ port, owner: client, settled: () => router.settled() }, "host", planClaim(hostId)).then(() => "sent", (e: Error) => e.message);
  check(/403/.test(late) && (await holders("host")).join(",") === operatorId, `a claim (another wallet's) finds no route: ${late.slice(0, 80)}`);

  // ------------------------------------------------ the onboarding app, installed at birth with the settings' config
  const onboardRoot = await (await k("host")).call("head", "onboard/app") as CID | null;
  const onboard = onboardRoot ? await (await k("host")).store.get(onboardRoot) as { version?: string; config?: { onboard?: { domain?: string; origin?: string } } } : undefined;
  check(!!onboard && onboard.config?.onboard?.domain === "localhost" && onboard.config.onboard.origin === base, `onboard ${onboard?.version} installed at birth, config.onboard ${JSON.stringify(onboard?.config?.onboard)}`);
  const brc = (x: Record<string, unknown>) => Array.isArray(x.filters) && x.filters.includes("kernel.brc104");
  check(rows.some((x) => x.app === "onboard" && x.address === "/onboard/call" && brc(x)) && rows.some((x) => x.app === "onboard" && x.address === "/onboard/register" && brc(x)), "its routes: /onboard/call and /onboard/register behind kernel.brc104 (#135, #143)");

  // ------------------------------------------------ grant: root to another key, signed by the operator's key, over the control socket
  const grantee = PrivateKey.fromRandom(), granteeId = grantee.toPublicKey().toString();
  const before = await (await new RawBox(ephemeralWallet(grantee), `${base}/@host`).af.fetch(`${base}/@host/explore`)).status;
  r = await cli(["grant", granteeId, "--role", "root"]);
  await router.settled();
  check(r.code === 0 && (await holders("host")).includes(granteeId), `skein-host grant <key> --role root: the grants head names it (${r.err.join(" ")})`);
  const after = await (await new RawBox(ephemeralWallet(grantee), `${base}/@host`).af.fetch(`${base}/@host/explore`)).status;
  check(before === 403 && after === 200, `the granted key reads the explorer: ${before} → ${after}`);
  r = await cli(["grant", granteeId]);
  check(r.code === 0 && r.out.some((l) => /the grants say so already/.test(l)), `a second grant sends nothing: ${r.out.join(" ")}`);

  // ------------------------------------------------ a client creates a skein
  /** onboard.create with `w`'s own signed claim (#127; `claim: null`: none, `claimBy`: another wallet's), as dag-json. */
  const create = async (handle: string, w = client, o: { claim?: null; claimBy?: typeof client } = {}) => {
    const claim = o.claim === null ? undefined : await signClaim(o.claimBy ?? w);
    const body = new TextDecoder().decode(dagJson.encode({ fn: "onboard.create", args: { handle, ...(claim ? { claim } : {}) } }));
    const res = await new RawBox(w, `${base}/@host`).af.fetch(`${base}/@host/onboard/call`, { method: "POST", headers: { "content-type": "application/json" }, body });
    const text = await res.text();
    let v: { fn?: string; result?: { handle: string; identity: string; url: string }; error?: { code: string; message: string } } = {};
    try { v = JSON.parse(text); } catch { /* not JSON: the check below says so */ }
    return { status: res.status, v, text };
  };
  let c = await create("alice", client, { claim: null });
  check(c.status === 400 && c.v.error?.code === "bad-args" && /args\.claim: missing/.test(c.v.error.message) && !db.get("alice"), `a create with no claim is refused: ${c.status} ${c.text}`);
  c = await create("alice", client, { claimBy: ephemeralWallet(PrivateKey.fromRandom()) });
  check(c.status === 409 && /its sender is not the owner/.test(c.v.error?.message ?? "") && !db.get("alice"), `a create with another key's claim is refused: ${c.status} ${c.text}`);
  c = await create("alice");
  const res = c.v.result;
  check(c.status === 200 && res?.handle === "alice" && res.url === `${base}/@alice`, `POST /onboard/call create alice → ${c.status} ${c.text}`);
  const alice = db.get("alice");
  check(!!alice && alice.status === "enabled" && alice.identity === res?.identity, `alice exists, published, her identity as answered (${alice?.identity?.slice(0, 8)})`);
  const aliceRows = await kernelRows("alice");
  check(aliceRows.map((x) => x.address).join(",") === "objects,head,dispatch,peers,grant" && (await holders("alice")).join(",") === clientId, "alice is claimed by the client's own signed claim: the client is root, her claim route gone");
  stores.push(alice!.store);
  const s = openStoreFile(alice!.store, { readOnly: true });
  const first: Array<Record<string, unknown>> = [];
  try { for await (const { entry } of s.log.entries(1)) { first.push(entry as Record<string, unknown>); break; } } finally { s.close(); }
  check(first[0]?.transport === "local", "the forwarded claim is alice's first entry after her genesis: her hostname was published after it");
  check(!(await genesisBook("alice")).includes("manager"), "alice's address book has no instance manager");
  // Her explorer route (kernel.brc104, root's) answers at her url, wanting a session.
  const page = await fetch(`${res?.url}/explore`);
  check(page.status === 401, `alice answers at her url (nothing at /: #125): GET ${res?.url}/explore with no session → ${page.status}`);
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
  const bad = await new RawBox(client, `${base}/@host`).af.fetch(`${base}/@host/onboard/call`, { method: "POST", headers: { "content-type": "application/json" }, body: new TextDecoder().decode(dagJson.encode({ fn: "onboard.create", args: { handle: "x", owner: operatorId, claim: await signClaim(client) } })) });
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

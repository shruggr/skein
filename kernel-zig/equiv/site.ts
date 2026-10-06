// The management site (#92), driven in headless Chrome over a host as
// `skein-host run` runs it (runHost: the signer over a master secret, the
// providers, the instance manager), with its host skein:
//
//   `skein-host init --owner <you>` creates the host skein from the default
//   image, which you claim from your wallet (#127: `skein plan claim`, the
//   sender owning it); the default
//   image (no site, no static, #125: the explorer route for its owner and the
//   git app's tree under apps/git); you install the onboarding app and the
//   management site (shruggr/skein-site, an app: its page at /site/) into it
//   as the owner's messages (`skein plan install`, #124), and send the site's
//   optional root read (`skein plan reads add … / site.site`, #135).
//
//   The wallet's grouped request (#97): GET /manifest.json at the host skein's
//   own origin is the site's manifest.json, by that root read (the protocols,
//   the basket and the spend the page uses; the counterparty protocols); the
//   router's origin still answers its own (metanet.trust, metanet.handles).
//
//   The page, served by the host skein at /site/, with a wallet in the tab over your
//   key (`?key=`, createWebWallet) pointed at a stand-in for the 1sat services
//   (`&services=`: headers for one block holding the payment that funds the
//   wallet, and a broadcast that accepts) — the chain is the only thing not
//   real here:
//
//   1. create: the form sends {fn: "onboard.create", args: {handle: alice}}
//      to /onboard/call on your session; the answer {handle, identity, url};
//      a locator token (a PushDrop output in basket skein-locators: alice's
//      identity, url, handle) written into your wallet; the page opens alice's
//      view (alice serves no page: she is managed from the host's);
//   2. alice's apps, from the host's page talking to alice: her apps read from her
//      explorer (yours: you own her); install the git app from the tree her
//      image carries (objects for its module and records, head, dispatch,
//      start — the prompt shown first); then install app-demo by hash from a
//      local repository served by `git http-backend`: one message to box git,
//      the git app's answer {tree, app} read from its thread, the manifest
//      read out of the stored tree, the record rebuilt in the page (the same
//      CID), the prompt, then head + dispatch + start; app-demo runs;
//   3. the explorer renders alice's log (genesis, the claim, the requests);
//   4. back on the host skein, a locator for it added from the page; its page
//      lists alice under the skeins created there;
//   5. a handle (#103, #113): the page's Register form (skein-site ≥ 0.5.3)
//      signs `register <name>@<domain>` (/.well-known/skein-host for the
//      domain) and posts it to /account/register over your wallet's
//      BRC-104 session with the host's origin (#135): the host skein's app
//      has the instance manager create your mailbox instance and answers the
//      handle certificate its record holds, which the wallet in the tab keeps
//      (acquireCertificate, direct: encrypted fields, your keyring);
//      listCertificates returns it, its serial the one resolve answers;
//      "Your handles" shows you@localhost and the messagebox it resolves to;
//      your profile (#104): the OpNS profile record, signed by the wallet in
//      the tab ([1, "metanet handles profile"]) and posted to the host's
//      /account/profile (#113: the app keeps it; the page's Profile form still
//      writes your mailbox instance); resolve carries it (verified here
//      against your key) with displayName (no avatarURL: the app's ordfs is
//      empty); the manifest names the host (the app's config) and its search
//      endpoint, and Find a handle on the page finds you by that name;
//      the Inbox (#99): opened on that messagebox (prefilled from the handle);
//      a sender delivers a payment to it in box metanet_inbox (a BRC-169
//      DAG-CBOR envelope, BRC-231 over BRC-104, its `payment` a BRC-29
//      transaction to you); the page, given the mailbox's URL, lists the
//      message (@bsv/message-box-client against skein's messagebox), keeps
//      the URL in the browser, and Sync runs @1sat/actions' syncMetanetInbox
//      with the wallet in the tab: the envelope opened, the payment
//      internalized (label "metanet payment", 50 000 sats in the wallet) and
//      acknowledged; the page shows the receipt (txid, sats, memo) and lists
//      the box again, empty;
//   6. the stores replay to themselves exactly.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/site.ts

import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import { createServer as httpServer, get as httpGet, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EncryptedMessage, Hash, MasterCertificate, MerklePath, P2PKH, PrivateKey, PublicKey, ProtoWallet, Script, Transaction, Utils, type WalletInterface } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { RawBox } from "../../src/client/raw.ts";
import { main, runHost, type Env } from "../../src/host/cli.ts";
import { HostDb } from "../../src/host/instances.ts";
import { appCheckout, ONBOARD_APP, ownerCli, sendDir, sendPlan, SITE_APP } from "../../src/testapps.ts";
import { planClaim } from "../../src/client/admin.ts";
import { planMain } from "../../src/client/admin-cli.ts";
import { HANDLE_CERTIFICATE_TYPE } from "../../src/host/handles.ts";
import { decodeProfile } from "@1sat/utils";
import { outpointFromBytes, outpointToBytes } from "@1sat/templates";
import { ephemeralWallet } from "../../src/wallet.ts";
import { chromium, playwright } from "./browser.ts";

/** The profile signature (#104): [1, "metanet handles profile"], key ID "1", counterparty anyone. */
const PROFILE_PROTOCOL: [1, string] = [1, "metanet handles profile"];
const PROFILE_KEY_ID = "1";

const here = dirname(fileURLToPath(import.meta.url));
const demoDir = join(here, "../../programs/test/app-demo");
const verbose = !!process.env.VERBOSE;
let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };
const hex = (b: unknown) => b instanceof Uint8Array ? Buffer.from(b).toString("hex") : String(b);

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});

// ---------------------------------------------------------------- app-demo in a repository, over smart HTTP (as git-clone.ts)

const work = mkdtempSync(join(tmpdir(), "skein-kz-site-"));
const repos = join(work, "repos");
const repo = join(repos, "app-demo");
mkdirSync(repo, { recursive: true });
for (const f of ["etc", "bin", "main.zig", "build.zig", "build.zig.zon", "build.sh"]) cpSync(join(demoDir, f), join(repo, f), { recursive: true });
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "skein", GIT_AUTHOR_EMAIL: "skein@test", GIT_COMMITTER_NAME: "skein", GIT_COMMITTER_EMAIL: "skein@test", GIT_AUTHOR_DATE: "2026-10-03T12:00:00Z", GIT_COMMITTER_DATE: "2026-10-03T12:00:00Z" };
const git = (...args: string[]) => {
  const r = spawnSync("git", args, { cwd: repo, env: gitEnv, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
git("init", "-q", "-b", "main");
git("add", "-A");
git("commit", "-qm", "app-demo");
const hashA = git("rev-parse", "HEAD");

function backend(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  const u = new URL(req.url!, "http://x");
  const p = spawn("git", ["http-backend"], {
    env: {
      ...process.env, GIT_PROJECT_ROOT: repos, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: decodeURIComponent(u.pathname), QUERY_STRING: u.search.slice(1),
      REQUEST_METHOD: req.method!, CONTENT_TYPE: req.headers["content-type"] ?? "", CONTENT_LENGTH: String(body.length), REMOTE_ADDR: "127.0.0.1",
      ...(req.headers["git-protocol"] ? { GIT_PROTOCOL: String(req.headers["git-protocol"]) } : {}),
    },
  });
  p.stdin.end(body);
  const out: Buffer[] = [];
  p.stdout.on("data", (d: Buffer) => out.push(d));
  p.on("close", () => {
    const all = Buffer.concat(out);
    const i = all.indexOf("\r\n\r\n");
    let status = 200;
    for (const l of all.subarray(0, i).toString().split("\r\n")) {
      const [k, v] = l.split(/:\s*/, 2);
      if (k!.toLowerCase() === "status") status = parseInt(v!); else if (k) res.setHeader(k, v ?? "");
    }
    res.statusCode = status;
    res.end(all.subarray(i + 4));
  });
}
const gitServer = httpServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => backend(req, res, Buffer.concat(chunks)));
});
await new Promise<void>((r) => gitServer.listen(0, "127.0.0.1", r));
const repoUrl = `http://127.0.0.1:${(gitServer.address() as AddressInfo).port}/app-demo`;

// ---------------------------------------------------------------- your key, and a payment that funds the page's wallet

const youKey = PrivateKey.fromRandom(), you = youKey.toPublicKey().toString();
const payer = PrivateKey.fromRandom();
const derivationPrefix = Utils.toBase64(Array.from(crypto.getRandomValues(new Uint8Array(8))));
const derivationSuffix = Utils.toBase64(Array.from(crypto.getRandomValues(new Uint8Array(8))));
const { publicKey: payTo } = await new ProtoWallet(payer).getPublicKey({ protocolID: [2, "3241645161d8"], keyID: `${derivationPrefix} ${derivationSuffix}`, counterparty: you });
// The payer's coin, proven in the stand-in's one block; the payment spends it (unproven: the wallet
// stores a proven transaction's header inside an IndexedDB transaction, which a fetch would end).
const coin = new Transaction();
coin.addInput({ sourceTXID: "11".repeat(32), sourceOutputIndex: 0, unlockingScript: new Script(), sequence: 0xffffffff });
coin.addOutput({ lockingScript: new P2PKH().lock(payer.toPublicKey().toAddress()), satoshis: 100_100 });
coin.addOutput({ lockingScript: new P2PKH().lock(payer.toPublicKey().toAddress()), satoshis: 50_100 }); // the Inbox's delivery (5.)
const coinTxid = coin.id("hex");
const HEIGHT = 900_000;
coin.merklePath = new MerklePath(HEIGHT, [[{ offset: 0, hash: coinTxid, txid: true }]]);
const merkleRoot = coin.merklePath.computeRoot(coinTxid);
const funding = new Transaction();
funding.addInput({ sourceTransaction: coin, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(payer), sequence: 0xffffffff });
funding.addOutput({ lockingScript: new P2PKH().lock(PublicKey.fromString(payTo).toAddress()), satoshis: 100_000 });
await funding.sign();
const atomic = funding.toAtomicBEEF();

// The Inbox's delivery (5.): the payer's second coin, paid to you under BRC-29 (fresh derivation).
const dPrefix = crypto.getRandomValues(new Uint8Array(8)), dSuffix = crypto.getRandomValues(new Uint8Array(8));
const { publicKey: payTo2 } = await new ProtoWallet(payer).getPublicKey({ protocolID: [2, "3241645161d8"], keyID: `${Utils.toBase64(Array.from(dPrefix))} ${Utils.toBase64(Array.from(dSuffix))}`, counterparty: you });
const delivery = new Transaction();
delivery.addInput({ sourceTransaction: coin, sourceOutputIndex: 1, unlockingScriptTemplate: new P2PKH().unlock(payer), sequence: 0xffffffff });
delivery.addOutput({ lockingScript: new P2PKH().lock(PublicKey.fromString(payTo2).toAddress()), satoshis: 50_000 });
await delivery.sign();

// ---------------------------------------------------------------- the stand-in for the 1sat services the wallet calls

const broadcasts: string[] = [];
const header = { version: 1, previousHash: "00".repeat(32), merkleRoot, time: 1_790_000_000, bits: 0x1d00ffff, nonce: 0, height: HEIGHT, hash: "22".repeat(32) };
const services = httpServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const u = new URL(req.url!, "http://x");
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
    const json = (v: unknown, status = 200) => { res.writeHead(status, { ...cors, "content-type": "application/json" }).end(JSON.stringify(v)); };
    if (req.method === "OPTIONS") { res.writeHead(204, cors).end(); return; }
    if (verbose) process.stdout.write(`  | services: ${req.method} ${u.pathname}${u.search}\n`);
    const p = u.pathname;
    if (p === "/1sat/chaintracks/tip" || p === `/1sat/chaintracks/header/height/${HEIGHT}`) return json(header);
    if (p === "/1sat/chaintracks/network") return json({ network: "main" });
    if (p === "/1sat/chaintracks/headers") { res.writeHead(200, { ...cors, "content-type": "application/octet-stream" }).end(Buffer.alloc(80 * Number(u.searchParams.get("count") ?? 1))); return; }
    if (p === "/1sat/arcade/policy") return json({ maxscriptsizepolicy: 100_000_000, maxtxsigopscountspolicy: 4_294_967_295, maxtxsizepolicy: 100_000_000, miningFee: { satoshis: 1, bytes: 1000 } });
    if (p === "/1sat/arcade/tx" && req.method === "POST") {
      const tx = Transaction.fromAtomicBEEF(Array.from(Buffer.concat(chunks)));
      broadcasts.push(tx.id("hex"));
      return json({ txid: tx.id("hex"), txStatus: "SEEN_ON_NETWORK", timestamp: new Date().toISOString() });
    }
    json({ message: "not here" }, 404);
  });
});
await new Promise<void>((r) => services.listen(0, "127.0.0.1", r));
const servicesUrl = `http://127.0.0.1:${(services.address() as AddressInfo).port}`;

// ---------------------------------------------------------------- the host and its host skein

const home = await fs.mkdtemp(join(tmpdir(), "skein-site-"));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const vars: Env["vars"] = {
  SKEIN_HOME: home, HOME: home, SKEIN_ROUTER_PORT: String(port), SKEIN_HOST_PORT: "0",
  SKEIN_INSTANCE_ORIGIN: "http://127.0.0.1:{port}/@{handle}",
};
const lines: string[] = [];
const out = (l: string) => { lines.push(l); if (verbose) process.stdout.write(`  | ${l}\n`); };
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

// The fetch provider carries requests beyond the host's own (the git app's clone of the local repository).
process.env.SKEIN_HTTP = "fetch";
const stores: string[] = [];
let host:Awaited<ReturnType<typeof runHost>> | undefined;
const db = new HostDb(join(home, "host.db"));
const pw = await playwright();
const browser = await pw.chromium.launch({ executablePath: chromium(), headless: true });
try {
  let r = await cli(["init", "--owner", you]);
  check(r.code === 0, `skein-host init --owner <you>: exit ${r.code} ${r.err.join(" ")}`);
  stores.push(db.get("host")!.store);
  host = await runHost(db, { vars: { ...vars, SKEIN_OWNER: you }, out, err: out });
  const router = host.router;
  // #127: the host skein is a bare image; you claim it from your wallet (skein plan claim, skein send): the sender owns it.
  await sendPlan({ port, owner: ephemeralWallet(youKey), settled: () => router.settled() }, "host", planClaim(db.get("host")!.identity!));
  check(((await (await router.hydrate("host")).kernel.dispatch()).rows as Array<Record<string, unknown>>).some((x) => x.program === "kernel" && x.address === "objects" && hex(x.sender) === you), "you claim the host skein from your wallet (#127)");
  // #113: the handle domain and the host's origin in the app's config; #104: the host's name in the manifest, no
  // avatarURL (nothing fetched from a public ORDFS gateway).
  r = await cli(["install", appCheckout(ONBOARD_APP), "--instance", "host", "--config", JSON.stringify({ onboard: { domain: "localhost", origin: base, name: "Test host", ordfs: "" } })], { wallet: ephemeralWallet(youKey), id: you });
  await router.settled();
  check(r.code === 0, `the onboarding app installed into the host skein: exit ${r.code} ${r.err.join(" ")}`);
  // #125: the management site, an app the host's owner installs, and its optional root read (the owner's own).
  r = await cli(["install", appCheckout(SITE_APP), "--instance", "host"], { wallet: ephemeralWallet(youKey), id: you });
  await router.settled();
  check(r.code === 0, `the site app installed into the host skein: exit ${r.code} ${r.err.join(" ")}`);
  const rootPlan = join(home, "root-row");
  const pe: string[] = [];
  const pc = await planMain(["reads", "add", "--prefix", "--fn", "get", "--settings", JSON.stringify({ root: "www" }), "/", "site.site", "--store", db.get("host")!.store, "--out", rootPlan], { vars: {}, out, err: (l) => { pe.push(l); out(l); } });
  const rootSent = pc === 0 ? await sendDir({ port, owner: ephemeralWallet(youKey), settled: () => router.settled() }, "host", rootPlan) : 0;
  check(pc === 0 && rootSent === 2, `the owner's root read for the site (#135: skein plan reads add … / site.site — objects, head reads), sent: ${pc} ${rootSent} ${pe.join(" ")}`);

  // ------------------------------------------------ the wallet's grouped request (#97): /manifest.json at the host skein's own origin
  // (host.localhost:<port>, the origin a wallet takes the page's originator from); the router's origin keeps its own.
  const atOrigin = (hostname: string, path: string) => new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
    httpGet({ host: "127.0.0.1", port, path, headers: { host: `${hostname}:${port}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks).toString("utf8") }));
    }).on("error", reject);
  });
  type Grouped = { protocolPermissions?: Array<{ protocolID: [number, string]; counterparty?: string }>; basketAccess?: Array<{ basket: string }>; spendingAuthorization?: { amount: number } };
  const pm = await atOrigin("host.localhost", "/manifest.json");
  const pmf = JSON.parse(pm.body) as { metanet?: { groupPermissions?: Grouped; counterpartyPermissions?: { protocols: Array<{ protocolName: string }> }; handles?: unknown } };
  const g = pmf.metanet?.groupPermissions ?? {};
  const has = (level: number, name: string, counterparty?: string) => !!g.protocolPermissions?.some((p) => p.protocolID[0] === level && p.protocolID[1] === name && p.counterparty === counterparty);
  const wanted: Array<[number, string, string | undefined]> = [
    [1, "identity key retrieval", "self"], [2, "server hmac", "self"], [2, "auth message signature", undefined], [1, "skein locator", "self"],
    [2, "skein register", "anyone"], [1, `certificate acquisition ${HANDLE_CERTIFICATE_TYPE}`, "self"], [1, "certificate list", "self"], [PROFILE_PROTOCOL[0], PROFILE_PROTOCOL[1], "anyone"],
  ];
  const missing = wanted.filter(([l, n, c]) => !has(l, n, c)).map(([l, n]) => `[${l}, ${n}]`);
  const cps = (pmf.metanet?.counterpartyPermissions?.protocols ?? []).map((p) => p.protocolName);
  check(pm.status === 200 && /json/.test(pm.type) && !pmf.metanet?.handles && missing.length === 0 && g.protocolPermissions?.length === wanted.length
    && g.basketAccess?.length === 1 && g.basketAccess[0]!.basket === "skein-locators" && g.spendingAuthorization === undefined
    && cps.join(",") === "auth message signature,certificate field encryption",
    `GET /manifest.json at the host skein's origin is the site's (${pm.type}): ${g.protocolPermissions?.length} protocols${missing.length ? ` (missing ${missing.join(", ")})` : ""}, basket ${g.basketAccess?.map((b) => b.basket).join(",")}, spending ${g.spendingAuthorization === undefined ? "none (0.5.2)" : "present"}; counterparty protocols ${cps.join(", ")}`);
  const rm = await atOrigin("127.0.0.1", "/manifest.json");
  const rmf = JSON.parse(rm.body) as { metanet?: { trust?: { publicKey?: string }; handles?: { resolve?: string }; groupPermissions?: unknown } };
  check(rm.status === 200 && !!rmf.metanet?.trust?.publicKey && rmf.metanet.handles?.resolve === `${base}/.well-known/metanet-handles/resolve` && !rmf.metanet.groupPermissions,
    "and the router's origin answers its own manifest (metanet.trust, metanet.handles), not the site's");

  const page = await (await browser.newContext()).newPage();
  /** The host skein's site, at the app's own path. */
  const sitePage = `${base}/@host/site/`;
  page.on("console", (m) => { if (verbose || m.type() === "error") process.stdout.write(`  | page: ${m.text()}\n`); });
  page.on("pageerror", (e) => process.stdout.write(`  | page error: ${e.message}\n`));
  page.on("dialog", (d) => void d.accept());
  const search = `?key=${youKey.toHex()}&services=${encodeURIComponent(servicesUrl)}`;
  const ready = async () => {
    await page.waitForFunction(() => (window as unknown as { siteReady?: boolean; siteFailed?: string }).siteReady === true || !!(window as unknown as { siteFailed?: string }).siteFailed, null, { timeout: 120_000 });
    const failed = await page.evaluate(() => (window as unknown as { siteFailed?: string }).siteFailed);
    if (failed) throw new Error(`page: ${failed}`);
  };
  /** The install prompt, or the page's error. */
  const prompted = async () => {
    await page.waitForSelector("#plan, #install-status.bad", { timeout: 180_000 });
    if (await page.locator("#install-status.bad").count()) throw new Error(`install: ${await page.locator("#install-status").innerText()}`);
  };

  // ------------------------------------------------ the page on the host skein, your wallet in the tab
  const root = await fetch(`${base}/@host/`);
  check(root.status === 200 && (await root.text()).includes('src="app.js"'), `the host skein serves the site at / by the owner's row (${root.status})`);
  await page.goto(`${sitePage}${search}`);
  await ready();
  const who = await page.locator("#who").getAttribute("title");
  check(who === you, `the host skein serves the site at /site/ and the page runs your wallet (${who?.slice(0, 10)})`);
  const funded = await page.evaluate(async ([tx, prefix, suffix, sender]) => {
    const w = (window as unknown as { site: { wallet: { internalizeAction(a: unknown): Promise<{ accepted: boolean }> } } }).site.wallet;
    return (await w.internalizeAction({ tx, outputs: [{ outputIndex: 0, protocol: "wallet payment", paymentRemittance: { derivationPrefix: prefix, derivationSuffix: suffix, senderIdentityKey: sender } }], description: "fund the test wallet" })).accepted;
  }, [Array.from(atomic), derivationPrefix, derivationSuffix, payer.toPublicKey().toString()] as const);
  check(funded === true, "the wallet in the tab takes a payment (the stand-in's one block proves it)");

  // ------------------------------------------------ 1. create
  await page.fill("#create input[name=handle]", "alice");
  await page.click("#create button[type=submit]");
  await page.waitForURL(/#\/s\/0[23][0-9a-f]{64}$/, { timeout: 180_000 });
  await ready();
  const alice = db.get("alice");
  check(!!alice && alice.status === "enabled", `create from the page: alice exists (${alice?.identity?.slice(0, 10)}), and the page opened her view`);
  const aliceId = alice!.identity!;
  stores.push(alice!.store);
  check(page.url().startsWith(`${sitePage}?key=`) && page.url().endsWith(`#/s/${aliceId}`), `the page stays the host's, on alice's view (#125: she serves no page) (${page.url().replace(/key=[0-9a-f]+/, "key=…")})`);
  const aliceRoot = await fetch(`${base}/@alice/`);
  check(aliceRoot.status === 404, `alice serves nothing at / (#125: no site in the image): ${aliceRoot.status}`);
  const locators = await page.evaluate(async () => {
    const w = (window as unknown as { site: { wallet: { listOutputs(a: unknown): Promise<{ outputs: Array<{ outpoint: string; lockingScript: string }> }> } } }).site.wallet;
    return (await w.listOutputs({ basket: "skein-locators", include: "locking scripts" })).outputs;
  });
  const { PushDrop, LockingScript } = await import("@bsv/sdk");
  const fields = locators.map((o) => PushDrop.decode(LockingScript.fromHex(o.lockingScript)).fields.map((f) => Buffer.from(f)));
  check(fields.length === 1 && fields[0]![0]!.toString("hex") === aliceId && fields[0]![1]!.toString() === `${base}/@alice` && fields[0]![2]!.toString() === "alice",
    `the locator token is in your wallet's basket skein-locators: a PushDrop of [identity, url, handle] (${fields.map((f) => f.map((x) => x.length).join("/")).join(" ")})`);
  check(broadcasts.length === 1, `the locator's transaction was broadcast through the wallet's services (${broadcasts.length})`);
  const aliceRows = ((await (await router.hydrate("alice")).kernel.dispatch()).rows as Array<Record<string, unknown>>);
  check(aliceRows.some((x) => x.program === "kernel" && hex(x.sender) === you), "alice is claimed for your key");

  // ------------------------------------------------ 2. alice's apps: the git app from her image, then app-demo by hash
  await page.waitForSelector("#apps", { timeout: 60_000 });
  check((await page.locator("#apps").innerText()).includes("No apps installed"), "alice's page reads her heads through her explorer: no apps yet");
  await page.click("tr[data-catalog=git] button");
  await prompted();
  const gitPlan = await page.locator("#plan").innerText();
  check(/install git 0\.1\.2/.test(gitPlan) && /row +mailbox git from \$owner → git/.test(gitPlan) && /objects ×1/.test(gitPlan), `the prompt for the git app (from alice's image, apps/git): ${gitPlan.split("\n").filter((l) => /install|row|messages/.test(l)).join(" | ")}`);
  await page.click("#approve");
  await page.waitForSelector("tr[data-app=git]", { timeout: 120_000 });
  check(true, "the git app installed from the page (objects, head, dispatch, start, signed by your wallet)");

  await page.fill("#install-url input[name=url]", repoUrl);
  await page.fill("#install-url input[name=hash]", hashA);
  await page.click("#install-url button[type=submit]");
  await prompted();
  const demoPlan = await page.locator("#plan").innerText();
  check(/install app-demo 0\.1\.0/.test(demoPlan) && /row +mailbox app-demo from anyone → demo/.test(demoPlan) && /objects ×1 \(0 records\)/.test(demoPlan) && /dispatch ×3/.test(demoPlan),
    `deploy by hash from the page: the git app cloned it, the record rebuilt in the page matches, nothing to send by objects (${demoPlan.split("\n").filter((l) => /install|messages/.test(l)).join(" | ")})`);
  await page.click("#approve");
  await page.waitForSelector("tr[data-app=app-demo]", { timeout: 120_000 });
  const call = await new RawBox(ephemeralWallet(youKey), `${base}/@alice`).af.fetch(`${base}/@alice/app-demo/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fn: "demo.counter.add", args: { by: 2 } }) });
  const cv = JSON.parse(await call.text()) as { result?: { count: number } };
  check(call.status === 200 && cv.result?.count === 2, `app-demo runs in alice: /app-demo/call add {by: 2} → ${call.status} ${JSON.stringify(cv)}`);

  // ------------------------------------------------ 3. the explorer
  await page.goto(`${sitePage}${search}#/s/${aliceId}/log`);
  await ready();
  await page.waitForSelector("#log", { timeout: 60_000 });
  const log = await page.locator("#log").innerText();
  check(/request \(http\)/.test(log) && /request \(local\)/.test(log) && /Older/.test(await page.locator("main").innerText()), `the explorer renders alice's log, newest first: the page's requests, the providers' answers (${log.split("\n").length} rows), and a link to older entries`);
  await page.goto(`${sitePage}${search}#/s/${aliceId}/log?before=2`);
  await page.waitForFunction(() => /genesis/.test(document.getElementById("log")?.innerText ?? ""), null, { timeout: 60_000 });
  const first = await page.locator("#log").innerText();
  check(/^1\s.*request \(local\)/m.test(first) && /^0\s.*genesis/m.test(first), `and its first entries: 0 the genesis, 1 the claim (a local request) (${first.replace(/\s+/g, " ").slice(0, 160)})`);
  await page.goto(`${sitePage}${search}#/s/${aliceId}/dispatch`);
  await page.waitForSelector("#dispatch", { timeout: 60_000 });
  check((await page.locator("#dispatch").innerText()).includes("/app-demo/call"), "and her dispatch table, with app-demo's rows");
  const stranger = PrivateKey.fromRandom();
  const refused = await new RawBox(ephemeralWallet(stranger), `${base}/@alice`).af.fetch(`${base}/@alice/explore`, { method: "GET" });
  check(refused.status === 403, `another key's read of alice's explorer is refused (${refused.status}): the explorer is the owner's`);

  // ------------------------------------------------ 4. the host skein's page: its children
  await page.goto(`${sitePage}${search}`);
  await ready();
  await page.click("[aria-controls=add-panel]"); // 0.7.x: the add form behind its link
  await page.fill("#add-locator input[name=handle]", "host");
  await page.click("#add-locator button[type=submit]");
  const hostId = db.get("host")!.identity!;
  await page.waitForSelector(`[data-locator="${hostId}"]`, { timeout: 120_000 });
  check(true, "a locator for the host skein added from the page (its identity from its signed answer)");
  await page.goto(`${sitePage}${search}#/s/${hostId}`);
  await page.waitForSelector("#children", { timeout: 60_000 });
  const kids = await page.locator("#children").innerText();
  check(/alice/.test(kids) && kids.includes(`${base}/@alice`) && /Open/.test(kids), `the host skein's page lists the skeins created there, alice openable through her locator (${kids.replace(/\s+/g, " ").trim()})`);

  // ------------------------------------------------ 5. a handle (#103, #113)
  await page.goto(`${sitePage}${search}`);
  await ready();
  await page.waitForSelector("#register", { timeout: 60_000 });
  check((await page.locator("#handles").innerText()).includes("No handle certificate from localhost"), "the host skein's page finds its host (/.well-known/skein-host, the manifest): no handle certificate in your wallet yet");
  // The page's Register form (skein-site ≥ 0.5.3): your wallet signs `register you@localhost` (the domain from
  // /.well-known/skein-host), POST /account/register over your wallet's session with the host's origin (#135,
  // skein-site ≥ 0.7.6), and the certificate it answers acquired (direct).
  const { publicKey: certifier } = await router.certifier.getPublicKey({ identityKey: true });
  await page.fill("#register input[name=handle]", "you");
  // The status the form ends on, kept by an observer set before the click: over the session the registration
  // answers in well under a second, and the page shows it for 300 ms before it renders the handle in the card's place.
  await page.evaluate(() => {
    const w = window as unknown as { regStatus?: { ok: boolean; text: string } };
    new MutationObserver(() => {
      const e = document.querySelector("#register-status.ok, #register-status.bad");
      if (e && !w.regStatus) w.regStatus = { ok: e.classList.contains("ok"), text: e.textContent ?? "" };
    }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  await page.click("#register button[type=submit]");
  const reg = await (await page.waitForFunction(() => (window as unknown as { regStatus?: { ok: boolean; text: string } }).regStatus, null, { timeout: 120_000 })).jsonValue() as { ok: boolean; text: string };
  const regStatus = reg.text;
  check(reg.ok && db.mailboxOf(you)?.handle === "you" && db.identityOf("you", "localhost") === you && regStatus.includes(`${base}/@you`),
    `the page's Register form: signed over register you@localhost by the wallet in the tab, the host skein's app had the instance manager create your mailbox instance you@localhost (${regStatus.replace(/\s+/g, " ").slice(0, 160)})`);
  stores.push(db.get("you")!.store);
  const held = await page.evaluate(async ([c, type]) => {
    const w = (window as unknown as { site: { wallet: { listCertificates(a: unknown): Promise<{ certificates: Array<Record<string, unknown>> }> } } }).site.wallet;
    return (await w.listCertificates({ certifiers: [c], types: [type] })).certificates;
  }, [certifier, HANDLE_CERTIFICATE_TYPE] as const);
  const cert = held[0] as { serialNumber: string; subject: string; certifier: string; fields: Record<string, string>; keyring: Record<string, string> } | undefined;
  const read = cert ? { ...await MasterCertificate.decryptFields(new ProtoWallet(youKey), cert.keyring, cert.fields, certifier) } : {};
  const resolved = await (await fetch(`${base}/.well-known/metanet-handles/resolve?handle=you`)).json() as { certificate?: { serialNumber?: string } };
  check(held.length === 1 && cert!.subject === you && cert!.serialNumber === resolved.certificate?.serialNumber && read.handle === "you" && read.domain === "localhost",
    `the handle certificate is in the wallet in the tab (acquireCertificate, direct): listCertificates by the host's certifier and the handle type returns it, the serial resolve answers (the app's record), your keyring reads its fields (${JSON.stringify(read)})`);
  // I1 (#113): "Remove from wallet" (relinquishCertificate: the toolbox keeps a deleted row, unique on type, certifier and
  // serial), then register again: the app issues under a new serial, so the wallet takes it.
  const again = await page.evaluate(async ([origin, me, certifierKey, type, old]) => {
    const site = (window as unknown as { site: { wallet: { createSignature(a: unknown): Promise<{ signature: number[] }>; acquireCertificate(a: unknown): Promise<unknown>; relinquishCertificate(a: unknown): Promise<unknown>; listCertificates(a: unknown): Promise<{ certificates: Array<{ serialNumber: string }> }> }; boxes: Map<string, { af: { fetch(url: string, init: unknown): Promise<Response> } }> } }).site;
    const w = site.wallet;
    await w.relinquishCertificate({ type, serialNumber: old, certifier: certifierKey });
    const { domain } = await (await fetch(`${origin}/.well-known/skein-host`)).json() as { domain: string };
    const { signature } = await w.createSignature({ protocolID: [2, "skein register"], keyID: "you", counterparty: "anyone", data: Array.from(new TextEncoder().encode(`register you@${domain}`)) });
    // #135: a registration is a signed request — over the session the page's Register form opened with the host's origin.
    const r = await site.boxes.get(origin)!.af.fetch(`${origin}/account/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "you", identityKey: me, signature: signature.map((b) => b.toString(16).padStart(2, "0")).join("") }) });
    const v = await r.json() as { certificate: Record<string, unknown>; keyringForSubject: Record<string, string> };
    const c = v.certificate;
    try {
      await w.acquireCertificate({ acquisitionProtocol: "direct", type: c.type, serialNumber: c.serialNumber, certifier: c.certifier, revocationOutpoint: c.revocationOutpoint, fields: c.fields, signature: c.signature, keyringRevealer: "certifier", keyringForSubject: v.keyringForSubject });
    } catch (e) { return { status: r.status, error: (e as Error).message }; }
    const { certificates } = await w.listCertificates({ certifiers: [certifierKey], types: [type] });
    return { status: r.status, serialNumber: c.serialNumber as string, held: certificates.map((x) => x.serialNumber) };
  }, [base, you, certifier, HANDLE_CERTIFICATE_TYPE, cert!.serialNumber] as const);
  check(again.status === 200 && "held" in again && again.serialNumber !== cert!.serialNumber && again.held.length === 1 && again.held[0] === again.serialNumber,
    `the certificate removed from the wallet (relinquishCertificate), then registered again: a new serial (${"serialNumber" in again ? again.serialNumber : ""}), which the wallet acquires (${"error" in again ? again.error : `holds ${"held" in again ? again.held.length : 0}`})`);
  await page.goto(`${sitePage}${search}`);
  await ready();
  await page.waitForSelector('[data-handle="you@localhost"]', { timeout: 60_000 });
  const handles = await page.locator("#handles").innerText();
  check(handles.includes("you@localhost") && handles.includes(`${base}/@you`), `"Your handles" shows it, resolved to its messagebox (${handles.replace(/\s+/g, " ").trim()})`);

  // ------------------------------------------------ your profile (#104, #113: kept by the host skein's app)
  // The page's Profile form (skein-site 0.5.2) writes to your mailbox instance, which the host no longer reads; what it
  // sends once skein-site follows: the same signed record posted to the host's /account/profile.
  const avatar = `${"cd".repeat(32)}.0`;
  const posted = await page.evaluate(async ([origin, avatarBytes]) => {
    const w = (window as unknown as { site: { wallet: { createSignature(a: unknown): Promise<{ signature: number[] }> } } }).site.wallet;
    // The DAG-CBOR {domain, name, avatar} @1sat/utils encodeProfile writes (keys in canonical order: name, avatar, domain).
    const enc = new TextEncoder();
    const text = (s: string) => { const b = enc.encode(s); return [0x60 + b.length, ...b]; };
    const record = Uint8Array.from([0xa3, ...text("name"), ...text("You Yourself"), ...text("avatar"), 0x58, 36, ...avatarBytes, ...text("domain"), ...text("localhost")]);
    const { signature } = await w.createSignature({ protocolID: [1, "metanet handles profile"], keyID: "1", counterparty: "anyone", data: Array.from(record) });
    // #135: a write, so a signed request — over the wallet's session (the page's RawBox, as its Profile form sends it).
    const { RawBox } = await import(new URL("lib.js", location.href).href) as { RawBox: new (w: unknown, u: string) => { af: { fetch: typeof fetch } } };
    const r = await new RawBox(w, origin).af.fetch(`${origin}/account/profile`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle: "you", record: btoa(String.fromCharCode(...record)), signature: signature.map((b) => b.toString(16).padStart(2, "0")).join("") }) });
    return { status: r.status, text: await r.text() };
  }, [base, Array.from(outpointToBytes(avatar.replace(".", "_"))!)] as const);
  check(posted.status === 200, `your profile, signed by the wallet in the tab, posted to the host (/account/profile → the host skein's app): ${posted.status} ${posted.text.slice(0, 120)}`);
  const res = await (await fetch(`${base}/.well-known/metanet-handles/resolve?handle=you`)).json() as { identityKey: string; displayName?: string; avatarURL?: string; profile?: { record: string; signature: string } };
  const signedOk = res.profile ? (await new ProtoWallet("anyone").verifySignature({ protocolID: PROFILE_PROTOCOL, keyID: PROFILE_KEY_ID, counterparty: you, data: Utils.toArray(res.profile.record, "base64"), signature: Utils.toArray(res.profile.signature, "hex") })).valid : false;
  const rec = res.profile ? decodeProfile(Utils.toArray(res.profile.record, "base64")) : undefined;
  check(signedOk && rec?.domain === "localhost" && rec.name === "You Yourself" && outpointFromBytes(rec.avatar ?? []) === avatar.replace(".", "_") && res.displayName === "You Yourself" && res.avatarURL === undefined,
    `resolve carries the profile, signed by your key (verified here): ${JSON.stringify({ ...rec, avatar: rec?.avatar ? outpointFromBytes(rec.avatar) : undefined })}, displayName ${res.displayName}; no avatarURL (the app's config.onboard.ordfs empty)`);
  const mf = await (await fetch(`${base}/manifest.json`)).json() as { metanet: { trust: { name?: string }; handles: { search?: string } } };
  check(mf.metanet.trust.name === "Test host" && mf.metanet.handles.search === `${base}/.well-known/metanet-handles/search`, `the manifest names the host (${mf.metanet.trust.name}, the app's config) and its search endpoint`);
  await page.fill("#search input[name=q]", "yourself");
  await page.click("#search button[type=submit]");
  await page.waitForSelector('tr[data-result="you@localhost"], #search-status.bad', { timeout: 60_000 });
  if (await page.locator("#search-status.bad").count()) throw new Error(`search: ${await page.locator("#search-status").innerText()}`);
  const found = (await page.locator("#search-results").innerText()).replace(/\s+/g, " ").trim();
  check((await page.locator("#search-results tr").count()) === 1 && /you@localhost You Yourself \(profile signed by its key\)/.test(found),
    `Find a handle: the host's search finds you by your profile's name; the result's profile verified in the page (${found.slice(0, 120)})`);

  // ------------------------------------------------ the Inbox (#99), opened on that messagebox
  await page.goto(`${sitePage}${search}#/inbox`);
  await ready();
  await page.waitForSelector("#inbox-from", { timeout: 60_000 });
  check(await page.locator("#inbox input[name=url]").inputValue() === `${base}/@you` && (await page.locator("#inbox-from").innerText()).includes("you@localhost"),
    `the Inbox's mailbox URL is prefilled from your handle (${await page.locator("#inbox input[name=url]").inputValue()})`);
  await page.waitForFunction(() => !/^listing/.test(document.getElementById("inbox-status")?.textContent ?? ""), null, { timeout: 120_000 });
  // The mailbox's own origin (the router's <handle>.localhost form): the stock client shakes hands at <origin>/.well-known/auth.
  const mailbox = `http://you.localhost:${port}`;
  // A BRC-169 §7.3 envelope in DAG-CBOR (1sat-sdk's actions/src/mandala/envelope.ts layout): `payment` the
  // BRC-29 delivery, `content` a BRC-78 message of a MIME entity, signed by the sender under
  // [2, "metanet handles envelope"], key ID "send", counterparty anyone, over the map without content and signature.
  const mime = Buffer.from("Content-Type: text/plain; charset=utf-8\r\n\r\nfor the Inbox", "utf8");
  const unsigned = {
    metanetHandles: "1.0",
    recipient: { handle: "you", domain: "localhost" },
    sender: { identityKey: Uint8Array.from(payer.toPublicKey().encode(true) as number[]) },
    created: "2026-10-04T12:00:00Z",
    payment: { derivationPrefix: dPrefix, derivationSuffix: dSuffix, protocol: Uint8Array.from(Buffer.from("3241645161d8")), satoshis: 50_000, beef: Uint8Array.from(delivery.toAtomicBEEF()) },
    contentHash: Uint8Array.from(Hash.sha256(Array.from(mime))),
  };
  const { signature: envSig } = await new ProtoWallet(payer).createSignature({ data: Array.from(dagCbor.encode(unsigned)), protocolID: [2, "metanet handles envelope"], keyID: "send", counterparty: "anyone" });
  const envelope = dagCbor.encode({ ...unsigned, content: Uint8Array.from(EncryptedMessage.encrypt(Array.from(mime), payer, youKey.toPublicKey())), signature: Uint8Array.from(envSig) });
  const sent = await new RawBox(ephemeralWallet(payer), `${base}/@you`).send(you, "metanet_inbox", envelope);
  check(!!sent.id, `a sender delivers a payment to your mailbox instance, box metanet_inbox (BRC-231 on its session): ${sent.id}`);

  // The stock client shakes hands at the URL's origin, so for it the dev form above is not the mailbox: its <handle>.localhost origin is.
  await page.fill("#inbox input[name=url]", mailbox);
  check(await page.locator("#inbox input[name=box]").inputValue() === "metanet_inbox", "the Inbox's box defaults to metanet_inbox");
  await page.click("#inbox button[type=submit]");
  await page.waitForSelector("#inbox-messages, #inbox-status.bad", { timeout: 120_000 });
  if (await page.locator("#inbox-status.bad").count()) throw new Error(`inbox: ${await page.locator("#inbox-status").innerText()}`);
  const listed = await page.locator("#inbox-messages tbody tr").count();
  const row = await page.locator("#inbox-messages").innerText();
  check(listed === 1 && (await page.locator(`tr[data-message="${sent.id}"]`).count()) === 1 && /BRC-169 envelope of 2026-10-04T12:00:00Z: a payment of 50000 sats/.test(row),
    `the page lists what is waiting: @bsv/message-box-client's listMessagesLite against skein's messagebox, on your wallet's session (${row.replace(/\s+/g, " ").slice(0, 160)})`);
  await page.goto(`${sitePage}${search}#/inbox`);
  await ready();
  await page.waitForSelector("#inbox-messages", { timeout: 120_000 });
  check(await page.locator("#inbox input[name=url]").inputValue() === mailbox, "the mailbox's URL is kept in the browser: the Inbox opens on it and lists it");

  await page.click("#sync");
  await page.waitForFunction(() => /received \d+, skipped \d+|sync: /.test(document.getElementById("sync-result")?.textContent ?? ""), null, { timeout: 120_000 });
  const synced = (await page.locator("#sync-result").innerText()).trim();
  const txid = delivery.id("hex");
  const receipt = page.locator(`#sync-received tr[data-message="${sent.id}"]`);
  const cells = (await receipt.count()) ? (await receipt.locator("td").allInnerTexts()).map((t) => t.trim()) : [];
  check(synced === "received 1, skipped 0" && (await receipt.count()) === 1 && (await receipt.locator("td").first().getAttribute("title")) === txid && cells[1] === "50000" && cells[2] === "for the Inbox",
    `Sync runs @1sat/actions' syncMetanetInbox over that mailbox's metanet_inbox with the wallet in the tab and shows its result (${synced}): the delivery received, its txid, sats and memo (${cells.join(" | ")})`);
  await page.waitForFunction(() => /Nothing waiting/.test(document.getElementById("inbox-messages")?.textContent ?? ""), null, { timeout: 120_000 });
  check(!(await page.locator("#inbox-status.bad").count()) && !(await page.locator("#error").count()),
    "the page lists the box again after the sync: nothing waiting (the SDK acknowledged the delivery), and nothing failed in the page");
  const paid = await page.evaluate(async (id) => {
    const w = (window as unknown as { site: { wallet: { listActions(a: unknown): Promise<{ actions: { txid: string; outputs?: { satoshis: number }[] }[] }> } } }).site.wallet;
    const { actions } = await w.listActions({ labels: ["metanet payment"], includeOutputs: true });
    return actions.filter((a) => a.txid === id).flatMap((a) => a.outputs ?? []).reduce((n, o) => n + o.satoshis, 0);
  }, txid);
  check(paid === 50_000, `the wallet in the tab holds the payment: its action labelled "metanet payment", txid ${txid}, ${paid} sats`);
} catch (e) {
  check(false, `threw: ${(e as Error).stack}`);
} finally {
  await browser.close();
  await host?.stop();
  db.close();
  gitServer.closeAllConnections(); gitServer.close();
  services.closeAllConnections(); services.close();
  for (const store of stores) {
    const rp = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), store], { encoding: "utf8" });
    process.stdout.write(rp.stdout);
    if (rp.status !== 0) process.stdout.write(rp.stderr);
    check(rp.status === 0 && /identical .*the source store reproduced exactly/.test(rp.stdout), `${store.split("/").at(-2)}'s store replays to itself exactly`);
  }
  if (failures && verbose) for (const l of lines.slice(-80)) process.stdout.write(`  | ${l}\n`);
  if (!process.env.KEEP) { await fs.rm(home, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); }
}
process.stdout.write(failures ? `site: ${failures} FAILED\n` : "site: all ok\n");
process.exit(failures ? 1 : 0);

// The default image and the claim (#89, #127, #143), end to end on a router:
//
//   an instance booted from the default image (images/default) — its genesis
//   names no root; its admin routes are root's and nobody holds root; the
//   claim route (box `claim`, open, to the kernel); it serves the management
//   site at `/`, `/site/` and `/manifest.json` (#141: chain, git and site
//   installed at birth, root's read route at `/`); its explorer is root's
//   (403 before the claim), and the gate takes no message in an admin box.
//
//   The owner claims it with a message from the owner's wallet (`skein
//   claim`, sent on its session): root is granted to the message's sender
//   (#127, #143), never a key in the body — a body naming another key changes
//   nothing. In one step the kernel writes the grants and removes the claim
//   route; the head `claim` names what was claimed (the sender as claimant,
//   the messagebox); the claimant's mailbox goes into the address book. A
//   second claim (a stranger's message into `claim`) finds no route. Nothing
//   waits on the claim (#143: git's `call` is root's), and root installs
//   programs/test/app-demo with its messages and calls it.
//
//   A claim signed before the instance existed (#127: naming no recipient,
//   what a registrant's page signs and the host forwards) claims a fresh
//   image for its signer, as the instance's first entry; a message naming no
//   recipient in any other box is refused at the front door.
//
//   An instance with root held refuses a claim: a stock instance whose root
//   added a claim route to its table keeps its grants when a claim comes.
//
//   `skein-host add --image default` writes the same image (its genesis: no
//   owner, the image's tree); `--image <outpoint>` is refused (no ORDFS app yet).
//
// Both instances' stores then replay to themselves exactly.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/claim.ts

import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";
import type { CID } from "multiformats/cid";
import * as dagCbor from "@ipld/dag-cbor";
import { RawBox, signClaim } from "../../src/client/raw.ts";
import { planClaim } from "../../src/client/admin.ts";
import { adminMain } from "../../src/client/admin-cli.ts";
import { writeFileSync } from "node:fs";
import { encode } from "../../src/runtime/cid.ts";
import { main } from "../../src/host/cli.ts";
import { ownerCli, sendPlan } from "../../src/testapps.ts";
import { dirSource } from "../../src/host/boot.ts";
import { testHost, until } from "../../src/host/testhost.ts";
import { openStoreFile } from "../../src/runtime/index-store.ts";
import { ephemeralWallet } from "../../src/wallet.ts";

const here = dirname(fileURLToPath(import.meta.url));
const demoDir = join(here, "../../programs/test/app-demo");
const imageDir = join(here, "../../images/default");
let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };
const hex = (b: unknown) => b instanceof Uint8Array ? Buffer.from(b).toString("hex") : String(b);

/** An instance's genesis record, read from its store file (read-only, beside the kernel). */
async function genesisOf(handle: string): Promise<Record<string, unknown> | undefined> {
  const s = openStoreFile(h.db.get(handle)!.store, { readOnly: true });
  try {
    for await (const { entry } of s.log.entries(0)) return await s.get((entry as { genesis: CID }).genesis) as Record<string, unknown>;
    return undefined;
  } finally { s.close(); }
}

const afters: Array<() => unknown> = [];
const h = await testHost({ after: (f) => afters.push(f) });
const stores: string[] = [];
try {
  h.mailbox("david", h.ownerId);
  const booted = await h.image("inst");
  const inst = h.db.get("inst")!.identity!;
  await h.router.start();
  stores.push(h.db.get("inst")!.store);
  const k = async (handle = "inst") => (await h.router.hydrate(handle)).kernel;
  const rows = async (handle = "inst") => (await (await k(handle)).dispatch()).rows as Array<Record<string, unknown>>;
  const kernelRows = async (handle = "inst") => (await rows(handle)).filter((r) => r.program === "kernel").map((r) => String(r.address));
  /** The root holders (hex, 8) as the head `grants` names them (#143). */
  const roots = async (handle = "inst") => {
    const c = await (await k(handle)).call("head", "grants") as CID | null;
    if (!c) return [];
    return (((await (await k(handle)).store.get(c)) as { roles?: Record<string, Uint8Array[]> }).roles?.root ?? []).map((x) => hex(x).slice(0, 8));
  };
  const cli = async (...args: string[]) => {
    const out: string[] = [], err: string[] = [];
    // #124: install/uninstall are the owner's messages, planned and sent on the owner's session (src/testapps.ts ownerCli).
    const o = args[0] === "install" || args[0] === "uninstall" ? await ownerCli({ home: h.home, port: h.router.port!, owner: h.owner, settled: () => h.router.settled() }, args) : undefined;
    if (o) { out.push(...o.out); err.push(...o.err); }
    const code = o ? o.code : await main(args, {
      vars: { SKEIN_HOME: h.home, HOME: h.home }, out: (l) => out.push(l), err: (l) => err.push(l),
    });
    await h.router.settled();
    if (process.env.VERBOSE) for (const l of [...out, ...err]) process.stdout.write(`  | ${l}\n`);
    return { code, out, err };
  };

  // ------------------------------------------------ the image, unclaimed
  const image = await dirSource(imageDir);
  check(!!booted.tree && booted.tree.equals(image.root), `booted from the default image's tree ${booted.tree} (programs ${booted.programs.join(", ")})`);
  const g = (await genesisOf("inst"))!;
  check(g.root === undefined && g.owner === undefined && (g.tree as CID).equals(image.root), "the genesis names no root, and the image's tree");
  check((await kernelRows()).join(",") === "objects,head,dispatch,peers,grant,claim" && (await roots()).length === 0, `the admin routes (root's: nobody holds it) and the claim route: ${(await kernelRows()).join(", ")}`);
  for (const path of ["/", "/site/", "/site/app.js", "/manifest.json"]) {
    const r = await fetch(`${h.base}/@inst${path}`);
    check(r.status === 200, `GET ${path}: 200, the site installed at birth serves it (#141: its read route under /site/, root's at /): ${r.status}`);
  }
  check(["chain/app", "git/app", "site/app"].every((n) => g.heads && (g.heads as Record<string, unknown>)[n]), `#141: the genesis names the heads chain/app, git/app and site/app (${Object.keys((g.heads as object) ?? {}).join(", ")})`);
  const unread = await new RawBox(h.owner, `${h.base}/@inst`).af.fetch(`${h.base}/@inst/explore`, { method: "GET" });
  check(unread.status === 403, `before the claim the explorer is nobody's (#143: root's, and no one holds root): ${unread.status}`);
  check(!(await rows()).some((x) => x.sender !== undefined), "#143: no route names a sender");
  const linesB = h.lines.length;
  await new RawBox(h.owner, `${h.base}/@inst`).send(inst, "objects", { records: [] });
  await h.router.settled();
  check(h.lines.slice(linesB).some((l) => /in objects from .*: objects is gated \(root\).*recorded, nothing runs/.test(l)), "before the claim, the owner's message to `objects` is gated away: root's, and nobody holds root");

  // ------------------------------------------------ the claim: the owner's own message (#127)
  const stranger = PrivateKey.fromRandom(), strangerId = stranger.toPublicKey().toString();
  const lines0 = h.lines.length;
  const plan = planClaim(inst, { messagebox: h.origin("david") });
  (plan.messages[0]!.body as Record<string, unknown>).owner = strangerId; // a key in the body is not read: root goes to the sender
  await sendPlan({ port: h.router.port!, owner: h.owner, settled: () => h.router.settled() }, "inst", plan);
  check(h.lines.slice(lines0).some((l) => /kernel claim: root [0-9a-f]+; the claim route removed; the claimant's messagebox in the address book/.test(l)), "the kernel took the claim in one step (one log line)");
  const owner8 = h.ownerId.slice(0, 8);
  check((await roots()).join(",") === owner8, `#143: root granted to the claim's sender, not the body's key (${(await roots()).join(", ")})`);
  check((await kernelRows()).join(",") === "objects,head,dispatch,peers,grant", `the claim route gone: ${(await kernelRows()).join(", ")}`);
  const claimRoot = await (await k()).call("head", "claim") as CID | null;
  const claimed = claimRoot ? await (await k()).store.get(claimRoot) as { claimant?: unknown; messagebox?: string } : undefined;
  check(hex(claimed?.claimant) === h.ownerId && claimed?.messagebox === h.origin("david"), `the head \`claim\` names what was claimed: the sender (not the body's key) and its messagebox (${claimed?.messagebox})`);
  const peers = await (await k()).call("head", "peers") as CID | null;
  const book = peers ? await Promise.all((((await (await k()).store.get(peers)) as { peers?: Array<{ peer: CID }> }).peers ?? []).map(async (p) => await (await k()).store.get(p.peer) as { key: Uint8Array; address: string; source: string })) : [];
  check(book.some((p) => hex(p.key) === h.ownerId && p.address === h.origin("david") && p.source === "claim"), "the owner's messagebox is in the address book (source claim)");
  // The explorer: root's (the genesis's roles) — the claimant's now.
  const ex = await new RawBox(h.owner, `${h.base}/@inst`).af.fetch(`${h.base}/@inst/explore/head/claim`, { method: "GET" });
  check(ex.status === 200 && (await ex.text()).includes(claimRoot!.toString()), `after the claim the owner reads the explorer: GET /explore/head/claim → ${ex.status}`);
  const other = await new RawBox(ephemeralWallet(PrivateKey.fromRandom()), `${h.base}/@inst`).af.fetch(`${h.base}/@inst/explore`, { method: "GET" });
  check(other.status === 403, `and another key does not (${other.status})`);

  // ------------------------------------------------ a second claim
  const byStranger = await new RawBox(ephemeralWallet(stranger), `${h.base}/@inst`).send(inst, "claim", { owner: strangerId }).then(() => "sent", (e: Error) => e.message);
  check(/403 ERR_NOT_SUBSCRIBED/.test(byStranger), `a stranger's sendMessage into \`claim\` finds no route (${byStranger})`);
  check((await roots()).join(",") === owner8, "root is still the claimant's alone");

  // ------------------------------------------------ the apps installed at birth: nothing to add (#141, #143)
  // `skein install images/default/apps/git --instance inst`, signed with the root key in the client, over the host's
  // control socket: the tree, the record and the routes are the instance's already — nothing is sent.
  await h.router.listenControl(join(h.home, "host.sock"));
  const keyFile = join(h.home, "operator.key");
  writeFileSync(keyFile, `${h.ownerKey.toHex()}\n`, { mode: 0o600 });
  const iout: string[] = [], ierr: string[] = [];
  const icode = await adminMain("install", [join(imageDir, "apps/git"), "--instance", "inst"], { vars: { SKEIN_HOME: h.home, SKEIN_OPERATOR_KEY: keyFile }, out: (l) => iout.push(l), err: (l) => ierr.push(l) });
  await h.router.settled();
  check(icode === 0 && iout.some((l) => /: 1 message sent/.test(l)), `skein install images/default/apps/git --instance inst after the claim: one message (the head again: the image wrote its routes) (${[...iout, ...ierr].filter((l) => /sent|dispatch add|install:/.test(l)).join(" | ")})`);

  // ------------------------------------------------ the owner installs an app
  let r = await cli("install", demoDir, "--instance", "inst");
  check(r.code === 0, `skein install app-demo into the claimed image: exit ${r.code} ${r.err.join(" ")}`);
  const app = await (await k()).call("head", "app-demo/app") as CID | null;
  check(!!app, "the head app-demo/app is the app record");
  const call = async (body: unknown) => {
    const res = await new RawBox(h.owner, `${h.base}/@inst`).af.fetch(`${h.base}/@inst/app-demo/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, v: JSON.parse(await res.text()) as { result?: { count: number } } };
  };
  let c = await call({ fn: "demo.counter.add", args: { by: 3 } });
  check(c.status === 200 && c.v.result?.count === 3, `POST /app-demo/call add {by: 3}: ${c.status} ${JSON.stringify(c.v)}`);
  const ticked = await until("the first tick", async () => {
    await h.router.settled();
    const rec = await (await k()).store.get((await (await k()).call("head", "app-demo/app")) as CID) as { state?: CID };
    const s = rec.state ? await (await k()).store.get(rec.state) as { ticks: number } : undefined;
    return s && s.ticks >= 1 ? s : undefined;
  }, 20_000).catch(() => undefined);
  check(!!ticked, "its start scheduled a heartbeat with the cron provider ($cron, from the image's address book), and the tick came");

  // ------------------------------------------------ an instance with root held refuses a claim
  h.instance("owned");
  await h.router.hydrate("owned");
  stores.push(h.db.get("owned")!.store);
  const ownedId = h.db.get("owned")!.identity!;
  await new RawBox(h.owner, `${h.base}/@owned`).send(ownedId, "dispatch", { op: "add", row: { transport: "mailbox", address: "claim", program: "kernel", fn: "claim" } });
  await h.router.settled();
  check(!(await kernelRows("owned")).includes("claim"), "#143: root of a stock instance cannot add a claim route (root is held: refused)");
  const late = await new RawBox(ephemeralWallet(stranger), `${h.base}/@owned`).send(ownedId, "claim", {}).then(() => "sent", (e: Error) => e.message);
  await h.router.settled();
  check(/403 ERR_NOT_SUBSCRIBED/.test(late), `a claim into it finds no route, nothing done (${late})`);
  check((await roots("owned")).join(",") === owner8, "its grants are unchanged");

  // ------------------------------------------------ skein-host add --image
  r = await cli("add", "fresh", "--image", `${"ab".repeat(32)}_0`);
  check(r.code === 2 && r.err.some((l) => /ORDFS app, which is not built yet/.test(l)), `--image <outpoint> is refused for now: ${r.err.join(" ")}`);
  r = await cli("add", "fresh", "--image", "default");
  check(r.code === 0 && r.out.some((l) => l.includes(`booted from the image ${image.root}`)), `skein-host add fresh --image default: exit ${r.code} ${[...r.out, ...r.err].join(" ")}`);
  const fg = await genesisOf("fresh");
  check(!!fg && fg.root === undefined && (fg.tree as CID).equals(image.root) && (fg.dispatch as Array<{ fn?: string }>).filter((x) => x.fn).map((x) => x.fn).includes("claim"), "its genesis: no root, the default image's tree, the claim route");

  // ------------------------------------------------ a claim signed before the instance existed (#127)
  await h.image("fresh2");
  await h.router.hydrate("fresh2");
  stores.push(h.db.get("fresh2")!.store);
  const signer = PrivateKey.fromRandom(), signerId = signer.toPublicKey().toString();
  const lines3 = h.lines.length;
  // A message naming no recipient in another box is not a claim: the front door refuses it.
  const loose = { kind: "mail", op: "put", sender: Uint8Array.from(Buffer.from(signerId, "hex")), box: "objects", body: encode({}).cid, nonce: new Uint8Array(16) };
  const { signature } = await ephemeralWallet(signer).createSignature({ protocolID: [2, "metanet handles envelope"], keyID: "send", counterparty: "anyone", data: [...dagCbor.encode(loose)] });
  const notClaim = await h.router.appendLocal("fresh2", { kind: "message", message: { ...loose, signature: Uint8Array.from(signature) }, body: dagCbor.encode({}) }).then(() => "admitted", (e: Error) => e.message);
  await h.router.settled();
  check(/admit: a request record in its transport's shape/.test(notClaim) && !h.lines.slice(lines3).some((l) => /kernel objects/.test(l)), `a message naming no recipient outside box \`claim\` is not admitted (${notClaim.slice(0, 70)})`);
  const fwd = await signClaim(ephemeralWallet(signer));
  check(fwd.message.recipient === undefined, "the signed claim names no recipient");
  await h.router.appendLocal("fresh2", { kind: "message", message: fwd.message, body: fwd.body });
  await h.router.settled();
  check((await roots("fresh2")).join(",") === signerId.slice(0, 8), `the forwarded claim: the signer is root (${(await roots("fresh2")).join(", ")})`);
} catch (e) {
  check(false, `threw: ${(e as Error).stack}`);
} finally {
  // testhost's afters: [remove the home, stop the router]: the router first, the replays, then the home.
  const [removeHome, ...rest] = afters;
  for (const f of rest.reverse()) await f();
  for (const store of stores) {
    const rp = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), store], { encoding: "utf8" });
    process.stdout.write(rp.stdout);
    if (rp.status !== 0) process.stdout.write(rp.stderr);
    check(rp.status === 0 && /identical .*the source store reproduced exactly/.test(rp.stdout), `${store.split("/").at(-2)}'s store replays to itself exactly`);
  }
  if (!process.env.KEEP) await removeHome?.();
}
process.stdout.write(failures ? `claim: ${failures} FAILED\n` : "claim: all ok\n");
process.exit(failures ? 1 : 0);

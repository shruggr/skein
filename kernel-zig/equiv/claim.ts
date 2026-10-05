// The default image and the claim (#89), end to end on a router:
//
//   an instance booted from the default image (images/default) — its genesis
//   names no owner and has no admin rows, only the claim row (box `claim`,
//   from anyone, to the kernel); it serves the management site at `/` and
//   `/site/` (the static app, #92), it has no explorer row (#121: every sender
//   is a key, and the claim brings the owner's), and it takes no owner's
//   message in an admin box.
//
//   `skein-host claim` (through the router's control socket) delivers the
//   owner's claim as a `local` request from the host's instance manager: in one
//   step the kernel writes the owner's four admin rows and the explorer row
//   with the owner's key (#121), and removes the claim row; the head `claim` names what was claimed; the owner's mailbox on this
//   host goes into the address book. A second claim finds no row and runs
//   nothing (`skein-host claim` exits 1); a stranger's sendMessage into `claim`
//   is refused. The owner then installs programs/test/app-demo with
//   the owner's messages (`skein plan install`, #124) and calls it.
//
//   An instance that is owned already refuses a claim: a stock instance whose
//   owner added a claim row to its table keeps its rows when a claim comes.
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
import { RawBox } from "../../src/client/raw.ts";
import { main } from "../../src/host/cli.ts";
import { ownerCli } from "../../src/testapps.ts";
import { CONTROL_SOCKET } from "../../src/host/control.ts";
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
  await h.router.listenControl(join(h.home, CONTROL_SOCKET));
  stores.push(h.db.get("inst")!.store);
  const k = async (handle = "inst") => (await h.router.hydrate(handle)).kernel;
  const rows = async (handle = "inst") => (await (await k(handle)).dispatch()).rows as Array<Record<string, unknown>>;
  const kernelRows = async (handle = "inst") => (await rows(handle)).filter((r) => r.program === "kernel").map((r) => `${r.address}<-${r.sender instanceof Uint8Array ? hex(r.sender).slice(0, 8) : r.sender}`);
  const cli = async (...args: string[]) => {
    const out: string[] = [], err: string[] = [];
    // #124: install/uninstall are the owner's messages, planned (`skein plan`) and sent to /sendMessage (src/testapps.ts ownerCli).
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
  check(g.owner === undefined && (g.tree as CID).equals(image.root), "the genesis names no owner, and the image's tree");
  check((await kernelRows()).join(",") === "claim<-*", `the only kernel row is the claim row, from anyone: ${(await kernelRows()).join(", ")}`);
  const home = await fetch(`${h.base}/@inst/`);
  const page = await home.text();
  check(home.status === 200 && page.includes('src="site/app.js"'), `GET / : the management site, served by the static app (${home.status})`);
  const js = await fetch(`${h.base}/@inst/site/app.js`);
  check(js.status === 200 && /javascript/.test(js.headers.get("content-type") ?? "") && (await js.text()).includes("skein-locators"), `GET /site/app.js: the site's files under /site/ (${js.status})`);
  const unread = await fetch(`${h.base}/@inst/explore`);
  check(unread.status === 404, `before the claim there is no explorer row (#121: the claim writes it with the owner's key): ${unread.status}`);
  check(!(await rows()).some((x) => x.sender === "owner"), "#121: no row names the `owner` symbol");
  const before = await new RawBox(h.owner, `${h.base}/@inst`).send(inst, "objects", { records: [] }).then(() => "sent", (e: Error) => e.message);
  check(/403 ERR_NOT_SUBSCRIBED/.test(before), `before the claim, the owner's message to \`objects\` is refused: no admin row (${before})`);

  // ------------------------------------------------ the claim
  const lines0 = h.lines.length;
  let r = await cli("claim", "inst", h.ownerId);
  check(r.code === 0 && r.out.some((l) => /claimed by .* by the running router/.test(l)), `skein-host claim inst <owner> through the control socket: exit ${r.code} ${[...r.out, ...r.err].join(" ")}`);
  check(h.lines.slice(lines0).some((l) => /kernel claim: owner [0-9a-f]+: admin rows objects, head, dispatch, peers, the explorer row; the claim row removed; the owner's messagebox in the address book/.test(l)), "the kernel took the claim in one step (one log line)");
  const explorer = (await rows()).filter((x) => x.transport === "http" && x.address === "/explore");
  check(explorer.length === 1 && explorer[0]!.prefix === true && explorer[0]!.fn === "explore" && explorer[0]!.sender instanceof Uint8Array && hex(explorer[0]!.sender) === h.ownerId, `#121: the claim wrote the explorer row with the owner's real key (${explorer.map((x) => x.sender instanceof Uint8Array ? hex(x.sender).slice(0, 8) : String(x.sender)).join(", ")})`);
  const owner8 = h.ownerId.slice(0, 8);
  check((await kernelRows()).join(",") === ["objects", "head", "dispatch", "peers"].map((o) => `${o}<-${owner8}`).join(","), `the owner's four admin rows, the claim row gone: ${(await kernelRows()).join(", ")}`);
  const claimRoot = await (await k()).call("head", "claim") as CID | null;
  const claimed = claimRoot ? await (await k()).store.get(claimRoot) as { owner?: unknown; messagebox?: string } : undefined;
  check(hex(claimed?.owner) === h.ownerId && claimed?.messagebox === h.origin("david"), `the head \`claim\` names what was claimed: the owner and its messagebox (${claimed?.messagebox})`);
  const peers = await (await k()).call("head", "peers") as CID | null;
  const book = peers ? await Promise.all((((await (await k()).store.get(peers)) as { peers?: Array<{ peer: CID }> }).peers ?? []).map(async (p) => await (await k()).store.get(p.peer) as { key: Uint8Array; address: string; source: string })) : [];
  check(book.some((p) => hex(p.key) === h.ownerId && p.address === h.origin("david") && p.source === "claim"), "the owner's messagebox is in the address book (source claim)");
  // #92: the image's read rule {op: explore, owner: true} — the owner as the front door sees it now, the claim's.
  const ex = await new RawBox(h.owner, `${h.base}/@inst`).af.fetch(`${h.base}/@inst/explore/head/claim`, { method: "GET" });
  check(ex.status === 200 && (await ex.text()).includes(claimRoot!.toString()), `after the claim the owner reads the explorer: GET /explore/head/claim → ${ex.status}`);
  const other = await new RawBox(ephemeralWallet(PrivateKey.fromRandom()), `${h.base}/@inst`).af.fetch(`${h.base}/@inst/explore`, { method: "GET" });
  check(other.status === 403, `and another key does not (${other.status})`);

  // ------------------------------------------------ a second claim
  const stranger = PrivateKey.fromRandom(), strangerId = stranger.toPublicKey().toString();
  const lines1 = h.lines.length;
  r = await cli("claim", "inst", strangerId);
  check(r.code === 1 && r.err.some((l) => /was refused/.test(l)), `a second claim is refused: exit ${r.code} ${r.err.join(" ")}`);
  check(h.lines.slice(lines1).some((l) => / in claim from [0-9a-f]+: no dispatch row; recorded, nothing runs/.test(l)), "the second claim found no row: recorded, nothing runs");
  const byStranger = await new RawBox(ephemeralWallet(stranger), `${h.base}/@inst`).send(inst, "claim", { owner: strangerId }).then(() => "sent", (e: Error) => e.message);
  check(/403 ERR_NOT_SUBSCRIBED/.test(byStranger), `a stranger's sendMessage into \`claim\` is refused (${byStranger})`);
  check((await kernelRows()).every((x) => x.endsWith(`<-${owner8}`)), "the admin rows are still the owner's");

  // ------------------------------------------------ the owner installs an app
  r = await cli("install", demoDir, "--instance", "inst");
  check(r.code === 0, `skein plan install app-demo into the claimed image: exit ${r.code} ${r.err.join(" ")}`);
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

  // ------------------------------------------------ an owned instance refuses a claim
  h.instance("owned");
  await h.router.hydrate("owned");
  stores.push(h.db.get("owned")!.store);
  const ownedId = h.db.get("owned")!.identity!;
  await new RawBox(h.owner, `${h.base}/@owned`).send(ownedId, "dispatch", { op: "add", row: { transport: "mailbox", address: "claim", sender: "*", program: "kernel", fn: "claim" } });
  await h.router.settled();
  check((await kernelRows("owned")).includes("claim<-*"), "the owner of a stock instance added a claim row");
  const lines2 = h.lines.length;
  const refused = await h.router.claim("owned", strangerId);
  check(!refused.claimed && h.lines.slice(lines2).some((l) => /kernel claim refused: the genesis names its owner: this instance is not an image; nothing done/.test(l)), "a claim into an owned instance is refused, nothing done");
  check((await kernelRows("owned")).filter((x) => x.startsWith("claim")).length === 1 && (await kernelRows("owned")).filter((x) => !x.startsWith("claim")).every((x) => x.endsWith(`<-${owner8}`)), "its rows are unchanged");

  // ------------------------------------------------ skein-host add --image
  r = await cli("add", "fresh", "--image", `${"ab".repeat(32)}_0`);
  check(r.code === 2 && r.err.some((l) => /ORDFS app, which is not built yet/.test(l)), `--image <outpoint> is refused for now: ${r.err.join(" ")}`);
  r = await cli("add", "fresh", "--image", "default");
  check(r.code === 0 && r.out.some((l) => l.includes(`booted from the image ${image.root}`)), `skein-host add fresh --image default: exit ${r.code} ${[...r.out, ...r.err].join(" ")}`);
  const fg = await genesisOf("fresh");
  check(!!fg && fg.owner === undefined && (fg.tree as CID).equals(image.root) && (fg.dispatch as Array<{ fn?: string }>).filter((x) => x.fn).map((x) => x.fn).includes("claim"), "its genesis: no owner, the default image's tree, the claim row");
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

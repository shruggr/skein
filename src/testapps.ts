// The apps tests and equivs install (skein next: the first cut's — the chain app and the overlay),
// from a checkout: $SKEIN_CHAIN_DIR / $SKEIN_OVERLAY_DIR name one, else the pinned commit is fetched
// once into <tmpdir>/skein-apps/<name>-<rev> and reused ($SKEIN_CHAIN_REV / $SKEIN_OVERLAY_REV another
// commit). They install through the real path: root's requests (src/client/admin.ts planInstallApp),
// signed by the owner and handed to the router (Router.messageLocal), as the client's are. Not part of
// anything that runs.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WalletInterface } from "@bsv/sdk";
import { planInstallApp, planUninstallApp, type AdminPlan } from "./client/admin.ts";
import { requestPayload, signRequest } from "./client/raw.ts";
import { WASM_DIR, wasmDirObjects } from "./host/boot.ts";
import { instanceView, readApp, type InstanceView } from "./host/install.ts";
import { storeSpec } from "./runtime/index-store.ts";
import { openStoreFile, storeExists } from "./host/stores.ts";
import type { Router } from "./host/router.ts";

export interface PinnedApp { name: string; repo: string; rev: string; dir?: string }

/** shruggr/skein-chain: the chain app (skein next: rows, the BEEF check, the rejected row). Its `next` branch's worktree until it is tagged. */
export const CHAIN_APP: PinnedApp = {
  name: "chain", repo: "https://github.com/shruggr/skein-chain",
  rev: process.env.SKEIN_CHAIN_REV ?? "next", dir: process.env.SKEIN_CHAIN_DIR,
};
/** shruggr/skein-overlay: the overlay engine (skein next: the submit and sync rows, the read rows). */
export const OVERLAY_APP: PinnedApp = {
  name: "overlay", repo: "https://github.com/shruggr/skein-overlay",
  rev: process.env.SKEIN_OVERLAY_REV ?? "next", dir: process.env.SKEIN_OVERLAY_DIR,
};

/** A checkout of the app: its env directory, else the pinned commit, fetched once. */
export function appCheckout(app: PinnedApp): string {
  if (app.dir) return app.dir;
  const cache = join(tmpdir(), "skein-apps");
  const dir = join(cache, `${app.name}-${app.rev}`);
  if (existsSync(join(dir, "etc/app.json"))) return dir;
  mkdirSync(cache, { recursive: true });
  // Fetched beside, then renamed into place: two test files may want it at once.
  const tmp = mkdtempSync(join(cache, `${app.name}-`));
  const run = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: tmp, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim() || `exit ${r.status}`}`);
  };
  run("init", "-q");
  run("fetch", "-q", "--depth", "1", app.repo, app.rev);
  run("checkout", "-q", "FETCH_HEAD");
  try { renameSync(tmp, dir); } catch { rmSync(tmp, { recursive: true, force: true }); }
  return dir;
}

/** The instance `handle` as the plan reads it: its store, read only, while the router runs it. */
export async function viewOf(router: Router, handle: string): Promise<InstanceView & { close(): void }> {
  const row = router.o.db.get(handle);
  if (!row) throw new Error(`no instance ${handle}`);
  if (!storeExists(storeSpec(row))) throw new Error(`${handle}: no store at ${storeSpec(row)} yet (hydrate it first)`);
  const s = openStoreFile(storeSpec(row), { readOnly: true });
  try { return { ...(await instanceView(s)), close: () => s.close() }; } catch (e) { s.close(); throw e; }
}

/** A plan's requests, each signed by `wallet` (root) to the instance and handed in (Router.messageLocal), in order; throws at the first refusal. */
export async function sendPlan(router: Router, handle: string, p: AdminPlan, wallet: WalletInterface): Promise<number> {
  for (const r of p.requests) await router.messageLocal(handle, await signRequest(wallet, { recipient: p.recipient, payload: requestPayload("POST", r.path, r.body) }));
  await router.settled();
  return p.requests.length;
}

/** Install the app in `dir` into `handle` as root (`wallet`): planned from its store, `config` merged over the manifest's, then sent. The prompt. */
export async function installApp(router: Router, handle: string, dir: string, wallet: WalletInterface, o: { config?: Record<string, unknown> } = {}): Promise<string[]> {
  await router.hydrate(handle);
  await router.settled();
  const view = await viewOf(router, handle);
  let p;
  try { p = await planInstallApp(await readApp(dir), view, { config: o.config, modules: wasmDirObjects(WASM_DIR) }); } finally { view.close(); }
  await sendPlan(router, handle, p, wallet);
  return p.prompt;
}

/** Uninstall `app` from `handle` as root. The prompt. */
export async function uninstallApp(router: Router, handle: string, app: string, wallet: WalletInterface): Promise<string[]> {
  await router.settled();
  const view = await viewOf(router, handle);
  let p;
  try { p = await planUninstallApp(app, view); } finally { view.close(); }
  await sendPlan(router, handle, p, wallet);
  return p.prompt;
}

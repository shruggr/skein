// The shell app and the chat app for tests and equivs (#83), the
// onboarding app (#90), the git app (#91) and the management site (#125). A genesis has no shell, no
// `run`, no `chat`: a test that runs them installs the apps first, through
// the real install path (the owner's messages `skein plan install` builds,
// src/client/admin.ts, POSTed to the instance's /sendMessage on the owner's
// BRC-104 session as any wallet sends them, #124), from a
// checkout at the commit pinned here — $SKEIN_SHELL_DIR / $SKEIN_CHAT_DIR /
// $SKEIN_ONBOARD_DIR / $SKEIN_GIT_DIR name a checkout instead,
// $SKEIN_SHELL_REV / $SKEIN_CHAT_REV / $SKEIN_ONBOARD_REV / $SKEIN_GIT_REV
// another commit. A pinned commit is fetched once into
// <tmpdir>/skein-apps/<name>-<rev> and reused. Not part of anything that runs.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WalletInterface } from "@bsv/sdk";
import type { CID } from "multiformats/cid";
import { join as joinPath } from "node:path";
import { deliver, planFiles, planInstallApp, planUninstallApp, messageJson, type AdminPlan } from "./client/admin.ts";
import { RawBox } from "./client/raw.ts";
import { WASM_DIR, wasmDirObjects } from "./host/boot.ts";
import { HostDb } from "./host/instances.ts";
import { fetchApp, instanceView, readApp, shellProgram, type InstanceView } from "./host/install.ts";
import { openStoreFile } from "./runtime/index-store.ts";
import type { Store } from "./runtime/store.ts";

export interface PinnedApp { name: string; repo: string; rev: string; dir?: string }

/** shruggr/skein-shell: `run` and the shell (brush, coreutils, the toolset). */
export const SHELL_APP: PinnedApp = {
  name: "shell", repo: "https://github.com/shruggr/skein-shell",
  rev: process.env.SKEIN_SHELL_REV ?? "98e201a6283944fc396be19dcbf03a1e1aa493f1", dir: process.env.SKEIN_SHELL_DIR,
};
/** shruggr/skein-chat: the chat loop (`chat`). */
export const CHAT_APP: PinnedApp = {
  name: "chat", repo: "https://github.com/shruggr/skein-chat",
  rev: process.env.SKEIN_CHAT_REV ?? "a9491ee30668aeee5a44745403dadf7355825a51", dir: process.env.SKEIN_CHAT_DIR,
};

/** shruggr/skein-onboard (#90, #113): the onboarding app, installed in the host skein: onboard.create, registration, BRC-169; #127: onboard.create takes the caller's signed claim (0.3.0). */
export const ONBOARD_APP: PinnedApp = {
  name: "onboard", repo: "https://github.com/shruggr/skein-onboard",
  rev: process.env.SKEIN_ONBOARD_REV ?? "7202d9541a66dde5fcdf04a5242c0af29bf7a810", dir: process.env.SKEIN_ONBOARD_DIR,
};

/** shruggr/skein-git (#91): the git app — `git.clone {url, hash}` into the store, the app record answered. */
export const GIT_APP: PinnedApp = {
  name: "git", repo: "https://github.com/shruggr/skein-git",
  rev: process.env.SKEIN_GIT_REV ?? "b571f42fe80fc348206bea65ac810f02a162c511", dir: process.env.SKEIN_GIT_DIR,
};

/** shruggr/skein-site (#125): the management site as an app — its page at /site/, served from its own tree's www (0.6.1). */
export const SITE_APP: PinnedApp = {
  name: "site", repo: "https://github.com/shruggr/skein-site",
  rev: process.env.SKEIN_SITE_REV ?? "47581ca0fafe88223864b576ac149007c51b77cd", dir: process.env.SKEIN_SITE_DIR,
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

/** What installing needs of a host: its SKEIN_HOME (host.db), the router's port, the owner's wallet, a wait for the router to settle. */
export interface InstallHost { home: string; port: number; owner: WalletInterface; settled(): Promise<void> }

/** The instance `handle` as the plan reads it: its store file (host.db's row), read only, while the router runs it. */
export async function viewOf(h: Pick<InstallHost, "home">, handle: string): Promise<InstanceView & { close(): void }> {
  const db = new HostDb(joinPath(h.home, "host.db"));
  const row = db.get(handle);
  db.close();
  if (!row) throw new Error(`no instance ${handle}`);
  if (!existsSync(row.store)) throw new Error(`${handle}: no store at ${row.store} yet (hydrate it first)`);
  const s = openStoreFile(row.store, { readOnly: true });
  try { return { ...(await instanceView(s)), close: () => s.close() }; } catch (e) { s.close(); throw e; }
}

/**
 * Deliver a plan as any wallet does (#124): each message's `/sendMessage` JSON body (src/client/admin.ts
 * messageJson, what `skein plan` writes), POSTed in order on the wallet's BRC-104 session with the
 * instance's front door; throws at the first answer that is not 200.
 */
export async function sendPlan(h: Pick<InstallHost, "port" | "owner" | "settled">, handle: string, p: AdminPlan, wallet: WalletInterface = h.owner): Promise<number> {
  const box = new RawBox(wallet, `http://127.0.0.1:${h.port}/@${handle}`);
  for (const m of p.messages) {
    const r = await box.postJson("/sendMessage", messageJson(p.recipient, m));
    if (r.status !== 200) throw new Error(`sendMessage ${m.box}: ${r.status} ${r.text.slice(0, 300)}`);
  }
  await h.settled();
  return p.messages.length;
}

/** Deliver a plan directory (`skein plan … --out dir`) as `skein send` does, with `wallet`'s session instead of `1sat authfetch`; throws at the first answer that is not 200. */
export async function sendDir(h: Pick<InstallHost, "port" | "owner" | "settled">, handle: string, dir: string, wallet: WalletInterface = h.owner): Promise<number> {
  const box = new RawBox(wallet, `http://127.0.0.1:${h.port}/@${handle}`);
  const done = await deliver(planFiles(dir), (json) => box.postJson("/sendMessage", json));
  const last = done.at(-1);
  if (last && last.status !== 200) throw new Error(`${last.file}: ${last.status} ${last.text.slice(0, 300)}`);
  await h.settled();
  return done.length;
}

/**
 * Install the app in `dir` into `handle` as its owner: planned from the instance's store (`skein plan
 * install --store`), `config` merged over the manifest's, then sent (sendPlan). The prompt.
 */
export async function installApp(h: InstallHost, handle: string, dir: string, o: { config?: Record<string, unknown>; wallet?: WalletInterface } = {}): Promise<string[]> {
  await h.settled();
  const view = await viewOf(h, handle);
  let p;
  try { p = await planInstallApp(await readApp(dir), view, { config: o.config, modules: wasmDirObjects(WASM_DIR) }); } finally { view.close(); }
  await sendPlan(h, handle, p, o.wallet);
  return p.prompt;
}

/** Uninstall `app` from `handle` as its owner (`skein plan uninstall`, then sent). The prompt. */
export async function uninstallApp(h: InstallHost, handle: string, app: string, o: { wallet?: WalletInterface } = {}): Promise<string[]> {
  await h.settled();
  const view = await viewOf(h, handle);
  let p;
  try { p = await planUninstallApp(app, view); } finally { view.close(); }
  await sendPlan(h, handle, p, o.wallet);
  return p.prompt;
}

/**
 * What the equivs ran as `skein-host install|uninstall` before #124, now the owner's path: `install <dir>
 * --instance <h> [--config json] [--dry-run]` or `uninstall <app> --instance <h>` — planned from the
 * instance's store (`skein plan … --store`) and, unless a dry run, sent by `wallet` (default the owner) to
 * its /sendMessage (sendPlan). `out`: the prompt, then `<h>: <app> <version> installed|upgraded: <n>
 * messages sent` (or `<h>: <app> uninstalled: …`); `err` and code 1 when planning or a send fails.
 */
export async function ownerCli(h: InstallHost, args: string[], wallet: WalletInterface = h.owner): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [], err: string[] = [];
  const [cmd, what] = args;
  const opt = (name: string) => { const i = args.indexOf(name); return i > 0 ? args[i + 1] : undefined; };
  const handle = opt("--instance");
  if ((cmd !== "install" && cmd !== "uninstall") || !what || !handle) return { code: 2, out, err: [`ownerCli: ${args.join(" ")}`] };
  try {
    await h.settled();
    const view = await viewOf(h, handle);
    let p: AdminPlan & { app?: string; version?: string; upgrade?: boolean };
    try {
      if (cmd === "install") {
        const c = opt("--config");
        const r = await planInstallApp(await readApp(fetchApp(what)), view, { config: c ? JSON.parse(c) as Record<string, unknown> : undefined, modules: wasmDirObjects(WASM_DIR) });
        p = { ...r, upgrade: r.prompt[0]!.startsWith("upgrade") };
      } else p = { ...(await planUninstallApp(what, view)), app: what };
    } finally { view.close(); }
    out.push(...p.prompt);
    if (args.includes("--dry-run")) return { code: 0, out, err };
    const n = await sendPlan(h, handle, p, wallet);
    out.push(cmd === "install" ? `${handle}: ${p.app} ${p.version} ${p.upgrade ? "upgraded" : "installed"}: ${n} messages sent` : `${handle}: ${what} uninstalled: ${n} messages sent`);
    return { code: 0, out, err };
  } catch (e) {
    err.push(`${cmd}: ${(e as Error).message}`);
    return { code: 1, out, err };
  }
}

/** Install apps into an instance as its owner (installApp each; the instance's store must exist: hydrate it first). */
export async function installApps(h: InstallHost, handle: string, apps: PinnedApp[] = [SHELL_APP, CHAT_APP], o: { config?: Record<string, unknown> } = {}): Promise<void> {
  for (const app of apps) {
    try { await installApp(h, handle, appCheckout(app), o); } catch (e) { throw new Error(`install ${app.name} into ${handle}: ${(e as Error).message}`); }
  }
}

/**
 * The shell app's shell program put straight into a store with no instance
 * (the shell cases and git in the VM run `skein-kernel shell <store>
 * <program>`, no log): the record and the blocks the install would send for
 * it, built by the install's own code (readApp, shellProgram). Its CID.
 */
export async function putShellProgram(store: Pick<Store, "put" | "putBlock" | "has">, app: PinnedApp = SHELL_APP): Promise<CID> {
  const dir = appCheckout(app);
  const t = await readApp(dir);
  const src = t.checked.sources.shell;
  if (src?.kind !== "shell") throw new Error(`${dir}: etc/app.json has no shell program`);
  const { record, blocks } = shellProgram(t.read, "shell", src, t.checked.manifest.name);
  for (const b of blocks) if (!(await store.has(b.cid))) await store.putBlock(b.cid, b.bytes);
  return await store.put(record as never);
}

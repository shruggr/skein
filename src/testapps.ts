// The shell app and the chat app for tests and equivs (#83), and the
// onboarding app (#90). A genesis has no shell, no `run`, no `chat`: a test
// that runs them installs the apps first, through the real install path
// (`skein-host install`, src/host/install.ts), from a checkout at the commit
// pinned here — $SKEIN_SHELL_DIR / $SKEIN_CHAT_DIR / $SKEIN_ONBOARD_DIR name
// a checkout instead, $SKEIN_SHELL_REV / $SKEIN_CHAT_REV /
// $SKEIN_ONBOARD_REV another commit. A pinned commit is fetched once into
// <tmpdir>/skein-apps/<name>-<rev> and reused. Not part of anything that runs.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WalletInterface } from "@bsv/sdk";
import type { CID } from "multiformats/cid";
import { RawBox } from "./client/raw.ts";
import { main } from "./host/cli.ts";
import { readApp, shellProgram } from "./host/install.ts";
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

/** shruggr/skein-onboard (#90): the onboarding app, installed in the host skein. */
export const ONBOARD_APP: PinnedApp = {
  name: "onboard", repo: "https://github.com/shruggr/skein-onboard",
  rev: process.env.SKEIN_ONBOARD_REV ?? "e142f8ea203a5846ac2de9d4c319669c59463af9", dir: process.env.SKEIN_ONBOARD_DIR,
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

/**
 * Install apps into an instance as its owner, by `skein-host install
 * <checkout> --instance <handle> --approve-all` (the instance's store must
 * exist: hydrate it first). Throws with the install's output when one fails.
 */
export async function installApps(h: InstallHost, handle: string, apps: PinnedApp[] = [SHELL_APP, CHAT_APP]): Promise<void> {
  for (const app of apps) {
    const out: string[] = [];
    const code = await main(["install", appCheckout(app), "--instance", handle, "--approve-all"], {
      vars: { SKEIN_HOME: h.home, HOME: h.home }, out: (l) => out.push(l), err: (l) => out.push(l),
      owner: { wallet: h.owner, box: (row) => new RawBox(h.owner, `http://127.0.0.1:${h.port}/@${row.handle}`) },
    });
    if (code !== 0) throw new Error(`skein-host install ${app.name} --instance ${handle}: exit ${code}\n${out.join("\n")}`);
    await h.settled();
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
  const { record, blocks } = shellProgram(dir, "shell", src, t.checked.manifest.name);
  for (const b of blocks) if (!(await store.has(b.cid))) await store.putBlock(b.cid, b.bytes);
  return await store.put(record as never);
}

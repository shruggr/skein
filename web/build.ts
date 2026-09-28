// Bundle the page (web/app.ts → web/dist/app.js) and write web/dist/config.json
// from ~/.skein (the same files and env overrides as the CLI's loadConfig).
//   node --experimental-strip-types web/build.ts        (npm run web:build)
//
// The shared modules the page imports (src/envelope.ts, src/runtime/identity.ts,
// src/client/conversation.ts) use node:crypto, node:fs/path and Buffer; the
// bundle maps those to web/shims (behaviour unchanged: the same hashes and
// bytes, see web/shims.test.ts), and never touches the node code paths.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildOptions } from "esbuild";

export const WEB = dirname(fileURLToPath(import.meta.url));
/** David's Yours identity: the page warns if the connected wallet is anyone else. */
export const YOURS_IDENTITY = "033212a70e51584870bae3a5b64648e826c56c1c741c850b626f160842c88cd59e";

export function browserOptions(entry: string, outfile: string): BuildOptions {
  return {
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: "esm",
    target: "es2022",
    platform: "browser",
    sourcemap: true,
    logLevel: "warning",
    alias: {
      "node:crypto": join(WEB, "shims/crypto.ts"),
      "node:fs": join(WEB, "shims/node-stub.ts"),
      "node:path": join(WEB, "shims/node-stub.ts"),
    },
    inject: [join(WEB, "shims/buffer.ts")],
    define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
  };
}

export async function buildPage(): Promise<void> {
  const { build } = await import("esbuild");
  await build(browserOptions(join(WEB, "app.ts"), join(WEB, "dist/app.js")));
  const { loadConfig } = await import("../src/client/config.ts");
  const c = loadConfig();
  const config = {
    instance: c.instance,
    instanceUrl: c.instanceUrl,
    mailboxUrl: c.mailboxUrl,
    hostUrl: process.env.SKEIN_HOST_URL ?? new URL(c.instanceUrl).origin,
    expectedOwner: process.env.SKEIN_YOURS_IDENTITY ?? YOURS_IDENTITY,
  };
  mkdirSync(join(WEB, "dist"), { recursive: true });
  writeFileSync(join(WEB, "dist/config.json"), JSON.stringify(config, null, 2) + "\n");
  console.log(`web/dist/app.js, web/dist/config.json (instance ${config.instance.handle}@${config.instance.domain}, ${config.instanceUrl}, mailbox ${config.mailboxUrl})`);
}

if (import.meta.main) await buildPage();

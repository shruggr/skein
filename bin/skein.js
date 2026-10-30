#!/usr/bin/env node
// skein — the client — for the npm package (and any checkout): dist/client/cli.js, else src/client/cli.ts.
import { existsSync } from "node:fs";

const root = new URL("..", import.meta.url);
const built = new URL("dist/client/cli.js", root);
const { main } = await import(existsSync(built) ? built.href : new URL("src/client/cli.ts", root).href);
main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { process.stderr.write(`skein: ${e?.message ?? e}\n`); process.exit(1); });

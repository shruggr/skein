// LEGACY since the router (#33): only for the `1sat serve` messagebox (messagebox.sh).
// `1sat serve` (0.0.121) mounts @bopen-io/messagebox-server's routes but never
// runs its knex migrations, so the first sendMessage fails with SQLITE_ERROR
// (no `messages` table). Apply them to the host's messagebox sqlite file using
// the knex and migrations shipped inside the installed 1sat CLI. Idempotent.
//   node scripts/host/messagebox-migrate.mjs <messagebox-main.db>
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";

const db = process.argv[2];
if (!db) { console.error("usage: messagebox-migrate.mjs <sqlite file>"); process.exit(2); }
const bin = realpathSync(execFileSync("which", ["1sat"], { encoding: "utf8" }).trim());
const cliRoot = join(dirname(bin), "..");                    // …/@1sat/cli
const require = createRequire(join(cliRoot, "package.json"));
const knexLib = require("knex");
const mbRoot = join(cliRoot, "node_modules/@bopen-io/messagebox-server");
const knex = knexLib({ client: "sqlite3", connection: { filename: db }, useNullAsDefault: true });
try {
  const [batch, log] = await knex.migrate.latest({ directory: join(mbRoot, "out/src/migrations"), loadExtensions: [".js"] });
  console.log(log.length ? `messagebox migrations applied (batch ${batch}): ${log.join(", ")}` : "messagebox migrations: up to date");
} finally {
  await knex.destroy();
}

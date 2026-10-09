import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const here = fileURLToPath(new URL(".", import.meta.url));

// runar-sdk is bundled straight from the local Rúnar checkout's TypeScript
// sources (README.md, "runar-sdk from the local checkout"): no build step, no
// copy. RUNAR_DIR overrides where that checkout is; the default is a sibling
// of this checkout's parent (~/Work/bsv/runar next to ~/Work/agent-env/skein-amm).
// tsconfig.json's `paths` mirror these aliases for the type checker.
const runarDir = resolve(here, process.env.RUNAR_DIR ?? "../../../../bsv/runar");

// The Mandala (BRC-162) script template, `Mandala`, comes the same way from the
// local 1sat-sdk checkout's sources (branch feat/onecolor-template, draft PR
// b-open-io/1sat-sdk#82; README.md, "Mandala from the local 1sat-sdk
// checkout") until @1sat/templates publishes it. ONESAT_SDK_DIR overrides
// where that checkout is; the default is ~/Work/bsv/1sat-sdk.
const oneSatSdkDir = resolve(here, process.env.ONESAT_SDK_DIR ?? "../../../../bsv/1sat-sdk");

// Build output (`npm run build` -> ../../www/) is the app's `www/`, committed:
// the tree a skein serves under /<app>/ (nothing is built on the skein). The
// Mandala pages are copied into www/mandala/ afterwards
// (../../scripts/mandala-pages.sh), so a build empties www/ and the whole
// sequence is ../../scripts/www.sh. Relative base so the pages work under
// /<app>/ on any instance, and under a host's "/@<handle>/<app>/" dev form.
export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^runar-sdk$/, replacement: resolve(runarDir, "packages/runar-sdk/src/index.ts") },
      // runar-ir-schema's barrel without its node-only Ajv validators (see the file).
      { find: /^runar-ir-schema$/, replacement: resolve(here, "src/pool/runar-ir-schema.ts") },
      { find: /^@runar-src\//, replacement: resolve(runarDir, "packages") + "/" },
      // @1sat/actions lazily imports xdelta3-wasm (OrdFS patches, unused
      // here), whose package.json names a "module" file that is not in the
      // package (dist/xdelta3.esm.js; the file is dist/xdelta3-wasm.esm.js).
      // Point at the file that exists so the bundler can resolve it.
      { find: /^xdelta3-wasm$/, replacement: resolve(here, "node_modules/xdelta3-wasm/dist/xdelta3-wasm.esm.js") },
      {
        find: /^@1sat\/templates\/mandala$/,
        replacement: resolve(oneSatSdkDir, "packages/templates/src/mandala/mandala.ts"),
      },
    ],
    // runar-sdk's and Mandala's sources import @bsv/sdk (and Mandala cbor2)
    // from outside this package: resolve them from here, one copy each.
    dedupe: ["@bsv/sdk", "cbor2"],
  },
  build: {
    outDir: resolve(here, "../../www"),
    emptyOutDir: true,
    assetsDir: "assets",
  },
  test: {
    environment: "node",
    globals: true,
  },
});

/**
 * `runar-ir-schema`, minus its Ajv validators: what this bundle resolves the
 * bare `runar-ir-schema` import (made by runar-sdk's sources) to. See
 * vite.config.ts and README.md "runar-sdk from the local checkout".
 *
 * runar-ir-schema's own `index.ts` re-exports `validators.ts`, which reads its
 * JSON schemas from disk at import time (`node:fs`, `fileURLToPath(import.meta.url)`)
 * and imports `ajv`. Neither works in a browser bundle, and runar-sdk never
 * calls the validators. Every other value export of that barrel (and the
 * artifact, ANF and stack IR types runar-sdk uses) is re-exported
 * here from the checkout's own sources; nothing is copied.
 */
export * from "@runar-src/runar-ir-schema/src/state-layout.js";
export * from "@runar-src/runar-ir-schema/src/abi-type-encoding.js";
export * from "@runar-src/runar-ir-schema/src/canonical-json.js";
export * from "@runar-src/runar-ir-schema/src/input-limits.js";
export * from "@runar-src/runar-ir-schema/src/unknown-anf-kind-error.js";
export { MERGED_LOCAL_TEMP_PREFIX } from "@runar-src/runar-ir-schema/src/anf-ir.js";
export type * from "@runar-src/runar-ir-schema/src/artifact.js";
export type * from "@runar-src/runar-ir-schema/src/anf-ir.js";
export type * from "@runar-src/runar-ir-schema/src/stack-ir.js";

// The TS program registry: `code: {ts: name}` in a Program record names an
// entry here. Records live in records.ts (their CIDs must not depend on code).

import type { ProgramImpl } from "../program.ts";
import { bash } from "./bash.ts";
import { loop } from "./loop.ts";

export const REGISTRY: Record<string, ProgramImpl> = { bash, loop };

export { BASH, BASH_CID, LOOP, LOOP_CID, PROGRAM_RECORDS } from "./records.ts";
export { toolDef } from "./sdk.ts";

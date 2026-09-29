// The host's clock: the one place the node host reads wall time for a log
// entry's stamp (a genesis, an admission). Nothing inside the kernel reads a
// clock; everything there derives time from these stamps.

import { msStamp, type Stamp } from "../runtime/syscalls.ts";

/** Wall time now, ms resolution, as a stamp. */
export function now(): Stamp {
  return msStamp(Date.now());
}

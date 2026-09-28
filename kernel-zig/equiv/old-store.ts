// A store in an older format, for run.sh's refusal check: the frozen
// TypeScript runtime's tables with a host-signed genesis (issue #33: before
// format 2, before fuel).
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/old-store.ts <out.db>

import { PrivateKey } from "@bsv/sdk";
import { ensureGenesis } from "../../src/host/entry.ts";
import { openStore } from "../../src/runtime/sqlite.ts";
import { T0 } from "../../src/testkit.ts";
import { ephemeralWallet } from "../../src/wallet.ts";

const s = openStore(process.argv[2]!);
await ensureGenesis(s, ephemeralWallet(PrivateKey.fromRandom()), ephemeralWallet(PrivateKey.fromRandom()), { owner: PrivateKey.fromRandom().toPublicKey().toString() }, T0);
await s.close();

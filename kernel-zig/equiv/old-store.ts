// A store in an older format, for run.sh's refusal check: sqlite.ts's tables
// with a format-1 log (issue #33: before format 2, before fuel) — one
// genesis naming a `host`, its entry signed by that host.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/old-store.ts <out.db>

import { PrivateKey } from "@bsv/sdk";
import { rootIdentity, signAnyone } from "../../src/runtime/identity.ts";
import { DEFAULTS, entryBytes, LOG_KEY_ID, LOG_PROTOCOL, nextEntry } from "../../src/runtime/log.ts";
import { SHELL_CID, SHELL_PROGRAM } from "../../src/runtime/programs.ts";
import { openStore } from "../../src/runtime/sqlite.ts";
import { T0 } from "../../src/testkit.ts";
import { ephemeralWallet } from "../../src/wallet.ts";

const s = openStore(process.argv[2]!);
const host = ephemeralWallet(PrivateKey.fromRandom());
await s.put(SHELL_PROGRAM);
const genesis = await s.put({
  kind: "genesis", identity: await rootIdentity(ephemeralWallet(PrivateKey.fromRandom())), handle: "skein", domain: "localhost",
  owner: PrivateKey.fromRandom().toPublicKey().toString(), host: await rootIdentity(host),
  programs: { shell: SHELL_CID }, subscriptions: [], defaults: DEFAULTS, collect: ["completions"],
});
const unsigned = await nextEntry(s, { genesis }, T0);
await s.log.append({ ...unsigned, sig: await signAnyone(host, LOG_PROTOCOL, LOG_KEY_ID, entryBytes(unsigned)) });
await s.close();

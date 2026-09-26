#!/usr/bin/env bash
# Everything the client and the instance need on David's machine, idempotent:
# the wallets, the messagebox host, the wallet grants, and host accounts for
# the owner (david), the instance (skein) and the inference peer (infer) — the
# host wallet (3324) only signs log entries and needs none; and a
# default provider map for the peer (~/.skein/infer.json) if there is none. See README.md.
set -euo pipefail
here="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
skein="${SKEIN_HOME:-$HOME/.skein}"
"$here/wallets.sh"
"$here/messagebox.sh" --bg
"$here/grants.sh" > /dev/null
reg() { node --experimental-strip-types --no-warnings "$here/register.ts" "$@"; }
# `owner.identity` may name a key up.sh does not hold (e.g. the Yours wallet, set
# by hand or by a genesis made with SKEIN_OWNER=<that key>): it can only register
# the dev owner wallet (owner-wallet.env, 3322), so say so instead of pretending.
owner="$(cat "$skein/owner.identity")"
if [ "$owner" = "$(cat "$skein/owner-dev.identity")" ]; then
  reg http://127.0.0.1:3322 skein-client david
else
  echo "owner ${owner:0:8}…${owner: -5} is not the dev wallet; register it from the page (Register) before its replies can be delivered"
fi
reg http://127.0.0.1:3321 skein skein
reg http://127.0.0.1:3323 skein-infer infer
[ -f "$skein/infer.json" ] || printf '%s\n' '{ "ripper": { "baseUrl": "http://100.100.177.87:8001/v1", "apiKey": "vllm" } }' > "$skein/infer.json"

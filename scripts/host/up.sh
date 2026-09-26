#!/usr/bin/env bash
# Everything the client and the instance need on David's machine, idempotent:
# the wallets, the messagebox host, the wallet grants, and host accounts for
# the owner (david), the instance (skein) and the inference peer (infer) — the
# host wallet (3324) only signs log entries and needs none; and a
# default provider map for the peer (~/.skein/infer.json) if there is none. See README.md.
set -euo pipefail
here="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
"$here/wallets.sh"
"$here/messagebox.sh" --bg
"$here/grants.sh" > /dev/null
reg() { node --experimental-strip-types --no-warnings "$here/register.ts" "$@"; }
reg http://127.0.0.1:3322 skein-client david
reg http://127.0.0.1:3321 skein skein
reg http://127.0.0.1:3323 skein-infer infer
skein="${SKEIN_HOME:-$HOME/.skein}"
[ -f "$skein/infer.json" ] || printf '%s\n' '{ "ripper": { "baseUrl": "http://100.100.177.87:8001/v1", "apiKey": "vllm" } }' > "$skein/infer.json"

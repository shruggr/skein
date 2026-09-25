#!/usr/bin/env bash
# Everything the client and the instance need on David's machine, idempotent:
# both wallets, the messagebox host, the wallet grants, and host accounts for
# the owner (david) and the instance (skein). See README.md.
set -euo pipefail
here="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
"$here/wallets.sh"
"$here/messagebox.sh" --bg
"$here/grants.sh" > /dev/null
reg() { node --experimental-strip-types --no-warnings "$here/register.ts" "$@"; }
reg http://127.0.0.1:3322 skein-client david
reg http://127.0.0.1:3321 skein skein

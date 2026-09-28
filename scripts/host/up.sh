#!/usr/bin/env bash
# The dev stack on David's machine, in the router layout (#33), idempotent:
#
#   router    skein-host run  (background)    127.0.0.1:8100  the reverse proxy to every instance's front door
#                                                              (http://<handle>.localhost:8100 or /@<handle>, #40), the
#                                                              instances' oracle and kernels (started on demand), the waker;
#                                              127.0.0.1:4600  host page and /roster.json; 4610+ one explorer per instance
#   owner     1sat serve wallet-api            127.0.0.1:3322  the dev owner's wallet (a client)
#   infer     1sat serve wallet-api            127.0.0.1:3323  the inference peer's wallet (a client)
#
# No `1sat serve` messagebox, no wallet-api per instance, no host wallet: each
# instance is an HTTP server (its front door); instances sign through the
# router's oracle (master secret ~/.skein/master.key). It starts the client
# wallets, writes the grants for them, starts the router if nothing listens on
# :8100, and registers the owner (david) and the inference peer (infer) —
# each a mailbox instance of its own, by a signed registration
# (register.ts). The owner's mailbox URL goes to ~/.skein/mailbox.url (the
# client's). The inference peer itself is bin/skein-infer
# (SKEIN_MAILBOX_URL=http://127.0.0.1:8100/@infer). Instances are rows: `skein-host add <handle>` (identity derived),
# then `skein-host deploy <handle> <dir>`. See README.md.
set -euo pipefail
here="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
root="$(cd "$here/../.." && pwd)"
skein="${SKEIN_HOME:-$HOME/.skein}"
export SKEIN_HOME="$skein"
port="${SKEIN_ROUTER_PORT:-8100}"
mkdir -p "$skein/logs"
"$here/wallets.sh" owner infer
"$here/grants.sh"
echo "http://127.0.0.1:$port/@david" > "$skein/mailbox.url"

listening() { ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN; }
if listening "$port"; then
  echo "router: something already listens on :$port (the router, or the legacy \`1sat serve\` messagebox: stop that one first)"
else
  [ -x "$root/kernel-zig/zig-out/bin/skein-kernel" ] || (cd "$root/kernel-zig" && mise exec -- zig build --release)
  nohup "$root/bin/skein-host" run >> "$skein/logs/host.log" 2>&1 &
  for _ in $(seq 60); do listening "$port" && break; sleep 0.5; done
  listening "$port" || { echo "the router did not start; see $skein/logs/host.log" >&2; exit 1; }
  echo "router: http://127.0.0.1:$port (log $skein/logs/host.log)"
fi

# A name already registered (exit 3) is fine: the mailbox instance is there.
reg() { node --experimental-strip-types --no-warnings "$here/register.ts" "$@" "http://127.0.0.1:$port" || [ $? = 3 ]; }
# `owner.identity` may name a key up.sh does not hold (e.g. the Yours wallet):
# it can register only the dev owner wallet (3322); the front end registers
# the other one itself (Register).
owner="$(cat "$skein/owner.identity")"
if [ "$owner" = "$(cat "$skein/owner-dev.identity")" ]; then
  reg http://127.0.0.1:3322 skein-client david
else
  echo "owner ${owner:0:8}…${owner: -5} is not the dev wallet; register it from the page (Register) before its replies can be delivered"
fi
reg http://127.0.0.1:3323 skein-infer infer
[ -f "$skein/infer.json" ] || printf '%s\n' '{ "ripper": { "baseUrl": "http://100.100.177.87:8001/v1", "apiKey": "vllm" } }' > "$skein/infer.json"
# The registrations above may have created mailbox instances: grant toward them too (#40).
"$here/grants.sh" # again, after registration

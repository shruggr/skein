#!/usr/bin/env bash
# The dev stack on David's machine, in the router layout (#33, #40), idempotent:
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
# router's oracle (master secret ~/.skein/master.key). The order matters
# (README.md, "Bring-up order"):
#
#   1. the client wallets (their identity files: owner.identity, infer.identity)
#   2. the mailbox instances of the owner (david) and the inference peer (infer):
#      `skein-host add <h> --mailbox --owner <key>`, kept if the key has one already.
#      Before anything is genesised: an agent's genesis is written at its first
#      hydration and names the owner's messagebox (`defaults.ownerMessagebox`,
#      the router's default: the owner's mailbox instance) — an agent genesised
#      earlier can never deliver its answers to him (it needs a new store).
#   3. the router, if nothing listens on :8100 (it hydrates every enabled row:
#      the agents' geneses happen here, the owner's mailbox already there)
#   4. the grants, toward every row's front-door key (`skein-host list`), now
#      that every row exists
#
# Nothing is registered: the mailbox rows of step 2 are what a registration
# (register.ts, POST /account/register) would make; that is for identities
# whose keys this machine does not know (the front end's Register). The
# owner's mailbox URL goes to ~/.skein/mailbox.url (the client's). The
# inference peer itself is bin/skein-infer
# (SKEIN_MAILBOX_URL=http://127.0.0.1:8100/@infer). Agents are rows:
# `skein-host add <handle>` (identity derived), then `skein-host deploy
# <handle> <dir>`. See README.md.
set -euo pipefail
here="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
root="$(cd "$here/../.." && pwd)"
skein="${SKEIN_HOME:-$HOME/.skein}"
export SKEIN_HOME="$skein"
port="${SKEIN_ROUTER_PORT:-8100}"
mkdir -p "$skein/logs"
host() { "$root/bin/skein-host" "$@"; }

# 1. The client wallets.
"$here/wallets.sh" owner infer
owner="$(cat "$skein/owner.identity")"
infer="$(cat "$skein/infer.identity")"

# 2. The mailbox instances, before any agent is genesised. `mailbox <handle>
# <key>` prints the handle of key's mailbox instance: the one it has, else a
# new one named <handle>.
mailbox() {
  local have
  have="$(host mailboxes | awk -F'\t' -v k="$2" '$2 == k && $4 == "enabled" { sub(/@.*/, "", $1); print $1; exit }')"
  if [ -n "$have" ]; then echo "$have"; return; fi
  host add "$1" --mailbox --owner "$2" >&2
  echo "$1"
}
mine="$(mailbox david "$owner")"
theirs="$(mailbox infer "$infer")"
echo "mailbox instances: the owner ${owner:0:8}… at @$mine, infer ${infer:0:8}… at @$theirs"
echo "http://127.0.0.1:$port/@$mine" > "$skein/mailbox.url"
[ -f "$skein/infer.json" ] || printf '%s\n' '{ "ripper": { "baseUrl": "http://100.100.177.87:8001/v1", "apiKey": "vllm" } }' > "$skein/infer.json"

# 3. The router: a new agent's genesis names the owner's mailbox instance (its default).
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

# 4. The grants, toward every row (agents and mailbox instances), all of which exist now.
"$here/grants.sh"

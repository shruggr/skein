#!/usr/bin/env bash
# The dev stack on David's machine, in the router layout (#33, #40), idempotent:
#
#   router    skein-host run  (background)    127.0.0.1:8100  the reverse proxy to every instance's front door
#                                                              (http://<handle>.localhost:8100 or /@<handle>, #40), the
#                                                              instances' signer and kernels (started on demand), the waker;
#                                              127.0.0.1:4600  host page and /roster.json
#   owner     1sat serve wallet-api            127.0.0.1:3322  the dev owner's wallet (a client)
#   infer     1sat serve wallet-api            127.0.0.1:3323  the inference peer's wallet (a client)
#
# No `1sat serve` messagebox, no wallet-api per instance, no host wallet: each
# instance is an HTTP server (its front door); instances sign through the
# router's signer (master secret ~/.skein/master.key). The order matters
# (README.md, "Bring-up order"):
#
#   1. the client wallets (their identity files: owner.identity, infer.identity)
#   2. the mailbox instances of the owner (david) and the inference peer (infer):
#      `skein-host add <h> --mailbox --owner <key>`, kept if the key has one already.
#      Before anything is genesised: an agent's genesis is written at its first
#      hydration and names the owner's messagebox (`defaults.ownerMessagebox`,
#      the router's default: the owner's mailbox instance) — an agent genesised
#      earlier can never deliver its answers to him (it needs a new store).
#   2b. the host skein (#90, #142): `skein-host init` — the operator's own
#      instance (handle `host`), from the host image (the default image with
#      the onboarding app), owned at birth by the operator's key
#      (SKEIN_OPERATOR_KEY: here the dev owner's, ~/.skein/owner-dev.key,
#      written from owner-wallet.env), the onboarding app's config from the
#      settings (SKEIN_HANDLE_DOMAIN, default localhost; the router's
#      origin), the instance manager in its address book. Once: run again, it
#      only says which instance it is
#   3. the router, if nothing listens on :8100 (it hydrates every enabled row:
#      the agents' geneses happen here, the owner's mailbox already there).
#      Its broadcaster (#58) is the host's Arcade: SKEIN_ARC_URL and
#      SKEIN_ARC_TOKEN (and SKEIN_ARC_EVENTS_URL, SKEIN_ARC_CALLBACK_URL) in the
#      environment or ~/.skein/host.env; without them nothing broadcasts and a
#      new genesis names no broadcast provider (#70; README.md, "The broadcaster").
#      Every new genesis seeds its address book with the host's providers
#      (fetch, waker, libp2p when it runs one, broadcast with an Arcade: local,
#      keys derived from the master secret) and the owner's mailbox
#   4. the grants, toward every row's front-door key (`skein-host list`), now
#      that every row exists
#   5. the address books (#40, #70): how each agent reaches a key. Into every
#      enabled agent, through its `peers` box as the owner: the owner's key and
#      mailbox instance, the inference peer's key and its mailbox instance, and
#      every other agent's key and origin. The inference peer's own address
#      book (every agent's key and origin) is the file ~/.skein/infer-peers.json,
#      which bin/skein-infer reads.
#   6. the apps (#83): a genesis has no shell and no chat loop, so every enabled
#      agent gets the shell app and the chat app (as the owner, at the tags
#      SKEIN_SHELL_APP / SKEIN_CHAT_APP name: <url>#<tag>, checked out under
#      ~/.skein/apps/ — an agent has no git app). Installing what an instance has
#      sends only the head again.
#   Steps 5–6 are the owner's messages (#124, #142): `bin/skein … --instance
#   <h>` signs them with the dev owner's key and hands them to the running
#   host over its control socket. An instance owned by another key (an
#   owner.identity that is not owner-dev.identity) refuses them: that owner
#   sends from its own wallet.
#   7. the mailboxes of step 2, which the host skein's onboarding app did not
#      make, adopted (`skein-host import-handles` prints the owner's request
#      for each), recorded and certified so they resolve. POST
#      /@host/onboard/call creates a skein for any wallet with a session,
#      through the instance manager; POST /account/register (signed over
#      `register <name>@<domain>`) a mailbox; the app answers BRC-169.
#
# Nothing is registered, and nothing registers itself: the mailbox rows of
# step 2 are what a registration (register.ts, POST /account/register) would
# make — that is for identities whose keys this machine does not know (the
# front end's Register) — and an identity outside the host reaches an agent's
# answers only once the admin puts its key and mailbox URL in that agent's
# address book (`skein peers add <key> <url> --instance …`). The owner's
# mailbox URL goes to ~/.skein/mailbox.url (the client's). The inference peer
# itself is bin/skein-infer (SKEIN_MAILBOX_URL=http://127.0.0.1:8100/@infer).
# Agents are rows: `skein-host add <handle>` (identity derived), then the
# owner deploys its directory (`skein deploy <dir> --instance <handle>`); run
# this again after adding one (its address book, and everyone else's). See
# README.md.
set -euo pipefail
here="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
root="$(cd "$here/../.." && pwd)"
skein="${SKEIN_HOME:-$HOME/.skein}"
export SKEIN_HOME="$skein"
port="${SKEIN_ROUTER_PORT:-8100}"
mkdir -p "$skein/logs"
host() { "$root/bin/skein-host" "$@"; }
# An instance's origin, as the router publishes it (SKEIN_INSTANCE_ORIGIN).
origin() { local t="${SKEIN_INSTANCE_ORIGIN:-http://{handle\}.localhost:{port\}}"; t="${t//\{handle\}/$1}"; echo "${t//\{port\}/$port}"; }
# The owner's messages (#124, #142): `owner_send <handle> <skein args…>` — signed by bin/skein with the dev
# owner's key (SKEIN_OPERATOR_KEY), handed to the running host over its control socket.
owner_send() {
  local h=$1; shift
  "$root/bin/skein" "$@" --instance "$h" > /dev/null
}
# An agent from code genesis has no git app to clone with: `checkout <url#rev>` checks the app out here, once,
# under ~/.skein/apps/, and `skein install <dir>` sends what the agent lacks.
checkout() {
  local url="${1%%#*}" rev="${1#*#}" dir
  dir="$skein/apps/$(basename "$url")-$rev"
  [ -f "$dir/etc/app.json" ] || git clone -q --depth 1 --branch "$rev" "$url" "$dir"
  echo "$dir"
}

# 1. The client wallets.
"$here/wallets.sh" owner infer
owner="$(cat "$skein/owner.identity")"
infer="$(cat "$skein/infer.identity")"
# The operator's key (#142): the dev owner's, from its wallet's env file, so the dev owner owns the host skein.
if [ ! -f "$skein/owner-dev.key" ]; then
  ( umask 077; sed -n 's/^PRIVATE_KEY_WIF=//p' "$skein/owner-wallet.env" > "$skein/owner-dev.key" )
fi
export SKEIN_OPERATOR_KEY="${SKEIN_OPERATOR_KEY:-$skein/owner-dev.key}"

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

# 2b. The host skein (#90, #142): once; owned by the operator's key at birth, the onboarding app installed.
[ -x "$root/kernel-zig/zig-out/bin/skein-kernel" ] || (cd "$root/kernel-zig" && mise exec -- zig build --release)
host init
hostskein="$(host list | awk -F'\t' '$2 == "host" { sub(/@.*/, "", $1); print $1; exit }')"

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

# 5. The address books, as the owner's messages.
mapfile -t agents < <(host list | awk -F'\t' '$2 == "agent" && $3 == "enabled" { split($1, h, "@"); print h[1] "\t" $4 }')
for a in "${agents[@]}"; do
  h="${a%%$'\t'*}"
  owner_send "$h" peers add "$owner" "$(origin "$mine")" --handle "${SKEIN_OWNER_HANDLE:-david@localhost}" || echo "peers add the owner into $h failed (above)" >&2
  owner_send "$h" peers add "$infer" "$(origin "$theirs")" --handle "${SKEIN_INFER_HANDLE:-infer@localhost}" || echo "peers add infer into $h failed (above)" >&2
  # The other agents: their keys and origins.
  for b in "${agents[@]}"; do
    o="${b%%$'\t'*}"; k="${b#*$'\t'}"
    [ "$o" = "$h" ] || owner_send "$h" peers add "$k" "$(origin "$o")" --handle "$o@localhost" || echo "peers add $o into $h failed (above)" >&2
  done
done
# The inference peer's address book: every agent's key at its origin.
{
  echo "{"
  i=0
  for a in "${agents[@]}"; do
    h="${a%%$'\t'*}"; k="${a#*$'\t'}"
    [ $i -gt 0 ] && echo ","
    printf '  "%s": "%s"' "$k" "$(origin "$h")"
    i=$((i + 1))
  done
  echo ""
  echo "}"
} > "$skein/infer-peers.json.tmp" && mv "$skein/infer-peers.json.tmp" "$skein/infer-peers.json"

# 6. The apps (#83): the shell app (`run`) and the chat app (`chat`) into every enabled agent.
for a in "${agents[@]}"; do
  h="${a%%$'\t'*}"
  for app in "${SKEIN_SHELL_APP:-https://github.com/shruggr/skein-shell#v0.1.0}" "${SKEIN_CHAT_APP:-https://github.com/shruggr/skein-chat#v0.1.0}"; do
    owner_send "$h" install "$(checkout "$app")" || echo "install $app into $h failed (above)" >&2
  done
done
echo "address books: ${#agents[@]} agent(s) know the owner and infer; infer knows them ($skein/infer-peers.json)"

# 7. The mailboxes the host skein's onboarding app did not make: adopted by the owner's requests import-handles prints.
if [ -n "$hostskein" ]; then
  host import-handles 2> /dev/null | while read -r line; do
    body="${line#*--body \'}"; body="${body%\'}"
    ( set -a; . "$skein/owner-wallet.env"; set +a; HOME="$skein/owner-home" 1sat authfetch POST "$(origin "$hostskein")/onboard/call" --body "$body" ) > /dev/null || echo "adopting failed: $body" >&2
  done
  echo "the host skein: @$hostskein, the onboarding app at $(origin "$hostskein")/onboard/call; handles @${SKEIN_HANDLE_DOMAIN:-localhost}"
fi

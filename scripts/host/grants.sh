#!/usr/bin/env bash
# wallet-api grants for the clients (deny-by-default; `1sat permissions
# grant`), in the router layout (#33): the dev owner's wallet (3322, origin
# skein-client) and the inference peer's (3323, origin skein-infer) talk to
# the router's messagebox — BRC-104 with the instances' own identities since
# #33 part 2 (the front instance at the bare URL, each instance on its own
# origin) — and exchange envelopes with every instance in host.db. Instances have no wallet-api: the
# router's oracle signs for them. Idempotent (the owner's are reset first).
# Run again after `skein-host add` (a new instance is a new counterparty).
#   scripts/host/grants.sh
# (The grants of the pre-router layout — the instance wallet 3321 and the
# host wallet 3324 — are in grants-legacy.sh.)
set -euo pipefail
here="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
root="$(cd "$here/../.." && pwd)"
skein="${SKEIN_HOME:-$HOME/.skein}"
export SKEIN_HOME="$skein"
router=$("$root/bin/skein-host" identity)   # the BRC-104 identity at the bare URL: the front instance's
echo "$router" > "$skein/router.identity"
mapfile -t instances < <("$root/bin/skein-host" list | awk -F'\t' '$2 == "enabled" && $3 != "-" { print $3 }')
q() { "$@" 2>&1 | grep -e granted -e revoked -e Error || true; }

# Owner (David) wallet, origin skein-client — HOME=~/.skein/owner-home.
o() { HOME="$skein/owner-home" q 1sat permissions "$@"; }
o revoke skein-client --all
o grant skein-client --protocol "identity key retrieval" --level 1
o grant skein-client --protocol "metanet handles envelope" --level 2 --counterparty anyone   # envelope signature
o grant skein-client --protocol "messagebox" --level 1                                       # message-box-client messageId HMAC
o grant skein-client --protocol "server hmac" --level 2 --counterparty self                  # BRC-104 nonces
for i in "${instances[@]}"; do
  o grant skein-client --protocol "auth message signature" --level 2 --counterparty "$i"     # BRC-104 with each instance
  o grant skein-client --protocol "message encryption" --level 2 --counterparty "$i"         # BRC-78 content to/from each instance
done

# Inference peer wallet, origin skein-infer — HOME=~/.skein/infer-home.
f() { HOME="$skein/infer-home" q 1sat permissions "$@"; }
f grant skein-infer --protocol "identity key retrieval" --level 1
f grant skein-infer --protocol "server hmac" --level 2 --counterparty self
f grant skein-infer --protocol "messagebox" --level 1
f grant skein-infer --protocol "metanet handles envelope" --level 2 --counterparty anyone
for i in "${instances[@]}"; do
  f grant skein-infer --protocol "auth message signature" --level 2 --counterparty "$i"
  f grant skein-infer --protocol "message encryption" --level 2 --counterparty "$i"
done
echo "grants: owner and infer toward ${#instances[@]} instance(s) (front ${router:0:8}…)"

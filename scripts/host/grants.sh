#!/usr/bin/env bash
# wallet-api grants (deny-by-default; `1sat permissions grant`). Each was found
# from the denial it answers; see README.md. Idempotent (grants dedupe on write
# only loosely, so the owner's are reset first).
set -euo pipefail
skein="${SKEIN_HOME:-$HOME/.skein}"
host=$(cat "$skein/host.identity")         # messagebox host identity (BRC-104 counterparty)
inst=$(cat "$skein/instance.identity")
owner=$(cat "$skein/owner.identity")
q() { "$@" 2>&1 | grep -e granted -e revoked -e Error || true; }

# Owner (David) wallet, origin skein-client — HOME=~/.skein/owner-home.
o() { HOME="$skein/owner-home" q 1sat permissions "$@"; }
o revoke skein-client --all
o grant skein-client --protocol "identity key retrieval" --level 1
o grant skein-client --protocol "metanet handles envelope" --level 2 --counterparty anyone   # envelope signature
o grant skein-client --protocol "message encryption" --level 2 --counterparty "$inst"        # BRC-78 content to/from the instance
o grant skein-client --protocol "messagebox" --level 1                                       # message-box-client messageId HMAC
o grant skein-client --protocol "server hmac" --level 2 --counterparty self                  # BRC-104 nonces
o grant skein-client --protocol "auth message signature" --level 2 --counterparty "$host"    # BRC-104 with the host

# Instance wallet, origin skein (the runtime's) — default HOME. Transport grants
# for its own messagebox session, plus the envelope grants its handlers need.
i() { q 1sat permissions "$@"; }
i grant skein --protocol "identity key retrieval" --level 1
i grant skein --protocol "server hmac" --level 2 --counterparty self
i grant skein --protocol "auth message signature" --level 2 --counterparty "$host"
i grant skein --protocol "messagebox" --level 1
i grant skein --protocol "metanet handles envelope" --level 2 --counterparty anyone
i grant skein --protocol "message encryption" --level 2 --counterparty "$owner"

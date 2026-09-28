#!/usr/bin/env bash
# LEGACY (pre-router layout, before #33): the instance wallet (3321) and the host
# wallet (3324), with the `1sat serve` messagebox as the BRC-104 host. See grants.sh.
# wallet-api grants (deny-by-default; `1sat permissions grant`). Each was found
# from the denial it answers; see README.md. Idempotent (grants dedupe on write
# only loosely, so the owner's are reset first).
set -euo pipefail
skein="${SKEIN_HOME:-$HOME/.skein}"
host=$(cat "$skein/host.identity")         # messagebox host identity (BRC-104 counterparty)
inst=$(cat "$skein/instance.identity")
owner=$(cat "$skein/owner.identity")
infer=$(cat "$skein/infer.identity")
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
# for its own messagebox session, plus the envelope grants: decrypting what
# arrives, signing and encrypting what it sends.
i() { q 1sat permissions "$@"; }
i grant skein --protocol "identity key retrieval" --level 1
i grant skein --protocol "server hmac" --level 2 --counterparty self
i grant skein --protocol "auth message signature" --level 2 --counterparty "$host"
i grant skein --protocol "messagebox" --level 1
i grant skein --protocol "metanet handles envelope" --level 2 --counterparty anyone
i grant skein --protocol "message encryption" --level 2 --counterparty "$owner"
i grant skein --protocol "message encryption" --level 2 --counterparty "$infer"   # `infer` requests and `completions` replies

# Inference peer wallet, origin skein-infer — HOME=~/.skein/infer-home. Its own
# messagebox session, and envelopes to and from the instance.
f() { HOME="$skein/infer-home" q 1sat permissions "$@"; }
f grant skein-infer --protocol "identity key retrieval" --level 1
f grant skein-infer --protocol "server hmac" --level 2 --counterparty self
f grant skein-infer --protocol "auth message signature" --level 2 --counterparty "$host"
f grant skein-infer --protocol "messagebox" --level 1
f grant skein-infer --protocol "metanet handles envelope" --level 2 --counterparty anyone
f grant skein-infer --protocol "message encryption" --level 2 --counterparty "$inst"

# Host wallet, origin skein-host — HOME=~/.skein/host-wallet-home. It signs every
# log entry (src/runtime/log.ts): the host's word that a message arrived, or a
# deadline came, at the stamped time. No messagebox session of its own.
h() { HOME="$skein/host-wallet-home" q 1sat permissions "$@"; }
h grant skein-host --protocol "identity key retrieval" --level 1
h grant skein-host --protocol "skein log" --level 2 --counterparty anyone

#!/usr/bin/env bash
# LEGACY since the router (#33): an instance is `skein-host add <handle>` (its
# identity derived from the router's master secret; no wallet-api) and
# scripts/host/grants.sh. Kept for the pre-router layout.
# One instance for `skein-host run`, idempotent: what up.sh does for the single
# instance, for <handle>. Its own key and wallet-api (on the next free port from
# SKEIN_INSTANCE_PORT, default 3401, kept in its directory and reused), its
# wallet grants (grants.sh's instance section, plus envelope grants between it
# and every other provisioned instance, the owner's dev wallet and the infer
# peer, where those exist), its account on the messagebox (register.ts), and
# its row in $SKEIN_HOME/host.db (skein-host add). Needs the messagebox
# (messagebox.sh) up and $SKEIN_HOME/{host,owner}.identity.
#   scripts/host/instance.sh <handle>
# Files: $SKEIN_HOME/instances/<handle>/{wallet.env, wallet.port, identity, home/, runtime.db}
# Log:   $SKEIN_HOME/logs/wallet-<handle>.log
set -euo pipefail
here="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
root="$(cd "$here/../.." && pwd)"
skein="${SKEIN_HOME:-$HOME/.skein}"
export SKEIN_HOME="$skein"
handle="${1:?usage: instance.sh <handle>}"
dir="$skein/instances/$handle"
mkdir -p "$dir/home" "$skein/logs"
genkey() { node --experimental-strip-types --no-warnings "$here/genkey.ts" "$1"; }
answers() { curl -fsS -m 1 -o /dev/null 2>/dev/null -X POST "http://127.0.0.1:$1/getVersion" -H 'Content-Type: application/json' -H 'Origin: http://skein-up' -d '{}'; }
listening() { ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN; }
q() { "$@" 2>&1 | grep -e granted -e revoked -e Error || true; }

# The key and the wallet-api: the port it was given, or the next one nothing
# listens on and no other instance has taken.
genkey "$dir/wallet.env" > "$dir/identity"
inst=$(cat "$dir/identity")
if [ ! -f "$dir/wallet.port" ]; then
  port="${SKEIN_INSTANCE_PORT:-3401}"
  while listening "$port" || grep -qxs "$port" "$skein"/instances/*/wallet.port; do port=$((port + 1)); done
  echo "$port" > "$dir/wallet.port"
fi
port=$(cat "$dir/wallet.port")
if answers "$port"; then
  echo "$handle wallet: already on 127.0.0.1:$port"
else
  listening "$port" && { echo "$handle: port $port is taken by something else; remove $dir/wallet.port to pick another" >&2; exit 1; }
  ( set -a; . "$dir/wallet.env"; set +a
    export HOME="$dir/home" ONESAT_DAPP_PORT="$port"
    nohup 1sat serve wallet-api >> "$skein/logs/wallet-$handle.log" 2>&1 & )
  for _ in $(seq 20); do answers "$port" && break; sleep 0.5; done
  answers "$port" || { echo "$handle wallet did not start; see $skein/logs/wallet-$handle.log" >&2; exit 1; }
  echo "$handle wallet: started on 127.0.0.1:$port"
fi

# Grants: the instance section of grants.sh, as this instance, origin skein.
host=$(cat "$skein/host.identity")   # messagebox host identity (BRC-104 counterparty)
owner=$(cat "$skein/owner.identity")
i() { HOME="$dir/home" q 1sat permissions "$@"; }
i grant skein --protocol "identity key retrieval" --level 1
i grant skein --protocol "server hmac" --level 2 --counterparty self
i grant skein --protocol "auth message signature" --level 2 --counterparty "$host"
i grant skein --protocol "messagebox" --level 1
i grant skein --protocol "metanet handles envelope" --level 2 --counterparty anyone
i grant skein --protocol "message encryption" --level 2 --counterparty "$owner"
if [ -f "$skein/infer.identity" ]; then
  i grant skein --protocol "message encryption" --level 2 --counterparty "$(cat "$skein/infer.identity")"
  [ -d "$skein/infer-home" ] && HOME="$skein/infer-home" q 1sat permissions grant skein-infer --protocol "message encryption" --level 2 --counterparty "$inst"
fi
[ -d "$skein/owner-home" ] && HOME="$skein/owner-home" q 1sat permissions grant skein-client --protocol "message encryption" --level 2 --counterparty "$inst"
# Every other provisioned instance, both ways: the roster can message itself.
# (A chat from any other identity reaches the open subscription only once this
# wallet is granted "message encryption" toward that sender: wallet-api has no
# any-counterparty grant.)
for other in "$skein"/instances/*/; do
  o=$(basename "$other")
  [ "$o" = "$handle" ] || [ ! -f "$other/identity" ] && continue
  i grant skein --protocol "message encryption" --level 2 --counterparty "$(cat "$other/identity")"
  HOME="$other/home" q 1sat permissions grant skein --protocol "message encryption" --level 2 --counterparty "$inst"
done

# The row (#40: the instance is its own messagebox at its router origin, http://<handle>.localhost:8100; no account to register).
"$root/bin/skein-host" add "$handle" --identity "$inst" --wallet-url "http://127.0.0.1:$port" --store "$dir/runtime.db"

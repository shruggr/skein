#!/usr/bin/env bash
# The two BRC-100 wallets on David's machine, both `1sat serve wallet-api`
# (deny-by-default; grants via `1sat permissions grant`):
#   instance  127.0.0.1:3321  HOME unchanged (~/.1sat/cli)      key ~/.skein/dev-wallet.env
#   owner     127.0.0.1:3322  HOME=~/.skein/owner-home          key ~/.skein/owner-wallet.env
# The 1sat CLI has no config-dir flag or env var: CONFIG_DIR is $HOME/.1sat/cli,
# so the owner wallet gets its own HOME. Writes ~/.skein/{instance,owner}.identity.
#   scripts/host/wallets.sh            # start whatever is not running (background)
set -euo pipefail
here="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
skein="${SKEIN_HOME:-$HOME/.skein}"
mkdir -p "$skein/logs" "$skein/owner-home"
genkey() { node --experimental-strip-types --no-warnings "$here/genkey.ts" "$1"; }

start() { # name port home envfile
  local name=$1 port=$2 home=$3 env=$4
  if ss -ltn 2>/dev/null | grep -q "127.0.0.1:$port "; then echo "$name wallet: already on 127.0.0.1:$port"; return; fi
  ( set -a; . "$env"; set +a
    export HOME="$home" ONESAT_DAPP_PORT="$port"
    nohup 1sat serve wallet-api >> "$skein/logs/wallet-$name.log" 2>&1 & )
  for _ in $(seq 60); do ss -ltn | grep -q "127.0.0.1:$port " && break; sleep 0.5; done
  ss -ltn | grep -q "127.0.0.1:$port " || { echo "$name wallet did not start; see $skein/logs/wallet-$name.log" >&2; exit 1; }
  echo "$name wallet: started on 127.0.0.1:$port"
}

[ -f "$skein/dev-wallet.env" ] || { echo "missing $skein/dev-wallet.env (instance key; see README-wallet.md)" >&2; exit 1; }
genkey "$skein/owner-wallet.env" > "$skein/owner.identity"
genkey "$skein/dev-wallet.env" > "$skein/instance.identity"
start instance 3321 "$HOME" "$skein/dev-wallet.env"
start owner 3322 "$skein/owner-home" "$skein/owner-wallet.env"
echo "instance identity: $(cat "$skein/instance.identity")"
echo "owner identity:    $(cat "$skein/owner.identity")"

#!/usr/bin/env bash
# The BRC-100 wallets on David's machine, all `1sat serve wallet-api`
# (deny-by-default; grants via `1sat permissions grant`):
#   instance  127.0.0.1:3321  HOME unchanged (~/.1sat/cli)      key ~/.skein/dev-wallet.env
#   owner     127.0.0.1:3322  HOME=~/.skein/owner-home          key ~/.skein/owner-wallet.env
#   infer     127.0.0.1:3323  HOME=~/.skein/infer-home          key ~/.skein/infer-wallet.env  (the inference peer)
#   host      127.0.0.1:3324  HOME=~/.skein/host-wallet-home    key ~/.skein/host-wallet.env   (signs every log entry)
# The 1sat CLI has no config-dir flag or env var: CONFIG_DIR is $HOME/.1sat/cli,
# so the owner, infer and host wallets get their own HOME. Writes
# ~/.skein/{instance,owner-dev,infer,host-wallet}.identity, and ~/.skein/owner.identity
# too if there is none yet — that one is the *configured* owner (a genesis's
# `owner`), which may be some other key (e.g. the Yours wallet) that up.sh only
# controls through the page, not through owner-dev.identity's wallet (3322).
# (The host wallet is not the messagebox's `1sat serve`, whose key is
# host.env: see messagebox.sh.)
#   scripts/host/wallets.sh            # start whatever is not running (background)
#   scripts/host/wallets.sh owner infer   # only these (what up.sh starts since #33)
#
# Since the router (#33) the instance (3321) and host (3324) wallets are
# LEGACY: instances sign through the router's signer (src/host/signer.ts) and
# entries are unsigned. Only the clients' wallets remain: the dev owner (3322)
# and the inference peer (3323).
set -euo pipefail
here="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
skein="${SKEIN_HOME:-$HOME/.skein}"
mkdir -p "$skein/logs" "$skein/owner-home" "$skein/infer-home" "$skein/host-wallet-home"
genkey() { node --experimental-strip-types --no-warnings "$here/genkey.ts" "$1"; }

# A wallet-api answering HTTP, not just a listening socket: getVersion needs no
# grant and no wallet key, so it is safe to poll before any permission exists.
# It 400s with no Origin header (wallet-api requires one, like HTTPWalletJSON sends).
answers() { curl -fsS -m 1 -o /dev/null -X POST "http://127.0.0.1:$1/getVersion" -H 'Content-Type: application/json' -H 'Origin: http://skein-up' -d '{}'; }

start() { # name port home envfile
  local name=$1 port=$2 home=$3 env=$4
  if answers "$port"; then echo "$name wallet: already on 127.0.0.1:$port"; return; fi
  ( set -a; . "$env"; set +a
    export HOME="$home" ONESAT_DAPP_PORT="$port"
    nohup 1sat serve wallet-api >> "$skein/logs/wallet-$name.log" 2>&1 & )
  for _ in $(seq 20); do answers "$port" && break; sleep 0.5; done
  answers "$port" || { echo "$name wallet did not start; see $skein/logs/wallet-$name.log" >&2; exit 1; }
  echo "$name wallet: started on 127.0.0.1:$port"
}

want() { local w; for w in "${names[@]}"; do [ "$w" = "$1" ] && return 0; done; return 1; }
names=("$@")
if [ ${#names[@]} -eq 0 ]; then names=(instance owner infer host); fi
genkey "$skein/owner-wallet.env" > "$skein/owner-dev.identity"
[ -f "$skein/owner.identity" ] || cp "$skein/owner-dev.identity" "$skein/owner.identity"
genkey "$skein/infer-wallet.env" > "$skein/infer.identity"
if want instance; then
  [ -f "$skein/dev-wallet.env" ] || { echo "missing $skein/dev-wallet.env (instance key; see README-wallet.md)" >&2; exit 1; }
  genkey "$skein/dev-wallet.env" > "$skein/instance.identity"
  start instance 3321 "$HOME" "$skein/dev-wallet.env"
fi
want owner && start owner 3322 "$skein/owner-home" "$skein/owner-wallet.env"
want infer && start infer 3323 "$skein/infer-home" "$skein/infer-wallet.env"
if want host; then
  genkey "$skein/host-wallet.env" > "$skein/host-wallet.identity"
  start host 3324 "$skein/host-wallet-home" "$skein/host-wallet.env"
fi
owner=$(cat "$skein/owner.identity"); devowner=$(cat "$skein/owner-dev.identity")
echo "owner identity:    $owner$([ "$owner" = "$devowner" ] || echo " (not the dev wallet: $devowner)")"
echo "infer identity:    $(cat "$skein/infer.identity")"

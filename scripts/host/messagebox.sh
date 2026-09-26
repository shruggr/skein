#!/usr/bin/env bash
# The skein host's messagebox: `1sat serve` (unified host: storage + accounts +
# paymail + messagebox) under its own HOME and its own dev key. Messagebox at
# http://127.0.0.1:8100/messagebox, BRC-103/104 auth (AuthFetch). See README.md.
#   scripts/host/messagebox.sh          # foreground
#   scripts/host/messagebox.sh --bg     # background, log in ~/.skein/logs/messagebox.log
set -euo pipefail
here="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
skein="${SKEIN_HOME:-$HOME/.skein}"
hosthome="$skein/host-home"
port="${SKEIN_MESSAGEBOX_PORT:-8100}"
mkdir -p "$hosthome" "$skein/logs"
node --experimental-strip-types --no-warnings "$here/genkey.ts" "$skein/host.env" > "$skein/host.identity"
run1sat() { HOME="$hosthome" 1sat "$@" 2>&1 | grep -v -e 'injected env' -e ExperimentalWarning -e trace-warnings || true; }
if [ ! -f "$hosthome/.1sat/cli/config.json" ]; then
  run1sat config set server.host 127.0.0.1
  run1sat config set server.port "$port"
  run1sat config set server.paymail.baseUrl "http://localhost:$port"   # paymail wants https or http://localhost
  run1sat config set server.paymail.userDomain localhost
  run1sat config set server.monitor.enabled false
fi
echo "http://127.0.0.1:$port/messagebox" > "$skein/messagebox.url"
# 1sat serve does not migrate the messagebox tables itself (see messagebox-migrate.mjs).
node "$here/messagebox-migrate.mjs" "$hosthome/.1sat/cli/data/messagebox-main.db"
# `1sat serve` binds 0.0.0.0, not 127.0.0.1 (unlike the wallet-apis), so match on
# port alone: any bind address, not a fixed one (ss's own filter, not grep).
listening() { ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN; }
if listening "$port"; then echo "messagebox: already on $port"; exit 0; fi
set -a; . "$skein/host.env"; set +a
export HOME="$hosthome" ONESAT_MONITOR=false ONESAT_PORT="$port"
if [ "${1:-}" = "--bg" ]; then
  nohup 1sat serve >> "$skein/logs/messagebox.log" 2>&1 &
  for _ in $(seq 20); do listening "$port" && break; sleep 0.5; done
  listening "$port" || { echo "messagebox did not start; see $skein/logs/messagebox.log" >&2; exit 1; }
  echo "messagebox: $(cat "$skein/messagebox.url") (host identity $(cat "$skein/host.identity"))"
else
  exec 1sat serve
fi

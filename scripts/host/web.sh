#!/usr/bin/env bash
# The browser client: build web/ (web/dist/app.js + config.json from ~/.skein)
# and serve it on http://localhost:4400. The Yours extension keys its grants by
# origin, so the port stays fixed (SKEIN_WEB_PORT only if you must).
#   scripts/host/web.sh          # foreground
#   scripts/host/web.sh --bg     # background, log in ~/.skein/logs/web.log
set -euo pipefail
here="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
root="$(cd "$here/../.." && pwd)"
skein="${SKEIN_HOME:-$HOME/.skein}"
port="${SKEIN_WEB_PORT:-4400}"
mkdir -p "$skein/logs"
node --experimental-strip-types --no-warnings "$root/web/build.ts"
if ss -ltn 2>/dev/null | grep -qE "(127.0.0.1|\*|0.0.0.0):$port "; then echo "web already listening on $port (rebuilt; reload the page)"; exit 0; fi
if [ "${1:-}" = "--bg" ]; then
  nohup node --experimental-strip-types --no-warnings "$root/web/serve.ts" "$port" >> "$skein/logs/web.log" 2>&1 &
  for _ in $(seq 20); do ss -ltn | grep -q "127.0.0.1:$port " && break; sleep 0.25; done
  ss -ltn | grep -q "127.0.0.1:$port " || { echo "web did not start; see $skein/logs/web.log" >&2; exit 1; }
  echo "skein web: http://localhost:$port"
else
  exec node --experimental-strip-types --no-warnings "$root/web/serve.ts" "$port"
fi

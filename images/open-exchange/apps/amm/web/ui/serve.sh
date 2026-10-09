#!/usr/bin/env bash
# Builds the market UI into ../../www/ and serves it as a plain static site on
# :4800, for opening against a skein instance: set VITE_AMM_OVERLAY to the AMM
# app's base URL first (a page at a dev server's root names no app). Do not
# commit a www/ built this way (it bakes the base URL in): scripts/www.sh.
#
# No proxy: the instance's router already sends permissive CORS headers
# (access-control-allow-origin: *, see README.md "The instance").
# The page calls the instance's origin directly from wherever it's served.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

npm run build

PORT="${PORT:-4800}"
echo "Serving ../../www/ on http://127.0.0.1:${PORT}"
exec npx vite preview --port "${PORT}" --strictPort --host 127.0.0.1

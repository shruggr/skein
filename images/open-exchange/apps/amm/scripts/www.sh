#!/usr/bin/env bash
# www/, the app's pages, as committed: the AMM pages built from web/ui (which
# empties www/ first), then the Mandala pages copied into www/mandala/.
# Needs Node 22+ and npm, and the Rúnar and 1sat-sdk checkouts web/ui/README.md names.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
(cd web/engine && npm ci)
(cd web/ui && npm ci && npm run build)
scripts/mandala-pages.sh

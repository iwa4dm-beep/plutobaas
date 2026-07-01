#!/usr/bin/env bash
# Container-friendly health probe. Exits 0 when ready, 1 otherwise.
# Used by Docker HEALTHCHECK and external uptime monitors.
# Usage:  ./scripts/healthcheck.sh [url]
set -euo pipefail
URL="${1:-http://127.0.0.1:${PORT:-8787}/readyz}"
code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "$URL" || echo "000")
[[ "$code" == "200" ]] || { echo "unhealthy ($code) $URL" >&2; exit 1; }
echo "ok"

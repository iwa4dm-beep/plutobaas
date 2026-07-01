#!/usr/bin/env bash
# Poll <url>/readyz until it returns 200 or timeout expires.
# Usage:  ./scripts/wait-for-healthy.sh <base-url> [timeout-seconds]
set -euo pipefail

BASE="${1:-http://localhost:8787}"
TIMEOUT="${2:-60}"
DEADLINE=$(( $(date +%s) + TIMEOUT ))

printf "Waiting for %s/readyz " "$BASE"
while : ; do
  code=$(curl -sk -o /tmp/pluto-ready.json -w '%{http_code}' "$BASE/readyz" || echo "000")
  if [[ "$code" == "200" ]]; then
    echo " ok"
    cat /tmp/pluto-ready.json 2>/dev/null || true
    echo
    exit 0
  fi
  if (( $(date +%s) >= DEADLINE )); then
    echo " TIMEOUT after ${TIMEOUT}s (last status: $code)"
    cat /tmp/pluto-ready.json 2>/dev/null || true
    echo
    exit 1
  fi
  printf "."
  sleep 2
done

#!/usr/bin/env bash
# Standalone smoke test — verifies /livez, /readyz, /health/migrations
# return HTTP 200 with expected status body.
#
# Usage:
#   bash deploy/smoke-test.sh                                  # local (127.0.0.1:3000)
#   bash deploy/smoke-test.sh https://api.timescard.cloud      # public
set -euo pipefail

BASE="${1:-http://127.0.0.1:3000}"
FAIL=0

check() {
  local path="$1"
  local expect="$2"
  local url="$BASE$path"
  local code body
  code=$(curl -sS -o /tmp/pluto-smoke-body -w "%{http_code}" "$url" || echo 000)
  body=$(cat /tmp/pluto-smoke-body 2>/dev/null || echo "")

  if [ "$code" != "200" ]; then
    printf "  ✘ %-24s HTTP %s\n" "$path" "$code"
    [ -n "$body" ] && echo "    body: ${body:0:200}"
    FAIL=1
    return
  fi
  if echo "$body" | grep -Eq "\"status\":\"($expect)\""; then
    printf "  ✔ %-24s HTTP 200 status:%s\n" "$path" "$expect"
  else
    printf "  ✘ %-24s HTTP 200 but status not in [%s]\n" "$path" "$expect"
    echo "    body: ${body:0:200}"
    FAIL=1
  fi
}

echo "▶ smoke test against $BASE"
check /livez              "ok"
check /readyz             "ok|ready"
check /health/migrations  "ok"
rm -f /tmp/pluto-smoke-body

if [ "$FAIL" = "0" ]; then
  echo "✅ all endpoints healthy"
  exit 0
else
  echo "❌ one or more endpoints failed"
  exit 1
fi

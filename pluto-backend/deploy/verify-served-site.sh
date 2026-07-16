#!/usr/bin/env bash
# Post-deploy verifier — probes every place the served site can appear and
# reports HTTP 200 on at least one. Usable as a smoke test in CI or the
# "did my deploy actually go live?" copy-paste check.
#
# Usage:
#   bash pluto-backend/deploy/verify-served-site.sh <slug>
#   APEX=app.timescard.cloud API=api.timescard.cloud bash ... <slug>
#
# Exits 0 iff at least one endpoint returned HTTP 2xx.

set -uo pipefail

SLUG="${1:-}"
APEX="${APEX:-app.timescard.cloud}"
API="${API:-api.timescard.cloud}"

if [ -z "$SLUG" ]; then
  echo "Usage: $0 <slug>"; exit 2
fi

# Probe targets (production + preview channel + worker fallback).
TARGETS=(
  "https://${SLUG}.${APEX}/"
  "https://${SLUG}-dev.${APEX}/"
  "https://${API}/sites/${SLUG}/"
  "https://${API}/preview/${SLUG}/"
  "http://127.0.0.1:8787/sites/${SLUG}/"
)

pass=0; fail=0; first_200=""
printf "%-6s %-6s %-8s %s\n" "STAT" "HTTP" "SIZE" "URL"
printf "%-6s %-6s %-8s %s\n" "----" "----" "----" "---"
for url in "${TARGETS[@]}"; do
  # -o /dev/null → discard body; -w → status + size; --max-time 8s per probe.
  out="$(curl -s -o /dev/null -w '%{http_code} %{size_download}' --max-time 8 -L "$url" || echo '000 0')"
  code="${out%% *}"; size="${out##* }"
  if [ "$code" -ge 200 ] 2>/dev/null && [ "$code" -lt 300 ]; then
    mark="✓"; pass=$((pass+1)); [ -z "$first_200" ] && first_200="$url"
  else
    mark="✗"; fail=$((fail+1))
  fi
  printf "%-6s %-6s %-8s %s\n" "$mark" "$code" "$size" "$url"
done

echo
if [ $pass -gt 0 ]; then
  echo "✅  Served site is live — $pass endpoint(s) OK.  First live URL:"
  echo "    $first_200"
  # Fetch a small snippet from the first live URL to confirm HTML is coming through.
  echo "▶ preview:"
  curl -s -L --max-time 8 "$first_200" | head -c 400
  echo; echo
  exit 0
else
  echo "❌  No endpoint returned 2xx for slug '$SLUG'."
  echo "   Checklist:"
  echo "   1. Was the deploy actually pushed?   (Auto Deploy → status ✓)"
  echo "   2. Is sandbox-worker running?        systemctl status pluto-sandbox-worker"
  echo "   3. Did nginx reload with new config? sudo nginx -t && sudo systemctl reload nginx"
  echo "   4. Does the slug exist on disk?      ls /var/lib/pluto/sites/${SLUG}"
  echo "   5. Tail worker logs:                 journalctl -u pluto-sandbox-worker -f"
  exit 1
fi

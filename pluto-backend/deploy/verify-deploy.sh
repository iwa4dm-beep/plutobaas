#!/usr/bin/env bash
# Full post-deploy verifier — proves nginx → worker → static bundle works
# end-to-end for a given slug. Combines:
#   1. worker /healthz on 127.0.0.1:8787
#   2. nginx → /sandbox/healthz over HTTPS  (api.<APEX>)
#   3. /site-status/<slug> readiness readout
#   4. served-site probe (delegates to verify-served-site.sh)
#
# Usage:
#   bash pluto-backend/deploy/verify-deploy.sh <slug>
#   APEX=app.timescard.cloud API=api.timescard.cloud bash ... <slug>

set -uo pipefail

SLUG="${1:-}"
[ -z "$SLUG" ] && { echo "Usage: $0 <slug>"; exit 2; }
APEX="${APEX:-app.timescard.cloud}"
API="${API:-api.timescard.cloud}"
here="$(cd "$(dirname "$0")" && pwd)"

step() { printf "\n▶ %s\n" "$*"; }
ok()   { printf "  ✓ %s\n" "$*"; }
bad()  { printf "  ✗ %s\n" "$*"; FAIL=1; }
FAIL=0

step "1/4  Worker /healthz on 127.0.0.1:8787"
if OUT="$(curl -fsS --max-time 5 http://127.0.0.1:8787/healthz)"; then
  ok "worker responded"; echo "$OUT" | head -c 300; echo
else
  bad "worker unreachable — check: sudo systemctl status pluto-sandbox-worker"
fi

step "2/4  Nginx → worker (/sandbox/healthz over HTTPS)"
code="$(curl -s -o /tmp/_sandbox_health.json -w '%{http_code}' --max-time 8 "https://${API}/sandbox/healthz" || echo 000)"
if [ "$code" = "200" ]; then
  ok "https://${API}/sandbox/healthz → 200"
else
  bad "https://${API}/sandbox/healthz → HTTP ${code} (nginx→worker routing broken?)"
  echo "     nginx test:   sudo nginx -t"
  echo "     nginx reload: sudo systemctl reload nginx"
fi

step "3/4  Site readiness — /site-status/${SLUG}"
code="$(curl -s -o /tmp/_site_status.json -w '%{http_code}' --max-time 8 "https://${API}/site-status/${SLUG}" || echo 000)"
if [ "$code" = "200" ]; then
  ok "readiness endpoint responded"
  cat /tmp/_site_status.json | python3 -m json.tool 2>/dev/null || cat /tmp/_site_status.json
  echo
else
  bad "site-status → HTTP ${code}"
fi

step "4/4  Served site probe"
if bash "$here/verify-served-site.sh" "$SLUG"; then
  ok "served-site verifier passed"
else
  bad "served-site verifier failed"
fi

echo
if [ $FAIL -eq 0 ]; then
  echo "✅  Deploy verification PASSED for '$SLUG'."
  exit 0
else
  echo "❌  Deploy verification FAILED — fix the ✗ steps above and re-run."
  exit 1
fi

#!/usr/bin/env bash
# Full post-deploy verifier — proves nginx → worker → static bundle works
# end-to-end for a given slug. Combines:
#   1. worker /healthz on 127.0.0.1:8787
#   2. nginx → /sandbox/healthz over HTTPS  (api.<APEX>)
#   3. /site-status/<slug> readiness readout
#   4. nginx → /sites/<slug>/ over HTTPS
#   5. served-site probe (delegates to verify-served-site.sh)
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

step "1/5  Worker /healthz on 127.0.0.1:8787"
if OUT="$(curl -fsS --max-time 5 http://127.0.0.1:8787/healthz)"; then
  ok "worker responded"; echo "$OUT" | head -c 300; echo
  if ! echo "$OUT" | grep -q 'v1-static-serve'; then
    bad "worker is stale — /healthz has no v1-static-serve marker"
    echo "     Fix now: sudo bash deploy/refresh-worker.sh"
  fi
else
  bad "worker unreachable — check: sudo systemctl status pluto-sandbox-worker"
fi

step "2/5  Nginx → worker (/sandbox/healthz over HTTPS)"
code="$(curl -s -o /tmp/_sandbox_health.json -w '%{http_code}' --max-time 8 "https://${API}/sandbox/healthz" || echo 000)"
if [ "$code" = "200" ]; then
  ok "https://${API}/sandbox/healthz → 200"
else
  bad "https://${API}/sandbox/healthz → HTTP ${code} (nginx→worker routing broken?)"
  echo "     nginx test:   sudo nginx -t"
  echo "     nginx reload: sudo systemctl reload nginx"
fi

step "3/5  Site readiness — /site-status/${SLUG}"
code="$(curl -s -o /tmp/_site_status.json -w '%{http_code}' --max-time 8 "https://${API}/site-status/${SLUG}" || echo 000)"
if [ "$code" = "200" ]; then
  ok "readiness endpoint responded"
  cat /tmp/_site_status.json | python3 -m json.tool 2>/dev/null || cat /tmp/_site_status.json
  echo
else
  bad "site-status → HTTP ${code}"
  cat /tmp/_site_status.json 2>/dev/null | head -c 300; echo
  if [ "$code" = "401" ]; then
    echo "     401 here means the old worker is still running and treating public routes as secret-protected."
    echo "     Fix now: sudo bash deploy/refresh-worker.sh && bash deploy/verify-deploy.sh ${SLUG}"
  elif [ "$code" = "404" ]; then
    echo "     404 here means the worker is healthy but cannot resolve this slug."
    # Try worker-native auto-seed first (no root required, no shell out).
    code2="$(curl -s -o /tmp/_site_status.json -w '%{http_code}' --max-time 8 \
      -H 'x-pluto-auto-seed: 1' "https://${API}/site-status/${SLUG}?autoseed=1" || echo 000)"
    if [ "$code2" = "200" ]; then
      ok "site-status recovered via worker auto-seed"
      cat /tmp/_site_status.json | python3 -m json.tool 2>/dev/null || cat /tmp/_site_status.json
      echo
    else
      echo "     Recover now: sudo bash deploy/seed-slug.sh '${SLUG}' && bash deploy/verify-deploy.sh '${SLUG}'"
      if [ "$(id -u)" = "0" ] && [ -f "$here/seed-slug.sh" ]; then
        echo "     Auto-seeding placeholder for '${SLUG}' now…"
        bash "$here/seed-slug.sh" "$SLUG" >/tmp/_seed_slug.log 2>&1 || cat /tmp/_seed_slug.log
        code="$(curl -s -o /tmp/_site_status.json -w '%{http_code}' --max-time 8 "https://${API}/site-status/${SLUG}" || echo 000)"
        [ "$code" = "200" ] && { ok "site-status recovered after seed"; cat /tmp/_site_status.json | python3 -m json.tool 2>/dev/null || cat /tmp/_site_status.json; echo; }
      fi
    fi
  fi
fi

step "4/5  Required HTTPS /sites/${SLUG}/ probe"
code="$(curl -s -o /tmp/_api_sites_probe.html -w '%{http_code}' --max-time 8 -L "https://${API}/sites/${SLUG}/" || echo 000)"
if [ "$code" = "200" ]; then
  ok "https://${API}/sites/${SLUG}/ → 200"
else
  bad "https://${API}/sites/${SLUG}/ → HTTP ${code}"
  if [ "$code" = "401" ]; then
    echo "     401 here is not a missing bundle; it means stale worker code is active."
    echo "     Fix now: sudo bash deploy/refresh-worker.sh"
  elif [ "$code" = "404" ]; then
    echo "     404 means the slug is not linked or no bundle has been unpacked for it."
    echo "     Recover now: sudo SLUG='${SLUG}' bash deploy/repair-sandbox-worker-and-site.sh"
  fi
  echo "     If worker health is OK, check slug disk state: ls -la /var/lib/pluto/sites/${SLUG}"
fi

step "5/5  Served site probe"
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

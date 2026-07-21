#!/usr/bin/env bash
# fix-wildcard-ssl.sh — একবারে *.<apex>-এর wildcard TLS certificate issue করে,
# nginx-এ wildcard vhost বসায়, reload করে, তারপর verifier চালায়।
#
# Usage:
#   sudo CF_API_TOKEN='cf-token-with-Zone:DNS:Edit' \
#        bash deploy/fix-wildcard-ssl.sh dbhstock-8myjt4
#
#   # or, if /etc/letsencrypt/cloudflare.ini already exists:
#   sudo bash deploy/fix-wildcard-ssl.sh dbhstock-8myjt4
#
# Env:
#   APEX          default: app.timescard.app
#   ACME_EMAIL    default: admin@<zone>
#   CF_API_TOKEN  optional; auto-writes /etc/letsencrypt/cloudflare.ini

set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "✗ run as root (sudo)"; exit 2; }

SLUG="${1:-}"
APEX="${APEX:-app.timescard.app}"
ACME_EMAIL="${ACME_EMAIL:-admin@${APEX#*.}}"
here="$(cd "$(dirname "$0")" && pwd)"

log(){ printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }

log "1/4 Ensuring wildcard DNS records for ${APEX}"
CF_API_TOKEN="${CF_API_TOKEN:-}" bash "$here/ensure-wildcard-dns.sh" "$APEX" || true

log "2/4 Issuing / verifying wildcard cert for *.${APEX}"
CERT_LIVE="/etc/letsencrypt/live/${APEX}"
needs_issue=1
if [ -s "${CERT_LIVE}/fullchain.pem" ]; then
  # Confirm it actually covers *.<apex>
  if openssl x509 -in "${CERT_LIVE}/fullchain.pem" -noout -text 2>/dev/null \
       | grep -q "DNS:\*\.${APEX}"; then
    echo "  ✓ existing cert already covers *.${APEX}"
    needs_issue=0
  else
    echo "  ⚠ existing cert does NOT cover *.${APEX} — reissuing"
  fi
fi
if [ "$needs_issue" = "1" ]; then
  CF_API_TOKEN="${CF_API_TOKEN:-}" ACME_EMAIL="$ACME_EMAIL" \
    bash "$here/install-wildcard-tls.sh" "$APEX"
fi

log "3/4 Installing wildcard nginx vhost and reloading"
SKIP_DNS=1 ACME_EMAIL="$ACME_EMAIL" \
  bash "$here/install-sites-proxy.sh" --wildcard "$APEX"

log "4/4 Verifying"
if [ -n "$SLUG" ]; then
  bash "$here/verify-deploy.sh" "$SLUG" || true
  echo
  echo "Try in browser:"
  echo "  https://${SLUG}.${APEX}/"
  echo "  https://${SLUG}-dev.${APEX}/"
else
  echo "  (pass a slug as \$1 to run the full verifier)"
fi

echo
echo "✓ Wildcard SSL setup complete for *.${APEX}"

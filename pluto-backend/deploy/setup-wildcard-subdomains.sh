#!/usr/bin/env bash
# setup-wildcard-subdomains.sh — Vercel/Lovable-style dynamic subdomain setup.
#
# Run once on the VPS. After this, every slug is served automatically as:
#   https://<slug>.app.timescard.cloud/
#   https://<slug>-dev.app.timescard.cloud/
# No per-slug DNS record or nginx vhost is needed.
#
# Usage:
#   sudo CF_API_TOKEN='cloudflare-token' \
#        UPSTREAM='https://<project-ref>.supabase.co' \
#        SERVICE_KEY='<service-role-key>' \
#        bash deploy/setup-wildcard-subdomains.sh
#
# Optional:
#   APEX=app.timescard.cloud
#   ACME_EMAIL=admin@timescard.cloud
#   SLUG=frfrom-he3wm0          # verify/seed one slug after setup
#   SECRET=<shared-secret>      # otherwise existing/generated worker secret is used
#   VPS_IP=<server-ip>          # if public IP auto-detect fails
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "✗ run as root (sudo)"; exit 2; }

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
APEX="${APEX:-${WILDCARD:-app.timescard.cloud}}"
ACME_EMAIL="${ACME_EMAIL:-admin@${APEX#*.}}"
SLUG="${SLUG:-${1:-}}"

log(){ printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
die(){ printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

cd "$ROOT"

log "0/8 Pull latest deploy scripts (safe-pull, non-destructive)"
if [ -x "$HERE/safe-pull.sh" ]; then bash "$HERE/safe-pull.sh" || echo "  (safe-pull skipped/failed — continuing with on-disk scripts)"; fi

log "1/8 Ensure wildcard DNS: ${APEX} and *.${APEX}"
bash "$HERE/ensure-wildcard-dns.sh" "$APEX" || true

log "2/7 Install/repair sandbox worker"
if [ -z "${SECRET:-}" ] && [ -r /etc/pluto/sandbox-worker.env ]; then
  SECRET="$(grep -E '^SANDBOX_SHARED_SECRET=' /etc/pluto/sandbox-worker.env | tail -1 | cut -d= -f2- || true)"
  export SECRET
fi
SECRET="${SECRET:-}" SERVICE_KEY="${SERVICE_KEY:-}" UPSTREAM="${UPSTREAM:-}" WILDCARD="$APEX" ACME_EMAIL="$ACME_EMAIL" \
  bash "$HERE/bootstrap-sandbox-worker.sh"

log "3/8 Refresh running worker code"
bash "$HERE/refresh-worker.sh"

log "4/8 Issue/verify wildcard SSL certificate (*.$APEX)"
APEX="$APEX" ACME_EMAIL="$ACME_EMAIL" bash "$HERE/fix-wildcard-ssl.sh" "${SLUG:-}"

log "5/8 Install nginx wildcard proxy"
ACME_EMAIL="$ACME_EMAIL" bash "$HERE/install-sites-proxy.sh" --wildcard "$APEX"
nginx -t
systemctl reload nginx

log "6/8 Install auto-renew timer (twice-daily certbot renew)"
if [ -x "$HERE/install-tls-renew-timer.sh" ]; then bash "$HERE/install-tls-renew-timer.sh" || true; fi

if [ -n "$SLUG" ]; then
  log "7/8 Ensure slug has a served placeholder if no bundle exists: $SLUG"
  code="$(curl -s -o /tmp/_pluto_status.json -w '%{http_code}' --max-time 8 "https://api.${APEX#app.}/site-status/${SLUG}" || echo 000)"
  if [ "$code" != "200" ]; then
    bash "$HERE/seed-slug.sh" "$SLUG" || true
  fi

  log "8/8 First verify-deploy for $SLUG"
  APEX="$APEX" API="api.${APEX#app.}" bash "$HERE/verify-deploy.sh" "$SLUG" || VERIFY_FAILED=1
else
  log "7/8 No SLUG provided — skipping targeted verify"
  echo "   Verify any slug later with:"
  echo "     sudo APEX=$APEX bash $HERE/verify-deploy.sh <slug>"

  log "8/8 Active subdomain summary"
  BASE_DOMAIN="$APEX" bash "$HERE/list-active-subdomains.sh" || true
fi

# Deterministic final summary — always prints, even if verify-deploy fails.
CERT_LINE="(no wildcard cert found)"
if [ -r "/etc/letsencrypt/live/${APEX}/fullchain.pem" ]; then
  CERT_LINE="$(openssl x509 -in /etc/letsencrypt/live/${APEX}/fullchain.pem -noout -subject -enddate 2>/dev/null | tr '\n' ' ')"
fi

cat <<EOF

════════════════════════════════════════════════════════════════
$( [ "${VERIFY_FAILED:-0}" = "1" ] && echo "⚠ Setup completed but verify-deploy failed for slug: $SLUG" || echo "✅ Wildcard subdomain platform installed for *.${APEX}" )
════════════════════════════════════════════════════════════════

Cert: ${CERT_LINE}
Nginx wildcard vhost: /etc/nginx/sites-enabled/pluto-wildcard-${APEX}.conf
Worker unit: pluto-sandbox-worker.service ($(systemctl is-active pluto-sandbox-worker 2>/dev/null || echo unknown))

How new deploys work:
  1. Wildcard DNS *.${APEX} → this VPS (one record forever)
  2. One nginx wildcard vhost — no per-slug config
  3. Sandbox worker routes Host: <slug>.${APEX} to its release directory
  4. Wildcard cert already covers every slug — no per-slug certbot run

Verify any slug later:
  sudo APEX=${APEX} bash $HERE/verify-deploy.sh <slug>

Permanent config to keep in sync:
  - /etc/pluto/sandbox-worker.env  (SANDBOX_SHARED_SECRET on VPS)
  - Lovable Cloud → Secrets → PLUTO_SANDBOX_SECRET (must match VPS)
  - /etc/letsencrypt/cloudflare.ini (Cloudflare API token for DNS-01 renew)
EOF

[ "${VERIFY_FAILED:-0}" = "1" ] && exit 1 || exit 0

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

log "1/7 Ensure wildcard DNS: ${APEX} and *.${APEX}"
bash "$HERE/ensure-wildcard-dns.sh" "$APEX" || true

log "2/7 Install/repair sandbox worker"
if [ -z "${SECRET:-}" ] && [ -r /etc/pluto/sandbox-worker.env ]; then
  SECRET="$(grep -E '^SANDBOX_SHARED_SECRET=' /etc/pluto/sandbox-worker.env | tail -1 | cut -d= -f2- || true)"
  export SECRET
fi
SECRET="${SECRET:-}" SERVICE_KEY="${SERVICE_KEY:-}" UPSTREAM="${UPSTREAM:-}" WILDCARD="$APEX" ACME_EMAIL="$ACME_EMAIL" \
  bash "$HERE/bootstrap-sandbox-worker.sh"

log "3/7 Refresh running worker code"
bash "$HERE/refresh-worker.sh"

log "4/7 Issue/verify wildcard SSL certificate"
APEX="$APEX" ACME_EMAIL="$ACME_EMAIL" bash "$HERE/fix-wildcard-ssl.sh" "${SLUG:-}"

log "5/7 Install nginx wildcard proxy"
ACME_EMAIL="$ACME_EMAIL" bash "$HERE/install-sites-proxy.sh" --wildcard "$APEX"
nginx -t
systemctl reload nginx

if [ -n "$SLUG" ]; then
  log "6/7 Ensure slug has a served placeholder if no bundle exists yet: $SLUG"
  code="$(curl -s -o /tmp/_pluto_status.json -w '%{http_code}' --max-time 8 "https://api.${APEX#app.}/site-status/${SLUG}" || echo 000)"
  if [ "$code" != "200" ]; then
    bash "$HERE/seed-slug.sh" "$SLUG" || true
  fi

  log "7/7 Verify live slug"
  APEX="$APEX" API="api.${APEX#app.}" bash "$HERE/verify-deploy.sh" "$SLUG"
else
  log "6/7 Skip slug verification (set SLUG=<slug> to verify one now)"
  echo "Test any deployed slug with:"
  echo "  APEX=$APEX bash $HERE/verify-served-site.sh <slug>"

  log "7/7 Current subdomain summary"
  BASE_DOMAIN="$APEX" bash "$HERE/list-active-subdomains.sh" || true
fi

cat <<EOF

✅ Wildcard subdomain platform is installed for *.${APEX}

How it works from now on:
  1. DNS has one wildcard record: *.${APEX} → this VPS
  2. nginx has one wildcard vhost, not one vhost per slug
  3. The sandbox worker maps each deploy slug to its release directory
  4. New slugs automatically go live at https://<slug>.${APEX}/

Required permanent secrets/config:
  - VPS /etc/pluto/sandbox-worker.env keeps SANDBOX_SHARED_SECRET secret.
  - Lovable Cloud secret PLUTO_SANDBOX_SECRET must match that VPS value.
  - Cloudflare token should stay only on the VPS at /etc/letsencrypt/cloudflare.ini for DNS-01 renewals.
EOF
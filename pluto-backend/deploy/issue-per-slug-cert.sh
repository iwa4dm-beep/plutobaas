#!/usr/bin/env bash
# Issue an HTTP-01 (webroot) Let's Encrypt certificate for a single Pluto slug
# subdomain and install a dedicated nginx vhost for it. Use this when the base
# domain (default: app.timescard.cloud) is NOT on Cloudflare / a DNS provider
# supported by certbot, so wildcard DNS-01 isn't available.
#
# Usage:
#   sudo bash pluto-backend/deploy/issue-per-slug-cert.sh <slug> [base-domain] [admin-email]
#
# Example:
#   sudo bash pluto-backend/deploy/issue-per-slug-cert.sh dubaiborkahouse-tzsegx
#
# Prereqs (verified by this script):
#   * DNS A record <slug>.<base> → this VPS's public IP (works for *.<base> too)
#   * nginx listening on :80 and /var/www/certbot writable
#   * certbot installed (apt install -y certbot python3-certbot-nginx)
#   * /var/lib/pluto/sites/<slug>/current exists (created by the sandbox worker
#     after a successful deploy; we don't require a bundle here — nginx will
#     show "Not deployed yet" until one is uploaded).
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (sudo)." >&2
  exit 1
fi

SLUG="${1:-}"
BASE="${2:-app.timescard.cloud}"
EMAIL="${3:-${CERT_EMAIL:-admin@timescard.cloud}}"

if [[ -z "$SLUG" ]]; then
  echo "Usage: $0 <slug> [base-domain] [admin-email]" >&2
  exit 2
fi
if ! [[ "$SLUG" =~ ^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$ ]] 2>/dev/null; then
  # bash regex doesn't support (?:) — do a plain check.
  if ! [[ "$SLUG" =~ ^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$ ]]; then
    echo "Invalid slug: $SLUG" >&2
    exit 2
  fi
fi

FQDN="${SLUG}.${BASE}"
WEBROOT="/var/www/certbot"
SITE_ROOT="/var/lib/pluto/sites/${SLUG}"
NGINX_AVAILABLE="/etc/nginx/sites-available/pluto-slug-${SLUG}.conf"
NGINX_ENABLED="/etc/nginx/sites-enabled/pluto-slug-${SLUG}.conf"
TEMPLATE="$(cd "$(dirname "$0")" && pwd)/nginx/per-slug-http01.conf.template"

echo "==> Issuing HTTP-01 cert for ${FQDN}"

# 1) Ensure certbot is present
if ! command -v certbot >/dev/null 2>&1; then
  echo "==> installing certbot"
  apt-get update -y >/dev/null
  apt-get install -y certbot >/dev/null
fi

# 2) Ensure webroot exists and nginx can serve /.well-known/acme-challenge/
mkdir -p "$WEBROOT/.well-known/acme-challenge"
chown -R www-data:www-data "$WEBROOT" 2>/dev/null || true

# 3) Ensure the site tree exists so nginx can start after we install the vhost
mkdir -p "$SITE_ROOT/current" "$SITE_ROOT/preview"
if [[ ! -f "$SITE_ROOT/current/index.html" ]]; then
  cat > "$SITE_ROOT/current/index.html" <<HTML
<!doctype html><meta charset=utf-8><title>${SLUG}</title>
<body style="font-family:system-ui;padding:3rem;max-width:36rem;margin:auto">
<h1>Placeholder</h1><p>Slug <code>${SLUG}</code> is registered. Push a build to activate.</p>
</body>
HTML
fi

# 4) DNS sanity check (non-fatal; certbot will fail loudly if wrong)
if command -v getent >/dev/null 2>&1; then
  RESOLVED="$(getent hosts "$FQDN" | awk '{print $1}' | head -n1 || true)"
  if [[ -z "$RESOLVED" ]]; then
    echo "!! Warning: ${FQDN} does not resolve. Add DNS record before retrying."
  else
    echo "   DNS: ${FQDN} -> ${RESOLVED}"
  fi
fi

# 5) Pre-issue: make sure port 80 is reachable for HTTP-01. If nginx isn't
#    running yet with any http vhost for this FQDN, `certbot certonly --webroot`
#    still works as long as *some* server_name covers the host on :80. The
#    existing wildcard-app.conf already listens on :80 for *.<base>, which is
#    enough. If the wildcard vhost isn't installed we install a stub HTTP-only
#    server for this slug so the challenge can be served.
if ! nginx -T 2>/dev/null | grep -qE "server_name[[:space:]]+.*\\*\\.${BASE//./\\.}"; then
  STUB="/etc/nginx/sites-available/pluto-slug-${SLUG}-acme.conf"
  cat > "$STUB" <<CONF
server {
    listen 80;
    listen [::]:80;
    server_name ${FQDN};
    location /.well-known/acme-challenge/ { root ${WEBROOT}; }
    location / { return 404; }
}
CONF
  ln -sf "$STUB" "/etc/nginx/sites-enabled/pluto-slug-${SLUG}-acme.conf"
  nginx -t
  systemctl reload nginx
fi

# 6) Request the certificate
certbot certonly \
  --webroot -w "$WEBROOT" \
  -d "$FQDN" \
  --email "$EMAIL" \
  --agree-tos --no-eff-email \
  --non-interactive \
  --keep-until-expiring

# 7) Render and enable the per-slug HTTPS vhost
if [[ ! -f "$TEMPLATE" ]]; then
  echo "Template missing: $TEMPLATE" >&2
  exit 3
fi
sed -e "s/__SLUG__/${SLUG}/g" -e "s/__BASE__/${BASE}/g" "$TEMPLATE" > "$NGINX_AVAILABLE"
ln -sf "$NGINX_AVAILABLE" "$NGINX_ENABLED"

# Remove the temporary ACME-only stub if present — the full vhost supersedes it.
rm -f "/etc/nginx/sites-enabled/pluto-slug-${SLUG}-acme.conf"

nginx -t
systemctl reload nginx

# 8) Verify
sleep 1
CODE="$(curl -sk -o /dev/null -w '%{http_code}' "https://${FQDN}/" || true)"
echo "==> https://${FQDN}/ -> HTTP ${CODE}"

echo "OK: ${FQDN} is now served with a per-slug Let's Encrypt certificate."
echo "    Renewal: the system certbot.timer will auto-renew via webroot."

#!/usr/bin/env bash
# Domain-aware Nginx site installer for the Pluto API.
# Copies deploy/nginx/<template>.conf → /etc/nginx/sites-available,
# rewrites the domain, symlinks into sites-enabled, tests + reloads Nginx.
#
# Usage:
#   bash deploy/install-nginx-site.sh api.timescard.cloud
#   bash deploy/install-nginx-site.sh api.example.com api.timescard.cloud.conf
set -euo pipefail

DOMAIN="${1:-}"
TEMPLATE="${2:-api.timescard.cloud.conf}"

if [ -z "$DOMAIN" ]; then
  echo "usage: $0 <domain> [template.conf]" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/deploy/nginx/$TEMPLATE"
DST_AVAIL="/etc/nginx/sites-available/${DOMAIN}.conf"
DST_ENABLED="/etc/nginx/sites-enabled/${DOMAIN}.conf"

[ -f "$SRC" ] || { echo "❌ template not found: $SRC" >&2; exit 1; }

echo "▶ deploying nginx site for $DOMAIN"
echo "  template: $SRC"
echo "  target:   $DST_AVAIL"

SUDO=""; [ "$(id -u)" != "0" ] && SUDO="sudo"

# Rewrite api.timescard.cloud → $DOMAIN and cert paths accordingly
$SUDO mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled
$SUDO tee "$DST_AVAIL" >/dev/null < <(sed "s|api\.timescard\.cloud|$DOMAIN|g" "$SRC")
$SUDO ln -sf "$DST_AVAIL" "$DST_ENABLED"
echo "  ✔ installed + symlinked"

# Ensure certificate exists before nginx tries to load it
CERT="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
if [ ! -f "$CERT" ]; then
  echo "⚠ no certificate at $CERT"
  echo "  run: sudo certbot --nginx -d $DOMAIN"
  echo "  (skipping nginx reload)"
  exit 0
fi

echo "▶ nginx -t"
$SUDO nginx -t
echo "▶ reload nginx"
$SUDO systemctl reload nginx
echo "✅ $DOMAIN is live"

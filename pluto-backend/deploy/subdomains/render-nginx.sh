#!/usr/bin/env bash
# Render nginx vhosts for app / api / dashboard subdomains.
#
# Env (required):
#   BASE_DOMAIN         e.g. timescard.cloud
# Env (optional — upstreams):
#   APP_UPSTREAM        "static" (default) or http://host:port
#   API_UPSTREAM        default http://127.0.0.1:3000
#   DASHBOARD_UPSTREAM  default http://127.0.0.1:8080
#   APP_ROOT            when APP_UPSTREAM=static, path to the built frontend
#                       default /var/www/app.<BASE_DOMAIN>
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "run as root (sudo)"; exit 1; fi

HERE="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE="$HERE/nginx-subdomain.conf.template"
BASE_DOMAIN="${BASE_DOMAIN:?set BASE_DOMAIN (e.g. timescard.cloud)}"
APP_UPSTREAM="${APP_UPSTREAM:-static}"
API_UPSTREAM="${API_UPSTREAM:-http://127.0.0.1:3000}"
DASHBOARD_UPSTREAM="${DASHBOARD_UPSTREAM:-http://127.0.0.1:8080}"
APP_ROOT="${APP_ROOT:-/var/www/app.$BASE_DOMAIN}"

SITES_AVAILABLE=/etc/nginx/sites-available
SITES_ENABLED=/etc/nginx/sites-enabled
mkdir -p "$SITES_AVAILABLE" "$SITES_ENABLED" /var/www/html

static_block() {
  local root="$1"
  cat <<EOF
    root $root;
    index index.html;

    location / { try_files \$uri \$uri/ /index.html; }

    location ~* \\.(?:js|css|woff2?|png|jpg|jpeg|gif|svg|ico|webp)\$ {
        expires 30d;
        access_log off;
        add_header Cache-Control "public, max-age=2592000, immutable";
    }
    location = /index.html {
        add_header Cache-Control "no-store, must-revalidate";
    }
    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;
EOF
}

proxy_block() {
  local upstream="$1"
  cat <<EOF
    location / {
        proxy_pass         $upstream;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_set_header   Upgrade           \$http_upgrade;
        proxy_set_header   Connection        "upgrade";
        proxy_read_timeout 60s;
    }
EOF
}

render() {
  local host="$1" upstream="$2"
  local out="$SITES_AVAILABLE/$host.conf"
  local routing
  if [ "$upstream" = "static" ]; then
    mkdir -p "$APP_ROOT"
    routing="$(static_block "$APP_ROOT")"
  else
    routing="$(proxy_block "$upstream")"
  fi

  # Substitute placeholders. Use a temp file so we can inject the multi-line
  # routing block via awk instead of sed (avoids quoting hell).
  awk -v host="$host" -v routing="$routing" '
    { gsub(/__HOST__/, host); gsub(/__ROUTING_BLOCK__.*/, routing); print }
  ' "$TEMPLATE" > "$out"

  ln -sf "$out" "$SITES_ENABLED/$host.conf"
  echo "  ✓ rendered $out"
}

echo "▶ rendering nginx vhosts under $BASE_DOMAIN"
render "app.$BASE_DOMAIN"       "$APP_UPSTREAM"
render "api.$BASE_DOMAIN"       "$API_UPSTREAM"
render "dashboard.$BASE_DOMAIN" "$DASHBOARD_UPSTREAM"

# Remove the default catch-all if it fights us for server_name _.
if [ -L /etc/nginx/sites-enabled/default ]; then
  rm -f /etc/nginx/sites-enabled/default
  echo "  ✓ removed default vhost symlink"
fi

# nginx -t will fail here if certs don't exist yet — that's expected.
# issue-certs.sh runs certbot which drops the cert files, then reloads.
echo "▶ config rendered. next: bash issue-certs.sh"

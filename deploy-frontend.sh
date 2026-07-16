#!/usr/bin/env bash
# ============================================================
# Pluto BaaS — Frontend Deploy Script (VPS)
# Usage:  sudo APP_DIR=/root/backend-joy bash /root/backend-joy/deploy-frontend.sh
#
# This is a TanStack Start app, not a static SPA. Production output is:
#   .output/server/index.mjs      (Node server)
#   .output/public/assets/*       (hashed CSS/JS assets)
# Do not rsync dist/ or use an index.html SPA fallback for /assets/*.
# ============================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/root/backend-joy}"
SERVICE="${SERVICE:-pluto-dashboard}"
PORT="${PORT:-3001}"
PUBLIC_URL="${PUBLIC_URL:-https://dashboard.timescard.cloud/}"
BUN_BIN="${BUN_BIN:-/root/.bun/bin/bun}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

public_host() {
  local url="${PUBLIC_URL#http://}"
  url="${url#https://}"
  url="${url%%/*}"
  printf '%s' "${url%%:*}"
}

is_https_public_url() {
  case "$PUBLIC_URL" in
    https://*) return 0 ;;
    *) return 1 ;;
  esac
}

DOMAIN="${DOMAIN:-$(public_host)}"
PUBLIC_BASE="${PUBLIC_URL%/}"
SYSTEMD_UNIT="/etc/systemd/system/${SERVICE}.service"
NGINX_AVAILABLE="/etc/nginx/sites-available/${DOMAIN}"
NGINX_ENABLED="/etc/nginx/sites-enabled/${DOMAIN}"
NGINX_CONF_D="/etc/nginx/conf.d/${DOMAIN}.conf"
NGINX_SITE=""
SUDO=""
[ "$(id -u)" = "0" ] || SUDO="sudo"

log() { printf "\n\033[1;36m▶ %s\033[0m\n" "$*"; }
ok()  { printf "\033[1;32m✔ %s\033[0m\n" "$*"; }
warn(){ printf "\033[1;33m! %s\033[0m\n" "$*"; }
fail(){ printf "\033[1;31m❌ %s\033[0m\n" "$*"; exit 1; }

tls_cert_matches_domain() {
  local cert="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
  local key="/etc/letsencrypt/live/${DOMAIN}/privkey.pem"
  [ -f "$cert" ] && [ -f "$key" ] || return 1
  command -v openssl >/dev/null 2>&1 || return 0
  openssl x509 -in "$cert" -noout -checkhost "$DOMAIN" 2>/dev/null | grep -qi 'does match'
}

nginx_dump() {
  $SUDO nginx -T 2>&1 || true
}

select_nginx_site_path() {
  local dump
  dump="$(nginx_dump)"

  if printf '%s\n' "$dump" | grep -qE '(/etc/nginx/sites-enabled/|include[[:space:]]+/etc/nginx/sites-enabled/)'; then
    NGINX_SITE="$NGINX_AVAILABLE"
    ok "nginx includes sites-enabled; using ${NGINX_SITE}"
  else
    NGINX_SITE="$NGINX_CONF_D"
    warn "nginx does not appear to load sites-enabled; using loaded conf.d path ${NGINX_SITE}"
  fi
}

same_nginx_file() {
  local left="$1" right="$2"
  [ "$left" = "$right" ] && return 0
  [ -e "$left" ] && [ -e "$right" ] || return 1
  [ "$(readlink -f "$left")" = "$(readlink -f "$right")" ]
}

install_nginx_site_link() {
  [ -n "$NGINX_SITE" ] || select_nginx_site_path

  if [ "$NGINX_SITE" = "$NGINX_AVAILABLE" ]; then
    $SUDO ln -sf "$NGINX_AVAILABLE" "$NGINX_ENABLED"
    $SUDO rm -f "$NGINX_CONF_D"
  else
    $SUDO rm -f "$NGINX_AVAILABLE" "$NGINX_ENABLED"
  fi
}

remove_conflicting_nginx_configs() {
  [ -n "$NGINX_SITE" ] || select_nginx_site_path

  # Remove duplicate server blocks for this exact hostname. A stale block can
  # win SNI matching or keep nginx from loading our managed per-domain 443
  # block, which makes nginx serve another domain's certificate.
  local files f
  files="$($SUDO grep -RlF "$DOMAIN" /etc/nginx/sites-enabled /etc/nginx/sites-available /etc/nginx/conf.d 2>/dev/null | sort -u || true)"
  if [ -n "$files" ]; then
    for f in $files; do
      $SUDO grep -qE 'server_name[[:space:]]' "$f" 2>/dev/null || continue
      $SUDO grep -qF "$DOMAIN" "$f" 2>/dev/null || continue
      same_nginx_file "$f" "$NGINX_SITE" && continue
      [ "$NGINX_SITE" = "$NGINX_AVAILABLE" ] && same_nginx_file "$f" "$NGINX_ENABLED" && continue
      warn "Removing duplicate nginx server_name for ${DOMAIN}: $f"
      $SUDO rm -f "$f"
    done
  fi

  # Certbot can leave domain-specific -le-ssl files behind; keep the active
  # managed file as the single source of truth for this hostname.
  $SUDO rm -f "/etc/nginx/sites-enabled/${DOMAIN}-le-ssl.conf" \
    "/etc/nginx/sites-available/${DOMAIN}-le-ssl.conf" \
    "/etc/nginx/conf.d/${DOMAIN}-le-ssl.conf"
}

show_tls_diagnostics() {
  warn "TLS certificate served for ${DOMAIN} does not match; showing nginx diagnostics"
  echo "--- nginx files mentioning ${DOMAIN} ---"
  $SUDO grep -RlnF "$DOMAIN" /etc/nginx/sites-enabled /etc/nginx/sites-available /etc/nginx/conf.d 2>/dev/null || true
  echo "--- active nginx 443/server_name/ssl_certificate lines ---"
  nginx_dump | grep -nE 'listen .*443|server_name|ssl_certificate' | tail -240 || true
  echo "--- nginx logs ---"
  $SUDO journalctl -u nginx -n 80 --no-pager 2>/dev/null || true
}

verify_served_tls_san() {
  is_https_public_url || return 0
  command -v openssl >/dev/null 2>&1 || {
    warn "openssl missing; cannot verify served TLS SAN for ${DOMAIN}"
    return 0
  }

  log "Verifying served TLS certificate SAN for ${DOMAIN}"
  local served_cert cert_info check_output openssl_log
  openssl_log="/tmp/${DOMAIN}.openssl-s_client.log"
  served_cert="$(printf '' | openssl s_client -connect "${DOMAIN}:443" -servername "$DOMAIN" -showcerts 2>"$openssl_log" | openssl x509 -outform PEM 2>>"$openssl_log" || true)"

  if [ -z "$served_cert" ]; then
    cat "$openssl_log" 2>/dev/null || true
    show_tls_diagnostics
    fail "Could not read served TLS certificate for ${DOMAIN}."
  fi

  cert_info="$(printf '%s\n' "$served_cert" | openssl x509 -noout -subject -issuer -ext subjectAltName 2>&1 || true)"
  printf '%s\n' "$cert_info"

  check_output="$(printf '%s\n' "$served_cert" | openssl x509 -noout -checkhost "$DOMAIN" 2>&1 || true)"
  printf '%s\n' "$check_output"
  if ! printf '%s\n' "$check_output" | grep -qi 'does match'; then
    cat "$openssl_log" 2>/dev/null || true
    show_tls_diagnostics
    fail "Served TLS certificate SAN does not match ${DOMAIN}. Fix duplicate/default 443 nginx blocks above, then re-run."
  fi

  ok "served TLS certificate SAN matches ${DOMAIN}"
}

write_nginx_http_site() {
  [ -n "$NGINX_SITE" ] || select_nginx_site_path
  $SUDO mkdir -p /var/www/certbot
  $SUDO tee "$NGINX_SITE" >/dev/null <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    root ${APP_DIR}/.output/public;
    location ^~ /assets/ {
        try_files \$uri =404;
        access_log off;
        expires 1y;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
    }

    location / {
        proxy_pass         http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_set_header   Upgrade           \$http_upgrade;
        proxy_set_header   Connection        \$http_connection;
    }
}
EOF
  install_nginx_site_link
}

ensure_tls_certificate() {
  tls_cert_matches_domain && return 0

  command -v certbot >/dev/null 2>&1 || {
    fail "Valid TLS certificate missing for ${DOMAIN}. Install certbot, then re-run this script; Chrome HSTS will not allow HTTPS with the current certificate."
  }

  warn "Valid TLS certificate missing for ${DOMAIN}; requesting Let's Encrypt certificate"
  write_nginx_http_site
  $SUDO ln -sf "$NGINX_AVAILABLE" "$NGINX_ENABLED"
  $SUDO nginx -t
  $SUDO systemctl reload nginx 2>/dev/null || $SUDO systemctl restart nginx

  $SUDO certbot certonly \
    --webroot -w /var/www/certbot \
    -d "$DOMAIN" \
    --cert-name "$DOMAIN" \
    --agree-tos --non-interactive --register-unsafely-without-email \
    --force-renewal || fail "Could not issue TLS certificate for ${DOMAIN}. Check DNS A record and port 80 access, then re-run."

  tls_cert_matches_domain || fail "Issued certificate does not match ${DOMAIN}. Check nginx/certbot certificate paths."
}

write_systemd_unit() {
  log "Installing systemd service: ${SERVICE}"
  $SUDO tee "$SYSTEMD_UNIT" >/dev/null <<EOF
[Unit]
Description=Pluto Dashboard (TanStack Start)
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
EnvironmentFile=-${APP_DIR}/.env
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=NITRO_HOST=127.0.0.1
Environment=PORT=${PORT}
Environment=NITRO_PORT=${PORT}
ExecStart=${NODE_BIN} ${APP_DIR}/.output/server/index.mjs
Restart=always
RestartSec=3
KillSignal=SIGINT
SyslogIdentifier=${SERVICE}

[Install]
WantedBy=multi-user.target
EOF
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable "$SERVICE" >/dev/null
  ok "systemd service installed"
}

write_nginx_site() {
  log "Installing nginx reverse proxy for ${DOMAIN}"
  local cert="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
  local key="/etc/letsencrypt/live/${DOMAIN}/privkey.pem"

  select_nginx_site_path

  # Remove duplicate .conf variants; duplicate server blocks were serving stale static roots.
  $SUDO rm -f \
    "/etc/nginx/sites-enabled/${DOMAIN}.conf" \
    "/etc/nginx/sites-available/${DOMAIN}.conf"

  remove_conflicting_nginx_configs

  if is_https_public_url; then
    ensure_tls_certificate

    $SUDO tee "$NGINX_SITE" >/dev/null <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name ${DOMAIN};

    ssl_certificate     ${cert};
    ssl_certificate_key ${key};
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;
    ssl_stapling off;
    ssl_stapling_verify off;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    client_max_body_size 100M;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;

    # Static build assets are real files. Missing assets must return 404,
    # never index HTML; otherwise browsers reject CSS/JS with MIME errors.
    root ${APP_DIR}/.output/public;
    location ^~ /assets/ {
        try_files \$uri =404;
        access_log off;
        expires 1y;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
    }

    location / {
        proxy_pass         http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_set_header   Upgrade           \$http_upgrade;
        proxy_set_header   Connection        \$http_connection;
    }
}
EOF
  else
    warn "PUBLIC_URL is not HTTPS; installing HTTP proxy only."
    write_nginx_http_site
  fi

  install_nginx_site_link
  ok "nginx site installed"
}

wait_for_http() {
  local url="$1" label="$2" code="000"
  for i in $(seq 1 30); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "$url" || echo 000)"
    if [ "$code" = "200" ] || [ "$code" = "302" ] || [ "$code" = "401" ]; then
      ok "${label} responding (HTTP ${code}) after ${i}s"
      return 0
    fi
    sleep 1
  done
  warn "${label} did not become ready (last HTTP ${code})"
  return 1
}

# ---------- 0. Sanity ----------
[ -d "$APP_DIR" ] || fail "$APP_DIR not found"
cd "$APP_DIR"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "$APP_DIR is not a git repository"
[ -n "$DOMAIN" ] || fail "Could not derive DOMAIN from PUBLIC_URL=${PUBLIC_URL}"
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || fail "node executable not found; install Node.js or set NODE_BIN=/path/to/node"

command -v curl >/dev/null || fail "curl missing"
command -v nginx >/dev/null || fail "nginx missing"
command -v systemctl >/dev/null || fail "systemctl missing"

if [ ! -x "$BUN_BIN" ]; then
  warn "bun not found at $BUN_BIN — installing"
  curl -fsSL https://bun.sh/install | bash
  export PATH="/root/.bun/bin:$PATH"
  BUN_BIN="/root/.bun/bin/bun"
fi

# ---------- 1. Pull latest/full tree ----------
log "Pulling FULL latest project from GitHub"
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git fetch --all --tags --prune

# VPS-এ হাতে edit করা tracked files build-কে stale করে রাখলে এগুলো stash হবে।
if ! git diff --quiet || ! git diff --cached --quiet; then
  warn "Local tracked changes found — stashing before reset"
  git stash push -u -m "vps-frontend-auto-stash-$(date +%Y%m%d-%H%M%S)" || true
fi

git reset --hard "origin/${CURRENT_BRANCH}"
# untracked stale source files remove, কিন্তু env/runtime files safe রাখে
git clean -fd \
  -e .env -e .env.local -e .env.production \
  -e pluto-backend/.env -e backend/.env \
  -e uploads -e storage || true

NEW_SHA="$(git rev-parse --short HEAD)"
ok "Repo fully synced: ${CURRENT_BRANCH} @ ${NEW_SHA}"

# ---------- 1.1 Critical dashboard files ----------
log "Verifying Auth & Users dashboard files"
[ -f src/routes/dashboard.users.tsx ] || fail "src/routes/dashboard.users.tsx missing — GitHub branch does not contain Auth & Users page"
[ -f src/components/pluto/Sidebar.tsx ] || fail "src/components/pluto/Sidebar.tsx missing"
grep -q 'Auth & Users' src/routes/dashboard.users.tsx || fail "Auth & Users page content is not present in pulled code"
grep -q '/dashboard/users' src/components/pluto/Sidebar.tsx || fail "Sidebar route /dashboard/users is not present"
ok "Auth & Users files are present in this checkout"

# ---------- 2. Install deps ----------
log "Installing dependencies (bun install)"
"$BUN_BIN" install --frozen-lockfile || "$BUN_BIN" install
ok "Dependencies installed"

# ---------- 3. Build ----------
log "Building TanStack Start production bundle for Node server"
rm -rf .output .vinxi .tanstack node_modules/.nitro 2>/dev/null || true
export NITRO_PRESET="${NITRO_PRESET:-node-server}"
"$BUN_BIN" run build
[ -f ".output/server/index.mjs" ] || fail "Build output missing (.output/server/index.mjs)"
[ -d ".output/public/assets" ] || fail "Build output missing (.output/public/assets)"
if [ -f ".output/server/wrangler.json" ]; then
  fail "Build used the Cloudflare target. Re-run with NITRO_PRESET=node-server."
fi
ok "Build complete (${NITRO_PRESET})"

# ---------- 3.1 Install runtime config ----------
write_systemd_unit
write_nginx_site

# ---------- 4. Free port 3001 ----------
log "Ensuring port $PORT is free"
$SUDO systemctl stop "$SERVICE" 2>/dev/null || true
if ss -tlnp 2>/dev/null | grep -q ":$PORT "; then
  warn "Port $PORT is in use — killing occupant(s)"
  fuser -k "${PORT}/tcp" 2>/dev/null || true
  pkill -9 -f "bun run .output/server" 2>/dev/null || true
  pkill -9 -f "node .output/server"    2>/dev/null || true
  sleep 2
fi
if ss -tlnp 2>/dev/null | grep -q ":$PORT "; then
  echo "❌ Port $PORT still in use:"; ss -tlnp | grep ":$PORT "; exit 1
fi
ok "Port $PORT is free"

# ---------- 5. Restart systemd service ----------
log "Restarting $SERVICE"
$SUDO systemctl daemon-reload
$SUDO systemctl restart "$SERVICE"
sleep 3
$SUDO systemctl is-active --quiet "$SERVICE" || {
  echo "❌ $SERVICE failed to start. Logs:"
  $SUDO journalctl -u "$SERVICE" -n 80 --no-pager
  exit 1
}
ok "$SERVICE is active"

# ---------- 6. Reload nginx ----------
log "Testing & reloading nginx"
$SUDO nginx -t
$SUDO systemctl reload nginx
ok "nginx reloaded"
verify_served_tls_san

# ---------- 7. Smoke test ----------
log "Smoke test"
wait_for_http "http://127.0.0.1:${PORT}/" "local dashboard" || {
  $SUDO journalctl -u "$SERVICE" -n 80 --no-pager
  fail "local dashboard is not responding"
}

curl -fsS -o /dev/null -w "  users  :${PORT}  → HTTP %{http_code}\n" "http://127.0.0.1:${PORT}/dashboard/users" || warn "local /dashboard/users check failed"
curl -fsS -o /dev/null -w "  public :443    → HTTP %{http_code}\n" "$PUBLIC_BASE/" || warn "public check failed"

CSS_FILE="$(ls .output/public/assets/*.css 2>/dev/null | head -1 || true)"
if [ -n "$CSS_FILE" ]; then
  CSS_PATH="/assets/$(basename "$CSS_FILE")"
  CSS_HEADERS="$(curl -sSI "$PUBLIC_BASE$CSS_PATH" || true)"
  echo "  asset  :css   → $(printf '%s\n' "$CSS_HEADERS" | awk 'BEGIN{ORS=" "} /^HTTP\//{print $2} /^content-type:/ {print $0}' | sed 's/[[:space:]]*$//')"
  if ! printf '%s\n' "$CSS_HEADERS" | grep -qiE '^content-type: *text/css'; then
    fail "CSS asset is not served as text/css. Check nginx config for ${DOMAIN}."
  fi
fi

echo
ok "🚀 Deploy complete — ${PUBLIC_URL}  (${NEW_SHA})"
echo "   Tail logs:  journalctl -u $SERVICE -f"

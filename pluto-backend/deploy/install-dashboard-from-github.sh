#!/usr/bin/env bash
# One-shot: pull the Pluto BaaS dashboard from GitHub, build it, and wire
# DOMAIN (default dashboard.timescard.cloud) to serve it as the primary frontend.
#
# This repo is a TanStack Start app that builds with Nitro. Two layouts are
# possible after `bun run build` / `npm run build`:
#
#   A) SSR Node server preset (default in this project):
#        .output/server/index.mjs  +  .output/public/{_build,assets,...}
#      → run the server as a systemd unit on 127.0.0.1:$PORT and let nginx
#        proxy_pass to it. Static assets under /_build/, /assets/, /favicon.ico
#        are aliased straight to .output/public for cache-friendliness.
#
#   B) Pure SPA build:
#        dist/index.html + dist/assets/*
#      → serve dist/ as a static site with SPA fallback to index.html.
#
# The script auto-detects which layout the build produced and configures nginx
# accordingly. Re-running is safe (idempotent).
#
# Usage (on the VPS, as root):
#   REPO_URL=https://github.com/<you>/<repo>.git \
#   sudo bash install-dashboard-from-github.sh
#
# Env (all optional except REPO_URL on first run):
#   REPO_URL   Git URL of the dashboard repo. Required if APP_DIR is empty.
#   BRANCH     Git branch (default: main)
#   APP_DIR    Clone / update dir (default: /root/backend-joy)
#   DOMAIN     Public hostname (default: dashboard.timescard.cloud)
#   PORT       Local port for the SSR node server (default: 8790)
#   NODE_BIN   Path to node (auto-detected)
#   SERVICE    systemd unit name for SSR mode (default: pluto-dashboard)

set -euo pipefail

REPO_URL="${REPO_URL:-}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/root/backend-joy}"
DOMAIN="${DOMAIN:-dashboard.timescard.cloud}"
PORT="${PORT:-8790}"
SERVICE="${SERVICE:-pluto-dashboard}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

log()  { printf '\033[1;36m[%s]\033[0m %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
die()  { printf '\033[1;31m[FAIL]\033[0m %s\n' "$*" >&2; exit 1; }
ok()   { printf '\033[1;32m[OK]\033[0m %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"

# ---------- 1. clone / pull -------------------------------------------------
if [ ! -d "$APP_DIR/.git" ]; then
  [ -n "$REPO_URL" ] || die "APP_DIR $APP_DIR is not a git checkout and REPO_URL is not set"
  log "Cloning $REPO_URL → $APP_DIR (branch $BRANCH)"
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$APP_DIR"
else
  log "Updating $APP_DIR (branch $BRANCH)"
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
fi

# ---------- 2. install deps + build ----------------------------------------
cd "$APP_DIR"

if command -v bun >/dev/null 2>&1; then
  log "bun install"
  bun install --no-progress
  log "bun run build"
  bun run build
else
  # Prefer `npm ci` when a lockfile exists, otherwise fall back to `npm install`.
  # `npm ci` hard-fails without a lockfile which broke earlier runs.
  if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then
    log "npm ci"
    npm ci --no-audit --no-fund
  else
    log "no lockfile — running npm install (bun not available)"
    npm install --no-audit --no-fund
  fi
  log "npm run build"
  npm run build
fi

# ---------- 3. detect build layout ------------------------------------------
MODE=""
SSR_ENTRY=""
PUBLIC_DIR=""
DIST_DIR=""

if [ -f "$APP_DIR/.output/server/index.mjs" ]; then
  MODE="ssr"
  SSR_ENTRY="$APP_DIR/.output/server/index.mjs"
  PUBLIC_DIR="$APP_DIR/.output/public"
  ok "Detected SSR build → $SSR_ENTRY (public: $PUBLIC_DIR)"
elif [ -f "$APP_DIR/dist/index.html" ] && [ -d "$APP_DIR/dist/assets" ]; then
  MODE="spa"
  DIST_DIR="$APP_DIR/dist"
  ok "Detected SPA build → $DIST_DIR"
else
  # Give the user actionable info instead of a generic failure.
  ls -la "$APP_DIR/.output" 2>/dev/null || true
  ls -la "$APP_DIR/dist" 2>/dev/null || true
  die "Build produced neither .output/server/index.mjs (SSR) nor dist/index.html (SPA). Check the build output above."
fi

# Permissions so nginx (www-data) can read everything and traverse into it.
for d in "$PUBLIC_DIR" "$DIST_DIR"; do
  [ -n "$d" ] && [ -d "$d" ] || continue
  chown -R root:www-data "$d" 2>/dev/null || true
  find "$d" -type d -exec chmod 755 {} +
  find "$d" -type f -exec chmod 644 {} +
done
p="$APP_DIR"
while [ "$p" != "/" ]; do chmod o+x "$p" 2>/dev/null || true; p="$(dirname "$p")"; done

# ---------- 4. SSR mode: systemd unit --------------------------------------
if [ "$MODE" = "ssr" ]; then
  [ -n "$NODE_BIN" ] || die "node not found on PATH — install Node.js 20+ and re-run (or set NODE_BIN=/path/to/node)"
  log "Writing systemd unit /etc/systemd/system/${SERVICE}.service (node $NODE_BIN, port $PORT)"
  cat > "/etc/systemd/system/${SERVICE}.service" <<EOF
[Unit]
Description=Pluto Dashboard (TanStack Start SSR)
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=${PORT}
Environment=NITRO_PORT=${PORT}
Environment=NITRO_HOST=127.0.0.1
ExecStart=${NODE_BIN} ${SSR_ENTRY}
Restart=on-failure
RestartSec=2
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "${SERVICE}.service" >/dev/null 2>&1 || true
  systemctl restart "${SERVICE}.service"

  # Wait for it to bind the port.
  for i in $(seq 1 30); do
    if ss -ltn "sport = :${PORT}" 2>/dev/null | grep -q ":${PORT}"; then break; fi
    sleep 0.5
  done
  if ! ss -ltn "sport = :${PORT}" 2>/dev/null | grep -q ":${PORT}"; then
    journalctl -u "${SERVICE}.service" -n 40 --no-pager || true
    die "${SERVICE} did not start listening on 127.0.0.1:${PORT}"
  fi
  ok "${SERVICE} listening on 127.0.0.1:${PORT}"
fi

# ---------- 5. write nginx vhost -------------------------------------------
CONF="/etc/nginx/sites-available/${DOMAIN}.conf"
CERT_DIR="/etc/letsencrypt/live/${DOMAIN}"
HAS_TLS=0
[ -f "$CERT_DIR/fullchain.pem" ] && [ -f "$CERT_DIR/privkey.pem" ] && HAS_TLS=1

log "Writing vhost → $CONF (mode=$MODE, tls=$([ $HAS_TLS -eq 1 ] && echo yes || echo no))"
mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled

if [ "$MODE" = "ssr" ]; then
  read -r -d '' SERVER_BODY <<EOF || true
    add_header X-Pluto-Primary "${DOMAIN}" always;

    # Static assets straight from disk for cache-friendliness. Any path missing
    # here falls through to the SSR proxy below.
    root ${PUBLIC_DIR};
    disable_symlinks off;

    location ^~ /_build/ {
        alias ${PUBLIC_DIR}/_build/;
        access_log off;
        expires 30d;
        add_header Cache-Control "public, immutable";
        try_files \$uri =404;
    }
    location ^~ /assets/ {
        alias ${PUBLIC_DIR}/assets/;
        access_log off;
        expires 30d;
        add_header Cache-Control "public, immutable";
        try_files \$uri =404;
    }
    location = /favicon.ico { try_files \$uri =404; access_log off; log_not_found off; }
    location = /robots.txt  { try_files \$uri =404; access_log off; log_not_found off; }

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 60s;
    }
EOF
else
  read -r -d '' SERVER_BODY <<EOF || true
    add_header X-Pluto-Primary "${DOMAIN}" always;
    root ${DIST_DIR};
    index index.html;
    disable_symlinks off;

    location ^~ /assets/ {
        alias ${DIST_DIR}/assets/;
        access_log off;
        expires 30d;
        add_header Cache-Control "public, immutable";
        try_files \$uri =404;
    }
    location / { try_files \$uri \$uri/ /index.html; }
EOF
fi

{
  if [ "$HAS_TLS" -eq 1 ]; then
    cat <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://\$host\$request_uri; }
}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name ${DOMAIN};

    ssl_certificate     ${CERT_DIR}/fullchain.pem;
    ssl_certificate_key ${CERT_DIR}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

${SERVER_BODY}
}
EOF
  else
    cat <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

${SERVER_BODY}
}
EOF
  fi
} > "$CONF"

ln -sf "$CONF" "/etc/nginx/sites-enabled/${DOMAIN}.conf"

# ---------- 6. remove duplicate server_name entries elsewhere --------------
KEEP_REAL="$(readlink -f "$CONF")"
log "Scanning nginx configs for duplicate server_name ${DOMAIN} ..."
mapfile -t HITS < <(grep -RrlE "server_name[[:space:]]+[^;]*\b${DOMAIN}\b" /etc/nginx 2>/dev/null | grep -v '\.bak\.' || true)

while IFS= read -r link; do
  [ -n "$link" ] || continue
  link_real="$(readlink -f "$link" 2>/dev/null || true)"
  if [ -L "$link" ] && [ "$link_real" != "$KEEP_REAL" ] && [ "$(basename "$link")" != "${DOMAIN}.conf" ]; then
    if grep -qE "server_name[[:space:]]+[^;]*\b${DOMAIN}\b" "$link_real" 2>/dev/null; then
      log "  removing stray symlink: $link -> $link_real"
      rm -f "$link"
    fi
  fi
done < <(find /etc/nginx/sites-enabled -maxdepth 1 -type l 2>/dev/null)

for f in "${HITS[@]:-}"; do
  [ -n "$f" ] || continue
  f_real="$(readlink -f "$f" 2>/dev/null || printf '%s' "$f")"
  [ "$f_real" = "$KEEP_REAL" ] && continue
  log "  cleaning duplicate: $f"
  cp -a "$f" "${f}.bak.$(date -u +%Y%m%dT%H%M%SZ)"
  python3 - "$f" "$DOMAIN" <<'PY'
import re, sys, pathlib
p, dom = sys.argv[1], sys.argv[2]
t = pathlib.Path(p).read_text()
def strip(m):
    names = [n for n in m.group(1).split() if n != dom]
    return 'server_name ' + ' '.join(names) + ';' if names else '# server_name (removed duplicate ' + dom + ');'
pathlib.Path(p).write_text(re.sub(r'server_name\s+([^;]+);', strip, t))
PY
done

# ---------- 7. reload + verify ---------------------------------------------
log "nginx -t && reload"
nginx -t
systemctl reload nginx

sleep 1
SCHEME="https"; [ "$HAS_TLS" -eq 0 ] && SCHEME="http"

# Probe an asset if we can identify one.
FIRST_ASSET=""
if [ "$MODE" = "ssr" ] && [ -d "$PUBLIC_DIR/_build/assets" ]; then
  FIRST_ASSET="_build/assets/$(ls "$PUBLIC_DIR/_build/assets" 2>/dev/null | head -1)"
elif [ "$MODE" = "ssr" ] && [ -d "$PUBLIC_DIR/assets" ]; then
  FIRST_ASSET="assets/$(ls "$PUBLIC_DIR/assets" 2>/dev/null | head -1)"
elif [ "$MODE" = "spa" ] && [ -d "$DIST_DIR/assets" ]; then
  FIRST_ASSET="assets/$(ls "$DIST_DIR/assets" 2>/dev/null | head -1)"
fi
if [ -n "$FIRST_ASSET" ]; then
  code=$(curl -sk -o /dev/null -w "%{http_code}" "${SCHEME}://${DOMAIN}/${FIRST_ASSET}")
  [ "$code" = "200" ] || die "Asset probe failed: /${FIRST_ASSET} → HTTP $code"
  ok "Asset OK: /${FIRST_ASSET} → 200"
fi

root_code=$(curl -sk -o /dev/null -w "%{http_code}" "${SCHEME}://${DOMAIN}/")
[ "$root_code" = "200" ] || die "Root probe failed: / → HTTP $root_code"

primary=$(curl -skI "${SCHEME}://${DOMAIN}/" | tr -d '\r' | awk 'tolower($1)=="x-pluto-primary:"{print $2; exit}')
[ "$primary" = "${DOMAIN}" ] || log "warn: X-Pluto-Primary=${primary:-<missing>} (expected ${DOMAIN})"

title=$(curl -skL --compressed "${SCHEME}://${DOMAIN}/" \
  | python3 -c 'import re,sys; s=sys.stdin.buffer.read().decode("utf-8","ignore"); m=re.search(r"<title>(.*?)</title>",s,re.I|re.S); print((m.group(1).strip() if m else "")[:120])')
ok "Root OK: / → 200, title: ${title:-<no title>}"

cat <<EOF

✅ Dashboard deployed from GitHub.

   Repo    : $(git -C "$APP_DIR" config --get remote.origin.url)
   Branch  : ${BRANCH}
   Commit  : $(git -C "$APP_DIR" rev-parse --short HEAD)
   Mode    : ${MODE}
$( [ "$MODE" = "ssr" ] && echo "   Service : ${SERVICE}.service (127.0.0.1:${PORT})" )
$( [ "$MODE" = "ssr" ] && echo "   Public  : ${PUBLIC_DIR}" )
$( [ "$MODE" = "spa" ] && echo "   Build   : ${DIST_DIR}" )
   URL     : ${SCHEME}://${DOMAIN}/

Re-run this same command anytime to pull the latest code and redeploy.
EOF

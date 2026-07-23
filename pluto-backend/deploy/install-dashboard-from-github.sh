#!/usr/bin/env bash
# One-shot: pull the Pluto BaaS dashboard from GitHub, build it, and wire
# dashboard.timescard.cloud to serve it as the primary frontend.
#
# Usage (on the VPS, as root):
#   REPO_URL=https://github.com/<you>/<repo>.git \
#   sudo bash install-dashboard-from-github.sh
#
# Env vars (all optional except REPO_URL on first run):
#   REPO_URL   Git URL of the dashboard repo. Required if APP_DIR doesn't exist.
#   BRANCH     Git branch (default: main)
#   APP_DIR    Where to clone / update the repo (default: /root/backend-joy)
#   DOMAIN     Public hostname (default: dashboard.timescard.cloud)
#   ENTRY      Path opened by "/" (default: /  — dashboard IS the app root now)
#
# What it does, in order:
#   1. git clone or fast-forward pull the repo
#   2. install deps (bun preferred, npm fallback) and run `vite build`
#      → produces ./dist  (TanStack Start + Vite SPA build)
#   3. write a clean, single nginx vhost that serves ./dist as the site root,
#      SPA-fallbacks to index.html, and aliases /assets/ with long cache
#   4. remove any other nginx server blocks claiming the same DOMAIN
#   5. nginx -t && reload, then verify HTTP 200 + real dashboard title
set -euo pipefail

REPO_URL="${REPO_URL:-}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/root/backend-joy}"
DOMAIN="${DOMAIN:-dashboard.timescard.cloud}"
ENTRY="${ENTRY:-/}"

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

# ---------- 2. install + build ---------------------------------------------
cd "$APP_DIR"
if command -v bun >/dev/null 2>&1; then
  log "bun install"
  bun install --no-progress
  log "bun run build"
  bun run build
else
  log "npm ci (bun not installed)"
  npm ci --no-audit --no-fund
  log "npm run build"
  npm run build
fi

BUILD_DIR="$APP_DIR/dist"
[ -f "$BUILD_DIR/index.html" ] || die "Build did not produce $BUILD_DIR/index.html"
[ -d "$BUILD_DIR/assets" ]     || die "Build did not produce $BUILD_DIR/assets/"

ok "Built $(ls "$BUILD_DIR/assets" | wc -l) asset files at $BUILD_DIR"

# Permissions: nginx (www-data) must be able to read the tree end-to-end.
chown -R root:www-data "$BUILD_DIR" 2>/dev/null || true
find "$BUILD_DIR" -type d -exec chmod 755 {} +
find "$BUILD_DIR" -type f -exec chmod 644 {} +
# And every parent dir up to /, so www-data can traverse into $BUILD_DIR.
p="$BUILD_DIR"
while [ "$p" != "/" ]; do chmod o+x "$p" 2>/dev/null || true; p="$(dirname "$p")"; done

# ---------- 3. write clean nginx vhost -------------------------------------
CONF="/etc/nginx/sites-available/${DOMAIN}.conf"
CERT_DIR="/etc/letsencrypt/live/${DOMAIN}"
HAS_TLS=0
[ -f "$CERT_DIR/fullchain.pem" ] && [ -f "$CERT_DIR/privkey.pem" ] && HAS_TLS=1

log "Writing vhost → $CONF (TLS: $([ $HAS_TLS -eq 1 ] && echo yes || echo no))"
mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled

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
    add_header X-Pluto-Primary "${DOMAIN}" always;

    root ${BUILD_DIR};
    index index.html;
    disable_symlinks off;

    location ^~ /assets/ {
        alias ${BUILD_DIR}/assets/;
        access_log off;
        expires 30d;
        add_header Cache-Control "public, immutable";
        try_files \$uri =404;
    }

    # SPA fallback: any unknown path renders index.html.
    location / {
        try_files \$uri \$uri/ /index.html;
    }
}
EOF
  else
    cat <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    add_header X-Pluto-Primary "${DOMAIN}" always;
    root ${BUILD_DIR};
    index index.html;
    disable_symlinks off;

    location ^~ /assets/ {
        alias ${BUILD_DIR}/assets/;
        access_log off;
        expires 30d;
        add_header Cache-Control "public, immutable";
        try_files \$uri =404;
    }
    location / { try_files \$uri \$uri/ /index.html; }
}
EOF
  fi
} > "$CONF"

ln -sf "$CONF" "/etc/nginx/sites-enabled/${DOMAIN}.conf"

# ---------- 4. remove duplicate server_name entries elsewhere --------------
KEEP_REAL="$(readlink -f "$CONF")"
log "Scanning nginx configs for duplicate server_name ${DOMAIN} ..."
mapfile -t HITS < <(grep -RrlE "server_name[[:space:]]+[^;]*\b${DOMAIN}\b" /etc/nginx 2>/dev/null | grep -v '\.bak\.' || true)

# Strip stray sites-enabled symlinks that don't point at the canonical file.
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

# Strip DOMAIN out of non-canonical config files.
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

# ---------- 5. reload + verify ---------------------------------------------
log "nginx -t && reload"
nginx -t
systemctl reload nginx

sleep 1
SCHEME="https"; [ "$HAS_TLS" -eq 0 ] && SCHEME="http"
FIRST_ASSET="$(ls "$BUILD_DIR/assets" | head -1)"

code=$(curl -sk -o /dev/null -w "%{http_code}" "${SCHEME}://${DOMAIN}/assets/${FIRST_ASSET}")
[ "$code" = "200" ] || die "Asset probe failed: /assets/${FIRST_ASSET} → HTTP $code"
ok "Asset OK: /assets/${FIRST_ASSET} → 200"

root_code=$(curl -sk -o /dev/null -w "%{http_code}" "${SCHEME}://${DOMAIN}/")
[ "$root_code" = "200" ] || die "Root probe failed: / → HTTP $root_code"

primary=$(curl -skI "${SCHEME}://${DOMAIN}/" | tr -d '\r' | awk 'tolower($1)=="x-pluto-primary:"{print $2; exit}')
[ "$primary" = "${DOMAIN}" ] || log "warn: X-Pluto-Primary=${primary:-<missing>} (expected ${DOMAIN})"

title=$(curl -skL --compressed "${SCHEME}://${DOMAIN}/" \
  | python3 -c 'import re,sys; s=sys.stdin.buffer.read().decode("utf-8","ignore"); m=re.search(r"<title>(.*?)</title>",s,re.I|re.S); print((m.group(1).strip() if m else "")[:120])')
ok "Root OK: / → 200, title: ${title:-<no title>}"

cat <<EOF

✅ Dashboard deployed from GitHub.

   Repo   : $(git -C "$APP_DIR" config --get remote.origin.url)
   Branch : ${BRANCH}
   Commit : $(git -C "$APP_DIR" rev-parse --short HEAD)
   Build  : ${BUILD_DIR}
   URL    : ${SCHEME}://${DOMAIN}/

Re-run this same command anytime to pull the latest code and redeploy.
EOF

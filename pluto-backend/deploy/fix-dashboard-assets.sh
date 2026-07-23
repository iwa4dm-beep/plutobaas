#!/usr/bin/env bash
# Fix dashboard.timescard.cloud 404s on /assets/* (and other static files) by
# pointing nginx's *root* AND /assets/ alias to the freshly built
# .output/public folder (Nitro node-server preset). The prior version only
# rewrote /assets/, leaving `root` pointing at a stale directory — hashed
# JS/CSS still 404'd because SSR HTML referenced new hashes not present at
# the old root. This script fixes the root itself, which is the real bug.
set -euo pipefail

DOMAIN="${DOMAIN:-dashboard.timescard.cloud}"

# Auto-detect BUILD_DIR: prefer .output/public (Nitro), fall back to dist.
detect_build_dir() {
  local candidates=(
    "${BUILD_DIR:-}"
    "/root/backend-joy/.output/public"
    "/root/pluto-baas/.output/public"
    "/root/dashboard/.output/public"
    "/root/backend-joy/dist"
    "/root/pluto-baas/dist"
  )
  for d in "${candidates[@]}"; do
    [ -n "$d" ] && [ -d "$d/assets" ] && { echo "$d"; return; }
  done
  return 1
}

BUILD_DIR="$(detect_build_dir)" || {
  echo "[FAIL] Could not locate a built dashboard with an assets/ folder." >&2
  echo "       Set BUILD_DIR=/path/to/.output/public and re-run." >&2
  exit 1
}

NGINX_AVAILABLE="/etc/nginx/sites-available"
NGINX_ENABLED="/etc/nginx/sites-enabled"

log() { printf '\033[1;36m[%s]\033[0m %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
die() { printf '\033[1;31m[FAIL]\033[0m %s\n' "$*" >&2; exit 1; }

log "Using BUILD_DIR: $BUILD_DIR ($(ls "$BUILD_DIR/assets" | wc -l) asset files)"

# Fix ownership/perms so nginx (www-data) can read it.
chown -R root:www-data "$BUILD_DIR" 2>/dev/null || true
find "$BUILD_DIR" -type d -exec chmod 755 {} + 2>/dev/null || true
find "$BUILD_DIR" -type f -exec chmod 644 {} + 2>/dev/null || true

# Find the nginx vhost file for this domain. Search sites-available first, then
# every nginx include path (conf.d, sites-enabled, /etc/nginx itself). If we
# still can't find one, create a fresh vhost so the domain can be served.
find_vhost() {
  local paths=(
    /etc/nginx/sites-available
    /etc/nginx/sites-enabled
    /etc/nginx/conf.d
    /etc/nginx
  )
  for p in "${paths[@]}"; do
    [ -d "$p" ] || continue
    local hit
    hit="$(grep -rlE "server_name[[:space:]]+[^;]*\b${DOMAIN}\b" "$p" 2>/dev/null | grep -v '\.bak\.' | head -1 || true)"
    [ -n "$hit" ] && { echo "$hit"; return; }
  done
  return 1
}

CONF="$(find_vhost || true)"

if [ -z "$CONF" ]; then
  log "No existing vhost for $DOMAIN — creating a new one."
  mkdir -p "$NGINX_AVAILABLE" "$NGINX_ENABLED"
  CONF="$NGINX_AVAILABLE/${DOMAIN}.conf"
  CERT="/etc/letsencrypt/live/${DOMAIN}"
  if [ -f "$CERT/fullchain.pem" ] && [ -f "$CERT/privkey.pem" ]; then
    cat > "$CONF" <<EOF
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
    ssl_certificate     ${CERT}/fullchain.pem;
    ssl_certificate_key ${CERT}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    root ${BUILD_DIR};
    index index.html;
    location / { try_files \$uri \$uri/ /index.html; }
}
EOF
  else
    log "No TLS cert at ${CERT} — creating HTTP-only vhost. Run certbot afterwards: certbot --nginx -d ${DOMAIN}"
    cat > "$CONF" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    root ${BUILD_DIR};
    index index.html;
    location / { try_files \$uri \$uri/ /index.html; }
}
EOF
  fi
fi

log "Vhost: $CONF"
ln -sf "$CONF" "$NGINX_ENABLED/$(basename "$CONF")"


cp -a "$CONF" "${CONF}.bak.$(date -u +%Y%m%dT%H%M%SZ)"

# Patch: set correct `root`, drop stale /assets/ blocks, add fresh alias.
python3 - "$CONF" "$BUILD_DIR" <<'PY'
import re, sys, pathlib
conf_path, build_dir = sys.argv[1], sys.argv[2]
src = pathlib.Path(conf_path).read_text()

# 1. Remove any prior /assets/ location blocks (both alias and root variants).
src = re.sub(r'\n\s*location\s+\^?~?\s*/assets/\s*\{[^}]*\}\s*', '\n', src)

# 2. Replace any existing top-level `root ...;` inside the 443 server block
#    with the correct build_dir. Also insert if missing.
def fix_server(m):
    body = m.group(0)
    if 'listen' not in body or '443' not in body:
        return body
    if re.search(r'^\s*root\s+[^;]+;', body, re.M):
        body = re.sub(r'^\s*root\s+[^;]+;', f'    root {build_dir};', body, count=1, flags=re.M)
    else:
        body = re.sub(r'(server_name[^;]*;\n)',
                      r'\1    root ' + build_dir + ';\n', body, count=1)
    # Add fresh /assets/ alias right after server_name if not present
    if '/assets/' not in body:
        alias_block = f"""
    location ^~ /assets/ {{
        alias {build_dir}/assets/;
        access_log off;
        expires 30d;
        add_header Cache-Control "public, immutable";
        try_files $uri =404;
    }}
"""
        body = re.sub(r'(server_name[^;]*;\n)', r'\1' + alias_block, body, count=1)
    return body

# Match each server { ... } block conservatively.
def replace_blocks(text):
    out, i, depth, start = [], 0, 0, -1
    while i < len(text):
        if text[i:i+7] == 'server ' or text[i:i+7] == 'server\t' or text[i:i+7] == 'server{':
            # find opening brace
            brace = text.find('{', i)
            if brace < 0: break
            depth, j = 1, brace + 1
            while j < len(text) and depth > 0:
                if text[j] == '{': depth += 1
                elif text[j] == '}': depth -= 1
                j += 1
            block = text[i:j]
            out.append(text[len(''.join(out)):i])
            out.append(fix_server(block))
            i = j
        else:
            i += 1
    # Fallback: simple regex if the above didn't rewrite anything
    return text

new = re.sub(r'server\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', lambda m: fix_server(m.group(0)), src)
pathlib.Path(conf_path).write_text(new)
print("patched root + /assets/ →", build_dir)
PY

ln -sf "$CONF" "$NGINX_ENABLED/$(basename "$CONF")"

nginx -t
systemctl reload nginx
log "nginx reloaded."

sleep 1
FIRST_ASSET="$(ls "$BUILD_DIR/assets" | head -1)"
code=$(curl -sk -o /dev/null -w "%{http_code}" "https://${DOMAIN}/assets/${FIRST_ASSET}")
[ "$code" = "200" ] || die "Asset still 404: /assets/${FIRST_ASSET} -> HTTP $code (check nginx error log: journalctl -u nginx -n 50)"
log "OK: /assets/${FIRST_ASSET} -> HTTP 200"

log "✅ dashboard root+assets fix complete. Hard-refresh https://${DOMAIN}/"

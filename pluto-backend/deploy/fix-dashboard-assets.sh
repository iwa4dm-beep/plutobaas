#!/usr/bin/env bash
# Fix dashboard.timescard.cloud 404 on /assets/* by pointing nginx to the
# freshly built .output/public/assets folder (Nitro node-server preset).
set -euo pipefail

DOMAIN="${DOMAIN:-dashboard.timescard.cloud}"
BUILD_DIR="${BUILD_DIR:-/root/backend-joy/.output/public}"
NGINX_AVAILABLE="/etc/nginx/sites-available"
NGINX_ENABLED="/etc/nginx/sites-enabled"

log() { printf '\033[1;36m[%s]\033[0m %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
die() { printf '\033[1;31m[FAIL]\033[0m %s\n' "$*" >&2; exit 1; }

[ -d "$BUILD_DIR/assets" ] || die "Build assets missing: $BUILD_DIR/assets — run 'bun run build' in backend-joy first."
log "Build assets found: $(ls "$BUILD_DIR/assets" | wc -l) files."

# Find the nginx vhost file for this domain
CONF="$(grep -rlE "server_name[[:space:]]+[^;]*\b${DOMAIN}\b" "$NGINX_AVAILABLE" 2>/dev/null | head -1 || true)"
[ -n "$CONF" ] || die "No nginx vhost found for $DOMAIN under $NGINX_AVAILABLE."
log "Vhost: $CONF"

# Backup
cp -a "$CONF" "${CONF}.bak.$(date -u +%Y%m%dT%H%M%SZ)"

# Patch: ensure a location /assets/ block serves from $BUILD_DIR/assets/
python3 - "$CONF" "$BUILD_DIR" <<'PY'
import re, sys, pathlib
conf_path, build_dir = sys.argv[1], sys.argv[2]
src = pathlib.Path(conf_path).read_text()

block = f"""
    location ^~ /assets/ {{
        alias {build_dir}/assets/;
        access_log off;
        expires 30d;
        add_header Cache-Control "public, immutable";
        try_files $uri =404;
    }}
"""

# Remove any existing /assets/ location blocks (balanced braces, simple form)
src = re.sub(r'\n\s*location\s+\^?~?\s*/assets/\s*\{[^}]*\}\s*', '\n', src)

# Insert the new block right after the first server_name line inside the 443/https server
def inject(match):
    return match.group(0) + block

new = re.sub(r'(server_name[^;]*;\n)', inject, src, count=1)
pathlib.Path(conf_path).write_text(new)
print("patched:", conf_path)
PY

# Ensure symlink is enabled
ln -sf "$CONF" "$NGINX_ENABLED/$(basename "$CONF")"

nginx -t
systemctl reload nginx
log "nginx reloaded."

# Verify
sleep 1
for a in /assets/$(ls "$BUILD_DIR/assets" | head -1); do
  code=$(curl -sk -o /dev/null -w "%{http_code}" "https://${DOMAIN}${a}")
  [ "$code" = "200" ] || die "Asset still not served: $a -> HTTP $code"
  log "OK: $a -> HTTP 200"
done

log "✅ dashboard assets fix complete. Hard-refresh https://${DOMAIN}/"

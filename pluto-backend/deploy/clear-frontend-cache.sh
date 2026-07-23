#!/usr/bin/env bash
# clear-frontend-cache.sh — Purge old bundle/cached files after a cutover.
# Removes Nginx cache, browser SW leftovers on disk, stale release dirs,
# CDN-cache-friendly bumps env.js query string, and reloads Nginx.
#
# Usage:
#   sudo bash clear-frontend-cache.sh app.timescard.cloud
#   sudo DOMAIN=dashboard.timescard.cloud bash clear-frontend-cache.sh
set -euo pipefail

DOMAIN="${1:-${DOMAIN:-app.timescard.cloud}}"
APP_ROOT="${APP_ROOT:-/var/www/$DOMAIN}"
NGINX_CACHE="${NGINX_CACHE:-/var/cache/nginx}"

green(){ printf "\033[1;32m✔ %s\033[0m\n" "$*"; }
info(){ printf "\033[1;36m→ %s\033[0m\n" "$*"; }
warn(){ printf "\033[1;33m! %s\033[0m\n" "$*"; }

info "domain=$DOMAIN  app_root=$APP_ROOT"

# 1. Nginx proxy cache
if [[ -d "$NGINX_CACHE" ]]; then
  info "clearing nginx cache at $NGINX_CACHE"
  find "$NGINX_CACHE" -type f -delete 2>/dev/null || true
  green "nginx cache cleared"
fi

# 2. Stale release directories (keep 2 newest under releases/)
if [[ -d "$APP_ROOT/releases" ]]; then
  info "pruning old releases (keeping newest 2)"
  cd "$APP_ROOT/releases"
  ls -1t | tail -n +3 | while read -r r; do
    [[ -n "$r" && "$r" != "current" ]] && rm -rf "$r" && echo "  removed $r"
  done
  green "release prune done"
fi

# 3. Bust env.js cache by appending a version query
CURRENT="$APP_ROOT/current"
[[ -L "$CURRENT" || -d "$CURRENT" ]] || CURRENT="$APP_ROOT"
INDEX="$CURRENT/index.html"
if [[ -f "$INDEX" ]]; then
  STAMP=$(date +%s)
  info "cache-busting env.js in $INDEX (v=$STAMP)"
  sed -i -E "s|(env\.js)(\?v=[0-9]+)?|\1?v=$STAMP|g" "$INDEX"
  green "index.html env.js bumped"
else
  warn "no index.html at $INDEX — skipping bust"
fi

# 4. Remove any service-worker file that might cache old chunks
find "$CURRENT" -maxdepth 3 -name 'sw.js' -o -name 'service-worker.js' 2>/dev/null | while read -r sw; do
  info "neutering $sw"
  echo "self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.map(x=>caches.delete(x)))).then(()=>self.clients.claim())));" > "$sw"
done

# 5. Reload nginx
if command -v nginx >/dev/null; then
  nginx -t && systemctl reload nginx && green "nginx reloaded"
fi

green "cache cleared — hard-refresh browser (Ctrl+Shift+R) to confirm"

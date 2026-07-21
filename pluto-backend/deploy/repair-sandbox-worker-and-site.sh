#!/usr/bin/env bash
# repair-sandbox-worker-and-site.sh — one-shot VPS recovery for:
#   - pluto-sandbox-worker stuck on EADDRINUSE / activating
#   - stale worker code
#   - nginx static-site proxy drift
#   - slug exists as a real workspace directory instead of a symlink
#
# Usage:
#   sudo SECRET='<PLUTO_SANDBOX_WORKER_SECRET>' \
#        SERVICE_KEY='<service-role-key>' \
#        UPSTREAM='https://<project-ref>.supabase.co' \
#        SLUG='dbhstock-8myjt4' \
#        bash deploy/repair-sandbox-worker-and-site.sh

set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "✗ run as root"; exit 2; }

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SLUG="${SLUG:-${1:-}}"
PORT="${PORT:-8787}"
SITES_ROOT="${SITES_ROOT:-/var/lib/pluto/sites}"
WILDCARD="${WILDCARD:-app.timescard.app}"
ACME_EMAIL="${ACME_EMAIL:-admin@${WILDCARD#*.}}"

[ -n "$SLUG" ] || { echo "Usage: sudo SLUG='<slug>' bash deploy/repair-sandbox-worker-and-site.sh"; exit 2; }

log() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }

cd "$ROOT"

log "1/6 identify and free port ${PORT}"
bash "$HERE/reset-sandbox-worker-port.sh" "$PORT"

log "2/6 repair/start pluto-sandbox-worker"
SECRET="${SECRET:-}" SERVICE_KEY="${SERVICE_KEY:-}" UPSTREAM="${UPSTREAM:-}" PORT="$PORT" SITES_ROOT="$SITES_ROOT" \
  bash "$HERE/repair-sandbox-worker.sh"

log "3/6 force-refresh running worker code"
bash "$HERE/refresh-worker.sh"

log "4/6 install/reload nginx static-site proxy"
ACME_EMAIL="$ACME_EMAIL" bash "$HERE/install-sites-proxy.sh" --wildcard "$WILDCARD"
nginx -t
systemctl reload nginx

log "5/6 recover slug disk state if possible"
SLUG_PATH="${SITES_ROOT}/${SLUG}"
if [ -L "$SLUG_PATH" ]; then
  echo "✓ slug symlink exists: $(ls -l "$SLUG_PATH")"
elif [ -d "$SLUG_PATH" ]; then
  echo "✓ slug exists as workspace directory: $SLUG_PATH"
  echo "  current worker accepts this layout after refresh"
elif [ -e "$SLUG_PATH" ]; then
  echo "✗ slug path exists but is not a directory/symlink: $SLUG_PATH"
  ls -la "$SLUG_PATH" || true
  exit 1
else
  echo "⚠ slug path is missing: $SLUG_PATH"
  MATCHES="$(grep -Rsl '"slug"[[:space:]]*:[[:space:]]*"'"$SLUG"'"' "$SITES_ROOT"/*/current.json "$SITES_ROOT"/*/preview.json 2>/dev/null | sed 's#/[^/]*\.json$##' | sort -u || true)"
  COUNT="$(printf '%s\n' "$MATCHES" | sed '/^$/d' | wc -l | tr -d ' ')"
  if [ "$COUNT" = "1" ]; then
    TARGET="$(printf '%s\n' "$MATCHES" | sed '/^$/d' | head -1)"
    ln -s "$(basename "$TARGET")" "$SLUG_PATH"
    echo "✓ repaired slug symlink: $SLUG_PATH -> $(basename "$TARGET")"
  else
    echo "✗ no deployed bundle for slug '$SLUG' under $SITES_ROOT"
    echo "  Worker/nginx are fixed. Now run Auto Deploy for this project so /sandbox/unpack creates the bundle, then rerun:"
    echo "  bash deploy/verify-deploy.sh $SLUG"
    exit 1
  fi
fi

echo "  disk state:"
ls -la "$SLUG_PATH" || true
if [ -d "$SLUG_PATH" ]; then
  ls -la "$SLUG_PATH" | sed -n '1,40p'
fi

log "6/6 verify served site"
bash "$HERE/verify-deploy.sh" "$SLUG"
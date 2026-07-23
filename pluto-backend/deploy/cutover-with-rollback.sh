#!/usr/bin/env bash
# cutover-with-rollback.sh — Wraps a Pluto cutover with automatic backup + rollback.
#
# Flow:
#   1. Snapshot current /var/www/$DOMAIN/current → /var/backups/pluto/$DOMAIN/<ts>
#   2. Snapshot current env.js and nginx vhost
#   3. Run the cutover (default: migrate-frontend-to-pluto.sh + build-and-cutover.sh)
#   4. Verify with verify-pluto-cutover.sh
#   5. On failure: restore the snapshot, reload nginx, restart service
#
# Usage:
#   sudo DOMAIN=app.timescard.cloud SERVICE=pluto-app bash cutover-with-rollback.sh
#   sudo CUTOVER_CMD="bash /root/backend-joy/pluto-backend/deploy/build-and-cutover.sh" \
#        DOMAIN=app.timescard.cloud bash cutover-with-rollback.sh
set -uo pipefail

DOMAIN="${DOMAIN:-app.timescard.cloud}"
APP_ROOT="${APP_ROOT:-/var/www/$DOMAIN}"
SERVICE="${SERVICE:-pluto-app}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/pluto/$DOMAIN}"
NGINX_VHOST="${NGINX_VHOST:-/etc/nginx/sites-available/$DOMAIN.conf}"
HERE="$(cd "$(dirname "$0")" && pwd)"
CUTOVER_CMD="${CUTOVER_CMD:-bash $HERE/build-and-cutover.sh}"
VERIFY_CMD="${VERIFY_CMD:-bash $HERE/verify-pluto-cutover.sh $DOMAIN}"

red(){ printf "\033[1;31m✗ %s\033[0m\n" "$*"; }
green(){ printf "\033[1;32m✔ %s\033[0m\n" "$*"; }
info(){ printf "\033[1;36m→ %s\033[0m\n" "$*"; }
warn(){ printf "\033[1;33m! %s\033[0m\n" "$*"; }

TS=$(date +%Y%m%d-%H%M%S)
SNAP="$BACKUP_ROOT/$TS"
mkdir -p "$SNAP"

info "snapshotting current state → $SNAP"
if [[ -e "$APP_ROOT/current" ]]; then
  cp -a "$(readlink -f "$APP_ROOT/current" 2>/dev/null || echo "$APP_ROOT/current")" "$SNAP/current" 2>/dev/null || \
    tar -C "$APP_ROOT" -czf "$SNAP/current.tgz" current 2>/dev/null || true
fi
[[ -f "$APP_ROOT/current/env.js" ]] && cp "$APP_ROOT/current/env.js" "$SNAP/env.js" 2>/dev/null || true
[[ -f "$NGINX_VHOST" ]] && cp "$NGINX_VHOST" "$SNAP/nginx.conf" 2>/dev/null || true
readlink -f "$APP_ROOT/current" > "$SNAP/current.symlink.txt" 2>/dev/null || true
green "backup saved"

rollback() {
  red "cutover FAILED — rolling back from $SNAP"
  if [[ -f "$SNAP/current.symlink.txt" ]]; then
    local prev
    prev=$(cat "$SNAP/current.symlink.txt")
    if [[ -d "$prev" ]]; then
      ln -sfn "$prev" "$APP_ROOT/current"
      green "restored symlink → $prev"
    fi
  elif [[ -d "$SNAP/current" ]]; then
    rm -rf "$APP_ROOT/current"
    cp -a "$SNAP/current" "$APP_ROOT/current"
  elif [[ -f "$SNAP/current.tgz" ]]; then
    rm -rf "$APP_ROOT/current"
    tar -C "$APP_ROOT" -xzf "$SNAP/current.tgz"
  fi
  [[ -f "$SNAP/nginx.conf" ]] && cp "$SNAP/nginx.conf" "$NGINX_VHOST" && nginx -t && systemctl reload nginx
  systemctl restart "$SERVICE" 2>/dev/null || true
  warn "rollback complete — verify manually"
  exit 1
}

info "running cutover: $CUTOVER_CMD"
if ! eval "$CUTOVER_CMD"; then
  rollback
fi

info "verifying cutover"
if ! eval "$VERIFY_CMD"; then
  rollback
fi

green "==== CUTOVER SUCCESS — backup retained at $SNAP ===="
# Keep last 5 backups
ls -1t "$BACKUP_ROOT" 2>/dev/null | tail -n +6 | while read -r old; do
  rm -rf "$BACKUP_ROOT/$old"
done

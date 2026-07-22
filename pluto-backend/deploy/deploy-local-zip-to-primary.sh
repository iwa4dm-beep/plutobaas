#!/usr/bin/env bash
# deploy-local-zip-to-primary.sh
# -----------------------------------------------------------------------------
# Manual/local fallback deploy for an already-built frontend ZIP.
# It bypasses POST /unpack, so it is useful when x-sandbox-secret is missing or
# Lovable-side worker auth is out of sync. It extracts the ZIP into the Pluto
# sites tree, flips <slug>/current, activates app.timescard.cloud, and verifies.
#
# Usage:
#   sudo PLUTO_URL=https://api.timescard.cloud PLUTO_ANON_KEY=pk_anon_xxx \
#     bash /opt/pluto/deploy/deploy-local-zip-to-primary.sh timesn /tmp/timesn.zip
# -----------------------------------------------------------------------------
set -euo pipefail

SLUG="${1:-}"
ZIP="${2:-}"
SITES_ROOT="${SITES_ROOT:-/var/lib/pluto/sites}"
APEX_DOMAIN="${APEX_DOMAIN:-app.timescard.cloud}"
SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
pass() { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
info() { printf '\033[1;36m→ %s\033[0m\n' "$*"; }

[[ "$(id -u)" -eq 0 ]] || die "run as root (sudo)."
[[ "$SLUG" =~ ^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])?$ ]] || die "invalid slug: $SLUG"
[[ -f "$ZIP" ]] || die "ZIP not found: $ZIP"
command -v unzip >/dev/null 2>&1 || die "unzip is required (apt install unzip)"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WS_DIR="$SITES_ROOT/$SLUG"
RELEASE_DIR="$WS_DIR/releases/$STAMP"
mkdir -p "$RELEASE_DIR"

info "Extracting $ZIP → $RELEASE_DIR"
unzip -oq "$ZIP" -d "$RELEASE_DIR"

find_webroot() {
  local root="$1" p count nested
  [[ -f "$root/index.html" ]] && { printf '%s\n' "$root"; return 0; }
  for p in "$root/dist" "$root/build" "$root/public" "$root/out" "$root/.output/public"; do
    [[ -f "$p/index.html" ]] && { printf '%s\n' "$p"; return 0; }
  done
  count=0; nested=""
  shopt -s nullglob
  for p in "$root"/*; do
    [[ -d "$p" ]] || continue
    count=$((count+1)); nested="$p"
  done
  shopt -u nullglob
  if [[ "$count" -eq 1 ]]; then find_webroot "$nested"; return $?; fi
  return 1
}

WEBROOT="$(find_webroot "$RELEASE_DIR")" || die "No index.html found inside $ZIP"
pass "Webroot: $WEBROOT"

if [[ -n "${PLUTO_URL:-}" || -n "${PLUTO_ANON_KEY:-}" ]]; then
  cat > "$WEBROOT/env.js" <<EOF
window.__PLUTO_ENV__ = {
  VITE_PLUTO_URL: "${PLUTO_URL:-https://api.timescard.cloud}",
  VITE_PLUTO_ANON_KEY: "${PLUTO_ANON_KEY:-}"
};
EOF
  pass "Wrote runtime env.js"
fi

if grep -RIl 'supabase\.\(co\|in\)' "$WEBROOT" >/tmp/pluto-leftovers.$$ 2>/dev/null; then
  cat /tmp/pluto-leftovers.$$ | sed 's/^/  leftover: /' >&2
  rm -f /tmp/pluto-leftovers.$$
  die "Supabase URL still exists in extracted bundle. Fix source, rebuild, then run this script again."
fi
rm -f /tmp/pluto-leftovers.$$

chown -R www-data:www-data "$WS_DIR" 2>/dev/null || true
find "$WS_DIR" -type d -exec chmod 755 {} + 2>/dev/null || true
find "$WS_DIR" -type f -exec chmod 644 {} + 2>/dev/null || true

ln -sfn "$WEBROOT" "$WS_DIR/current.new"
chown -h www-data:www-data "$WS_DIR/current.new" 2>/dev/null || true
mv -Tf "$WS_DIR/current.new" "$WS_DIR/current"
cat > "$WS_DIR/current.json" <<EOF
{"workspaceId":"$SLUG","slug":"$SLUG","channel":"production","webRoot":"$WEBROOT","servedAt":"$(date -u +%FT%TZ)"}
EOF
pass "Activated slug current: $WS_DIR/current → $WEBROOT"

if [[ -f "$SCRIPT_DIR/set-primary-frontend.sh" ]]; then
  info "Activating primary frontend $APEX_DOMAIN → $SLUG"
  APEX_DOMAIN="$APEX_DOMAIN" bash "$SCRIPT_DIR/set-primary-frontend.sh" --activate "$SLUG"
else
  die "Missing set-primary-frontend.sh next to this script"
fi

info "Verifying https://$APEX_DOMAIN"
code="$(curl -s -o /tmp/pluto-primary-body.$$ -w '%{http_code}' --max-time 12 "https://$APEX_DOMAIN/" || echo 000)"
[[ "$code" =~ ^2 ]] || die "Primary frontend returned HTTP $code"
rm -f /tmp/pluto-primary-body.$$
pass "Primary frontend live: https://$APEX_DOMAIN"

if [[ -f "$SCRIPT_DIR/verify-pluto-cutover.sh" ]]; then
  bash "$SCRIPT_DIR/verify-pluto-cutover.sh" "$APEX_DOMAIN"
fi
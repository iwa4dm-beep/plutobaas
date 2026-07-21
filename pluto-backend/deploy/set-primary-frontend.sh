#!/usr/bin/env bash
# set-primary-frontend.sh — Make app.timescard.cloud the single, permanent
# frontend URL for every published Pluto project.
#
# Instead of minting a new subdomain + Let's Encrypt cert for every project,
# this script:
#   1. Ensures /var/lib/pluto/sites/_primary/ exists with a `current` symlink.
#   2. Installs a fixed nginx vhost for app.timescard.cloud that serves
#      /var/lib/pluto/sites/_primary/current (SPA fallback + long-cache assets).
#   3. On every publish, atomically flips `_primary/current` to the given
#      workspace's live release, so the *latest* project is what app.
#      timescard.cloud serves — no DNS change, no cert reissue, ever.
#
# Usage (first time — installs vhost + cert):
#   sudo bash set-primary-frontend.sh --install --email admin@timescard.cloud
#
# Usage (on every successful publish — flip primary to a project):
#   sudo bash set-primary-frontend.sh --activate <workspaceId-or-slug>
#
# Usage (show what's currently primary):
#   sudo bash set-primary-frontend.sh --status

set -euo pipefail

APEX="${APEX_DOMAIN:-app.timescard.cloud}"
SITES_ROOT="${PLUTO_SITES_ROOT:-/var/lib/pluto/sites}"
PRIMARY_DIR="$SITES_ROOT/_primary"
PRIMARY_LINK="$PRIMARY_DIR/current"
NGX_AVAIL="/etc/nginx/sites-available/pluto-primary.conf"
NGX_ENABL="/etc/nginx/sites-enabled/pluto-primary.conf"
CONFLICT_BACKUP_DIR="/etc/nginx/pluto-primary-disabled"

log()  { printf "\n▶ %s\n" "$*"; }
pass() { printf "  ✓ %s\n" "$*"; }
warn() { printf "  ⚠ %s\n" "$*" >&2; }
die()  { printf "  ✗ %s\n" "$*" >&2; exit 1; }

need_root() { [ "$(id -u)" -eq 0 ] || die "run as root (sudo)"; }

disable_conflicting_vhosts() {
  # If another enabled nginx config already claims app.timescard.cloud, nginx
  # can keep serving that older vhost and ignore this managed primary frontend
  # block. Move only enabled configs that explicitly mention this exact
  # server_name; the original files are preserved under CONFLICT_BACKUP_DIR.
  local changed=0 conf real dest stamp
  stamp="$(date +%Y%m%d-%H%M%S)"

  shopt -s nullglob
  for conf in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do
    [ -e "$conf" ] || [ -L "$conf" ] || continue
    real="$conf"
    [ -L "$conf" ] && real="$(readlink -f "$conf" 2>/dev/null || echo "$conf")"
    [ "$conf" = "$NGX_ENABL" ] && continue
    [ "$real" = "$NGX_AVAIL" ] && continue
    grep -Eq "server_name[[:space:]][^;]*\b${APEX//./\\.}\b" "$real" 2>/dev/null || continue

    mkdir -p "$CONFLICT_BACKUP_DIR"
    dest="$CONFLICT_BACKUP_DIR/${stamp}-$(basename "$conf")"
    warn "disabling conflicting nginx vhost for $APEX: $conf → $dest"
    mv -f "$conf" "$dest"
    changed=1
  done
  shopt -u nullglob

  if [ "$changed" -eq 1 ]; then
    pass "Conflicting $APEX vhost(s) disabled; backups in $CONFLICT_BACKUP_DIR"
  fi
}

ensure_primary_dir() {
  mkdir -p "$PRIMARY_DIR"
  # Fallback landing page when no project is active yet.
  if [ ! -e "$PRIMARY_DIR/_placeholder/index.html" ]; then
    mkdir -p "$PRIMARY_DIR/_placeholder"
    cat > "$PRIMARY_DIR/_placeholder/index.html" <<HTML
<!doctype html><meta charset="utf-8"><title>Pluto — no active project</title>
<style>body{font-family:system-ui;padding:4rem;max-width:40rem;margin:auto;color:#334}</style>
<h1>No active project</h1>
<p>Publish a project from the dashboard and it will appear here at
<code>$APEX</code>.</p>
HTML
  fi
  if [ ! -L "$PRIMARY_LINK" ]; then
    ln -sfn "$PRIMARY_DIR/_placeholder" "$PRIMARY_LINK"
    pass "Initialized $PRIMARY_LINK → _placeholder"
  fi
}

write_vhost() {
  disable_conflicting_vhosts
  cat > "$NGX_AVAIL" <<NGX
# Managed by set-primary-frontend.sh — do not edit by hand.
server {
    listen 80;
    listen [::]:80;
    server_name $APEX;

    location /.well-known/acme-challenge/ { root /var/www/html; default_type "text/plain"; }
    location / { return 301 https://\$host\$request_uri; }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name $APEX;

    ssl_certificate     /etc/letsencrypt/live/$APEX/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$APEX/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options    "nosniff"                             always;
    add_header Referrer-Policy           "strict-origin-when-cross-origin"     always;
    add_header X-Pluto-Primary           "$APEX"                               always;

    root $PRIMARY_LINK;
    index index.html;

    location / { try_files \$uri \$uri/ /index.html; }

    location ~* \.(?:js|css|woff2?|png|jpg|jpeg|gif|svg|ico|webp)\$ {
        expires 30d; access_log off;
        add_header Cache-Control "public, max-age=2592000, immutable";
    }
    location = /index.html {
        add_header Cache-Control "no-store, must-revalidate";
    }

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;
}
NGX
  ln -sfn "$NGX_AVAIL" "$NGX_ENABL"
  pass "Wrote $NGX_AVAIL"
}

reload_nginx() {
  nginx -t
  systemctl reload nginx
  pass "nginx reloaded"
}

verify_primary_header() {
  if ! command -v curl >/dev/null 2>&1; then
    warn "curl not installed; skipping local primary-vhost header check"
    return 0
  fi
  local headers
  headers="$(curl -k -sS -I --max-time 8 --resolve "$APEX:443:127.0.0.1" "https://$APEX/" 2>/dev/null || true)"
  if printf '%s\n' "$headers" | grep -qi '^x-pluto-primary:'; then
    pass "Verified nginx is serving $APEX via pluto-primary vhost"
    return 0
  fi
  printf '%s\n' "$headers" | sed -n '1,12p' >&2
  die "$APEX is still not served by pluto-primary (X-Pluto-Primary header missing). Check for duplicate server_name blocks with: sudo nginx -T | grep -n \"server_name .*${APEX}\""
}

issue_cert() {
  local email="$1"
  [ -n "$email" ] || die "--email is required on first --install"
  if [ -d "/etc/letsencrypt/live/$APEX" ]; then
    pass "Cert for $APEX already exists — skipping issuance"
    return
  fi
  # Temporarily disable the HTTPS server block so certbot's HTTP-01 works
  # even before the cert file exists. We do this by writing an ACME-only
  # stub, running certbot, then rewriting the full vhost.
  cat > "$NGX_AVAIL" <<STUB
server { listen 80; server_name $APEX;
  location /.well-known/acme-challenge/ { root /var/www/html; }
  location / { return 200 "acme-bootstrap"; }
}
STUB
  ln -sfn "$NGX_AVAIL" "$NGX_ENABL"
  nginx -t && systemctl reload nginx
  mkdir -p /var/www/html
  certbot certonly --webroot -w /var/www/html \
    -d "$APEX" --email "$email" --agree-tos --non-interactive --no-eff-email
  pass "Issued cert for $APEX"
}

resolve_release() {
  # Accept either a workspace id (/var/lib/pluto/sites/<id>/current)
  # or a slug (searches all workspaces for a matching manifest).
  local key="$1"
  local candidate="$SITES_ROOT/$key/current"
  if [ -L "$candidate" ] || [ -d "$candidate" ]; then
    readlink -f "$candidate" 2>/dev/null || echo "$candidate"
    return
  fi
  # slug lookup via manifest
  local hit
  hit=$(grep -l "\"slug\"[[:space:]]*:[[:space:]]*\"$key\"" \
        "$SITES_ROOT"/*/current.json 2>/dev/null | head -1 || true)
  if [ -n "$hit" ]; then
    local ws
    ws=$(dirname "$hit")
    local cur="$ws/current"
    [ -L "$cur" ] && readlink -f "$cur" || echo "$cur"
    return
  fi
  die "Could not find a live release for '$key' under $SITES_ROOT"
}

cmd_install() {
  local email="${1:-}"
  need_root
  ensure_primary_dir
  disable_conflicting_vhosts
  issue_cert "$email"
  write_vhost
  reload_nginx
  verify_primary_header
  cat <<EOF

════════════════════════════════════════════════════════════════
✅ Primary frontend installed
   Domain:   https://$APEX
   Root:     $PRIMARY_LINK  (symlink)
   Placeholder shown until you --activate a project.

Next: after each successful publish, run
   sudo bash $(basename "$0") --activate <workspaceId-or-slug>
to flip $APEX to that project. SSL cert stays the same forever.
════════════════════════════════════════════════════════════════
EOF
}

cmd_activate() {
  local key="${1:-}"
  [ -n "$key" ] || die "usage: --activate <workspaceId-or-slug>"
  need_root
  ensure_primary_dir
  local target
  target=$(resolve_release "$key")
  [ -d "$target" ] || die "Resolved target is not a directory: $target"
  local tmplink="$PRIMARY_DIR/.current.new"
  ln -sfn "$target" "$tmplink"
  mv -Tf "$tmplink" "$PRIMARY_LINK"
  echo "{\"activatedAt\":\"$(date -u +%FT%TZ)\",\"key\":\"$key\",\"target\":\"$target\"}" \
    > "$PRIMARY_DIR/current.json"
  pass "Primary now serves: $target"
  pass "URL: https://$APEX"
}

cmd_status() {
  ensure_primary_dir
  echo "Primary domain : https://$APEX"
  echo "Symlink        : $PRIMARY_LINK"
  echo "Resolves to    : $(readlink -f "$PRIMARY_LINK" 2>/dev/null || echo '(missing)')"
  [ -f "$PRIMARY_DIR/current.json" ] && cat "$PRIMARY_DIR/current.json"
}

case "${1:-}" in
  --install)  shift; email=""; while [ $# -gt 0 ]; do case "$1" in --email) email="$2"; shift 2;; *) shift;; esac; done; cmd_install "$email" ;;
  --activate) shift; cmd_activate "${1:-}" ;;
  --status)   cmd_status ;;
  *) cat <<USAGE
Usage:
  sudo bash $0 --install --email you@example.com   # one-time setup
  sudo bash $0 --activate <workspaceId-or-slug>    # after each publish
  sudo bash $0 --status                            # inspect current target

Every project publish should end with '--activate', so
https://$APEX always serves the latest live project without
minting new subdomains or SSL certificates.
USAGE
  ;;
esac

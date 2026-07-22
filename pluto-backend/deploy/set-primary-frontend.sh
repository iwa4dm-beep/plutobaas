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
NGX_ENABL="/etc/nginx/sites-enabled/000-pluto-primary.conf"
NGX_LEGACY_ENABL="/etc/nginx/sites-enabled/pluto-primary.conf"
CONFLICT_BACKUP_DIR="/etc/nginx/pluto-primary-disabled"

log()  { printf "\n▶ %s\n" "$*"; }
pass() { printf "  ✓ %s\n" "$*"; }
warn() { printf "  ⚠ %s\n" "$*" >&2; }
die()  { printf "  ✗ %s\n" "$*" >&2; exit 1; }

need_root() { [ "$(id -u)" -eq 0 ] || die "run as root (sudo)"; }

disable_conflicting_vhosts() {
  # If ANY other nginx config claims the primary frontend host — or is a
  # default_server on :443/:80 that would catch this hostname when SNI/SSL
  # fails — nginx can keep serving that older vhost and ignore this managed
  # primary frontend block. Enumerate every config file nginx actually loads
  # (`nginx -T`) and quarantine any that either (a) mention this exact
  # server_name, or (b) declare `default_server` on the HTTP/HTTPS listen
  # ports, unless the file IS our managed primary vhost.
  local changed=0 stamp conflict real dest
  stamp="$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$CONFLICT_BACKUP_DIR"

  # Collect every config file nginx has loaded — includes /etc/nginx/nginx.conf,
  # sites-enabled/*, conf.d/*.conf, and any custom include paths.
  local -a loaded_files=()
  if command -v nginx >/dev/null 2>&1; then
    mapfile -t loaded_files < <(nginx -T 2>/dev/null | awk '/^# configuration file /{gsub(":",""); print $4}' | sort -u)
  fi
  # Fallback / union with the usual suspects so nothing is missed even if
  # `nginx -T` fails (e.g. current config is broken).
  shopt -s nullglob
  for extra in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do
    loaded_files+=("$extra")
  done
  shopt -u nullglob

  # Dedup.
  local -A seen=()
  local -a files=()
  for f in "${loaded_files[@]}"; do
    [ -n "$f" ] || continue
    [ -f "$f" ] || continue
    [ -n "${seen[$f]:-}" ] && continue
    seen[$f]=1
    files+=("$f")
  done

  local apex_re="${APEX//./\\.}"
  for conflict in "${files[@]}"; do
    real="$(readlink -f "$conflict" 2>/dev/null || echo "$conflict")"
    # Never quarantine our own managed files or nginx's main config.
    [ "$real" = "$NGX_AVAIL" ] && continue
    [ "$conflict" = "$NGX_ENABL" ] && continue
    [ "$conflict" = "$NGX_LEGACY_ENABL" ] && continue
    [ "$conflict" = "/etc/nginx/nginx.conf" ] && continue
    case "$conflict" in
      /etc/nginx/mime.types|/etc/nginx/fastcgi_params|/etc/nginx/proxy_params|/etc/nginx/scgi_params|/etc/nginx/uwsgi_params|/etc/nginx/koi-*|/etc/nginx/win-utf|/etc/nginx/modules-enabled/*|/etc/letsencrypt/options-ssl-nginx.conf)
        continue ;;
    esac

    local hit=0
    # (a) explicit server_name for this apex.
    if grep -Eq "server_name[[:space:]][^;]*${apex_re}([[:space:];]|$)" "$conflict" 2>/dev/null; then
      hit=1
    fi
    # (b) any default_server on :80 or :443 — catches marketing app deployed as
    # nginx default. Match IPv4, IPv6 ([::]:443), and any directive ordering
    # (e.g. `listen 443 default_server ssl http2;`).
    if [ "$hit" = "0" ] && grep -Ei "listen[[:space:]][^;]*default_server[^;]*;" "$conflict" 2>/dev/null | grep -Eq "(^|[^0-9])(80|443)([^0-9]|$)|\[::\]:(80|443)"; then
      hit=1
    fi
    [ "$hit" = "1" ] || continue

    dest="$CONFLICT_BACKUP_DIR/${stamp}-$(printf '%s' "$conflict" | tr '/' '_')"
    warn "quarantining conflicting nginx config for $APEX: $conflict → $dest"
    # Preserve the original file; if it's outside sites-enabled/conf.d we
    # can't simply move it (nginx.conf itself was excluded above), so copy+truncate
    # is unsafe. Instead move to backup and, if it lives under an `include`d
    # path, leave a no-op stub so the include doesn't error out.
    mv -f "$conflict" "$dest"
    if [[ "$conflict" == /etc/nginx/sites-enabled/* || "$conflict" == /etc/nginx/conf.d/*.conf ]]; then
      : # nginx globs skip missing entries — safe to leave removed.
    else
      # Included by name — leave an empty stub so `include` doesn't fail.
      printf '# Quarantined by set-primary-frontend.sh on %s → %s\n' "$stamp" "$dest" > "$conflict"
    fi
    changed=1
  done

  if [ "$changed" -eq 1 ]; then
    pass "Conflicting $APEX vhost(s)/default_server(s) quarantined; backups in $CONFLICT_BACKUP_DIR"
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
  if [ -e "$PRIMARY_LINK" ] && [ ! -L "$PRIMARY_LINK" ]; then
    local backup="$PRIMARY_DIR/current.backup.$(date +%Y%m%d-%H%M%S)"
    warn "$PRIMARY_LINK exists but is not a symlink; moving it to $backup"
    mv -f "$PRIMARY_LINK" "$backup"
  fi
  if [ ! -L "$PRIMARY_LINK" ]; then
    ln -sfn "$PRIMARY_DIR/_placeholder" "$PRIMARY_LINK"
    chown -h www-data:www-data "$PRIMARY_LINK" 2>/dev/null || true
    pass "Initialized $PRIMARY_LINK → _placeholder"
  fi
}

ensure_webroot_permissions() {
  # CloudPanel/nginx installs often enable `disable_symlinks if_not_owner` at a
  # global level. If our release/current symlink is owned by root while the
  # release files are owned by www-data, nginx opens index.html with O_NOFOLLOW
  # and returns ELOOP/403 ("Too many levels of symbolic links"). Make the whole
  # path traversable and keep the primary symlink owned by the web user.
  local target="$1" d
  for d in /var/lib /var/lib/pluto "$SITES_ROOT" "$PRIMARY_DIR"; do
    [ -d "$d" ] && chmod 755 "$d" 2>/dev/null || true
  done
  if [ -d "$target" ]; then
    find "$target" -type d -exec chmod 755 {} + 2>/dev/null || true
    find "$target" -type f -exec chmod 644 {} + 2>/dev/null || true
    chown -R www-data:www-data "$target" 2>/dev/null || true
  fi
}

write_vhost() {
  disable_conflicting_vhosts
  # Older installs used this enabled filename. Remove it so nginx loads exactly
  # one managed primary vhost, and loads it early enough to beat stale duplicate
  # server_name blocks if an operator left one outside the usual include paths.
  rm -f "$NGX_LEGACY_ENABL"
  cat > "$NGX_AVAIL" <<NGX
# Managed by set-primary-frontend.sh — do not edit by hand.
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name $APEX;

    location /.well-known/acme-challenge/ { root /var/www/html; default_type "text/plain"; }
    location / { return 301 https://\$host\$request_uri; }
}

server {
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
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
    disable_symlinks off;

    location / {
        add_header X-Pluto-Primary "$APEX" always;
        try_files \$uri \$uri/ /index.html;
    }

    location ~* \.(?:js|css|woff2?|png|jpg|jpeg|gif|svg|ico|webp)\$ {
        expires 30d; access_log off;
        add_header X-Pluto-Primary "$APEX" always;
        add_header Cache-Control "public, max-age=2592000, immutable";
    }
    location = /index.html {
        add_header X-Pluto-Primary "$APEX" always;
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
  local headers status body_file
  body_file="/tmp/pluto-primary-check.$$"
  headers="$(curl -k -sS -D - -o "$body_file" --max-time 8 --resolve "$APEX:443:127.0.0.1" "https://$APEX/" 2>/dev/null || true)"
  status="$(printf '%s\n' "$headers" | awk 'tolower($1) ~ /^http/ { code=$2 } END { print code }')"
  if printf '%s\n' "$headers" | grep -qi '^x-pluto-primary:'; then
    if [ "$status" != "200" ]; then
      printf '%s\n' "$headers" | sed -n '1,16p' >&2
      [ -f /var/log/nginx/error.log ] && tail -20 /var/log/nginx/error.log >&2 || true
      rm -f "$body_file"
      die "$APEX is using the pluto-primary vhost, but returned HTTP ${status:-unknown}. Check release permissions and index.html."
    fi
    rm -f "$body_file"
    pass "Verified nginx is serving $APEX via pluto-primary vhost"
    return 0
  fi
  printf '%s\n' "$headers" | sed -n '1,12p' >&2
  rm -f "$body_file"
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
  rm -f "$NGX_LEGACY_ENABL"
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

resolve_webroot_with_index() {
  # Normalize a release/current path to the exact directory nginx should serve.
  # The target must contain index.html; otherwise primary activation succeeds on
  # disk but app.timescard.cloud keeps showing the wrong app or a broken route.
  local root="$1" p count nested
  [ -d "$root" ] || die "Resolved release is not a directory: $root"
  if [ -f "$root/index.html" ]; then
    printf '%s\n' "$root"
    return 0
  fi
  for p in "$root/dist" "$root/build" "$root/public" "$root/out" "$root/.output/public"; do
    if [ -f "$p/index.html" ]; then
      printf '%s\n' "$p"
      return 0
    fi
  done
  count=0; nested=""
  shopt -s nullglob
  for p in "$root"/*; do
    [ -d "$p" ] || continue
    count=$((count+1)); nested="$p"
  done
  shopt -u nullglob
  if [ "$count" -eq 1 ]; then
    resolve_webroot_with_index "$nested"
    return $?
  fi
  die "No index.html found for '$root' (checked root, dist, build, public, out). Re-run Auto Deploy so the bundle is built/unpacked correctly."
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
  target=$(resolve_webroot_with_index "$target")
  [ -f "$target/index.html" ] || die "Resolved target has no index.html: $target"
  ensure_webroot_permissions "$target"
  local tmplink="$PRIMARY_DIR/.current.new"
  ln -sfn "$target" "$tmplink"
  chown -h www-data:www-data "$tmplink" 2>/dev/null || true
  if [ -e "$PRIMARY_LINK" ] && [ ! -L "$PRIMARY_LINK" ]; then
    local backup="$PRIMARY_DIR/current.backup.$(date +%Y%m%d-%H%M%S)"
    warn "$PRIMARY_LINK exists but is not a symlink; moving it to $backup"
    mv -f "$PRIMARY_LINK" "$backup"
  fi
  mv -Tf "$tmplink" "$PRIMARY_LINK"
  echo "{\"activatedAt\":\"$(date -u +%FT%TZ)\",\"key\":\"$key\",\"target\":\"$target\"}" \
    > "$PRIMARY_DIR/current.json"
  pass "Primary now serves: $target"
  pass "URL: https://$APEX"
  verify_primary_header
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

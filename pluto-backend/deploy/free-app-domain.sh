#!/usr/bin/env bash
# free-app-domain.sh — Detach the current site from app.timescard.cloud so a
# new GitHub-based project can be deployed cleanly.
#
# What this does (idempotent):
#   1. Removes the "primary frontend" pin (/var/lib/pluto/sites/_primary/current).
#   2. Disables Nginx vhosts that claim app.timescard.cloud
#      (pluto-primary.conf and any *app.timescard.cloud*.conf in sites-enabled).
#   3. Cleans broken symlinks under /etc/nginx/sites-enabled.
#   4. Reloads Nginx (nginx -t first; aborts on failure).
#   5. Verifies https://app.timescard.cloud/ no longer sends X-Pluto-Primary.
#
# Run as root on the VPS:
#   sudo bash /opt/pluto/deploy/free-app-domain.sh
#
# The wildcard *.app.timescard.cloud vhost, sandbox worker, TLS cert, and DNS
# all stay intact — only the domain root is freed.

set -euo pipefail

DOMAIN="${DOMAIN:-app.timescard.cloud}"
PRIMARY_DIR="/var/lib/pluto/sites/_primary"
NGINX_AVAILABLE="/etc/nginx/sites-available"
NGINX_ENABLED="/etc/nginx/sites-enabled"
BACKUP_DIR="/var/backups/pluto/free-app-domain-$(date +%Y%m%d-%H%M%S)"

log()  { printf "\033[1;36m[free]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[warn]\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m[ ok ]\033[0m %s\n" "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)"; exit 1; }

mkdir -p "$BACKUP_DIR"
log "Backups will be written to $BACKUP_DIR"

# 1. Drop the primary pin ---------------------------------------------------
if [ -e "$PRIMARY_DIR/current" ] || [ -L "$PRIMARY_DIR/current" ]; then
  log "Removing primary symlink $PRIMARY_DIR/current"
  cp -a "$PRIMARY_DIR/current" "$BACKUP_DIR/_primary.current" 2>/dev/null || true
  rm -f "$PRIMARY_DIR/current"
  ok  "primary pin removed"
else
  ok  "no primary pin present"
fi

if [ -f "$PRIMARY_DIR/current.json" ]; then
  cp -a "$PRIMARY_DIR/current.json" "$BACKUP_DIR/_primary.current.json" || true
  rm -f "$PRIMARY_DIR/current.json"
  ok  "manifest current.json removed"
fi

# 2. Disable Nginx vhosts owning the domain --------------------------------
disable_vhost() {
  local link="$1"
  if [ -L "$link" ] || [ -f "$link" ]; then
    log "Disabling $(basename "$link")"
    cp -a "$link" "$BACKUP_DIR/$(basename "$link")" 2>/dev/null || true
    rm -f "$link"
  fi
}

# Known primary vhost
disable_vhost "$NGINX_ENABLED/pluto-primary.conf"
disable_vhost "$NGINX_ENABLED/000-pluto-primary.conf"

# Any other vhost whose server_name matches the bare domain (not *.app...)
if command -v grep >/dev/null 2>&1; then
  while IFS= read -r f; do
    if grep -Eq "server_name[^;]*\b${DOMAIN}\b" "$f" 2>/dev/null \
       && ! grep -Eq "server_name[^;]*\*\.${DOMAIN}\b" "$f" 2>/dev/null; then
      # Skip wildcard-only files; only disable if the bare domain is served.
      link="$NGINX_ENABLED/$(basename "$f")"
      [ -e "$link" ] && disable_vhost "$link"
    fi
  done < <(find "$NGINX_ENABLED" -maxdepth 1 -type f -o -type l 2>/dev/null)
fi

# 3. Kill broken symlinks (common cause of nginx -t emerg) -----------------
log "Removing broken symlinks under $NGINX_ENABLED"
find "$NGINX_ENABLED" -xtype l -print -delete || true

# 4. Test + reload Nginx ---------------------------------------------------
log "Running nginx -t"
if ! nginx -t; then
  warn "nginx -t failed — restoring backups"
  cp -a "$BACKUP_DIR/." "$NGINX_ENABLED/" 2>/dev/null || true
  exit 1
fi
systemctl reload nginx
ok "nginx reloaded"

# 5. Verify --------------------------------------------------------------------
log "Probing https://${DOMAIN}/"
HDRS="$(curl -skI "https://${DOMAIN}/" --max-time 10 || true)"
echo "$HDRS" | sed 's/^/    /'

if echo "$HDRS" | grep -qi '^x-pluto-primary:'; then
  warn "X-Pluto-Primary is still present — another vhost may still be pinning ${DOMAIN}."
  warn "Run:  grep -RIn \"${DOMAIN}\" ${NGINX_AVAILABLE} ${NGINX_ENABLED}"
  exit 2
fi

ok "${DOMAIN} is free — no primary frontend attached."
cat <<EOF

Next steps to deploy your GitHub repo to ${DOMAIN}:
  1. Set the repo as the primary frontend:
       sudo bash /opt/pluto/deploy/install-dashboard-from-github.sh \\
            --repo https://github.com/<you>/<repo>.git \\
            --domain ${DOMAIN}
     (or use the Auto-Deploy Studio in the dashboard).
  2. Verify:
       curl -sI https://${DOMAIN}/ | grep -i x-pluto-primary

Backups of removed configs: ${BACKUP_DIR}
EOF

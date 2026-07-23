#!/usr/bin/env bash
# Remove `dashboard.timescard.cloud` from any nginx vhost that isn't our
# canonical dashboard config, so nginx stops picking the marketing/default
# vhost first (root cause of the "conflicting server name" warning + wrong
# HTML being served).
set -euo pipefail

DOMAIN="${DOMAIN:-dashboard.timescard.cloud}"
KEEP="${KEEP:-/etc/nginx/lovable-sites/${DOMAIN}.conf}"

log() { printf '\033[1;36m[%s]\033[0m %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
die() { printf '\033[1;31m[FAIL]\033[0m %s\n' "$*" >&2; exit 1; }

[ -f "$KEEP" ] || die "Canonical vhost not found: $KEEP (run fix-dashboard-assets.sh first)"

log "Keeping canonical: $KEEP"
log "Scanning for other vhosts claiming $DOMAIN ..."

mapfile -t HITS < <(grep -rlE "server_name[[:space:]]+[^;]*\b${DOMAIN}\b" \
  /etc/nginx 2>/dev/null | grep -v '\.bak\.' | grep -Fv "$KEEP" || true)

if [ "${#HITS[@]}" -eq 0 ]; then
  log "No duplicates found."
else
  for f in "${HITS[@]}"; do
    log "Cleaning duplicate: $f"
    cp -a "$f" "${f}.bak.$(date -u +%Y%m%dT%H%M%SZ)"
    # Strip DOMAIN token from server_name lines. If server_name becomes empty,
    # comment the whole line out (nginx rejects empty server_name).
    python3 - "$f" "$DOMAIN" <<'PY'
import re, sys, pathlib
p, dom = sys.argv[1], sys.argv[2]
txt = pathlib.Path(p).read_text()
def strip(m):
    names = m.group(1).split()
    names = [n for n in names if n != dom]
    if not names:
        return '# server_name (removed duplicate ' + dom + ');'
    return 'server_name ' + ' '.join(names) + ';'
new = re.sub(r'server_name\s+([^;]+);', strip, txt)
pathlib.Path(p).write_text(new)
print("  patched", p)
PY
  done
fi

nginx -t
systemctl reload nginx
log "nginx reloaded."

sleep 1
served="$(curl -sk -I "https://${DOMAIN}/" | tr -d '\r' | awk 'tolower($1)=="server:"{print $2}')"
title="$(curl -sk "https://${DOMAIN}/" | grep -oiE '<title>[^<]*' | head -1)"
log "Server header: ${served:-?}"
log "Title: ${title:-?}"
root_code="$(curl -sk -o /dev/null -w "%{http_code}" "https://${DOMAIN}/")"
root_location="$(curl -skI "https://${DOMAIN}/" | tr -d '\r' | awk 'tolower($1)=="location:"{print $2; exit}')"
if [ "$root_code" = "301" ] || [ "$root_code" = "302" ]; then
  log "Root redirect: HTTP ${root_code} -> ${root_location:-?}"
else
  log "Root response: HTTP ${root_code} (if this shows marketing HTML, re-run fix-dashboard-assets.sh)"
fi
log "✅ dedupe complete. Hard-refresh https://${DOMAIN}/"

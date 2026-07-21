#!/usr/bin/env bash
# diagnose-slug.sh — deep, actionable "why is this slug broken?" diagnosis.
# Emits JSON on stdout when --json is passed, otherwise a human-readable
# report with an exact fix command per detected cause.
#
# Usage:
#   bash deploy/diagnose-slug.sh <slug> [--json]
#   APEX=app.timescard.app API=api.timescard.cloud bash deploy/diagnose-slug.sh <slug>
set -uo pipefail

SLUG="${1:-}"
[ -z "$SLUG" ] && { echo "Usage: $0 <slug> [--json]" >&2; exit 2; }
FMT="human"; [ "${2:-}" = "--json" ] && FMT="json"

APEX="${APEX:-app.timescard.app}"
API="${API:-api.timescard.cloud}"
here="$(cd "$(dirname "$0")" && pwd)"

# 1) VPS IP + DNS resolution
VPS_IP="$(curl -4fsS --max-time 4 https://api.ipify.org 2>/dev/null || echo '')"
DNS_IP="$(getent hosts "${SLUG}.${APEX}" 2>/dev/null | awk '{print $1}' | head -n1)"
DNS_APEX_IP="$(getent hosts "${APEX}" 2>/dev/null | awk '{print $1}' | head -n1)"

# 2) TLS SAN check for wildcard
tls_covers=0
if command -v openssl >/dev/null 2>&1; then
  san="$(echo | openssl s_client -connect "${SLUG}.${APEX}:443" -servername "${SLUG}.${APEX}" 2>/dev/null \
        | openssl x509 -noout -text 2>/dev/null | grep -oE 'DNS:[^,]+' || true)"
  echo "$san" | grep -q "DNS:\\*\\.${APEX}" && tls_covers=1
fi

# 3) systemd unit states
nginx_active=$(systemctl is-active nginx 2>/dev/null || echo unknown)
worker_active=$(systemctl is-active pluto-sandbox-worker 2>/dev/null || \
                systemctl is-active pluto-sandbox 2>/dev/null || echo unknown)

# 4) Worker /site-status probe on localhost
worker_code=$(curl -s -o /tmp/_diag_ss -w '%{http_code}' --max-time 5 \
             "http://127.0.0.1:8787/site-status/${SLUG}" || echo 000)
worker_body=$(cat /tmp/_diag_ss 2>/dev/null || echo '')

# 5) Disk state
disk_dir="/var/lib/pluto/sites/${SLUG}"
has_dir=0; has_current=0
[ -d "$disk_dir" ] && has_dir=1
[ -L "$disk_dir/current" ] && has_current=1

# 6) HTTPS subdomain probe
subs_out=$(curl -s -o /dev/null -w '%{http_code} %{errormsg}' --max-time 6 \
          "https://${SLUG}.${APEX}/" 2>/dev/null || echo '000 curl_failed')
subs_code=$(echo "$subs_out" | awk '{print $1}')
subs_err=$(echo "$subs_out" | cut -d' ' -f2-)

# ---- classify cause ----
cause=""; fix=""
if [ -z "$DNS_APEX_IP" ] || [ -z "$DNS_IP" ]; then
  cause="dns_missing"
  fix="sudo bash $here/ensure-wildcard-dns.sh ${APEX}"
elif [ -n "$VPS_IP" ] && [ "$DNS_IP" != "$VPS_IP" ]; then
  cause="dns_wrong_ip"
  fix="Update DNS: ${SLUG}.${APEX} currently → ${DNS_IP}, should → ${VPS_IP}. Run: sudo bash $here/ensure-wildcard-dns.sh ${APEX}"
elif echo "$subs_err" | grep -qi "no alternative certificate subject"; then
  cause="tls_missing"
  fix="sudo CF_API_TOKEN='<cloudflare-token>' bash $here/fix-wildcard-ssl.sh ${SLUG}"
elif [ "$tls_covers" = "0" ] && [ "$subs_code" = "000" ]; then
  cause="tls_missing"
  fix="sudo CF_API_TOKEN='<cloudflare-token>' bash $here/fix-wildcard-ssl.sh ${SLUG}"
elif [ "$nginx_active" != "active" ]; then
  cause="nginx_down"
  fix="sudo nginx -t && sudo systemctl restart nginx"
elif [ "$worker_active" != "active" ]; then
  cause="worker_down"
  fix="sudo bash $here/refresh-worker.sh"
elif [ "$worker_code" = "404" ] || [ "$has_current" = "0" ]; then
  cause="slug_not_seeded"
  fix="sudo bash $here/seed-slug.sh ${SLUG}   # or: curl -H 'x-pluto-auto-seed: 1' http://127.0.0.1:8787/site-status/${SLUG}"
elif [ "$worker_code" = "200" ] && [ "$subs_code" != "200" ]; then
  cause="nginx_proxy_broken"
  fix="sudo bash $here/install-sites-proxy.sh --wildcard ${APEX}"
else
  cause="ok"
  fix=""
fi

if [ "$FMT" = "json" ]; then
  python3 - "$SLUG" "$APEX" "$VPS_IP" "$DNS_IP" "$DNS_APEX_IP" \
    "$tls_covers" "$nginx_active" "$worker_active" "$worker_code" \
    "$has_dir" "$has_current" "$subs_code" "$subs_err" "$cause" "$fix" <<'PY'
import json, sys
k=["slug","apex","vps_ip","dns_ip","dns_apex_ip","tls_covers_wildcard","nginx","worker","worker_status_code","disk_dir_exists","has_current_symlink","https_status_code","https_err","cause","fix_command"]
v=sys.argv[1:]
d=dict(zip(k,v))
for f in ("tls_covers_wildcard","disk_dir_exists","has_current_symlink"): d[f]=bool(int(d[f]))
print(json.dumps(d, indent=2))
PY
  exit 0
fi

echo "▶ diagnose-slug: ${SLUG} on ${APEX}"
printf "  vps_ip=%s dns_ip=%s apex_dns=%s\n" "$VPS_IP" "$DNS_IP" "$DNS_APEX_IP"
printf "  tls_covers_wildcard=%s nginx=%s worker=%s\n" "$tls_covers" "$nginx_active" "$worker_active"
printf "  worker /site-status → HTTP %s\n" "$worker_code"
printf "  https://%s.%s/ → HTTP %s %s\n" "$SLUG" "$APEX" "$subs_code" "$subs_err"
printf "  disk: dir=%s current-symlink=%s (%s)\n" "$has_dir" "$has_current" "$disk_dir"
echo
if [ "$cause" = "ok" ]; then
  echo "✓ No issue detected — slug '${SLUG}' looks healthy."
else
  echo "⚠ Cause: ${cause}"
  echo "→ Fix:   ${fix}"
fi

#!/usr/bin/env bash
# tls-renew.sh — wraps certbot renew, logs to /var/log/pluto, writes
# /var/lib/pluto/tls-status.json with cert not-after per domain. Reloads
# nginx on successful renewal.
#
# Install via pluto-backend/deploy/systemd/pluto-tls-renew.{service,timer}
set -uo pipefail

LOG_DIR="${LOG_DIR:-/var/log/pluto}"
STATE_DIR="${STATE_DIR:-/var/lib/pluto}"
STATUS="${STATE_DIR}/tls-status.json"
mkdir -p "$LOG_DIR" "$STATE_DIR"
LOG="${LOG_DIR}/tls-renew.log"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
echo "[$(ts)] pluto tls-renew starting" >>"$LOG"

renew_rc=0
if command -v certbot >/dev/null 2>&1; then
  certbot renew --deploy-hook 'systemctl reload nginx' \
    >>"$LOG" 2>&1 || renew_rc=$?
else
  echo "[$(ts)] certbot missing" >>"$LOG"
  renew_rc=127
fi

# Build cert inventory
tmp="$(mktemp)"
echo '{' >"$tmp"
echo "  \"lastRun\": \"$(ts)\"," >>"$tmp"
echo "  \"success\": $([ $renew_rc -eq 0 ] && echo true || echo false)," >>"$tmp"
echo "  \"exitCode\": $renew_rc," >>"$tmp"
echo '  "certs": [' >>"$tmp"
first=1
if [ -d /etc/letsencrypt/live ]; then
  for d in /etc/letsencrypt/live/*/; do
    [ -f "${d}fullchain.pem" ] || continue
    name="$(basename "$d")"
    not_after="$(openssl x509 -in "${d}fullchain.pem" -noout -enddate 2>/dev/null | cut -d= -f2)"
    not_after_iso="$(date -u -d "$not_after" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")"
    days_left="$(( ( $(date -u -d "$not_after" +%s 2>/dev/null || echo 0) - $(date -u +%s) ) / 86400 ))"
    sans="$(openssl x509 -in "${d}fullchain.pem" -noout -text 2>/dev/null \
           | awk '/Subject Alternative Name/{getline; print}' \
           | tr -d ' ' | tr ',' '\n' | sed 's/DNS://g' | paste -sd, -)"
    [ $first -eq 1 ] || echo "," >>"$tmp"
    first=0
    printf '    {"name":"%s","notAfter":"%s","daysLeft":%s,"sans":"%s"}' \
      "$name" "$not_after_iso" "$days_left" "$sans" >>"$tmp"
  done
fi
echo >>"$tmp"
echo '  ]' >>"$tmp"
echo '}' >>"$tmp"
mv "$tmp" "$STATUS"
chmod 644 "$STATUS"

echo "[$(ts)] tls-renew finished rc=${renew_rc} status=${STATUS}" >>"$LOG"

# Alert hook — fires on failure or if any cert has <14d remaining
if [ -x "$(dirname "$0")/tls-alert.sh" ]; then
  bash "$(dirname "$0")/tls-alert.sh" || true
fi

exit $renew_rc

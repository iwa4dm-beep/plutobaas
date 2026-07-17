#!/usr/bin/env bash
# tls-alert.sh — reads /var/lib/pluto/tls-status.json and POSTs an alert to
# the dashboard when a cert is expiring soon (<14 days) or the last renew
# failed. HMAC-signed with TLS_ALERT_SECRET when set. Runs alongside
# tls-renew.sh in the same systemd timer.
set -uo pipefail

STATUS="${STATUS:-/var/lib/pluto/tls-status.json}"
LOG="${LOG:-/var/log/pluto/tls-alert.log}"
mkdir -p "$(dirname "$LOG")"
[ -f "$STATUS" ] || { echo "[$(date -u +%FT%TZ)] no status file at $STATUS" >>"$LOG"; exit 0; }

# Load alert endpoint + secret from /etc/pluto/tls-alert.env if present.
[ -f /etc/pluto/tls-alert.env ] && . /etc/pluto/tls-alert.env
ENDPOINT="${TLS_ALERT_URL:-}"
SECRET="${TLS_ALERT_SECRET:-}"

# Decide whether to alert.
payload="$(cat "$STATUS")"
should_alert="$(python3 - <<PY
import json,sys
d=json.loads('''$payload''')
alert=False; reasons=[]
if not d.get('success', True):
    alert=True; reasons.append('renew_failed')
for c in d.get('certs',[]):
    if isinstance(c.get('daysLeft'), int) and c['daysLeft'] < 14:
        alert=True; reasons.append(f"expiring:{c['name']}:{c['daysLeft']}d")
print('1' if alert else '0', ','.join(reasons))
PY
)"
flag="$(echo "$should_alert" | awk '{print $1}')"
reasons="$(echo "$should_alert" | cut -d' ' -f2-)"

if [ "$flag" != "1" ]; then
  echo "[$(date -u +%FT%TZ)] tls-alert: healthy" >>"$LOG"
  exit 0
fi

echo "[$(date -u +%FT%TZ)] tls-alert: reasons=${reasons}" >>"$LOG"

if [ -z "$ENDPOINT" ]; then
  echo "[$(date -u +%FT%TZ)] TLS_ALERT_URL not configured; skipping POST" >>"$LOG"
  exit 0
fi

sig=""
if [ -n "$SECRET" ]; then
  sig="$(printf '%s' "$payload" | openssl dgst -sha256 -hmac "$SECRET" -binary | xxd -p -c 256)"
fi

curl -fsS -o /dev/null --max-time 8 -X POST "$ENDPOINT" \
  -H 'content-type: application/json' \
  ${sig:+-H "x-pluto-signature: sha256=${sig}"} \
  -H "x-pluto-alert-reasons: ${reasons}" \
  --data-binary "$payload" \
  >>"$LOG" 2>&1 \
  && echo "[$(date -u +%FT%TZ)] tls-alert: posted to $ENDPOINT" >>"$LOG" \
  || echo "[$(date -u +%FT%TZ)] tls-alert: POST failed" >>"$LOG"

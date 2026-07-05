#!/usr/bin/env bash
# Create/update UptimeRobot HTTPS monitors for the Pluto API health endpoints.
# Uses UptimeRobot v2 REST API — https://uptimerobot.com/api/
#
# Prereqs:
#   export UPTIMEROBOT_API_KEY=ur-xxxxxxxxxxxxxxxxxx   # "Main API Key" from
#                                                     # My Settings → API Settings
#   export ALERT_CONTACT_ID=1234567                   # id of an existing alert
#                                                     # contact (email/SMS/Slack)
#                                                     # from getAlertContacts
#
# Usage:
#   bash deploy/uptimerobot-monitors.sh
#   BASE=https://api.example.com bash deploy/uptimerobot-monitors.sh
set -euo pipefail

: "${UPTIMEROBOT_API_KEY:?set UPTIMEROBOT_API_KEY}"
: "${ALERT_CONTACT_ID:?set ALERT_CONTACT_ID (see: curl -s -X POST https://api.uptimerobot.com/v2/getAlertContacts -d api_key=\$UPTIMEROBOT_API_KEY -d format=json | jq)}"

BASE="${BASE:-https://api.timescard.cloud}"
# Threshold format: "contact_id_threshold_recurrence" — 0_0 = notify immediately, no repeat
THRESHOLD="${ALERT_CONTACT_ID}_0_0"

# Monitors to create: name|path|keyword-expected-in-body
MONITORS=(
  "Pluto /livez|/livez|ok"
  "Pluto /readyz|/readyz|ready"
  "Pluto /health/migrations|/health/migrations|ok"
)

api() {
  local method="$1"; shift
  curl -sS -X POST "https://api.uptimerobot.com/v2/$method" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -H "Cache-Control: no-cache" \
    --data-urlencode "api_key=$UPTIMEROBOT_API_KEY" \
    -d format=json \
    "$@"
}

for row in "${MONITORS[@]}"; do
  NAME="${row%%|*}"; rest="${row#*|}"
  PATH_="${rest%%|*}"; KEYWORD="${rest##*|}"
  URL="${BASE}${PATH_}"

  echo "▶ ensuring monitor: $NAME → $URL (keyword=$KEYWORD)"

  # monitor_type=2 (Keyword), keyword_type=2 (exists = alert when NOT found),
  # http_method=1 (GET), interval=300s. Use newMonitor; ignore 'already exists' error.
  RESP=$(api newMonitor \
    --data-urlencode "friendly_name=$NAME" \
    --data-urlencode "url=$URL" \
    -d monitor_type=2 \
    -d keyword_type=2 \
    -d "keyword_value=$KEYWORD" \
    -d http_method=1 \
    -d interval=300 \
    --data-urlencode "alert_contacts=$THRESHOLD" || true)

  if echo "$RESP" | grep -q '"stat":"ok"'; then
    echo "  ✔ created / OK"
  elif echo "$RESP" | grep -q 'already exists'; then
    echo "  ℹ already exists — skipping"
  else
    echo "  ✘ failed: $RESP"
  fi
done

echo "✅ done — verify at https://uptimerobot.com/dashboard"

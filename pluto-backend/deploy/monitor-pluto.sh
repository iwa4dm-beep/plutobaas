#!/usr/bin/env bash
# monitor-pluto.sh — Live dashboard for Pluto backend health.
# Polls /health and /auth/v1/settings on api.timescard.cloud (or $PLUTO_API)
# and prints a rolling status table with latency + last error body.
#
# Usage:
#   bash monitor-pluto.sh              # loop every 5s
#   INTERVAL=2 bash monitor-pluto.sh   # every 2s
#   ONCE=1 bash monitor-pluto.sh       # single probe (for cron / logs)
#   LOG=/var/log/pluto-monitor.log bash monitor-pluto.sh
set -uo pipefail

PLUTO_API="${PLUTO_API:-https://api.timescard.cloud}"
INTERVAL="${INTERVAL:-5}"
ONCE="${ONCE:-0}"
LOG="${LOG:-}"

probe() {
  local path="$1" tmp code ms
  tmp=$(mktemp)
  local start end
  start=$(date +%s%3N)
  code=$(curl -s -o "$tmp" -w '%{http_code}' --max-time 6 "$PLUTO_API$path" || echo 000)
  end=$(date +%s%3N)
  ms=$((end - start))
  local snippet=""
  if [[ "$code" != 2* ]]; then
    snippet=$(head -c 120 "$tmp" | tr '\n' ' ')
  fi
  rm -f "$tmp"
  printf '%s\t%s\t%sms\t%s\n' "$path" "$code" "$ms" "$snippet"
}

run() {
  local ts
  ts=$(date '+%Y-%m-%d %H:%M:%S')
  local h a
  h=$(probe /health)
  a=$(probe /auth/v1/settings)
  local line="[$ts] $PLUTO_API"$'\n'"  health : $h"$'\n'"  auth   : $a"
  echo "$line"
  [[ -n "$LOG" ]] && echo "$line" >> "$LOG"
}

if [[ "$ONCE" = "1" ]]; then
  run
  exit 0
fi

echo "▶ monitoring $PLUTO_API every ${INTERVAL}s  (Ctrl-C to stop)"
[[ -n "$LOG" ]] && echo "  logging → $LOG"
while true; do
  clear 2>/dev/null || true
  run
  sleep "$INTERVAL"
done

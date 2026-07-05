#!/usr/bin/env bash
# One-shot health probe for cron / UptimeRobot alternative.
# Exits 0 if all endpoints healthy, 1 otherwise. Logs to /var/log/pluto-health.log
set -u
BASE="${PLUTO_HEALTH_BASE:-https://api.timescard.cloud}"
LOG="${PLUTO_HEALTH_LOG:-/var/log/pluto-health.log}"

ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
fail=0

check() {
  local path="$1" expect="$2"
  local code
  code=$(curl -s -o /tmp/hc.$$ -w "%{http_code}" --max-time 10 "$BASE$path" || echo "000")
  if [ "$code" != "$expect" ]; then
    echo "$(ts) FAIL $path -> $code (expected $expect)" | tee -a "$LOG"
    head -c 400 /tmp/hc.$$ | tee -a "$LOG" >/dev/null; echo | tee -a "$LOG" >/dev/null
    fail=1
  else
    echo "$(ts) ok   $path -> $code" >> "$LOG"
  fi
  rm -f /tmp/hc.$$
}

check /livez           200
check /readyz          200
check /health/deps     200
check /health/migrations 200

exit $fail

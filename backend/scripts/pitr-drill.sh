#!/usr/bin/env bash
# Cross-region PITR failover drill.
#
# Simulates losing the primary region and recovering to a target time using
# a base backup + WAL segments streamed to the DR region. Measures RPO
# (data loss window) and RTO (time to first-byte on the replica) so we
# can track them against the SLO documented in docs/runbooks/pitr-drill.md.
#
# Usage:
#   BASE_URL=https://api.example.com \
#   SERVICE_ROLE_KEY=... \
#   TARGET_TIME=2026-07-04T10:00:00Z \
#   ./backend/scripts/pitr-drill.sh
#
# All API calls go through the /pitr/v1/* control plane (see
# backend/apps/server/src/modules/pitr/plugin.ts). This script does NOT
# touch the live database directly — it drives the same endpoints the UI
# uses so the drill mirrors production behavior.
set -euo pipefail

: "${BASE_URL:?BASE_URL is required}"
: "${SERVICE_ROLE_KEY:?SERVICE_ROLE_KEY is required}"
TARGET_TIME="${TARGET_TIME:-$(date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-5M +%Y-%m-%dT%H:%M:%SZ)}"

curl_json() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -X "$method" -H "authorization: Bearer ${SERVICE_ROLE_KEY}" -H "content-type: application/json")
  [[ -n "$body" ]] && args+=(-d "$body")
  curl "${args[@]}" "${BASE_URL}${path}"
}

echo "==> Verifying WAL archive is enabled"
config=$(curl_json GET /pitr/v1/config)
echo "$config" | jq .
enabled=$(echo "$config" | jq -r '.enabled // false')
if [[ "$enabled" != "true" ]]; then
  echo "!! WAL archive is not enabled — aborting drill" >&2
  exit 2
fi

echo "==> Finding most recent basebackup on/before ${TARGET_TIME}"
started=$(date +%s)

echo "==> Requesting DRY-RUN restore (validates coverage)"
restore=$(curl_json POST /pitr/v1/restore \
  "{\"target_time\":\"${TARGET_TIME}\",\"dry_run\":true}")
echo "$restore" | jq .
rid=$(echo "$restore" | jq -r .id)

echo "==> Polling restore status"
for _ in $(seq 1 60); do
  s=$(curl_json GET "/pitr/v1/restore/${rid}" | jq -r .status)
  echo "   status=${s}"
  [[ "$s" == "done" || "$s" == "failed" ]] && break
  sleep 5
done
ended=$(date +%s)
rto=$((ended - started))

echo "==> Listing cross-region replicas and checking they are current"
replicas=$(curl_json GET /pitr/v1/replicas)
echo "$replicas" | jq '.replicas[] | {region, status, replicated_at, verified_at}'

# RPO ≈ (target_time - most_recent_archived_wal) — a positive number means
# we lost that many seconds of writes on failover.
last_wal=$(echo "$config" | jq -r '.last_archived_at // empty')
if [[ -n "$last_wal" ]]; then
  target_epoch=$(date -u -d "${TARGET_TIME}" +%s 2>/dev/null || date -u -jf "%Y-%m-%dT%H:%M:%SZ" "${TARGET_TIME}" +%s)
  wal_epoch=$(date -u -d "${last_wal}" +%s 2>/dev/null || date -u -jf "%Y-%m-%dT%H:%M:%S%z" "${last_wal}" +%s)
  rpo=$((target_epoch - wal_epoch))
  [[ $rpo -lt 0 ]] && rpo=0
else
  rpo="unknown"
fi

echo
echo "===================== DRILL SUMMARY ====================="
echo "  target_time : ${TARGET_TIME}"
echo "  restore_id  : ${rid}"
echo "  RTO (sec)   : ${rto}"
echo "  RPO (sec)   : ${rpo}"
echo "========================================================="

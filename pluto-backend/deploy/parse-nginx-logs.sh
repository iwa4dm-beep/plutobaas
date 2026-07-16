#!/usr/bin/env bash
# parse-nginx-logs.sh — Phase F.
#
# Tails /var/log/nginx/pluto-slugs.log (JSON log_format pluto_slug_json),
# aggregates per (slug, day) since the last checkpoint, and UPSERTs into
# admin.project_usage via the Pluto admin API. Also emits abuse_events
# when a slug crosses a spike threshold within a single run.
#
# Designed to run every 5 minutes from pluto-usage-parser.timer.
#
# Environment:
#   PLUTO_API_BASE          default http://127.0.0.1:8000
#   PLUTO_SERVICE_ROLE_KEY  required
#   PLUTO_ACCESS_LOG        default /var/log/nginx/pluto-slugs.log
#   PARSER_STATE_DIR        default /var/lib/pluto/parser
#   SPIKE_5XX_THRESHOLD     default 50   (5xx per slug per run → abuse_event)
#   SPIKE_4XX_THRESHOLD     default 500

set -euo pipefail

PLUTO_API_BASE="${PLUTO_API_BASE:-http://127.0.0.1:8000}"
LOG_FILE="${PLUTO_ACCESS_LOG:-/var/log/nginx/pluto-slugs.log}"
STATE_DIR="${PARSER_STATE_DIR:-/var/lib/pluto/parser}"
STATE_FILE="$STATE_DIR/pluto-slugs.offset"
SPIKE_5XX_THRESHOLD="${SPIKE_5XX_THRESHOLD:-50}"
SPIKE_4XX_THRESHOLD="${SPIKE_4XX_THRESHOLD:-500}"

[[ -n "${PLUTO_SERVICE_ROLE_KEY:-}" ]] || { echo "PLUTO_SERVICE_ROLE_KEY required" >&2; exit 1; }
command -v jq   >/dev/null || { echo "jq required"   >&2; exit 1; }
command -v curl >/dev/null || { echo "curl required" >&2; exit 1; }

mkdir -p "$STATE_DIR"
[[ -f "$LOG_FILE" ]] || { echo "log file $LOG_FILE not found — nothing to do"; exit 0; }

INODE_NOW=$(stat -c '%i' "$LOG_FILE")
SIZE_NOW=$(stat -c '%s' "$LOG_FILE")

OFFSET=0
LAST_INODE=0
if [[ -f "$STATE_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$STATE_FILE"
fi
# Log rotated → start from beginning of new file.
[[ "$LAST_INODE" != "$INODE_NOW" ]] && OFFSET=0
# Truncated → reset.
[[ "$OFFSET" -gt "$SIZE_NOW" ]] && OFFSET=0

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

tail -c +$((OFFSET + 1)) "$LOG_FILE" > "$TMP" || true

if [[ ! -s "$TMP" ]]; then
  printf 'OFFSET=%s\nLAST_INODE=%s\n' "$SIZE_NOW" "$INODE_NOW" > "$STATE_FILE"
  exit 0
fi

# Aggregate to { slug, day, requests, bytes_out, errors_4xx, errors_5xx }.
ROLLUP=$(jq -sc '
  map(select(.slug != null and .slug != ""))
  | group_by([.slug, (.ts | .[0:10])])
  | map({
      slug:       .[0].slug,
      day:        (.[0].ts | .[0:10]),
      requests:   length,
      bytes_out:  ([.[].body_bytes_sent // 0] | add),
      errors_4xx: ([.[] | select(.status >= 400 and .status < 500)] | length),
      errors_5xx: ([.[] | select(.status >= 500)] | length)
    })
' < "$TMP")

COUNT=$(jq 'length' <<<"$ROLLUP")
echo "[parser] rolled up $COUNT slug/day rows from $(wc -l <"$TMP") log lines"

if [[ "$COUNT" -gt 0 ]]; then
  curl -fsS -X POST "$PLUTO_API_BASE/admin/v1/project-usage/upsert" \
       -H "authorization: Bearer $PLUTO_SERVICE_ROLE_KEY" \
       -H "apikey: $PLUTO_SERVICE_ROLE_KEY" \
       -H "content-type: application/json" \
       -d "{\"rows\":$ROLLUP}" >/dev/null || echo "[parser] upsert failed" >&2

  # Spike detection.
  jq -c --argjson t4 "$SPIKE_4XX_THRESHOLD" --argjson t5 "$SPIKE_5XX_THRESHOLD" '
    .[] | select(.errors_5xx >= $t5 or .errors_4xx >= $t4)
    | {slug, kind: (if .errors_5xx >= $t5 then "error_spike" else "rate_spike" end),
       detail: {errors_4xx: .errors_4xx, errors_5xx: .errors_5xx, day: .day}}
  ' <<<"$ROLLUP" | while read -r evt; do
    [[ -n "$evt" ]] || continue
    curl -fsS -X POST "$PLUTO_API_BASE/admin/v1/abuse-events" \
         -H "authorization: Bearer $PLUTO_SERVICE_ROLE_KEY" \
         -H "apikey: $PLUTO_SERVICE_ROLE_KEY" \
         -H "content-type: application/json" \
         -d "$evt" >/dev/null || true
  done
fi

printf 'OFFSET=%s\nLAST_INODE=%s\n' "$SIZE_NOW" "$INODE_NOW" > "$STATE_FILE"

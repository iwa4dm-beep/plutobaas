#!/usr/bin/env bash
# /usr/local/sbin/pluto-ops — dispatcher for Ops actions triggered by the
# dashboard's Operations page. Called by the sandbox worker via sudo -n.
#
# Actions:
#   migrations-plan        — list pending migrations (no changes)
#   migrations-dry-run     — apply inside a rolled-back transaction
#   migrations-apply       — apply pending migrations
#   service-restart --service <api|realtime|worker|nginx-reload>
#   service-health         — dump systemd/docker status for known services
#
# All actions are allow-listed. No arbitrary shell.
set -euo pipefail

ACTION="${1:-}"; shift || true
SERVICE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --service) SERVICE="${2:-}"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Resolve deploy root (mirrors used by pluto-repair)
DEPLOY_DIR=""
for d in /opt/pluto/deploy /root/pluto-backend/deploy /home/pluto/pluto-backend/deploy; do
  [ -d "$d" ] && DEPLOY_DIR="$d" && break
done

log() { printf '[pluto-ops] %s\n' "$*"; }

case "$ACTION" in
  migrations-plan)
    [ -n "$DEPLOY_DIR" ] || { log "no deploy dir found"; exit 127; }
    bash "$DEPLOY_DIR/preflight-migrations.sh" --plan-only 2>&1 || \
      bash "$DEPLOY_DIR/run-migrator.sh" --plan 2>&1
    ;;
  migrations-dry-run)
    [ -n "$DEPLOY_DIR" ] || { log "no deploy dir found"; exit 127; }
    bash "$DEPLOY_DIR/run-migrator.sh" --dry-run 2>&1
    ;;
  migrations-apply)
    [ -n "$DEPLOY_DIR" ] || { log "no deploy dir found"; exit 127; }
    bash "$DEPLOY_DIR/run-migrator.sh" 2>&1
    ;;
  service-restart)
    case "$SERVICE" in
      api)
        log "restarting API"
        if systemctl list-unit-files 2>/dev/null | grep -q '^pluto-api\.service'; then
          systemctl restart pluto-api
          systemctl status pluto-api --no-pager -l | tail -20
        elif docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^pluto-api$'; then
          docker restart pluto-api
        else
          # docker compose fallback
          cd /root/pluto-backend/docker 2>/dev/null || cd "$DEPLOY_DIR/../docker" 2>/dev/null || true
          docker compose restart api 2>&1
        fi
        ;;
      realtime)
        log "restarting Realtime"
        if systemctl list-unit-files 2>/dev/null | grep -q '^pluto-realtime\.service'; then
          systemctl restart pluto-realtime
          systemctl status pluto-realtime --no-pager -l | tail -20
        else
          cd /root/pluto-backend/docker 2>/dev/null || cd "$DEPLOY_DIR/../docker" 2>/dev/null || true
          docker compose restart realtime 2>&1
        fi
        ;;
      worker)
        log "restarting sandbox worker"
        systemctl restart pluto-sandbox-worker 2>/dev/null || systemctl restart pluto-sandbox
        systemctl status pluto-sandbox-worker --no-pager -l 2>/dev/null | tail -20 || \
          systemctl status pluto-sandbox --no-pager -l | tail -20
        ;;
      nginx-reload)
        log "nginx -t && reload"
        nginx -t
        systemctl reload nginx
        ;;
      *)
        log "invalid --service: $SERVICE"
        exit 2
        ;;
    esac
    ;;
  service-health)
    for unit in pluto-api pluto-realtime pluto-sandbox-worker pluto-sandbox nginx; do
      if systemctl list-unit-files 2>/dev/null | grep -q "^${unit}\.service"; then
        state=$(systemctl is-active "$unit" 2>/dev/null || echo unknown)
        since=$(systemctl show "$unit" -p ActiveEnterTimestamp --value 2>/dev/null || echo "")
        printf '%-28s %-10s since=%s\n' "$unit" "$state" "$since"
      fi
    done
    if command -v docker >/dev/null 2>&1; then
      echo "--- docker ---"
      docker ps --format 'table {{.Names}}\t{{.Status}}' 2>/dev/null | grep -E 'pluto|postgres|redis|minio' || true
    fi
    ;;
  *)
    echo "unknown action: $ACTION" >&2
    echo "allowed: migrations-plan migrations-dry-run migrations-apply service-restart service-health" >&2
    exit 2
    ;;
esac

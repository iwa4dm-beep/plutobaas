#!/usr/bin/env bash
# /usr/local/sbin/pluto-ops — dispatcher for Ops actions triggered by the
# dashboard's Operations page. Called by the sandbox worker via sudo -n.
#
# Actions (all allow-listed, no arbitrary shell):
#   migrations-plan
#   migrations-dry-run
#   migrations-apply
#   migrations-rollback-plan     --target <version> [--allow-missing-down]
#   migrations-rollback-apply    --target <version> [--allow-missing-down]
#   service-restart              --service <api|realtime|worker|nginx-reload>
#   service-rollout              --plan <auto|workers-only|canary-api|full> [--soak <sec>]
#   service-health
#   backup-create
#   backup-list
#   backup-restore               --id <backup-id>
#
# Every invocation also accepts:
#   --env <dev|staging|prod>     (informational — used for backup dir + log prefix)

set -euo pipefail

ACTION="${1:-}"; shift || true
SERVICE=""
PLAN=""
SOAK="30"
TARGET=""
BACKUP_ID=""
ALLOW_MISSING_DOWN="0"
ENV_NAME="prod"
KEEP_DAYS=""
KEEP_COUNT=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --service) SERVICE="${2:-}"; shift 2 ;;
    --plan) PLAN="${2:-}"; shift 2 ;;
    --soak) SOAK="${2:-30}"; shift 2 ;;
    --target) TARGET="${2:-}"; shift 2 ;;
    --id) BACKUP_ID="${2:-}"; shift 2 ;;
    --allow-missing-down) ALLOW_MISSING_DOWN="1"; shift ;;
    --env) ENV_NAME="${2:-prod}"; shift 2 ;;
    --keep-days) KEEP_DAYS="${2:-}"; shift 2 ;;
    --keep-count) KEEP_COUNT="${2:-}"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

case "$ENV_NAME" in dev|staging|prod) ;; *) echo "invalid --env: $ENV_NAME" >&2; exit 2 ;; esac

# Optional per-env conf: /etc/pluto/ops.conf may export PLUTO_OPS_DISALLOW="rollout,rollback-apply".
[ -f /etc/pluto/ops.conf ] && . /etc/pluto/ops.conf || true

disallow_re="${PLUTO_OPS_DISALLOW:-}"
if [ -n "$disallow_re" ] && printf '%s' ",$disallow_re," | grep -q ",${ACTION},"; then
  echo "[pluto-ops] action '$ACTION' disabled by /etc/pluto/ops.conf on env=$ENV_NAME" >&2
  exit 3
fi

# Resolve deploy root (mirrors used by pluto-repair)
DEPLOY_DIR=""
for d in /opt/pluto/deploy /root/pluto-backend/deploy /home/pluto/pluto-backend/deploy; do
  [ -d "$d" ] && DEPLOY_DIR="$d" && break
done

BACKUP_ROOT="${PLUTO_BACKUP_ROOT:-/var/backups/pluto}/$ENV_NAME"
mkdir -p "$BACKUP_ROOT" 2>/dev/null || true

log() { printf '[pluto-ops][%s] %s\n' "$ENV_NAME" "$*"; }

# ----------- helpers -----------
find_dc() {
  # Emit the docker-compose dir + file if we can find one.
  for base in /root/pluto-backend /home/pluto/pluto-backend /opt/pluto; do
    if [ -f "$base/docker/docker-compose.yml" ]; then
      echo "$base/docker"; return 0
    fi
  done
  return 1
}

pg_dump_cmd() {
  # Prefer running inside the postgres container if compose is up.
  local dc; dc=$(find_dc || true)
  if [ -n "$dc" ] && docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^pluto-postgres$'; then
    echo "docker exec -e PGPASSWORD=$POSTGRES_PASSWORD pluto-postgres pg_dump -U $POSTGRES_USER -d $POSTGRES_DB -Fc"
  else
    echo "PGPASSWORD=$POSTGRES_PASSWORD pg_dump -h ${POSTGRES_HOST:-127.0.0.1} -U ${POSTGRES_USER:-pluto} -d ${POSTGRES_DB:-pluto} -Fc"
  fi
}

load_env_creds() {
  # Best-effort read of docker/.env for DB creds.
  for f in /root/pluto-backend/docker/.env /home/pluto/pluto-backend/docker/.env; do
    [ -f "$f" ] && . "$f" && break
  done
  : "${POSTGRES_USER:=pluto}"; : "${POSTGRES_DB:=pluto}"; : "${POSTGRES_PASSWORD:=}"; : "${POSTGRES_HOST:=127.0.0.1}"
  export POSTGRES_USER POSTGRES_DB POSTGRES_PASSWORD POSTGRES_HOST
}

health_probe() {
  local unit="$1"
  systemctl is-active "$unit" >/dev/null 2>&1 && return 0
  docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${unit}$" && return 0
  return 1
}

restart_one() {
  local svc="$1"
  case "$svc" in
    api)
      if systemctl list-unit-files 2>/dev/null | grep -q '^pluto-api\.service'; then
        systemctl restart pluto-api
      elif docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^pluto-api$'; then
        docker restart pluto-api
      else
        local dc; dc=$(find_dc || true); [ -n "$dc" ] && (cd "$dc" && docker compose restart api)
      fi ;;
    realtime)
      if systemctl list-unit-files 2>/dev/null | grep -q '^pluto-realtime\.service'; then
        systemctl restart pluto-realtime
      else
        local dc; dc=$(find_dc || true); [ -n "$dc" ] && (cd "$dc" && docker compose restart realtime)
      fi ;;
    worker)
      systemctl restart pluto-sandbox-worker 2>/dev/null || systemctl restart pluto-sandbox ;;
    nginx-reload)
      nginx -t && systemctl reload nginx ;;
    *) log "invalid service: $svc"; return 2 ;;
  esac
}

# ----------- actions -----------
# ----------- helper: emit report line for migration actions -----------
emit_report_json() {
  local kind="$1" outcome="$2" objects_csv="$3" pending_count="$4"
  local rid; rid="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "rep-$$-$(date +%s)")"
  printf 'REPORT_JSON: {"id":"%s","env":"%s","kind":"%s","outcome":"%s","affected":"%s","pending":%s,"createdAt":"%s"}\n' \
    "$rid" "$ENV_NAME" "$kind" "$outcome" "$objects_csv" "${pending_count:-0}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

extract_objects_from_pending() {
  # scan pending migrations dir if run-migrator surfaced a list; best-effort.
  local mig_dir="$DEPLOY_DIR/../migrations"; [ -d "$mig_dir" ] || mig_dir="$(dirname "$DEPLOY_DIR")/migrations"
  [ -d "$mig_dir" ] || return 0
  grep -hoiE '(CREATE|ALTER|DROP)[[:space:]]+(TABLE|INDEX|VIEW|FUNCTION|SCHEMA|TYPE|POLICY|TRIGGER)[[:space:]]+[A-Za-z0-9_."]+' "$mig_dir"/*.sql 2>/dev/null \
    | awk '{print $NF}' | tr -d '";,' | sort -u | head -25 | tr '\n' '|' | sed 's/|$//'
}

case "$ACTION" in
  migrations-plan)
    [ -n "$DEPLOY_DIR" ] || { log "no deploy dir found"; exit 127; }
    tmp_out="$(mktemp)"
    (bash "$DEPLOY_DIR/preflight-migrations.sh" --plan-only 2>&1 || bash "$DEPLOY_DIR/run-migrator.sh" --plan 2>&1) | tee "$tmp_out"
    _rc=${PIPESTATUS[0]}
    _pending=$(grep -cE '^(pending|would apply|→ )' "$tmp_out" 2>/dev/null || echo 0)
    _outcome=$([ "$_rc" = "0" ] && echo "ok" || echo "failed")
    emit_report_json "plan" "$_outcome" "$(extract_objects_from_pending)" "$_pending"
    rm -f "$tmp_out"
    exit "$_rc"
    ;;
  migrations-dry-run)
    [ -n "$DEPLOY_DIR" ] || { log "no deploy dir found"; exit 127; }
    tmp_out="$(mktemp)"
    bash "$DEPLOY_DIR/run-migrator.sh" --dry-run 2>&1 | tee "$tmp_out"
    _rc=${PIPESTATUS[0]}
    _outcome=$([ "$_rc" = "0" ] && echo "ok" || echo "failed")
    emit_report_json "dry-run" "$_outcome" "$(extract_objects_from_pending)" "0"
    rm -f "$tmp_out"
    exit "$_rc"
    ;;
  migrations-apply)
    [ -n "$DEPLOY_DIR" ] || { log "no deploy dir found"; exit 127; }
    tmp_out="$(mktemp)"
    bash "$DEPLOY_DIR/run-migrator.sh" 2>&1 | tee "$tmp_out"
    _rc=${PIPESTATUS[0]}
    _outcome=$([ "$_rc" = "0" ] && echo "ok" || echo "failed")
    emit_report_json "apply" "$_outcome" "$(extract_objects_from_pending)" "0"
    rm -f "$tmp_out"
    exit "$_rc"
    ;;
  migrations-rollback-plan)
    [ -n "$TARGET" ] || { log "--target required"; exit 2; }
    [ -n "$DEPLOY_DIR" ] || { log "no deploy dir found"; exit 127; }
    # List applied migrations above target + presence of .down.sql pairs.
    load_env_creds
    log "planning rollback to $TARGET"
    MIG_DIR="$DEPLOY_DIR/../migrations"; [ -d "$MIG_DIR" ] || MIG_DIR="$(dirname "$DEPLOY_DIR")/migrations"
    ls "$MIG_DIR" 2>/dev/null | grep -E '^[0-9]+_.*\.sql$' | grep -v '\.down\.sql$' | sort -r | while read -r f; do
      ver="${f%%_*}"
      if [ "$ver" -gt "$TARGET" ] 2>/dev/null; then
        down="${f%.sql}.down.sql"
        if [ -f "$MIG_DIR/$down" ]; then echo "OK    $ver  $down"; else echo "MISS  $ver  $f (no down-migration)"; fi
      fi
    done
    ;;
  migrations-rollback-apply)
    [ -n "$TARGET" ] || { log "--target required"; exit 2; }
    [ -n "$DEPLOY_DIR" ] || { log "no deploy dir found"; exit 127; }
    load_env_creds
    log "APPLYING rollback to $TARGET (allow-missing-down=$ALLOW_MISSING_DOWN)"
    MIG_DIR="$DEPLOY_DIR/../migrations"; [ -d "$MIG_DIR" ] || MIG_DIR="$(dirname "$DEPLOY_DIR")/migrations"
    # Concatenate downs in reverse order.
    TMP="$(mktemp -t pluto-rollback.XXXXXX.sql)"
    trap 'rm -f "$TMP"' EXIT
    echo 'BEGIN;' > "$TMP"
    missing_count=0
    ls "$MIG_DIR" | grep -E '^[0-9]+_.*\.sql$' | grep -v '\.down\.sql$' | sort -r | while read -r f; do
      ver="${f%%_*}"
      if [ "$ver" -gt "$TARGET" ] 2>/dev/null; then
        down="${f%.sql}.down.sql"
        if [ -f "$MIG_DIR/$down" ]; then
          echo "-- $down" >> "$TMP"; cat "$MIG_DIR/$down" >> "$TMP"; echo >> "$TMP"
        else
          echo "-- MISSING down for $f" >> "$TMP"
          missing_count=$((missing_count+1))
        fi
      fi
    done
    echo 'COMMIT;' >> "$TMP"
    if [ "$ALLOW_MISSING_DOWN" != "1" ] && grep -q "^-- MISSING down" "$TMP"; then
      log "aborted: missing down-migrations (pass --allow-missing-down to force)"
      grep "^-- MISSING" "$TMP" || true
      exit 4
    fi
    dc=$(find_dc || true)
    if [ -n "$dc" ] && docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^pluto-postgres$'; then
      docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" pluto-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 < "$TMP"
    else
      PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -f "$TMP"
    fi
    log "rollback applied"
    ;;
  service-restart)
    restart_one "$SERVICE"
    systemctl status "pluto-$SERVICE" --no-pager -l 2>/dev/null | tail -20 || true
    ;;
  service-rollout)
    PLAN="${PLAN:-auto}"
    case "$PLAN" in
      workers-only)   stages="worker" ;;
      canary-api)     stages="worker realtime api nginx-reload" ;;
      full|auto|"")   stages="worker realtime api nginx-reload" ;;
      *) log "invalid --plan: $PLAN"; exit 2 ;;
    esac
    log "rollout plan=$PLAN stages=[$stages] soak=${SOAK}s"
    for s in $stages; do
      log "→ stage: $s"
      restart_one "$s" || { log "stage '$s' FAILED"; exit 5; }
      # health probe (best-effort). soak only after api.
      case "$s" in
        api) log "soak ${SOAK}s after api"; sleep "$SOAK" ;;
      esac
      log "✓ stage $s done"
    done
    log "rollout complete"
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
  backup-create)
    load_env_creds
    ts="$(date -u +%Y%m%dT%H%M%SZ)"
    id="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "$ts-$$")"
    dst="$BACKUP_ROOT/${ts}-${id}.dump"
    log "creating backup → $dst"
    cmd=$(pg_dump_cmd)
    # shellcheck disable=SC2086
    eval "$cmd" > "$dst"
    size=$(stat -c%s "$dst" 2>/dev/null || echo 0)
    sha=$(sha256sum "$dst" | awk '{print $1}')
    # Emit a single JSON line the worker parses to append to the backup registry.
    printf 'BACKUP_JSON: {"id":"%s","env":"%s","path":"%s","size":%s,"sha256":"%s","createdAt":"%s","status":"ok"}\n' \
      "$id" "$ENV_NAME" "$dst" "$size" "$sha" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    log "backup ok size=${size}B"
    ;;
  backup-list)
    ls -1t "$BACKUP_ROOT"/*.dump 2>/dev/null | head -20 | while read -r f; do
      size=$(stat -c%s "$f" 2>/dev/null || echo 0)
      mtime=$(stat -c%y "$f" 2>/dev/null || echo "")
      echo "$f  size=$size  mtime=$mtime"
    done
    ;;
  backup-restore)
    [ -n "$BACKUP_ID" ] || { log "--id required"; exit 2; }
    load_env_creds
    # Match by id embedded in filename or full path.
    src=""
    if [ -f "$BACKUP_ID" ]; then src="$BACKUP_ID"
    else src=$(ls -1 "$BACKUP_ROOT"/*"$BACKUP_ID"*.dump 2>/dev/null | head -1); fi
    [ -n "$src" ] && [ -f "$src" ] || { log "backup not found: $BACKUP_ID"; exit 4; }
    log "restoring from $src"
    dc=$(find_dc || true)
    if [ -n "$dc" ] && docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^pluto-postgres$'; then
      docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" pluto-postgres pg_restore --clean --if-exists -U "$POSTGRES_USER" -d "$POSTGRES_DB" < "$src"
    else
      PGPASSWORD="$POSTGRES_PASSWORD" pg_restore --clean --if-exists -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" < "$src"
    fi
    log "restore complete"
    ;;
  backup-prune)
    # Enforce retention: delete dumps older than KEEP_DAYS days OR beyond KEEP_COUNT newest.
    kd="${KEEP_DAYS:-0}"; kc="${KEEP_COUNT:-0}"
    log "prune keep_days=$kd keep_count=$kc dir=$BACKUP_ROOT"
    removed=0; kept=0
    # Age-based first.
    if [ "$kd" -gt 0 ] 2>/dev/null; then
      while IFS= read -r f; do
        [ -f "$f" ] || continue
        printf 'PRUNE_REMOVE: %s (age)\n' "$f"
        rm -f "$f" && removed=$((removed+1))
      done < <(find "$BACKUP_ROOT" -maxdepth 1 -type f -name '*.dump' -mtime "+$kd" 2>/dev/null)
    fi
    # Count-based: keep newest kc, delete rest.
    if [ "$kc" -gt 0 ] 2>/dev/null; then
      i=0
      while IFS= read -r f; do
        i=$((i+1))
        if [ "$i" -le "$kc" ]; then kept=$((kept+1)); continue; fi
        printf 'PRUNE_REMOVE: %s (count)\n' "$f"
        rm -f "$f" && removed=$((removed+1))
      done < <(ls -1t "$BACKUP_ROOT"/*.dump 2>/dev/null)
    fi
    printf 'PRUNE_JSON: {"env":"%s","removed":%s,"kept":%s,"keepDays":%s,"keepCount":%s,"at":"%s"}\n' \
      "$ENV_NAME" "$removed" "$kept" "${kd:-0}" "${kc:-0}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    log "prune complete removed=$removed kept=$kept"
    ;;
  *)
    echo "unknown action: $ACTION" >&2
    echo "allowed: migrations-plan|dry-run|apply|rollback-plan|rollback-apply, service-restart|rollout|health, backup-create|list|restore|prune" >&2
    exit 2
    ;;
esac

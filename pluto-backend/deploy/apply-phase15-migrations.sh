#!/usr/bin/env bash
# ==============================================================================
#  Pluto BaaS · Phase 15 migration deploy script
# ==============================================================================
#  Applies the 0016 → 0026 migration batch on your VPS Postgres.
#
#  Usage on the VPS:
#    cd /opt/pluto-backend                  # or wherever the repo is cloned
#    git pull                               # fetch these new files first
#    export DATABASE_URL=postgres://…       # (or source your .env)
#    ./deploy/apply-phase15-migrations.sh   # applies + verifies + restarts
#
#  Flags:
#    --dry-run     Show what would be applied, run nothing
#    --no-restart  Skip the systemctl restart step
#    --force       Reapply even if already recorded (uses psql, not the runner)
#    --repo-root DIR   Override auto-detected repo root
# ==============================================================================
set -euo pipefail

DRY_RUN=0; RESTART=1; FORCE=0
REPO_ROOT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)    DRY_RUN=1 ;;
    --no-restart) RESTART=0 ;;
    --force)      FORCE=1 ;;
    --repo-root)  REPO_ROOT="$2"; shift ;;
    -h|--help)
      sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

# --- Resolve repo root ---
if [[ -z "$REPO_ROOT" ]]; then
  REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
MIG_DIR="$REPO_ROOT/migrations"
[[ -d "$MIG_DIR" ]] || { echo "❌ migrations dir not found: $MIG_DIR" >&2; exit 1; }

# --- Load .env if present (DATABASE_URL etc.) ---
if [[ -z "${DATABASE_URL:-}" && -f "$REPO_ROOT/.env" ]]; then
  # shellcheck disable=SC2046
  set -a; . "$REPO_ROOT/.env"; set +a
fi
: "${DATABASE_URL:?❌ DATABASE_URL not set (export it, or put it in $REPO_ROOT/.env)}"

command -v psql >/dev/null || { echo "❌ psql not installed (apt install postgresql-client)"; exit 1; }

echo "──────────────────────────────────────────────────────────"
echo "  Pluto · Phase 15 migration deploy"
echo "  Repo:        $REPO_ROOT"
echo "  Migrations:  $MIG_DIR"
echo "  DB:          ${DATABASE_URL%%\?*}"
echo "  Dry run:     $DRY_RUN   Force: $FORCE   Restart svc: $RESTART"
echo "──────────────────────────────────────────────────────────"

# --- The batch we're rolling out ---
BATCH=(
  0016_stats_workspaces.sql
  0017_integrations_health.sql
  0018_sql_history.sql
  0019_cors_origins.sql
  0020_rate_limits.sql
  0021_ai_vector.sql
  0022_queues_cache.sql
  0023_templates.sql
  0024_push.sql
  0025_sso.sql
  0026_realtime_system_channels.sql
)

# --- Sanity: every file present? ---
missing=0
for f in "${BATCH[@]}"; do
  if [[ ! -f "$MIG_DIR/$f" ]]; then
    echo "  ✖ missing $f"; missing=1
  else
    printf "  ✔ %s (%d bytes)\n" "$f" "$(wc -c <"$MIG_DIR/$f")"
  fi
done
[[ $missing -eq 0 ]] || { echo "❌ Refusing to run — files above are missing. Did you 'git pull'?"; exit 1; }

# --- Show which are already recorded ---
echo ""
echo "→ Current ledger:"
psql "$DATABASE_URL" -Atc "select name from _pluto_migrations order by name" 2>/dev/null \
  | grep -E '^0(01[6-9]|02[0-6])_' || echo "  (none of 0016–0026 applied yet)"

if [[ $DRY_RUN -eq 1 ]]; then
  echo ""; echo "🟡 Dry run — nothing applied. Re-run without --dry-run to apply."; exit 0
fi

# --- Backup safety net ---
BACKUP_DIR="$REPO_ROOT/backups"
mkdir -p "$BACKUP_DIR"
BACKUP_FILE="$BACKUP_DIR/pre-phase15-$(date +%Y%m%d-%H%M%S).sql.gz"
echo ""
echo "→ Dumping schema-only snapshot to $BACKUP_FILE (safety net)"
if pg_dump "$DATABASE_URL" --schema-only --no-owner --no-privileges 2>/dev/null | gzip >"$BACKUP_FILE"; then
  echo "  ✔ backup ok ($(du -h "$BACKUP_FILE" | cut -f1))"
else
  echo "  ⚠ pg_dump failed — continuing without backup"
  rm -f "$BACKUP_FILE"
fi

# --- Apply ---
echo ""
if [[ $FORCE -eq 1 ]]; then
  echo "→ FORCE mode: applying each file directly via psql (skipping ledger check)"
  for f in "${BATCH[@]}"; do
    echo "  → $f"
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$MIG_DIR/$f"
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
      "insert into _pluto_migrations (name) values ('$f') on conflict do nothing"
  done
else
  echo "→ Applying via the standard runner (skips already-applied files)"
  if [[ -d "$REPO_ROOT/packages/api" ]] && command -v node >/dev/null; then
    ( cd "$REPO_ROOT/packages/api" && node scripts/migrate.mjs )
  else
    echo "  Runner not found — falling back to direct psql apply"
    for f in "${BATCH[@]}"; do
      already=$(psql "$DATABASE_URL" -Atc "select 1 from _pluto_migrations where name = '$f'")
      if [[ "$already" == "1" ]]; then
        echo "  ✓ $f already applied"
      else
        echo "  → $f"
        psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$MIG_DIR/$f"
        psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
          "insert into _pluto_migrations (name) values ('$f')"
      fi
    done
  fi
fi

# --- Verify ---
echo ""
echo "→ Verifying (expecting all 11 rows present)"
psql "$DATABASE_URL" -Atc "
  select name from _pluto_migrations
  where name like '001[6-9]_%' or name like '002[0-6]_%'
  order by name"

echo ""
echo "→ Table smoke test"
psql "$DATABASE_URL" -Atc "
  select table_schema||'.'||table_name from information_schema.tables
  where (table_schema,table_name) in (
    ('admin','workspaces'), ('admin','workspace_members'), ('admin','integrations'),
    ('admin','sql_history'), ('admin','cors_origins'), ('admin','rate_limit_policies'),
    ('ai','requests'), ('ai','collections'), ('ai','embeddings'),
    ('queue','queues'), ('queue','jobs'), ('cache','kv'),
    ('admin','templates'), ('admin','push_devices'),
    ('auth','sso_providers'), ('public','realtime_system_channels'),
    ('public','realtime_broadcasts')
  ) order by 1"

# --- Restart the service ---
if [[ $RESTART -eq 1 ]]; then
  echo ""
  if systemctl list-unit-files pluto-backend.service >/dev/null 2>&1; then
    echo "→ Restarting pluto-backend.service"
    sudo systemctl restart pluto-backend.service
    sleep 2
    sudo systemctl status pluto-backend.service --no-pager -l | head -12
  else
    echo "→ No pluto-backend.service unit — skip restart (use --no-restart to silence)"
  fi
fi

# --- Health probe ---
echo ""
echo "→ Health check"
HOST="${PLUTO_HEALTH_URL:-http://127.0.0.1:3000}"
curl -fsS "$HOST/livez"  | head -c 200; echo
curl -fsS "$HOST/readyz" | head -c 200; echo
curl -fsS "$HOST/health/migrations" | head -c 400; echo

echo ""
echo "✅ Phase 15 deploy complete."
echo "   Refresh the dashboard — Workspaces / Integrations / SQL / CORS / Rate Limits /"
echo "   AI / Vector / Queues / Templates / Push / SSO / Realtime pages should now show data."

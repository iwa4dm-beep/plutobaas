#!/usr/bin/env bash
# Migration preflight + remediation gate.
# Runs role repair, plan, transactional dry-run, apply, and ledger verify before
# the rest of a deploy is allowed to continue.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT/docker/docker-compose.yml}"
OVERLAY_FILE="$ROOT/docker/docker-compose.migrator.yml"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
PG_SERVICE="${PG_SERVICE:-postgres}"
REPORT_DIR="${REPORT_DIR:-$ROOT/.migration-reports}"

bash "$HERE/check-env.sh"

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
: "${POSTGRES_USER:=pluto}"
: "${POSTGRES_DB:=pluto}"

mkdir -p "$REPORT_DIR"
ts="$(date -u +%Y%m%dT%H%M%SZ)"

echo "▶ migration preflight: ensure Postgres compatibility roles"
if [ -f "$HERE/ensure-pg-roles.sql" ]; then
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T "$PG_SERVICE" \
    psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    < "$HERE/ensure-pg-roles.sql" >/dev/null
fi

echo "▶ migration preflight: build runner image"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -f "$OVERLAY_FILE" build migrator

echo "▶ migration preflight: plan pending files"
PLUTO_MIGRATION_REPORT="/tmp/pluto-migration-plan-$ts.json" \
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -f "$OVERLAY_FILE" \
  run --rm --no-deps migrator --plan-only --json | tee "$REPORT_DIR/plan-$ts.json" >/dev/null

echo "▶ migration preflight: transactional dry-run"
PLUTO_MIGRATION_REPORT="/tmp/pluto-migration-dry-run-$ts.json" \
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -f "$OVERLAY_FILE" \
  run --rm --no-deps migrator --dry-run --json | tee "$REPORT_DIR/dry-run-$ts.json" >/dev/null

echo "▶ migration preflight: apply pending migrations"
PLUTO_MIGRATION_REPORT="/tmp/pluto-migration-apply-$ts.json" \
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -f "$OVERLAY_FILE" \
  run --rm --no-deps migrator --json | tee "$REPORT_DIR/apply-$ts.json" >/dev/null

echo "▶ migration preflight: verify ledger"
bash "$HERE/verify-migrations.sh"

echo "✔ migration preflight passed"
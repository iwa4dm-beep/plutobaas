#!/usr/bin/env bash
# Integration test: run migrate.mjs on (A) a fresh DB and (B) a legacy snapshot
# using the built api image (so npm deps are present), then verify audit
# sealing tables round-trip via SQL.
#
# Usage:
#   bash pluto-backend/packages/api/scripts/test-migrations.sh
#
# Env overrides:
#   PLUTO_TEST_PG_IMAGE  (default: postgres:16-alpine)
#   PLUTO_API_IMAGE      (default: docker-api  — built by docker/docker-compose.yml)
#
# Requires: docker.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
API_DIR="$(cd "$HERE/.." && pwd)"
REPO_ROOT="$(cd "$API_DIR/../.." && pwd)"
MIG_DIR="$REPO_ROOT/migrations"

PG_IMG="${PLUTO_TEST_PG_IMAGE:-postgres:16-alpine}"
API_IMG="${PLUTO_API_IMAGE:-docker-api}"

SUFFIX="$$-$RANDOM"
NET="pluto-mig-net-$SUFFIX"
PG_CT="pluto-mig-pg-$SUFFIX"
PW="testpw_$RANDOM"
DB_URL="postgres://pluto:${PW}@${PG_CT}:5432/pluto"

cleanup() {
  echo "▶ cleanup"
  docker rm -f "$PG_CT" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

ensure_api_image() {
  if ! docker image inspect "$API_IMG" >/dev/null 2>&1; then
    echo "❌ api image '$API_IMG' not found."
    echo "   Build it first:"
    echo "     docker compose --env-file .env -f docker/docker-compose.yml build api"
    echo "   Or set PLUTO_API_IMAGE=<your-image-tag>."
    exit 1
  fi
}

start_pg() {
  local mode="$1"
  cleanup
  echo "▶ creating network + Postgres ($mode)"
  docker network create "$NET" >/dev/null
  docker run -d --name "$PG_CT" --network "$NET" \
    -e POSTGRES_USER=pluto \
    -e POSTGRES_PASSWORD="$PW" \
    -e POSTGRES_DB=pluto \
    "$PG_IMG" >/dev/null

  for _ in {1..30}; do
    if docker exec "$PG_CT" pg_isready -U pluto -d pluto >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done
  echo "❌ Postgres failed to start"
  docker logs "$PG_CT" | tail -40
  exit 1
}

psql_in_pg() {
  docker exec -i "$PG_CT" psql -U pluto -d pluto -v ON_ERROR_STOP=1 "$@"
}

apply_legacy_snapshot() {
  echo "▶ applying legacy migrations 0001..0005"
  for f in "$MIG_DIR"/000[1-5]_*.sql; do
    echo "  - $(basename "$f")"
    psql_in_pg < "$f" >/dev/null
  done
}

run_in_api() {
  # Runs a node command inside a throw-away api container attached to $NET.
  docker run --rm --network "$NET" \
    -e DATABASE_URL="$DB_URL" \
    -w /app "$API_IMG" "$@"
}

run_full_migrate() {
  echo "▶ running migrate.mjs (inside $API_IMG)"
  run_in_api node packages/api/scripts/migrate.mjs
}

run_validator() {
  echo "▶ validating audit_log schema"
  run_in_api node packages/api/scripts/validate-audit-schema.mjs
}

verify_audit_seal_sql() {
  echo "▶ verifying audit_seal round-trip via SQL"
  psql_in_pg <<'SQL' >/dev/null
insert into admin.audit_log (actor_id, action, resource_type, params, result)
values (null, 'test.migration', 'test', '{"probe":true}'::jsonb, 'ok');

with row_ins as (
  select id from admin.audit_log order by id desc limit 1
)
insert into admin.audit_seals (project_id, from_id, to_id, row_count, prev_hash, chain_hash, sealed_by)
select null, (select id from row_ins), (select id from row_ins), 1, '', md5('probe'), null;

select count(*) as seals from admin.audit_seals;
SQL
  echo "  ✔ audit_seals insert OK"
}

ensure_api_image

echo "=============================================="
echo "  TEST A: fresh database → run all migrations"
echo "=============================================="
start_pg "fresh"
run_full_migrate
run_validator
verify_audit_seal_sql

echo ""
echo "=============================================="
echo "  TEST B: legacy snapshot (0001..0005) → migrate"
echo "=============================================="
start_pg "legacy"
apply_legacy_snapshot
psql_in_pg <<'SQL' >/dev/null
insert into admin.audit_log (actor_id, action, target, metadata, ip)
values (null, 'legacy.action', 'thing', '{"legacy":true}'::jsonb, '127.0.0.1');
SQL
run_full_migrate
run_validator
verify_audit_seal_sql

echo ""
echo "✅ integration tests passed (fresh + legacy)"

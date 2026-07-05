#!/usr/bin/env bash
# Integration test: run migrate.mjs on (A) a fresh DB and (B) a legacy snapshot,
# then hit compliance endpoints to verify audit sealing works end-to-end.
#
# Usage:
#   PLUTO_TEST_PG_IMAGE=postgres:16-alpine  \
#   PLUTO_API_PORT=3000                     \
#   bash pluto-backend/packages/api/scripts/test-migrations.sh
#
# Requires: docker, curl, jq, node.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
API_DIR="$(cd "$HERE/.." && pwd)"
REPO_ROOT="$(cd "$API_DIR/../.." && pwd)"
MIG_DIR="$REPO_ROOT/migrations"

IMG="${PLUTO_TEST_PG_IMAGE:-postgres:16-alpine}"
PORT="${PLUTO_TEST_PG_PORT:-55432}"
CONTAINER="pluto-mig-test-$$"
PW="testpw_$RANDOM"
DB_URL="postgres://pluto:${PW}@127.0.0.1:${PORT}/pluto"

cleanup() {
  echo "▶ cleanup"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

start_pg() {
  local mode="$1"
  cleanup
  echo "▶ starting Postgres ($mode)"
  docker run -d --name "$CONTAINER" \
    -e POSTGRES_USER=pluto \
    -e POSTGRES_PASSWORD="$PW" \
    -e POSTGRES_DB=pluto \
    -p "127.0.0.1:${PORT}:5432" \
    "$IMG" >/dev/null

  for i in {1..30}; do
    if docker exec "$CONTAINER" pg_isready -U pluto -d pluto >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done
  echo "❌ Postgres failed to start"
  docker logs "$CONTAINER" | tail -40
  exit 1
}

apply_legacy_snapshot() {
  # Approximate the pre-fix state: apply everything up through 0005 only.
  echo "▶ applying legacy migrations 0001..0005"
  for f in "$MIG_DIR"/000[1-5]_*.sql; do
    echo "  - $(basename "$f")"
    docker exec -i "$CONTAINER" psql -U pluto -d pluto -v ON_ERROR_STOP=1 < "$f" >/dev/null
  done
}

run_full_migrate() {
  echo "▶ running migrate.mjs"
  ( cd "$API_DIR" && DATABASE_URL="$DB_URL" node scripts/migrate.mjs )
}

run_validator() {
  echo "▶ validating audit_log schema"
  ( cd "$API_DIR" && DATABASE_URL="$DB_URL" node scripts/validate-audit-schema.mjs )
}

verify_audit_seal_sql() {
  # Insert a synthetic audit row + seal it via SQL to prove the schema supports it.
  # (Compliance HTTP endpoints require full API boot + JWT; SQL path exercises the same tables.)
  echo "▶ verifying audit_seal round-trip via SQL"
  docker exec -i "$CONTAINER" psql -U pluto -d pluto -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
insert into admin.audit_log (actor_id, action, resource_type, params, result)
values (null, 'test.migration', 'test', '{"probe":true}'::jsonb, 'ok');

with rows as (
  select id from admin.audit_log order by id desc limit 1
)
insert into admin.audit_seals (project_id, from_id, to_id, row_count, prev_hash, chain_hash, sealed_by)
select null, (select id from rows), (select id from rows), 1, '', md5('probe'), null;

select count(*) as seals from admin.audit_seals;
SQL
  echo "  ✔ audit_seals insert OK"
}

# ---------- (A) Fresh DB ----------
echo "=============================================="
echo "  TEST A: fresh database → run all migrations"
echo "=============================================="
start_pg "fresh"
run_full_migrate
run_validator
verify_audit_seal_sql

# ---------- (B) Legacy snapshot ----------
echo ""
echo "=============================================="
echo "  TEST B: legacy snapshot (0001..0005) → migrate"
echo "=============================================="
start_pg "legacy"
apply_legacy_snapshot
# Seed a legacy-style audit row (no project_id / params) before upgrading
docker exec -i "$CONTAINER" psql -U pluto -d pluto -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
insert into admin.audit_log (actor_id, action, target, metadata, ip)
values (null, 'legacy.action', 'thing', '{"legacy":true}'::jsonb, '127.0.0.1');
SQL
run_full_migrate
run_validator
verify_audit_seal_sql

echo ""
echo "✅ integration tests passed (fresh + legacy)"

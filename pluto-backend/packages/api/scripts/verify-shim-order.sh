#!/usr/bin/env bash
# Fresh-DB verification: proves that migrate.mjs installs the auth.* shim
# BEFORE running 0016_stats_workspaces.sql. Runs entirely in Docker.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

PG_IMG="${PLUTO_TEST_PG_IMAGE:-postgres:16-alpine}"
SUFFIX="$$-$RANDOM"
PG_CT="pluto-shim-pg-$SUFFIX"
NET="pluto-shim-net-$SUFFIX"
PW="pw_$RANDOM"
DB_URL="postgres://pluto:${PW}@${PG_CT}:5432/pluto"

cleanup() {
  docker rm -f "$PG_CT" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "▶ starting fresh Postgres ($PG_IMG)"
docker network create "$NET" >/dev/null
docker run -d --name "$PG_CT" --network "$NET" \
  -e POSTGRES_USER=pluto -e POSTGRES_PASSWORD="$PW" -e POSTGRES_DB=pluto \
  "$PG_IMG" >/dev/null
for _ in {1..30}; do
  docker exec "$PG_CT" pg_isready -U pluto -d pluto >/dev/null 2>&1 && break
  sleep 1
done

psql_run() { docker exec -i "$PG_CT" psql -U pluto -d pluto -v ON_ERROR_STOP=1 "$@"; }

# Pre-flight: auth.uid() must NOT exist yet — this is a fresh DB.
echo "▶ pre-check: auth schema should be absent"
if psql_run -Atc "select 1 from pg_namespace where nspname='auth'" | grep -q 1; then
  echo "✘ unexpected: auth schema already exists in freshly-created DB"; exit 1
fi

# Run migrate.mjs inside a throwaway Node container that mounts the repo.
echo "▶ running migrate.mjs against fresh DB"
docker run --rm --network "$NET" \
  -e DATABASE_URL="$DB_URL" \
  -v "$ROOT":/app -w /app \
  node:20-alpine sh -c "npm i --no-save --silent postgres@3 && node packages/api/scripts/migrate.mjs"

echo "▶ post-check: auth.uid() exists and 0016 recorded"
psql_run -Atc "select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
               where n.nspname='auth' and p.proname in ('uid','role','jwt')
               order by proname" | tee /tmp/shim-fns
grep -q '^uid$'  /tmp/shim-fns
grep -q '^role$' /tmp/shim-fns
grep -q '^jwt$'  /tmp/shim-fns

psql_run -Atc "select name from public._pluto_migrations where name='0016_stats_workspaces.sql'" \
  | grep -q 0016_stats_workspaces.sql

echo "✔ shim was in place before 0016_stats_workspaces.sql (0016 applied cleanly)"

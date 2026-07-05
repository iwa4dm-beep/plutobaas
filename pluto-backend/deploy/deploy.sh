#!/usr/bin/env bash
# One-command deploy: build → restart → migrate → smoke test.
# Run from repo root:  bash deploy/deploy.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

COMPOSE="docker compose --env-file .env -f docker/docker-compose.yml"
API_BASE="${API_BASE:-http://127.0.0.1:3000}"
MIGRATE_PATH="packages/api/scripts/migrate.mjs"

step() { printf "\n\033[1;34m▶ %s\033[0m\n" "$*"; }
ok()   { printf "  \033[32m✔\033[0m %s\n" "$*"; }
fail() { printf "  \033[31m✘\033[0m %s\n" "$*" >&2; exit 1; }

step "1/4  build + restart stack"
$COMPOSE up -d --build

step "2/4  wait for api container to be healthy"
for i in $(seq 1 30); do
  if $COMPOSE exec -T api sh -c "test -f /app/$MIGRATE_PATH" >/dev/null 2>&1; then
    ok "api container up (migrate script present)"
    break
  fi
  sleep 2
  [ "$i" = "30" ] && fail "api container not ready after 60s"
done

step "3/4  apply migrations"
$COMPOSE exec -T api node "$MIGRATE_PATH"
ok "migrations applied"

step "4/4  smoke test health endpoints"
for i in $(seq 1 20); do
  code=$(curl -s -o /dev/null -w "%{http_code}" "$API_BASE/livez" || true)
  [ "$code" = "200" ] && break
  sleep 1
  [ "$i" = "20" ] && fail "livez never returned 200"
done

check() {
  local path="$1"
  local body
  body=$(curl -sf "$API_BASE$path") || fail "$path did not respond 2xx"
  echo "$body" | grep -q '"status":"ok"' \
    && ok "$path status ok" \
    || fail "$path did not return status:ok — body: $body"
}

check /livez
check /readyz
check /health/migrations

printf "\n\033[1;32m✅ deploy complete\033[0m\n"
